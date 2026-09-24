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
