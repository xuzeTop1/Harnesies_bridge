import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  Adapter,
  ApprovalLevel,
  BridgeEvent,
  DetectResult,
  ModelCatalog,
  EventType,
  RunParser,
  SpawnPlan,
  TaskSpec,
  Usage,
} from '../types.ts';
import { DispatchRejected } from '../types.ts';
import { localAppData, which } from '../locate.ts';

const execFileAsync = promisify(execFile);

/**
 * CodeBuddy(腾讯)—— 层级②,与 Claude Code 同构的 stream-json CLI。
 *
 * 本机存在两份 codebuddy CLI,而**哪一份登录着会变**,所以选哪份不能只靠固定优先级:
 * - WorkBuddy 内置(<LOCALAPPDATA>/Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy):
 *   2026-09-19 那阵子它复用 WorkBuddy 登录态,是本机第二个能真产出文本的 worker;
 *   2026-09-26 实测它已落到 2.147.0 且报 "Authentication required"(WorkBuddy 应用没升级,内置 CLI 就不涨)。
 * - PATH 上用户自装的那份:2026-09-26 是 2.158.0,已登录,模型清单比内置的宽。
 * 默认仍按"内置优先、PATH 兜底"(09-19 的判断,当时 PATH 那份确实没用),要用另一份必须**显式**指:
 * env `LLMS_BRIDGE_CODEBUDDY_CLI` 或 `<LLMS_BRIDGE_HOME>/config.json` 的 `codebuddyCli`。
 * 指不到就 detect 失败并说清是哪一处覆盖 —— 悄悄退回 bundled 会让调用方以为在用新版。
 *
 * 输出与 Claude stream-json 同构:system/init → assistant → result。
 * 注意 `thinking` 块也以 assistant 出现,不能把它的内容当成回答。
 */
const PERMISSION_MODE: Record<ApprovalLevel, string> = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  full: 'bypassPermissions',
};

function createRun(spec: TaskSpec, taskId: string): RunParser {
  let seq = 0;
  let lastResultText: string | undefined;
  let accumulated = '';
  let usage: Usage | undefined;
  let fatal: string | undefined;
  let isError = false;

  const event = (type: EventType, extra: Partial<BridgeEvent> = {}): BridgeEvent => ({
    taskId,
    seq: seq++,
    harness: 'codebuddy',
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
            return [
              event('status', {
                text: 'init model=' + String(obj.model) + ' key=' + String(obj.apiKeySource),
                raw: obj,
              }),
            ];
          }
          return [event('status', { text: 'system:' + String(obj.subtype), raw: obj })];
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
              out.push(event('status', { text: 'assistant.block=' + String(block?.type), raw: block }));
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
          const u = obj.usage;
          if (u && typeof u.input_tokens === 'number') {
            usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
          }
          if (isError) fatal = typeof obj.result === 'string' ? obj.result : 'codebuddy 报告 is_error';
          return [event('result', { text: lastResultText, usage, raw: obj })];
        }
        default:
          return [event('status', { text: 'codebuddy:' + String(obj?.type), raw: obj })];
      }
    },

    finalize(exitCode: number) {
      const text = lastResultText ?? (accumulated.length > 0 ? accumulated : undefined);
      return {
        text,
        structured: undefined,
        usage,
        errorText: isError
          ? (fatal ?? 'codebuddy 报告 is_error')
          : exitCode === 0
            ? undefined
            : 'exit ' + exitCode,
      };
    },
  };
}

/** WorkBuddy 捆绑的 CLI 路径。装在应用目录里、随应用升级变动,故动态拼而不写死版本。 */
function bundledCliPath(): string | null {
  const local = localAppData();
  if (!local) return null;
  const p = join(
    local,
    'Programs',
    'WorkBuddy',
    'resources',
    'app.asar.unpacked',
    'cli',
    'bin',
    'codebuddy',
  );
  return existsSync(p) ? p : null;
}

/** 调用方显式指定的 CLI 路径。env 优先于配置文件 —— env 更临时、更可能是本次会话故意给的。 */
function userCliOverride(opts: CodeBuddyAdapterOptions): { path: string; whence: string } | null {
  const env = opts.env ?? process.env;
  const fromEnv = env.LLMS_BRIDGE_CODEBUDDY_CLI?.trim();
  if (fromEnv) return { path: fromEnv, whence: 'env LLMS_BRIDGE_CODEBUDDY_CLI' };

  const path =
    opts.configPath ??
    join(env.LLMS_BRIDGE_HOME ?? join(homedir(), '.llms-bridge'), 'config.json');
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (raw === null) return null;
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new CliConfigError(`${path} 解析失败: ${(err as Error).message}`);
  }
  const v = (cfg as { codebuddyCli?: unknown })?.codebuddyCli;
  if (typeof v === 'string' && v.trim()) return { path: v.trim(), whence: `${path} 的 codebuddyCli` };
  return null;
}

/** 配置文件坏掉时必须响,不能当成"没配置" —— 那会把用户解除了他自己的限制。 */
class CliConfigError extends Error {}

/** 覆盖路径解析出的启动方式;null = 这条路径没法当 CLI 用。 */
interface CliInvocation {
  command: string;
  prefixArgs: string[];
  how: string;
}

/**
 * npm 在 Windows 装的 shim 不能直接喂给 spawn(`.cmd` → EINVAL),也不能过 shell 解释
 * (用户 prompt 会变成 cmd 的命令行 —— 注入面,与 AGENTS.md 铁律相反)。
 * 这里只**读** shim 文本、把 `"%_prog%" "<入口>" %*` 那行的第二个带引号参数取出来当 js 入口跑。
 */
function shimToInvocation(shimPath: string): CliInvocation | null {
  let text: string;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const entryRaw = quoted.find(
    (q) => /node_modules/i.test(q) && !/node\.exe$/i.test(q),
  );
  if (!entryRaw) return null;
  const shimDir = dirname(shimPath);
  const entry = resolve(shimDir, entryRaw.replace(/^%[^%]*%[\\\/]?/, '').replace(/^\\/, ''));
  if (!existsSync(entry)) return null;
  return {
    command: process.execPath,
    prefixArgs: [entry],
    how: `${basename(shimPath)} shim → node ${entry}`,
  };
}

function invocationForPath(p: string, whence: string): CliInvocation {
  if (/\.(exe|com)$/i.test(p)) return { command: p, prefixArgs: [], how: whence + ' @ ' + p };
  if (/\.(cmd|bat)$/i.test(p)) {
    const viaShim = shimToInvocation(p);
    if (viaShim) return viaShim;
    return {
      command: process.execPath,
      prefixArgs: [p],
      how: `${whence} @ ${p}(shim 里没解析出入口,只能整个当 js 喂给 node)`,
    };
  }
  // 含无扩展名的 npm 入口:Windows 上 spawn 不动它(bash 脚本),而 npm 的 bin 本质是 js,
  // 用当前 node 跑最稳(WorkBuddy 内置那份走的就是这条路)。
  return {
    command: process.execPath,
    prefixArgs: [p],
    how: whence + ' → node ' + p,
  };
}

export interface CodeBuddyAdapterOptions {
  /** 测试注入:指向一份 fixture config.json */
  configPath?: string;
  /** 测试注入:进程 env */
  env?: NodeJS.ProcessEnv;
}

export function createCodeBuddyAdapter(opts: CodeBuddyAdapterOptions = {}): Adapter {
  let entry: { command: string; prefixArgs: string[]; label: string } | null = null;

  return {
    id: 'codebuddy',
    tier: 2,
    displayName: 'CodeBuddy(腾讯)',
    supportedApprovals: ['read-only', 'workspace-write', 'full'],

    async detect(): Promise<DetectResult> {
      let override: { path: string; whence: string } | null = null;
      try {
        override = userCliOverride(opts);
      } catch (err) {
        return { available: false, detail: (err as Error).message };
      }
      if (override) {
        if (!existsSync(override.path)) {
          return {
            available: false,
            detail:
              `${override.whence} 指向的 codebuddy 不存在: ${override.path}。` +
              '桥**不会**悄悄退回 WorkBuddy 内置那份 —— 你以为在用哪份就是在用哪份。',
          };
        }
        const inv = invocationForPath(override.path, override.whence);
        entry = { command: inv.command, prefixArgs: inv.prefixArgs, label: inv.how };
      } else {
        const bundled = bundledCliPath();
        if (bundled) {
          entry = {
            command: process.execPath,
            prefixArgs: [bundled],
            label: 'WorkBuddy bundled @ ' + bundled,
          };
        } else {
          const onPath = await which('codebuddy');
          if (!onPath) {
            return {
              available: false,
              detail: '既没有 WorkBuddy 捆绑的 cli/bin/codebuddy,也不在 PATH',
            };
          }
          entry = { command: onPath, prefixArgs: [], label: 'PATH @ ' + onPath + '(注意:此份可能未登录)' };
        }
      }

      try {
        const { stdout } = await execFileAsync(entry.command, [...entry.prefixArgs, '--version'], {
          timeout: 60_000,
          windowsHide: true,
        });
        return { available: true, version: stdout.trim() + ' | ' + entry.label };
      } catch (err) {
        return { available: false, detail: '--version 失败: ' + (err as Error).message };
      }
    },

    /**
     * codebuddy 的 `--help` 会把支持的模型**全部列出来**(`Currently supported: (auto, …)`),
     * 所以这份清单是它自己声明的,不是我们整理的。解析不到就返回 null —— 宁可"未知"也不编。
     * 清单会随版本漂移,故每次现取并带 `checkedAt`。
     */
    async listModels(): Promise<ModelCatalog | null> {
      if (!entry) return null; // 未探测;调度器保证先跑过 detectAll()
      try {
        const { stdout } = await execFileAsync(entry.command, [...entry.prefixArgs, '--help'], {
          timeout: 60_000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        });
        // --help 会按终端宽度折行,先压平再匹配,否则列表被切断就会漏读。
        const flat = stdout.replace(/\s+/g, ' ');
        const m = /Currently supported:\s*\(([^)]+)\)/.exec(flat);
        if (!m) return null;
        const models = m[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (models.length === 0) return null;
        return { models, source: 'codebuddy --help 的 --model 行', checkedAt: Date.now() };
      } catch {
        return null;
      }
    },

    plan(spec: TaskSpec): SpawnPlan {
      if (!entry) throw new DispatchRejected('codebuddy: 未探测成功,先调用 detect()');
      const args = [
        ...entry.prefixArgs,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        PERMISSION_MODE[spec.approval],
      ];
      if (spec.model) args.push('--model', spec.model);
      if (spec.session.mode === 'resume') args.push('-r', spec.session.sessionId);
      args.push(spec.prompt);
      return { command: entry.command, args };
    },

    createRun,
  };
}