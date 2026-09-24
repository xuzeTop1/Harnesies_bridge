import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EgressReport } from './types.ts';
import { ensureBridgeDirExcluded } from './worktree.ts';

/**
 * 仓库级"本仓库内容能不能发到本机之外"的策略。
 *
 * 为什么需要:**只读档的 worker 照样会把仓库内容发给模型** —— 只读约束的是"改不改文件",
 * 与数据去向无关。用户 2026-09-24 要求按仓库选择,所以策略写在仓库里、随仓库走。
 *
 * 语义(刻意如此,别改成"缺省即限制"):
 *   - 文件**不存在** = 不限制。给所有既有用法保留原行为,否则每个仓库都会突然多一道默认拒绝。
 *   - 文件**存在** = 白名单模式:
 *       · `cloud.allowHarnesses` 非空 → harness 必须在名单里;
 *       · 名单为空 → 只允许**自报端点在本机**的 harness。
 *   - **端点未知 ≠ 本机**。不自报 egress 的 harness 在空名单下会被拒 ——
 *     把"不知道"当成"安全"正是本项目最忌的静默降级(同 AGENTS.md 铁律一/三)。
 *   - 文件坏掉按**拒绝**处理:用户建它是为了限制,解析失败不该悄悄解除限制。
 *
 * 文件落在 `.llms-bridge/policy.json` 并进 `.git/info/exclude`:它是**这台机器上这个仓库**的属性,
 * 不该随仓库进版本库(何况"这个仓库不许上云"这条本身就不该被推上去)。
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

export async function readCloudPolicy(cwd: string): Promise<CloudPolicy> {
  const path = join(cwd, '.llms-bridge', 'policy.json');
  if (!existsSync(path)) return { present: false, allowHarnesses: [], path };

  // 用户刚手写的策略文件不该以未跟踪文件的样子出现在他的 `git status` 里。
  await ensureBridgeDirExcluded(cwd);

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

/** 端点是不是本机。`127.0.0.1:15721` 这种带端口的写法也要认。 */
function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '').split(':')[0] ?? '';
  return bare === 'localhost' || bare === '::1' || bare === '0:0:0:0:0:0:0:1' || /^127\./.test(bare);
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
            `该仓库设了云策略:harness "${harness}" 不在允许名单里(当前名单:${policy.allowHarnesses.join(', ')})。` +
            `确实要放行,就把它加进 ${policy.path} 的 cloud.allowHarnesses。`,
        };
  }

  // 空名单 = 只允许端点在本机的。这里必须把"不知道"当拒绝。
  if (egress === undefined) {
    return {
      allowed: false,
      reason:
        `该仓库设了云策略且允许名单为空 ⇒ 只允许"数据端点在本机"的 harness,` +
        `但 ${harness} 不自报数据去向(端点未知)。端点未知不等于本机,故拒绝。` +
        `要放行请在 ${policy.path} 的 cloud.allowHarnesses 里显式写出 ${harness}。`,
    };
  }
  return isLocalHost(egress.endpointHost)
    ? { allowed: true }
    : {
        allowed: false,
        reason:
          `该仓库设了云策略且允许名单为空,而 ${harness} 自报的端点是 ${egress.endpointHost}(非本机) —— 拒绝。` +
          `确实要放行,请在 ${policy.path} 的 cloud.allowHarnesses 里显式写出 ${harness}。`,
      };
}
