/**
 * 层级① 的客户端侧文件面(`fs/read_text_file` / `fs/write_text_file`)必须真的受控。
 *
 * 为什么单独测:ACP 把文件读写放在**客户端**这一侧,桥不实现就物理上写不了文件;
 * 实现了就等于开了一道写盘的口子,所以"能不能写、写到哪、什么档位能写"必须逐条钉住。
 * 这里直接驱动 RunParser(不 spawn 任何进程),因此**零额度、零外部依赖**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter } from '../src/adapters/acp.ts';

function makeAdapter() {
  return createAcpAdapter({
    id: 'qwen',
    displayName: 'Qwen Code (ACP)',
    binName: 'qwen',
    pkgName: '@qwen-code/qwen-code',
  });
}

/** 起一个 parser,返回"喂一行 → 拿到我方发出的消息"。 */
async function drive(cwd, approval) {
  const spec = {
    taskId: 'task-1',
    harness: 'qwen',
    prompt: 'x',
    cwd,
    approval,
    budget: { maxWallMs: 60_000 },
    session: { mode: 'fresh' },
  };
  const run = makeAdapter().createRun(spec, spec.taskId);
  const sent = [];
  run.onStart((line) => sent.push(JSON.parse(line)));
  return { run, sent, lastReplyFor: (id) => sent.filter((m) => m.id === id).at(-1) };
}

const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('写档位:agent 请求 fs/write_text_file 应真的落在 cwd 内', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  try {
    const { run, lastReplyFor } = await drive(dir, 'workspace-write');
    const events = run.parseLine(
      JSON.stringify(req(50, 'fs/write_text_file', { path: 'gen.txt', content: 'hello\n' })),
    );
    assert.equal(await readFile(join(dir, 'gen.txt'), 'utf8'), 'hello\n', '文件应真的被写出来');
    assert.ok(lastReplyFor(50)?.result, '应回 result 而不是 error');
    assert.ok(
      events.some((e) => e.type === 'tool_call'),
      '写盘必须留下 tool_call 事件,否则主脑看不见改动',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('读档位:fs/read_text_file 应回内容并留 tool_result 事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  try {
    await writeFile(join(dir, 'seed.txt'), 'seed-body', 'utf8');
    const { run, lastReplyFor } = await drive(dir, 'read-only');
    const events = run.parseLine(JSON.stringify(req(51, 'fs/read_text_file', { path: 'seed.txt' })));
    assert.equal(lastReplyFor(51)?.result?.content, 'seed-body');
    assert.ok(events.some((e) => e.type === 'tool_result'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('read-only 档位必须拒绝写文件,且明确告知原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  try {
    const { run, lastReplyFor } = await drive(dir, 'read-only');
    const events = run.parseLine(
      JSON.stringify(req(52, 'fs/write_text_file', { path: 'nope.txt', content: 'x' })),
    );
    assert.equal(existsSync(join(dir, 'nope.txt')), false, 'read-only 下不得落盘');
    assert.match(lastReplyFor(52)?.error?.message ?? '', /read-only/);
    assert.ok(events.some((e) => e.type === 'error'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('越界路径必须被拒:`..` 与绝对路径都不得写到 cwd 外', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  const outside = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-out-'));
  try {
    const { run, lastReplyFor } = await drive(dir, 'workspace-write');
    for (const [id, bad] of [
      [60, '../escape.txt'],
      [61, join(outside, 'abs-escape.txt')],
      [62, 'sub/../../escape2.txt'],
    ]) {
      run.parseLine(JSON.stringify(req(id, 'fs/write_text_file', { path: bad, content: 'x' })));
      assert.match(
        lastReplyFor(id)?.error?.message ?? '',
        /越界|拒绝/,
        `${bad} 应当被拒`,
      );
    }
    assert.equal(existsSync(join(outside, 'abs-escape.txt')), false, '不得写到 cwd 外');
    assert.equal(existsSync(join(dir, '..', 'escape.txt')), false, '不得经 .. 逃出');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('terminal/* 必须拒绝:那会让 agent 绕过写档位直接执行命令', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  try {
    const { run, lastReplyFor } = await drive(dir, 'workspace-write');
    run.parseLine(JSON.stringify(req(70, 'terminal/create', { command: 'del' })));
    assert.equal(lastReplyFor(70)?.error?.code, -32601, 'terminal 方法应回 -32601');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('反向请求必须被应答,不能挂死等一个不会来的响应', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  try {
    const { run, sent } = await drive(dir, 'read-only');
    const before = sent.length;
    run.parseLine(JSON.stringify(req(80, 'some/unknown_method', {})));
    assert.ok(sent.length > before, '每个反向请求都要有一条应答');
    assert.equal(sent.at(-1).id, 80);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// —— 能力声明与权限协商 ——
// SDK 里 `zClientCapabilities.fs` 默认全 false,不声明 agent 就不会来调 fs/*,
// 于是"实现了处理器"等于没实现。这两条钉的是**能不能被用到**,不是写得对不对。

test('initialize 必须声明 fs 能力;writeTextFile 只在非 read-only 档位为 true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  try {
    const ro = await drive(dir, 'read-only');
    const initRo = ro.sent.find((m) => m.method === 'initialize');
    assert.ok(initRo, 'onStart 应立刻发出 initialize');
    assert.deepEqual(initRo.params.clientCapabilities.fs, {
      readTextFile: true,
      writeTextFile: false,
    });

    const ww = await drive(dir, 'workspace-write');
    const initWw = ww.sent.find((m) => m.method === 'initialize');
    assert.equal(initWw.params.clientCapabilities.fs.writeTextFile, true);
    assert.equal(initWw.params.clientCapabilities.terminal, false, 'terminal 能力必须显式不开');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const OPTIONS = [
  { optionId: 'o-allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'o-allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'o-reject-once', name: 'Reject once', kind: 'reject_once' },
];

test('写档位的权限请求:选 allow_once,永不选 allow_always(最小权限)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  try {
    const { run, lastReplyFor } = await drive(dir, 'workspace-write');
    run.parseLine(
      JSON.stringify(req(90, 'session/request_permission', { sessionId: 's', options: OPTIONS })),
    );
    const out = lastReplyFor(90)?.result?.outcome;
    assert.equal(out?.outcome, 'selected');
    assert.equal(out?.optionId, 'o-allow-once', '批掉整个会话的 allow_always 超出本次任务的 approval');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('read-only 档位的权限请求:必须选 reject_*', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  try {
    const { run, lastReplyFor } = await drive(dir, 'read-only');
    run.parseLine(
      JSON.stringify(req(91, 'session/request_permission', { sessionId: 's', options: OPTIONS })),
    );
    assert.equal(lastReplyFor(91)?.result?.outcome?.optionId, 'o-reject-once');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('optionId 只能来自对方给的集合;没有可用选项时回 cancelled 而不是编一个', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-acpfs-'));
  try {
    const { run, lastReplyFor } = await drive(dir, 'workspace-write');
    // 只给 reject:写档位找不到 allow_*,必须 cancelled
    run.parseLine(
      JSON.stringify(
        req(92, 'session/request_permission', {
          sessionId: 's',
          options: [{ optionId: 'only-reject', kind: 'reject_once' }],
        }),
      ),
    );
    assert.deepEqual(lastReplyFor(92)?.result?.outcome, { outcome: 'cancelled' });

    // 空 options 同样不能编 id
    run.parseLine(JSON.stringify(req(93, 'session/request_permission', { sessionId: 's', options: [] })));
    assert.deepEqual(lastReplyFor(93)?.result?.outcome, { outcome: 'cancelled' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
