import { fileURLToPath } from 'node:url';
import type {
  Adapter,
  BridgeEvent,
  DetectResult,
  EventType,
  RunParser,
  SpawnPlan,
  TaskSpec,
} from '../types.ts';
import { DispatchRejected } from '../types.ts';
import { fetchVersion, readCdpPort } from '../antigravity-cdp.ts';

/**
 * Antigravity(Gemini)适配器 —— 层级④,驱动一个**正在运行的 GUI 应用**。
 *
 * 为什么不是 gemini CLI:那个客户端已被 Google 退役(见 PLAN §3.6),
 * 而同一个账号在 Antigravity 里功能正常。
 *
 * 边界(必须随结果一起被理解):
 *  - 它操作的是一条**当前会话**,不是独立进程;并发派发会互相覆盖 → 天然只能串行。
 *  - `read-only` 在这里**只是标签**:Antigravity 是 agent IDE,会不会动手取决于它的权限模式。
 *    适配器只保证"自己只点输入框和发送按钮",不保证 agent 不写盘。
 *  - 不支持 --model / --effort:模型与思考档在应用里选。传了就直接拒,不静默忽略。
 */

const HELPER = fileURLToPath(new URL('../antigravity-run.ts', import.meta.url));

function projectName(): string {
  return process.env.ANTIGRAVITY_PROJECT ?? 'debate';
}

function createRun(_spec: TaskSpec, taskId: string): RunParser {
  let seq = 0;
  let lastText = '';
  let finalText: string | undefined;
  const errors: string[] = [];

  const event = (type: EventType, extra: Partial<BridgeEvent> = {}): BridgeEvent => ({
    taskId,
    seq: seq++,
    harness: 'antigravity',
    tier: 4,
    type,
    at: Date.now(),
    ...extra,
  });

  return {
    parseLine(line: string): BridgeEvent[] {
      if (!line.trim()) return [];
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        return [event('message', { text: line, raw: line })];
      }
      switch (obj?.type) {
        case 'message': {
          // 助手子进程发的是**全文快照**,不是增量;这里保留最新一份即可。
          if (typeof obj.text === 'string') lastText = obj.text;
          return [event('message', { text: lastText, raw: obj })];
        }
        case 'result': {
          if (typeof obj.text === 'string') finalText = obj.text;
          return [event('result', { text: finalText, raw: obj })];
        }
        case 'error': {
          const text = String(obj.text ?? '');
          errors.push(text);
          return [event('error', { text, raw: obj })];
        }
        default:
          return [event('status', { text: String(obj?.text ?? obj?.type ?? ''), raw: obj })];
      }
    },
    finalize(exitCode: number) {
      return {
        text: finalText ?? (lastText || undefined),
        structured: undefined,
        usage: undefined,
        errorText: exitCode === 0 ? undefined : errors.join('\n') || `exit ${exitCode}`,
      };
    },
  };
}

export function createAntigravityAdapter(): Adapter {
  let detected = false;

  return {
    id: 'antigravity',
    tier: 4,
    displayName: 'Antigravity(Gemini,CDP)',
    supportedApprovals: ['read-only'],

    async detect(): Promise<DetectResult> {
      const port = readCdpPort();
      if (!port) {
        detected = true;
        return { available: false, detail: '读不到 DevToolsActivePort:Antigravity 没在运行,或未启用远程调试' };
      }
      const version = await fetchVersion(port);
      detected = true;
      if (!version) {
        return { available: false, detail: `登记端口 ${port} 上没有 CDP 响应(应用刚退出?)` };
      }
      return { available: true, version: `${version.Browser ?? 'Antigravity'} @127.0.0.1:${port}` };
    },

    plan(spec: TaskSpec): SpawnPlan {
      if (!detected) {
        throw new DispatchRejected('antigravity: 未探测成功,先调用 detect()');
      }
      if (spec.model) {
        throw new DispatchRejected(
          'antigravity: 不支持 --model —— 模型与思考档要在 Antigravity 应用里选。'
          + '静默忽略一个被指定的模型等于骗调用方,所以这里直接拒。',
        );
      }
      if (spec.effort) {
        throw new DispatchRejected(
          'antigravity: 不支持 --effort —— 思考档在应用内的模型选择器里("Gemini 3.8 Flash High")。',
        );
      }
      const args = [
        HELPER,
        '--project', projectName(),
        '--timeout-ms', String(spec.budget.maxWallMs),
      ];
      // fresh = 新开一条会话;resume = 继续当前这条(它没有可寻址的会话 id)。
      if (spec.session.mode === 'fresh') args.push('--new');
      args.push('--prompt', spec.prompt);
      return { command: process.execPath, args };
    },

    createRun,
  };
}
