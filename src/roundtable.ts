import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Scheduler } from './scheduler.ts';
import type { BridgeEvent, TaskResult } from './types.ts';
/**
 * 圆桌:一个文件夹 = 一个讨论,每席一条**原生会话**。
 *
 * 为什么不用"每轮重放完整转录":原生会话自带记忆,每轮只喂"别人刚说的话"即可,
 * 单轮输入量从 O(全场) 降到 O(本轮新增)。代价是**会话历史不可编辑** ——
 * 所以会话失效或上下文超限时,降级为"新开会话 + 全量重放最近若干条",并如实记一条 reseeded。
 */

export interface Seat {
  harness: string;
  model?: string;
  /** 思考强度,原样透传给那家 CLI;各家取值不同,不做统一映射。 */
  effort?: string;
  label?: string;
}

export interface RoomConfig {
  id: string;
  topic: string;
  seats: Seat[];
  /** 本次调用要跑的轮数(不是累计轮数)。 */
  rounds: number;
  /** 房间根目录;房间自己的文件夹建在它下面的 .llms-bridge/roundtable/ 里。 */
  cwd: string;
  maxWallMsPerTurn: number;
  maxTokensPerTurn?: number;
  /** 最近多少条发言给全文(仅重建会话时需要;原生会话只喂增量)。 */
  keepTurns: number;
  /** 单轮提示词字符上限。codex 用 argv 传提示词,Windows 命令行上限 32767。 */
  maxPromptChars: number;
  boardPath?: string;
  workspaceDir?: string;
  /** 跑到全员无异议为止(最多 rounds 轮),然后出一份 final.md。 */
  untilConsensus?: boolean;
  /** 收尾由哪一席执笔(默认第一席)。 */
  finalizeSeat?: string;
}

export interface TurnRecord {
  turn: number;
  round: number;
  seat: string;
  harness: string;
  /** user = 主持人(你自己)说的话;final = 收尾那份统一结果;system = 编排自己的记录。 */
  kind: 'message' | 'pass' | 'absent' | 'user' | 'final' | 'system';
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  taskId?: string;
  status?: string;
  reason?: string;
  sessionId?: string;
  /** true = 原生会话不可用,本轮改成新会话 + 全量重放。 */
  reseeded?: boolean;
  at: number;
}

export interface SeatState {
  sessionId?: string;
  /** 该席已经看见到第几轮;下一轮的增量从这里之后算。 */
  lastTurn: number;
}

export interface RunRoomOptions {
  onStatus?: (message: string) => void;
  onTurn?: (record: TurnRecord) => void;
}

const RULES = [
  '你是圆桌会议的一名成员。只讨论,不修改文件,不执行命令。',
  '只写你自己的观点;不复述他人,不寒暄,不写全场总结。',
  '若对当前议题没有新的实质性补充,只回复 PASS(就这四个字母)。',
].join('\n');

export function roomDir(root: string, id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`房间 id 只能用字母数字和 ._-:${id}`);
  }
  return join(root, '.llms-bridge', 'roundtable', id);
}

/**
 * 与 ui.ts 同源:面板和圆桌是两个进程,只能靠同一个 LLMS_BRIDGE_HOME 找到彼此。
 * 三行重复好过一个只为它俩服务的共享模块。
 */
function bridgeHome(): string {
  return process.env.LLMS_BRIDGE_HOME ?? join(homedir(), '.llms-bridge');
}

/** 把房间登记到桥的主目录,面板才找得到它(房间本身仍在用户指定的 cwd 下)。 */
function registerRoom(dir: string, config: RoomConfig): void {
  try {
    const home = bridgeHome();
    mkdirSync(home, { recursive: true });
    const file = join(home, 'roundtable-rooms.json');
    const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {};
    current[config.id] = {
      dir,
      cwd: config.cwd,
      topic: config.topic,
      seats: config.seats.map(seatLabel),
      // 席位全量规格(model/effort)—— 续聊要按原样重放,只留标签会把设置丢掉。
      seatSpecs: config.seats,
      updatedAt: Date.now(),
    };
    writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
  } catch {
    // 登记失败只影响"面板能不能找到这个房间",不该拦住讨论本身。
  }
}

/** 主持人插话:直接落进转录,下一轮所有席位都会在增量里看到它。 */
export function appendUserTurn(transcriptPath: string, text: string): TurnRecord {
  const prior = readTranscript(transcriptPath);
  const turn = prior.reduce((max, r) => Math.max(max, r.turn), 0) + 1;
  const record: TurnRecord = {
    turn,
    round: 0,
    seat: '你',
    harness: 'user',
    kind: 'user',
    text,
    at: Date.now(),
  };
  appendTurn(transcriptPath, record);
  return record;
}

export interface AttachmentBlock {
  name: string;
  text: string;
  truncated?: boolean;
  /** 结构要点稿:附件太贵时,后续轮次只喂这一份。 */
  digest?: string;
  /** true = 这一轮喂的是要点稿而不是全文。 */
  digestOnly?: boolean;
}

/**
 * 摘要不是让模型写文件(席位是只读的),而是确定性抽取:
 * 每个标题 + 其后百来字。零调用成本、结果可复现,用来做"后续轮次的附件记忆"。
 */
export function digestText(text: string, limit = 2000): string {
  const lines = text.split(/\r?\n/);
  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length && used < limit; i++) {
    const line = lines[i]!;
    if (!/^#{1,4}\s/.test(line)) continue;
    let chunk = line.trim();
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!.trim();
      if (/^#{1,4}\s/.test(next)) break; // 下一节开始,别把整篇吸进来
      if (!next) continue;
      chunk += ` ${next}`;
      if (chunk.length >= 160) break;
    }
    chunk = chunk.slice(0, 180);
    parts.push(chunk);
    used += chunk.length + 1;
  }
  const composed = parts.join('\n');
  return (composed.length > 0 ? composed : text.slice(0, limit)).slice(0, limit);
}

/**
 * 把 `[附件] <path>` 指向的文件正文读出来,作为提示词的一部分。
 *
 * 为什么不让各家自己去读路径:codex 的 read-only 沙箱只读 cwd 之内,antigravity 的
 * 工作区又是另一个目录 —— 同一个路径三家能不能读各不相同。内联正文让"谁能读"不再是变量。
 */
export function loadAttachments(
  history: TurnRecord[],
  workspace: string,
  limits: { perFile?: number; total?: number } = {},
): AttachmentBlock[] {
  const perFile = limits.perFile ?? 12_000;
  const total = limits.total ?? 20_000;
  const seen = new Set<string>();
  const out: AttachmentBlock[] = [];
  let used = 0;

  for (const record of history) {
    if (record.kind !== 'user' || !record.text) continue;
    for (const match of record.text.matchAll(/\[附件\]\s*([^\s(]+)/g)) {
      const raw = match[1]!;
      if (seen.has(raw)) continue;
      seen.add(raw);

      let text: string | undefined;
      for (const candidate of [resolve(workspace, raw), raw]) {
        try {
          const body = readFileSync(candidate, 'utf8');
          if (!body.includes('\u0000')) { text = body; break; }
        } catch {
          /* 换个候选路径再试 */
        }
      }
      if (text === undefined) continue;

      const budget = Math.min(perFile, total - used);
      if (budget <= 0) break;
      // 要点稿必须从**完整原文**抽,否则大文件只剩开头一小段的结构。
      const digest = digestText(text);
      let truncated = false;
      if (text.length > budget) {
        text = text.slice(0, budget);
        truncated = true;
      }
      out.push({ name: raw, text, digest, ...(truncated ? { truncated } : {}) });
      used += text.length;
    }
  }
  return out;
}

/** 附件首次出现的轮次,决定"哪一轮给全文、之后只给要点"。 */
export function readAttachmentTurns(path: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export function parseSeats(raw: string): Seat[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      // 形如 codex:gpt-6-astra@high / claude@max
      const atEffort = item.indexOf('@');
      const spec = atEffort < 0 ? item : item.slice(0, atEffort);
      const effort = atEffort < 0 ? undefined : item.slice(atEffort + 1);
      const atModel = spec.indexOf(':');
      const seat: Seat = atModel < 0
        ? { harness: spec }
        : { harness: spec.slice(0, atModel), model: spec.slice(atModel + 1) };
      if (effort) seat.effort = effort;
      return seat;
    });
}

export function seatLabel(seat: Seat): string {
  return seat.label ?? seat.harness;
}

/** 只认"整条就是 PASS",不把"PASS 因为……"当成弃权 —— 那是有话要说。 */
export function isPass(text: string | undefined): boolean {
  if (!text) return false;
  const core = text
    .trim()
    .replace(/^[`"'\s]+/, '')
    .replace(/[`"'\s]+$/, '')
    .replace(/[。.!！?？]+$/, '');
  return /^pass$/i.test(core);
}

export function buildPrompt(args: {
  /** resume = 只喂增量;fresh = 重建会话,喂最近若干条全文。 */
  mode: 'resume' | 'fresh';
  topic: string;
  board?: string;
  /** 该席尚未看见的发言(它自己上一轮之后的)。 */
  delta: TurnRecord[];
  /** 重建会话时用的历史(已含 delta)。 */
  history: TurnRecord[];
  seat: string;
  turn: number;
  keepTurns: number;
  maxChars: number;
  attachments?: AttachmentBlock[];
}): { prompt: string; omitted: number; clipped: boolean } {
  const head = `# 圆桌规则\n${RULES}\n\n# 议题\n${args.topic}\n`;
  const board = args.board && args.board.trim()
    ? `\n# 共识板(主持人维护,优先于讨论记录)\n${args.board.trim()}\n`
    : '';
  const foot = `\n# 轮到你\n你是 ${args.seat},第 ${args.turn} 轮。只输出你的发言,或 PASS。\n`;

  const baseFixed = head.length + board.length + foot.length;
  if (baseFixed + 200 > args.maxChars) {
    throw new Error(`议题/共识板过长:固定部分已 ${baseFixed} 字符,超过上限 ${args.maxChars}`);
  }

  // 附件正文优先占位(它是讨论的实质内容),但留 800 字符给讨论记录,免得只剩附件。
  const attachBudget = Math.max(0, args.maxChars - baseFixed - 800);
  const attachParts: string[] = [];
  let attachUsed = 0;
  for (const file of args.attachments ?? []) {
    const remaining = attachBudget - attachUsed;
    if (remaining <= 120) break;
    let text = file.text;
    let cut = file.truncated === true;
    if (text.length > remaining) {
      text = text.slice(0, remaining);
      cut = true;
    }
    const tag = file.digestOnly ? '(要点稿)' : cut ? '(截断)' : '';
    const block = `\n--- ${file.name}${tag} ---\n${text}\n`;
    attachParts.push(block);
    attachUsed += block.length;
  }
  const attachSection = attachParts.length > 0 ? `\n# 附件正文\n${attachParts.join('')}` : '';
  const fixed = baseFixed + attachSection.length;

  if (args.mode === 'resume') {
    const lines = args.delta
      .filter((r) => (r.kind === 'message' || r.kind === 'user') && r.turn < args.turn)
      .map((r) => `[${r.turn}] ${r.seat}: ${(r.text ?? '').trim()}`);
    const body = lines.length === 0
      ? '\n# 本轮新增发言\n(没有新的发言)\n'
      : `\n# 本轮新增发言\n${lines.join('\n')}\n`;
    const prompt = head + board + attachSection + body + foot;
    if (prompt.length <= args.maxChars) return { prompt, omitted: 0, clipped: false };
    // 增量本身超限(一轮里别人说了很长的东西):退回重放路径,让它按预算裁剪。
  }

  const perMessageCap = Math.max(200, Math.floor(args.maxChars / 3));
  const recent = args.history.slice(-Math.max(1, args.keepTurns));
  const lines: string[] = [];
  let used = 0;
  let clipped = false;
  for (let i = recent.length - 1; i >= 0; i--) {
    const rec = recent[i];
    let text = (rec.text ?? '').trim();
    if (text.length > perMessageCap) {
      text = `${text.slice(0, perMessageCap)} …(本条截断)`;
      clipped = true;
    }
    const line = `[${rec.turn}] ${rec.seat}: ${text}`;
    if (fixed + used + line.length + 64 > args.maxChars) {
      clipped = true;
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  const omitted = args.history.length - lines.length;
  const header = lines.length === 0
    ? '\n# 讨论记录\n(还没有人发言)\n'
    : `\n# 讨论记录${omitted > 0 ? `(仅最近 ${lines.length} 条,更早 ${omitted} 条已省略)` : ''}\n`;
  const prompt = `${head}${board}${attachSection}${header}${lines.join('\n')}${lines.length ? '\n' : ''}${foot}`;
  return { prompt, omitted, clipped };
}

const FINAL_RULES = [
  '把上面的讨论收敛成一份最终结果。',
  '- 先给结论(2-3 句),再给要点或步骤,最后给"仍未解决的分歧"(没有就写"无")。',
  '- 不要复述讨论过程,不要点名谁说过什么。',
  '- 只输出 Markdown 正文,不要开场白。',
].join('\n');

/** 收尾那一轮的提示词:同一个议题 + 讨论记录,但要求产出统一结果。 */
export function buildFinalPrompt(args: {
  topic: string;
  history: TurnRecord[];
  attachments?: AttachmentBlock[];
  keepTurns: number;
  maxChars: number;
}): string {
  const head = `# 任务\n${FINAL_RULES}\n\n# 议题\n${args.topic}\n`;

  const attachBudget = Math.max(0, args.maxChars - head.length - 800);
  const parts: string[] = [];
  let attachUsed = 0;
  for (const file of args.attachments ?? []) {
    const remaining = attachBudget - attachUsed;
    if (remaining <= 120) break;
    const text = file.text.length > remaining ? file.text.slice(0, remaining) : file.text;
    const block = `\n--- ${file.name} ---\n${text}\n`;
    parts.push(block);
    attachUsed += block.length;
  }
  const attachSection = parts.length > 0 ? `\n# 附件正文\n${parts.join('')}` : '';

  const budget = args.maxChars - head.length - attachSection.length - 200;
  const recent = args.history.slice(-Math.max(1, args.keepTurns));
  const lines: string[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const rec = recent[i]!;
    const line = `[${rec.turn}] ${rec.seat}: ${(rec.text ?? '').trim()}`;
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length + 1;
  }

  const historySection = lines.length > 0 ? `\n# 讨论记录\n${lines.join('\n')}\n` : '';
  return `${head}${attachSection}${historySection}\n# 现在\n只输出最终结果(Markdown)。\n`;
}

/** 每席发言落成独立 md:人能翻,后续轮次也能按路径读。 */
export function writeTurnMd(dir: string, record: TurnRecord): string | null {
  if ((record.kind !== 'message' && record.kind !== 'final') || !record.text) return null;
  const mdDir = join(dir, 'md');
  mkdirSync(mdDir, { recursive: true });
  const safeSeat = record.seat.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  const file = join(mdDir, `t${String(record.turn).padStart(3, '0')}-${safeSeat}.md`);
  const body = [
    `# ${record.seat} · 第 ${record.turn} 轮`,
    '',
    record.usage
      ? `> tokens: in ${record.usage.inputTokens ?? '?'} / out ${record.usage.outputTokens ?? '?'}`
      : '',
    '',
    record.text,
    '',
  ].join('\n');
  writeFileSync(file, body, 'utf8');
  return file;
}

function transcriptPath(dir: string): string {
  return join(dir, 'transcript.jsonl');
}

function sessionsPath(dir: string): string {
  return join(dir, 'sessions.json');
}

export function appendTurn(path: string, record: TurnRecord): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export function readTranscript(path: string): TurnRecord[] {
  if (!existsSync(path)) return [];
  const out: TurnRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TurnRecord);
    } catch {
      // 进程被杀时最后一行可能只写了一半;丢掉它,不要让整份转录读不出来。
    }
  }
  return out;
}

export function readSessions(path: string): Record<string, SeatState> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, SeatState>;
  } catch {
    return {};
  }
}

function writeSessions(path: string, states: Record<string, SeatState>): void {
  writeFileSync(path, JSON.stringify(states, null, 2), 'utf8');
}

/** 会话 id 只存在于厂商原始事件里:codex 是 thread_id,claude 是 session_id。 */
export function extractSessionId(events: BridgeEvent[]): string | undefined {
  for (const event of events) {
    const raw = event.raw as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') continue;
    for (const key of ['thread_id', 'session_id']) {
      const value = raw[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return undefined;
}

function looksLikeSessionFailure(result: TaskResult): boolean {
  if (result.status === 'ok') return false;
  const text = `${result.reason ?? ''}\n${result.text ?? ''}`.toLowerCase();
  return /session|thread|resume|not found|no rollout|unknown conversation/.test(text);
}

function classify(
  result: TaskResult,
  seat: Seat,
  label: string,
  turn: number,
  round: number,
  sessionId: string | undefined,
  reseeded: boolean,
): TurnRecord {
  const base: TurnRecord = {
    turn,
    round,
    seat: label,
    harness: seat.harness,
    kind: 'absent',
    taskId: result.taskId,
    usage: result.usage,
    sessionId,
    at: Date.now(),
  };
  if (reseeded) base.reseeded = true;
  if (result.status !== 'ok') {
    return { ...base, status: result.status, reason: result.reason ?? `status=${result.status}` };
  }
  const text = (result.text ?? '').trim();
  if (!text) return { ...base, status: result.status, reason: '空回复' };
  if (isPass(text)) return { ...base, kind: 'pass', text };
  return { ...base, kind: 'message', text };
}

export async function runRoom(
  scheduler: Scheduler,
  config: RoomConfig,
  options: RunRoomOptions = {},
): Promise<{ dir: string; transcript: TurnRecord[] }> {
  const dir = roomDir(config.cwd, config.id);
  const workspace = config.workspaceDir ?? join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });

  const roomFile = join(dir, 'room.json');
  if (!existsSync(roomFile)) {
    writeFileSync(roomFile, JSON.stringify({ ...config, createdAt: Date.now() }, null, 2), 'utf8');
  }
  registerRoom(dir, config);

  const tpath = transcriptPath(dir);
  const spath = sessionsPath(dir);
  const states = readSessions(spath);

  const boardFile = config.boardPath ?? join(dir, 'board.md');
  const board = existsSync(boardFile) ? readFileSync(boardFile, 'utf8').trim() : undefined;

  const prior = readTranscript(tpath);
  let turn = prior.reduce((max, r) => Math.max(max, r.turn), 0) + 1;

  const maxRounds = config.untilConsensus ? Math.max(1, config.rounds) : config.rounds;
  for (let round = 1; round <= maxRounds; round++) {
    const roundStart = readTranscript(tpath).length;
    for (const seat of config.seats) {
      const label = seatLabel(seat);
      const state = states[label] ?? { lastTurn: 0 };
      const all = readTranscript(tpath);
      const messages = all.filter((r) => r.kind === 'message' || r.kind === 'user');
      // 附件正文内联:谁的工作区长什么样都不再影响"能不能读到"。
      // 注意:房间的第一条消息是**议题**(只存在 room.json 里),不在转录中 ——
      // 它里面同样可能带 `[附件]`,所以要合成一条记录一起扫。
      const topicRecord: TurnRecord = {
        turn: 0, round: 0, seat: '你', harness: 'user', kind: 'user', text: config.topic, at: 0,
      };
      const attachments = loadAttachments([topicRecord, ...messages], workspace);

      // 附件记忆:首次出现的那个"一轮"给全文,之后只给要点稿,直到新附件出现。
      const attachTurnsFile = join(dir, 'attachments.json');
      const attachTurns = readAttachmentTurns(attachTurnsFile);
      let attachChanged = false;
      for (const file of attachments) {
        if (attachTurns[file.name] === undefined) {
          attachTurns[file.name] = turn;
          attachChanged = true;
        }
      }
      if (attachChanged) writeFileSync(attachTurnsFile, JSON.stringify(attachTurns, null, 2), 'utf8');

      const effectiveAttachments = attachments.map((file) => {
        const introduced = attachTurns[file.name] ?? 0;
        const full = turn - introduced < config.seats.length;
        if (full) return file;
        return { name: file.name, text: file.digest ?? digestText(file.text), digestOnly: true };
      });
      const delta = messages.filter((r) => r.turn > (state.lastTurn ?? 0));
      const wantsResume = Boolean(state.sessionId);

      const build = (mode: 'resume' | 'fresh') => buildPrompt({
        mode,
        topic: config.topic,
        board,
        delta,
        history: messages,
        seat: label,
        turn,
        keepTurns: config.keepTurns,
        maxChars: config.maxPromptChars,
        attachments: effectiveAttachments,
      });

      let built = build(wantsResume ? 'resume' : 'fresh');
      options.onStatus?.(
        `[第 ${round}/${config.rounds} 轮] ${label} · ${wantsResume ? `续接会话 ${String(state.sessionId).slice(0, 8)}` : '新会话'}`
        + ` · 增量 ${delta.length} 条${built.omitted > 0 ? ` · 重放省略 ${built.omitted} 条` : ''}${built.clipped ? ' · 有截断' : ''}`,
      );

      const dispatch = (prompt: string, resume: boolean) => {
        const spec = {
          taskId: `rt-${config.id}-${turn}${resume ? '' : '-fresh'}`,
          harness: seat.harness,
          prompt,
          cwd: workspace,
          approval: 'read-only' as const,
          budget: {
            maxWallMs: config.maxWallMsPerTurn,
            ...(config.maxTokensPerTurn === undefined ? {} : { maxTokens: config.maxTokensPerTurn }),
          },
          session: resume
            ? { mode: 'resume' as const, sessionId: String(state.sessionId) }
            : { mode: 'fresh' as const },
          ...(seat.model === undefined ? {} : { model: seat.model }),
          ...(seat.effort === undefined ? {} : { effort: seat.effort }),
        };
        return scheduler.dispatch(spec).then((ack) => ack.taskId);
      };

      let taskId = '';
      let result: TaskResult;
      let reseeded = false;

      try {
        taskId = await dispatch(built.prompt, wantsResume);
        result = await scheduler.collect(taskId);

        if (wantsResume && looksLikeSessionFailure(result)) {
          // 原生会话不可用(被清理 / 上游不认这个 id):换新会话重放最近若干条。
          // 这不叫"重试"——重试会把同一个失败再买一次;这是换一条已知能走的路径。
          options.onStatus?.(`  ↳ ${label} 的会话已不可用(${result.reason ?? result.status}),改用新会话 + 全量重放`);
          built = build('fresh');
          taskId = await dispatch(built.prompt, false);
          result = await scheduler.collect(taskId);
          reseeded = true;
        }
      } catch (err) {
        // 单席派发失败不能拖垮整场:记缺席(带原因)后继续下一席。
        const reason = err instanceof Error ? err.message : String(err);
        options.onStatus?.(`  ↳ ${label} 派发失败:${reason}`);
        const record: TurnRecord = {
          turn,
          round,
          seat: label,
          harness: seat.harness,
          kind: 'absent',
          status: 'failed',
          reason,
          at: Date.now(),
        };
        appendTurn(tpath, record);
        states[label] = { lastTurn: Math.max(state.lastTurn ?? 0, turn) };
        writeSessions(spath, states);
        options.onTurn?.(record);
        turn++;
        continue;
      }

      const sessionId = extractSessionId(scheduler.events(taskId));
      const record = classify(result, seat, label, turn, round, sessionId, reseeded);
      appendTurn(tpath, record);
      writeTurnMd(dir, record);

      const next: SeatState = { lastTurn: Math.max(state.lastTurn ?? 0, turn) };
      // 重建后仍拿不到新 id,说明老 id 多半也废了,别留着下一轮再撞一次。
      const effective = sessionId ?? (reseeded ? undefined : state.sessionId);
      if (effective) next.sessionId = effective;
      states[label] = next;
      writeSessions(spath, states);

      options.onTurn?.(record);
      turn++;
    }

    if (config.untilConsensus) {
      const thisRound = readTranscript(tpath).slice(roundStart);
      // 全员弃权 = 这一轮没有人有新的实质意见,继续只是烧钱。
      if (thisRound.length > 0 && thisRound.every((r) => r.kind === 'pass')) {
        const rec: TurnRecord = {
          turn, round, seat: '系统', harness: 'system', kind: 'system',
          text: '全员无异议,讨论提前收敛', at: Date.now(),
        };
        appendTurn(tpath, rec);
        options.onTurn?.(rec);
        turn++;
        break;
      }
    }
  }

  if (config.untilConsensus && config.seats.length > 0) {
    const editor = config.seats.find((s) => seatLabel(s) === config.finalizeSeat) ?? config.seats[0]!;
    const label = seatLabel(editor);

    const all = readTranscript(tpath);
    const messages = all.filter((r) => r.kind === 'message' || r.kind === 'user');
    const topicRecord: TurnRecord = {
      turn: 0, round: 0, seat: '你', harness: 'user', kind: 'user', text: config.topic, at: 0,
    };
    const attachments = loadAttachments([topicRecord, ...messages], workspace);
    const prompt = buildFinalPrompt({
      topic: config.topic,
      history: messages,
      attachments,
      keepTurns: Math.max(config.keepTurns, 12),
      maxChars: config.maxPromptChars,
    });

    options.onStatus?.(`收尾:${label} 正在整理最终结果`);
    let record: TurnRecord;
    try {
      const ack = await scheduler.dispatch({
        taskId: `rt-${config.id}-final`,
        harness: editor.harness,
        prompt,
        cwd: workspace,
        approval: 'read-only',
        budget: {
          maxWallMs: config.maxWallMsPerTurn,
          ...(config.maxTokensPerTurn === undefined ? {} : { maxTokens: config.maxTokensPerTurn }),
        },
        session: { mode: 'fresh' },
        ...(editor.model === undefined ? {} : { model: editor.model }),
      });
      const result = await scheduler.collect(ack.taskId);
      if (result.status === 'ok' && result.text && result.text.trim().length > 0) {
        record = {
          turn, round: maxRounds, seat: label, harness: editor.harness, kind: 'final',
          text: result.text.trim(), taskId: result.taskId, usage: result.usage, at: Date.now(),
        };
      } else {
        record = {
          turn, round: maxRounds, seat: label, harness: editor.harness, kind: 'absent',
          status: result.status, reason: result.reason ?? '收尾没有产出', taskId: result.taskId, at: Date.now(),
        };
      }
    } catch (err) {
      record = {
        turn, round: maxRounds, seat: label, harness: editor.harness, kind: 'absent',
        status: 'failed', reason: err instanceof Error ? err.message : String(err), at: Date.now(),
      };
    }

    appendTurn(tpath, record);
    if (record.kind === 'final') {
      writeTurnMd(dir, record);
      writeFileSync(join(dir, 'final.md'), `# ${config.topic}\n\n${record.text ?? ''}\n`, 'utf8');
    }
    options.onTurn?.(record);
    turn++;
  }

  return { dir, transcript: readTranscript(tpath) };
}
