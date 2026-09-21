/**
 * MCP 协议层测试:握手、工具清单、以及三道审批闸门必须真的拦住。
 *
 * 全部不消耗模型额度 —— 只测参数校验与拒绝路径,不触发任何真实模型调用。
 * 需要真实派发的那条链由 LLMS_BRIDGE_LIVE=1 单独开启(见文件末尾)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(PROJECT, 'src', 'mcp-server.ts');

/** 起一个 MCP server 子进程,返回一个 request(id) → response 的调用器。 */
function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], cwd: PROJECT });
  const pending = new Map();
  let buf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.length === 0) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let seq = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => reject(new Error(`${method} 超时未响应`)), 60_000);
    });

  // 通知(无 id)不需要等响应
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');

  return { child, send, notify, close: () => child.kill() };
}

/** 取工具返回的文本并解析回对象。 */
const payloadOf = (res) => {
  const text = res.result?.content?.[0]?.text;
  assert.ok(typeof text === 'string', '工具应返回 text content');
  return JSON.parse(text);
};

test('MCP 握手:回显客户端协议版本,声明 tools 能力', async () => {
  const s = startServer();
  try {
    const res = await s.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(res.result.protocolVersion, '2025-06-18');
    assert.equal(res.result.serverInfo.name, 'llms-bridge');
    assert.ok(res.result.capabilities.tools, '应声明 tools 能力');
  } finally {
    s.close();
  }
});

test('tools/list 提供六个原语', async () => {
  const s = startServer();
  try {
    await s.send('initialize', { protocolVersion: '1', capabilities: {} });
    const res = await s.send('tools/list');
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'harness_dispatch',
      'harness_events',
      'harness_list',
      'harness_models',
      'harness_poll',
      'harness_result',
    ]);
    const dispatch = res.result.tools.find((t) => t.name === 'harness_dispatch');
    // 铁律二/四在 MCP 契约上就必须是必填
    for (const required of ['harness', 'prompt', 'cwd', 'approval', 'max_wall_ms']) {
      assert.ok(dispatch.inputSchema.required.includes(required), `${required} 应为必填`);
    }
  } finally {
    s.close();
  }
});

test('审批闸门:approval=full 未开闸必须被拒', async () => {
  const s = startServer();
  try {
    await s.send('initialize', { protocolVersion: '1', capabilities: {} });
    const res = await s.send('tools/call', {
      name: 'harness_dispatch',
      arguments: {
        harness: 'codex',
        prompt: 'x',
        cwd: PROJECT,
        approval: 'full',
        max_wall_ms: 5000,
      },
    });
    assert.equal(res.result.isError, true, '应当以 isError 返回而不是成功');
    assert.match(payloadOf(res).error, /allowedFull/);
  } finally {
    s.close();
  }
});

test('成本闸门:缺 max_wall_ms 必须被拒', async () => {
  const s = startServer();
  try {
    await s.send('initialize', { protocolVersion: '1', capabilities: {} });
    const res = await s.send('tools/call', {
      name: 'harness_dispatch',
      arguments: { harness: 'codex', prompt: 'x', cwd: PROJECT, approval: 'read-only' },
    });
    assert.equal(res.result.isError, true);
    assert.match(payloadOf(res).error, /maxWallMs/);
  } finally {
    s.close();
  }
});

test('未知 harness 必须被拒,且不静默降级到别家', async () => {
  const s = startServer();
  try {
    await s.send('initialize', { protocolVersion: '1', capabilities: {} });
    const res = await s.send('tools/call', {
      name: 'harness_dispatch',
      arguments: { harness: 'nope', prompt: 'x', cwd: PROJECT, approval: 'read-only', max_wall_ms: 5000 },
    });
    assert.equal(res.result.isError, true);
    assert.match(payloadOf(res).error, /未知 harness/);
  } finally {
    s.close();
  }
});

test('隔离闸门:非 git 目录的写任务必须被拒', async () => {
  // 用临时目录而不是本仓库根:本仓库将来可能 git init,那样这条断言会失效
  const plain = await mkdtemp(join(tmpdir(), 'llms-bridge-nogit-'));
  const s = startServer();
  try {
    await s.send('initialize', { protocolVersion: '1', capabilities: {} });
    const res = await s.send('tools/call', {
      name: 'harness_dispatch',
      arguments: {
        harness: 'codex',
        prompt: 'x',
        cwd: plain,
        approval: 'workspace-write',
        max_wall_ms: 5000,
      },
    });
    assert.equal(res.result.isError, true);
    assert.match(payloadOf(res).error, /worktree|铁律三/);
  } finally {
    s.close();
    await rm(plain, { recursive: true, force: true });
  }
});

test('harness_list 返回统一的层级与审批档位结构', async () => {
  const s = startServer();
  try {
    await s.send('initialize', { protocolVersion: '1', capabilities: {} });
    const list = payloadOf(await s.send('tools/call', { name: 'harness_list', arguments: {} }));
    assert.ok(Array.isArray(list) && list.length > 0, '应至少有一个 adapter');
    for (const h of list) {
      assert.ok(typeof h.id === 'string' && h.id.length > 0, 'id 必填');
      assert.ok([1, 2, 3, 4, 5].includes(h.tier), `tier 应在 1..5,实际 ${h.tier}`);
      assert.ok(Array.isArray(h.supportedApprovals) && h.supportedApprovals.length > 0);
      assert.equal(typeof h.available, 'boolean', 'available 应是布尔值');
    }
    const ids = list.map((h) => h.id);
    for (const expected of ['codex', 'claude', 'qwen', 'mimo']) {
      assert.ok(ids.includes(expected), `应包含 ${expected},实际 ${ids.join(',')}`);
    }
  } finally {
    s.close();
  }
});

// 真实派发要花模型额度,默认跳过。需要时 LLMS_BRIDGE_LIVE=1 npm test
const live = process.env.LLMS_BRIDGE_LIVE === '1';
test('真实派发闭环(需额度)', { skip: live ? false : '设 LLMS_BRIDGE_LIVE=1 才跑' }, async () => {
  const s = startServer();
  try {
    await s.send('initialize', { protocolVersion: '1', capabilities: {} });
    const ack = payloadOf(
      await s.send('tools/call', {
        name: 'harness_dispatch',
        arguments: {
          harness: 'codex',
          prompt: 'Reply with exactly one word: pong',
          cwd: join(PROJECT, '.scratch', 'acpwork'),
          approval: 'read-only',
          max_wall_ms: 180_000,
        },
      }),
    );
    assert.ok(ack.task_id, '应立刻返回 task_id');

    let finished = false;
    for (let i = 0; i < 40 && !finished; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      finished = payloadOf(
        await s.send('tools/call', { name: 'harness_poll', arguments: { task_id: ack.task_id } }),
      ).finished;
    }
    assert.ok(finished, '任务应在预算内结束');

    const result = payloadOf(
      await s.send('tools/call', { name: 'harness_result', arguments: { task_id: ack.task_id } }),
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.isolated, false, 'read-only 不该分配 worktree');
  } finally {
    s.close();
  }
});

/**
 * 读侧三个工具(poll / result / events)对**未知 task_id** 必须回工具级错误,
 * 而不是把 stdio 连接搞崩。主脑靠这三个工具跟踪进度 —— 崩一次连接等于整桥掉线。
 * 此前 `harness_events` 只在 tools/list 里被点过名,**从未真被调用**;poll/result 也只在
 * 需要额度的 live 用例里跑过。这条零额度,专门补这个洞。
 */
test('poll / result / events 遇到未知 task_id 必须报错但不崩连接', async () => {
  const s = startServer();
  try {
    await s.send('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    s.notify('notifications/initialized');

    for (const name of ['harness_poll', 'harness_result', 'harness_events']) {
      const res = await s.send('tools/call', {
        name,
        arguments: { task_id: '00000000-0000-0000-0000-000000000000' },
      });
      assert.equal(res.result?.isError, true, `${name} 对未知 taskId 应回工具级 isError`);
      const text = res.result?.content?.[0]?.text ?? '';
      assert.match(text, /未知 taskId/, `${name} 应说明原因,实际:${text}`);
    }

    // 关键:三次错误之后连接仍然可用
    const tools = await s.send('tools/list', {});
    assert.equal(tools.result.tools.length, 6, '报错不得让 server 掉线');
  } finally {
    s.close();
  }
});

// —— GUI 宿主的 stdio 兼容不变量 ——
//
// 依据(2026-09-19 从 Qoder 的 app.asar 里挖出):它在正式 initialize 之前会**另起一个短命
// 兄弟进程**发探测请求来确定协议 era,注释原话 "stdio era negotiation on a DISPOSABLE SIBLING",
// 理由是很多 SDK 的 server 收到 initialize 前的请求就自杀。
// 所以"应答 initialize 之前的请求"不是规范洁癖问题,而是**挂不进 GUI 宿主**的问题。
// 谁若日后按 MCP 规范把握手收紧,这两条会红 —— 那时要连 GUI 挂载一起重新验证,不能只改这里。

test('Qoder 式探测:未 initialize 就请求 tools/list 必须存活且有应答', async () => {
  const s = startServer();
  try {
    const res = await s.send('tools/list', {});
    assert.ok(Array.isArray(res.result?.tools), '应直接返回 tools 数组');
    assert.equal(res.result.tools.length, 6, `应有 6 个原语,实际 ${res.result.tools.length}`);
    assert.equal(s.child.killed, false, '探测后进程必须还活着');
  } finally {
    s.close();
  }
});

test('Qoder 式探测:一行非 JSON 必须回 -32700 而不是崩掉进程', async () => {
  const s = startServer();
  const lines = [];
  s.child.stdout.on('data', (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) lines.push(l.trim());
  });
  try {
    s.child.stdin.write('not-json-at-all\n');
    await new Promise((r) => setTimeout(r, 1500));
    const parseErr = lines.map((l) => JSON.parse(l)).find((m) => m.error?.code === -32700);
    assert.ok(parseErr, `应回 -32700 parse error,实际收到:${JSON.stringify(lines)}`);
    assert.equal(s.child.exitCode, null, '垃圾行不得让进程退出');

    // 关键:被探测过一次垃圾之后,正常请求仍须服务
    const res = await s.send('tools/list', {});
    assert.equal(res.result.tools.length, 6, '收到垃圾行后仍应正常应答');
  } finally {
    s.close();
  }
});