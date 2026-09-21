import { runStreaming } from './proc.ts';
import { allocateWorktree, captureDiff, isGitRepo } from './worktree.ts';
import type {
  Adapter,
  ApprovalLevel,
  BridgeEvent,
  HarnessModels,
  ModelCatalog,
  TaskResult,
  TaskSpec,
  TaskStatus,
  Tier,
} from './types.ts';
import { DispatchRejected } from './types.ts';

const LEVELS: readonly ApprovalLevel[] = ['read-only', 'workspace-write', 'full'];

/** worker 产出的 diff 保留上限,防止超长 patch 把内存和上下文撑爆。 */
// 可覆盖是为了让"截断"这条安全分支真的能被测到 —— 否则用例得先造一份 200KB 的 diff。
const DIFF_CAP = Number(process.env.LLMS_BRIDGE_DIFF_CAP ?? 200_000);

interface TaskState {
  /** 调用方给的原始 spec(并发判定用原始 cwd)。 */
  spec: TaskSpec;
  /** 实际执行用的 spec(cwd 可能被换成 worktree)。 */
  runSpec: TaskSpec;
  harness: string;
  tier: Tier;
  startedAt: number;
  events: BridgeEvent[];
  finished: boolean;
  result?: TaskResult;
  isolated: boolean;
  worktreePath?: string;
}

export interface DispatchAck {
  taskId: string;
  /** 是否分配了独立 worktree。 */
  isolated: boolean;
  worktreePath?: string;
}

export interface HarnessInfo {
  id: string;
  tier: Tier;
  displayName: string;
  supportedApprovals: readonly ApprovalLevel[];
}

export type HarnessReport = HarnessInfo & {
  available: boolean;
  version?: string;
  detail?: string;
};

export interface TaskSnapshot {
  taskId: string;
  harness: string;
  tier: Tier;
  finished: boolean;
  status?: TaskStatus;
  eventCount: number;
  lastEvent?: BridgeEvent;
  usageTokens?: number;
  isolated: boolean;
  worktreePath?: string;
}

export class Scheduler {
  #adapters: Map<string, Adapter>;
  #tasks = new Map<string, TaskState>();
  #running = new Map<string, Promise<void>>();
  #detectPromise: Promise<HarnessReport[]> | null = null;

  constructor(adapters: Adapter[]) {
    this.#adapters = new Map(adapters.map((a) => [a.id, a]));
  }

  harnesses(): HarnessInfo[] {
    return [...this.#adapters.values()].map((a) => ({
      id: a.id,
      tier: a.tier,
      displayName: a.displayName,
      supportedApprovals: a.supportedApprovals,
    }));
  }

  /**
   * 探测并**缓存**结果。
   *
   * 层级① 的探测要跑一次真实 ACP 握手(initialize + session/new),是秒级的;
   * 若不缓存,每次 harness_dispatch/harness_list 都会再等一轮,直接破坏
   * "dispatch 立刻返回 task_id" 的设计。要刷新就传 force=true。
   */
  detectAll(force = false): Promise<HarnessReport[]> {
    if (force || this.#detectPromise === null) {
      this.#detectPromise = this.#runDetect();
    }
    return this.#detectPromise;
  }

  async #runDetect(): Promise<HarnessReport[]> {
    // 并行探测:层级① 各家都要跑一次 ACP 握手(且不通的会等到超时),
    // 串行会把这些等待叠加起来。
    return Promise.all(
      [...this.#adapters.values()].map(async (a) => {
        const d = await a.detect();
        return {
          id: a.id,
          tier: a.tier,
          displayName: a.displayName,
          supportedApprovals: a.supportedApprovals,
          available: d.available,
          version: d.version,
          detail: d.detail,
        };
      }),
    );
  }

  /**
   * 派发任务。**同步返回 task_id**,执行在后台跑 —— 一次 worker 运行可能几分钟到几十分钟,
   * 调用方不能同步等(见 PLAN.md §5.3)。
   */
  async dispatch(spec: TaskSpec): Promise<DispatchAck> {
    if (typeof spec.taskId !== 'string' || spec.taskId.length === 0) {
      throw new DispatchRejected('taskId 必填');
    }
    if (typeof spec.prompt !== 'string' || spec.prompt.length === 0) {
      throw new DispatchRejected('prompt 必填');
    }
    if (typeof spec.cwd !== 'string' || spec.cwd.length === 0) {
      throw new DispatchRejected('cwd 必填');
    }

    if (spec.approval === undefined || spec.approval === null) {
      throw new DispatchRejected('approval 必填且无默认值 —— 见 AGENTS.md 铁律二');
    }
    if (!LEVELS.includes(spec.approval)) {
      throw new DispatchRejected(`approval 取值非法: ${String(spec.approval)}`);
    }

    if (spec.budget === undefined || spec.budget === null) {
      throw new DispatchRejected('budget 必填且无默认值 —— 见 AGENTS.md 铁律四');
    }
    if (!Number.isFinite(spec.budget.maxWallMs) || spec.budget.maxWallMs <= 0) {
      throw new DispatchRejected('budget.maxWallMs 必须是正数');
    }

    const adapter = this.#adapters.get(spec.harness);
    if (!adapter) throw new DispatchRejected(`未知 harness: ${spec.harness}`);
    if (!adapter.supportedApprovals.includes(spec.approval)) {
      throw new DispatchRejected(`${spec.harness} 不支持审批档位 ${spec.approval}`);
    }
    if (spec.approval === 'full' && spec.allowedFull !== true) {
      throw new DispatchRejected(
        `${spec.harness}: approval='full' 需显式 allowedFull=true —— 那会让该模型在无人确认下改动你的磁盘`,
      );
    }

    // 写任务必须隔离(AGENTS.md 铁律三):git 仓库分配独立 worktree;
    // 非 git 目录默认拒绝,除非调用方显式声明放弃隔离。
    let effectiveCwd = spec.cwd;
    let worktreePath: string | undefined;
    let isolated = false;

    if (spec.approval !== 'read-only') {
      if (await isGitRepo(spec.cwd)) {
        try {
          const wt = await allocateWorktree(spec.cwd, spec.taskId);
          effectiveCwd = wt.path;
          worktreePath = wt.path;
          isolated = true;
        } catch (err) {
          throw new DispatchRejected(`分配 worktree 失败: ${(err as Error).message}`);
        }
      } else if (spec.allowUnisolatedWrite !== true) {
        throw new DispatchRejected(
          `${spec.cwd} 不是 git 仓库,无法给写任务分配独立 worktree(AGENTS.md 铁律三)。` +
            `改用 approval='read-only',或显式传 allowUnisolatedWrite=true ` +
            `(风险自负,结果会标记 isolated=false)。`,
        );
      } else {
        // 显式放弃隔离:仍然不允许同目录并发写。
        for (const t of this.#tasks.values()) {
          if (!t.finished && !t.isolated && t.spec.cwd === spec.cwd && t.spec.approval !== 'read-only') {
            throw new DispatchRejected(
              `同一工作目录已有未隔离的可写任务在跑(${t.spec.taskId});并行写会互相覆盖。`,
            );
          }
        }
      }
    }

    const runSpec: TaskSpec = { ...spec, cwd: effectiveCwd };

    // 探测放在所有校验之后:被拒绝的请求不该等一轮 ACP 握手。
    // plan() 需要 adapter 已经解析出二进制路径,所以这里必须先探测完。
    await this.detectAll();

    // plan() 会在此处抛出(二进制未探测到等),让派发失败在调用方当场可见。
    const plan = adapter.plan(runSpec);

    const state: TaskState = {
      spec,
      runSpec,
      harness: adapter.id,
      tier: adapter.tier,
      startedAt: Date.now(),
      events: [],
      finished: false,
      isolated,
      worktreePath,
    };
    this.#tasks.set(spec.taskId, state);
    this.#running.set(spec.taskId, this.#execute(adapter, runSpec, state, plan));
    return { taskId: spec.taskId, isolated, worktreePath };
  }

  async #execute(
    adapter: Adapter,
    spec: TaskSpec,
    state: TaskState,
    plan: { command: string; args: string[]; env?: Record<string, string> },
  ): Promise<void> {
    const parser = adapter.createRun(spec, spec.taskId);
    let tokens = 0;
    let overBudget = false;

    const outcome = await runStreaming({
      command: plan.command,
      args: plan.args,
      cwd: spec.cwd,
      env: plan.env,
      maxWallMs: spec.budget.maxWallMs,
      needsStdin: plan.needsStdin,
      onStdin: (write) => parser.onStart?.(write),
      onLine: (line) => {
        for (const e of parser.parseLine(line)) {
          state.events.push(e);
          if (e.usage) {
            tokens = (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0);
            if (spec.budget.maxTokens !== undefined && tokens > spec.budget.maxTokens) {
              overBudget = true;
            }
          }
        }
      },
      shouldAbort: () => overBudget || parser.shouldStop?.() === true,
    });

    const fin = parser.finalize(outcome.exitCode ?? -1);

    // 会话型协议(层级①)是"我们主动收工才 kill 子进程",所以退出码天然非零,
    // 不能据此判失败 —— 协议自己说完成了就算完成。一次性 adapter 没有这个信号,退出码照旧有效。
    const protocolDone = parser.shouldStop?.() === true;

    let status: TaskStatus = 'ok';
    let reason: string | undefined;
    if (outcome.timedOut) {
      status = 'timeout';
      reason = `超过 budget.maxWallMs=${spec.budget.maxWallMs}ms,已中断进程树`;
    } else if (outcome.aborted && overBudget) {
      status = 'failed';
      reason = `超过 budget.maxTokens=${spec.budget.maxTokens}(实际约 ${tokens}),已中断`;
    } else if (fin.errorText) {
      status = 'failed';
      reason = fin.errorText;
    } else if (!protocolDone && outcome.exitCode !== 0) {
      status = 'failed';
      reason = `退出码 ${outcome.exitCode}`;
    }

    // worker 的改动以 diff 形式回收,不直接合并回源仓库(AGENTS.md 铁律三)。
    let capturedDiff: string | undefined;
    let diffTruncated: boolean | undefined;
    if (state.worktreePath) {
      try {
        const { patch, stat } = await captureDiff(state.worktreePath);
        if (stat.trim().length > 0) {
          const truncated = patch.length > DIFF_CAP;
          diffTruncated = truncated;
          capturedDiff = truncated ? patch.slice(0, DIFF_CAP) + '\n...[diff 已截断]' : patch;
          state.events.push({
            taskId: spec.taskId,
            seq: state.events.length,
            harness: adapter.id,
            tier: adapter.tier,
            type: 'diff',
            at: Date.now(),
            text: stat.trim(),
            raw: capturedDiff,
          });
        } else {
          state.events.push({
            taskId: spec.taskId,
            seq: state.events.length,
            harness: adapter.id,
            tier: adapter.tier,
            type: 'status',
            at: Date.now(),
            text: 'worktree 内无改动',
          });
        }
      } catch (err) {
        state.events.push({
          taskId: spec.taskId,
          seq: state.events.length,
          harness: adapter.id,
          tier: adapter.tier,
          type: 'error',
          at: Date.now(),
          text: `回收 diff 失败: ${(err as Error).message}`,
        });
      }
    }

    // 终态 result 只应有一条。三个适配器都会把协议里的 result 行翻译成 `result` 事件
    // (带着 raw 便于排查),这里若无条件再推一条,每个任务就会有**两条内容相同**的终态事件 ——
    // 主脑按 harness_events 增量跟踪时要把答案读两遍,还得猜是不是结束了两次。
    // 仅当解析器没交出同文本的 result 时才补(例如层级③ 的 codex 不发 result 行)。
    const alreadyHasResult = state.events.some(
      (e) => e.type === 'result' && e.text === fin.text,
    );
    if (!alreadyHasResult) {
      state.events.push({
        taskId: spec.taskId,
        seq: state.events.length,
        harness: adapter.id,
        tier: adapter.tier,
        type: 'result',
        at: Date.now(),
        text: fin.text,
        usage: fin.usage,
      });
    }

    state.result = {
      taskId: spec.taskId,
      harness: adapter.id,
      tier: adapter.tier,
      status,
      text: fin.text,
      structured: fin.structured,
      usage: fin.usage,
      eventCount: state.events.length,
      startedAt: state.startedAt,
      endedAt: Date.now(),
      reason,
      isolated: state.isolated,
      model: spec.model,
      worktreePath: state.worktreePath,
      diff: capturedDiff,
      diffTruncated,
    };
    state.finished = true;
  }

  poll(taskId: string): TaskSnapshot {
    const state = this.#tasks.get(taskId);
    if (!state) throw new DispatchRejected(`未知 taskId: ${taskId}`);
    const last = state.events[state.events.length - 1];
    const usage = state.events.filter((e) => e.usage).pop()?.usage;
    return {
      taskId,
      harness: state.harness,
      tier: state.tier,
      finished: state.finished,
      status: state.result?.status,
      eventCount: state.events.length,
      lastEvent: last,
      usageTokens: usage
        ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        : undefined,
      isolated: state.isolated,
      worktreePath: state.worktreePath,
    };
  }

  events(taskId: string): BridgeEvent[] {
    const state = this.#tasks.get(taskId);
    if (!state) throw new DispatchRejected(`未知 taskId: ${taskId}`);
    return state.events;
  }

  #modelCache = new Map<string, ModelCatalog | null>();

  /**
   * 各 harness **自己声明**的模型清单。
   *
   * 不自报的一律 `declared:false` 且 `models:[]` —— 调用方必须渲染成"未知"。
   * 这条限制是刻意的:面板一旦允许用"看起来合理"的默认值填空,就会派出一个根本不存在的模型,
   * 而用户看到的是一次失败的任务而不是一个空下拉框。
   * 结果按进程缓存:取清单要跑 `--help` 子进程,每次刷新都跑会明显拖慢面板。
   */
  async models(force = false): Promise<HarnessModels[]> {
    const report = await this.detectAll(force);
    return Promise.all(
      [...this.#adapters.values()].map(async (a) => {
        if (force || !this.#modelCache.has(a.id)) {
          const catalog = a.listModels ? await a.listModels().catch(() => null) : null;
          this.#modelCache.set(a.id, catalog);
        }
        const catalog = this.#modelCache.get(a.id) ?? null;
        return {
          id: a.id,
          displayName: a.displayName,
          available: report.find((r) => r.id === a.id)?.available === true,
          declared: catalog !== null,
          models: catalog?.models ?? [],
          source:
            catalog?.source ??
            `${a.id} 不自己声明模型清单(未实现 listModels,或其输出解析失败)—— 请按"未知"处理,不要填默认值`,
          ...(catalog ? { checkedAt: catalog.checkedAt } : {}),
        };
      }),
    );
  }

  /** 等任务跑完并取结果。 */
  async collect(taskId: string): Promise<TaskResult> {
    const running = this.#running.get(taskId);
    if (!running) throw new DispatchRejected(`未知 taskId: ${taskId}`);
    await running;
    const state = this.#tasks.get(taskId);
    if (!state?.result) throw new DispatchRejected(`taskId ${taskId} 已结束但没有结果`);
    return state.result;
  }

  /** 等所有在跑的任务结束(CLI 收尾用)。 */
  async idle(): Promise<void> {
    await Promise.all([...this.#running.values()]);
  }
}