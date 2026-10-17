/**
 * 事后磁盘审计:派发前后各看一眼调用方的工作目录,把"worker 到底动没动我的盘"
 * 从**桥报出来的事实**而不是从档位标签推断出来。
 *
 * 为什么要它:审批档位在很多家只是标签(见 src/enforcement.ts)—— 实测过的例子是 opencode,
 * 它的 read-only 照样写文件、照样执行命令。而写档的 worktree 隔离也只保证"默认落点",
 * 挡不住绝对路径。
 *
 * 2026-10-16 rewrite. The first version compared only `git status` codes, which reproducibly
 * missed two common cases:
 *   - a file that was already dirty and got rewritten (` M` before, ` M` after);
 *   - a new file inside an untracked directory (`?? notes/` before and after).
 * Now:
 *   - `--untracked-files=all` lists every untracked file individually;
 *   - every dirty/untracked path gets a fingerprint (size, mtime and ctime in ns, mode).
 *     ctime cannot be set from user space, so a rewrite is visible even if mtime is restored;
 *   - every ref (branches, tags, stash) is compared, not only HEAD.
 * Cost stays proportional to the number of dirty paths, not to the repository size.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './worktree.ts';

/** Above this many dirty/untracked paths, the rest are compared by status code only (and the caveat says so). */
const MAX_FINGERPRINTS = Number(process.env.LLMS_BRIDGE_AUDIT_MAX_PATHS ?? 50_000);

export interface DiskSnapshot {
  /** false = 这个目录不是 git 工作区(或 git 调用失败),审计无从下手。 */
  repo: boolean;
  /** Repository top level (realpath); porcelain paths are relative to it. */
  root?: string;
  /** '' when the branch has no commit yet. */
  head?: string;
  /** refname -> object id, for every ref. */
  refs?: Record<string, string>;
  /** 相对路径 -> porcelain 的 XY 码。只含 git 认为"可见且不干净"的条目。 */
  entries?: Record<string, string>;
  /** path -> `size:mtimeNs:ctimeNs:mode`, or 'absent'. */
  fingerprints?: Record<string, string>;
  /** More dirty paths than MAX_FINGERPRINTS. */
  partial?: boolean;
  /** repo=false 时说明为什么。 */
  whyNot?: string;
}

export interface DiskAuditPath {
  path: string;
  /** 派发前的状态码;'' 表示当时干净。 */
  before: string;
  /** 结束后的状态码;'' 表示现在干净了。 */
  after: string;
  /** 'status' = the status code changed; 'content' = same code, but the file was rewritten. */
  change: 'status' | 'content';
}

export interface DiskAudit {
  audited: boolean;
  /** 被审计的目录 —— 调用方给的那个 cwd,不是被换成的 worktree。 */
  cwd: string;
  changed?: boolean;
  paths?: DiskAuditPath[];
  /** HEAD 动了 = worker 在你的仓库里提交了东西。隔离语义里这是越界。 */
  headMoved?: boolean;
  /** Branches, tags or stash entries that appeared, disappeared or moved. */
  refsChanged?: string[];
  caveats: string[];
}

/** 审计的固有盲区。每次审计都原样带出去,不藏。 */
export const AUDIT_CAVEATS: readonly string[] = [
  '盲区1 / blind spot 1: paths excluded by .gitignore are not reported (e.g. writes into node_modules/).',
  '盲区2:只审计这一个目录;worker 往别处(其它盘、仓库外的绝对路径)写的东西不在范围内 / only this repository is audited.',
  '盲区3 / blind spot 3: only filesystem changes are visible. What the worker read or sent to its model is governed by the cloud policy and egress report, not by this audit.',
  'Method: git status codes plus per-file size/mtime/ctime fingerprints for dirty and untracked paths, plus all refs.',
];

function fingerprint(path: string): string {
  try {
    const st = lstatSync(path, { bigint: true });
    return `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}`;
  } catch {
    return 'absent';
  }
}

/**
 * `-z` 下条目以 NUL 分隔,格式是 `XY<空格>路径`;重命名/复制会再多跟一条**原路径**。
 * 用 -z 而不是按行切:路径带空格、引号、中文时按行切会解析错,而错在这儿意味着**误报越界**。
 */
function parsePorcelainZ(stdout: string): Record<string, string> {
  const parts = stdout.split('\0').filter((p) => p.length > 0);
  const entries: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!.slice(0, 2);
    entries[parts[i]!.slice(3)] = code;
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return entries;
}

export async function snapshotDisk(cwd: string): Promise<DiskSnapshot> {
  // Independent read-only queries: run them concurrently (each git spawn costs ~5–10 ms).
  const [top, head, st, refsOut] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)']),
  ]);
  if (!top.ok) {
    return { repo: false, whyNot: `不是 git 工作区,或 git 不可用:${top.stderr.trim() || 'rev-parse --show-toplevel 失败'}` };
  }
  let root = top.stdout.trim();
  try {
    root = realpathSync.native(root);
  } catch {
    /* keep git's spelling */
  }
  if (!st.ok) {
    return { repo: false, whyNot: `git status 失败:${st.stderr.trim()}` };
  }
  const refs: Record<string, string> = {};
  for (const line of refsOut.stdout.split('\n')) {
    const [name, sha] = line.split('\0');
    if (name && sha) refs[name] = sha;
  }

  const entries = parsePorcelainZ(st.stdout);
  const fingerprints: Record<string, string> = {};
  const paths = Object.keys(entries);
  for (const p of paths.slice(0, MAX_FINGERPRINTS)) fingerprints[p] = fingerprint(join(root, p));
  return {
    repo: true,
    root,
    head: head.ok ? head.stdout.trim() : '',
    refs,
    entries,
    fingerprints,
    partial: paths.length > MAX_FINGERPRINTS || undefined,
  };
}

/** 拿派发前的快照,现在再取一次并比对。before 不是 git 工作区时如实报"未审计"。 */
export async function auditDisk(cwd: string, before: DiskSnapshot): Promise<DiskAudit> {
  if (!before.repo) {
    return {
      audited: false,
      cwd,
      caveats: [`未审计:${before.whyNot ?? ''} —— 没有基线可比,这是"没法验证",不是"没改动"。`],
    };
  }
  const after = await snapshotDisk(cwd);
  if (!after.repo) {
    return {
      audited: false,
      cwd,
      caveats: [`审计中途失效:结束时 git 又不可用了(${after.whyNot ?? '未知'})。不知道有没有改动。`],
    };
  }

  const b = before.entries ?? {};
  const a = after.entries ?? {};
  const bf = before.fingerprints ?? {};
  const af = after.fingerprints ?? {};
  const paths: DiskAuditPath[] = [];
  for (const p of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const codeBefore = b[p] ?? '';
    const codeAfter = a[p] ?? '';
    if (codeBefore !== codeAfter) {
      paths.push({ path: p, before: codeBefore, after: codeAfter, change: 'status' });
    } else if (p in bf && p in af && bf[p] !== af[p]) {
      paths.push({ path: p, before: codeBefore, after: codeAfter, change: 'content' });
    }
  }
  paths.sort((x, y) => x.path.localeCompare(y.path));

  const refsChanged: string[] = [];
  const br = before.refs ?? {};
  const ar = after.refs ?? {};
  for (const r of new Set([...Object.keys(br), ...Object.keys(ar)])) {
    if (br[r] !== ar[r]) refsChanged.push(r);
  }
  refsChanged.sort();

  const headMoved = before.head !== after.head;
  const caveats = [...AUDIT_CAVEATS];
  if (before.partial || after.partial) {
    caveats.push(
      `More than ${MAX_FINGERPRINTS} dirty/untracked paths: paths beyond that limit were compared by status code only, so a rewrite of an already-dirty file there could be missed.`,
    );
  }
  return {
    audited: true,
    cwd,
    changed: paths.length > 0 || headMoved || refsChanged.length > 0,
    paths,
    headMoved,
    refsChanged,
    caveats,
  };
}
