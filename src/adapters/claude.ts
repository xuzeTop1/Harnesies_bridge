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

/** One API call's usage from a Claude-style `usage` object, cache tokens included in input. */
export function claudeCallUsage(u: any): Usage | undefined {
  if (!u || typeof u.input_tokens !== 'number') return undefined;
  const cacheRead = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0;
  const cacheWrite = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0;
  return {
    inputTokens: u.input_tokens + cacheRead + cacheWrite,
    outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

/**
 * Cumulative usage across the API calls of one run.
 *
 * Measured 2026-10-16 with Claude Code 2.1.302 against a local mock API: every `assistant` line
 * carries the usage of its API call as known at message start (output_tokens is not final yet),
 * lines of the same call share `message.id`, and the final `result.usage` is the **sum over all
 * calls**, cache tokens included. The first version used only `input_tokens + output_tokens` of the
 * final line (2,254 processed tokens were counted as 214) and attached usage to no event before
 * the end, so max_tokens could never stop a run.
 */
export class ClaudeUsageTracker {
  #perCall = new Map<string, Usage>();
  #final: Usage | undefined;

  onAssistant(messageId: unknown, usage: any): Usage | undefined {
    const u = claudeCallUsage(usage);
    if (!u) return undefined;
    const id = typeof messageId === 'string' && messageId.length > 0 ? messageId : `anon-${this.#perCall.size}`;
    const prev = this.#perCall.get(id);
    this.#perCall.set(id, {
      inputTokens: Math.max(prev?.inputTokens ?? 0, u.inputTokens ?? 0),
      outputTokens: Math.max(prev?.outputTokens ?? 0, u.outputTokens ?? 0),
      cacheReadTokens: Math.max(prev?.cacheReadTokens ?? 0, u.cacheReadTokens ?? 0),
      cacheWriteTokens: Math.max(prev?.cacheWriteTokens ?? 0, u.cacheWriteTokens ?? 0),
    });
    return this.current();
  }

  onResult(usage: any): Usage | undefined {
    const u = claudeCallUsage(usage);
    if (u) this.#final = u;
    return this.current();
  }

  current(): Usage | undefined {
    if (this.#final) return this.#final;
    if (this.#perCall.size === 0) return undefined;
    const sum: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const u of this.#perCall.values()) {
      sum.inputTokens! += u.inputTokens ?? 0;
      sum.outputTokens! += u.outputTokens ?? 0;
      sum.cacheReadTokens! += u.cacheReadTokens ?? 0;
      sum.cacheWriteTokens! += u.cacheWriteTokens ?? 0;
    }
    return sum;
  }

  isFinal(): boolean {
    return this.#final !== undefined;
  }
}

/** 实测的 `claude -p --output-format stream-json --verbose` 输出形状(2026-09-19 / 2026-10-16):
 *
 *   {"type":"system","subtype":"init","session_id":"...","model":"...", ...}
 *   {"type":"assistant","message":{"id":"msg_…","content":[...],"usage":{...}}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"...","usage":{...cumulative}}
 */
export function createClaudeStreamRun(harness: string, spec: TaskSpec, taskId: string): RunParser {
  let seq = 0;
  let lastResultText: string | undefined;
  let accumulated = '';
  const tracker = new ClaudeUsageTracker();
  let apiError: string | undefined;
  let isError = false;

  const event = (type: EventType, extra: Partial<BridgeEvent> = {}): BridgeEvent => ({
    taskId,
    seq: seq++,
    harness,
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
      if (obj === null || typeof obj !== 'object') return [event('message', { text: line, raw: line })];

      switch (obj.type) {
        case 'system':
          if (obj.subtype === 'init') {
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
            } else if (block?.type === 'thinking') {
              out.push(event('status', { text: '<thinking>', raw: block }));
            } else if (block?.type === 'tool_use') {
              out.push(event('tool_call', { text: String(block.name ?? ''), raw: block }));
            } else if (block?.type === 'tool_result') {
              out.push(event('tool_result', { raw: block }));
            } else {
              out.push(event('status', { text: `assistant.block=${String(block?.type)}`, raw: block }));
            }
          }
          const usage = tracker.onAssistant(obj.message?.id, obj.message?.usage);
          if (out.length === 0) out.push(event('status', { text: 'assistant(empty)', raw: obj }));
          // Usage rides on the first event of the line so the scheduler's budget check sees it now.
          if (usage) out[0] = { ...out[0]!, usage };
          return out;
        }
        case 'user': {
          // Tool results come back as `user` lines in stream-json.
          const blocks: any[] = Array.isArray(obj.message?.content) ? obj.message.content : [];
          const results = blocks.filter((b) => b?.type === 'tool_result');
          if (results.length > 0) return results.map((b) => event('tool_result', { raw: b }));
          return [event('status', { text: 'user', raw: obj })];
        }
        case 'result': {
          isError = obj.is_error === true;
          if (typeof obj.result === 'string') lastResultText = obj.result;
          const usage = tracker.onResult(obj.usage);
          if (isError) apiError = typeof obj.result === 'string' ? obj.result : `terminal_reason=${String(obj.terminal_reason)}`;
          return [event('result', { text: lastResultText, usage, raw: obj })];
        }
        default:
          return [event('status', { text: `${harness}:${String(obj.type)}`, raw: obj })];
      }
    },

    finalize(exitCode: number) {
      const text = lastResultText ?? (accumulated.length > 0 ? accumulated : undefined);
      return {
        text,
        structured: undefined,
        usage: tracker.current(),
        errorText: isError
          ? (apiError ?? `${harness} 报告 is_error`)
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
    usageReporting: 'streaming',

    async detect(): Promise<DetectResult> {
      try {
        cli = await resolveGlobalCli('claude', '@anthropic-ai/claude-code', 'claude');
      } catch (err) {
        cli = null;
        return { available: false, detail: (err as Error).message };
      }
      if (!cli) {
        return { available: false, detail: 'claude 不在 PATH(也不在常见安装目录),可用 LLMS_BRIDGE_CLAUDE_CLI 指定' };
      }
      try {
        const { stdout } = await execFileAsync(cli.command, [...cli.prefixArgs, '--version'], {
          timeout: 30_000,
          windowsHide: true,
        });
        return { available: true, version: `${stdout.trim()} | ${cli.detail}` };
      } catch (err) {
        return { available: false, detail: `--version 失败: ${(err as Error).message}` };
      }
    },

    /** 数据去向自报:用户用 cc-switch 一键就能在原生 Anthropic 和国内中转之间切换。 */
    async egress(spec?: Pick<TaskSpec, 'cwd'>): Promise<EgressReport> {
      return claudeEgress({ cwd: spec?.cwd });
    },

    credentialEnv(env) {
      const allowed = ['ANTHROPIC_*', 'CLAUDE_CODE_OAUTH_TOKEN'];
      if (env.CLAUDE_CODE_USE_BEDROCK) allowed.push('AWS_*');
      if (env.CLAUDE_CODE_USE_VERTEX) allowed.push('GOOGLE_*', 'GCLOUD_*', 'CLOUDSDK_*');
      return allowed;
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
      // The prompt goes to stdin (verified: `claude -p` reads it when no prompt argument is given).
      // On argv it hit OS length limits and any prompt starting with "-" was parsed as an option.
      return { command: cli.command, args, stdin: spec.prompt };
    },

    createRun: (spec, taskId) => createClaudeStreamRun('claude', spec, taskId),
  };
}
