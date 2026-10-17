import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { EgressReport } from './types.ts';
import { ensureBridgeDirExcluded, git, realpathOr } from './worktree.ts';

/**
 * 仓库级"本仓库内容能不能发到本机之外"的策略。
 *
 * 为什么需要:**只读档的 worker 照样会把仓库内容发给模型** —— 只读约束的是"改不改文件",
 * 与数据去向无关。用户 2026-09-24 要求按仓库选择,所以策略写在仓库里、随仓库走。
 *
 * 语义(刻意如此,别改成"缺省即限制"):
 *   - 文件**不存在** = 不限制。
 *   - 文件**存在** = 白名单模式:`cloud.allowHarnesses` 非空 → harness 必须在名单里;
 *     名单为空 → 只允许**自报端点在本机**的 harness。
 *   - **端点未知 ≠ 本机**;文件坏掉按**拒绝**处理。
 *
 * 2026-10-16: where the file is looked for. The first version read only `<cwd>/.llms-bridge/policy.json`,
 * so a dispatch whose cwd was a sub-directory of the repository, or a worktree (including the
 * bridge's own `.llms-bridge/worktrees/<id>` — the cross-review input), silently skipped a
 * repository's "local-only" policy. Now every applicable policy file counts:
 *   - `<dir>/.llms-bridge/policy.json` for the cwd and each of its ancestors;
 *   - the main worktree root when the cwd is inside a linked worktree anywhere on disk;
 *   - a user-wide `$LLMS_BRIDGE_HOME/policy.json` (default `~/.llms-bridge/policy.json`).
 * A dispatch must satisfy **all** of them (fail closed).
 */
export interface CloudPolicy {
  /** 文件是否存在。不存在 = 不限制。 */
  present: boolean;
  /** 允许把本仓库内容发出去的 harness id;空数组 = 只允许端点在本机的。 */
  allowHarnesses: string[];
  path: string;
  /** 文件存在但读不懂时的原因(此时一律拒绝)。 */
  error?: string;
}

function bridgeHome(): string {
  return process.env.LLMS_BRIDGE_HOME ?? join(homedir(), '.llms-bridge');
}

function parsePolicyFile(path: string): CloudPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { present: true, allowHarnesses: [], path, error: (err as Error).message };
  }
  const obj = parsed as { cloud?: { allowHarnesses?: unknown }; allowHarnesses?: unknown } | null;
  const list = obj?.cloud?.allowHarnesses ?? obj?.allowHarnesses;
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
    return {
      present: true,
      allowHarnesses: [],
      path,
      error: '缺少 cloud.allowHarnesses(应为字符串数组;空数组表示只允许端点在本机的 harness)',
    };
  }
  return { present: true, allowHarnesses: list as string[], path };
}

/** Candidate policy locations for a dispatch cwd, nearest first, de-duplicated. */
export async function policyCandidates(cwd: string): Promise<string[]> {
  const out: string[] = [];
  const add = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };
  let dir = realpathOr(cwd);
  for (;;) {
    add(join(dir, '.llms-bridge', 'policy.json'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // A linked worktree may live outside the main repository; its policy is the main repo's.
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.ok) {
    const commonDir = realpathOr(common.stdout.trim());
    if (basename(commonDir) === '.git') add(join(dirname(commonDir), '.llms-bridge', 'policy.json'));
  }
  add(join(bridgeHome(), 'policy.json'));
  return out;
}

/** Every policy file that applies to `cwd` (only existing files are returned). */
export async function readCloudPolicies(cwd: string): Promise<CloudPolicy[]> {
  const found: CloudPolicy[] = [];
  for (const path of await policyCandidates(cwd)) {
    if (!existsSync(path)) continue;
    const policyDir = dirname(dirname(path));
    if (policyDir !== bridgeHome()) {
      // 用户刚手写的策略文件不该以未跟踪文件的样子出现在他的 `git status` 里。
      await ensureBridgeDirExcluded(policyDir).catch(() => {});
    }
    found.push(parsePolicyFile(path));
  }
  return found;
}

/** Back-compat single view: the nearest applicable policy (or "absent"). Prefer readCloudPolicies. */
export async function readCloudPolicy(cwd: string): Promise<CloudPolicy> {
  const all = await readCloudPolicies(cwd);
  return all[0] ?? { present: false, allowHarnesses: [], path: join(cwd, '.llms-bridge', 'policy.json') };
}

/** Host part of `host`, `host:port`, `[v6]:port`, bare IPv6, or a URL. */
export function bareHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.includes('://')) {
    try {
      h = new URL(h).hostname;
    } catch {
      /* fall through with the raw string */
    }
  }
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h.slice(1);
  }
  if (h.split(':').length > 2) return h; // bare IPv6 without port
  return h.split(':')[0] ?? '';
}

/** 端点是不是本机。`127.0.0.1:15721`、`[::1]:8080` 这种带端口的写法也要认。 */
export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const bare = bareHost(host);
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare === '::1' ||
    bare === '0:0:0:0:0:0:0:1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
  );
}

export function checkCloudPolicy(
  policy: CloudPolicy,
  harness: string,
  egress: EgressReport | undefined,
): { allowed: boolean; reason?: string } {
  if (!policy.present) return { allowed: true };

  if (policy.error !== undefined) {
    return {
      allowed: false,
      reason:
        `该仓库有云策略但读不懂(${policy.error}):按最保守处理,拒绝派发。` +
        `修好或删掉 ${policy.path} 再派。`,
    };
  }

  if (policy.allowHarnesses.length > 0) {
    return policy.allowHarnesses.includes(harness)
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            `云策略 ${policy.path}:harness "${harness}" 不在允许名单里(当前名单:${policy.allowHarnesses.join(', ')})。` +
            `确实要放行,就把它加进 cloud.allowHarnesses。`,
        };
  }

  // 空名单 = 只允许端点在本机的。这里必须把"不知道"当拒绝。
  if (egress === undefined) {
    return {
      allowed: false,
      reason:
        `云策略 ${policy.path} 的允许名单为空 ⇒ 只允许"数据端点在本机"的 harness,` +
        `但 ${harness} 不自报数据去向(端点未知)。端点未知不等于本机,故拒绝。` +
        `要放行请在 cloud.allowHarnesses 里显式写出 ${harness}。`,
    };
  }
  // Every host the request could go to must be local (settings layers can disagree; see egress.ts).
  const hosts = [egress.endpointHost, ...(egress.alternateHosts ?? [])];
  const remote = hosts.filter((h) => !isLocalHost(h));
  return remote.length === 0
    ? { allowed: true }
    : {
        allowed: false,
        reason:
          `云策略 ${policy.path} 的允许名单为空,而 ${harness} 自报的端点是 ${remote.join(', ')}(非本机) —— 拒绝。` +
          `确实要放行,请在 cloud.allowHarnesses 里显式写出 ${harness}。`,
      };
}

/** All policies must allow the dispatch. */
export function checkCloudPolicies(
  policies: CloudPolicy[],
  harness: string,
  egress: EgressReport | undefined,
): { allowed: boolean; reason?: string; policies: string[] } {
  const paths = policies.filter((p) => p.present).map((p) => p.path);
  for (const p of policies) {
    const v = checkCloudPolicy(p, harness, egress);
    if (!v.allowed) return { allowed: false, reason: v.reason, policies: paths };
  }
  return { allowed: true, policies: paths };
}
