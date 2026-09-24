import { runStreaming } from './proc.ts';
import {
  judgeLiveness,
  locateTaskRecord,
  readTaskBeat,
  recordDispatch,
  recordFinish,
  readProgress,
  startHeartbeat,
  taskRecordPath,
} from './journal.ts';
import type { TaskProgress, TaskRecord } from './journal.ts';
import { checkCloudPolicy, readCloudPolicy } from './policy.ts';
import { redactCredentials } from './redact.ts';
import { auditDisk, snapshotDisk } from './audit.ts';
import type { DiskSnapshot } from './audit.ts';
import { enforcementNote, enforcementOf } from './enforcement.ts';
import { allocateWorktree, captureDiff, isGitRepo, resolveReusableWorktree } from './worktree.ts';
import type {
  Adapter,
  ApprovalEnforcement,
  ApprovalLevel,
  BridgeEvent,
  EgressReport,
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

/** 只对声明支持的档位给结论;没实测过的由 enforcementOf() 落成 'unknown',不默认成拦得住。 */
function enforcementMap(adapter: Adapter): Partial<Record<ApprovalLevel, ApprovalEnforcement>> {
  const out: Partial<Record<ApprovalLevel, ApprovalEnforcement>> = {};
  for (const level of adapter.supportedApprovals) out[level] = enforcementOf(adapter, level);
  return out;
}

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
  /** 派发前对**调用方原始 cwd** 拍的快照;审计要拿它当基线。 */
  diskBefore?: DiskSnapshot;
  /** 关掉这个任务的心跳定时器。#execute 抛异常时也必须关,见 dispatch 里的 finally。 */
  stopBeat?: () => void;
}

export interface DispatchAck {
  taskId: string;
  /** 是否分配了独立 worktree。 */
  isolated: boolean;
  worktreePath?: string;
  /**
   * 这次用的档位实际拦不拦得住。放在 ack 是刻意的:调用方在**派发那一刻**就该知道
   * 自己买到了什么,而不是等结果出来才发现"只读"是个标签。
   */
  approvalEnforcement: ApprovalEnforcement;
  approvalNote: string;
  /**
   * 这次派发的数据去向(adapter 自报;它不知道就留空,调度器绝不替它编)。
   * 放在 ack 而不是只放 harness_list,是因为用户会在两次派发之间用 cc-switch 换端点 ——
   * 缓存过的探测结果可能已经过期,而 ack 一定是**这次**算出来的。
   */
  egress?: EgressReport;
}

export interface HarnessInfo {
  id: string;
  tier: Tier;
  displayName: string;
  supportedApprovals: readonly ApprovalLevel[];
  /**
   * 逐档位的"拦不拦得住"。必须和 supportedApprovals 一起给:只显示后者会让调用方
   * 把"桥肯给这个档"读成"这家不会改我的盘",而实测这两件事在 opencode 上并不等价。
   */
  approvalEnforcement: Partial<Record<ApprovalLevel, ApprovalEnforcement>>;
}

export type HarnessReport = HarnessInfo & {
  available: boolean;
  version?: string;
  detail?: string;
  egress?: EgressReport;
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
  /**
   * 以下三项来自**落盘账本**而不是内存:说明这个任务不属于本进程(通常是宿主重启前的
   * 上一个桥进程派发的)。调用方看到 true 时不能再期待事件流或后续进展。
   */
  fromJournal?: boolean;
  reason?: string;
  journalPath?: string;
  /**
   * 进度与判活。注意 `liveness:'heartbeat_lost'` 时**不许**按"在跑"渲染 ——
   * 记录本身会永远停在 running(进程被杀就是这样的),只有心跳能把它和真在跑的分开。
   */
  progress?: TaskProgress;
}

/**
 * 账本兜底时的措辞。必须让调用方能分辨两件完全不同的事:
 * "这个 ID 从没派发过"(拼错了)与"派发过、但持有它的进程消失了"。
 */
function journalNote(record: TaskRecord, cwd: string): { reason: string; journalPath: string } {
  const at = new Date(record.startedAt).toISOString();
  return {
    journalPath: taskRecordPath(cwd, record.taskId),
    reason:
      record.status === 'running'
        ? `账本记录停在 running(${at} 派出),但持有它的桥进程已经消失:本进程内存里没有该任务,` +
          `它不会再有任何进展,也没有结果可取。这**不代表任务失败**,只代表状态断了 —— 需要产出就得重派。`
        : `该任务由**上一个桥进程**派发(${at}),本进程内存里没有它;以下内容来自落盘账本,事件流无法回放。`,
  };
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
      approvalEnforcement: enforcementMap(a),
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
          approvalEnforcement: enforcementMap(a),
          available: d.available,
          version: d.version,
          detail: d.detail,
          // 出口自报失败 ≠ 该 harness 不可用:降级成"桥不知道",不许把探测整体拖挂。
          egress: a.egress ? await a.egress().catch(() => undefined) : undefined,
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
    // 三种形态由调用方选(2026-09-24 用户要求:要不要 worktree 交出去):
    //   reuseWorktreePath 给定 → 复用那个**已验过**的 worktree(多轮任务共用一份工作区);
    //   allowUnisolatedWrite → 直接写 spec.cwd(结果标 isolated=false);
    //   都不给 → 老规矩,git 仓库新建一个 worktree。
    let effectiveCwd = spec.cwd;
    let worktreePath: string | undefined;
    let isolated = false;

    /** 未隔离写:同一目录不许有两个并发写手,否则互相覆盖。 */
    const rejectConcurrentUnisolatedWrite = (): void => {
      for (const t of this.#tasks.values()) {
        if (!t.finished && !t.isolated && t.spec.cwd === spec.cwd && t.spec.approval !== 'read-only') {
          throw new DispatchRejected(
            `同一工作目录已有未隔离的可写任务在跑(${t.spec.taskId});并行写会互相覆盖。`,
          );
        }
      }
    };

    if (spec.approval === 'read-only' && spec.reuseWorktreePath !== undefined) {
      // 两条理由,都不是"以后再说":
      // ① 只读档本来就不分配 worktree,静默忽略这个字段等于骗调用方(本项目禁止静默丢弃 spec 选项);
      // ② 更不能"采纳它并标 isolated:true" —— 只读 worker 照样能按绝对路径读到主仓库,
      //    标了隔离就是过度宣称(同"宣称强度别超过证据")。它要读那个工作区的快照,直接把 cwd 指过去即可。
      throw new DispatchRejected(
        `approval='read-only' 不涉及 worktree,不支持 reuseWorktreePath。` +
          `若想让只读任务读某个已有 worktree 的快照,直接把 cwd 设成那个路径(不传本字段)。`,
      );
    }

    if (spec.approval !== 'read-only') {
      if (spec.reuseWorktreePath !== undefined) {
        try {
          // 复用也算隔离,但**只认验证过的**:是不是同一个仓库的独立 worktree,由 git 自己回答。
          const reused = await resolveReusableWorktree(spec.cwd, spec.reuseWorktreePath);
          effectiveCwd = reused;
          worktreePath = reused;
          isolated = true;
        } catch (err) {
          throw new DispatchRejected(`复用 worktree 失败: ${(err as Error).message}`);
        }
      } else if (spec.allowUnisolatedWrite === true) {
        rejectConcurrentUnisolatedWrite();
      } else if (await isGitRepo(spec.cwd)) {
        try {
          const wt = await allocateWorktree(spec.cwd, spec.taskId);
          effectiveCwd = wt.path;
          worktreePath = wt.path;
          isolated = true;
        } catch (err) {
          throw new DispatchRejected(`分配 worktree 失败: ${(err as Error).message}`);
        }
      } else {
        throw new DispatchRejected(
          `${spec.cwd} 不是 git 仓库,无法给写任务分配独立 worktree(AGENTS.md 铁律三)。` +
            `改用 approval='read-only',或显式传 allowUnisolatedWrite=true ` +
            `(风险自负,结果会标记 isolated=false)。`,
        );
      }
    }

    const runSpec: TaskSpec = { ...spec, cwd: effectiveCwd };

    // 仓库级云策略:只读档的 worker 照样会把仓库内容发给模型,所以与档位无关,一律在派发前过闸。
    // 没有 policy.json 的仓库不受影响(缺失=不限制);有则按白名单判,判不过当场拒,不产生任何副作用。
    const egress = adapter.egress ? await adapter.egress().catch(() => undefined) : undefined;
    const policy = await readCloudPolicy(spec.cwd);
    const verdict = checkCloudPolicy(policy, adapter.id, egress);
    if (!verdict.allowed) throw new DispatchRejected(verdict.reason ?? '被该仓库的云策略拒绝');

    // 探测放在所有校验之后:被拒绝的请求不该等一轮 ACP 握手。
    // plan() 需要 adapter 已经解析出二进制路径,所以这里必须先探测完。
    await this.detectAll();

    // plan() 会在此处抛出(二进制未探测到等),让派发失败在调用方当场可见。
    const plan = adapter.plan(runSpec);

    // 基线紧贴启动取:早一步(比如在 detectAll 之前)就多几秒窗口,用户在别的窗口里
    // 改的文件会被算到 worker 头上;晚一步就漏掉 worker 最初的写入。
    // 拍的是 spec.cwd(**调用方给的那个目录**),不是被换成的 worktree —— 要抓的正是越界。
    const diskBefore = await snapshotDisk(spec.cwd);

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
      diskBefore,
    };
    this.#tasks.set(spec.taskId, state);
    // 账本写在启动**之前**:启动后进程随时可能被杀,那就什么痕迹都没有了。
    recordDispatch(runSpec, effectiveCwd, adapter.tier, isolated, egress?.endpointHost);
    // 心跳定时器挂在这条链上停:正常收尾、超时、还是 #execute 抛异常,三条路都必须停。
    // 漏停会让一个早已结束的任务继续跳心跳 —— "永远显示在跑"是面板能给的最坏的假信号。
    this.#running.set(
      spec.taskId,
      this.#execute(adapter, runSpec, state, plan).finally(() => state.stopBeat?.()),
    );

    const approvalEnforcement = enforcementOf(adapter, spec.approval);

    // 端点可以在两次派发之间被用户整体换掉(cc-switch),所以 ack 里的出口**现取**,
    // 不复用 detectAll 的缓存。取不到就不报,宁缺毋滥。
    return {
      taskId: spec.taskId,
      isolated,
      worktreePath,
      approvalEnforcement,
      approvalNote: enforcementNote(spec.approval, approvalEnforcement),
      egress: egress ? { ...egress, promptBytes: Buffer.byteLength(spec.prompt, 'utf8') } : undefined,
    };
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

    // 心跳:让"这个任务还在被看着"这件事有落盘证据,面板才谈得上进度。
    // 交给 dispatch 那边的 finally 统一停 —— 放在这里 stop 会漏掉抛异常那条路。
    const beat = startHeartbeat(spec.cwd, spec.taskId, () => {
      const last = state.events[state.events.length - 1];
      return {
        events: state.events.length,
        lastSeq: last?.seq,
        lastType: last?.type,
        lastEventAt: last?.at,
        tokens,
      };
    });
    state.stopBeat = () => beat.stop();

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
          // 适配器把外部 CLI 的原样返回塞在 raw 里,可能夹带凭证(qwen 的 set_model 就带过),
          // 而 raw 会经 harness_events 交给主脑 —— 那可能是别的厂商的云端模型。见 src/redact.ts。
          state.events.push(e.raw === undefined ? e : { ...e, raw: redactCredentials(e.raw) });
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

    // 各家 CLI 的 stderr 里常常写着"为什么没干成",而它此前**采集了却没人用** ——
    // 结果是调用方只看到一句"退出码 1 且无文本"。原话必须转达(末尾 4000 字符,proc.ts 里截的)。
    const stderrTail = outcome.stderrTail.trim();
    if (stderrTail.length > 0 && status !== 'ok') {
      reason = `${reason ?? '失败'} | stderr: ${stderrTail}`;
    }

    // worker 的改动以 diff 形式回收,不直接合并回源仓库(AGENTS.md 铁律三)。
    let capturedDiff: string | undefined;
    let diffTruncated: boolean | undefined;
    // 只读档**不跑** captureDiff:复用别人建好的 worktree 时,`git add -A` 会把那个工作区里
    // 既有的未提交改动一并暂存 —— 对只读任务而言这是对它人工作区的副作用,而且没有收益(它不该改文件)。
    if (state.worktreePath && spec.approval !== 'read-only') {
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

    // 先钉住结束时刻:审计要再跑一次 git,不该把"worker 何时结束"往后推。
    const endedAt = Date.now();

    // 审计的对象是 state.spec.cwd —— **调用方给的目录**,不是 runSpec 那个被换成的 worktree。
    // 写档即使隔离了也要审原目录:要抓的就是"越界写到你的主仓库"那种事。
    const diskAudit = await auditDisk(
      state.spec.cwd,
      state.diskBefore ?? { repo: false, whyNot: '桥没取到派发前快照' },
    );

    // 什么算越界:
    //  - 只读档:改了这个目录里的任何东西就是违约(档位可能只是标签,所以要用事实说话);
    //  - 写档且已隔离:worker 的写应该全在 worktree 里,主目录动了说明它跑出去了;
    //  - 写档且调用方主动放弃隔离(allowUnisolatedWrite):改 cwd 是它要的行为,不算越界。
    const escaped =
      diskAudit.audited === true &&
      diskAudit.changed === true &&
      (spec.approval === 'read-only' || state.isolated);
    if (escaped) {
      const where = diskAudit.headMoved ? '含 HEAD 移动(在你仓库里提交了)' : `${diskAudit.paths?.length ?? 0} 处文件`;
      // 与"超预算"同构:产出可能是好的,但契约破了,所以判 failed 并说清为什么。
      // 不许让它停在 ok 上 —— 只查 status 的调用方(实测确实有这种)会整个漏掉这件事。
      status = 'failed';
      reason = `越界改动:审批档位=${spec.approval} 隔离=${state.isolated},但 ${state.spec.cwd} 被改动了 ${where}`;
    }

    const approvalEnforcement = enforcementOf(adapter, spec.approval);

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
      endedAt,
      reason,
      isolated: state.isolated,
      approvalEnforcement,
      approvalNote: enforcementNote(spec.approval, approvalEnforcement),
      diskAudit,
      model: spec.model,
      worktreePath: state.worktreePath,
      diff: capturedDiff,
      diffTruncated,
    };
    state.finished = true;
    // 这里的 `spec` 就是 runSpec(dispatch 传进来的那个),cwd 已是实际执行目录。
    recordFinish(spec.cwd, spec.taskId, {
      status,
      reason,
      usage: fin.usage,
      text: fin.text,
    });
  }

  poll(taskId: string): TaskSnapshot {
    const state = this.#tasks.get(taskId);
    if (!state) {
      const found = locateTaskRecord(taskId);
      if (found) {
        const { record, cwd } = found;
        const note = journalNote(record, cwd);
        return {
          taskId,
          harness: record.harness,
          tier: record.tier,
          // 它再也不会推进:回 finished=false 会让调用方无限轮询一个已不存在的进程。
          finished: true,
          status: record.status === 'running' ? 'failed' : record.status,
          // 事件流只在内存里,没落盘 —— 回 0 而不是假装有历史。
          eventCount: 0,
          usageTokens: record.usage
            ? (record.usage.inputTokens ?? 0) + (record.usage.outputTokens ?? 0)
            : undefined,
          isolated: record.isolated,
          worktreePath: record.worktreePath,
          fromJournal: true,
          reason: note.reason,
          journalPath: note.journalPath,
          // 走账本时进度只能来自心跳文件 —— 它同时也是"桥还活着吗"的唯一证据。
          progress: readProgress(cwd, taskId, record),
        };
      }
      throw new DispatchRejected(
        `未知 taskId: ${taskId} —— 本进程内存与本机账本里都没有它。账本只记本机派发过的任务,请先核对 ID。`,
      );
    }
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
      // 内存路径也走同一套判据:计数取即时的,判活仍用心跳文件 —— 否则面板和 poll 会各说一套。
      progress: readProgress(
        state.runSpec.cwd,
        taskId,
        { status: state.finished ? (state.result?.status ?? 'ok') : 'running', startedAt: state.startedAt },
        {
          events: state.events.length,
          tokens: usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : 0,
          lastType: last?.type,
          lastEventAt: last?.at,
        },
      ),
    };
  }

  events(taskId: string): BridgeEvent[] {
    const state = this.#tasks.get(taskId);
    if (state) return state.events;
    // 账本里只留了"是什么、最后怎样、产出了什么",**没有事件流** —— 过程不可回放。
    // 这里直接说清,好过回一个空数组让调用方以为"跑过但没事件"。
    const found = locateTaskRecord(taskId);
    if (found) {
      throw new DispatchRejected(
        `taskId ${taskId} 只在账本里(${taskRecordPath(found.cwd, taskId)}):该任务由上一个桥进程派发,` +
          `事件流只在进程内存里、没有落盘,无法回放。要判断它跑成什么样,请用 harness_result 读账本里的结果。`,
      );
    }
    throw new DispatchRejected(`未知 taskId: ${taskId} —— 本进程内存与本机账本里都没有它。`);
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
    if (running) await running;
    const state = this.#tasks.get(taskId);
    if (state?.result) return state.result;
    if (state) throw new DispatchRejected(`taskId ${taskId} 已结束但没有结果`);

    // 不在本进程内存里 —— 可能是宿主重启前那次派发的。账本里有正文就直接读回来,
    // 这正是它存在的意义:让"重启后拿不到产出"变成"读得到,只是过程看不到"。
    const found = locateTaskRecord(taskId);
    if (!found) {
      throw new DispatchRejected(
        `未知 taskId: ${taskId} —— 本进程内存与本机账本里都没有它。账本只记本机派发过的任务,请先核对 ID。`,
      );
    }
    const { record, cwd } = found;
    const note = journalNote(record, cwd);
    const interrupted = record.status === 'running';
    return {
      taskId,
      harness: record.harness,
      tier: record.tier,
      status: interrupted ? 'failed' : record.status,
      text: record.text,
      usage: record.usage,
      eventCount: 0,
      startedAt: record.startedAt,
      // 没写终态就是**没有**结束时间。此处绝不拿 startedAt 顶替:那会让"被中断"看起来像
      // "开始即结束",调用方据此判断时序会得出完全错误的结论。
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      reason: interrupted ? note.reason : (record.reason ?? note.reason),
      isolated: record.isolated,
      model: record.model,
      worktreePath: record.worktreePath,
      fromJournal: true,
      journalPath: note.journalPath,
    };
  }

  /** 等所有在跑的任务结束(CLI 收尾用)。 */
  async idle(): Promise<void> {
    await Promise.all([...this.#running.values()]);
  }
}