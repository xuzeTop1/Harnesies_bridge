/**
 * ACP 握手结果的跨进程缓存(修 2026-10-30 的进程风暴)。
 *
 * 要守住的不是"缓存命中率",而是那条实测出来的因果:宿主每开一个会话就新建一个桥进程,
 * 每个实例的启动预热都把层级① 那几家各握手最多两遍(单次 100–400 MB)。
 * 所以这里全部用假 run(不起任何 CLI),零额度、零外部依赖。
 * 注意:本文件是 .mjs(纯 JS),不能出现 TS 语法。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 缓存落在 LLMS_BRIDGE_HOME 下(与账本同源);指到临时目录就不碰用户真实家目录。
const HOME = mkdtempSync(join(tmpdir(), 'llms-bridge-probe-test-'));
process.env.LLMS_BRIDGE_HOME = HOME;
// 等对端的默认上限是 45s(要盖住一次 8s+25s 握手);测试里等不到就该快点失败。
process.env.LLMS_BRIDGE_PROBE_WAIT_MS = '3000';

const { probeKey, probeShared } = await import(pathToFileURL(join(PROJECT, 'src', 'probe-cache.ts')).href);

const OK = { protocolVersion: 1, authMethodCount: 2, agentName: 'Fake', agentVersion: '9.9' };

function freshKey(name) {
  return probeKey(name, 'fake-cli.exe', ['--acp', String(Math.random())]);
}

/** 直接改缓存文件,用来伪造"另一个进程留下的结果/锁"。 */
function cacheDir() {
  return join(HOME, 'acp-probes');
}
function entryPath(key) {
  return join(cacheDir(), `${key}.json`);
}
function claimPath(key) {
  return join(cacheDir(), `${key}.claim`);
}
function writeEntry(key, probe, at) {
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(entryPath(key), JSON.stringify({ probe, at }));
}
function writeClaim(key, at) {
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(claimPath(key), JSON.stringify({ pid: 424242, at }));
}

test('同一家第二次探测不再起进程,且要说清结果是缓存来的', async () => {
  const key = freshKey('qwen');
  let runs = 0;
  const first = await probeShared(key, async () => {
    runs++;
    return OK;
  });
  const second = await probeShared(key, async () => {
    runs++;
    return { ...OK, agentVersion: '不该被取到' };
  });

  assert.equal(runs, 1, '两次 detect 只该起一次握手进程');
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true, '取自缓存时必须标出来,调用方要在 detail 里说明');
  assert.equal(second.probe?.agentVersion, '9.9');
  assert.equal(second.checkedAt, first.checkedAt, 'checkedAt 必须是握手那一刻,不能刷新成"刚刚"');
});

test('force=true 才允许忽略缓存(harness_models force 的语义不能丢)', async () => {
  const key = freshKey('mimo');
  await probeShared(key, async () => OK);

  let forced = 0;
  const reran = await probeShared(
    key,
    async () => {
      forced++;
      return { ...OK, agentVersion: '10.0' };
    },
    true,
  );
  assert.equal(forced, 1, 'force 必须真的重探一次');
  assert.equal(reran.probe?.agentVersion, '10.0');
  assert.equal(reran.fromCache, false);

  // 刷新后的缓存也要被后来的实例继承
  const after = await probeShared(key, async () => ({ ...OK, agentVersion: '11.0' }));
  assert.equal(after.probe?.agentVersion, '10.0');
});

test('同进程并发探测同一家只跑一次(否则会自己跟自己抢锁)', async () => {
  const key = freshKey('openclaw');
  let runs = 0;
  const slow = () =>
    probeShared(key, async () => {
      runs++;
      await new Promise((s) => setTimeout(s, 400));
      return OK;
    });
  const out = await Promise.all([slow(), slow(), slow()]);
  assert.equal(runs, 1, `三个并发请求该合成一次握手,实际跑了 ${runs} 次`);
  assert.deepEqual(
    out.map((o) => o.probe?.protocolVersion),
    [1, 1, 1],
  );
});

test('另一个进程正在探同一家:等它的结果,而不是各探各的', async () => {
  const key = freshKey('wait-peer');
  writeClaim(key, Date.now());
  let runs = 0;
  const waiter = probeShared(key, async () => {
    runs++;
    return { ...OK, agentVersion: '我的' };
  });
  // 模拟持有锁的那个进程在 600ms 后写出结果
  setTimeout(() => writeEntry(key, { ...OK, agentVersion: '对端的' }, Date.now()), 600);

  const got = await waiter;
  assert.equal(runs, 0, '对方正在探,本进程不该再起一个 CLI 进程 —— 这正是风暴的成因');
  assert.equal(got.probe?.agentVersion, '对端的');
  assert.equal(got.fromCache, true);
});

test('锁主僵死(进程被强杀)时锁要被抢走,不能永远走慢路径', async () => {
  const key = freshKey('stale-claim');
  writeClaim(key, Date.now() - 10 * 60_000); // 远超 CLAIM_STALE_MS
  let runs = 0;
  const got = await probeShared(key, async () => {
    runs++;
    return OK;
  });
  assert.equal(runs, 1, '过期锁必须能抢下来自己探');
  assert.equal(got.fromCache, false);
  // 抢下来之后要正常释放并写下结果,下一个进程直接命中
  const again = await probeShared(key, async () => null);
  assert.equal(again.probe?.agentVersion, '9.9');
});

test('等不到对端就自己探:宁可重复一次握手,也不把调用方挂在别人的锁上', async () => {
  const key = freshKey('dead-peer');
  writeClaim(key, Date.now()); // 锁一直有人,但永远不写结果
  let runs = 0;
  const got = await probeShared(key, async () => {
    runs++;
    return OK;
  });
  assert.equal(runs, 1, `等超时要 fallback 自己探(等了 ${Math.round((Date.now() - got.checkedAt) / 1000)}s)`);
  assert.equal(got.fromCache, false);
});

test('未判定(两次都没响应)只缓存很短时间,重跑 harness_list 仍然有意义', async () => {
  process.env.LLMS_BRIDGE_PROBE_MISS_TTL_MS = '0';
  const key = freshKey('miss-ttl');
  let runs = 0;
  const run = () =>
    probeShared(key, async () => {
      runs++;
      return null;
    });
  await run();
  await run();
  assert.equal(runs, 2, 'MISS_TTL=0 时"未判定"不该被复用');
  delete process.env.LLMS_BRIDGE_PROBE_MISS_TTL_MS;

  // 而在 TTL 内它是共享的:16 个实例同时启动时,不通的那几家也只能各探一次
  const shared = await run();
  assert.equal(shared.probe, null);
  assert.equal(shared.fromCache, true, '未判定也该共享,否则风暴照旧');
});

test('坏掉的缓存文件按"没有缓存"处理,绝不把它读成 available', async () => {
  const key = freshKey('corrupt');
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(entryPath(key), '{"at":' + Date.now() + '}'); // 缺 probe 字段
  let runs = 0;
  const got = await probeShared(key, async () => {
    runs++;
    return OK;
  });
  assert.equal(runs, 1);
  assert.equal(got.probe?.protocolVersion, 1);

  // 半截 JSON(改名写入不会产出这个,但手改/磁盘错误会)
  const key2 = freshKey('corrupt2');
  writeFileSync(entryPath(key2), '{"probe":{"protocolVersion":1,"at":');
  const got2 = await probeShared(key2, async () => ({ ...OK, agentName: 'Reprobed' }));
  assert.equal(got2.probe?.agentName, 'Reprobed');
});

test('没有 protocolVersion 的对象不许冒充一次成功握手', async () => {
  const key = freshKey('shape');
  writeEntry(key, { authMethodCount: 3 }, Date.now());
  let runs = 0;
  const got = await probeShared(key, async () => {
    runs++;
    return OK;
  });
  assert.equal(runs, 1, '形状不对的条目等同于没有');
  assert.equal(got.probe?.protocolVersion, 1);
});

test('键要随解析出的入口变:换了 CLI 就不该继承上一家的结论', async () => {
  const a = probeKey('qwen', 'node.exe', ['/old/qwen.js', '--acp']);
  const b = probeKey('qwen', 'node.exe', ['/new/qwen.js', '--acp']);
  assert.notEqual(a, b);
  assert.match(a, /^qwen-/, '键里要带 adapter id,否则三家的缓存会互相踩');
});

/**
 * 真起两个子进程(同一个 key、同一份缓存目录):同一家 CLI 全机只该被握手一次。
 * 这是那条 bug 的直接复现形状 —— 宿主并发拉 N 个桥进程。
 */
test('跨进程:四个实例同时启动,同一家只探一次', async () => {
  const key = freshKey('cross-proc');
  const child = `
    const { probeShared } = await import(${JSON.stringify(pathToFileURL(join(PROJECT, 'src', 'probe-cache.ts')).href)});
    const got = await probeShared(${JSON.stringify(key)}, async () => {
      const fs = await import('node:fs');
      fs.appendFileSync(${JSON.stringify(join(HOME, 'runs.log'))}, String(process.pid) + '\\n');
      await new Promise((s) => setTimeout(s, 700));
      return { protocolVersion: 1, authMethodCount: 1, agentName: 'Child' };
    });
    console.log(JSON.stringify({ pid: process.pid, fromCache: got.fromCache, name: got.probe?.agentName }));
  `;
  const scriptPath = join(HOME, 'child.mjs');
  writeFileSync(scriptPath, child);

  const lines = await Promise.all(
    Array.from({ length: 4 }, () =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [scriptPath], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (c) => (out += c));
        p.stderr.setEncoding('utf8');
        p.stderr.on('data', (c) => (err += c));
        p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err}`))));
      }),
    ),
  );

  const parsed = lines.map((l) => JSON.parse(l));
  const real = readFileSync(join(HOME, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(real.length, 1, `四次并发只该真探一次,实际起了 ${real.length} 次:${real.join(', ')}`);
  assert.equal(parsed.filter((x) => x.fromCache).length, 3, '其余三个实例都该是对端的缓存结果');
  for (const x of parsed) assert.equal(x.name, 'Child', '四个实例必须拿到同一份握手结果');
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});
