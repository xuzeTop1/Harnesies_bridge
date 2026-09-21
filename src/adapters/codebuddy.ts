import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
 * 实测(2026-09-19):WorkBuddy 自带一份 codebuddy CLI
 * (<LOCALAPPDATA>/Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy,
 * Node 启动脚本),它**复用 WorkBuddy 的登录态**(apiKeySource=copilot.tencent.com,
 * 模型 hy4-preview),因此不需要任何新凭证 —— 本机除 codex 外唯一能真正产出文本的 harness。
 *
 * 全局 npm 装的那份(codebuddy 1.2.1)反而**未登录**(报 "Authentication required"),
 * 所以优先用 WorkBuddy 捆绑版,只把 PATH 版当兜底 —— 按 PATH 找只会找到没用那份。
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

export function createCodeBuddyAdapter(): Adapter {
  let entry: { command: string; prefixArgs: string[]; label: string } | null = null;

  return {
    id: 'codebuddy',
    tier: 2,
    displayName: 'CodeBuddy(腾讯;复用 WorkBuddy 登录态)',
    supportedApprovals: ['read-only', 'workspace-write', 'full'],

    async detect(): Promise<DetectResult> {
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