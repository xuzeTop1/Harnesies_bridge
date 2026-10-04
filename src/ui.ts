/**
 * 只读观测面板:给人看"派了多少、正在跑什么、各家烧了多少 token"。
 *
 * 三条边界是这个文件存在的前提,别在后续改动里磨掉:
 *  1. **只读**。没有任何派发/取消/合并接口 —— 控制面仍然只有 MCP 六原语。
 *     面板能改状态的那一刻,它就成了第二个主脑,而它比主脑更没有上下文。
 *  2. **只听回环,端口由系统分配**。AGENTS.md 禁止硬编码端口:listen(0) 拿临时端口,
 *     实际值写进登记文件 ~/.llms-bridge/ui.json 供人找回。
 *  3. **渲染不拼 HTML**。页面显示的是各家模型的原文,拼字符串就等于把"漏转义一次"
 *     变成"任意 HTML 注入",而那内容的作者不是我们。所以全程 createElement + textContent。
 *
 * 数据只来自落盘账本 + 心跳文件 + 事件流文件:桥重启、面板先起后起,都不影响能看到历史。
 * 面板是**另一个进程**,读不到桥的内存,所以"正在跑的会话"也只能从盘上看 ——
 * 这正是事件流落盘(2026-10-05)存在的原因。
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eventLogPath, listTaskRecords, locateTaskRecord, readEventLog, readProgress, taskRecordPath } from './journal.ts';
import type { EventLogLine, ListedTask, TaskProgress, TaskRecord } from './journal.ts';

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

async function handle(
  req: { method?: string; url?: string },
  res: import('node:http').ServerResponse,
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0]!;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('只读面板:不接受写操作\n');
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
