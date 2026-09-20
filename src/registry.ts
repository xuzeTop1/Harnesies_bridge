import type { Adapter } from './types.ts';
import { createCodexAdapter } from './adapters/codex.ts';
import { createClaudeAdapter } from './adapters/claude.ts';
import { createCodeBuddyAdapter } from './adapters/codebuddy.ts';
import { createAcpAdapter } from './adapters/acp.ts';

/**
 * 适配器注册表。
 *
 * 层级① 的 ACP 方言差异只在"怎么进入 ACP 模式"这一个参数上,所以共用一个 adapter 工厂:
 * Gemini / Qwen 用 flag `--acp`,MiMo / OpenClaw 用子命令 `acp`。
 *
 * Gemini 的 `--acp` 本机实测静默无响应(存活但不输出任何字节),故未注册 ——
 * 实现存在但入口不工作,等查明再加。
 */
export function createAdapters(): Adapter[] {
  return [
    createAcpAdapter({
      id: 'qwen',
      displayName: 'Qwen Code (ACP)',
      binName: 'qwen',
      pkgName: '@qwen-code/qwen-code',
    }),
    createAcpAdapter({
      id: 'mimo',
      displayName: 'MiMo (ACP)',
      binName: 'mimo',
      pkgName: '@mimo-ai/cli',
      acpArgs: ['acp'],
    }),
    createAcpAdapter({
      id: 'openclaw',
      displayName: 'OpenClaw (ACP)',
      binName: 'openclaw',
      pkgName: 'openclaw',
      acpArgs: ['acp'],
    }),
    createCodeBuddyAdapter(),
    createClaudeAdapter(),
    createCodexAdapter(),
  ];
}