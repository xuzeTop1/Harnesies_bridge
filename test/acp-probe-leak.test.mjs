/**
 * 层级① 探测的真实进程行为:用一支**假 ACP CLI** 走通 detect() → listModels() 整条路。
 *
 * 为什么值得单开一个文件:这条路上两个缺陷都是"进程级"的,断言 parser 收不到,
 * 只能靠真起进程才知道(零额度 —— 假 CLI 不调任何模型):
 *   1. 探测收尾必须连 re-exec 出来的孙进程一起杀,否则每次 harness_list 都留下一批孤儿;
 *   2. 模型清单必须复用 detect 那次握手,不能为一次清单再 spawn 一个 CLI(此前的行为)。
 * 以及 3. 跨进程缓存真的让第二个桥进程一个进程都不起。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAcpAdapter } from '../src/adapters/acp.ts';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HOME = mkdtempSync(join(tmpdir(), 'llms-bridge-acpprobe-'));
process.env.LLMS_BRIDGE_HOME = HOME;
const LOG = join(HOME, 'spawns.log');
process.env.FAKE_ACP_LOG = LOG;

// —— 假 CLI:PATH 上一个 bin + 与它同级的 node_modules(resolveGlobalCli 就是这么找全局包的)——
const binDir = join(HOME, 'bin');
const pkgDir = join(binDir, 'node_modules', 'fake-acp');
mkdirSync(binDir, { recursive: true });
mkdirSync(pkgDir, { recursive: true });
// 无扩展名的 shim:which() 会按 .exe/.cmd/.bat/'' 的顺序挑到它,而 resolveGlobalCli
// 从不 spawn shim 本身(它只读包里的 bin 入口),所以在 Windows 上也成立。
writeFileSync(join(binDir, 'fake-acp'), '#!/bin/sh\n');
writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-acp', bin: { 'fake-acp': 'cli.mjs' } }));
writeFileSync(
  join(pkgDir, 'cli.mjs'),
  `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const LOG = process.env.FAKE_ACP_LOG;
appendFileSync(LOG, 'shell ' + process.pid + '\\n');

// 真实那几家(qwen/mimo/openclaw)都会再 re-exec 一层重进程 —— 泄漏就出在那一层:
// 桥只杀 shell,这货会变成孤儿常驻。
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
appendFileSync(LOG, 'grand ' + grand.pid + '\\n');

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const SESSION = {
  sessionId: 'ses_fake',
  models: { currentModelId: 'fake/a', availableModels: [{ modelId: 'fake/a' }, { modelId: 'fake/b' }] },
};

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === 1) out({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentInfo: { name: 'Fake', version: '0.1.0' }, authMethods: [] } });
  if (m.id === 2) out({ jsonrpc: '2.0', id: 2, result: SESSION });
  // 收到 initialize/session/new 之后**不退场**:真 agent 就是这样常驻等提示词的,
  // 所以"探测结束 = 进程没了"只能是桥的功劳,不能指望对方自己走。
});
setInterval(() => {}, 1000);
`,
);
process.env.PATH = binDir + (process.platform === 'win32' ? ';' : ':') + process.env.PATH;

const spawns = () =>
  readFileSync(LOG, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [kind, pid] = l.split(' ');
      return { kind, pid: Number(pid) };
    });

/** 每个用例从"没有记录、没有缓存"开始,否则断言的是上一个用例留下的状态。 */
const resetLog = () => writeFileSync(LOG, '');
const resetCache = () => rmSync(join(HOME, 'acp-probes'), { recursive: true, force: true });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

const makeAdapter = () =>
  createAcpAdapter({ id: 'fake', displayName: 'Fake (ACP)', binName: 'fake-acp', pkgName: 'fake-acp', acpArgs: ['acp'] });

const waitAlive = async (pid, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise((s) => setTimeout(s, 100));
  return alive(pid);
};

test('detect() 收尾不留孤儿:shell 与它 re-exec 的孙进程都得没', async () => {
  resetCache();
  resetLog();
  const detected = await makeAdapter().detect();
  assert.equal(detected.available, true, `假 CLI 应判可用,实际: ${detected.detail ?? '(无原因)'}`);
  assert.match(detected.version ?? '', /Fake 0\.1\.0/, '版本要来自真实握手');

  const listed = spawns();
  assert.equal(listed.filter((s) => s.kind === 'shell').length, 1, '一次 detect 该起一个 CLI 进程');
  assert.ok(listed.length >= 2, '假 CLI 的孙进程也要被记下来,否则这条断言没意义');

  for (const s of listed) {
    assert.equal(await waitAlive(s.pid), false, `${s.kind} ${s.pid} 在探测结束后仍然活着 = 孤儿泄漏`);
  }
});

test('listModels() 复用 detect 那次握手,不再为清单多起一个 CLI 进程', async () => {
  resetCache();
  resetLog();
  const adapter = makeAdapter();
  await adapter.detect();
  const afterDetect = spawns().length;
  assert.ok(afterDetect >= 1, '前提:这一次是真探,后面才谈得上"复用"');

  const catalog = await adapter.listModels();
  assert.deepEqual(catalog?.models, ['fake/a', 'fake/b']);
  assert.match(catalog?.source ?? '', /session\/new/);
  assert.ok(catalog && catalog.checkedAt > 0);
  assert.ok(
    Date.now() - catalog.checkedAt < 60_000,
    'checkedAt 必须是握手那一刻;清单会漂移,不能把旧结果标成刚刚取的',
  );
  assert.equal(spawns().length, afterDetect, `取清单不该再起进程(前 ${afterDetect} → 后 ${spawns().length})`);
});

test('第二个桥进程(同一台机器)命中共享缓存,一个进程都不起', async () => {
  resetCache();
  resetLog();
  await makeAdapter().detect();
  assert.equal(spawns().filter((s) => s.kind === 'shell').length, 1, '缓存是冷的,这一次该真探');

  const before = spawns().length;
  // 换一个 adapter 实例:模拟"宿主又开了一个会话/桥进程"的第二次预热
  const second = await makeAdapter().detect();
  assert.equal(second.available, true);
  assert.match(second.detail ?? '', /共享探测缓存/, '取自缓存必须在 detail 里说出来,不能冒充现场握手');
  assert.equal(spawns().length, before, '跨进程缓存命中时不该起任何 CLI 进程');

  // force 才允许再探一次(harness_models force=true 的语义)
  const third = await makeAdapter().detect(true);
  assert.equal(third.available, true);
  assert.equal(spawns().filter((s) => s.kind === 'shell').length, 2, 'force 必须真的重新握手');
});

test('plan() 在缓存命中时仍能拿到解析出的入口(不能因为没握手就拒绝派发)', async () => {
  resetCache();
  resetLog();
  const cold = makeAdapter();
  await cold.detect();
  const coldPlan = cold.plan({ cwd: process.cwd() });

  // 缓存里只有握手结果,入口路径是每个进程自己现解析的 —— 别让"命中缓存"变成"没探测过"
  const warm = makeAdapter();
  await warm.detect();
  const warmPlan = warm.plan({ cwd: process.cwd() });
  assert.deepEqual(warmPlan.args, coldPlan.args);
  assert.equal(warmPlan.needsStdin, true);
});

test('清理:用例造的假进程都别留在用户机器上', async () => {
  for (const s of spawns()) assert.equal(await waitAlive(s.pid), false, `${s.kind} ${s.pid} 残留`);
  rmSync(HOME, { recursive: true, force: true });
});
