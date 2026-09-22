import type {
  Adapter,
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
import { resolveGlobalCli } from '../locate.ts';
import type { ResolvedCli } from '../locate.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * OpenCode CLI —— 层级③(一次性子进程),但带会话续接。
 *
 * 为什么值得单独一个适配器,而不是蹭 mimo 那条 ACP:
 * 它一家就自报 **443 个模型 / 7 家提供商**(`opencode models`),是本机模型面最宽的 worker;
 * 而且 `opencode run` 有 `--format json`(可直接解析)与 `--session/--continue/--fork`(会话语义),
 * 比层级① 的 ACP 路径好接。实测 free 档 `opencode/big-pickle` 零成本可产出文本。
 *
 * **只声明 read-only**:`--auto` 的官方说明是
 * "auto-approve permissions that are not explicitly denied (dangerous!)" —— 按 AGENTS.md 铁律二,
 * 这类绕过审批的旗标默认禁用,所以写档位在这里不是"没做",而是**刻意不做**。
 * 实测不带 `--auto` 时读文件会自动放行(不会卡在权限询问),所以只读是可兑现的。
 */
export function createOpencodeAdapter(): Adapter {
  let entry: ResolvedCli | null = null;
  let catalog: ModelCatalog | null = null;

  return {
    id: 'opencode',
    tier: 3,
    displayName: 'OpenCode CLI(443 模型/7 提供商)',
    supportedApprovals: ['read-only'],

    async detect(): Promise<DetectResult> {
      entry = await resolveGlobalCli('opencode', 'opencode-ai');
      if (!entry) {
        return {
          available: false,
          detail: '未找到 opencode(或其 npm 入口无法解析:平台包 opencode-windows-x64 缺失时 --version 会直接失败)',
        };
      }
      try {
        const { stdout } = await execFileAsync(entry.command, [...entry.prefixArgs, '--version'], {
          timeout: 60_000,
          windowsHide: true,
        });
        return { available: true, version: stdout.trim() + ' | ' + entry.detail };
      } catch (err) {
        return { available: false, detail: '--version 失败: ' + (err as Error).message };
      }
    },

    /** 清单来自 `opencode models`,是它自己打印的 —— 不是我整理的。 */
    async listModels(): Promise<ModelCatalog | null> {
      if (!entry) return null;
      try {
        const { stdout } = await execFileAsync(entry.command, [...entry.prefixArgs, 'models'], {
          timeout: 120_000,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        });
        const models = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l.includes('/'));
        if (models.length === 0) return null;
        catalog = { models, source: 'opencode models', checkedAt: Date.now() };
        return catalog;
      } catch {
        return null;
      }
    },

    plan(spec: TaskSpec): SpawnPlan {
      if (!entry) throw new DispatchRejected('opencode: 未探测成功,先调用 detect()');
      if (spec.approval !== 'read-only') {
        // 不静默降级:想开写档位必须先解决 --auto 的审批问题,见文件头注释。
        throw new DispatchRejected(
          'opencode: 只实现 read-only;写档位需要 --auto(其自述为 dangerous),按铁律二默认禁用',
        );
      }
      const args = [...entry.prefixArgs, 'run', '--format', 'json'];
      if (spec.model) args.push('--model', spec.model);
      if (spec.session.mode === 'resume' || spec.session.mode === 'fork') {
        args.push('--session', spec.session.sessionId);
        if (spec.session.mode === 'fork') args.push('--fork');
      }
      args.push(spec.prompt);
      return { command: entry.command, args };
    },

    createRun(spec: TaskSpec, taskId: string): RunParser {
      let seq = 0;
      let text = '';
      let usage: Usage | undefined;
      const event = (type: EventType, extra: Partial<BridgeEvent> = {}): BridgeEvent => ({
        taskId,
        seq: seq++,
        harness: 'opencode',
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
            return [];
          }
          if (obj.type === 'text' && typeof obj.part?.text === 'string') {
            text += obj.part.text;
            return [event('message', { text: obj.part.text, raw: obj })];
          }
          if (obj.type === 'step_finish') {
            const t = obj.part?.tokens;
            if (t) {
              usage = {
                inputTokens: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
                outputTokens: t.output ?? 0,
              };
            }
            return [event('status', { text: `step_finish cost=${obj.part?.cost ?? 0}`, raw: obj })];
          }
          return [];
        },

        finalize(exitCode: number) {
          return {
            text: text.trim() || undefined,
            usage,
            errorText:
              exitCode === 0 || text.trim().length > 0
                ? undefined
                : `opencode 退出码 ${exitCode} 且无文本输出`,
          };
        },
      };
    },
  };
}
