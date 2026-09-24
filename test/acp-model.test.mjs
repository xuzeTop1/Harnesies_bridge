/**
 * 层级① 的"派发时点名模型"必须真的点名,且点不到时必须**中止**。
 *
 * 为什么单独测:ACP 里模型不是启动参数,而是握手后的一次 `session/set_model` 调用。
 * 这条路上有两种坏结局,都属于本项目最忌讳的"静默降级":
 *   1. 传了模型但我方没发 set_model —— 调用方以为指定了,实际跑的是默认模型;
 *   2. 模型不被接受却继续发提示词 —— 实测 mimo 的免费端点会对 `mimo-auto` 回 400,
 *      而 agent 侧只表现为 "end_turn + 零文本 + 零 usage",看起来像"跑完了,没内容"。
 * 这里驱动 RunParser(不 spawn 任何进程),所以**零额度、零外部依赖**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcpAdapter, modelCatalogFromSessionResult, sessionSetModelRequest } from '../src/adapters/acp.ts';

// —— 两种清单形状都取自 2026-09-23 的真机返回,不是照规范推的 ——

/** mimo(MiMoCode 0.1.6 / OpenCode 0.1.6):选择器在 configOptions 里。 */
const MIMO_SESSION = {
  sessionId: 'ses_f33984d5',
  configOptions: [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'build', options: [] },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'xiaomi/mimo-v2.6-pro-ultraspeed',
      options: [
        { value: 'deepseek/deepseek-v4-pro', name: 'DeepSeek/DeepSeek V4 Pro' },
        { value: 'mimo/mimo-auto', name: 'MiMo Auto (free)/MiMo Auto' },
        { value: 'mimo/mimo-auto/high', name: 'MiMo Auto (free)/MiMo Auto (high)' },
        { value: 'xiaomi/mimo-v2.6-pro-ultraspeed', name: 'Xiaomi/MiMo-V2.6-Pro-UltraSpeed' },
      ],
    },
  ],
};

/** qwen(qwen-code 0.24.4):单独一节 models。 */
const QWEN_SESSION = {
  sessionId: 'qwen-ses-1',
  models: {
    currentModelId: 'qwen3.6-plus(openai)',
    availableModels: [
      { modelId: 'qwen3.6-plus(openai)', name: '[ModelStudio Standard] qwen3.6-plus' },
      { modelId: 'qwen3.7-max(openai)', name: '[ModelStudio Standard] qwen3.7-max' },
      { modelId: 'glm-5.1(openai)', name: '[ModelStudio Standard] glm-5.1' },
    ],
  },
};

function makeAdapter() {
  return createAcpAdapter({
    id: 'qwen',
    displayName: 'Qwen Code (ACP)',
    binName: 'qwen',
    pkgName: '@qwen-code/qwen-code',
  });
}

/** 起一个 parser,返回"喂一行 → 看已发出的消息"。 */
function drive(model) {
  const spec = {
    taskId: 'task-m',
    harness: 'qwen',
    prompt: 'hello',
    cwd: process.cwd(),
    approval: 'read-only',
    budget: { maxWallMs: 60_000 },
    session: { mode: 'fresh' },
    ...(model === undefined ? {} : { model }),
  };
  const run = makeAdapter().createRun(spec, spec.taskId);
  const sent = [];
  run.onStart((line) => sent.push(JSON.parse(line)));
  const feed = (obj) => run.parseLine(JSON.stringify(obj));
  return { run, sent, feed, method: (m) => sent.filter((x) => x.method === m) };
}

const initResult = { id: 1, result: { agentInfo: { name: 'OpenCode', version: '0.1.6' } } };

// —— 清单解析 ——

test('清单解析:mimo 形状取 configOptions[category=model] 的 options[].value', () => {
  const catalog = modelCatalogFromSessionResult(MIMO_SESSION, 1234);
  assert.deepEqual(catalog?.models, [
    'deepseek/deepseek-v4-pro',
    'mimo/mimo-auto',
    'mimo/mimo-auto/high',
    'xiaomi/mimo-v2.6-pro-ultraspeed',
  ]);
  assert.equal(catalog?.checkedAt, 1234);
  assert.match(catalog?.source ?? '', /configOptions/);
  // "不点名时实际跑哪个"必须能看出来,否则调用方无法判断这次派的到底是谁
  assert.match(catalog?.source ?? '', /xiaomi\/mimo-v2\.6-pro-ultraspeed/);
});

test('清单解析:qwen 形状取 models.availableModels[].modelId', () => {
  const catalog = modelCatalogFromSessionResult(QWEN_SESSION, 1);
  assert.deepEqual(catalog?.models, ['qwen3.6-plus(openai)', 'qwen3.7-max(openai)', 'glm-5.1(openai)']);
  assert.match(catalog?.source ?? '', /availableModels/);
  assert.match(catalog?.source ?? '', /qwen3\.6-plus\(openai\)/);
});

test('清单解析:认不出形状就返回 null(未知),不许编一份看着合理的清单', () => {
  assert.equal(modelCatalogFromSessionResult({ sessionId: 's' }, 1), null);
  assert.equal(modelCatalogFromSessionResult({ configOptions: [] }, 1), null);
  assert.equal(modelCatalogFromSessionResult({ configOptions: [{ category: 'model', options: [] }] }, 1), null);
  assert.equal(modelCatalogFromSessionResult(null, 1), null);
  assert.equal(modelCatalogFromSessionResult('not-an-object', 1), null);
});

test('未探测过就取清单:返回 null,不许瞎起进程', async () => {
  assert.equal(await makeAdapter().listModels(), null);
});

// —— 派发路径 ——

test('点名模型:握手后必须发 session/set_model,且 prompt 让到 id=4', () => {
  const { sent, feed, method } = drive('mimo/mimo-auto');
  feed(initResult);
  assert.ok(method('session/new').length === 1, 'initialize 之后应发 session/new');

  feed({ id: 2, result: MIMO_SESSION });
  const setModel = method('session/set_model');
  assert.equal(setModel.length, 1, '点名了模型就必须发 set_model —— 不发等于静默用了默认模型');
  assert.deepEqual(setModel[0].params, { sessionId: 'ses_f33984d5', modelId: 'mimo/mimo-auto' });
  assert.equal(setModel[0].id, 3);
  assert.equal(method('session/prompt').length, 0, 'set_model 有结果之前不得先发提示词');

  feed({ id: 3, result: { _meta: { opencode: { modelId: 'mimo/mimo-auto' } } } });
  const prompt = method('session/prompt');
  assert.equal(prompt.length, 1, 'set_model 成功后应继续发提示词');
  assert.equal(prompt[0].id, 4);
  assert.deepEqual(prompt[0].params.prompt, [{ type: 'text', text: 'hello' }]);

  // 末尾的 result 事件:能走到这里说明会话真的结束了
  const events = feed({ id: 4, result: { stopReason: 'end_turn' } });
  assert.ok(events.some((e) => e.type === 'result'));
});

test('不点名模型:不得发 set_model,prompt 仍是 id=3', () => {
  const { feed, method } = drive(undefined);
  feed(initResult);
  feed({ id: 2, result: MIMO_SESSION });
  assert.equal(method('session/set_model').length, 0);
  assert.equal(method('session/prompt')[0]?.id, 3);
});

test('模型不在 agent 自己报的清单里:**中止**,一个字的提示词都不许发', () => {
  const { run, feed, method } = drive('mimo/mimo-turbo-9'); // 清单里没有这个
  feed(initResult);
  const events = feed({ id: 2, result: MIMO_SESSION });

  assert.equal(method('session/prompt').length, 0, '模型对不上还继续发提示词 = 拿默认模型假装是它');
  assert.equal(method('session/set_model').length, 0, '连 set_model 都不必发');
  assert.ok(run.shouldStop(), '应立刻判定结束,不许挂着');
  const err = events.find((e) => e.type === 'error');
  assert.match(err?.text ?? '', /mimo\/mimo-turbo-9/);
  // 报错必须带上**它自己报的**可选值,否则调用方只知道"错了"不知道"该填什么"
  assert.match(err?.text ?? '', /mimo\/mimo-auto/);
  assert.match(run.finalize().errorText ?? '', /mimo\/mimo-turbo-9/);
});

test('清单里点名的是"当前值"也照样发 set_model(清单能对上就不拦)', () => {
  const { feed, method } = drive('deepseek/deepseek-v4-pro');
  feed(initResult);
  feed({ id: 2, result: MIMO_SESSION });
  assert.equal(method('session/set_model').length, 1);
});

test('取不到清单是"未知"不是"没有":仍然要试 set_model', () => {
  const { feed, method } = drive('whatever/model');
  feed(initResult);
  feed({ id: 2, result: { sessionId: 's-bare' } }); // 没有 configOptions 也没有 models
  assert.equal(method('session/set_model').length, 1, '没清单只能靠对方判定,不能替它拒绝');
});

test('set_model 被拒:必须中止,不许退回默认模型接着跑', () => {
  const { run, feed, method } = drive('mimo/mimo-auto');
  feed(initResult);
  feed({ id: 2, result: MIMO_SESSION });
  const events = feed({ id: 3, error: { code: -32602, message: 'Unknown model' } });

  assert.equal(method('session/prompt').length, 0, '退回默认模型跑出来的结果,调用方会当成"就是它跑的"');
  assert.ok(run.shouldStop());
  assert.match(events.find((e) => e.type === 'error')?.text ?? '', /Unknown model/);
  const finalized = run.finalize();
  assert.match(finalized.errorText ?? '', /mimo\/mimo-auto/);
  assert.equal(finalized.text, undefined, '中止时不得交出任何文本');
});

test('端点不接受这个模型时:不许把它当成"成功但回复为空"', () => {
  // 这是实测里最危险的一幕(mimo 免费端点对 mimo-auto 回 400,agent 侧却 end_turn + 零文本)。
  // 桥这一层能保证的是:只要模型是点名要的,就绝不以这种姿态收场。
  const { run, feed } = drive('mimo/mimo-auto');
  feed(initResult);
  feed({ id: 2, result: MIMO_SESSION });
  feed({ id: 3, result: { _meta: { opencode: { modelId: 'mimo/mimo-auto' } } } });
  feed({ id: 4, result: { stopReason: 'end_turn' } }); // 零文本、零 usage
  const finalized = run.finalize();
  assert.ok(finalized.errorText, '零文本 + end_turn 必须显式报失败,不能交一个空洞的成功');
});

test('sessionSetModelRequest 的形状', () => {
  assert.deepEqual(sessionSetModelRequest('s1', 'm1', 7), {
    jsonrpc: '2.0',
    id: 7,
    method: 'session/set_model',
    params: { sessionId: 's1', modelId: 'm1' },
  });
});
