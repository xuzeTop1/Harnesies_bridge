/**
 * 仓库级云策略:该仓库的内容允不允许发给"本机之外"。
 *
 * 为什么单独测:只读档的 worker 照样把仓库内容发给模型 —— "只读"管的是改不改文件,与数据去向无关。
 * 而全机只有 claude 会自报 egress,所以最容易犯的错是把"不自报"当成"安全"。
 * 这条闸门的全部价值就在于:**端点未知一律按不可信处理**,而且不许默认拒绝所有仓库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LLMS_BRIDGE_HOME = join(tmpdir(), `llms-bridge-test-home-${process.pid}`);

const { Scheduler } = await import('../src/scheduler.ts');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** 桩:可选地自报一个端点(模拟 claude 那种 egress())。 */
function makeStub(host) {
  return {
    id: 'stub',
    tier: 2,
    displayName: 'Stub',
    supportedApprovals: ['read-only'],
    detect: async () => ({ available: true, version: 'stub-1' }),
    egress: host === undefined ? undefined : async () => ({
      endpointHost: host,
      nativeAnthropic: false,
      source: 'test stub',
      proxyClues: [],
      notice: 'stub',
    }),
    plan: () => ({ command: process.execPath, args: ['-e', "console.log('ok')"] }),
    createRun: () => ({ parseLine: () => [], finalize: () => ({ text: 'ok' }) }),
  };
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-bridge-policy-'));
  git(dir, ['init', '-q']);
  await writeFile(join(dir, 'seed.txt'), 'seed\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return dir;
}

async function writePolicy(repo, body) {
  await mkdir(join(repo, '.llms-bridge'), { recursive: true });
  await writeFile(
    join(repo, '.llms-bridge', 'policy.json'),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  );
}

const spec = (cwd, taskId) => ({
  taskId,
  harness: 'stub',
  prompt: 'x',
  cwd,
  approval: 'read-only',
  budget: { maxWallMs: 30_000 },
  session: { mode: 'fresh' },
});

test('没有 policy.json 的仓库:行为与以前完全一样(缺失=不限制)', async () => {
  const repo = await makeRepo();
  try {
    const scheduler = new Scheduler([makeStub(undefined)]);
    const ack = await scheduler.dispatch(spec(repo, 'p-nofile'));
    assert.ok(ack.taskId);
    await scheduler.idle();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('白名单里有这个 harness:放行', async () => {
  const repo = await makeRepo();
  try {
    await writePolicy(repo, { cloud: { allowHarnesses: ['stub'] } });
    const scheduler = new Scheduler([makeStub('api.example.com')]);
    const ack = await scheduler.dispatch(spec(repo, 'p-allow'));
    assert.ok(ack.taskId);
    assert.equal(ack.egress?.endpointHost, 'api.example.com', 'ack 仍要如实报端点');
    await scheduler.idle();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('白名单模式下不在名单里的:当场拒,并说清怎么放行', async () => {
  const repo = await makeRepo();
  try {
    await writePolicy(repo, { cloud: { allowHarnesses: ['claude', 'codebuddy'] } });
    const scheduler = new Scheduler([makeStub('api.example.com')]);
    await assert.rejects(
      () => scheduler.dispatch(spec(repo, 'p-deny')),
      /不在允许名单里\(当前名单:claude, codebuddy\)[\s\S]*cloud\.allowHarnesses/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('空名单:端点在本机的放行', async () => {
  const repo = await makeRepo();
  try {
    await writePolicy(repo, { cloud: { allowHarnesses: [] } });
    const scheduler = new Scheduler([makeStub('127.0.0.1:15721')]);
    const ack = await scheduler.dispatch(spec(repo, 'p-local'));
    assert.ok(ack.taskId);
    await scheduler.idle();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('空名单:端点在外面的拒(这是"这个仓库不许上云"的核心用例)', async () => {
  const repo = await makeRepo();
  try {
    await writePolicy(repo, { cloud: { allowHarnesses: [] } });
    const scheduler = new Scheduler([makeStub('api.anthropic.com')]);
    await assert.rejects(
      () => scheduler.dispatch(spec(repo, 'p-cloud')),
      /自报的端点是 api\.anthropic\.com\(非本机\)/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('空名单 + harness 不自报端点:必须拒 —— "不知道"不等于"本机"', async () => {
  const repo = await makeRepo();
  try {
    await writePolicy(repo, { cloud: { allowHarnesses: [] } });
    const scheduler = new Scheduler([makeStub(undefined)]);
    await assert.rejects(
      () => scheduler.dispatch(spec(repo, 'p-unknown')),
      /不自报数据去向[\s\S]*端点未知不等于本机/,
      '把未知当安全是本项目最忌的静默降级',
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('策略文件写坏了:按拒处理(用户建它是为了限制,解析失败不该悄悄解除)', async () => {
  const repo = await makeRepo();
  try {
    await writePolicy(repo, '{ 这不是 JSON');
    const scheduler = new Scheduler([makeStub('127.0.0.1:1')]);
    await assert.rejects(() => scheduler.dispatch(spec(repo, 'p-broken')), /读不懂/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('策略文件写错键名:同样按拒处理,不许当成"名单为空所以随便放行"', async () => {
  const repo = await makeRepo();
  try {
    await writePolicy(repo, { cloud: { allow: ['stub'] } }); // 键名错了
    const scheduler = new Scheduler([makeStub('127.0.0.1:1')]);
    await assert.rejects(() => scheduler.dispatch(spec(repo, 'p-keytypo')), /缺少 cloud\.allowHarnesses/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('策略文件本身不许出现在 git status 里', async () => {
  const repo = await makeRepo();
  try {
    await writePolicy(repo, { cloud: { allowHarnesses: ['stub'] } });
    const scheduler = new Scheduler([makeStub('api.example.com')]);
    await scheduler.dispatch(spec(repo, 'p-clean'));
    await scheduler.idle();
    assert.equal(git(repo, ['status', '--porcelain']).trim(), '', '策略/账本目录污染了工作区');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
