import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BridgeEvent, TaskSpec, TaskStatus, Tier, Usage } from './types.ts';
import { redactCredentials } from './redact.ts';
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
 * 正文(prompt/结果)按**用户 2026-09-23 的决定**落盘。当时写的理由是"整机本地、仓库无远端",
 * 那条前提到 2026-10-05 已不成立(仓库有 GitHub 远端)。结论不变,但依据换成实际起作用的那一层:
 * `.llms-bridge/` 写在版本化的 .gitignore 里,worktree 容器另走 .git/info/exclude —— 正文因此
 * 不进版本库、不进 diff、也不随 push 出去(2026-10-05 核过:全部历史里从没提交过该目录)。
 * 换言之"能不能落盘"取决于这份忽略规则,不再取决于有没有远端:哪天这目录被强制加进版本控制,
 * 各家任务的 prompt 与模型原文就会跟着公开出去。
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
    // 全字匹配而不是"包含":调用方传 ../ 形状的 ID 时会先在这里断掉,不会被拼进盘路径。
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

/**
 * 事件流落盘:每任务一个 jsonl,追加写。
 *
 * 为什么不能等任务结束时整份写:进程被杀的那一刻内存里的流水就没了,而"它调了哪些工具、
 * 停在哪一步"正是中断之后唯一要回看的东西 —— 账本只给了首尾(prompt 与最终 text)。
 *
 * 为什么同步写:与记录同理,派发那一刻进程随时可能被杀,异步队列会把"没排上队"变成新的丢失方式。
 * 代价是每个事件一次小写入,单条体积由下面的字段上限钉住。
 *
 * 两个上限都要:
 *  - 逐字段:一个 `tool_result` 可能是几十万字节的产品文件内容,一条就能顶掉整个任务的上限;
 *  - 逐任务:长任务事件上千条,不封顶就无界增长(面板不是归档浏览器,见 listTaskRecords)。
 * 撞上限只写一条标记行;差额由调用方比"心跳里的事件总数"与"落盘行数"得出,不靠标记计数。
 *
 * 落盘前一律过 redactCredentials。调度器交过来的 raw 已经隐去凭证字段了,这里再走一次:
 * 铁律一不设例外,而"信调用方都脱过敏"会变成日后新增写入点时的静默失守。
 */

/** 单个字段(text、raw 各算一个)的落盘上限。 */
const EVENT_FIELD_CAP = Number(process.env.LLMS_BRIDGE_EVENT_FIELD_CAP ?? 8_000);

/** 每任务事件流的总字节上限。 */
const EVENT_BYTES_CAP = Number(process.env.LLMS_BRIDGE_EVENT_BYTES_CAP ?? 2_000_000);

export function eventLogPath(cwd: string, taskId: string): string {
  return join(cwd, '.llms-bridge', 'tasks', `${taskId}.events.jsonl`);
}

/** 落盘的一行。比 BridgeEvent 扁:harness/tier 在记录和索引里都有,不必每行重复。 */
export interface EventLogLine {
  seq: number;
  type: string;
  at: number;
  text?: string;
  usage?: Usage;
  raw?: unknown;
  /** 这一行的 text 或 raw 被逐字段上限切过。 */
  clipped?: true;
  /** 只有撞上限的标记行有它。 */
  marker?: 'bytes-cap';
}

/**
 * 每个文件写到多少字节、是否已撞上限。
 * 首见时按磁盘现有大小起算:桥重启后接着写同一个任务时,内存计数是零而文件不是 ——
 * 不这么起算,重启一次就等于白送一个新上限。
 */
const written = new Map<string, { bytes: number; capped: boolean }>();

function clipField(value: string): { value: string; clipped: true } | { value: string; clipped?: undefined } {
  if (value.length <= EVENT_FIELD_CAP) return { value };
  return { value: value.slice(0, EVENT_FIELD_CAP) + '\n...[事件字段已截断]', clipped: true };
}

function toLogLine(event: BridgeEvent): EventLogLine {
  const line: EventLogLine = { seq: event.seq, type: event.type, at: event.at };
  let clipped = false;
  if (event.text !== undefined) {
    const c = clipField(event.text);
    line.text = c.value;
    clipped = c.clipped === true;
  }
  if (event.usage !== undefined) line.usage = event.usage;
  if (event.raw !== undefined) {
    const safe = redactCredentials(event.raw);
    if (typeof safe === 'string') {
      const c = clipField(safe);
      line.raw = c.value;
      clipped = clipped || c.clipped === true;
    } else {
      // 对象先序列化再按同一个上限切:否则一个"看着不大"的嵌套结构能绕过上限。
      const encoded = JSON.stringify(safe);
      if (encoded.length > EVENT_FIELD_CAP) {
        line.raw = encoded.slice(0, EVENT_FIELD_CAP) + '...[事件字段已截断]';
        clipped = true;
      } else {
        line.raw = safe;
      }
    }
  }
  if (clipped) line.clipped = true;
  return line;
}

/** 追加一行事件。写不进去只影响面板能不能看到过程,绝不该影响任务本身。 */
export function appendEvent(cwd: string, event: BridgeEvent): void {
  const path = eventLogPath(cwd, event.taskId);
  let st = written.get(path);
  if (st === undefined) {
    st = { bytes: statSync(path, { throwIfNoEntry: false })?.size ?? 0, capped: false };
    written.set(path, st);
    mkdirSync(dirname(path), { recursive: true });
  }
  if (st.capped) return;

  const encoded = `${JSON.stringify(toLogLine(event))}\n`;
  if (st.bytes + Buffer.byteLength(encoded, 'utf8') > EVENT_BYTES_CAP) {
    st.capped = true;
    const marker: EventLogLine = {
      seq: -1,
      type: 'status',
      at: Date.now(),
      marker: 'bytes-cap',
      text: `事件流已达 ${EVENT_BYTES_CAP} 字节上限,此后的事件未落盘 —— 面板上"落盘 N 条"与"共 M 条"对不上就是这个原因`,
    };
    try {
      appendFileSync(path, `${JSON.stringify(marker)}\n`, 'utf8');
    } catch {
      /* 标记也写不进就是盘有问题,此时面板会显示两数不等,而不会误显示成"事件都在这" */
    }
    return;
  }
  try {
    appendFileSync(path, encoded, 'utf8');
    st.bytes += Buffer.byteLength(encoded, 'utf8');
  } catch {
    /* 见上 */
  }
}

export interface EventLogRead {
  /** 尾部若干行,时间正序。 */
  lines: EventLogLine[];
  /** 文件里可解析的总行数(不是尾部的行数)。 */
  total: number;
  /** 解析不了被跳过的残行数 —— 崩在写一半会留一行半个 JSON。 */
  malformed: number;
  /** 是否撞到逐任务字节上限。 */
  capped: boolean;
  /** 文件不存在或读不动时的原因。面板必须区分"没有事件"与"读不到事件"。 */
  unreadable?: string;
}

/** 读事件流尾部。默认只取最后 400 行:面板给人看过程,不是给人做全文检索。 */
export function readEventLog(cwd: string, taskId: string, tail = 400): EventLogRead {
  const path = eventLogPath(cwd, taskId);
  if (!existsSync(path)) return { lines: [], total: 0, malformed: 0, capped: false, unreadable: '事件流文件不存在' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { lines: [], total: 0, malformed: 0, capped: false, unreadable: `读不动:${(err as Error).message}` };
  }

  const all: EventLogLine[] = [];
  let capped = false;
  let malformed = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const parsed = JSON.parse(t) as EventLogLine;
      if (typeof parsed.seq !== 'number' || typeof parsed.type !== 'string') {
        malformed++;
        continue;
      }
      if (parsed.marker === 'bytes-cap') capped = true;
      all.push(parsed);
    } catch {
      malformed++;
    }
  }
  return { lines: all.slice(-Math.max(0, tail)), total: all.length, malformed, capped };
}
