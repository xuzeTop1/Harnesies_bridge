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
 * 数据只来自落盘账本 + 心跳文件:桥重启、面板先起后起,都不影响能看到历史。
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listTaskRecords } from './journal.ts';
import type { ListedTask } from './journal.ts';

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
  notes: string[];
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
    notes: [
      'token 只统计各家自报的部分;0 可能是"该家不报用量",不等于没用过。',
      '面板只读:派发仍然只走 MCP 的 harness_dispatch,这里没有任何写接口。',
      'liveness=heartbeat_lost 时记录本身可能仍写着 running —— 那代表"桥不再心跳",不代表模型失败。',
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
</style></head>
<body>
<h1>LLMS Bridge <span class="note">只读观测面</span></h1>
<div class="sub" id="meta">载入中…</div>
<div id="cards"></div>
<h1>任务</h1>
<div class="sub" id="empty"></div>
<table><thead><tr>
 <th>状态</th><th>harness</th><th>模型</th><th>档位</th><th>目录</th><th>进度</th><th>token</th><th>结果 / 原因</th>
</tr></thead><tbody id="rows"></tbody></table>
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

  const rows = el('tbody');
  for (const r of s.tasks) {
    const live = r.liveness === 'running' || r.liveness === 'awaiting_output';
    const tr = document.createElement('tr');
    const c0 = td(lcls(r.liveness), r.liveness);
    if (r.status !== 'running') c0.append(el('div', 'note', 'status=' + r.status));
    tr.append(c0);
    tr.append(td(null, r.harness));
    tr.append(td('note', r.model || '(默认)'));
    const c3 = td('note', (r.approval || '-') + (r.isolated ? '' : '  未隔离'));
    tr.append(c3);
    tr.append(td('note', r.requestedCwd || r.cwd));
    const c5 = td(null, r.events + ' 事件 · 最后输出 ' + ago(r.lastEventAgoMs));
    // 走 CSSOM 而非标记解析,数值也是本地算出来的。
    const bar = el('div', 'bar');
    bar.style.width = (live ? Math.min(100, 8 + r.events * 2) : 100) + '%';
    c5.append(bar);
    c5.append(el('div', 'note', r.livenessNote));
    tr.append(c5);
    tr.append(td(null, r.tokens));
    tr.append(td('note', (r.text || r.reason || '').slice(0, 260)));
    rows.append(tr);
  }
  swap('rows', rows);

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
