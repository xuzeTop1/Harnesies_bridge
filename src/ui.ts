/**
 * 观测面板:给人看"派了多少、正在跑什么、各家烧了多少 token",外加一个**发起圆桌**的入口。
 *
 * 四条边界是这个文件存在的前提,别在后续改动里磨掉:
 *  1. **只读账本,只有一个写入口**:`POST /api/roundtable/start`(2026-10-23 经用户要求加入,
 *     用于在 GUI 里开讨论)。它只 spawn 我们自己的 `cli.ts roundtable` 子进程,**不代跑模型、
 *     不改账本、不碰任务的审批档位**;其余全部接口仍然只读。
 *     没有这个限制的话,面板就成了第二个主脑,而它比主脑更没有上下文。
 *  2. **只听回环,端口由系统分配**。AGENTS.md 禁止硬编码端口:listen(0) 拿临时端口,
 *     实际值写进登记文件 ~/.llms-bridge/ui.json 供人找回。
 *  3. **渲染不拼 HTML**。页面显示的是各家模型的原文,拼字符串就等于把"漏转义一次"
 *     变成"任意 HTML 注入",而那内容的作者不是我们。所以全程 createElement + textContent。
 *  4. **同一时刻只允许一场圆桌**:antigravity 那席操作的是应用里的"当前会话",两场并行会互相覆盖。
 *
 * 数据只来自落盘账本 + 心跳文件 + 事件流文件:桥重启、面板先起后起,都不影响能看到历史。
 * 面板是**另一个进程**,读不到桥的内存,所以"正在跑的会话"也只能从盘上看 ——
 * 这正是事件流落盘(2026-10-05)存在的原因。
 */
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventLogPath, listTaskRecords, locateTaskRecord, readEventLog, readProgress, taskRecordPath } from './journal.ts';
import type { EventLogLine, ListedTask, TaskProgress, TaskRecord } from './journal.ts';
import { createAdapters } from './registry.ts';
import { appendUserTurn } from './roundtable.ts';

function bridgeHome(): string {
  return process.env.LLMS_BRIDGE_HOME ?? join(homedir(), '.llms-bridge');
}

export interface UiHandle {
  url: string;
  port: number;
  registryPath: string;
  close(): Promise<void>;
}

export interface UiOptions {
  /** 默认且仅允许回环。放开它等于把本机账本(含 prompt 与模型输出)暴露给局域网。 */
  host?: string;
  /** 0 = 让系统分配。AGENTS.md 不许硬编码端口。 */
  port?: number;
}

export async function startUi(opts: UiOptions = {}): Promise<UiHandle> {
  const host = opts.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `面板只允许监听回环地址(要监听的是 ${host})。账本里躺着各家任务的 prompt 与模型原文,` +
        `开给局域网之前先想清楚这台机器的盘上有什么。`,
    );
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const registryPath = join(bridgeHome(), 'ui.json');
  const url = `http://${host}:${port}/`;
  try {
    mkdirSync(bridgeHome(), { recursive: true });
    writeFileSync(
      registryPath,
      JSON.stringify({ pid: process.pid, port, host, url, startedAt: Date.now() }, null, 2),
      'utf8',
    );
  } catch {
    /* 登记文件写不掉只影响"下次怎么找回端口",不该拦住面板本身 */
  }

  return {
    url,
    port,
    registryPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export interface RoomListItem {
  id: string;
  dir: string;
  topic?: string;
  seats?: string[];
  updatedAt?: number;
  turns: number;
  last?: { seat: string; kind: string; at: number };
  /** 登记过但目录不在了 —— 如实标出来,别让它看起来像"0 条发言"。 */
  missing?: boolean;
}

interface TranscriptLine {
  turn?: number;
  round?: number;
  seat?: string;
  kind?: string;
  text?: string;
  reason?: string;
  reseeded?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
  at?: number;
}

function readTranscriptLines(path: string): TranscriptLine[] | null {
  if (!existsSync(path)) return null;
  const out: TranscriptLine[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TranscriptLine);
    } catch {
      // 进程被中断时最后一行可能只写了一半;丢掉它,别让整份转录读不出来。
    }
  }
  return out;
}

/** 房间登记在 ~/.llms-bridge/roundtable-rooms.json,房间本体在用户自己的 cwd 下。 */
export function listRooms(): RoomListItem[] {
  const file = join(bridgeHome(), 'roundtable-rooms.json');
  let registry: Record<string, { dir?: string; topic?: string; seats?: string[]; updatedAt?: number }>;
  try {
    registry = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const out: RoomListItem[] = [];
  for (const [id, meta] of Object.entries(registry)) {
    const dir = meta?.dir;
    if (typeof dir !== 'string' || dir.length === 0) continue;
    const item: RoomListItem = {
      id,
      dir,
      turns: 0,
      ...(meta.topic ? { topic: meta.topic } : {}),
      ...(meta.seats ? { seats: meta.seats } : {}),
      ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
    };
    const lines = readTranscriptLines(join(dir, 'transcript.jsonl'));
    if (lines === null) {
      // 目录在、转录还没写 = 刚开房还没人发言;只有**目录真的没了**才叫 missing。
      if (existsSync(dir)) {
        out.push(item);
        continue;
      }
      item.missing = true;
      out.push(item);
      continue;
    }
    item.turns = lines.length;
    const last = lines[lines.length - 1];
    if (last) {
      item.last = { seat: String(last.seat ?? '?'), kind: String(last.kind ?? '?'), at: Number(last.at ?? 0) };
      if (!item.updatedAt) item.updatedAt = Number(last.at ?? 0);
    }
    out.push(item);
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function readRoom(id: string): {
  found: boolean;
  id: string;
  dir?: string;
  room?: unknown;
  transcript?: TranscriptLine[];
  why?: string;
} {
  const entry = listRooms().find((r) => r.id === id);
  if (!entry) return { found: false, id, why: '没有登记过这个房间' };
  let room: unknown;
  try {
    room = JSON.parse(readFileSync(join(entry.dir, 'room.json'), 'utf8'));
  } catch {
    room = undefined;
  }
  return { found: true, id, dir: entry.dir, room, transcript: readTranscriptLines(join(entry.dir, 'transcript.jsonl')) ?? [] };
}

/** 静态外壳:一行动态数据都不进这个字符串,内容一律由前端 createElement + textContent 渲染。 */
const ROOMS_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>圆桌</title>
<style>
  :root{
    --bg:#0f1115; --panel:#151821; --panel2:#1b1f2a; --line:#252b37;
    --text:#e6e9ef; --muted:#8b93a7; --accent:#4c8dff; --accent-soft:#4c8dff22;
    --user:#1e2b45; --warn:#e0a24a; --bad:#e05c5c;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 "Segoe UI",system-ui,sans-serif}
  .app{display:grid;grid-template-columns:260px 1fr;height:100vh}
  .sidebar{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
  .brand{padding:16px 16px 10px;font-weight:600;letter-spacing:.5px}
  .newbtn{margin:0 12px 10px;padding:8px;border-radius:8px;border:1px dashed var(--line);background:none;color:var(--muted);cursor:pointer;font:inherit}
  .newbtn:hover{border-color:var(--accent);color:var(--text)}
  .rooms{flex:1;overflow:auto;padding:4px 8px}
  .room{display:block;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:10px;padding:9px 10px;margin-bottom:2px;color:inherit;font:inherit;cursor:pointer}
  .room:hover{background:var(--panel2)}
  .room.active{background:var(--accent-soft);border-color:#4c8dff55}
  .room .rid{font-weight:600;font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .room .rsub{color:var(--muted);font-size:12px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sidefoot{padding:10px 16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
  .main{display:flex;flex-direction:column;min-width:0;min-height:0}
  .topbar{display:flex;align-items:center;gap:12px;padding:12px 24px;border-bottom:1px solid var(--line);background:#12141a}
  .title{flex:1;min-width:0}
  .title h1{margin:0;font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .meta{color:var(--muted);font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .iconbtn{background:none;border:1px solid var(--line);color:var(--muted);border-radius:8px;min-width:34px;height:34px;cursor:pointer;font-size:15px;flex:0 0 auto}
  .iconbtn:hover{color:var(--text);border-color:#39415a}
  .chatlog{flex:1;overflow:auto;padding:20px 24px 8px}
  .chatwrap{max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
  .msg{display:flex;gap:10px}
  .msg.user{flex-direction:row-reverse}
  .avatar{width:30px;height:30px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:var(--panel2);color:var(--muted)}
  .msg.user .avatar{background:#27406b;color:#cfe0ff}
  .body{min-width:0;max-width:82%}
  .msg.user .body{max-width:72%}
  .mhead{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--muted);margin-bottom:3px}
  .msg.user .mhead{justify-content:flex-end}
  .name{font-weight:600;color:#cdd5e6;font-size:12.5px}
  .bubble{white-space:pre-wrap;word-break:break-word;padding:10px 13px;border-radius:12px;background:var(--panel2);border:1px solid var(--line)}
  .msg.user .bubble{background:var(--user);border-color:#2f4a7a}
  .msg.final .bubble{border-color:#3c6fd0;background:#152442}
  .msg.final .name{color:#9dc0ff}
  .msg.pass .bubble,.msg.absent .bubble{background:transparent;border-style:dashed;color:var(--muted)}
  .pill{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
  .pill.warn{color:var(--warn);border-color:#5a4a22}
  .pill.bad{color:var(--bad);border-color:#5a2a2a}
  .empty{color:var(--muted);text-align:center;margin-top:48px}
  .progress{display:flex;align-items:center;gap:10px;padding:6px 24px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);background:#12141a}
  .progress[hidden]{display:none}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 1.1s infinite}
  @keyframes pulse{0%{opacity:.2}50%{opacity:1}100%{opacity:.2}}
  #pstate{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .progress button{font:inherit;font-size:12px;padding:2px 10px;border-radius:6px;border:1px solid #5a2a2a;background:#e05c5c22;color:#ffb4b4;cursor:pointer}
  .composer{display:flex;gap:10px;align-items:flex-end;padding:12px 24px 6px;border-top:1px solid var(--line);background:#12141a}
  .composer textarea{flex:1;min-height:44px;max-height:160px;resize:vertical;font:inherit;padding:11px 13px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:inherit;outline:none}
  .composer textarea:focus{border-color:#39415a}
  .sendbtn{flex:0 0 auto;padding:11px 20px;border-radius:10px;border:1px solid #2f5fb0;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
  .sendbtn:disabled{opacity:.45;cursor:default}
  .cmsg{padding:0 24px 10px;color:var(--muted);font-size:12px;min-height:16px;background:#12141a}
  .drawer{position:fixed;top:0;right:0;bottom:0;width:430px;max-width:92vw;background:var(--panel);border-left:1px solid var(--line);padding:16px;overflow:auto;z-index:60;box-shadow:-20px 0 40px #0007}
  .drawer[hidden]{display:none}
  .drawerhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;font-weight:600}
  .seats{display:grid;gap:8px}
  .seatrow{display:flex;gap:6px;align-items:center}
  .picker{position:relative;min-width:0}
  .picker.harness{width:150px}
  .picker.model{flex:1}
  .picker.effort{width:118px}
  .pbtn{width:100%;text-align:left;font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:9px;background:var(--panel2);color:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pbtn:disabled{opacity:.45;cursor:default}
  .menu{position:absolute;z-index:80;left:0;right:0;top:calc(100% + 4px);display:flex;flex-direction:column;max-height:300px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;box-shadow:0 14px 34px #000a;overflow:hidden}
  .mfilter{width:100%;box-sizing:border-box;padding:8px 10px;border:0;border-bottom:1px solid var(--line);background:#12141a;color:inherit;font:inherit;outline:none}
  .mitems{overflow:auto}
  .mitem{display:block;width:100%;text-align:left;font:inherit;padding:7px 10px;background:none;border:0;color:inherit;cursor:pointer}
  .mitem:hover{background:#ffffff14}
  .mitem.sel{background:var(--accent-soft)}
  .hint{color:var(--muted);font-size:12px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0 8px}
  .row input{width:64px;font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:inherit}
  .row button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:none;color:inherit;cursor:pointer}
  #drop{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:#4c8dff26;border:3px dashed var(--accent);font-size:18px;pointer-events:none}
  #drop[hidden]{display:none}
  .bubble{white-space:normal}
  .bubble p{margin:0 0 8px}
  .bubble p:last-child{margin-bottom:0}
  .bubble h2{font-size:15px;margin:10px 0 6px}
  .bubble h3{font-size:14px;margin:8px 0 4px}
  .bubble ul,.bubble ol{margin:6px 0;padding-left:22px}
  .bubble li{margin:2px 0}
  .bubble code.inline{background:#0b0e13;border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-family:Consolas,monospace;font-size:12.5px}
  .bubble pre{margin:8px 0;padding:10px 12px;background:#0b0e13;border:1px solid var(--line);border-radius:8px;overflow:auto}
  .bubble pre code{font-family:Consolas,monospace;font-size:12.5px;white-space:pre}
  .bubble blockquote{margin:8px 0;padding:2px 10px;border-left:3px solid #39415a;color:var(--muted)}
  .bubble hr{border:0;border-top:1px solid var(--line);margin:10px 0}
  .bubble a{color:var(--accent)}
  .bubble strong{color:#fff}
</style></head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">圆桌</div>
    <button id="newbtn" class="newbtn" type="button">+ 新讨论</button>
    <div id="rooms" class="rooms"></div>
    <div class="sidefoot">只读观测 · 每秒刷新</div>
  </aside>
  <main class="main">
    <header class="topbar">
      <div class="title">
        <h1 id="roomtitle">还没有选择讨论</h1>
        <div id="roommeta" class="meta">在下面发第一条消息即可开一个新讨论</div>
      </div>
      <button id="export" class="iconbtn" type="button" title="导出为 Markdown">⬇</button>
      <button id="settingsbtn" class="iconbtn" type="button" title="席位设置">⚙</button>
    </header>
    <div id="chatlog" class="chatlog"></div>
    <div id="progress" class="progress" hidden>
      <span class="dot"></span>
      <span id="pstate">…</span>
      <button type="button" id="stop">停止</button>
    </div>
    <footer class="composer">
      <button id="attach" class="iconbtn" type="button" title="附加文件">📎</button>
      <input type="file" id="file" hidden multiple />
      <textarea id="input" placeholder="说点什么…(Enter 发送,Shift+Enter 换行,可拖入文件)"></textarea>
      <button id="send" class="sendbtn" type="button">发送</button>
    </footer>
    <div id="cmsg" class="cmsg"></div>
  </main>
</div>
<aside id="settings" class="drawer" hidden>
  <div class="drawerhead">席位设置 <button id="closesettings" class="iconbtn" type="button">×</button></div>
  <div id="seats" class="seats"></div>
  <div class="row">
    <label class="hint">轮数 <input id="rounds" type="number" min="1" max="10" value="3" /></label>
    <button id="addseat" type="button">+ 席位</button>
  </div>
  <label class="hint" style="display:block;margin-bottom:10px">
    <input type="checkbox" id="converge" checked /> 讨论到出结果(全员无异议即停,收尾产出 final.md)
  </label>
  <p class="hint">首条消息会开新房间,之后每条消息触发一轮全员回应。模型与思考档来自各家自报;拉不到就显"未知",不替你猜。</p>
  <p class="hint">会真实调用模型并消耗额度。同一时刻只允许一场(三家共用一个 Antigravity 会话)。</p>
</aside>
<div id="drop" hidden>松开即上传(可多选,≤4MB/个)</div>
<script src="/rooms.js"></script>
</body></html>
`;

/** 当前这场圆桌(同一时刻只允许一场:antigravity 操作的是应用里的"当前会话")。 */
interface ActiveRun {
  id: string;
  startedAt: number;
  child: import('node:child_process').ChildProcess;
  logPath: string;
}
let activeRun: ActiveRun | null = null;

const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));
/** 页面脚本单独成文件:内联进模板字符串时,正则里的 \s \n 会被模板转义吃掉。 */
const ROOMS_JS = readFileSync(fileURLToPath(new URL('./rooms-page.js', import.meta.url)), 'utf8');

export function currentRun(): {
  running: boolean;
  id?: string;
  startedAt?: number;
  elapsedMs?: number;
  lastStatus?: string;
} {
  if (!activeRun) return { running: false };
  let lastStatus = '';
  try {
    const lines = readFileSync(activeRun.logPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60); i--) {
      const line = lines[i]!.trim();
      if (/^\[第 \d+\/\d+ 轮\]/.test(line) || line.startsWith('↳')) { lastStatus = line; break; }
    }
  } catch {
    /* 日志还没写出来 */
  }
  return {
    running: true,
    id: activeRun.id,
    startedAt: activeRun.startedAt,
    elapsedMs: Date.now() - activeRun.startedAt,
    lastStatus,
  };
}

/** 停一场:Windows 上只 kill 子进程会留下孙子(cod codex 等),所以整棵进程树一起收。 */
function stopRun(): boolean {
  if (!activeRun) return false;
  const pid = activeRun.child.pid;
  try {
    if (process.platform === 'win32' && pid) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      activeRun.child.kill('SIGTERM');
    }
  } catch {
    return false;
  }
  activeRun = null;
  return true;
}

async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('请求体过大(上限 64KB)');
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function rejectWith(res: import('node:http').ServerResponse, code: number, why: string): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, why }));
}

/** 子进程的输出落进房间目录的 run.log —— stdio:'ignore' 会把"为什么没跑起来"一起吞掉。 */
function spawnLogged(args: string[], logPath: string): import('node:child_process').ChildProcess {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.on('exit', () => { try { log.end(); } catch { /* 已关就算了 */ } });
  return child;
}

async function handleStart(
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  if (activeRun) {
    rejectWith(res, 409, `已有一场在跑(${activeRun.id});它要操作同一个 Antigravity 会话,不能并行`);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    rejectWith(res, 400, (err as Error).message);
    return;
  }

  const topic = String(body.topic ?? '').trim();
  const seats = String(body.seats ?? '').trim();
  const rounds = Number(body.rounds ?? 1);
  const untilConsensus = body.untilConsensus === true;

  // 这些都会变成子进程的 argv,属于系统边界:只收已知形状,不做"尽力纠正"。
  if (!topic) { rejectWith(res, 400, 'topic 不能为空'); return; }
  if (topic.length > 4000) { rejectWith(res, 400, 'topic 太长(上限 4000 字符)'); return; }
  if (!seats) { rejectWith(res, 400, 'seats 不能为空,例:codex:gpt-6-astra@low,claude@low,antigravity'); return; }
  if (!/^[\w.:@/,\-]{1,400}$/.test(seats)) { rejectWith(res, 400, 'seats 形状不合法(只收 harness[:model][@effort],逗号分隔,不含空格)'); return; }
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 10) { rejectWith(res, 400, 'rounds 必须是 0..10 的整数'); return; }

  const id = `room-${Date.now().toString(36)}`;
  const root = join(bridgeHome(), 'gui-rooms');
  mkdirSync(root, { recursive: true });

  const logPath = join(root, '.llms-bridge', 'roundtable', id, 'run.log');
  const args = [
    CLI_PATH,
    'roundtable',
    '--id', id,
    '--topic', topic,
    '--seats', seats,
    '--rounds', String(rounds),
    '--cwd', root,
  ];
  if (untilConsensus) args.push('--until-consensus');
  const child = spawnLogged(args, logPath);

  activeRun = { id, startedAt: Date.now(), child, logPath };
  child.on('exit', () => { if (activeRun?.id === id) activeRun = null; });
  child.on('error', () => { if (activeRun?.id === id) activeRun = null; });

  res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, id, rounds, seats }));
}

/**
 * 面板可选席位。
 * codebuddy / opencode 也放进来:它们是桥里已有的 adapter,能不能派是 adapter 的事;
 * 但 codebuddy 的限制是**账号级**风控(见 PLAN),选它之前自己心里有数。
 * opencode 的模型清单很长(几百个),下拉会滚动。
 */
const SEAT_HARNESSES = ['codex', 'claude', 'antigravity', 'codebuddy', 'opencode'];

export interface SeatCatalogEntry {
  id: string;
  name: string;
  tier: number;
  /** 探测结果:false 表示这台机器上暂时调不起来(比如 Antigravity 没开)。 */
  available: boolean;
  /** 空数组 = 该家不自报;前端必须显示"未知",不许填空值。 */
  models: string[];
  modelSource?: string;
  efforts: string[];
  effortSource?: string;
}

let catalogCache: { at: number; data: SeatCatalogEntry[] } | null = null;
let catalogRefreshing: Promise<SeatCatalogEntry[]> | null = null;

async function refreshCatalog(): Promise<SeatCatalogEntry[]> {
  if (catalogRefreshing) return catalogRefreshing;
  catalogRefreshing = (async () => {
    const data: SeatCatalogEntry[] = [];
    for (const adapter of createAdapters().filter((a) => SEAT_HARNESSES.includes(a.id))) {
      // 必须先 detect:claude 的 listModels/listEfforts 依赖探测时解析出的 CLI 路径。
      const detected = await adapter.detect().catch(() => null);
      const models = adapter.listModels ? await adapter.listModels().catch(() => null) : null;
      const efforts = adapter.listEfforts ? await adapter.listEfforts().catch(() => null) : null;
      data.push({
        id: adapter.id,
        name: adapter.displayName,
        tier: adapter.tier,
        available: detected?.available ?? false,
        models: models?.models ?? [],
        ...(models?.source ? { modelSource: models.source } : {}),
        efforts: efforts?.models ?? [],
        ...(efforts?.source ? { effortSource: efforts.source } : {}),
      });
    }
    catalogCache = { at: Date.now(), data };
    return data;
  })();
  try {
    return await catalogRefreshing;
  } finally {
    catalogRefreshing = null;
  }
}

/**
 * 席位目录。opencode 的 `models` 要跑几秒,所以有缓存就**先给旧的、后台再刷新** ——
 * 首屏不该为了一个下拉等 7 秒。
 */
export async function seatsCatalog(force = false): Promise<SeatCatalogEntry[]> {
  if (!force && catalogCache) {
    if (Date.now() - catalogCache.at > 60_000) void refreshCatalog();
    return catalogCache.data;
  }
  return refreshCatalog();
}

interface RoomMeta {
  dir: string;
  cwd?: string;
  topic?: string;
  seats?: string[];
  seatSpecs?: { harness: string; model?: string; effort?: string }[];
}

function roomMeta(id: string): RoomMeta | null {
  try {
    const registry = JSON.parse(readFileSync(join(bridgeHome(), 'roundtable-rooms.json'), 'utf8')) as Record<string, RoomMeta>;
    return registry[id] ?? null;
  } catch {
    return null;
  }
}

function seatsToString(meta: RoomMeta): string {
  const specs = meta.seatSpecs ?? [];
  if (specs.length > 0) {
    return specs
      .map((s) => s.harness + (s.model ? `:${s.model}` : '') + (s.effort ? `@${s.effort}` : ''))
      .join(',');
  }
  // 老房间没存全量规格:退回标签,至少能继续说话(模型/档位会用各家默认)。
  return (meta.seats ?? []).join(',');
}

/** 续聊:把用户这句写进转录,再让所有席位回一轮。 */
async function handleSay(
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  if (activeRun) {
    rejectWith(res, 409, `已有一场在跑(${activeRun.id});它要操作同一个 Antigravity 会话,不能并行`);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    rejectWith(res, 400, (err as Error).message);
    return;
  }

  const id = String(body.id ?? '');
  const text = String(body.text ?? '').trim();
  if (!/^[\w.-]{1,64}$/.test(id)) { rejectWith(res, 400, 'id 形状不合法'); return; }
  if (!text) { rejectWith(res, 400, '消息不能为空'); return; }
  if (text.length > 8000) { rejectWith(res, 400, '消息太长(上限 8000 字符)'); return; }

  const meta = roomMeta(id);
  if (!meta) { rejectWith(res, 404, '没有这个房间'); return; }
  const seats = seatsToString(meta);
  if (!seats) { rejectWith(res, 400, '房间没记录席位,无法续聊'); return; }

  let record;
  try {
    record = appendUserTurn(join(meta.dir, 'transcript.jsonl'), text);
  } catch (err) {
    rejectWith(res, 500, `写转录失败:${(err as Error).message}`);
    return;
  }

  const logPath = join(meta.dir, 'run.log');
  const child = spawnLogged([
    CLI_PATH,
    'roundtable',
    '--id', id,
    '--topic', meta.topic || '(续聊)',
    '--seats', seats,
    '--rounds', '1',
    '--cwd', meta.cwd ?? join(bridgeHome(), 'gui-rooms'),
  ], logPath);

  activeRun = { id, startedAt: Date.now(), child, logPath };
  child.on('exit', () => { if (activeRun?.id === id) activeRun = null; });
  child.on('error', () => { if (activeRun?.id === id) activeRun = null; });

  res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, id, turn: record.turn }));
}

/**
 * 附件先落到桥自己的 uploads/(不写进用户仓库)。
 * 位置作为**绝对路径**拼进消息里:codex/claude 能按路径读;
 * antigravity 的那席能不能读到,取决于它的工作区,不保证。
 */
async function handleUpload(
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 8 * 1024 * 1024);
  } catch (err) {
    rejectWith(res, 400, (err as Error).message);
    return;
  }
  const name = String(body.name ?? '').trim();
  const data = String(body.data ?? '');
  const id = String(body.id ?? '');
  if (!name || !data) { rejectWith(res, 400, 'name/data 都要给'); return; }

  // 文件名来自浏览器 = 系统边界:只留安全字符,并加时间前缀避免覆盖。
  const safe = name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
  const fileName = `${Date.now().toString(36)}-${safe}`;

  // 关键:有房间就落到**该房间的工作区**里。codex 的 read-only 沙箱只读 cwd 之内,
  // 放在桥目录下它会明说"我读不到这个文件"。
  const meta = /^[\w.-]{1,64}$/.test(id) ? roomMeta(id) : null;
  const dir = meta ? join(meta.dir, 'workspace', 'uploads') : join(bridgeHome(), 'uploads');
  const rel = meta ? `uploads/${fileName}` : undefined;

  mkdirSync(dir, { recursive: true });
  const target = join(dir, fileName);
  try {
    writeFileSync(target, Buffer.from(data, 'base64'));
  } catch (err) {
    rejectWith(res, 500, `落盘失败:${(err as Error).message}`);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, path: target, ...(rel ? { rel } : {}) }));
}

async function handle(
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0]!;

  if (req.method === 'POST' && path === '/api/roundtable/start') {
    await handleStart(req, res);
    return;
  }
  if (req.method === 'POST' && path === '/api/room/say') {
    await handleSay(req, res);
    return;
  }
  if (req.method === 'POST' && path === '/api/run/stop') {
    const stopped = stopRun();
    res.writeHead(stopped ? 200 : 409, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: stopped, why: stopped ? undefined : '没有在跑的任务' }));
    return;
  }
  if (req.method === 'POST' && path === '/api/upload') {
    await handleUpload(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('面板只读;写入口只有 /api/roundtable/start、/api/room/say、/api/upload\n');
    return;
  }
  // no-store:面板显示的是"此刻还在不在跑",看到缓存快照会得出完全错误的结论。
  res.setHeader('cache-control', 'no-store');
  if (path === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buildState()));
    return;
  }
  if (path === '/api/task') {
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const taskId = query.get('task_id') ?? '';
    // taskId 会参与拼盘路径,而它是 HTTP 查询参数 = 系统边界。只收我们自己写出去过的形状。
    if (!/^[\w.-]{1,64}$/.test(taskId)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ found: false, why: 'task_id 形状不合法(只收字母、数字、点、下划线、连字符)' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buildTaskView(taskId)));
    return;
  }
  if (path === '/api/seats-catalog') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(await seatsCatalog()));
    return;
  }
  if (path === '/api/run') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(currentRun()));
    return;
  }
  if (path === '/api/rooms') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(listRooms()));
    return;
  }
  if (path === '/api/room') {
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const id = query.get('id') ?? '';
    // 房间 id 参与拼盘路径,而它是查询参数 = 系统边界。只收我们自己登记过的形状。
    if (!/^[\w.-]{1,64}$/.test(id)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ found: false, why: 'id 形状不合法(只收字母、数字、点、下划线、连字符)' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(readRoom(id)));
    return;
  }
  if (path === '/rooms.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    res.end(ROOMS_JS);
    return;
  }
  if (path === '/rooms' || path === '/rooms.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(ROOMS_PAGE);
    return;
  }
  if (path !== '/' && path !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}

/** token 只含各家**自报**的部分,所以汇总必须把这条一起带出去 —— 否则 0 会被读成"免费"。 */
export interface HarnessUsage {
  harness: string;
  tasks: number;
  ok: number;
  failed: number;
  tokens: number;
  /** 没自报用量的任务数。tokens 少不等于用得少。 */
  unreported: number;
  models: Record<string, number>;
}

export interface PanelState {
  generatedAt: number;
  /** 账本覆盖到哪些仓库。空 = 这台机器还没用桥派过活。 */
  scanned: string[];
  totals: { all: number; running: number; lost: number; finished: number };
  byHarness: HarnessUsage[];
  tasks: ListedTask[];
  /** 按工作区归组:一个 worktree 一栏,里面是它的各轮往来。 */
  workgroups: Workgroup[];
  notes: string[];
}

/**
 * 一个工作区(bridge 建的 worktree、复用的 worktree、或未隔离的 cwd)。
 *
 * 为什么以工作区而不是以任务为主键:同一个 worktree 上的多轮派发是**同一件事的连续状态**
 * (第二轮读得到第一轮的改动),按任务摊平就把这条线切断了 —— 而人回看时要的正是这条线。
 */
export interface Workgroup {
  path: string;
  kind: 'bridge-worktree' | 'reused-worktree' | 'unisolated';
  /** 它从哪个仓库来的;未隔离时就是那个目录本身。 */
  repo: string;
  tasks: number;
  running: number;
  harnesses: string[];
  lastStartedAt: number;
}

const WORKTREE_MARK = '/.llms-bridge/worktrees/';

function groupTasks(listed: ListedTask[]): Workgroup[] {
  const byPath = new Map<string, Workgroup>();
  for (const t of listed) {
    const path = t.worktreePath ?? t.cwd;
    const normalized = path.replaceAll('\\', '/');
    const g = byPath.get(path) ?? {
      path,
      kind: !t.isolated
        ? 'unisolated'
        : normalized.includes(WORKTREE_MARK)
          ? 'bridge-worktree'
          : 'reused-worktree',
      // 未隔离时仓库就是调用方给的目录;worktree 则从容器目录反推主仓库。
      repo: t.isolated && normalized.includes(WORKTREE_MARK) ? normalized.split(WORKTREE_MARK)[0]! : (t.requestedCwd || path),
      tasks: 0,
      running: 0,
      harnesses: [],
      lastStartedAt: 0,
    } as Workgroup;
    g.tasks++;
    if (t.liveness === 'running' || t.liveness === 'awaiting_output') g.running++;
    if (!g.harnesses.includes(t.harness)) g.harnesses.push(t.harness);
    g.lastStartedAt = Math.max(g.lastStartedAt, t.startedAt);
    byPath.set(path, g);
  }
  return [...byPath.values()].sort((a, b) => b.lastStartedAt - a.lastStartedAt);
}

/**
 * 单次派发的完整视图:账本记录 + 心跳进度 + 落盘事件流。
 *
 * `eventsOnDisk` 与 `eventsKnown` 必须都给:前者是盘上真有的行数,后者是心跳记的事件总数。
 * 只给一个数,调用方就无从知道"过程缺了" —— 差额来自撞字节上限、或桥被杀前没写出来。
 */
export interface TaskView {
  found: boolean;
  taskId: string;
  why?: string;
  record?: TaskRecord;
  progress?: TaskProgress;
  events?: EventLogLine[];
  eventsOnDisk?: number;
  eventsKnown?: number;
  /** 事件流是否撞了每任务字节上限。 */
  capped?: boolean;
  /** 读不了 / 被跳过的残行数。 */
  malformed?: number;
  recordPath?: string;
  eventsPath?: string;
  eventsUnreadable?: string;
}

export function buildTaskView(taskId: string): TaskView {
  const found = locateTaskRecord(taskId);
  if (!found) {
    return {
      found: false,
      taskId,
      why: '本机账本与索引里都没有这个 taskId —— 要么从没派发过,要么它所在仓库被删/搬走了(桥不猜它去哪了)',
    };
  }
  const { cwd, record } = found;
  const log = readEventLog(cwd, taskId);
  const progress = readProgress(cwd, taskId, record);
  return {
    found: true,
    taskId,
    record,
    progress,
    events: log.lines,
    eventsOnDisk: log.total,
    eventsKnown: progress.events,
    capped: log.capped,
    malformed: log.malformed,
    recordPath: taskRecordPath(cwd, taskId),
    eventsPath: eventLogPath(cwd, taskId),
    ...(log.unreadable === undefined ? {} : { eventsUnreadable: log.unreadable }),
  };
}

export function buildState(now = Date.now()): PanelState {
  const listed = listTaskRecords(now);
  const seen = new Set(listed.map((t) => t.cwd));

  const byHarness = new Map<string, HarnessUsage>();
  let running = 0;
  let lost = 0;
  let finished = 0;
  for (const t of listed) {
    const u = byHarness.get(t.harness) ?? {
      harness: t.harness,
      tasks: 0,
      ok: 0,
      failed: 0,
      tokens: 0,
      unreported: 0,
      models: {},
    };
    u.tasks++;
    if (t.liveness === 'running' || t.liveness === 'awaiting_output') running++;
    else if (t.liveness === 'heartbeat_lost') lost++;
    else finished++;
    if (t.status === 'ok') u.ok++;
    else if (t.status !== 'running') u.failed++;
    if (t.tokens > 0) u.tokens += t.tokens;
    else u.unreported++;
    // 没点名的任务不许并进某个真实型号里 —— 那会被读成"这家默认就是这个模型"。
    const model = t.model ?? '(未指定,用该 harness 的默认模型)';
    u.models[model] = (u.models[model] ?? 0) + 1;
    byHarness.set(t.harness, u);
  }

  return {
    generatedAt: now,
    scanned: [...seen],
    totals: { all: listed.length, running, lost, finished },
    byHarness: [...byHarness.values()].sort((a, b) => b.tasks - a.tasks),
    tasks: listed,
    workgroups: groupTasks(listed),
    notes: [
      'token 只统计各家自报的部分;0 可能是"该家不报用量",不等于没用过。',
      '面板只读:派发仍然只走 MCP 的 harness_dispatch,这里没有任何写接口。',
      'liveness=heartbeat_lost 时记录本身可能仍写着 running —— 那代表"桥不再心跳",不代表模型失败。',
      '事件流按逐字段与逐任务上限落盘,超长会被截断并标记;diff 的完整那一份留在 worktree 里,不在这里。',
      'prompt、模型原文与事件流都落在本机磁盘(.llms-bridge/tasks/),清理 worktree 会连带删掉它的事件流。',
    ],
  };
}

/** 静态骨架,不含任何数据;数据一律由 DOM API 填。没有构建步骤。 */
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>LLMS Bridge 面板</title>
<style>
 :root { color-scheme: light dark }
 body { font: 14px/1.55 ui-monospace, "Cascadia Mono", Consolas, monospace; margin: 0; padding: 22px; background: #101317; color: #dfe3e8 }
 h1 { font-size: 17px; margin: 0 0 4px }
 .sub { color: #8b949e; font-size: 12px; margin-bottom: 18px }
 .cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px }
 .card { background: #171b21; border: 1px solid #262c34; border-radius: 7px; padding: 10px 14px; min-width: 96px }
 .card b { display: block; font-size: 21px; font-weight: 600 }
 .card span { color: #8b949e; font-size: 11px }
 table { width: 100%; border-collapse: collapse; margin-bottom: 22px }
 th, td { text-align: left; padding: 6px 9px; border-bottom: 1px solid #22272e; vertical-align: top }
 th { color: #8b949e; font-weight: 500; font-size: 11px; letter-spacing: .04em }
 .run { color: #58a6ff } .lost { color: #d29922 } .ok { color: #3fb950 } .bad { color: #f85149 }
 .note { color: #8b949e; font-size: 11px }
 .bar { height: 3px; background: #58a6ff; border-radius: 2px; margin-top: 4px }
 ul.notes { color: #8b949e; font-size: 12px; padding-left: 18px }
 .group { background: #171b21; border: 1px solid #262c34; border-radius: 7px; padding: 10px 12px; margin-bottom: 12px }
 .ghead { margin-bottom: 6px }
 .ghead b { display: block; font-size: 12px; word-break: break-all }
 button { font: inherit; background: #21262d; color: #dfe3e8; border: 1px solid #30363d; border-radius: 5px; padding: 2px 8px; cursor: pointer }
 button:hover { border-color: #58a6ff }
 .detail { background: #171b21; border: 1px solid #262c34; border-radius: 7px; padding: 12px 14px; color: #dfe3e8 }
 .detail h2 { font-size: 13px; margin: 14px 0 6px; color: #8b949e; font-weight: 500 }
 pre { margin: 0; padding: 8px 10px; background: #101317; border: 1px solid #22272e; border-radius: 5px; white-space: pre-wrap; word-break: break-word; font-size: 12px }
 .ev { display: flex; gap: 8px; border-bottom: 1px solid #22272e; padding: 4px 0; font-size: 12px }
 .ev .k { color: #58a6ff; min-width: 92px }
 .ev .s { color: #8b949e; min-width: 52px }
 .ev .t { flex: 1; word-break: break-word }
 .warn { color: #d29922; font-size: 12px }
</style></head>
<body>
<h1>LLMS Bridge <span class="note">只读观测面</span></h1>
<div class="sub" id="meta">载入中…</div>
<div id="cards"></div>
<h1>工作区</h1>
<div class="sub" id="empty"></div>
<div id="groups"></div>
<h1>会话</h1>
<div class="detail" id="detail">点上面任一行左侧的任务号,读它的 prompt、逐条事件与结果。</div>
<h1>按 harness 汇总</h1>
<table><thead><tr><th>harness</th><th>任务</th><th>ok / 失败</th><th>token 合计</th><th>未自报用量</th><th>用过的模型</th></tr></thead><tbody id="usage"></tbody></table>
<ul class="notes" id="notes"></ul>
<script>
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = text == null ? '' : String(text);
  return n;
};
const td = (cls, text) => el('td', cls, text);
const ago = (ms) => ms == null ? '-' : (ms < 60000 ? Math.round(ms / 1000) + '秒前' : Math.round(ms / 60000) + '分前');
const lcls = (l) => l === 'running' ? 'run' : l === 'heartbeat_lost' ? 'lost' : l === 'finished' ? 'ok' : 'note';
const swap = (id, node) => { const old = document.getElementById(id); old.replaceWith(node); node.id = id; };
const kindLabel = (k) => k === 'bridge-worktree' ? '桥建 worktree(已隔离)'
  : k === 'reused-worktree' ? '复用 worktree(已隔离)'
  : '未隔离(直接落在调用方给的目录)';
const preview = (x, n) => {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const HEADS = ['任务', '状态', 'harness', '模型', '档位', '进度', 'token', '结果 / 原因'];

/**
 * 会话详情:prompt → 逐条事件 → 结果。
 *
 * 全程 textContent:这里显示的是**别的厂商模型写出来的原文**,拼 HTML 等于把
 * "漏转义一次"变成"任意 HTML 注入"。
 */
async function showTask(taskId) {
  let d;
  try {
    d = await (await fetch('/api/task?task_id=' + encodeURIComponent(taskId))).json();
  } catch (e) {
    const box = el('div', 'detail');
    box.append(el('div', 'warn', '读不到详情:' + e.message));
    swap('detail', box);
    return;
  }
  const box = el('div', 'detail');
  if (!d.found) {
    box.append(el('div', null, '查无此任务 ' + d.taskId));
    box.append(el('div', 'warn', d.why || ''));
    swap('detail', box);
    return;
  }
  const r = d.record;
  box.append(el('div', null, r.taskId));
  box.append(el('div', 'note', r.harness + ' · 模型 ' + (r.model || '(该家默认)') + ' · 档位 ' + r.approval +
    (r.isolated ? ' · 已隔离' : ' · 未隔离') + ' · 会话 ' + r.sessionMode + ' · 层级 ' + r.tier));
  box.append(el('div', 'note', '工作区 ' + r.cwd + (r.egressHost ? ' · 这次数据发往 ' + r.egressHost : ' · 数据去向该家未自报')));
  box.append(el('div', 'note', new Date(r.startedAt).toLocaleString() +
    (r.endedAt ? ' → ' + new Date(r.endedAt).toLocaleTimeString() : ' → 没写下结束时刻')));
  box.append(el('div', r.status === 'ok' ? 'ok' : 'bad', 'status=' + r.status + ' | ' + d.progress.note));

  if (d.eventsUnreadable) {
    box.append(el('div', 'warn', '事件流读不到:' + d.eventsUnreadable + ' —— 早于事件落盘的旧账本就长这样,过程确实不可回放'));
  } else if (d.eventsKnown > d.eventsOnDisk) {
    box.append(el('div', 'warn', '盘上 ' + d.eventsOnDisk + ' 条,心跳记 ' + d.eventsKnown + ' 条:差额是撞字节上限或桥被杀前没写出来,别当成"过程都在这"'));
  }
  if (d.capped) box.append(el('div', 'warn', '这份事件流撞过每任务字节上限,后面的事件没落盘'));
  if (d.malformed) box.append(el('div', 'warn', d.malformed + ' 行残行被跳过(崩在写一半留下的半个 JSON)'));

  box.append(el('h2', null, 'prompt'));
  box.append(el('pre', null, preview(r.prompt || '', 4000)));
  box.append(el('h2', null, '事件流(逐条往来,尾部 ' + d.events.length + ' 条)'));
  const evs = el('div');
  if (d.events.length === 0) evs.append(el('div', 'note', '(没有落盘的事件)'));
  for (const l of d.events) {
    const row = el('div', 'ev');
    row.append(el('span', 's', '#' + l.seq));
    row.append(el('span', 'k', l.marker ? '上限标记' : l.type));
    row.append(el('span', 'note', new Date(l.at).toLocaleTimeString()));
    row.append(el('span', 't', (l.text || '') + (l.raw === undefined ? '' : '  ⟵ ' + preview(l.raw, 300)) + (l.clipped ? '  [已截断]' : '')));
    evs.append(row);
  }
  box.append(evs);
  box.append(el('h2', null, '结果'));
  box.append(el('pre', null, preview(r.text || '(没有产出正文)', 4000)));
  if (r.reason) {
    box.append(el('h2', null, '原因'));
    box.append(el('pre', 'warn', r.reason));
  }
  box.append(el('div', 'note', '账本 ' + d.recordPath + ' · 事件流 ' + d.eventsPath));
  swap('detail', box);
}

function taskRow(r) {
  const tr = document.createElement('tr');
  const c0 = document.createElement('td');
  const btn = el('button', null, r.taskId.slice(0, 8));
  btn.title = '读这次派发的 prompt、逐条事件与结果';
  btn.addEventListener('click', function () { showTask(r.taskId); });
  c0.append(btn);
  tr.append(c0);
  const c1 = el('td', lcls(r.liveness));
  c1.append(el('span', null, r.liveness));
  if (r.status !== 'running') c1.append(el('div', 'note', 'status=' + r.status));
  tr.append(c1);
  tr.append(td(null, r.harness));
  tr.append(td('note', r.model || '(默认)'));
  tr.append(td('note', (r.approval || '-') + (r.isolated ? '' : '  未隔离')));
  const c5 = el('td');
  c5.append(el('div', null, r.events + ' 事件 · 最后输出 ' + ago(r.lastEventAgoMs)));
  const bar = el('div', 'bar');
  const live = r.liveness === 'running' || r.liveness === 'awaiting_output';
  bar.style.width = (live ? Math.min(100, 8 + r.events * 2) : 100) + '%';
  c5.append(bar);
  c5.append(el('div', 'note', r.livenessNote));
  tr.append(c5);
  tr.append(td(null, r.tokens));
  tr.append(td('note', (r.text || r.reason || '').slice(0, 260)));
  return tr;
}

async function tick() {
  let s;
  try { s = await (await fetch('/api/state')).json(); }
  catch (e) { document.getElementById('meta').textContent = '读不到面板进程:' + e.message; return; }

  document.getElementById('meta').textContent =
    '账本扫描自 ' + (s.scanned.length ? s.scanned.join(' · ') : '(本机还没有派发记录)') +
    '  |  刷新于 ' + new Date(s.generatedAt).toLocaleTimeString() + '  |  2 秒一跳';

  const t = s.totals;
  const cards = el('div', 'cards');
  for (const row of [['全部', t.all, ''], ['在跑', t.running, 'run'],
                     ['疑似失联', t.lost, 'lost'], ['已结束', t.finished, 'ok']]) {
    const card = el('div', 'card');
    card.append(el('b', row[2], row[1]));
    card.append(el('span', null, row[0]));
    cards.append(card);
  }
  swap('cards', cards);
  document.getElementById('empty').textContent = t.all
    ? '' : '还没有任务记录。派一个活,或检查 LLMS_BRIDGE_HOME 与账本所在仓库是否一致。';

  const groups = el('div');
  for (const g of s.workgroups) {
    const box = el('div', 'group');
    const head = el('div', 'ghead');
    head.append(el('b', null, g.path));
    head.append(el('div', 'note', kindLabel(g.kind) + ' · 来自 ' + g.repo + ' · ' + g.tasks + ' 轮' +
      (g.running ? ' · ' + g.running + ' 在跑' : '') + ' · harness ' + g.harnesses.join('/')));
    box.append(head);
    const table = document.createElement('table');
    const htr = document.createElement('tr');
    for (const h of HEADS) htr.append(el('th', null, h));
    const thead = document.createElement('thead');
    thead.append(htr);
    const tbody = document.createElement('tbody');
    // 组内按派发先后正序:多轮往来要按它发生的顺序读, newest-first 会把对话倒过来。
    const mine = s.tasks.filter(function (r) { return (r.worktreePath || r.cwd) === g.path; })
      .sort(function (a, b) { return a.startedAt - b.startedAt; });
    for (const r of mine) tbody.append(taskRow(r));
    table.append(thead, tbody);
    box.append(table);
    groups.append(box);
  }
  swap('groups', groups);

  const usage = el('tbody');
  for (const u of s.byHarness) {
    const tr = document.createElement('tr');
    const cell = document.createElement('td');
    cell.append(el('span', 'ok', u.ok), el('span', null, ' / '), el('span', 'bad', u.failed));
    tr.append(td(null, u.harness), td(null, u.tasks), cell,
      td(null, u.tokens), td('note', u.unreported),
      td('note', Object.entries(u.models).map(function (m) { return m[0] + '×' + m[1]; }).join(' · ')));
    usage.append(tr);
  }
  swap('usage', usage);

  const notes = el('ul', 'notes');
  for (const n of s.notes) notes.append(el('li', null, n));
  swap('notes', notes);
}
tick(); setInterval(tick, 2000);
</script></body></html>
`;
