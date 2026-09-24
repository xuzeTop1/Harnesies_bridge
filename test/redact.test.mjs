/**
 * `raw` 里的凭证字段绝不许进事件流。
 *
 * 为什么单独测:`raw` 是**外部 CLI 的原样返回**,而它会经 `harness_events` 交给主脑 ——
 * 主脑可能就是另一个厂商的云端模型。实测(2026-09-23)qwen 的 `session/set_model` 返回里
 * 真的带过 `_meta.qwenModelSwitch.apiKey`。这是 AGENTS.md 铁律一(不转发凭证)的落地闸门,
 * 所以既测纯函数,也测它**真的被接在**调度器那条路上 —— 光有函数没接线等于没修。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactCredentials } from '../src/redact.ts';
import { Scheduler } from '../src/scheduler.ts';

// 账本索引默认写在 ~/.llms-bridge/,跑测试不该碰用户真实目录(journal.ts 惰性读这个变量)。
process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-${process.pid}`);

const SENTINEL = 'sk-LEAK-SENTINEL-DO-NOT-EMIT';

test('嵌套结构里的凭证字段被隐去,层级再深也拦得住', () => {
  const raw = {
    result: {
      _meta: {
        qwenModelSwitch: { apiKey: SENTINEL, modelId: 'qwen3.6-plus', baseUrl: 'https://x/v1' },
      },
    },
    list: [{ Authorization: `Bearer ${SENTINEL}` }, { 'x-api-key': SENTINEL }],
  };
  const out = JSON.stringify(redactCredentials(raw));
  assert.equal(out.includes(SENTINEL), false, '任何层级都不许漏出');
  assert.match(out, /已隐去:apiKey/);
  assert.match(out, /已隐去:Authorization/);
  assert.match(out, /已隐去:x-api-key/);
  // 非敏感字段必须原样保留,否则排查时看不出发生了什么
  assert.match(out, /qwen3\.6-plus/);
  assert.match(out, /https:\/\/x\/v1/);
});

test('用量字段不能被误伤:token_count / input_tokens / totalTokens 都要留住', () => {
  // 名单里刻意没有裸 `token` —— 按 /token/ 匹配会把预算闸门赖以工作的计量数据一起抹掉。
  const usage = {
    input_tokens: 12,
    output_tokens: 3,
    cache_read_input_tokens: 7,
    totalTokens: 15,
    token_count: 15,
  };
  assert.deepEqual(redactCredentials(usage), usage);
});

test('非对象原样通过:字符串(diff/协议行)、数字、null、布尔', () => {
  assert.equal(redactCredentials('sk-abc raw line'), 'sk-abc raw line', '字符串是内容本身,不按内容猜');
  assert.equal(redactCredentials(42), 42);
  assert.equal(redactCredentials(null), null);
  assert.equal(redactCredentials(true), true);
  assert.deepEqual(redactCredentials(['a', { api_key: SENTINEL }]), ['a', { api_key: '[已隐去:api_key]' }]);
});

test('调度器接线:事件流里的 raw 必须已隐去,而主脑仍能看到事件本身', async () => {
  const seen = [];
  /** 桩:不发任何模型请求,只在 parseLine/ finalize 里模拟"外部 CLI 返回了带 key 的报文"。 */
  const stub = {
    id: 'stub-leak',
    tier: 3,
    displayName: 'Stub leak worker',
    supportedApprovals: ['read-only'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    plan: () => ({ command: process.execPath, args: ['-e', "console.log('LEAK_LINE')"] }),
    createRun(spec, taskId) {
      seen.push(spec);
      return {
        parseLine(line) {
          if (line !== 'LEAK_LINE') return [];
          return [
            {
              taskId,
              seq: 0,
              harness: 'stub-leak',
              tier: 3,
              type: 'status',
              at: Date.now(),
              text: '模型已设为 x',
              raw: { _meta: { qwenModelSwitch: { apiKey: SENTINEL, modelId: 'qwen3.6-plus' } } },
            },
          ];
        },
        finalize: () => ({ text: 'done' }),
      };
    },
  };

  const scheduler = new Scheduler([stub]);
  // 用临时目录当 cwd:账本记录与心跳是**按任务 cwd**落的,拿 process.cwd() 会把测试垃圾
  // 直接写进本仓库的 .llms-bridge/tasks/ —— 光重定向 LLMS_BRIDGE_HOME 只挡住了索引,挡不住这个。
  const cwd = await mkdtemp(join(tmpdir(), 'llms-bridge-redact-'));
  const ack = await scheduler.dispatch({
    taskId: 'leak-1',
    harness: 'stub-leak',
    prompt: 'x',
    cwd,
    approval: 'read-only',
    budget: { maxWallMs: 30_000 },
    session: { mode: 'fresh' },
  });
  await scheduler.collect(ack.taskId);
  await rm(cwd, { recursive: true, force: true });

  const events = scheduler.events('leak-1');
  assert.equal(
    JSON.stringify(events).includes(SENTINEL),
    false,
    '经 harness_events 交出去的事件流里不许有 key —— 这里模拟的就是主脑看到的东西',
  );
  const withRaw = events.find((e) => e.raw !== undefined);
  assert.ok(withRaw, 'raw 本身还在(只是被隐去了),否则排查能力被一起砍掉');
  assert.equal(withRaw.raw._meta.qwenModelSwitch.apiKey, '[已隐去:apiKey]');
  assert.equal(withRaw.raw._meta.qwenModelSwitch.modelId, 'qwen3.6-plus');
});
