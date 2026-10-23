import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  Adapter,
  ApprovalLevel,
  BridgeEvent,
  DetectResult,
  EventType,
  ModelCatalog,
  RunParser,
  SpawnPlan,
  TaskSpec,
  Usage,
} from '../types.ts';
import { DispatchRejected } from '../types.ts';
import { resolveCodex } from '../locate.ts';

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

      switch (obj?.type) {
        case 'thread.started':
          threadId = obj.thread_id;
          return [event('status', { text: `thread.started ${String(obj.thread_id)}`, raw: obj })];
        case 'turn.started':
          return [event('status', { text: 'turn.started', raw: obj })];
        case 'turn.completed': {
          const u = obj.usage ?? {};
          usage = {
            inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
            outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
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
  let binary: string | null = null;

  return {
    id: 'codex',
    tier: 3,
    displayName: 'Codex CLI',
    supportedApprovals: ['read-only', 'workspace-write', 'full'],

    async detect(): Promise<DetectResult> {
      binary = await resolveCodex();
      if (!binary) {
        return { available: false, detail: 'codex.exe 不在 %LOCALAPPDATA%\\OpenAI\\Codex\\bin\\ 也不在 PATH' };
      }
      try {
        const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 20_000, windowsHide: true });
        return { available: true, version: stdout.trim() };
      } catch (err) {
        return { available: false, detail: `--version 失败: ${(err as Error).message}` };
      }
    },

    plan(spec: TaskSpec): SpawnPlan {
      if (!binary) throw new DispatchRejected('codex: 未探测成功,先调用 detect()');

      // `codex exec resume` 的选项集与 `codex exec` 不同:实测 0.163 上不接受 `-C`,
      // 也没有 `-s`(报 unexpected argument '-C')。cwd 由子进程自己的 cwd 决定(调度器已设),
      // 沙箱只能经 `-c sandbox_mode=...` 覆盖;照搬 fresh 的参数会让每次 resume 都必然失败。
      const args = spec.session.mode === 'fresh'
        ? ['exec', '--json', '-C', spec.cwd, '--skip-git-repo-check', '-s', SANDBOX[spec.approval]]
        : [
            'exec',
            'resume',
            '--json',
            '--skip-git-repo-check',
            '-c',
            `sandbox_mode="${SANDBOX[spec.approval]}"`,
          ];

      // codex 没有 --effort 旗标,思考强度只能经 config 覆盖项传;resume 与 fresh 都认 -c。
      if (spec.effort) args.push('-c', `model_reasoning_effort="${spec.effort}"`);

      if (spec.session.mode !== 'fresh') args.push(spec.session.sessionId);
      if (spec.outputSchemaPath) args.push('--output-schema', spec.outputSchemaPath);
      if (spec.model) args.push('-m', spec.model);
      args.push(spec.prompt);

      return { command: binary, args };
    },

    /**
     * 思考档只能从 codex 自己的配置里读(`enabled-reasoning-efforts`),它没有 --help 清单。
     * 配置里没写就返回 null —— 不拿"我记得的几个值"去填,那是编。
     */
    async listEfforts(): Promise<ModelCatalog | null> {
      const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
      try {
        const text = await readFile(join(home, 'config.toml'), 'utf8');
        const block = /enabled-reasoning-efforts\s*=\s*\[([\s\S]*?)\]/.exec(text);
        if (!block) return null;
        const values = Array.from(block[1]!.matchAll(/"([^"]+)"/g)).map((m) => m[1]!);
        if (values.length === 0) return null;
        return {
          models: values,
          source: `${join(home, 'config.toml')} 的 enabled-reasoning-efforts`,
          checkedAt: Date.now(),
        };
      } catch {
        return null;
      }
    },

    createRun,

    /**
     * Codex 没有 listModels 子命令,但它自己缓存了服务端的模型清单(models_cache.json)。
     * 那是 **CLI 自己拉到的事实**,还带 fetched_at —— 比自己写死一份或猜一份都强。
     * 读不到就返回 null(调用方必须渲染成"未知",不许填默认值)。
     */
    async listModels(): Promise<ModelCatalog | null> {
      const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
      try {
        const raw = JSON.parse(await readFile(join(home, 'models_cache.json'), 'utf8')) as {
          fetched_at?: number | string;
          models?: { slug?: string; id?: string; display_name?: string }[];
        };
        const models = (raw.models ?? [])
          .map((m) => m.slug ?? m.id)
          .filter((m): m is string => typeof m === 'string' && m.length > 0);
        if (models.length === 0) return null;
        const parsed = typeof raw.fetched_at === 'number'
          ? raw.fetched_at
          : typeof raw.fetched_at === 'string'
            ? Date.parse(raw.fetched_at)
            : NaN;
        const checkedAt = Number.isFinite(parsed) ? parsed : Date.now();
        return {
          models,
          source: `${join(home, 'models_cache.json')}(CLI 自身缓存于 ${new Date(checkedAt).toISOString()})`,
          checkedAt,
        };
      } catch {
        return null;
      }
    },
  };
}