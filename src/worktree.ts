import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 每个 worker 的 worktree 落在这里。相对于仓库根,便于一起清理。 */
const WORKTREE_DIRNAME = '.llms-bridge';
const WORKTREE_SUBDIR = 'worktrees';
const EXCLUDE_ENTRY = `${WORKTREE_DIRNAME}/`;

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const st = await stat(join(dir, '.git')).catch(() => null);
  if (st?.isDirectory() || st?.isFile()) return true;
  const r = await git(dir, ['rev-parse', '--git-dir']);
  return r.ok;
}

export interface Worktree {
  /** worker 实际的工作目录(隔离出来的那份)。 */
  path: string;
  repoRoot: string;
}

/**
 * 把 worktree 容器目录加进仓库**本地**的排除表。
 *
 * 用 `.git/info/exclude` 而不是 `.gitignore`:后者是被跟踪的版本化文件,
 * 不该因为桥跑了一次就出现在用户的 diff 里。写在 info/exclude 只影响本仓库,且不产生 diff。
 */
async function ensureExcluded(repoRoot: string): Promise<void> {
  const r = await git(repoRoot, ['rev-parse', '--git-dir']);
  if (!r.ok) return;
  const gitDir = r.stdout.trim();
  if (gitDir.length === 0) return;
  const absGitDir = isAbsolute(gitDir) ? gitDir : resolve(repoRoot, gitDir);
  const excludePath = join(absGitDir, 'info', 'exclude');

  const existing = await readFile(excludePath, 'utf8').catch(() => '');
  if (existing.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_ENTRY)) return;

  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await mkdir(join(absGitDir, 'info'), { recursive: true });
  await writeFile(excludePath, `${existing}${separator}${EXCLUDE_ENTRY}\n`, 'utf8');
}

/**
 * 给一个 worker 分配独立 worktree(AGENTS.md 铁律三)。
 *
 * 用 `--detach` 而不是开分支:worker 的产出以 diff 形式回收,不需要污染分支列表。
 * 仓库状态(base commit)就是分配时的 HEAD,所以事后 `git diff` 能干净地拿到 worker 的改动。
 */
export async function allocateWorktree(repoRoot: string, taskId: string): Promise<Worktree> {
  const base = resolve(repoRoot);
  const short = taskId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  const path = join(base, WORKTREE_DIRNAME, WORKTREE_SUBDIR, short);
  await mkdir(join(base, WORKTREE_DIRNAME, WORKTREE_SUBDIR), { recursive: true });
  await ensureExcluded(base);

  const r = await git(base, ['worktree', 'add', '--detach', path, 'HEAD']);
  if (!r.ok) {
    throw new Error(`分配 worktree 失败: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return { path, repoRoot: base };
}

/**
 * 回收 worker 的改动为一段 diff。
 *
 * 先 `add -A` 再 `diff --cached`:否则新建的文件不会出现在 diff 里。
 * 这个 add 只发生在 worker 自己的 worktree 内,不影响用户的仓库。
 */
export async function captureDiff(worktreePath: string): Promise<{ patch: string; stat: string }> {
  await git(worktreePath, ['add', '-A']);
  const statText = await git(worktreePath, ['diff', '--cached', '--stat']);
  const patch = await git(worktreePath, ['diff', '--cached']);
  return { patch: patch.stdout, stat: statText.stdout };
}

/** 删除 worktree。默认只在调用方明确要求时用 —— 删掉之前先确认 diff 已回收。 */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  await git(repoRoot, ['worktree', 'prune']);
}

export interface WorktreeEntry {
  path: string;
  head: string;
  detached: boolean;
  /** 是否由本桥创建(位于 .llms-bridge/worktrees/ 下)。 */
  ownedByBridge: boolean;
}

/**
 * 列出仓库的所有 worktree。
 *
 * 用 `--porcelain` 而不是人读格式:后者会因终端宽度/本地化变化,不适合解析。
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const r = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!r.ok) throw new Error(`列出 worktree 失败: ${r.stderr.trim()}`);

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;
  const flush = () => {
    if (current?.path) {
      const normalized = current.path.replaceAll('\\', '/');
      entries.push({
        path: current.path,
        head: current.head ?? '',
        detached: current.detached ?? false,
        ownedByBridge: normalized.includes(`/${WORKTREE_DIRNAME}/${WORKTREE_SUBDIR}/`),
      });
    }
    current = null;
  };

  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line.trim() === 'detached' && current) {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

export interface CleanResult {
  /** 实际删除的路径。dry-run 时必为空数组。 */
  removed: string[];
  /** 命中的桥 worktree(dry-run 时就是要删的清单)。 */
  targets: string[];
  /** 未命中的(其它 worktree 与主工作区),一律不动。 */
  kept: string[];
}

/**
 * 清理本桥创建的 worktree。
 *
 * 默认只是**列出将要删的东西**(dry-run) —— 清理属于破坏性操作,
 * 必须由人显式确认(AGENTS.md 提交纪律:清 worktree 一律先问)。
 */
export async function cleanBridgeWorktrees(
  repoRoot: string,
  options: { confirm: boolean; only?: string },
): Promise<CleanResult> {
  const all = await listWorktrees(repoRoot);
  const isTarget = (w: WorktreeEntry) =>
    w.ownedByBridge && (options.only === undefined || w.path.includes(options.only));

  const targets = all.filter(isTarget).map((w) => w.path);
  const kept = all.filter((w) => !isTarget(w)).map((w) => w.path);

  if (!options.confirm) return { removed: [], targets, kept };

  const removed: string[] = [];
  for (const path of targets) {
    await removeWorktree(repoRoot, path);
    removed.push(path);
  }
  return { removed, targets, kept };
}