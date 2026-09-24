/**
 * 事后磁盘审计:派发前后各看一眼调用方的工作目录,把"worker 到底动没动我的盘"
 * 从**桥报出来的事实**而不是从档位标签推断出来。
 *
 * 为什么要它:审批档位在很多家只是标签(见 src/enforcement.ts)—— 实测过的例子是 opencode,
 * 它的 read-only 照样写文件、照样执行命令。而写档的 worktree 隔离也只保证"默认落点",
 * 挡不住绝对路径。也就是说桥此前只能宣称意图,拿不出结果。R7 那次是用户自己手算了一份
 * `pre_run_snapshot.sha256` 才把这件事变成证据;这条把那个动作收进桥。
 *
 * 判据故意用 `git status` 而不是哈希遍历:
 *  - 不改动任何东西(对比之下 `captureDiff` 要先 `git add -A`,那会污染他人 worktree 的索引,
 *    也正是只读档不跑 captureDiff 的原因);
 *  - 成本与仓库体积基本无关,哈希遍历在 1.9GB 的仓库上是分钟级。
 * 代价是盲区必须讲清楚,见 CAVEATS —— 报"看不见"比假装看见要好。
 */
import { git } from './worktree.ts';

export interface DiskSnapshot {
  /** false = 这个目录不是 git 工作区(或 git 调用失败),审计无从下手。 */
  repo: boolean;
  head?: string;
  /** 相对路径 -> porcelain 的 XY 码。只含 git 认为"可见且不干净"的条目。 */
  entries?: Record<string, string>;
  /** repo=false 时说明为什么。 */
  whyNot?: string;
}

export interface DiskAuditPath {
  path: string;
  /** 派发前的状态码;'' 表示当时干净。 */
  before: string;
  /** 结束后的状态码;'' 表示现在干净了。 */
  after: string;
}

export interface DiskAudit {
  audited: boolean;
  /** 被审计的目录 —— 调用方给的那个 cwd,不是被换成的 worktree。 */
  cwd: string;
  changed?: boolean;
  paths?: DiskAuditPath[];
  /** HEAD 动了 = worker 在你的仓库里提交了东西。隔离语义里这是越界。 */
  headMoved?: boolean;
  caveats: string[];
}

/** 审计的固有盲区。每次审计都原样带出去,不藏。 */
export const AUDIT_CAVEATS: readonly string[] = [
  '盲区1:被 .gitignore 排除的路径 git 不会报(例如往 node_modules/ 里写东西看不见)。',
  '盲区2:只审计这一个目录;worker 往别处(其它盘、仓库外的绝对路径)写的东西不在范围内。',
  '盲区3:这里只看文件系统的改动。它读了什么、把什么发给了模型,归云策略与 egress 管,不在这个结果里。',
];

export async function snapshotDisk(cwd: string): Promise<DiskSnapshot> {
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  if (!head.ok) {
    return { repo: false, whyNot: `不是 git 工作区,或 git 不可用:${head.stderr.trim() || 'rev-parse HEAD 失败'}` };
  }
  const st = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (!st.ok) {
    return { repo: false, head: head.stdout.trim(), whyNot: `git status 失败:${st.stderr.trim()}` };
  }
  return { repo: true, head: head.stdout.trim(), entries: parsePorcelainZ(st.stdout) };
}

/**
 * `-z` 下条目以 NUL 分隔,格式是 `XY<空格>路径`;重命名/复制会再多跟一条**原路径**。
 * 用 -z 而不是按行切:路径带空格、引号、中文时按行切会解析错,而错在这儿意味着**误报越界**。
 */
function parsePorcelainZ(stdout: string): Record<string, string> {
  const parts = stdout.split('\0').filter((p) => p.length > 0);
  const entries: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    entries[parts[i].slice(3)] = code;
    if (code[0] === 'R' || code[0] === 'C') i++;
  }
  return entries;
}

/** 拿派发前的快照，现在再取一次并比对。before 不是 git 工作区时如实报"未审计"。 */
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
  const paths: DiskAuditPath[] = [];
  for (const p of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if ((b[p] ?? '') !== (a[p] ?? '')) paths.push({ path: p, before: b[p] ?? '', after: a[p] ?? '' });
  }
  paths.sort((x, y) => x.path.localeCompare(y.path));

  const headMoved = before.head !== after.head;
  return {
    audited: true,
    cwd,
    changed: paths.length > 0 || headMoved,
    paths,
    headMoved,
    caveats: [...AUDIT_CAVEATS],
  };
}
