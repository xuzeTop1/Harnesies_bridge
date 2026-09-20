import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type {
  Adapter,
  BridgeEvent,
  DetectResult,
  EventType,
  RunParser,
  SpawnPlan,
  TaskSpec,
  Usage,
} from '../types.ts';
import { DispatchRejected } from '../types.ts';
import { resolveGlobalCli } from '../locate.ts';
import type { ResolvedCli } from '../locate.ts';

/**
 * 通用 ACP(Agent Client Protocol)适配器 —— 层级①。
 *
 * 协议已实测(2026-09-19,对 qwen):
 *   帧格式:ndjson(每行一个 JSON-RPC 消息),走 stdio。
 *   initialize  { protocolVersion: 1, clientCapabilities: {} }
 *     → { protocolVersion: 1, agentInfo: {name,title,version}, authMethods: [...],
 *         agentCapabilities: { loadSession, promptCapabilities, sessionCapabilities:{list,resume}, ... } }
 *   session/new { cwd, mcpServers: [] } → { sessionId } 或 error
 *     实测未鉴权时返回: { code: -32000, message: "Authentication required: ..." }
 *
 * **未实测**(本机 qwen 未鉴权,走不到提示词阶段,不敢照记忆写死):
 *   1. session/prompt 的响应形状与 stopReason 取值;
 *   2. `session/update` 通知里 update.sessionUpdate 的取值与 content 结构
 *      (按 ACP 规范应为 agent_message_chunk / agent_thought_chunk / tool_call 等,待实测收紧);
 *   3. 代理反向发起的 `session/request_permission` 请求的选项结构。
 *      当前一律回 -32601 并记 error 事件 —— 宁可显式失败,也不挂死等一个不会来的响应。
 *
 * 关于审批档位:ACP 没有"权限模式"开关,权限是按请求逐个协商的。
 * 因此 read-only 的语义应是"拒绝一切权限请求",full 才是"全允";
 * 由于 (3) 尚未实测,当前行为等价于**全部拒绝**(最保守),这是有意的。
 */

/** 允许的 approval 档位在 ACP 下的语义(待 (3) 实测后落地)。 */
const ACP_PROTOCOL_VERSION = 1;

/**
 * 层级① 尚未接的 spec 选项。**两个都是 false 意味着"传了也不生效"**。
 *
 * - 模型选择:ACP 里大概走 `session/new` 的模型字段或单独的 set-model 方法;
 * - 会话选择:resume / fork 在 ACP 里对应 loadSession / 会话列表(能力里确实报了
 *   `sessionCapabilities: {list, resume}`),但本机几家都没到能验证那一步。
 *
 * 两处都**不照记忆猜字段名**。传了不会被采纳,但也不会静默丢弃 ——
 * 由 `unsupportedOptionEvents()` 在连接后显式回一条 error 事件。
 * 需要模型级差异请用 codex / claude(层级②③)。
 */
const ACP_MODEL_SELECTION_WIRED = false;
const ACP_SESSION_SELECTION_WIRED = false;

/**
 * 层级① 是否已接"写档位审批"。
 *
 * **当前是 false,所以 supportedApprovals 只声明 read-only。**
 * ACP 没有权限模式开关,权限是**按请求逐个协商**的(`session/request_permission`)。
 * 我们的处理器至今一律回 -32601(全拒),等价于只读。
 *
 * 在这种情况下仍然对外声明 workspace-write / full 会是个谎:调用方以为拿到了写权限,
 * 实际对方每个权限请求都被拒 —— 这种静默降级比"显式拒绝"危险得多
 * (同 AGENTS.md 铁律三那条"不许把没隔离混成隔离了")。
 *
 * 等 request_permission 的形状实测清楚、并按 approval 档位应答之后,再把它置 true
 * 并放开档位。在此之前层级① **只能当只读 worker 用**。
 */
const ACP_WRITE_APPROVALS_WIRED = false;

interface AcpInitResult {
  agentName?: string;
  agentVersion?: string;
  protocolVersion?: number;
  authMethodCount: number;
  /** session/new 失败时的原因(通常是未鉴权)。 */
  sessionError?: string;
}

/**
 * detect() 用的轻量握手:initialize + session/new,拿到真实版本与鉴权状态后即断开。
 * 存在的意义:ACP 需要鉴权前置,只验二进制存在会把"装了但用不了"报成可用。
 */
function acpProbe(cli: ResolvedCli, acpArgs: string[], timeoutMs: number): Promise<AcpInitResult | null> {
  return new Promise((resolve) => {
    const child = spawn(cli.command, [...cli.prefixArgs, ...acpArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buffer = '';
    let settled = false;
    const result: AcpInitResult = { authMethodCount: 0 };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      resolve(result.protocolVersion === undefined ? null : result);
    };

    const timer = setTimeout(finish, timeoutMs);

    const send = (obj: unknown) => {
      if (child.stdin.destroyed) return;
      child.stdin.write(JSON.stringify(obj) + '\n');
    };

    child.on('error', finish);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line.length === 0) continue;

        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (msg.id === 1 && msg.result) {
          result.protocolVersion = msg.result.protocolVersion;
          result.agentName = msg.result.agentInfo?.name;
          result.agentVersion = msg.result.agentInfo?.version;
          result.authMethodCount = Array.isArray(msg.result.authMethods) ? msg.result.authMethods.length : 0;
          send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
        } else if (msg.id === 2) {
          if (msg.error) result.sessionError = String(msg.error.message ?? msg.error.code);
          finish();
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
    });
  });
}

function createRun(spec: TaskSpec, taskId: string, harness: string): RunParser {
  let seq = 0;
  let write: ((line: string) => void) | null = null;
  let sessionId: string | null = null;
  let accumulated = '';
  let usage: Usage | undefined;
  let stopReason: string | undefined;
  let fatal: string | undefined;
  let finished = false;

  const event = (type: EventType, extra: Partial<BridgeEvent> = {}): BridgeEvent => ({
    taskId,
    seq: seq++,
    harness,
    tier: 1,
    type,
    at: Date.now(),
    ...extra,
  });

  const send = (obj: unknown): void => {
    write?.(JSON.stringify(obj));
  };

  /**
   * 把本层级**不会采纳**的 spec 选项列出来并转成 error 事件。
   * 宁可让主脑看到"这项没生效",也不要让它以为生效了 —— 见 AGENTS.md 的静默降级禁令。
   */
  const unsupportedOptionEvents = (): BridgeEvent[] => {
    const ignored: string[] = [];
    if (!ACP_MODEL_SELECTION_WIRED && spec.model !== undefined) {
      ignored.push(`model=${spec.model}(实际用该 agent 的默认模型)`);
    }
    if (!ACP_SESSION_SELECTION_WIRED && spec.session.mode !== 'fresh') {
      ignored.push(`session.mode=${spec.session.mode}(层级① 每次新建会话,不支持 resume/fork)`);
    }
    if (spec.outputSchemaPath !== undefined) {
      ignored.push(`output_schema=${spec.outputSchemaPath}(层级① 不支持结构化输出约束)`);
    }
    return ignored.map((item) => event('error', { text: `层级① 尚未支持该选项,已被忽略: ${item}` }));
  };

  /**
   * 把 agent 请求的路径限制在本次任务的 cwd 内(写任务时 cwd 已被换成 worktree)。
   * 逐级回退到"最近的已存在祖先"再 realpath,是为了挡掉用符号链接或 `..` 逃出 worktree 的写法 ——
   * 目标文件本身还不存在(新建是常态),所以不能直接 realpath 目标。
   */
  const confine = (p: string): string => {
    if (typeof p !== 'string' || p.length === 0) throw new Error('path 缺失或非法');
    const root = realpathSync(spec.cwd);
    const abs = resolve(root, p);
    let probe = abs;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const real = realpathSync(probe);
    if (real !== root && !real.startsWith(root + sep)) {
      throw new Error(`路径越界,已拒绝: ${p}`);
    }
    return abs;
  };

  const reply = (id: number, result?: unknown, error?: { code: number; message: string }) =>
    send(
      error === undefined
        ? { jsonrpc: '2.0', id, result: result ?? {} }
        : { jsonrpc: '2.0', id, error },
    );

  /**
   * 代理反向发起的请求。ACP 把**文件读写放在客户端这一侧**(`fs/read_text_file` /
   * `fs/write_text_file`),所以桥不实现它们,层级① 的 agent 就物理上写不了任何文件 ——
   * 这才是此前 `supportedApprovals` 只能声明 read-only 的真正原因。
   *
   * 用同步 fs 是有意的:`parseLine` 是同步契约,没有异步回推事件的通道。
   * 这些是 worktree 里的文本文件,阻塞几毫秒换掉一套异步 plumbing 是划算的。
   */
  const handleAgentRequest = (msg: any): BridgeEvent[] => {
    const method = String(msg.method);
    const id = msg.id as number;

    if (method === 'session/request_permission') {
      // 只能从**对方给出的** options 里选:qwen 的校验器会明确拒绝不在集合内的 optionId,
      // 所以绝不自己编一个 id。
      const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
      const want =
        spec.approval === 'read-only'
          ? ['reject_once', 'reject_always']
          : // 最小权限:allow_once 优先,永不选 allow_always —— 那是把整个会话的写权限一次批掉,
            // 超出本次任务的 approval,也超出 worktree 隔离所承诺的范围。
            ['allow_once', 'allow_always'];
      const pick = want
        .map((kind) => options.find((o: any) => o?.kind === kind))
        .find((o: any) => typeof o?.optionId === 'string');

      if (pick === undefined) {
        reply(id, { outcome: { outcome: 'cancelled' } });
        return [
          event('error', {
            text: `权限请求没有可用选项(期望 ${want.join('/')}),已回 cancelled`,
            raw: msg,
          }),
        ];
      }
      // 注意形状:zRequestPermissionResponse.outcome 是**嵌套的判别联合**
      // `{outcome:'selected', optionId}`,不是平铺的 `{outcome:'selected',optionId}`。
      reply(id, { outcome: { outcome: 'selected', optionId: pick.optionId } });
      const kind = String(pick.kind ?? '?');
      return [
        event(kind.startsWith('allow') ? 'tool_call' : 'error', {
          text: `权限请求 ${kind} → ${String(pick.name ?? pick.optionId)}(approval=${spec.approval})`,
          raw: msg,
        }),
      ];
    }

    if (method === 'fs/read_text_file') {
      try {
        const abs = confine(String(msg.params?.path));
        const content = readFileSync(abs, 'utf8');
        reply(id, { content });
        return [event('tool_result', { text: `读取 ${msg.params.path}(${content.length} 字符)`, raw: msg })];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply(id, undefined, { code: -32603, message });
        return [event('error', { text: `fs/read_text_file 失败: ${message}`, raw: msg })];
      }
    }

    if (method === 'fs/write_text_file') {
      if (spec.approval === 'read-only') {
        reply(id, undefined, { code: -32603, message: '本任务 approval=read-only,不允许写文件' });
        return [
          event('error', {
            text: `拒绝写入 ${String(msg.params?.path)}:read-only 档位不允许改动文件`,
            raw: msg,
          }),
        ];
      }
      try {
        const abs = confine(String(msg.params?.path));
        const existed = existsSync(abs);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, String(msg.params?.content ?? ''), 'utf8');
        reply(id, {});
        return [
          event('tool_call', {
            text: `写入 ${msg.params.path}${existed ? '(覆盖)' : '(新建)'}`,
            raw: msg,
          }),
        ];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply(id, undefined, { code: -32603, message });
        return [event('error', { text: `fs/write_text_file 失败: ${message}`, raw: msg })];
      }
    }

    // terminal/* 一律拒绝:那等于让 agent 绕过沙箱直接执行命令,写档位管不住它。
    reply(id, undefined, { code: -32601, message: `llms-bridge 不代理该方法: ${method}` });
    return [event('error', { text: `代理请求了不被代理的方法: ${method}(已应答,未挂死)`, raw: msg })];
  };

  return {
    onStart(w) {
      write = w;
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        // 必须声明 fs 能力:SDK 里 `zClientCapabilities.fs` 默认是
        // `{readTextFile:false, writeTextFile:false}`,不声明 agent 就**不会来调用** fs/*,
        // 我们实现的处理器等于不存在。writeTextFile 只在非 read-only 档位声明 ——
        // 不声明比"声明了再在请求里拒"更省,也不给对方留下"客户端支持写"的错觉。
        params: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: spec.approval !== 'read-only' },
            terminal: false,
          },
        },
      });
    },

    parseLine(line: string): BridgeEvent[] {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return [event('message', { text: line, raw: line })];
      }

      // 代理反向发起的请求:必须应答,否则对方会一直等。
      if (msg.id !== undefined && typeof msg.method === 'string') {
        return handleAgentRequest(msg);
      }

      // 我方的响应
      if (msg.id !== undefined) {
        if (msg.id === 1) {
          if (msg.error) {
            fatal = `initialize 失败: ${String(msg.error.message ?? msg.error.code)}`;
            finished = true;
            return [event('error', { text: fatal, raw: msg })];
          }
          const info = msg.result?.agentInfo ?? {};
          send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: spec.cwd, mcpServers: [] } });
          const connected = event('status', {
            text: `ACP 已连接 ${String(info.name ?? '?')} ${String(info.version ?? '?')}`,
            raw: msg,
          });
          return [connected, ...unsupportedOptionEvents()];
        }
        if (msg.id === 2) {
          if (msg.error) {
            fatal = String(msg.error.message ?? msg.error.code);
            finished = true;
            return [event('error', { text: fatal, raw: msg })];
          }
          sessionId = msg.result?.sessionId ?? null;
          if (!sessionId) {
            fatal = 'session/new 未返回 sessionId';
            finished = true;
            return [event('error', { text: fatal, raw: msg })];
          }
          send({
            jsonrpc: '2.0',
            id: 3,
            method: 'session/prompt',
            params: { sessionId, prompt: [{ type: 'text', text: spec.prompt }] },
          });
          return [event('status', { text: `session=${sessionId}`, raw: msg })];
        }
        if (msg.id === 3) {
          if (msg.error) {
            fatal = String(msg.error.message ?? msg.error.code);
          } else {
            stopReason = msg.result?.stopReason;
          }
          finished = true;
          return [event('result', { text: accumulated || undefined, raw: msg })];
        }
        return [event('status', { text: `acp:response id=${String(msg.id)}`, raw: msg })];
      }

      // 通知:session/update 是流式产出
      if (msg.method === 'session/update') {
        const update = msg.params?.update ?? {};
        const kind = update.sessionUpdate;
        switch (kind) {
          case 'agent_message_chunk': {
            const text = update.content?.type === 'text' ? String(update.content.text ?? '') : '';
            accumulated += text;
            return [event('message', { text, raw: msg })];
          }
          case 'agent_thought_chunk':
            return [event('status', { text: '<thought>', raw: msg })];
          case 'tool_call':
          case 'tool_call_update':
            return [event('tool_call', { text: String(update.title ?? update.toolCallId ?? ''), raw: msg })];
          default:
            return [event('status', { text: `session/update:${String(kind)}`, raw: msg })];
        }
      }

      return [event('status', { text: `acp:${String(msg.method)}`, raw: msg })];
    },

    shouldStop: () => finished,
    finalize: () => ({
      text: accumulated.length > 0 ? accumulated : undefined,
      structured: undefined,
      usage,
      // 实测(2026-09-19,mimo/OpenCode):会话能以 stopReason=end_turn 正常结束,
      // 却一个字的文本都没有、usage 全为 0 —— 那是模型没配好或没鉴权,
      // 不是"成功但回复为空"。必须显式报失败,否则主脑会拿到一个空洞的成功。
      errorText:
        fatal ??
        (accumulated.length === 0 && stopReason === 'end_turn'
          ? 'ACP 会话以 end_turn 正常结束,但未产出任何文本且 usage 为 0(模型未配置或未鉴权?)'
          : undefined),
    }),
  };
}

export interface AcpAdapterConfig {
  id: string;
  displayName: string;
  /** npm bin 名,如 'qwen'。 */
  binName: string;
  /** npm 包名,如 '@qwen-code/qwen-code'。 */
  pkgName: string;
  /**
   * 进入 ACP 模式的参数。各家写法不同:
   * Gemini / Qwen 是 flag `--acp`;MiMo / OpenClaw 是子命令 `acp`。
   */
  acpArgs?: string[];
}

export function createAcpAdapter(config: AcpAdapterConfig): Adapter {
  const acpArgs = config.acpArgs ?? ['--acp'];
  let cli: ResolvedCli | null = null;

  return {
    id: config.id,
    tier: 1,
    displayName: config.displayName,
    // 只声明真能兑现的档位:写档位要等权限协商实现,见 ACP_WRITE_APPROVALS_WIRED
    supportedApprovals: ACP_WRITE_APPROVALS_WIRED
      ? ['read-only', 'workspace-write', 'full']
      : ['read-only'],

    async detect(): Promise<DetectResult> {
      cli = await resolveGlobalCli(config.binName, config.pkgName);
      if (!cli) {
        return { available: false, detail: `找不到 ${config.binName}(${config.pkgName})的 bin` };
      }
      const probe = await acpProbe(cli, acpArgs, 8_000);
      if (!probe) {
        return { available: false, detail: 'ACP 握手无响应(initialize 未返回)' };
      }
      const version = probe.agentVersion
        ? `${probe.agentName ?? config.id} ${probe.agentVersion} (ACP v${probe.protocolVersion})`
        : undefined;
      if (probe.sessionError) {
        return { available: true, version, detail: `ACP 通但未鉴权: ${probe.sessionError}` };
      }
      return { available: true, version };
    },

    plan(spec: TaskSpec): SpawnPlan {
      if (!cli) throw new DispatchRejected(`${config.id}: 未探测成功,先调用 detect()`);
      return {
        command: cli.command,
        args: [...cli.prefixArgs, ...acpArgs],
        needsStdin: true,
      };
    },

    createRun: (spec, taskId) => createRun(spec, taskId, config.id),
  };
}