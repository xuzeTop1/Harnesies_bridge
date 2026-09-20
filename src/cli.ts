import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Scheduler } from './scheduler.ts';
import { createAdapters } from './registry.ts';
import { cleanBridgeWorktrees, isGitRepo, listWorktrees } from './worktree.ts';
import type { ApprovalLevel, SessionMode, TaskSpec } from './types.ts';
import { DispatchRejected } from './types.ts';

function parseFlags(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out.set(key, true);
    } else {
      out.set(key, next);
      i++;
    }
  }
  return out;
}

function str(flags: Map<string, string | true>, key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === 'string' ? v : undefined;
}

function num(flags: Map<string, string | true>, key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const USAGE = `llms-bridge(冒烟入口)

  node src/cli.ts detect
      探测各 adapter 是否可用(版本、缺失原因)

  node src/cli.ts dispatch --harness <id> --prompt <text> --approval <level> --max-wall-ms <n>
      [--cwd <dir>] [--max-tokens <n>] [--schema <file.json>] [--model <name>] [--allow-full]
      [--resume <sessionId> | --fork <sessionId>] [--allow-unisolated-write] [--verbose]

  node src/cli.ts worktrees [--cwd <repo>] [--only <子串>] [--confirm]
      列出仓库里的 worktree;默认 dry-run 只报将要删的,加 --confirm 才真删。
      只清理本桥创建的(.llms-bridge/worktrees/ 下),不动其它 worktree。
      **worker 的 diff 未合并前不要删。**

  approval 取值: read-only | workspace-write | full(full 需 --allow-full)`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === undefined || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }

  const scheduler = new Scheduler(createAdapters());
  const flags = parseFlags(argv.slice(1));

  if (command === 'detect') {
    const report = await scheduler.detectAll();
    for (const r of report) {
      const mark = r.available ? 'OK  ' : 'MISS';
      console.log(`${mark} ${r.id.padEnd(8)} tier=${r.tier} approvals=${r.supportedApprovals.join('|')}`);
      console.log(`     ${r.version ?? r.detail ?? '(无版本信息)'}`);
    }
    return 0;
  }

  if (command === 'worktrees') {
    const repoRoot = resolve(str(flags, 'cwd') ?? process.cwd());
    if (!(await isGitRepo(repoRoot))) {
      console.error(`${repoRoot} 不是 git 仓库,没有 worktree 可管`);
      return 2;
    }

    const only = str(flags, 'only');
    const confirm = flags.get('confirm') === true;
    const all = await listWorktrees(repoRoot);

    console.log(`仓库: ${repoRoot}`);
    for (const w of all) {
      const tag = w.ownedByBridge ? '[桥]  ' : '[其它]';
      console.log(`  ${tag} ${w.path}  HEAD=${w.head.slice(0, 8)}${w.detached ? ' (detached)' : ''}`);
    }

    const result = await cleanBridgeWorktrees(repoRoot, { confirm, only });
    if (confirm) {
      console.log(`\n已删除 ${result.removed.length} 个 worktree:`);
      for (const p of result.removed) console.log(`  ${p}`);
    } else {
      console.log(`\n待删除 ${result.targets.length} 个(未加 --confirm,当前为 dry-run):`);
      for (const p of result.targets) console.log(`  ${p}`);
      console.log('确认 diff 已回收/已合并后再加 --confirm 真删。');
    }
    return 0;
  }

  if (command === 'dispatch') {
    const harness = str(flags, 'harness');
    const prompt = str(flags, 'prompt');
    const approval = str(flags, 'approval') as ApprovalLevel | undefined;
    const maxWallMs = num(flags, 'max-wall-ms');

    if (!harness || !prompt || !approval || maxWallMs === undefined) {
      console.error('缺少必填参数。--harness / --prompt / --approval / --max-wall-ms 都要给。');
      console.error(USAGE);
      return 2;
    }

    let session: SessionMode = { mode: 'fresh' };
    const resume = str(flags, 'resume');
    const fork = str(flags, 'fork');
    if (resume) session = { mode: 'resume', sessionId: resume };
    else if (fork) session = { mode: 'fork', sessionId: fork };

    const taskId = randomUUID();
    const spec: TaskSpec = {
      taskId,
      harness,
      prompt,
      cwd: resolve(str(flags, 'cwd') ?? process.cwd()),
      approval,
      budget: { maxWallMs, maxTokens: num(flags, 'max-tokens') },
      session,
      outputSchemaPath: str(flags, 'schema'),
      model: str(flags, 'model'),
      allowedFull: flags.get('allow-full') === true,
      allowUnisolatedWrite: flags.get('allow-unisolated-write') === true,
    };

    try {
      // detect 由 dispatch 在参数校验之后自行触发,这里不用先跑
      const ack = await scheduler.dispatch(spec);
      console.error(
        `[dispatched] task=${ack.taskId} harness=${harness} approval=${approval} ` +
          `isolated=${ack.isolated}${ack.worktreePath ? ` worktree=${ack.worktreePath}` : ''}`,
      );

      const result = await scheduler.collect(ack.taskId);
      console.log(JSON.stringify(result, null, 2));

      const events = scheduler.events(ack.taskId);
      if (flags.get('verbose') === true) {
        console.error('[verbose] 全部事件:');
        for (const e of events) {
          console.error(`  seq=${e.seq} ${e.type.padEnd(11)} ${JSON.stringify(e.text ?? e.raw ?? '').slice(0, 700)}`);
        }
      }
      console.error(`[events] ${events.length} 条,类型分布:`);
      const counts = new Map<string, number>();
      for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      for (const [type, n] of counts) console.error(`  ${type}: ${n}`);

      return result.status === 'ok' ? 0 : 1;
    } catch (err) {
      if (err instanceof DispatchRejected) {
        console.error(`[rejected] ${err.message}`);
        return 3;
      }
      throw err;
    }
  }

  console.error(`未知子命令: ${command}`);
  console.error(USAGE);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });