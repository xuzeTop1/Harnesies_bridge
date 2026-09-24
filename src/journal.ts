import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { TaskSpec, TaskStatus, Tier, Usage } from './types.ts';
import { ensureBridgeDirExcluded } from './worktree.ts';

/**
 * 任务账本:把"派发过什么、最后怎么样、产出了什么"落盘。
 *
 * 为什么需要它(MCP server 无状态是**设计**,不是缺陷 —— 缺陷是**没有任何痕迹**):
 * 实测 2026-09-23,宿主重启后新桥进程里是张空表,三个已派发的 taskId 一律回
 * "未知 taskId"。调用方由此无法分辨两件完全不同的事:
 *   (a) 这个 ID 从来没被派发过(拼错了);
 *   (b) 它派发过、进程死了,结果不可恢复。
 * 对拿它当"评议有没有跑完"依据的主脑,这两者的差别是整个判断的基础 —— 所以必须有痕迹。
 *
 * 正文(prompt/结果)按**用户 2026-09-23 的决定**落盘:整机本地、仓库无远端,
 * 且容器目录按既有约定进 .git/info/exclude,因此既不进版本库也不产生 diff。
 */

/** 单段正文(prompt、结果各算一段)的落盘上限。可覆盖是为了让截断分支真的能被测到。 */
const TEXT_CAP = Number(process.env.LLMS_BRIDGE_JOURNAL_CAP ?? 200_000);

/**
 * 索引的落点。**惰性求值**:测试要在 import 之后才把 LLMS_BRIDGE_HOME 指到临时目录,
 * 模块加载时就定死的话,`npm test` 会往用户的真实 `~/.llms-bridge/` 里写垃圾。
 */
function indexPath(): string {
  const home = process.env.LLMS_BRIDGE_HOME ?? join(homedir(), '.llms-bridge');
  return join(home, 'tasks-index.jsonl');
}

export interface TaskRecord {
  taskId: string;
  harness: string;
  tier: Tier;
  model?: string;
  approval: string;
  sessionMode: string;
  /** 调用方给的 cwd(人类回看时最认这个)。 */
  requestedCwd: string;
  /** 实际执行用的 cwd(隔离时是 worktree)。 */
  cwd: string;
  isolated: boolean;
  worktreePath?: string;
  /** 这次派发的数据发往哪个主机(harness 不自报时为 undefined)。审计"出过本机没有"就靠它。 */
  egressHost?: string;
  startedAt: number;
  endedAt?: number;
  /** running 表示"落盘时还在跑";若进程消失,它会**永远停在 running** —— 那正是中断的证据。 */
  status: 'running' | TaskStatus;
  reason?: string;
  usage?: Usage;
  prompt?: string;
  promptTruncated?: boolean;
  text?: string;
  textTruncated?: boolean;
}

export function taskRecordPath(cwd: string, taskId: string): string {
  return join(cwd, '.llms-bridge', 'tasks', `${taskId}.json`);
}

/** 超过上限就截断并**标记**,不静默丢内容。 */
function clip(text: string | undefined): { value?: string; truncated?: boolean } {
  if (text === undefined) return {};
  if (text.length <= TEXT_CAP) return { value: text };
  return { value: text.slice(0, TEXT_CAP) + '\n...[账本已截断]', truncated: true };
}

/**
 * 写一条账本记录。同步 fs 是有意的:派发那一刻进程随时可能被杀,
 * 用异步写会让"记录还没落盘就丢了"变成新的失败模式。
 */
export function writeTaskRecord(record: TaskRecord): void {
  const dir = join(record.cwd, '.llms-bridge', 'tasks');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  // 只读任务不分配 worktree,所以不会经过 allocateWorktree 那条 exclude 路径 ——
  // 不在这里补一次,账本就会以未跟踪文件的样子出现在用户的 `git status` 里。
  ensureBridgeDirExcluded(record.cwd);

  // 先写临时文件再改名:崩在写一半会留下坏 JSON,让账本反而变得不可读。
  const target = taskRecordPath(record.cwd, record.taskId);
  const temp = `${target}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(temp, target);
  } catch {
    /* 账本坏了不该拦住派发本身 */
  }
}

export function readTaskRecord(cwd: string, taskId: string): TaskRecord | null {
  try {
    const raw = readFileSync(taskRecordPath(cwd, taskId), 'utf8');
    return JSON.parse(raw) as TaskRecord;
  } catch {
    return null;
  }
}

/** 派发那一刻记一条。正文一起写,否则"进程死了"就等于连题目都找不回来。 */
export function recordDispatch(
  spec: TaskSpec,
  runCwd: string,
  tier: Tier,
  isolated: boolean,
  egressHost?: string,
): void {
  const prompt = clip(spec.prompt);
  const record: TaskRecord = {
    taskId: spec.taskId,
    harness: spec.harness,
    tier,
    model: spec.model,
    approval: spec.approval,
    sessionMode: spec.session.mode,
    requestedCwd: spec.cwd,
    cwd: runCwd,
    isolated,
    worktreePath: isolated ? runCwd : undefined,
    startedAt: Date.now(),
    status: 'running',
    prompt: prompt.value,
    promptTruncated: prompt.truncated,
    // 记下这次数据发往哪个主机:事后审计"这批内容出过本机没有"时,这是唯一的落盘依据。
    egressHost,
  };
  writeTaskRecord(record);
  void appendIndex(record);
}

/** 结束时把同一条记录补全(原地覆盖,保持一个任务一个文件)。 */
export function recordFinish(
  runCwd: string,
  taskId: string,
  patch: Pick<TaskRecord, 'status' | 'reason' | 'usage'> & { text?: string },
): void {
  const existing = readTaskRecord(runCwd, taskId);
  if (existing === null) return;
  const text = clip(patch.text);
  writeTaskRecord({
    ...existing,
    endedAt: Date.now(),
    status: patch.status,
    reason: patch.reason,
    usage: patch.usage,
    text: text.value,
    textTruncated: text.truncated,
  });
}

async function appendIndex(record: TaskRecord): Promise<void> {
  const path = indexPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    await appendFile(
      indexPath(),
      JSON.stringify({
        taskId: record.taskId,
        harness: record.harness,
        cwd: record.cwd,
        startedAt: record.startedAt,
      }) + '\n',
      'utf8',
    );
  } catch {
    /* 索引写不进去只影响"事后能不能反查",不该让派发失败 */
  }
}

/**
 * 按 taskId 反查它在哪个仓库。**倒着读**:索引是追加的,同一 ID 重复用时最近一条才算数。
 * 只回"文件存在"的那些 —— 指向已被删掉的仓库的索引项没有意义。
 */
export function locateTaskRecord(taskId: string): { cwd: string; record: TaskRecord } | null {
  const index = indexPath();
  if (!existsSync(index)) return null;
  let lines: string[];
  try {
    lines = readFileSync(index, 'utf8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let entry: { taskId?: string; cwd?: string };
    try {
      entry = JSON.parse(line) as { taskId?: string; cwd?: string };
    } catch {
      continue;
    }
    if (entry.taskId !== taskId || typeof entry.cwd !== 'string') continue;
    const record = readTaskRecord(entry.cwd, taskId);
    if (record) return { cwd: entry.cwd, record };
  }
  return null;
}

/**
 * 心跳:与账本记录**分开一个小文件**。
 *
 * 为什么不直接把 progress 写进 TaskRecord —— 记录里有 prompt 和 text(各自上限 200KB),
 * 每 3 秒整条重写一次会让一个 4 小时的任务产生几百 MB 的写入。单独一个几百字节的心跳文件,
 * 换来的是"重写成本与任务体积无关"。
 *
 * 为什么必须**无条件**按点写、而不是"有新事件才写":心跳要回答的是"桥还在看着这个任务吗",
 * 不是"worker 有没有在输出"。只在有事件时写,就把两种完全不同的状态压成了一个 ——
 * "worker 卡在长思考上但一切正常" 和 "桥进程早没了" 会长得一模一样。
 */
export interface TaskBeat {
  taskId: string;
  events: number;
  /** 最后一个事件的 seq/type/at —— 用来看"它最后在做哪类事",不是用来判活。 */
  lastSeq?: number;
  lastType?: string;
  lastEventAt?: number;
  /** 已累计 token(各家自报,没自报就是 0,不许估)。 */
  tokens: number;
  /** 这次心跳写盘的时刻。判活只看它。 */
  beatAt: number;
}

/** 心跳文件路径。与记录同目录,便于"一个任务的所有产物在一处"。 */
export function beatPath(cwd: string, taskId: string): string {
  return join(cwd, '.llms-bridge', 'tasks', `${taskId}.beat.json`);
}

export function readTaskBeat(cwd: string, taskId: string): TaskBeat | null {
  try {
    return JSON.parse(readFileSync(beatPath(cwd, taskId), 'utf8')) as TaskBeat;
  } catch {
    return null;
  }
}

export function writeTaskBeat(cwd: string, beat: TaskBeat): void {
  const dir = join(cwd, '.llms-bridge', 'tasks');
  try {
    mkdirSync(dir, { recursive: true });
    const target = beatPath(cwd, beat.taskId);
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(beat), 'utf8');
    renameSync(temp, target);
  } catch {
    /* 心跳写不进去只影响面板看不看得到,不该影响任务本身 */
  }
}

/** 心跳隔多久写一次。 */
const BEAT_MS = Number(process.env.LLMS_BRIDGE_BEAT_MS ?? 3_000);

/**
 * 心跳**失效**的判据:超过这个间隔没心跳,就不能再说"在跑"。
 *
 * 取 4 倍周期而不是 1 倍:一次 GC、一次磁盘抖动都不该把在跑的任务标成疑似死亡 ——
 * 误报"它挂了"会让人去重派,那才是真损失。
 */
export const BEAT_STALE_MS = Number(process.env.LLMS_BRIDGE_BEAT_STALE_MS ?? 12_000);

export interface Heartbeat {
  stop(): void;
}

/** 起一个心跳定时器。`unref` 是必须的:否则测试跑完进程会因为还有活定时器而吊着不退。 */
export function startHeartbeat(
  cwd: string,
  taskId: string,
  sample: () => { events: number; lastSeq?: number; lastType?: string; lastEventAt?: number; tokens: number },
): Heartbeat {
  const beat = () => writeTaskBeat(cwd, { taskId, ...sample(), beatAt: Date.now() });
  beat();
  const timer = setInterval(beat, BEAT_MS);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      // 收尾再写一次:面板据此分得清"心跳停是因为任务结束了"还是"因为桥没了"。
      beat();
    },
  };
}

export type Liveness = 'running' | 'awaiting_output' | 'heartbeat_lost' | 'finished';

export interface LivenessVerdict {
  state: Liveness;
  /** 给人看的一句话,面板可以直接显示。判不开的两种情况必须明说判不开。 */
  note: string;
  /** 距最后一次心跳多少毫秒;从没跳过则 undefined。 */
  sinceBeatMs?: number;
}

/**
 * 把"记录说它在跑"翻译成"证据支持到什么程度的结论"。
 *
 * 这条是面板可信度的关键:`status:'running'` 单独看毫无信息量 —— 进程被杀时它就永远停在
 * running(这正是当初建账本要解决的事)。只有配上心跳的新鲜度,才谈得上"进度"。
 */
export function judgeLiveness(
  record: Pick<TaskRecord, 'status' | 'startedAt'>,
  beat: TaskBeat | null,
  now = Date.now(),
): LivenessVerdict {
  if (record.status !== 'running') {
    return { state: 'finished', note: `已结束(${record.status})` };
  }
  if (beat === null) {
    return {
      state: 'heartbeat_lost',
      note: '从没跳过心跳:要么任务还没真正起来,要么桥在写第一次心跳前就没了 —— 这两者光看文件分不开',
    };
  }
  const since = now - beat.beatAt;
  if (since > BEAT_STALE_MS) {
    return {
      state: 'heartbeat_lost',
      sinceBeatMs: since,
      note:
        `心跳停在 ${(since / 1000).toFixed(0)} 秒前:桥进程大概已经不在了` +
        `(也可能是心跳写盘本身失败:盘满或权限)—— 单看文件分不开。别按"在跑"处理`,
    };
  }
  // 有事件且最近还在出 ⇒ 在跑;只有心跳没新事件 ⇒ 活着但在等(长思考、或在等一个慢工具)。
  const lastActivity = beat.lastEventAt ?? record.startedAt;
  if (beat.events > 0 && now - lastActivity <= BEAT_STALE_MS) {
    return {
      state: 'running',
      sinceBeatMs: since,
      note: `在跑:${beat.events} 个事件,最后一条是 ${beat.lastType ?? '未知'}(${Math.round((now - lastActivity) / 1000)} 秒前)`,
    };
  }
  return {
    state: 'awaiting_output',
    sinceBeatMs: since,
    note: `桥还在看着它,但 ${beat.events} 个事件之后已无新输出 —— 在等长回答还是卡住了,面板分不开`,
  };
}/** 面板与 `harness_poll` 共用的进度视图。字段语义见 judgeLiveness。 */
export interface TaskProgress {
  events: number;
  /** 已累计 token,只含各家自报的部分;0 可能意味着"它没报",不代表"没花钱"。 */
  tokens: number;
  lastType?: string;
  lastEventAt?: number;
  beatAt?: number;
  liveness: Liveness;
  note: string;
  sinceBeatMs?: number;
}

/**
 * 读进度。`live` 给的是内存里的即时计数(比心跳文件新最多一个心跳周期);
 * 不给就用文件里的 —— 账本兜底路径没有内存态可用。
 *
 * token 的取数顺序是有讲究的:很多家的用量是在 `finalize()` 里才凑齐的(它不是事件),
 * 所以**已结束**的任务要优先信记录里的 `usage`,否则会把一次真实花销显示成 0。
 * 心跳里的累计值只在"还在跑"时是唯一来源。
 */
export function readProgress(
  cwd: string,
  taskId: string,
  record: Pick<TaskRecord, 'status' | 'startedAt'> & Partial<Pick<TaskRecord, 'usage'>>,
  live?: { events: number; tokens: number; lastType?: string; lastEventAt?: number },
): TaskProgress {
  const beat = readTaskBeat(cwd, taskId);
  const v = judgeLiveness(record, beat);
  const settled = record.usage
    ? (record.usage.inputTokens ?? 0) + (record.usage.outputTokens ?? 0)
    : undefined;
  return {
    events: live?.events ?? beat?.events ?? 0,
    tokens: live?.tokens ?? settled ?? beat?.tokens ?? 0,
    lastType: live?.lastType ?? beat?.lastType,
    lastEventAt: live?.lastEventAt ?? beat?.lastEventAt,
    beatAt: beat?.beatAt,
    liveness: v.state,
    note: v.note,
    sinceBeatMs: v.sinceBeatMs,
  };
}

/** 面板要的一行任务。比 TaskRecord 扁,因为渲染方是浏览器不是本模块。 */
export interface ListedTask {
  taskId: string;
  harness: string;
  model?: string;
  approval: string;
  requestedCwd: string;
  cwd: string;
  isolated: boolean;
  worktreePath?: string;
  egressHost?: string;
  status: string;
  reason?: string;
  startedAt: number;
  endedAt?: number;
  text?: string;
  events: number;
  tokens: number;
  liveness: Liveness;
  livenessNote: string;
  /** 距最后一次模型输出多久。判"卡住没有"就靠它,不是靠 events。 */
  lastEventAgoMs?: number;
}

/**
 * 把索引里所有任务摊平成面板视图。
 *
 * 索引只存"在哪、什么时候";正文仍按一任务一文件读,所以这里对每个 taskId 是一次
 * 记录读 + 一次心跳读。上限是刻意的:面板不是归档浏览器,几千条一起渲染只会让它自己卡死。
 */
export function listTaskRecords(now = Date.now(), limit = 300): ListedTask[] {
  const index = indexPath();
  if (!existsSync(index)) return [];
  let lines: string[];
  try {
    lines = readFileSync(index, 'utf8').split('\n');
  } catch {
    return [];
  }
  // 倒着读:同一 taskId 重复派发时,后写的那条才算它现在在哪个仓库。
  const wanted = new Map<string, string>();
  for (let i = lines.length - 1; i >= 0 && wanted.size < limit; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { taskId?: string; cwd?: string };
      if (typeof e.taskId === 'string' && typeof e.cwd === 'string' && !wanted.has(e.taskId)) {
        wanted.set(e.taskId, e.cwd);
      }
    } catch {
      /* 索引坏一行不该让整个面板空;读不到的记录本来就该跳过 */
    }
  }

  const out: ListedTask[] = [];
  for (const [taskId, cwd] of wanted) {
    const record = readTaskRecord(cwd, taskId);
    if (!record) continue; // 仓库被删/搬走了 —— 不猜它去哪了
    const p = readProgress(cwd, taskId, record);
    out.push({
      taskId,
      harness: record.harness,
      model: record.model,
      approval: record.approval,
      requestedCwd: record.requestedCwd,
      cwd: record.cwd,
      isolated: record.isolated,
      worktreePath: record.worktreePath,
      egressHost: record.egressHost,
      status: record.status,
      reason: record.reason,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      text: record.text,
      events: p.events,
      tokens: p.tokens,
      liveness: p.liveness,
      livenessNote: p.note,
      lastEventAgoMs: p.lastEventAt === undefined ? undefined : now - p.lastEventAt,
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
