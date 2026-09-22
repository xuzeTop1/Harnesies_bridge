import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Adapter,
  ApprovalLevel,
  BridgeEvent,
  DetectResult,
  EgressReport,
  EventType,
  RunParser,
  SpawnPlan,
  TaskSpec,
  Usage,
} from '../types.ts';
import { DispatchRejected } from '../types.ts';
import { resolveGlobalCli } from '../locate.ts';
import type { ResolvedCli } from '../locate.ts';
import { claudeEgress } from '../egress.ts';

const execFileAsync = promisify(execFile);

/** 实测于 Claude Code 2.1.224:`--permission-mode` 的合法取值。 */
const PERMISSION_MODE: Record<ApprovalLevel, string> = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'full': 'bypassPermissions',
};

/** 实测的 `claude -p --output-format stream-json --verbose` 输出形状(2026-09-19):
 *
 *   {"type":"system","subtype":"init","session_id":"...","model":"...",
 *    "permissionMode":"default","tools":[...],"skills":[...],"agents":[...]}
 *   {"type":"assistant","message":{...,"content":[{"type":"text","text":"..."}]}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"...",
 *    "session_id":"...","total_cost_usd":N,"usage":{...},"terminal_reason":"..."}
 *
 * 本次实测因账号余额不足(402)未拿到正常回复,但三种事件的形状已确认。
 * `assistant` 的 content 是数组,可能混有 tool_use 等块,故按块类型分别映射。
 */
function createRun(spec: TaskSpec, taskId: string): RunParser {
  let seq = 0;
  let lastResultText: string | undefined;
  let accumulated = '';
  let usage: Usage | undefined;
  let sessionId: string | undefined;
  let apiError: string | undefined;
  let isError = false;

  const event = (type: EventType, extra: Partial<BridgeEvent> = {}): BridgeEvent => ({
    taskId,
    seq: seq++,
    harness: 'claude',
    tier: 2,
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

      switch (obj?.type) {
        case 'system':
          if (obj.subtype === 'init') {
            if (typeof obj.session_id === 'string') sessionId = obj.session_id;
            return [event('status', { text: `init model=${String(obj.model)} mode=${String(obj.permissionMode)}`, raw: obj })];
          }
          return [event('status', { text: `system:${String(obj.subtype)}`, raw: obj })];
        case 'assistant': {
          const blocks: any[] = Array.isArray(obj.message?.content) ? obj.message.content : [];
          const out: BridgeEvent[] = [];
          for (const block of blocks) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              accumulated += block.text;
              out.push(event('message', { text: block.text, raw: obj }));
            } else if (block?.type === 'tool_use') {
              out.push(event('tool_call', { text: String(block.name ?? ''), raw: block }));
            } else if (block?.type === 'tool_result') {
              out.push(event('tool_result', { raw: block }));
            } else {
              out.push(event('status', { text: `assistant.block=${String(block?.type)}`, raw: block }));
            }
          }
          const u = obj.message?.usage;
          if (u && typeof u.input_tokens === 'number') {
            usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
          }
          return out.length > 0 ? out : [event('status', { text: 'assistant(empty)', raw: obj })];
        }
        case 'result': {
          isError = obj.is_error === true;
          if (typeof obj.result === 'string') lastResultText = obj.result;
          if (typeof obj.session_id === 'string') sessionId = obj.session_id;
          const u = obj.usage;
          if (u && typeof u.input_tokens === 'number') {
            usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
          }
          if (isError) apiError = typeof obj.result === 'string' ? obj.result : `terminal_reason=${String(obj.terminal_reason)}`;
          return [event('result', { text: lastResultText, usage, raw: obj })];
        }
        default:
          return [event('status', { text: `claude:${String(obj?.type)}`, raw: obj })];
      }
    },

    finalize(exitCode: number) {
      const text = lastResultText ?? (accumulated.length > 0 ? accumulated : undefined);
      return {
        text,
        structured: undefined,
        usage,
        errorText: isError
          ? (apiError ?? 'claude 报告 is_error')
          : exitCode === 0
            ? undefined
            : `exit ${exitCode}`,
      };
    },
  };
}

export function createClaudeAdapter(): Adapter {
  let cli: ResolvedCli | null = null;

  return {
    id: 'claude',
    tier: 2,
    displayName: 'Claude Code',
    supportedApprovals: ['read-only', 'workspace-write', 'full'],

    async detect(): Promise<DetectResult> {
      cli = await resolveGlobalCli('claude', '@anthropic-ai/claude-code');
      if (!cli) {
        return { available: false, detail: 'claude 不在 PATH,或 @anthropic-ai/claude-code 的 package.json 里没有可用 bin' };
      }
      try {
        const { stdout } = await execFileAsync(cli.command, [...cli.prefixArgs, '--version'], {
          timeout: 30_000,
          windowsHide: true,
        });
        return { available: true, version: stdout.trim() };
      } catch (err) {
        return { available: false, detail: `--version 失败: ${(err as Error).message}` };
      }
    },

    /** 数据去向自报:用户用 cc-switch 一键就能在原生 Anthropic 和国内中转之间切换。 */
    async egress(): Promise<EgressReport> {
      return claudeEgress();
    },

    plan(spec: TaskSpec): SpawnPlan {
      if (!cli) throw new DispatchRejected('claude: 未探测成功,先调用 detect()');
      const args = [...cli.prefixArgs,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        PERMISSION_MODE[spec.approval],
      ];
      if (spec.outputSchemaPath) args.push('--json-schema', spec.outputSchemaPath);
      if (spec.model) args.push('--model', spec.model);
      if (spec.session.mode === 'resume') args.push('--resume', spec.session.sessionId);
      else if (spec.session.mode === 'fork') args.push('--resume', spec.session.sessionId, '--fork-session');
      args.push(spec.prompt);
      return { command: cli.command, args };
    },

    createRun,
  };
}