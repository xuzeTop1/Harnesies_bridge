/**
 * 适配器注册表测试:五级模型的结构契约 + 探测行为。
 *
 * 会跑一次真实的 detect(层级① 含 ACP 握手,每家约数秒),但不派发任何任务,不消耗模型额度。
 * 注意:本文件是 .mjs(纯 JS),不能出现 TS 语法(类型标注 / import type / 非空断言 !)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from '../src/registry.ts';
import { Scheduler } from '../src/scheduler.ts';

const adapters = createAdapters();

test('注册表里每个 adapter 都满足统一契约', () => {
  assert.ok(adapters.length >= 4, `adapter 数应 >= 4,实际 ${adapters.length}`);

  const ids = new Set();
  for (const a of adapters) {
    assert.ok(typeof a.id === 'string' && a.id.length > 0, 'id 必填');
    assert.ok(!ids.has(a.id), `id 重复: ${a.id}`);
    ids.add(a.id);

    assert.ok([1, 2, 3, 4, 5].includes(a.tier), `${a.id}: tier 应在 1..5,实际 ${a.tier}`);
    assert.ok(typeof a.displayName === 'string' && a.displayName.length > 0);
    assert.ok(
      Array.isArray(a.supportedApprovals) && a.supportedApprovals.length > 0,
      `${a.id}: 必须声明支持的审批档位`,
    );
    for (const lvl of a.supportedApprovals) {
      assert.ok(['read-only', 'workspace-write', 'full'].includes(lvl), `${a.id}: 非法审批档位 ${lvl}`);
    }
    assert.equal(typeof a.detect, 'function');
    assert.equal(typeof a.plan, 'function');
    assert.equal(typeof a.createRun, 'function');
  }
});

test('层级分布:①ACP ②双向流 ③一次性 都应有代表', () => {
  const byTier = new Map();
  for (const a of adapters) byTier.set(a.tier, [...(byTier.get(a.tier) ?? []), a.id]);
  for (const tier of [1, 2, 3]) {
    assert.ok(byTier.has(tier), `层级 ${tier} 没有 adapter;M1 要求三级横截面都有`);
  }
  assert.ok((byTier.get(1) ?? []).length >= 2, '层级① 应有多个 ACP 厂商');
});

test('未探测前 plan() 必须拒绝而不是给出坏命令', () => {
  for (const a of adapters) {
    assert.throws(
      () =>
        a.plan({
          taskId: 't',
          harness: a.id,
          prompt: 'x',
          cwd: process.cwd(),
          approval: 'read-only',
          budget: { maxWallMs: 1000 },
          session: { mode: 'fresh' },
        }),
      /detect|未探测/,
      `${a.id}: 未 detect 就 plan 应抛错`,
    );
  }
});

test('detect() 返回结构正确,且不把"装了但不可用"报成可用', async () => {
  for (const a of adapters) {
    const d = await a.detect();
    assert.equal(typeof d.available, 'boolean', `${a.id}: available 应是布尔`);
    if (d.available) {
      const plan = a.plan({
        taskId: 't',
        harness: a.id,
        prompt: 'x',
        cwd: process.cwd(),
        approval: 'read-only',
        budget: { maxWallMs: 1000 },
        session: { mode: 'fresh' },
      });
      assert.ok(typeof plan.command === 'string' && plan.command.length > 0, `${a.id}: command 必填`);
      assert.ok(Array.isArray(plan.args), `${a.id}: args 应是数组`);
    } else {
      assert.ok(
        typeof d.detail === 'string' && d.detail.length > 0,
        `${a.id}: 不可用时必须给出原因(不许静默)`,
      );
    }
  }
});

test('A 股本机实测基线:codex 必须可用(三家可产出文本之一,见 PLAN §3.5)', async () => {
  const codex = adapters.find((a) => a.id === 'codex');
  assert.ok(codex, '注册表里应有 codex');
  const d = await codex.detect();
  assert.equal(d.available, true, `codex 应可用,实际: ${d.detail ?? '(无原因)'}`);
  assert.match(d.version ?? '', /codex/i, 'version 应能报出 codex 版本');
});

test('model 参数会传进 argv(零额度,纯查命令构造)', async () => {
  const base = {
    taskId: 't',
    prompt: 'x',
    cwd: process.cwd(),
    approval: 'read-only',
    budget: { maxWallMs: 1000 },
    session: { mode: 'fresh' },
  };
  const expected = new Map([
    ['codex', '-m'],
    ['claude', '--model'],
  ]);

  for (const [id, flag] of expected) {
    const adapter = adapters.find((a) => a.id === id);
    assert.ok(adapter, `注册表里应有 ${id}`);
    const detected = await adapter.detect();
    if (!detected.available) continue;

    const withModel = adapter.plan({ ...base, harness: id, model: 'some-model-x' });
    const idx = withModel.args.indexOf(flag);
    assert.ok(idx >= 0, `${id}: 传了 model 时 argv 应含 ${flag},实际 ${withModel.args.join(' ')}`);
    assert.equal(withModel.args[idx + 1], 'some-model-x', `${id}: ${flag} 后应紧跟模型名`);

    const withoutModel = adapter.plan({ ...base, harness: id });
    assert.ok(!withoutModel.args.includes(flag), `${id}: 没传 model 时 argv 不该出现 ${flag}`);
  }
});

// —— 层级① 的"静默忽略"防线:不启进程,直接给 parser 喂仿真响应 ——

const ACP_INIT_OK = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: 1,
    agentInfo: { name: 'fake-agent', title: 'Fake', version: '0.0.0' },
    authMethods: [],
  },
});

test('层级① 对不支持的 spec 选项必须显式报错,不许静默忽略', () => {
  const acp = adapters.find((a) => a.tier === 1);
  assert.ok(acp, '注册表里应有层级① 的 adapter');

  const run = acp.createRun(
    {
      taskId: 't',
      harness: acp.id,
      prompt: 'x',
      cwd: process.cwd(),
      approval: 'read-only',
      budget: { maxWallMs: 1000 },
      session: { mode: 'resume', sessionId: 'abc' },
      model: 'some-model-x',
      outputSchemaPath: 'C:/tmp/schema.json',
    },
    't',
  );

  const events = run.parseLine(ACP_INIT_OK);
  const texts = events.map((e) => e.text ?? '').join('\n');

  assert.match(texts, /model=some-model-x/, '应报出 model 被忽略');
  assert.match(texts, /session\.mode=resume/, '应报出 session 被忽略');
  assert.match(texts, /output_schema=/, '应报出 output_schema 被忽略');
  assert.ok(
    events.filter((e) => e.type === 'error').length >= 3,
    `三项都应以 error 事件呈现,实际 ${JSON.stringify(events)}`,
  );
  assert.ok(events.some((e) => e.type === 'status'), '仍应有连接成功事件');
});

test('层级① 未传这些选项时不该产生噪音', () => {
  const acp = adapters.find((a) => a.tier === 1);
  const run = acp.createRun(
    {
      taskId: 't',
      harness: acp.id,
      prompt: 'x',
      cwd: process.cwd(),
      approval: 'read-only',
      budget: { maxWallMs: 1000 },
      session: { mode: 'fresh' },
    },
    't',
  );

  const events = run.parseLine(ACP_INIT_OK);
  assert.equal(
    events.filter((e) => e.type === 'error').length,
    0,
    `不该有 error,实际 ${JSON.stringify(events)}`,
  );
  assert.ok(events.some((e) => e.type === 'status'), '应有连接成功事件');
});

// —— 不得超额声明能力 ——

test('层级① 不得声明它兑现不了的写档位', () => {
  const tier1 = adapters.filter((a) => a.tier === 1);
  assert.ok(tier1.length > 0, '应有层级① 的 adapter');
  for (const a of tier1) {
    assert.deepEqual(
      a.supportedApprovals,
      ['read-only'],
      `${a.id}: 权限协商未实现前只应声明 read-only,实际 ${JSON.stringify(a.supportedApprovals)}。` +
        '声明了写档位却对每个权限请求回 -32601,等于让调用方以为拿到了写权限',
    );
  }
});

test('调度器真的会拒绝层级① 的写任务', async () => {
  const scheduler = new Scheduler(createAdapters());
  const tier1 = adapters.find((a) => a.tier === 1);
  assert.ok(tier1);

  await assert.rejects(
    () =>
      scheduler.dispatch({
        taskId: 't-reject-write',
        harness: tier1.id,
        prompt: 'x',
        cwd: process.cwd(),
        approval: 'workspace-write',
        budget: { maxWallMs: 1000 },
        session: { mode: 'fresh' },
      }),
    /不支持审批档位/,
    '层级① 的 workspace-write 应在派发阶段就被拒,而不是让它跑起来后静默失败',
  );
});

// —— CodeBuddy(腾讯,层级②)—— 本机第二个真正能产出文本的 harness ——

test('codebuddy 已入列,且必须解析到 WorkBuddy 捆绑的那份 CLI', async () => {
  const cb = adapters.find((a) => a.id === 'codebuddy');
  assert.ok(cb, '注册表里应有 codebuddy');
  assert.equal(cb.tier, 2, 'codebuddy 与 Claude Code 同构,属层级②');
  assert.deepEqual(cb.supportedApprovals, ['read-only', 'workspace-write', 'full']);

  const d = await cb.detect();
  assert.equal(d.available, true, `codebuddy 应可用,实际: ${d.detail ?? '(无原因)'}`);
  assert.match(
    d.version ?? '',
    /WorkBuddy bundled/,
    '必须用 WorkBuddy 捆绑的那份 —— 全局 npm 那份是未登录的,按 PATH 找会找错',
  );
});

test('codebuddy 的 argv 构造符合实测的旗标', () => {
  const cb = adapters.find((a) => a.id === 'codebuddy');
  const base = {
    taskId: 't',
    harness: 'codebuddy',
    prompt: 'x',
    cwd: process.cwd(),
    budget: { maxWallMs: 1000 },
    session: { mode: 'fresh' },
  };
  const at = (args, flag) => args[args.indexOf(flag) + 1];

  const ro = cb.plan({ ...base, approval: 'read-only' });
  assert.ok(ro.args.includes('-p'), '必须是 print 模式');
  assert.equal(at(ro.args, '--output-format'), 'stream-json');
  assert.equal(at(ro.args, '--permission-mode'), 'plan');
  assert.equal(at(cb.plan({ ...base, approval: 'workspace-write' }).args, '--permission-mode'), 'acceptEdits');
  assert.equal(at(cb.plan({ ...base, approval: 'full' }).args, '--permission-mode'), 'bypassPermissions');

  const withModel = cb.plan({ ...base, approval: 'read-only', model: 'm1' });
  assert.equal(at(withModel.args, '--model'), 'm1');
  assert.ok(!cb.plan({ ...base, approval: 'read-only' }).args.includes('--model'));

  // prompt 必须是最后一个位置参数,否则会被当成旗标值
  assert.equal(ro.args[ro.args.length - 1], 'x');
});