/**
 * Regression tests (2026-10-16):
 *  - CLI discovery only knew the Windows npm layout (`<bin>/node_modules`): on macOS/Linux every
 *    npm-installed CLI and Claude Code's native installer were reported missing (only codex was found);
 *  - prompts went on argv: a prompt starting with "--- a/" (a diff) was rejected by claude/codex;
 *  - harness_events returned every event with full payloads (≈12.8 MB for a 1,500-event task);
 *  - no cancel primitive; machine-specific MCP configs (D:\LLMS_Bridge) instead of a generator.
 * The MCP-level test drives the real codex adapter against a fake `codex` script (no model).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { nodeScript, spec, stubAdapter, tempDir } from './helpers.mjs';

process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-dem-${process.pid}`);
const { resolveGlobalCli, which, cliOverride } = await import('../src/locate.ts');
const { argvPrompt } = await import('../src/argv.ts');
const { Scheduler } = await import('../src/scheduler.ts');
const { createClaudeAdapter } = await import('../src/adapters/claude.ts');
const { createCodexAdapter } = await import('../src/adapters/codex.ts');

const posix = process.platform !== 'win32';
const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------- discovery ----------------

test('POSIX npm 全局布局(<prefix>/bin → ../lib/node_modules/…)能被找到', { skip: posix ? false : 'POSIX layout' }, async () => {
  const prefix = await tempDir('llms-bridge-npmprefix-');
  const savedPath = process.env.PATH;
  try {
    const pkgBin = join(prefix, 'lib', 'node_modules', '@vendor', 'fake-cli', 'bin');
    await mkdir(pkgBin, { recursive: true });
    await mkdir(join(prefix, 'bin'));
    const entry = await nodeScript(pkgBin, 'cli.js', 'console.log("fake 1.0")');
    await symlink(entry, join(prefix, 'bin', 'fakecli'));
    process.env.PATH = `${join(prefix, 'bin')}:${savedPath}`;
    const r = await resolveGlobalCli('fakecli', '@vendor/fake-cli', 'fakecli');
    assert.ok(r, '修复前这里是 null');
    assert.equal(r.command, join(prefix, 'bin', 'fakecli'));
    assert.match(r.detail, /lib\/node_modules/);
  } finally {
    process.env.PATH = savedPath;
    await rm(prefix, { recursive: true, force: true });
  }
});

test('原生安装器的单文件二进制(无 package.json)也能找到;不可执行的文件跳过', { skip: posix ? false : 'POSIX layout' }, async () => {
  const dir = await tempDir('llms-bridge-native-');
  const savedPath = process.env.PATH;
  try {
    await nodeScript(dir, 'nativecli', 'console.log("native 2.0")');
    await writeFile(join(dir, 'notexec'), 'x');
    await chmod(join(dir, 'notexec'), 0o644);
    process.env.PATH = `${dir}:${savedPath}`;
    assert.equal((await resolveGlobalCli('nativecli', '@whatever/pkg'))?.command, join(dir, 'nativecli'));
    assert.equal(await which('notexec'), null);
  } finally {
    process.env.PATH = savedPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('显式覆盖:LLMS_BRIDGE_<ID>_CLI 与 config.json 的 cli.<id>;坏配置明确报错', async () => {
  const home = await tempDir('llms-bridge-ovr-');
  try {
    assert.deepEqual(cliOverride('claude', { LLMS_BRIDGE_CLAUDE_CLI: '/x/claude', LLMS_BRIDGE_HOME: home }), {
      path: '/x/claude',
      whence: 'env LLMS_BRIDGE_CLAUDE_CLI',
    });
    await writeFile(join(home, 'config.json'), JSON.stringify({ cli: { claude: '/y/claude' } }));
    assert.equal(cliOverride('claude', { LLMS_BRIDGE_HOME: home })?.path, '/y/claude');
    await writeFile(join(home, 'config.json'), '{ broken');
    assert.throws(() => cliOverride('claude', { LLMS_BRIDGE_HOME: home }), /解析失败/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------- prompt delivery ----------------

test('claude / codex 的 prompt 走 stdin,argv 里没有 prompt', async () => {
  const dir = await tempDir('llms-bridge-stdinplan-');
  const fake = await nodeScript(dir, 'fake.mjs', 'console.log("9.9.9")');
  const saved = { c: process.env.LLMS_BRIDGE_CLAUDE_CLI, x: process.env.LLMS_BRIDGE_CODEX_CLI };
  process.env.LLMS_BRIDGE_CLAUDE_CLI = fake;
  process.env.LLMS_BRIDGE_CODEX_CLI = fake;
  try {
    const prompt = '--- a/src/app.ts\n+++ b/src/app.ts\nReview.';
    for (const a of [createClaudeAdapter(), createCodexAdapter()]) {
      assert.equal((await a.detect()).available, true);
      const plan = a.plan({ taskId: 't', harness: a.id, prompt, cwd: dir, approval: 'read-only', budget: { maxWallMs: 1 }, session: { mode: 'fresh' } });
      assert.equal(plan.stdin, prompt, `${a.id}: prompt 应经 stdin`);
      assert.ok(!plan.args.includes(prompt), `${a.id}: argv 不应再含 prompt`);
    }
  } finally {
    for (const [k, v] of [['LLMS_BRIDGE_CLAUDE_CLI', saved.c], ['LLMS_BRIDGE_CODEX_CLI', saved.x]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('只能走 argv 的 CLI:"-" 开头的 prompt 前加换行;超长 prompt 当场拒绝并说明', () => {
  assert.equal(argvPrompt('x', '- bullet'), '\n- bullet');
  assert.equal(argvPrompt('x', 'normal'), 'normal');
  assert.throws(() => argvPrompt('x', 'y'.repeat(40_000), 'win32'), /command line/);
  assert.doesNotThrow(() => argvPrompt('x', 'y'.repeat(40_000), 'darwin'));
});

test('stdin 送达:worker 读到的 prompt 与原文逐字节一致(含 "-" 开头与中文)', async () => {
  const dir = await tempDir('llms-bridge-stdin-');
  try {
    const prompt = '--- a/论文.md\n+++ b/论文.md\n- 第一条\n' + 'x'.repeat(300_000);
    const s = new Scheduler([
      stubAdapter({
        plan: (sp) => ({
          command: process.execPath,
          args: ['-e', "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c).on('end',()=>console.log(require('crypto').createHash('sha256').update(d).digest('hex')))"],
          stdin: sp.prompt,
        }),
      }),
    ]);
    await s.dispatch(spec(dir, 'stdin', { prompt }));
    await s.collect('stdin');
    const expected = (await import('node:crypto')).createHash('sha256').update(prompt).digest('hex');
    assert.ok(s.events('stdin').some((e) => e.text === expected), '哈希应一致');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------- bounded events ----------------

test('harness_events 分页:默认 ≤50 条、约 64 KB;翻页能取全;raw 默认不带', async () => {
  const dir = await tempDir('llms-bridge-pages-');
  try {
    const worker = await nodeScript(dir, 'w.mjs', "const pad='y'.repeat(2000);for(let i=0;i<600;i++)console.log('line '+i+' '+pad)");
    const s = new Scheduler([stubAdapter({ plan: () => ({ command: process.execPath, args: [worker] }) })]);
    await s.dispatch(spec(dir, 'pages'));
    await s.collect('pages');
    const first = s.eventsPage('pages');
    assert.ok(first.returned <= 50);
    assert.ok(JSON.stringify(first.events).length <= 70_000);
    assert.equal(first.hasMore, true);
    assert.ok(first.events.every((e) => !('raw' in e)));
    let seen = first.returned;
    let next = first.nextSeq;
    while (next !== undefined) {
      const p = s.eventsPage('pages', { sinceSeq: next, limit: 500, maxBytes: 1_000_000 });
      seen += p.returned;
      next = p.nextSeq;
    }
    assert.equal(seen, s.eventsPage('pages').total);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('单个事件超过 max_bytes 时被截短而不是卡住翻页', async () => {
  const dir = await tempDir('llms-bridge-bigev-');
  try {
    const worker = await nodeScript(dir, 'w.mjs', "console.log('z'.repeat(200000))");
    const s = new Scheduler([stubAdapter({ plan: () => ({ command: process.execPath, args: [worker] }) })]);
    await s.dispatch(spec(dir, 'bigev'));
    await s.collect('bigev');
    const p = s.eventsPage('bigev', { maxBytes: 5_000 });
    assert.ok(p.returned >= 1);
    assert.ok(JSON.stringify(p.events).length < 12_000);
    assert.ok(p.events[0].text.length < 20_000, '内存里也已按 16 KB 截短');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('长会话:较早结束的任务把事件交还账本,内存只留最近的', async () => {
  const dir = await tempDir('llms-bridge-evict-');
  const { execFileSync } = await import('node:child_process');
  try {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { Scheduler } = await import(${JSON.stringify(join(PROJECT, 'src', 'scheduler.ts'))});
         const plan = () => ({ command: process.execPath, args: ['-e', 'console.log("hi")'] });
         const stub = { id: 'stub', tier: 3, displayName: 's', supportedApprovals: ['read-only'], detect: async () => ({ available: true }), plan,
           createRun: (sp, id) => ({ parseLine: (l) => [{ taskId: id, seq: 0, harness: 'stub', tier: 3, type: 'message', at: Date.now(), text: l }], finalize: () => ({ text: 'ok' }) }) };
         const s = new Scheduler([stub]);
         for (const id of ['a', 'b', 'c']) { await s.dispatch({ taskId: id, harness: 'stub', prompt: 'p', cwd: ${JSON.stringify(dir)}, approval: 'read-only', budget: { maxWallMs: 30000 }, session: { mode: 'fresh' } }); await s.collect(id); }
         const pa = s.eventsPage('a'); const pc = s.eventsPage('c');
         console.log(JSON.stringify({ aJournal: pa.fromJournal === true, aHasHi: pa.events.some((e) => e.text === 'hi'), cMemory: pc.fromJournal === undefined }));`,
      ],
      { env: { ...process.env, LLMS_BRIDGE_FINISHED_WITH_EVENTS: '1' }, encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { aJournal: true, aHasHi: true, cMemory: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------- MCP level, real codex adapter + fake codex ----------------

function startServer(env) {
  const child = spawn(process.execPath, [join(PROJECT, 'src', 'mcp-server.ts')], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  let seq = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    });
  const call = async (name, args) => {
    const res = await send('tools/call', { name, arguments: args });
    return { isError: res.result.isError, body: JSON.parse(res.result.content[0].text) };
  };
  return { child, send, call };
}

test('MCP:经真 codex 适配器(假 codex 二进制)派发 → stdin 送达、取消、分页、mcp-config', async () => {
  const dir = await tempDir('llms-bridge-mcp-');
  const home = await tempDir('llms-bridge-mcp-home-');
  try {
    // Fake codex: echoes the stdin prompt as an agent_message, then idles until killed.
    const fake = await nodeScript(
      dir,
      'fake-codex.mjs',
      [
        "if (process.argv.includes('--version')) { console.log('codex-cli 0.0.0-fake'); process.exit(0); }",
        "let d=''; process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', c => d += c).on('end', () => {",
        "  console.log(JSON.stringify({type:'thread.started',thread_id:'t1'}));",
        "  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'GOT:'+d.slice(0,20)}}));",
        "  if (d.includes('HANG')) setInterval(() => {}, 1000);",
        "  else console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:4,output_tokens:2}}));",
        '});',
      ].join('\n'),
    );
    const env = { ...process.env, LLMS_BRIDGE_HOME: home, LLMS_BRIDGE_CODEX_CLI: fake, CODEX_HOME: home };
    const s = startServer(env);
    try {
      await s.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
      const ok = await s.call('harness_dispatch', { harness: 'codex', prompt: '--- a/x\nreview', cwd: dir, approval: 'read-only', max_wall_ms: 30_000 });
      assert.equal(ok.isError, false, JSON.stringify(ok.body));
      let res;
      for (let i = 0; i < 100; i++) {
        res = await s.call('harness_result', { task_id: ok.body.task_id });
        if (res.body.finished !== false) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(res.body.status, 'ok', JSON.stringify(res.body));
      assert.equal(res.body.text, 'GOT:--- a/x\nreview', '以 "---" 开头的 prompt 经 stdin 原样送达');
      assert.deepEqual(res.body.usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 });

      const hang = await s.call('harness_dispatch', { harness: 'codex', prompt: 'HANG', cwd: dir, approval: 'read-only', max_wall_ms: 60_000, max_tokens: 1000 });
      assert.match(hang.body.max_tokens_enforcement, /post-run/);
      await new Promise((r) => setTimeout(r, 500));
      const c = await s.call('harness_cancel', { task_id: hang.body.task_id, reason: 'test cancel' });
      assert.equal(c.body.cancelled, true);
      for (let i = 0; i < 100; i++) {
        res = await s.call('harness_result', { task_id: hang.body.task_id });
        if (res.body.finished !== false) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(res.body.status, 'cancelled');

      const page = await s.call('harness_events', { task_id: ok.body.task_id, limit: 2 });
      assert.equal(page.body.returned, 2);
      assert.equal(page.body.has_more, true);
      assert.equal(typeof page.body.next_seq, 'number');

      const unknown = await s.call('harness_cancel', { task_id: 'nope' });
      assert.equal(unknown.isError, true);
    } finally {
      s.child.kill();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('mcp-config 生成本机绝对路径的注册命令(替代写死 D:\\LLMS_Bridge 的配置)', async () => {
  const out = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [join(PROJECT, 'src', 'cli.ts'), 'mcp-config', '--host', 'claude']);
    let o = '';
    c.stdout.on('data', (d) => (o += d));
    c.on('close', () => resolve(o));
    c.on('error', reject);
  });
  assert.match(out, /^claude mcp add --scope user llms-bridge -- /);
  assert.ok(out.includes(join(PROJECT, 'src', 'mcp-server.ts')));
  assert.ok(!out.includes('D:\\LLMS_Bridge'));
});
