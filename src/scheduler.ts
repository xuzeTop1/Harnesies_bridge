import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runStreaming } from './proc.ts';
import {
  locateTaskRecord,
  recordDispatch,
  recordFinish,
  readEventLog,
  readProgress,
  appendEvent,
  startHeartbeat,
  taskRecordPath,
} from './journal.ts';
import type { EventLogLine, TaskProgress, TaskRecord } from './journal.ts';
import { checkCloudPolicies, readCloudPolicies } from './policy.ts';
import { redactCredentials, redactSecretsInText } from './redact.ts';
import { auditDisk, snapshotDisk } from './audit.ts';
import type { DiskSnapshot } from './audit.ts';
import { enforcementNote, enforcementOf } from './enforcement.ts';
import { buildWorkerEnv } from './env.ts';
import { allocateWorktree, captureDiff, git, isGitRepo, realpathOr, removeWorktree, resolveReusableWorktree } from './worktree.ts';
import type {
  Adapter,
  ApprovalEnforcement,
  ApprovalLevel,
  BridgeEvent,
  EgressReport,
  HarnessModels,
  ModelCatalog,
  SpawnPlan,
  TaskResult,
  TaskSpec,
  TaskStatus,
  Tier,
  Usage,
  UsageReporting,
} from './types.ts';
import { DispatchRejected, usageTotal } from './types.ts';

const LEVELS: readonly ApprovalLevel[] = ['read-only', 'workspace-write', 'full'];

/** worker 产出的 diff 保留上限,防止超长 patch 把内存和上下文撑爆。 */
// 可覆盖是为了让"截断"这条安全分支真的能被测到 —— 否则用例得先造一份 200KB 的 diff。
const DIFF_CAP = Number(process.env.LLMS_BRIDGE_DIFF_CAP ?? 200_000);

/**
 * In-memory bounds per task. A long session used to keep every event with its full raw payload
 * (1,500 events of 4 KB → 12 MB held, and harness_events returned all of it at once).
 */
const EVENT_FIELD_CAP_MEM = Number(process.env.LLMS_BRIDGE_EVENT_MEM_FIELD_CAP ?? 16_000);
const EVENTS_IN_MEMORY = Number(process.env.LLMS_BRIDGE_EVENTS_IN_MEMORY ?? 5_000);
/**
 * The MCP server lives as long as the host session (days). Finished tasks beyond this many keep
 * their result in memory but hand their event list back to the on-disk journal.
 */
const FINISHED_WITH_EVENTS = Number(process.env.LLMS_BRIDGE_FINISHED_WITH_EVENTS ?? 50);

/** 只对声明支持的档位给结论;没实测过的由 enforcementOf() 落成 'unknown',不默认成拦得住。 */
function enforcementMap(adapter: Adapter): Partial<Record<ApprovalLevel, ApprovalEnforcement>> {
  const out: Partial<Record<ApprovalLevel, ApprovalEnforcement>> = {};
  for (const level of adapter.supportedApprovals) out[level] = enforcementOf(adapter, level);
  return out;
}

/** What max_tokens can do for this adapter, in one sentence for the caller. */
function maxTokensEnforcement(reporting: UsageReporting | undefined, maxTokens: number | undefined): string | undefined {
  if (maxTokens === undefined) return undefined;
  switch (reporting ?? 'none') {
    case 'streaming':
      return 'mid-run: usage arrives while the worker runs; the run is stopped as soon as the total exceeds max_tokens';
    case 'final':
      return 'post-run only: this CLI reports usage when the run ends, so max_tokens can mark the task failed but cannot stop it early — rely on max_wall_ms';
    default:
      return 'not enforceable: this harness does not report token usage — rely on max_wall_ms';
  }
}

/**
 * A prefix that does not keep its parent alive. V8 represents `s.slice()` as a view onto `s`, so
 * clipping a 200 KB tool result to 16 KB with slice() still retained all 200 KB (measured: heap
 * went *up*, 40.6 → 80.8 MB, for 200 such events). Copying through a Buffer detaches it.
 */
export function detachedPrefix(s: string, n: number): string {
  return Buffer.from(s.slice(0, n), 'utf8').toString('utf8');
}

function clipForMemory(e: BridgeEvent): BridgeEvent {
  let out = e;
  if (typeof e.text === 'string' && e.text.length > EVENT_FIELD_CAP_MEM) {
    out = { ...out, text: detachedPrefix(e.text, EVENT_FIELD_CAP_MEM) + '\n...[clipped in memory]' };
  }
  if (e.raw !== undefined) {
    const encoded = typeof e.raw === 'string' ? e.raw : JSON.stringify(e.raw);
    if (encoded !== undefined && encoded.length > EVENT_FIELD_CAP_MEM) {
      out = { ...out, raw: detachedPrefix(encoded, EVENT_FIELD_CAP_MEM) + '...[clipped in memory]' };
    }
  }
  return out;
}

interface TaskState {
  /** 调用方给的原始 spec(cwd 已规范化为 realpath)。 */
  spec: TaskSpec;
  /** 实际执行用的 spec(cwd 可能被换成 worktree)。 */
  runSpec: TaskSpec;
  harness: string;
  tier: Tier;
  startedAt: number;
  events: BridgeEvent[];
  /** Events dropped from the front of `events` because of EVENTS_IN_MEMORY. */
  droppedEvents: number;
  seq: number;
  finished: boolean;
  result?: TaskResult;
  isolated: boolean;
  worktreePath?: string;
  baseCommit?: string;
  /** 派发前对**调用方原始 cwd** 拍的快照;审计要拿它当基线。 */
  diskBefore?: DiskSnapshot;
  /** 关掉这个任务的心跳定时器。#execute 抛异常时也必须关。 */
  stopBeat?: () => void;
  abort: AbortController;
  cancelReason?: string;
  envWithheld: string[];
  usageReporting: UsageReporting;
  /** Events were released from memory (older finished task); read them from the journal. */
  eventsEvicted?: boolean;
}

export interface DispatchAck {
  taskId: string;
  /** 是否分配了独立 worktree。 */
  isolated: boolean;
  worktreePath?: string;
  /** Worktree tasks: the commit the worktree was created from. */
  baseCommit?: string;
  /**
   * 这次用的档位实际拦不拦得住。放在 ack 是刻意的:调用方在**派发那一刻**就该知道
   * 自己买到了什么,而不是等结果出来才发现"只读"是个标签。
   */
  approvalEnforcement: ApprovalEnforcement;
  approvalNote: string;
  /** 这次派发的数据去向(adapter 自报;它不知道就留空,调度器绝不替它编)。 */
  egress?: EgressReport;
  /** Policy files that applied to this dispatch (all allowed it). */
  policies?: string[];
  /** Names (never values) of credential variables withheld from the worker. */
  envWithheld: string[];
  /** What max_tokens can actually do for this harness (absent when max_tokens was not given). */
  maxTokensEnforcement?: string;
}

export interface HarnessInfo {
  id: string;
  tier: Tier;
  displayName: string;
  supportedApprovals: readonly ApprovalLevel[];
  /**
   * 逐档位的"拦不拦得住"。必须和 supportedApprovals 一起给。
   */
  approvalEnforcement: Partial<Record<ApprovalLevel, ApprovalEnforcement>>;
  usageReporting: UsageReporting;
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
   * 以下三项来自**落盘账本**而不是内存:说明这个任务不属于本进程。
   */
  fromJournal?: boolean;
  reason?: string;
  journalPath?: string;
  progress?: TaskProgress;
}

export interface EventsPageOptions {
  sinceSeq?: number;
  /** Max events returned (default 50, at most 500). */
  limit?: number;
  /** Approximate cap on the serialized page (default 64 KB, at most 1 MB). */
  maxBytes?: number;
  /** Include vendor raw payloads (default false: they are large and duplicate `text`). */
  includeRaw?: boolean;
}

export interface EventsPage {
  taskId: string;
  /** Events known for the task (memory or journal). */
  total: number;
  returned: number;
  events: BridgeEvent[];
  /** Pass as `since_seq` to continue; absent when nothing is left. */
  nextSeq?: number;
  hasMore: boolean;
  /** Fields cut to fit max_bytes. */
  clippedFields: number;
  /** Older events no longer held in memory (still in the on-disk journal, subject to its caps). */
  droppedFromMemory?: number;
  fromJournal?: boolean;
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
        : `该任务由**上一个桥进程**派发(${at}),本进程内存里没有它;结果与事件流都读自落盘账本。`,
  };
}

function pageOf(
  taskId: string,
  all: BridgeEvent[],
  opts: EventsPageOptions,
  extra: { total: number; droppedFromMemory?: number; fromJournal?: boolean },
): EventsPage {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const maxBytes = Math.max(1_000, Math.min(1_000_000, Math.floor(opts.maxBytes ?? 64_000)));
  const since = opts.sinceSeq;
  const candidates = since === undefined ? all : all.filter((e) => e.seq >= since);
  const events: BridgeEvent[] = [];
  let bytes = 0;
  let clippedFields = 0;
  for (const e of candidates) {
    if (events.length >= limit) break;
    let ev: BridgeEvent = opts.includeRaw ? e : { ...e, raw: undefined };
    if (!opts.includeRaw) delete (ev as { raw?: unknown }).raw;
    let size = JSON.stringify(ev).length;
    const room = maxBytes - bytes;
    if (size > room) {
      if (events.length > 0) break; // the next page starts here
      // A single oversized event: shrink its fields so progress is always possible.
      const budget = Math.max(200, Math.floor(room / 2));
      if (typeof ev.text === 'string' && ev.text.length > budget) {
        ev = { ...ev, text: ev.text.slice(0, budget) + '...[clipped to max_bytes]' };
        clippedFields++;
      }
      if (ev.raw !== undefined) {
        const enc = typeof ev.raw === 'string' ? ev.raw : JSON.stringify(ev.raw);
        if (enc.length > budget) {
          ev = { ...ev, raw: enc.slice(0, budget) + '...[clipped to max_bytes]' };
          clippedFields++;
        }
      }
      size = JSON.stringify(ev).length;
    }
    events.push(ev);
    bytes += size;
  }
  const last = events[events.length - 1];
  const remaining = last === undefined ? candidates.length : candidates.filter((e) => e.seq > last.seq).length;
  return {
    taskId,
    total: extra.total,
    returned: events.length,
    events,
    hasMore: remaining > 0,
    ...(remaining > 0 && last !== undefined ? { nextSeq: last.seq + 1 } : {}),
    clippedFields,
    ...(extra.droppedFromMemory ? { droppedFromMemory: extra.droppedFromMemory } : {}),
    ...(extra.fromJournal ? { fromJournal: true } : {}),
  };
}

export class Scheduler {
  #adapters: Map<string, Adapter>;
  #tasks = new Map<string, TaskState>();
  #running = new Map<string, Promise<void>>();
  #detectPromise: Promise<HarnessReport[]> | null = null;
  /** Finished task ids whose events are still in memory, oldest first. */
  #finishedOrder: string[] = [];

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
      usageReporting: a.usageReporting ?? 'none',
    }));
  }

  /**
   * 探测并**缓存**结果。层级① 的探测要跑一次真实 ACP 握手,是秒级的;要刷新就传 force=true。
   */
  detectAll(force = false): Promise<HarnessReport[]> {
    if (force || this.#detectPromise === null) {
      this.#detectPromise = this.#runDetect();
    }
    return this.#detectPromise;
  }

  async #runDetect(): Promise<HarnessReport[]> {
    return Promise.all(
      [...this.#adapters.values()].map(async (a) => {
        const d = await a.detect().catch((err: unknown) => ({ available: false, detail: `detect 抛错: ${String(err)}` }) as const);
        return {
          id: a.id,
          tier: a.tier,
          displayName: a.displayName,
          supportedApprovals: a.supportedApprovals,
          approvalEnforcement: enforcementMap(a),
          usageReporting: a.usageReporting ?? 'none',
          available: d.available,
          version: 'version' in d ? d.version : undefined,
          detail: d.detail,
          // 出口自报失败 ≠ 该 harness 不可用:降级成"桥不知道",不许把探测整体拖挂。
          egress: a.egress ? await a.egress().catch(() => undefined) : undefined,
        };
      }),
    );
  }

  /**
   * 派发任务。**同步返回 task_id**,执行在后台跑。
   */
  async dispatch(input: TaskSpec): Promise<DispatchAck> {
    if (typeof input.taskId !== 'string' || input.taskId.length === 0) {
      throw new DispatchRejected('taskId 必填');
    }
    if (this.#tasks.has(input.taskId)) throw new DispatchRejected(`taskId ${input.taskId} 已在本进程使用过`);
    if (typeof input.prompt !== 'string' || input.prompt.length === 0) {
      throw new DispatchRejected('prompt 必填');
    }
    if (typeof input.cwd !== 'string' || input.cwd.length === 0) {
      throw new DispatchRejected('cwd 必填');
    }
    // A mistyped cwd used to be created on the fly by the journal (mkdir -p <cwd>/.llms-bridge/…).
    const cwdStat = existsSync(input.cwd) ? statSync(input.cwd) : null;
    if (!cwdStat?.isDirectory()) throw new DispatchRejected(`cwd 不存在或不是目录: ${input.cwd}`);
    const spec: TaskSpec = { ...input, cwd: realpathOr(input.cwd) };

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
    if (spec.budget.maxTokens !== undefined && (!Number.isFinite(spec.budget.maxTokens) || spec.budget.maxTokens <= 0)) {
      throw new DispatchRejected('budget.maxTokens 给了就必须是正数');
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

    // 仓库级云策略:只读档的 worker 照样会把仓库内容发给模型,所以与档位无关,一律在派发前过闸。
    // Checked before any side effect (no worktree is created for a dispatch the policy refuses).
    const [egress, policies] = await Promise.all([
      adapter.egress ? adapter.egress({ cwd: spec.cwd }).catch(() => undefined) : Promise.resolve(undefined),
      readCloudPolicies(spec.cwd),
    ]);
    const verdict = checkCloudPolicies(policies, adapter.id, egress);
    if (!verdict.allowed) throw new DispatchRejected(verdict.reason ?? '被云策略拒绝');

    // 写任务必须隔离(AGENTS.md 铁律三)。三种形态由调用方选。
    let effectiveCwd = spec.cwd;
    let worktreePath: string | undefined;
    let baseCommit: string | undefined;
    let isolated = false;

    if (spec.approval === 'read-only' && spec.reuseWorktreePath !== undefined) {
      throw new DispatchRejected(
        `approval='read-only' 不涉及 worktree,不支持 reuseWorktreePath。` +
          `若想让只读任务读某个已有 worktree 的快照,直接把 cwd 设成那个路径(不传本字段)。`,
      );
    }

    // 探测放在所有校验之后:被拒绝的请求不该等一轮 ACP 握手。plan() 需要 adapter 已探测完。
    await this.detectAll();

    if (spec.approval !== 'read-only') {
      if (spec.reuseWorktreePath !== undefined) {
        try {
          const reused = await resolveReusableWorktree(spec.cwd, spec.reuseWorktreePath);
          effectiveCwd = reused;
          worktreePath = reused;
          isolated = true;
        } catch (err) {
          throw new DispatchRejected(`复用 worktree 失败: ${(err as Error).message}`);
        }
      } else if (spec.allowUnisolatedWrite === true) {
        for (const t of this.#tasks.values()) {
          if (!t.finished && !t.isolated && t.spec.cwd === spec.cwd && t.spec.approval !== 'read-only') {
            throw new DispatchRejected(`同一工作目录已有未隔离的可写任务在跑(${t.spec.taskId});并行写会互相覆盖。`);
          }
        }
      } else if (await isGitRepo(spec.cwd)) {
        try {
          const wt = await allocateWorktree(spec.cwd, spec.taskId);
          effectiveCwd = wt.workCwd;
          worktreePath = wt.path;
          baseCommit = wt.baseCommit;
          isolated = true;
        } catch (err) {
          throw new DispatchRejected(`分配 worktree 失败: ${(err as Error).message}`);
        }
      } else {
        throw new DispatchRejected(
          `${spec.cwd} 不是 git 仓库,无法给写任务分配独立 worktree(AGENTS.md 铁律三)。` +
            `改用 approval='read-only',或显式传 allowUnisolatedWrite=true(风险自负,结果会标记 isolated=false)。`,
        );
      }
    }

    const runSpec: TaskSpec = { ...spec, cwd: effectiveCwd };
    // plan() 会在此处抛出(二进制未探测到、prompt 太长等),让派发失败在调用方当场可见。
    // A worktree created for this dispatch must not be left behind by a rejected plan.
    let plan: SpawnPlan;
    try {
      plan = adapter.plan(runSpec);
    } catch (err) {
      if (baseCommit !== undefined && worktreePath !== undefined) {
        await removeWorktree(spec.cwd, worktreePath).catch(() => {});
      }
      throw err;
    }

    const allowedEnv = adapter.credentialEnv ? await adapter.credentialEnv(process.env) : [];
    const workerEnv = buildWorkerEnv(process.env, allowedEnv);

    // 基线紧贴启动取;拍的是 spec.cwd(**调用方给的那个目录**),不是被换成的 worktree。
    const diskBefore = await snapshotDisk(spec.cwd);

    const state: TaskState = {
      spec,
      runSpec,
      harness: adapter.id,
      tier: adapter.tier,
      startedAt: Date.now(),
      events: [],
      droppedEvents: 0,
      seq: 0,
      finished: false,
      isolated,
      worktreePath,
      baseCommit,
      diskBefore,
      abort: new AbortController(),
      envWithheld: workerEnv.withheld,
      usageReporting: adapter.usageReporting ?? 'none',
    };
    this.#tasks.set(spec.taskId, state);
    // 账本写在启动**之前**:启动后进程随时可能被杀,那就什么痕迹都没有了。
    recordDispatch(spec, effectiveCwd, adapter.tier, isolated, egress?.endpointHost, {
      worktreePath,
      baseCommit,
      envWithheld: workerEnv.withheld,
    });
    // Whatever happens inside #execute, the task must end in a recorded state and nothing may
    // escape as an unhandled rejection (that used to terminate the whole MCP server).
    this.#running.set(
      spec.taskId,
      this.#execute(adapter, runSpec, state, plan, workerEnv.env)
        .catch((err: unknown) => this.#failTask(state, err))
        .finally(() => {
          this.#retire(spec.taskId);
          state.stopBeat?.();
          // The stopper closes over #execute's scope, which also holds the parser and everything it
          // accumulated. Keeping it on the (long-lived) task state leaked every finished task's
          // streamed text for the life of the bridge process.
          state.stopBeat = undefined;
        }),
    );

    const approvalEnforcement = enforcementOf(adapter, spec.approval);
    return {
      taskId: spec.taskId,
      isolated,
      worktreePath,
      baseCommit,
      approvalEnforcement,
      approvalNote: enforcementNote(spec.approval, approvalEnforcement),
      egress: egress ? { ...egress, promptBytes: Buffer.byteLength(spec.prompt, 'utf8') } : undefined,
      policies: verdict.policies,
      envWithheld: workerEnv.withheld,
      maxTokensEnforcement: maxTokensEnforcement(adapter.usageReporting, spec.budget.maxTokens),
    };
  }

  #retire(taskId: string): void {
    this.#finishedOrder.push(taskId);
    while (this.#finishedOrder.length > FINISHED_WITH_EVENTS) {
      const old = this.#tasks.get(this.#finishedOrder.shift()!);
      if (old) {
        old.events = [];
        old.eventsEvicted = true;
      }
    }
  }

  /** Stop a running task and everything it started. Returns false when it already finished. */
  cancel(taskId: string, reason = 'cancelled by caller'): boolean {
    const state = this.#tasks.get(taskId);
    if (!state) {
      if (locateTaskRecord(taskId)) {
        throw new DispatchRejected(`taskId ${taskId} 属于上一个桥进程,本进程无法控制它(它的进程若还在,需手动结束)`);
      }
      throw new DispatchRejected(`未知 taskId: ${taskId}`);
    }
    if (state.finished) return false;
    state.cancelReason = reason;
    state.abort.abort();
    return true;
  }

  /** Cancel every running task (bridge shutdown). */
  cancelAll(reason: string): number {
    let n = 0;
    for (const s of this.#tasks.values()) {
      if (!s.finished) {
        s.cancelReason = reason;
        s.abort.abort();
        n++;
      }
    }
    return n;
  }

  #push(state: TaskState, e: Omit<BridgeEvent, 'seq'> & { seq?: number }): BridgeEvent {
    const event: BridgeEvent = { ...e, seq: state.seq++ } as BridgeEvent;
    // 脱敏收在这一个出口:落盘比交回主脑更难撤回。
    const safe: BridgeEvent = {
      ...event,
      ...(typeof event.text === 'string' ? { text: redactSecretsInText(event.text).text } : {}),
      ...(event.raw === undefined ? {} : { raw: redactCredentials(event.raw) }),
    };
    appendEvent(state.runSpec.cwd, safe);
    state.events.push(clipForMemory(safe));
    if (state.events.length > EVENTS_IN_MEMORY) {
      state.events.shift();
      state.droppedEvents++;
    }
    return safe;
  }

  #failTask(state: TaskState, err: unknown): void {
    if (state.finished) return;
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.#push(state, {
        taskId: state.spec.taskId,
        harness: state.harness,
        tier: state.tier,
        type: 'error',
        at: Date.now(),
        text: `bridge internal error: ${message}`,
      });
    } catch {
      /* the result below still records the failure */
    }
    state.result = {
      taskId: state.spec.taskId,
      harness: state.harness,
      tier: state.tier,
      status: 'failed',
      reason: `bridge internal error: ${message}`,
      eventCount: state.seq,
      startedAt: state.startedAt,
      endedAt: Date.now(),
      isolated: state.isolated,
      worktreePath: state.worktreePath,
      baseCommit: state.baseCommit,
      envWithheld: state.envWithheld,
    };
    state.finished = true;
    try {
      recordFinish(state.runSpec.cwd, state.spec.taskId, { status: 'failed', reason: state.result.reason, usage: undefined });
    } catch {
      /* journal is best-effort */
    }
  }

  async #execute(
    adapter: Adapter,
    spec: TaskSpec,
    state: TaskState,
    plan: SpawnPlan,
    env: Record<string, string>,
  ): Promise<void> {
    const parser = adapter.createRun(spec, spec.taskId);
    let usage: Usage | undefined;
    let overBudget = false;
    let parserErrors = 0;
    let parserEmittedResult = false;

    const emit = (e: BridgeEvent): void => {
      this.#push(state, e);
    };

    // 心跳:让"这个任务还在被看着"这件事有落盘证据,面板才谈得上进度。
    const beat = startHeartbeat(spec.cwd, spec.taskId, () => {
      const last = state.events[state.events.length - 1];
      return { events: state.seq, lastSeq: last?.seq, lastType: last?.type, lastEventAt: last?.at, tokens: usageTotal(usage) };
    });
    state.stopBeat = () => beat.stop();

    const outcome = await runStreaming({
      command: plan.command,
      args: plan.args,
      cwd: spec.cwd,
      env: { ...env, ...(plan.env ?? {}) },
      maxWallMs: spec.budget.maxWallMs,
      needsStdin: plan.needsStdin,
      stdinData: plan.stdin,
      signal: state.abort.signal,
      onStdin: (write) => parser.onStart?.(write),
      onLine: (line) => {
        let parsed: BridgeEvent[];
        try {
          parsed = parser.parseLine(line);
        } catch (err) {
          // A vendor output shape the parser did not expect must not take the bridge down.
          parserErrors++;
          parsed = [
            {
              taskId: spec.taskId,
              seq: 0,
              harness: adapter.id,
              tier: adapter.tier,
              type: 'error',
              at: Date.now(),
              text: `parser error: ${(err as Error).message}`,
              raw: line.slice(0, 2_000),
            },
          ];
        }
        for (const e of parsed) {
          if (e.type === 'result') parserEmittedResult = true;
          emit(e);
          if (e.usage) {
            // Adapters report cumulative usage for the task so far.
            usage = e.usage;
            if (spec.budget.maxTokens !== undefined && usageTotal(usage) > spec.budget.maxTokens) overBudget = true;
          }
        }
      },
      shouldAbort: () => overBudget || parser.shouldStop?.() === true,
    });

    let fin: ReturnType<typeof parser.finalize>;
    try {
      fin = parser.finalize(outcome.exitCode ?? -1);
    } catch (err) {
      fin = { errorText: `parser finalize error: ${(err as Error).message}` };
    }
    if (fin.usage && usageTotal(fin.usage) >= usageTotal(usage)) usage = fin.usage;
    if (spec.budget.maxTokens !== undefined && usageTotal(usage) > spec.budget.maxTokens) overBudget = true;

    // 会话型协议(层级①)是"我们主动收工才 kill 子进程",所以退出码天然非零 —— 协议自己说完成了就算完成。
    const protocolDone = parser.shouldStop?.() === true;

    let status: TaskStatus = 'ok';
    let reason: string | undefined;
    if (outcome.spawnError !== undefined) {
      status = 'failed';
      reason = `worker 进程没能启动: ${outcome.spawnError}`;
    } else if (outcome.cancelled) {
      status = 'cancelled';
      reason = state.cancelReason ?? 'cancelled';
    } else if (outcome.timedOut) {
      status = 'timeout';
      reason = `超过 budget.maxWallMs=${spec.budget.maxWallMs}ms,已中断进程树`;
    } else if (outcome.aborted && overBudget) {
      status = 'failed';
      reason = `超过 budget.maxTokens=${spec.budget.maxTokens}(累计约 ${usageTotal(usage)},含缓存 token),已中断`;
    } else if (fin.errorText) {
      status = 'failed';
      reason = fin.errorText;
    } else if (!protocolDone && outcome.exitCode !== 0) {
      status = 'failed';
      reason = `退出码 ${outcome.exitCode}${outcome.exitSignal ? ` (signal ${outcome.exitSignal})` : ''}`;
    } else if (overBudget) {
      // Usage only arrived at the end ('final' adapters): the run finished but broke the budget.
      status = 'failed';
      reason = `超过 budget.maxTokens=${spec.budget.maxTokens}(累计 ${usageTotal(usage)});该 harness 只在结束时报用量,无法中途停下`;
    }
    if (outcome.pipeLeftOpen) {
      emit({
        taskId: spec.taskId,
        seq: 0,
        harness: adapter.id,
        tier: adapter.tier,
        type: 'status',
        at: Date.now(),
        text: 'worker 退出后仍有它启动的进程占着 stdout;桥已结束该进程组并停止等待',
      });
    }
    if (parserErrors > 0 || outcome.callbackErrors > 0) {
      reason = `${reason ? reason + ' | ' : ''}${parserErrors + outcome.callbackErrors} 行输出解析出错(见 error 事件)`;
    }

    // 各家 CLI 的 stderr 里常常写着"为什么没干成" —— 原话必须转达(末尾 4000 字符)。
    const stderrTail = outcome.stderrTail.trim();
    if (stderrTail.length > 0 && status !== 'ok') {
      reason = `${reason ?? '失败'} | stderr: ${redactSecretsInText(stderrTail).text}`;
    }

    // worker 的改动以 diff 形式回收,不直接合并回源仓库(AGENTS.md 铁律三)。
    let capturedDiff: string | undefined;
    let diffTruncated: boolean | undefined;
    let diffPath: string | undefined;
    let diffRedactions: number | undefined;
    let workerCommits: string[] | undefined;
    // 只读档**不跑** captureDiff:`git add -A` 会把别人工作区里既有的未提交改动一并暂存。
    if (state.worktreePath && spec.approval !== 'read-only') {
      try {
        const base = state.baseCommit ?? (await this.#headOf(state.worktreePath));
        const { patch, stat, commits } = await captureDiff(state.worktreePath, base);
        workerCommits = commits.length > 0 ? commits : undefined;
        if (stat.trim().length > 0) {
          // The full patch stays on local disk (owner-only), next to the task record.
          diffPath = join(spec.cwd, '.llms-bridge', 'tasks', `${spec.taskId}.diff`);
          try {
            writeFileSync(diffPath, patch, { encoding: 'utf8', mode: 0o600 });
          } catch {
            diffPath = undefined;
          }
          const red = redactSecretsInText(patch);
          diffRedactions = red.count || undefined;
          const truncated = red.text.length > DIFF_CAP;
          diffTruncated = truncated;
          capturedDiff = truncated ? detachedPrefix(red.text, DIFF_CAP) + '\n...[diff 已截断]' : red.text;
          emit({
            taskId: spec.taskId,
            seq: 0,
            harness: adapter.id,
            tier: adapter.tier,
            type: 'diff',
            at: Date.now(),
            text: stat.trim(),
            raw: capturedDiff,
          });
        } else {
          emit({
            taskId: spec.taskId,
            seq: 0,
            harness: adapter.id,
            tier: adapter.tier,
            type: 'status',
            at: Date.now(),
            text: 'worktree 内无改动',
          });
        }
      } catch (err) {
        emit({
          taskId: spec.taskId,
          seq: 0,
          harness: adapter.id,
          tier: adapter.tier,
          type: 'error',
          at: Date.now(),
          text: `回收 diff 失败: ${(err as Error).message}`,
        });
      }
    }

    const red = fin.text === undefined ? undefined : redactSecretsInText(fin.text);
    const finalText = red?.text;

    // 终态 result 只应有一条:仅当解析器没交出 result 时才补(例如层级③ 的 codex 不发 result 行)。
    if (!parserEmittedResult) {
      emit({
        taskId: spec.taskId,
        seq: 0,
        harness: adapter.id,
        tier: adapter.tier,
        type: 'result',
        at: Date.now(),
        text: finalText,
        usage,
      });
    }

    const endedAt = Date.now();

    // 审计的对象是 state.spec.cwd —— **调用方给的目录**,不是 runSpec 那个被换成的 worktree。
    const diskAudit = await auditDisk(state.spec.cwd, state.diskBefore ?? { repo: false, whyNot: '桥没取到派发前快照' });

    //  - 只读档:改了这个目录里的任何东西就是违约;
    //  - 写档且已隔离:worker 的写应该全在 worktree 里,主目录动了说明它跑出去了;
    //  - 写档且调用方主动放弃隔离:改 cwd 是它要的行为,不算越界。
    const escaped =
      diskAudit.audited === true &&
      diskAudit.changed === true &&
      (spec.approval === 'read-only' || state.isolated);
    if (escaped) {
      const parts: string[] = [];
      if (diskAudit.headMoved) parts.push('HEAD 移动(在你仓库里提交了)');
      if ((diskAudit.paths?.length ?? 0) > 0) parts.push(`${diskAudit.paths!.length} 处文件`);
      if ((diskAudit.refsChanged?.length ?? 0) > 0) parts.push(`refs 变化: ${diskAudit.refsChanged!.join(', ')}`);
      if (status === 'ok' || status === 'failed') status = 'failed';
      reason = `越界改动:审批档位=${spec.approval} 隔离=${state.isolated},但 ${state.spec.cwd} 被改动了 ${parts.join('; ')}${reason ? ` | ${reason}` : ''}`;
    }

    const approvalEnforcement = enforcementOf(adapter, spec.approval);
    const accounting =
      state.usageReporting === 'streaming'
        ? 'usage reported during the run (cumulative, cache tokens included in input)'
        : state.usageReporting === 'final'
          ? 'usage reported only when the run ended (cumulative, cache reads are part of input)'
          : 'this harness reports no token usage';

    state.result = {
      taskId: spec.taskId,
      harness: adapter.id,
      tier: adapter.tier,
      status,
      text: finalText,
      structured: fin.structured,
      usage,
      eventCount: state.seq,
      startedAt: state.startedAt,
      endedAt,
      reason,
      isolated: state.isolated,
      approvalEnforcement,
      approvalNote: enforcementNote(spec.approval, approvalEnforcement),
      diskAudit,
      model: spec.model,
      worktreePath: state.worktreePath,
      baseCommit: state.baseCommit,
      workerCommits,
      diff: capturedDiff,
      diffTruncated,
      diffPath,
      diffRedactions,
      envWithheld: state.envWithheld,
      usageAccounting: accounting,
      textRedactions: red?.count || undefined,
    };
    state.finished = true;
    recordFinish(spec.cwd, spec.taskId, {
      status,
      reason,
      usage,
      text: finalText,
      baseCommit: state.baseCommit,
      workerCommits,
      diffPath,
    });
  }

  async #headOf(dir: string): Promise<string | undefined> {
    const r = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
    return r.ok ? r.stdout.trim() : undefined;
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
          eventCount: readEventLog(cwd, taskId, Infinity).total,
          usageTokens: record.usage ? usageTotal(record.usage) : undefined,
          isolated: record.isolated,
          worktreePath: record.worktreePath,
          fromJournal: true,
          reason: note.reason,
          journalPath: note.journalPath,
          progress: readProgress(cwd, taskId, record),
        };
      }
      throw new DispatchRejected(
        `未知 taskId: ${taskId} —— 本进程内存与本机账本里都没有它。账本只记本机派发过的任务,请先核对 ID。`,
      );
    }
    const last = state.events[state.events.length - 1];
    const usage = state.result?.usage ?? [...state.events].reverse().find((e) => e.usage)?.usage;
    return {
      taskId,
      harness: state.harness,
      tier: state.tier,
      finished: state.finished,
      status: state.result?.status,
      eventCount: state.seq,
      lastEvent: last ? clipForMemory({ ...last, raw: undefined }) : undefined,
      usageTokens: usage ? usageTotal(usage) : undefined,
      isolated: state.isolated,
      worktreePath: state.worktreePath,
      progress: readProgress(
        state.runSpec.cwd,
        taskId,
        { status: state.finished ? (state.result?.status ?? 'ok') : 'running', startedAt: state.startedAt },
        {
          events: state.seq,
          tokens: usageTotal(usage),
          lastType: last?.type,
          lastEventAt: last?.at,
        },
      ),
    };
  }

  /** All events still held (memory) or on disk (journal). Unbounded: prefer eventsPage(). */
  events(taskId: string): BridgeEvent[] {
    const state = this.#tasks.get(taskId);
    if (state && !state.eventsEvicted) return state.events;
    return this.#journalEvents(taskId).events;
  }

  #journalEvents(taskId: string): { events: BridgeEvent[]; total: number } {
    const found = locateTaskRecord(taskId);
    if (!found) {
      throw new DispatchRejected(`未知 taskId: ${taskId} —— 本进程内存与本机账本里都没有它。`);
    }
    const { record, cwd } = found;
    const log = readEventLog(cwd, taskId, Infinity);
    if (log.total === 0) {
      // 读不到就明说读不到,不回空数组 —— 空数组会被读成"跑过,但一个事件都没有"。
      throw new DispatchRejected(
        `taskId ${taskId} 在账本里(${taskRecordPath(cwd, taskId)}),但事件流读不到` +
          `(${log.unreadable ?? '文件是空的'}):那次派发早于事件落盘,或文件没能写出来。` +
          `结果仍可用 harness_result 读账本。`,
      );
    }
    const events = log.lines.map((l: EventLogLine) => ({
      taskId,
      seq: l.seq,
      harness: record.harness,
      tier: record.tier,
      type: l.type as BridgeEvent['type'],
      at: l.at,
      ...(l.text === undefined ? {} : { text: l.text }),
      ...(l.usage === undefined ? {} : { usage: l.usage }),
      ...(l.raw === undefined ? {} : { raw: l.raw }),
    }));
    return { events, total: log.total };
  }

  /** Bounded page of events for MCP responses (see EventsPageOptions). */
  eventsPage(taskId: string, opts: EventsPageOptions = {}): EventsPage {
    const state = this.#tasks.get(taskId);
    if (state && !state.eventsEvicted) {
      return pageOf(taskId, state.events, opts, { total: state.seq, droppedFromMemory: state.droppedEvents });
    }
    const j = this.#journalEvents(taskId);
    return pageOf(taskId, j.events, opts, { total: j.total, fromJournal: true });
  }

  #modelCache = new Map<string, ModelCatalog | null>();

  /**
   * 各 harness **自己声明**的模型清单。不自报的一律 `declared:false` 且 `models:[]`。
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
      status: record.status === 'running' ? 'failed' : record.status,
      text: record.text,
      usage: record.usage,
      eventCount: readEventLog(cwd, taskId, Infinity).total,
      startedAt: record.startedAt,
      // 没写终态就是**没有**结束时间。此处绝不拿 startedAt 顶替。
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      reason: interrupted ? note.reason : (record.reason ?? note.reason),
      isolated: record.isolated,
      model: record.model,
      worktreePath: record.worktreePath,
      ...(record.baseCommit ? { baseCommit: record.baseCommit } : {}),
      ...(record.workerCommits ? { workerCommits: record.workerCommits } : {}),
      ...(record.diffPath ? { diffPath: record.diffPath } : {}),
      ...(record.envWithheld ? { envWithheld: record.envWithheld } : {}),
      fromJournal: true,
      journalPath: note.journalPath,
    };
  }

  /** 等所有在跑的任务结束(CLI 收尾用)。 */
  async idle(): Promise<void> {
    await Promise.all([...this.#running.values()]);
  }
}
