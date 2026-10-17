/**
 * Opt-in (LLMS_BRIDGE_REAL_CLI=1, `npm run test:real-cli`): the **real** Claude Code CLI driven
 * through the bridge's claude adapter, against a local mock of the Messages API. No model is
 * called and nothing leaves the machine: the base URL is 127.0.0.1, auth is a dummy key, the
 * config dir is a fresh temp dir and non-essential traffic is disabled.
 *
 * What it pins down (measured 2026-10-16 with Claude Code 2.1.302):
 *  - the prompt is delivered through stdin intact, including a leading "--- a/" diff header;
 *  - usage accounting over two API calls (tool use + answer) equals the mock's numbers, cache included;
 *  - a local-only policy allows the worker when its endpoint is 127.0.0.1, and refuses before
 *    spawning anything when project settings point elsewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeRepo, tempDir } from './helpers.mjs';

const enabled = process.env.LLMS_BRIDGE_REAL_CLI === '1';
process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-real-${process.pid}`);

const MOCK = `
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const [LOG, PORTFILE, READFILE] = process.argv.slice(2);
let n = 0;
const sse = (res, ev, data) => res.write('event: ' + ev + '\\ndata: ' + JSON.stringify(data) + '\\n\\n');
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    const msgs = Array.isArray(j.messages) ? j.messages : [];
    const texts = msgs.flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text)));
    const hasToolResult = msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    appendFileSync(LOG, JSON.stringify({ path: req.url, texts }) + '\\n');
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end('{}'); }
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":10}'); }
    const wantTool = !hasToolResult && texts.join(' ').includes('USE_READ_TOOL');
    const usage = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 1000, output_tokens: 1 };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, 'message_start', { type: 'message_start', message: { id: 'msg_' + (++n), type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, usage } });
    if (wantTool) {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: READFILE }) } });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: wantTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
}).listen(0, '127.0.0.1', function () { writeFileSync(PORTFILE, String(this.address().port)); });
`;

async function startMock(dir, readFile) {
  const file = join(dir, 'mock.mjs');
  await writeFile(file, MOCK);
  const log = join(dir, 'mock-log.jsonl');
  const portFile = join(dir, 'port');
  const child = spawn(process.execPath, [file, log, portFile, readFile], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
  const port = Number(await readFile_(portFile));
  return { child, port, log };
}
const readFile_ = (p) => readFile(p, 'utf8');

test('真 claude CLI + 本地 mock API:stdin 送达、用量累计、本机端点过 local-only 策略', { skip: enabled ? false : 'set LLMS_BRIDGE_REAL_CLI=1' }, async () => {
  const repo = await makeRepo({ 'notes.txt': 'hello\n' });
  const cfg = await tempDir('llms-bridge-claude-cfg-');
  await mkdir(join(repo, '.llms-bridge'), { recursive: true });
  await writeFile(join(repo, '.llms-bridge', 'policy.json'), JSON.stringify({ cloud: { allowHarnesses: [] } }));
  const mock = await startMock(cfg, join(repo, 'notes.txt'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
    ANTHROPIC_API_KEY: 'dummy-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
  });
  try {
    const { Scheduler } = await import('../src/scheduler.ts');
    const { createClaudeAdapter } = await import('../src/adapters/claude.ts');
    const s = new Scheduler([createClaudeAdapter()]);
    const report = await s.detectAll();
    assert.equal(report[0].available, true, report[0].detail);

    const prompt = '--- a/src/app.ts\n+++ b/src/app.ts\nUSE_READ_TOOL then answer.';
    const ack = await s.dispatch({
      taskId: 'real-claude-1',
      harness: 'claude',
      prompt,
      cwd: repo,
      approval: 'read-only',
      budget: { maxWallMs: 120_000 },
      session: { mode: 'fresh' },
    });
    assert.equal(ack.egress.endpointHost, `127.0.0.1:${mock.port}`);
    const r = await s.collect('real-claude-1');
    assert.equal(r.status, 'ok', r.reason);
    assert.equal(r.text, 'PONG');
    // Two API calls of 100 input + 20 cache write + 1000 cache read + 7 output each.
    assert.deepEqual(r.usage, { inputTokens: 2240, outputTokens: 14, cacheReadTokens: 2000, cacheWriteTokens: 40 });
    const calls = (await readFile(mock.log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.some((c) => c.texts.some((t) => t.includes(prompt))), 'the prompt reached the API intact');

    // Project settings pointing at a remote relay: refused before anything is spawned.
    await mkdir(join(repo, '.claude'), { recursive: true });
    await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example.invalid' } }));
    const before = calls.length;
    await assert.rejects(
      () => s.dispatch({ taskId: 'real-claude-2', harness: 'claude', prompt: 'x', cwd: repo, approval: 'read-only', budget: { maxWallMs: 60_000 }, session: { mode: 'fresh' } }),
      /relay\.example\.invalid/,
    );
    const after = (await readFile(mock.log, 'utf8')).trim().split('\n').length;
    assert.equal(after, before, 'no request was made for the refused dispatch');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    mock.child.kill();
    await rm(repo, { recursive: true, force: true });
    await rm(cfg, { recursive: true, force: true });
  }
});
