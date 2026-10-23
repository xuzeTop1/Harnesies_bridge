import type { Adapter } from './types.ts';
import { createCodexAdapter } from './adapters/codex.ts';
import { createClaudeAdapter } from './adapters/claude.ts';
import { createCodeBuddyAdapter } from './adapters/codebuddy.ts';
import { createOpencodeAdapter } from './adapters/opencode.ts';
import { createAcpAdapter } from './adapters/acp.ts';
import { createAntigravityAdapter } from './adapters/antigravity.ts';

/**
 * 适配器注册表。
 *
 * 层级① 的 ACP 方言差异只在"怎么进入 ACP 模式"这一个参数上,所以共用一个 adapter 工厂:
 * Gemini / Qwen 用 flag `--acp`,MiMo / OpenClaw 用子命令 `acp`。
 *
 * Gemini 未注册:它的 `--acp` 本机实测静默无响应,而该 CLI 又被 Google 以
 * "This client is no longer supported for Gemini Code Assist for individuals" 拒绝(见 PLAN §3.6)。
 *
 * opencode 单列一个层级③ 适配器,不走 mimo 那条 ACP:mimo 虽是 OpenCode 的套壳,
 * 但 `opencode run` 有 `--format json`,且它自报的模型清单比 mimo 宽一个量级,
 * 比 ACP 路径好接。（条数不写在这里 —— 那是会漂移的即时值，问 harness_models 要。）
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
    createOpencodeAdapter(),
    createClaudeAdapter(),
    createCodexAdapter(),
    // 层级④:Gemini 的 CLI 客户端已被退役(见 PLAN §3.6),改驱动本机运行的 Antigravity。
    // 它操作"当前会话"而非独立进程,且 read-only 只是标签 —— 派发前务必看 adapter 头注释。
    createAntigravityAdapter(),
  ];
}
