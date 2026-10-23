/**
 * 圆桌的纯函数契约:PASS 识别、提示词裁剪、转录/会话落盘、会话 id 提取。
 * 这里不派发任何任务,零额度消耗;真实多模型一通跑由 LLMS_BRIDGE_LIVE 开关另外控制。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTurn,
  appendUserTurn,
  buildPrompt,
  digestText,
  extractSessionId,
  isPass,
  loadAttachments,
  parseSeats,
  readSessions,
  readTranscript,
  roomDir,
  runRoom,
} from '../src/roundtable.ts';
import { createAdapters } from '../src/registry.ts';
import { parseDevToolsPort } from '../src/antigravity-cdp.ts';

const msg = (turn, seat, text) => ({ turn, round: 1, seat, harness: seat, kind: 'message', text, at: 1 });

test('PASS 只认整条就是 PASS', () => {
  for (const yes of ['PASS', 'pass', ' Pass. ', 'PASS。', '"PASS"']) {
    assert.equal(isPass(yes), true, yes);
  }
  for (const no of ['PASS 因为我觉得还行', 'PASSED', '', undefined, '我同意,没有补充']) {
    assert.equal(isPass(no), false, String(no));
  }
});

test('座位解析支持 harness:model', () => {
  assert.deepEqual(parseSeats('codex:gpt-6-astra, claude'), [
    { harness: 'codex', model: 'gpt-6-astra' },
    { harness: 'claude' },
  ]);
});

test('座位可以逐席指定思考强度', () => {
  assert.deepEqual(parseSeats('codex:gpt-6-astra@high,claude@max,mimo'), [
    { harness: 'codex', model: 'gpt-6-astra', effort: 'high' },
    { harness: 'claude', effort: 'max' },
    { harness: 'mimo' },
  ]);
});

test('思考强度原样透传给两家 CLI,而不是被悄悄吃掉', async () => {
  const adapters = createAdapters();
  const base = {
    taskId: 't', prompt: 'p', cwd: process.cwd(), approval: 'read-only', budget: { maxWallMs: 1000 },
  };

  const codex = adapters.find((a) => a.id === 'codex');
  if ((await codex.detect()).available) {
    const fresh = codex.plan({ ...base, harness: 'codex', session: { mode: 'fresh' }, effort: 'high' });
    assert.deepEqual(fresh.args.slice(-3), ['-c', 'model_reasoning_effort="high"', 'p']);
    const resumed = codex.plan({
      ...base, harness: 'codex', session: { mode: 'resume', sessionId: 'abc' }, effort: 'xhigh',
    });
    assert.ok(resumed.args.includes('model_reasoning_effort="xhigh"'), 'resume 也要带强度');
    assert.equal(resumed.args[resumed.args.length - 1], 'p', '提示词必须是最后一个参数');
  }

  const claude = adapters.find((a) => a.id === 'claude');
  if ((await claude.detect()).available) {
    const args = claude.plan({ ...base, harness: 'claude', session: { mode: 'fresh' }, effort: 'max' }).args;
    assert.equal(args[args.indexOf('--effort') + 1], 'max');
  }
});

test('续接模式只喂增量,不重复自己的历史', () => {
  const history = [msg(1, 'codex', '我的旧观点'), msg(2, 'claude', '我的旧观点'), msg(3, 'codex', '更新')];
  const { prompt } = buildPrompt({
    mode: 'resume',
    topic: '选哪个方案',
    delta: [msg(2, 'claude', '我的旧观点'), msg(3, 'codex', '更新')],
    history,
    seat: 'claude',
    turn: 4,
    keepTurns: 8,
    maxChars: 24000,
  });
  assert.match(prompt, /选哪个方案/);
  assert.match(prompt, /\[3\] codex: 更新/);
  assert.match(prompt, /\] claude: 我的旧观点/);
  assert.ok(!prompt.includes('[1] codex'), '不该重放本席第一轮');
  assert.match(prompt, /PASS/);
});

test('重建模式按预算裁剪并如实报省略条数', () => {
  const history = Array.from({ length: 40 }, (_, i) =>
    msg(i + 1, i % 2 ? 'claude' : 'codex', `观点${i + 1}`.padEnd(300, '述')));
  const { prompt, omitted, clipped } = buildPrompt({
    mode: 'fresh',
    topic: '议题',
    delta: history,
    history,
    seat: 'claude',
    turn: 41,
    keepTurns: 40,
    maxChars: 4000,
  });
  assert.ok(prompt.length <= 4000, `提示词 ${prompt.length} 超了上限`);
  assert.ok(omitted > 0, '应该省略掉较早的发言');
  assert.ok(clipped, '被预算挡住时应标记 clipped');
  assert.match(prompt, /观点40/, '最新的发言必须在里面');
  assert.ok(!prompt.includes('观点1述'), '最早的发言应被省略');
});

test('固定部分就超限时明确报错,而不是悄悄发出去', () => {
  assert.throws(
    () => buildPrompt({
      mode: 'fresh',
      topic: '议'.repeat(500),
      delta: [],
      history: [],
      seat: 'codex',
      turn: 1,
      keepTurns: 4,
      maxChars: 600,
    }),
    /超过上限/,
  );
});

test('转录与会话可落盘再读回', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-'));
  try {
    const dir = roomDir(root, 'r1');
    const tpath = join(dir, 'transcript.jsonl');
    const spath = join(dir, 'sessions.json');
    mkdirSync(dir, { recursive: true });
    appendTurn(tpath, msg(1, 'codex', '第一句'));
    appendTurn(tpath, { ...msg(2, 'claude', '第二句'), sessionId: 's-2' });
    const back = readTranscript(tpath);
    assert.equal(back.length, 2);
    assert.equal(back[1].text, '第二句');
    assert.equal(back[1].sessionId, 's-2');

    writeFileSync(spath, JSON.stringify({ claude: { sessionId: 's-2', lastTurn: 2 } }));
    assert.equal(readSessions(spath).claude.sessionId, 's-2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('会话 id 从厂商原始事件里取(codex thread_id / claude session_id)', () => {
  const event = (raw) => ({ taskId: 't', seq: 0, harness: 'x', tier: 3, type: 'status', at: 0, raw });
  assert.equal(extractSessionId([event({ thread_id: 'abc' })]), 'abc');
  assert.equal(extractSessionId([event({ type: 'system', session_id: 'sid' })]), 'sid');
  assert.equal(extractSessionId([event({ type: 'turn.started' })]), undefined);
});

test('房间 id 不接受路径穿越', () => {
  assert.throws(() => roomDir('/tmp', '../evil'), /只能用字母数字/);
  assert.match(roomDir('/tmp', 'room-1'), /room-1$/);
});

test('codex 的模型清单来自 CLI 自己的缓存,读不到就报 null 而不编', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const codex = createAdapters().find((a) => a.id === 'codex');

    assert.equal(await codex.listModels(), null, '没有缓存时必须返回 null');

    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      fetched_at: 1700000000000,
      models: [{ slug: 'gpt-6-sol' }, { slug: 'gpt-reserve' }],
    }));
    const catalog = await codex.listModels();
    assert.deepEqual(catalog.models, ['gpt-6-sol', 'gpt-reserve']);
    assert.equal(catalog.checkedAt, 1700000000000, '清单日期要跟着缓存走,不能填"此刻"');
    assert.match(catalog.source, /models_cache\.json/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('只读面板能列出圆桌房间,且不接受非法 id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-rt-'));
  const prevHome = process.env.LLMS_BRIDGE_HOME;
  process.env.LLMS_BRIDGE_HOME = root;
  try {
    const dir = join(root, 'roomdir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'room.json'), JSON.stringify({
      id: 'r1', topic: '测试议题', seats: [{ harness: 'codex' }, { harness: 'claude' }],
    }));
    writeFileSync(join(dir, 'transcript.jsonl'), `${JSON.stringify({
      turn: 1, round: 1, seat: 'codex', kind: 'message', text: '你好', at: 1700000000000,
    })}\n`);
    writeFileSync(join(root, 'roundtable-rooms.json'), JSON.stringify({
      r1: { dir, topic: '测试议题', seats: ['codex', 'claude'], updatedAt: 1700000000000 },
    }));

    const { startUi } = await import('../src/ui.ts');
    const ui = await startUi({ port: 0 });
    try {
      const rooms = await (await fetch(`${ui.url}api/rooms`)).json();
      assert.equal(rooms.length, 1);
      assert.equal(rooms[0].id, 'r1');
      assert.equal(rooms[0].turns, 1, '条数必须从转录回读,不能靠登记信息估');

      const room = await (await fetch(`${ui.url}api/room?id=r1`)).json();
      assert.equal(room.found, true);
      assert.equal(room.transcript[0].text, '你好');

      assert.equal((await fetch(`${ui.url}api/room?id=..%2Fetc`)).status, 400);
      const page = await fetch(`${ui.url}rooms`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /圆桌/);
    } finally {
      await ui.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.LLMS_BRIDGE_HOME;
    else process.env.LLMS_BRIDGE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('整轮编排:每席的模型/强度进到 spec,第二轮续接同一席的会话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-run-'));
  const prevHome = process.env.LLMS_BRIDGE_HOME;
  process.env.LLMS_BRIDGE_HOME = root;
  try {
    const sent = [];
    let seq = 0;
    const scheduler = {
      async dispatch(spec) {
        sent.push(spec);
        return { taskId: 't' + (++seq) };
      },
      async collect(taskId) {
        return {
          taskId, harness: 'stub', tier: 3, status: 'ok', text: '观点-' + taskId,
          eventCount: 1, startedAt: 1, endedAt: 2, isolated: false,
        };
      },
      events(taskId) {
        return [{ taskId, seq: 0, harness: 'stub', tier: 3, type: 'status', at: 0, raw: { session_id: 'sid-' + taskId } }];
      },
    };

    const { transcript } = await runRoom(scheduler, {
      id: 'rs',
      topic: '议题',
      cwd: root,
      rounds: 2,
      seats: [
        { harness: 'a', model: 'm1', effort: 'low' },
        { harness: 'b', effort: 'max' },
      ],
      maxWallMsPerTurn: 1000,
      keepTurns: 4,
      maxPromptChars: 20000,
    });

    assert.equal(sent.length, 4, '两席两轮 = 4 次派发');
    assert.equal(sent[0].effort, 'low');
    assert.equal(sent[0].model, 'm1');
    assert.equal(sent[0].session.mode, 'fresh');
    assert.equal(sent[1].effort, 'max');
    assert.equal(sent[1].model, undefined, '没指定模型就不该自己编一个');

    assert.equal(sent[2].session.mode, 'resume', '同一席第二轮必须续接');
    assert.equal(sent[2].session.sessionId, 'sid-t1', '续接的是该席第一轮拿到的会话');
    assert.match(sent[2].prompt, /\[2\] b:/, '续接只喂增量:必须带上另一席上一轮的话');

    assert.equal(transcript.length, 4);
    assert.equal(transcript[0].kind, 'message');
  } finally {
    if (prevHome === undefined) delete process.env.LLMS_BRIDGE_HOME;
    else process.env.LLMS_BRIDGE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('antigravity:CDP 端口只从登记文件解析,解析不出就报 null', () => {
  assert.equal(parseDevToolsPort('62504\n/devtools/browser/abc\n'), 62504);
  assert.equal(parseDevToolsPort(''), null);
  assert.equal(parseDevToolsPort('not-a-port'), null);
  assert.equal(parseDevToolsPort('70000'), null, '越界端口不算');
});

test('antigravity:助手输出的 JSONL 被正确归一,且模型/强度被明确拒绝', async () => {
  const antigravity = createAdapters().find((a) => a.id === 'antigravity');
  // plan() 要求先探测(未探测即派发是坏命令);这里探测失败也无妨,只要跑过就能看参数构造。
  await antigravity.detect();
  const spec = {
    taskId: 't', harness: 'antigravity', prompt: 'p', cwd: '.',
    approval: 'read-only', budget: { maxWallMs: 1000 }, session: { mode: 'fresh' },
  };

  assert.throws(() => antigravity.plan({ ...spec, model: 'pro' }), /不支持 --model/,
    '被指定的模型不能静默忽略');
  assert.throws(() => antigravity.plan({ ...spec, effort: 'high' }), /不支持 --effort/);

  const planned = antigravity.plan(spec);
  assert.ok(planned.args.includes('--new'), 'fresh 必须是新会话');
  assert.equal(planned.args[planned.args.length - 1], 'p');
  assert.ok(!antigravity.plan({ ...spec, session: { mode: 'resume', sessionId: 'x' } }).args.includes('--new'),
    'resume 不该再开新会话');

  const parser = antigravity.createRun(spec, 't1');
  const events = [];
  for (const line of [
    '{"type":"message","text":"PRO"}',
    '{"type":"message","text":"PROBE_OK"}',
    '{"type":"result","text":"PROBE_OK","session_id":"antigravity-current"}',
  ]) {
    events.push(...parser.parseLine(line));
  }
  assert.equal(parser.finalize(0).text, 'PROBE_OK', '快照式输出应取最后一份');
  assert.ok(events.some((e) => e.type === 'message' && e.text === 'PROBE_OK'));

  const broken = antigravity.createRun(spec, 't2');
  broken.parseLine('{"type":"error","text":"当前激活项目是「Fusion」"}');
  assert.match(broken.finalize(3).errorText, /Fusion/);
});

test('codex 的思考档来自它自己的 config.toml,没有就报 null', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-effort-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const codex = createAdapters().find((a) => a.id === 'codex');
    assert.equal(await codex.listEfforts(), null, '没有配置就必须返回 null,不能编一份默认档位');
    writeFileSync(join(home, 'config.toml'), 'model = "x"\nenabled-reasoning-efforts = [\n  "low",\n  "high",\n]\n');
    const catalog = await codex.listEfforts();
    assert.deepEqual(catalog.models, ['low', 'high']);
    assert.match(catalog.source, /config\.toml/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('席位目录:三家都在,拉不到清单的必须是空数组而不是默认值', async () => {
  const { seatsCatalog } = await import('../src/ui.ts');
  const list = await seatsCatalog(true);
  assert.deepEqual(
    list.map((x) => x.id).sort(),
    ['antigravity', 'claude', 'codebuddy', 'codex', 'opencode'],
    '席位目录应包含桥里可派的五家',
  );

  const antigravity = list.find((x) => x.id === 'antigravity');
  assert.deepEqual(antigravity.models, [], 'antigravity 不自报模型');
  assert.deepEqual(antigravity.efforts, [], 'antigravity 不支持 effort');

  const codex = list.find((x) => x.id === 'codex');
  assert.ok(codex.models.length > 0, 'codex 应从自己的缓存拿到模型清单');

  const claude = list.find((x) => x.id === 'claude');
  if (claude.available) {
    assert.ok(claude.models.length > 0, 'claude 应能从 --help 拿到别名');
    assert.ok(claude.efforts.length > 0, 'claude 应能从 --help 拿到 effort 档位');
  }
});

test('附件正文会被内联进提示词,谁的工作区长什么样都不影响', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-attach-'));
  try {
    const dir = roomDir(root, 'a1');
    const workspace = join(dir, 'workspace');
    mkdirSync(join(workspace, 'uploads'), { recursive: true });
    writeFileSync(join(workspace, 'uploads', 'idea.md'), '# 方案\n核心假设是 X。');

    const tpath = join(dir, 'transcript.jsonl');
    appendTurn(tpath, msg(1, 'codex', '旧观点'));
    appendUserTurn(tpath, '[附件] uploads/idea.md (abs: C:\\nope.md)\n看看这个');

    const history = readTranscript(tpath);
    const files = loadAttachments(history, workspace);
    assert.equal(files.length, 1, '应按 [附件] 路径读到正文');
    assert.match(files[0].text, /核心假设是 X/);

    // 房间首条消息只存在 room.json 里,runRoom 会把它合成一条 user 记录一起扫。
    const topicFiles = loadAttachments(
      [{ turn: 0, round: 0, seat: '你', harness: 'user', kind: 'user', text: '[附件] uploads/idea.md', at: 0 }],
      workspace,
    );
    assert.equal(topicFiles.length, 1, '议题里的附件引用也要能扫到');

    const { prompt } = buildPrompt({
      mode: 'fresh', topic: 'T', delta: history, history, seat: 'antigravity',
      turn: 3, keepTurns: 8, maxChars: 24000, attachments: files,
    });
    assert.match(prompt, /附件正文/);
    assert.match(prompt, /核心假设是 X/);
    assert.ok(prompt.length <= 24000, '内联后仍要守住提示词上限');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('要点稿按标题抽取且有上限', () => {
  const text = `# 标题一\n第一段内容甲。\n## 标题二\n第二段内容乙。\n${'x'.repeat(5000)}`;
  const digest = digestText(text, 200);
  assert.ok(digest.length <= 200, '要点稿必须受长度限制');
  assert.match(digest, /标题一/);
  assert.match(digest, /标题二/);
});

test('附件只在首次那一轮给全文,之后只喂要点稿', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-life-'));
  const prevHome = process.env.LLMS_BRIDGE_HOME;
  process.env.LLMS_BRIDGE_HOME = root;
  try {
    const dir = roomDir(root, 'rs2');
    const workspace = join(dir, 'workspace');
    mkdirSync(join(workspace, 'uploads'), { recursive: true });
    const body = `# 方案\n核心假设是甲。\n## 方法\n用乙实现。\n${'细节'.repeat(300)}\n结尾标记Z`;
    writeFileSync(join(workspace, 'uploads', 'idea.md'), body);

    const sent = [];
    let seq = 0;
    const scheduler = {
      async dispatch(spec) { sent.push(spec); return { taskId: 't' + (++seq) }; },
      async collect(taskId) {
        return { taskId, harness: 'stub', tier: 3, status: 'ok', text: '好的', eventCount: 1, startedAt: 1, endedAt: 2, isolated: false };
      },
      events(taskId) { return [{ taskId, seq: 0, harness: 'stub', tier: 3, type: 'status', at: 0, raw: { session_id: 's' + taskId } }]; },
    };

    await runRoom(scheduler, {
      id: 'rs2',
      topic: '[附件] uploads/idea.md\n看看这个方案',
      cwd: root,
      rounds: 2,
      seats: [{ harness: 'a' }, { harness: 'b' }],
      maxWallMsPerTurn: 1000,
      keepTurns: 4,
      maxPromptChars: 24000,
    });

    assert.match(sent[0].prompt, /核心假设是甲/, '首轮必须给全文');
    assert.match(sent[0].prompt, /结尾标记Z/, '首轮应含全文尾部');
    assert.ok(!/要点稿/.test(sent[0].prompt), '首轮不该标要点稿');
    assert.match(sent[2].prompt, /\(要点稿\)/, '第二轮起只给要点稿');
    assert.ok(!sent[2].prompt.includes('结尾标记Z'), '后续轮次不该再带全文尾部');
    assert.ok(sent[2].prompt.length < sent[0].prompt.length, '要点稿应明显短于全文');
  } finally {
    if (prevHome === undefined) delete process.env.LLMS_BRIDGE_HOME;
    else process.env.LLMS_BRIDGE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('收敛模式:全员弃权就停,收尾产出 final.md 与每席 md', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-consensus-'));
  const prevHome = process.env.LLMS_BRIDGE_HOME;
  process.env.LLMS_BRIDGE_HOME = root;
  try {
    const sent = [];
    let seq = 0;
    const scheduler = {
      async dispatch(spec) { sent.push(spec); return { taskId: 't' + (++seq) }; },
      async collect(taskId) {
        const spec = sent[sent.length - 1];
        const isFinal = spec.prompt.includes('# 现在');
        return {
          taskId, harness: 'stub', tier: 3, status: 'ok',
          text: isFinal ? '# 结论\n做 A,不做 B。' : 'PASS',
          eventCount: 1, startedAt: 1, endedAt: 2, isolated: false,
        };
      },
      events(taskId) {
        return [{ taskId, seq: 0, harness: 'stub', tier: 3, type: 'status', at: 0, raw: { session_id: 's' + taskId } }];
      },
    };

    const { dir, transcript } = await runRoom(scheduler, {
      id: 'rc', topic: '议题', cwd: root, rounds: 4, untilConsensus: true,
      seats: [{ harness: 'a' }, { harness: 'b' }],
      maxWallMsPerTurn: 1000, keepTurns: 4, maxPromptChars: 20000,
    });

    assert.equal(sent.length, 3, '一轮两席 + 一次收尾,不该跑满 4 轮');
    assert.match(sent[2].prompt, /# 现在/, '第三次派发必须是收尾');
    assert.equal(transcript.filter((r) => r.kind === 'pass').length, 2);
    assert.equal(transcript.filter((r) => r.kind === 'final').length, 1);

    assert.ok(existsSync(join(dir, 'final.md')), '应落盘 final.md');
    assert.match(readFileSync(join(dir, 'final.md'), 'utf8'), /# 结论/);
    assert.ok(readdirSync(join(dir, 'md')).length >= 1, '收尾结果也要有 md');
  } finally {
    if (prevHome === undefined) delete process.env.LLMS_BRIDGE_HOME;
    else process.env.LLMS_BRIDGE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('主持人插话会进转录,并出现在下一轮增量里', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt-user-'));
  try {
    const dir = roomDir(root, 'u1');
    mkdirSync(dir, { recursive: true });
    const tpath = join(dir, 'transcript.jsonl');
    appendTurn(tpath, msg(1, 'codex', '旧观点'));
    const rec = appendUserTurn(tpath, '换个角度');
    assert.equal(rec.kind, 'user');
    assert.equal(rec.seat, '你');
    assert.equal(rec.turn, 2);

    const history = readTranscript(tpath);
    const { prompt } = buildPrompt({
      mode: 'resume', topic: 'T', delta: history, history,
      seat: 'claude', turn: 3, keepTurns: 8, maxChars: 24000,
    });
    assert.match(prompt, /\[2\] 你: 换个角度/, '主持人插话必须出现在增量里');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('上传落盘到桥目录;续聊拒空消息与未知房间', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-say-'));
  const prevHome = process.env.LLMS_BRIDGE_HOME;
  process.env.LLMS_BRIDGE_HOME = root;
  try {
    const { startUi } = await import('../src/ui.ts');
    const ui = await startUi({ port: 0 });
    try {
      const post = (p, body) => fetch(`${ui.url}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      const uploaded = await post('api/upload', { name: 'a.txt', data: Buffer.from('hello').toString('base64') });
      assert.equal(uploaded.status, 200);
      const { path } = await uploaded.json();
      assert.ok(existsSync(path), '附件应落盘');
      assert.equal(readFileSync(path, 'utf8'), 'hello');

      assert.equal((await post('api/room/say', { id: 'nope', text: 'x' })).status, 404);
      assert.equal((await post('api/room/say', { id: 'r1', text: '   ' })).status, 400);

      // 没在跑的时候,"停止"必须如实说没有,而不是假装停了
      const stop = await fetch(`${ui.url}api/run/stop`, { method: 'POST' });
      assert.equal(stop.status, 409);
      assert.equal((await (await fetch(`${ui.url}api/run`)).json()).running, false);
    } finally {
      await ui.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.LLMS_BRIDGE_HOME;
    else process.env.LLMS_BRIDGE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('页面脚本单独成文件:语法可检,且不许用 innerHTML', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-page-'));
  const prevHome = process.env.LLMS_BRIDGE_HOME;
  process.env.LLMS_BRIDGE_HOME = root;
  try {
    const { startUi } = await import('../src/ui.ts');
    const ui = await startUi({ port: 0 });
    try {
      const html = await (await fetch(`${ui.url}rooms`)).text();
      assert.match(html, /src="\/rooms\.js"/, '页面应外链脚本');

      const jsRes = await fetch(`${ui.url}rooms.js`);
      assert.equal(jsRes.status, 200);
      const js = await jsRes.text();

      // 模型输出会进 Markdown 渲染器:一旦用了 innerHTML,就等于把注入面交给模型。
      assert.ok(!/\.innerHTML\s*=/.test(js), '页面脚本不许给 innerHTML 赋值');
      assert.match(js, /renderMarkdown/, '应有 Markdown 渲染');
      assert.match(js, /https\?/, '链接需白名单');

      const file = join(root, 'rooms-page.js');
      writeFileSync(file, js);
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } finally {
      await ui.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.LLMS_BRIDGE_HOME;
    else process.env.LLMS_BRIDGE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('面板可以发起圆桌(rounds=0 只登记房间,不派发任何模型)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-start-'));
  const prevHome = process.env.LLMS_BRIDGE_HOME;
  process.env.LLMS_BRIDGE_HOME = root;
  try {
    const { startUi } = await import('../src/ui.ts');
    const ui = await startUi({ port: 0 });
    try {
      const post = (body) => fetch(`${ui.url}api/roundtable/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      assert.equal((await post({ topic: '' })).status, 400, '空议题必须被拒');
      assert.equal((await post({ topic: 'x', seats: 'codex', rounds: 99 })).status, 400, '轮数越界必须被拒');
      assert.equal((await post({ topic: 'x', seats: 'rm -rf /', rounds: 1 })).status, 400, '非法 seats 必须被拒');

      const ok = await post({ topic: '冒烟', seats: 'codex,claude', rounds: 0 });
      assert.equal(ok.status, 202);
      const { id } = await ok.json();

      let rooms = [];
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        rooms = await (await fetch(`${ui.url}api/rooms`)).json();
        if (rooms.some((x) => x.id === id)) break;
      }
      const room = rooms.find((x) => x.id === id);
      assert.ok(room, '房间应出现在 /api/rooms');
      assert.equal(room.turns, 0, 'rounds=0 不该产生任何发言');

      const run = await (await fetch(`${ui.url}api/run`)).json();
      assert.equal(typeof run.running, 'boolean');
    } finally {
      await ui.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.LLMS_BRIDGE_HOME;
    else process.env.LLMS_BRIDGE_HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
  }
});
