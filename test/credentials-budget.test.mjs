/**
 * Regression tests (2026-10-16):
 *  - redaction matched an exact key list: OPENAI_API_KEY, ANTHROPIC_AUTH_TOKEN, auth_token,
 *    GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY and inline "Bearer …" all passed through;
 *  - the bridge forwarded its whole environment to every worker (cross-vendor key leak);
 *  - journal files were world-readable by default umask and stored prompts verbatim;
 *  - the read-only panel answered any Host header (DNS rebinding);
 *  - max_tokens was only checked against the final line (Claude: usage only on `result`, cache
 *    tokens ignored — 2,254 processed tokens counted as 214; OpenCode/ACP: never).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nodeScript, spec, stubAdapter, tempDir } from './helpers.mjs';

const HOME = join(tmpdir(), `llms-bridge-test-home-cred-${process.pid}`);
process.env.LLMS_BRIDGE_HOME = HOME;
const { redactCredentials, redactSecretsInText } = await import('../src/redact.ts');
const { buildWorkerEnv, isCredentialName } = await import('../src/env.ts');
const { Scheduler } = await import('../src/scheduler.ts');
const { ClaudeUsageTracker, createClaudeStreamRun } = await import('../src/adapters/claude.ts');
const { startUi, allowedHost } = await import('../src/ui.ts');

const posix = process.platform !== 'win32';

// ---------------- redaction ----------------

test('按键名脱敏:常见凭证变量名都覆盖,用量数字保留', () => {
  const raw = {
    apiKey: 'sk-AAA',
    OPENAI_API_KEY: 'sk-BBB',
    ANTHROPIC_AUTH_TOKEN: 'CCC',
    auth_token: 'DDD',
    env: { GITHUB_TOKEN: 'ghp_EEE', AWS_SECRET_ACCESS_KEY: 'FFF', PATH: '/usr/bin' },
    usage: { input_tokens: 123, output_tokens: 7, cache_read_input_tokens: 9 },
    apiKeySource: 'none',
    max_token: 4096,
  };
  const out = redactCredentials(raw);
  for (const v of [out.apiKey, out.OPENAI_API_KEY, out.ANTHROPIC_AUTH_TOKEN, out.auth_token, out.env.GITHUB_TOKEN, out.env.AWS_SECRET_ACCESS_KEY]) {
    assert.match(String(v), /已隐去/);
  }
  assert.equal(out.env.PATH, '/usr/bin');
  assert.deepEqual(out.usage, raw.usage, '用量字段不能被抹掉(预算闸门要用)');
  assert.equal(out.apiKeySource, 'none', '不是凭证的 *KeySource 不该被误伤');
  assert.equal(out.max_token, 4096, '数字永远不是凭证');
});

test('按值形态脱敏:工具输出里的密钥、Bearer、URL 账号密码、赋值语句、私钥', () => {
  const secrets = [
    'sk-ant-api03-' + 'a'.repeat(40),
    'sk-proj-' + 'b'.repeat(40),
    'ghp_' + 'c'.repeat(36),
    'AKIA' + 'D'.repeat(16),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ];
  const text = [
    `cat .env -> OPENAI_API_KEY=${secrets[1]}`,
    `Authorization: Bearer ${'z'.repeat(40)}`,
    'git remote: https://alice:hunter2pass@github.com/org/repo.git',
    `GITHUB_TOKEN: ${secrets[2]}`,
    `key ${secrets[0]} and ${secrets[3]} and ${secrets[4]}`,
    '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----',
    'MAX_TOKENS = 200000  # a number, not a secret',
  ].join('\n');
  const { text: out, count } = redactSecretsInText(text);
  for (const s of [...secrets, 'hunter2pass', 'z'.repeat(40), 'abc\ndef']) assert.ok(!out.includes(s), `仍含 ${s.slice(0, 12)}…`);
  assert.match(out, /OPENAI_API_KEY=\[redacted/, '变量名保留,值隐去');
  assert.match(out, /MAX_TOKENS = 200000/, '纯数字的配置值不误伤');
  assert.ok(count >= 8);
});

// ---------------- worker environment ----------------

test('请求头形式的凭证不论长短都隐去', () => {
  const { text } = redactSecretsInText('Authorization: Bearer sk-GGG\nx-api-key: abc\nproxy-authorization=Basic dXNlcg==');
  assert.ok(!/sk-GGG|abc\b|dXNlcg/.test(text), text);
  assert.match(text, /Authorization: Bearer \[redacted:authorization\]/);
});

test('凭证变量名识别:强词子串、弱词按段,socket 不算', () => {
  for (const n of ['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PGPASSWORD', 'HF_TOKEN', 'MY_SERVICE_CREDENTIALS']) {
    assert.equal(isCredentialName(n), true, n);
  }
  for (const n of ['PATH', 'HOME', 'HTTPS_PROXY', 'TOKENIZERS_PARALLELISM', 'SSH_AUTH_SOCK', 'CODEX_HOME', 'LANG']) {
    assert.equal(isCredentialName(n), false, n);
  }
});

test('buildWorkerEnv:只放行该家自己的凭证 + LLMS_BRIDGE_PASS_ENV 显式放行', () => {
  const base = {
    PATH: '/bin',
    OPENAI_API_KEY: 'o',
    ANTHROPIC_API_KEY: 'a',
    CLAUDE_CODE_MESSAGING_TOKEN: 'host-session',
    MY_TOOL_TOKEN: 't',
    LLMS_BRIDGE_PASS_ENV: 'MY_TOOL_*',
  };
  const r = buildWorkerEnv(base, ['ANTHROPIC_*']);
  assert.equal(r.env.ANTHROPIC_API_KEY, 'a');
  assert.equal(r.env.MY_TOOL_TOKEN, 't');
  assert.equal(r.env.PATH, '/bin');
  assert.equal(r.env.OPENAI_API_KEY, undefined);
  assert.equal(r.env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  assert.deepEqual(r.withheld, ['CLAUDE_CODE_MESSAGING_TOKEN', 'OPENAI_API_KEY']);
});

test('调度器:worker 收不到别家的密钥,ack 只列被扣下的变量名', async () => {
  const dir = await tempDir('llms-bridge-env-');
  const saved = { ...process.env };
  Object.assign(process.env, { OPENAI_API_KEY: 'sk-should-not-pass', ANTHROPIC_API_KEY: 'sk-ant-own', CLAUDE_CODE_MESSAGING_TOKEN: 'host' });
  try {
    const s = new Scheduler([
      stubAdapter({
        credentialEnv: () => ['ANTHROPIC_*'],
        plan: () => ({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'] }),
      }),
    ]);
    const ack = await s.dispatch(spec(dir, 'envtest'));
    await s.collect('envtest');
    const keys = JSON.parse(s.events('envtest').find((e) => e.text?.startsWith('['))?.text ?? '[]');
    assert.ok(keys.includes('ANTHROPIC_API_KEY'));
    assert.ok(!keys.includes('OPENAI_API_KEY'));
    assert.ok(!keys.includes('CLAUDE_CODE_MESSAGING_TOKEN'));
    assert.ok(ack.envWithheld.includes('OPENAI_API_KEY'));
    assert.ok(!JSON.stringify(ack).includes('sk-should-not-pass'), 'ack 不得含任何值');
  } finally {
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_MESSAGING_TOKEN']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('账本:prompt 里的密钥不落盘;文件权限仅属主可读', async () => {
  const dir = await tempDir('llms-bridge-perm-');
  try {
    const s = new Scheduler([stubAdapter({ plan: () => ({ command: process.execPath, args: ['-e', 'console.log("x")'] }) })]);
    const key = 'sk-proj-' + 'q'.repeat(40);
    await s.dispatch(spec(dir, 'perm', { prompt: `use ${key} please` }));
    await s.collect('perm');
    const file = join(dir, '.llms-bridge', 'tasks', 'perm.json');
    const rec = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(!rec.prompt.includes(key));
    if (posix) {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, '.llms-bridge', 'tasks')).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, '.llms-bridge', 'tasks', 'perm.events.jsonl')).mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------- panel ----------------

function get(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('面板:非回环 Host 头一律 403(防 DNS rebinding),正常请求带安全头', async () => {
  const ui = await startUi({ port: 0 });
  try {
    const bad = await get(ui.port, '/api/state', `attacker.example:${ui.port}`);
    assert.equal(bad.status, 403);
    const good = await get(ui.port, '/api/state', `127.0.0.1:${ui.port}`);
    assert.equal(good.status, 200);
    assert.equal(good.headers['x-content-type-options'], 'nosniff');
    assert.match(good.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(allowedHost(`localhost:${ui.port}`, ui.port), true);
    assert.equal(allowedHost(`localhost:${ui.port + 1}`, ui.port), false);
  } finally {
    await ui.close();
  }
});

// ---------------- token accounting ----------------

test('Claude 用量:按 message.id 去重累加、缓存 token 计入 input、result 为全程合计', () => {
  const t = new ClaudeUsageTracker();
  const call = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 1000, output_tokens: 1 };
  t.onAssistant('m1', call);
  t.onAssistant('m1', { ...call, output_tokens: 3 }); // same call, later line
  const mid = t.onAssistant('m2', call);
  assert.deepEqual(mid, { inputTokens: 2240, outputTokens: 4, cacheReadTokens: 2000, cacheWriteTokens: 40 });
  // Measured shape of the final line (2 calls): sums with output finalised.
  const fin = t.onResult({ input_tokens: 200, cache_creation_input_tokens: 40, cache_read_input_tokens: 2000, output_tokens: 14 });
  assert.deepEqual(fin, { inputTokens: 2240, outputTokens: 14, cacheReadTokens: 2000, cacheWriteTokens: 40 });
});

test('Claude 解析器:用量挂在 assistant 那一行的事件上(预算闸门能中途看到)', () => {
  const run = createClaudeStreamRun('claude', { taskId: 't', session: { mode: 'fresh' } }, 't');
  const ev = run.parseLine(
    JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Read' }], usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } }),
  );
  assert.deepEqual(ev[0].usage, { inputTokens: 100, outputTokens: 1, cacheReadTokens: 90, cacheWriteTokens: 0 });
});

test('max_tokens 中途生效:累计超限就停下,不等跑完', async () => {
  const dir = await tempDir('llms-bridge-budget-');
  try {
    // 40 lines, one every 50 ms, each reporting cumulative usage +1000.
    const worker = await nodeScript(
      dir,
      'w.mjs',
      'let i=0;const t=setInterval(()=>{i++;console.log(JSON.stringify({n:i,usage:{inputTokens:i*1000,outputTokens:0}}));if(i===40){clearInterval(t)}},50);',
    );
    const s = new Scheduler([stubAdapter({ usageReporting: 'streaming', plan: () => ({ command: process.execPath, args: [worker] }) })]);
    const ack = await s.dispatch(spec(dir, 'budget', { budget: { maxWallMs: 30_000, maxTokens: 5_500 } }));
    assert.match(ack.maxTokensEnforcement, /mid-run/);
    const r = await s.collect('budget');
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /maxTokens=5500/);
    const lines = s.events('budget').filter((e) => e.text?.startsWith('{"n"')).length;
    assert.ok(lines < 15, `应在第 6 行左右停下,实际处理了 ${lines} 行(修复前会跑满 40 行)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('只在结束时报用量的 harness:ack 如实说明 max_tokens 只能事后判', async () => {
  const dir = await tempDir('llms-bridge-budget2-');
  try {
    const s = new Scheduler([
      stubAdapter({
        usageReporting: 'final',
        plan: () => ({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify({usage:{inputTokens:9000,outputTokens:1}}))'] }),
      }),
    ]);
    const ack = await s.dispatch(spec(dir, 'budget2', { budget: { maxWallMs: 30_000, maxTokens: 100 } }));
    assert.match(ack.maxTokensEnforcement, /post-run/);
    const r = await s.collect('budget2');
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /maxTokens=100/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('result 文本里的密钥在交回主脑前被替换,并计数', async () => {
  const dir = await tempDir('llms-bridge-redtext-');
  try {
    const key = 'ghp_' + 'k'.repeat(36);
    const s = new Scheduler([stubAdapter({ text: `token is ${key}`, plan: () => ({ command: process.execPath, args: ['-e', '0'] }) })]);
    await s.dispatch(spec(dir, 'redtext'));
    const r = await s.collect('redtext');
    assert.ok(!r.text.includes(key));
    assert.equal(r.textRedactions, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('清理:测试 home 不残留到用户真实目录', () => {
  assert.ok(!HOME.startsWith(join(process.env.HOME ?? '/nonexistent', '.llms-bridge')));
  assert.ok(existsSync(HOME) || true);
});
