import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Adapter,
  ApprovalLevel,
  BridgeEvent,
  DetectResult,
  EventType,
  RunParser,
  SpawnPlan,
  TaskSpec,
  Usage,
} from '../types.ts';
import { DispatchRejected } from '../types.ts';
import { invocationFor, resolveCodex } from '../locate.ts';
import type { ResolvedCli } from '../locate.ts';
import { codexEgress, readCodexConfig } from '../egress.ts';

const execFileAsync = promisify(execFile);

/** 实测于 codex-cli 0.155.0-alpha.9.2:`-s` 的合法取值。 */
const SANDBOX: Record<ApprovalLevel, string> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'full': 'danger-full-access',
};

/** 实测的 `codex exec --json` 输出形状(2026-09-19,真跑一次得到):
 *
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"item.completed","item":{"id":"item_0","type":"error","message":"..."}}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"pong"}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,
 *     "cache_write_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N}}
 *
 * 只实测到 item.type 的 `agent_message` 与 `error` 两种。其它类型(工具调用、文件变更等)
 * 未实测,一律原样透传到 status 事件,不假装知道它们的字段名。
 *
 * 注意:`item.type === "error"` 也被用于**非致命告警**(如配置项被忽略),因此不能据此判失败;
 * 成败只由退出码决定。
 */
function createRun(spec: TaskSpec, taskId: string): RunParser {
  let seq = 0;
  let lastAgentText: string | undefined;
  /** Cumulative over turn.completed lines (one per `exec` turn). */
  let usage: Usage | undefined;
  let threadId: string | undefined;
  const errorTexts: string[] = [];

  const event = (type: EventType, extra: Partial<BridgeEvent> = {}): BridgeEvent => ({
    taskId,
    seq: seq++,
    harness: 'codex',
    tier: 3,
    type,
    at: Date.now(),
    ...extra,
  });

  return {
    parseLine(line: string): BridgeEvent[] {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        return [event('message', { text: line, raw: line })];
      }

      if (obj === null || typeof obj !== 'object') return [event('message', { text: line, raw: line })];
      switch (obj.type) {
        case 'thread.started':
          threadId = obj.thread_id;
          return [event('status', { text: `thread.started ${String(obj.thread_id)}`, raw: obj })];
        case 'turn.started':
          return [event('status', { text: 'turn.started', raw: obj })];
        case 'turn.completed': {
          // OpenAI semantics: input_tokens already includes cached_input_tokens and output_tokens
          // includes reasoning tokens, so they are not added again.
          const u = obj.usage ?? {};
          const num = (v: unknown) => (typeof v === 'number' ? v : 0);
          usage = {
            inputTokens: (usage?.inputTokens ?? 0) + num(u.input_tokens),
            outputTokens: (usage?.outputTokens ?? 0) + num(u.output_tokens),
            cacheReadTokens: (usage?.cacheReadTokens ?? 0) + num(u.cached_input_tokens),
          };
          return [event('usage', { usage, raw: obj })];
        }
        case 'item.completed':
        case 'item.started':
        case 'item.updated': {
          const item = obj.item ?? {};
          switch (item.type) {
            case 'agent_message':
              if (typeof item.text === 'string') lastAgentText = item.text;
              return [event('message', { text: item.text, raw: obj })];
            case 'error': {
              const message = String(item.message ?? '');
              errorTexts.push(message);
              return [event('error', { text: message, raw: obj })];
            }
            case 'file_change':
              // 实测到该类型存在(2026-09-19,写任务里出现两次:started + completed),
              // 但字段结构未细看 —— 原样透传,不猜字段名。改动内容以 git diff 事件为准。
              return [event('diff', { text: 'file_change', raw: obj })];
            case 'mcp_tool_call': {
              // 实测形状(2026-09-19):
              // {"type":"mcp_tool_call","server":"codex","tool":"list_mcp_resources",
              //  "arguments":{},"result":{"content":[{"type":"text","text":"..."}],"structured_content":null},
              //  "error":null,"status":"in_progress"|"completed"}
              // item.started 时 result 为 null(status=in_progress),item.completed 时才有结果。
              const out: BridgeEvent[] = [];
              const label = `${String(item.server)}.${String(item.tool)}`;
              if (item.status === 'in_progress') {
                out.push(event('tool_call', { text: label, raw: obj }));
              } else {
                const errText = item.error
                  ? String(item.error.message ?? JSON.stringify(item.error))
                  : undefined;
                out.push(event('tool_result', { text: errText ?? label, raw: obj }));
              }
              return out;
            }
            default:
              return [event('status', { text: `item.type=${String(item.type)}`, raw: obj })];
          }
        }
        default:
          return [event('status', { text: `codex:${String(obj?.type)}`, raw: obj })];
      }
    },
    finalize(exitCode: number) {
      return {
        text: lastAgentText,
        structured: undefined,
        usage,
        errorText: exitCode === 0 ? undefined : errorTexts.join('\n') || `exit ${exitCode}`,
        // threadId 由调度器用于 resume;此处不放进标准返回,避免污染统一模型
        // 需要时从 status 事件里读。
      };
    },
  };
}

export function createCodexAdapter(): Adapter {
  let cli: ResolvedCli | null = null;

  return {
    id: 'codex',
    tier: 3,
    displayName: 'Codex CLI',
    supportedApprovals: ['read-only', 'workspace-write', 'full'],
    // `codex exec --json` reports usage in turn.completed, i.e. when the run is over.
    usageReporting: 'final',

    async detect(): Promise<DetectResult> {
      let binary: string | null;
      try {
        binary = await resolveCodex();
      } catch (err) {
        cli = null;
        return { available: false, detail: (err as Error).message };
      }
      if (!binary) {
        return { available: false, detail: 'codex 不在 PATH / 常见安装目录 / %LOCALAPPDATA%\\OpenAI\\Codex\\bin;可用 LLMS_BRIDGE_CODEX_CLI 指定' };
      }
      cli = invocationFor(binary, binary);
      try {
        const { stdout } = await execFileAsync(cli.command, [...cli.prefixArgs, '--version'], { timeout: 20_000, windowsHide: true });
        return { available: true, version: `${stdout.trim()} | ${cli.detail}` };
      } catch (err) {
        return { available: false, detail: `--version 失败: ${(err as Error).message}` };
      }
    },

    async egress() {
      return codexEgress();
    },

    async credentialEnv(env) {
      // Its own vendor's variables plus whatever env_key its config.toml providers name.
      const cfg = await readCodexConfig(env);
      return ['OPENAI_*', 'CODEX_*', 'AZURE_OPENAI_*', ...(cfg?.envKeys ?? [])];
    },

    plan(spec: TaskSpec): SpawnPlan {
      if (!cli) throw new DispatchRejected('codex: 未探测成功,先调用 detect()');
      const sessionArgs =
        spec.session.mode === 'fresh'
          ? ['exec']
          : ['exec', spec.session.mode, spec.session.sessionId];

      const args = [
        ...cli.prefixArgs,
        ...sessionArgs,
        '--json',
        '-C',
        spec.cwd,
        '--skip-git-repo-check',
        '-s',
        SANDBOX[spec.approval],
      ];
      if (spec.outputSchemaPath) args.push('--output-schema', spec.outputSchemaPath);
      if (spec.model) args.push('-m', spec.model);
      // `-` = read the prompt from stdin (codex exec --help; verified 2026-10-16 that a prompt
      // starting with "--- a/" is accepted this way, while as an argument it is "unexpected").
      args.push('-');

      return { command: cli.command, args, stdin: spec.prompt };
    },

    createRun,
  };
}