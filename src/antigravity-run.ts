import { CdpClient, fetchVersion, findPage, readCdpPort } from './antigravity-cdp.ts';

/**
 * 把一句话送进正在运行的 Antigravity,并把回答按 JSONL 吐给桥的 adapter。
 *
 * 为什么是"独立子进程"而不是在 adapter 里直接连 CDP:桥的统一契约是 subprocess + 行流
 * (SpawnPlan / RunParser),这样超时、进程树中断、事件落盘都不用另写一套。
 *
 * 三道闸(缺一条就不该调用它):
 *  1. 读不到 DevToolsActivePort → 直接失败,不猜端口。
 *  2. 当前激活项目 ≠ --project → 拒绝输入(防止把话打进用户真实项目)。
 *  3. 只碰输入框与发送按钮,从不点 Run / Accept / Apply。
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function emit(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function fail(text: string, code: number): never {
  emit({ type: 'error', text });
  process.exit(code);
}

const prompt = flag('prompt') ?? '';
const project = flag('project') ?? 'debate';
const timeoutMs = Number(flag('timeout-ms') ?? 180_000);
if (!prompt) fail('缺少 --prompt', 2);

const port = readCdpPort();
if (!port) fail('读不到 Antigravity 的 DevToolsActivePort —— 应用没开,或没启用远程调试', 2);
// 登记文件会在进程退出后留下来,所以"有端口"不等于"进程还活着"。先打一枪再判断。
const version = await fetchVersion(port);
if (!version) {
  fail(`登记端口 ${port} 上没有 CDP 响应:Antigravity 已经退出(或刚启动还没就绪),文件是上次留下的`, 2);
}
const page = await findPage(port);
if (!page?.webSocketDebuggerUrl) fail(`CDP 在 ${port} 上活着,但没有 page target(窗口还没加载完?)`, 2);

const client = await CdpClient.connect(page.webSocketDebuggerUrl);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EDITOR = `(() => {
  const byLabel = document.querySelector('[contenteditable="true"][aria-label="Message input"]');
  if (byLabel && byLabel.offsetParent) return byLabel;
  return Array.from(document.querySelectorAll('[contenteditable="true"]')).find((e) => e.offsetParent) || null;
})()`;

const headerProject = `(() => {
  const btn = document.querySelector('button[class*="headerbtn"]');
  const t = btn ? btn.innerText.trim() : '';
  if (t) return t;
  const crumb = document.querySelector('span.truncate.inline-block');
  return crumb ? crumb.innerText.trim() : '';
})()`;

const assistantCount = `document.querySelectorAll('div.leading-relaxed.select-text').length`;

const beforeProject = String(await client.eval(headerProject));
if (beforeProject !== project) {
  client.close();
  fail(`当前激活项目是「${beforeProject || '(未知)'}」,不是 --project 指定的「${project}」——拒绝输入`, 3);
}

if (has('new')) {
  const clicked = await client.eval<boolean>(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.getAttribute('aria-label') || b.innerText || '').trim() === 'New Conversation');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) {
    client.close();
    fail('找不到 New Conversation 按钮 —— 无法保证是新会话,拒绝继续', 4);
  }
  await sleep(900);
  const afterProject = String(await client.eval(headerProject));
  if (afterProject !== project) {
    client.close();
    fail(`新建会话后项目变成了「${afterProject}」,与「${project}」不符 —— 停止`, 3);
  }
}

const focused = await client.eval<string>(`(() => {
  const ed = ${EDITOR};
  if (!ed) return 'no-editor';
  ed.focus();
  return 'focused';
})()`);
if (focused !== 'focused') {
  client.close();
  fail('找不到输入框(Message input)', 4);
}

await client.send('Input.insertText', { text: prompt });
const typed = await client.eval<string>(`(() => {
  const ed = ${EDITOR};
  return ed ? ed.innerText.trim() : '';
})()`);
if (!typed) {
  client.close();
  fail('文本没有进入输入框', 4);
}

const beforeCount = Number(await client.eval(assistantCount));
const clickedSend = await client.eval<boolean>(`(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.getAttribute('aria-label') || '').trim() === 'Send message');
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
})()`);
if (!clickedSend) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
  }
}

const startedAt = Date.now();
let last = '';
let stable = 0;
let sawReply = false;
while (Date.now() - startedAt < timeoutMs) {
  await sleep(1200);
  const count = Number(await client.eval(assistantCount));
  const text = String(await client.eval<string>(`(() => {
    const nodes = document.querySelectorAll('div.leading-relaxed.select-text');
    return nodes.length ? nodes[nodes.length - 1].innerText : '';
  })()`));
  if (count > beforeCount || (text && text !== last)) sawReply = true;

  // "Worked for Ns" 是**这一轮真的结束**之后才出现的折叠条;思考阶段的停顿看起来和结束一模一样,
  // 只靠"文本稳定"会把思考片段当答案(实测踩过)。
  const state = JSON.parse(String(await client.eval<string>(`(() => {
    const nodes = Array.from(document.querySelectorAll('button,[role="button"]'));
    const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
    const worked = nodes.some((b) => /Worked for|已完成工作|工作 \\d+ 秒/i.test(label(b)));
    const stop = nodes.some((b) => /stop|cancel|停止|取消/i.test(label(b)));
    return JSON.stringify({ worked, stop });
  })()`)));
  const finished = state.worked === true || (state.stop !== true && stable >= 5);

  if (text && text !== last) {
    last = text;
    stable = 0;
    emit({ type: 'message', text });
  } else {
    stable += 1;
  }
  if (sawReply && stable >= 2 && finished) break;
}

client.close();
if (!sawReply || !last) fail(`等不到回答(${Math.round(timeoutMs / 1000)}s 内)`, 5);
emit({ type: 'result', text: last, session_id: 'antigravity-current' });
process.exit(0);
