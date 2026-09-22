#!/usr/bin/env node
/**
 * llms-bridge 的 MCP server(stdio,ndjson JSON-RPC)。
 *
 * 手写而不引 @modelcontextprotocol/sdk:只有五个原语,不值得为它拉一棵依赖树。
 *
 * 暴露给"主 harness"的能力:
 *   harness_list      —— 有哪些 harness、层级、支持的审批档位、当前可用性
 *   harness_dispatch  —— **异步**派发,立刻返回 task_id(worker 会跑几分钟到几十分钟,
 *                        同步等会把 MCP 调用拖超时 —— 见 PLAN.md §5.3)
 *   harness_poll      —— 轮询任务状态
 *   harness_result    —— 取结构化结果(未跑完则返回未完成标志,不阻塞)
 *   harness_events    —— 取归一化事件流,便于主脑跟踪过程
 *
 * AGENTS.md 铁律在 MCP 边界同样强制:dispatch 的 approval / max_wall_ms 是必填参数,
 * full 档需要显式 allow_full=true。
 *
 * 注意:stdout 只用于协议消息,任何日志一律走 stderr —— 否则会污染 JSON-RPC 流。
 */

import { createInterface } from 'node:readline';
import { Scheduler } from './scheduler.ts';
import { createAdapters } from './registry.ts';
import type { ApprovalLevel, SessionMode, TaskSpec } from './types.ts';
import { DispatchRejected } from './types.ts';

const SERVER_NAME = 'llms-bridge';
const SERVER_VERSION = '0.0.1';

/** 客户端报什么版本就回什么:各家 MCP 客户端版本不一,回显比赌一个"最新版"更兼容。 */
function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && requested.length > 0 ? requested : '2024-11-05';
}

const scheduler = new Scheduler(createAdapters());

const log = (msg: string) => process.stderr.write(`[llms-bridge] ${msg}\n`);

// 启动即预热探测:层级① 的 ACP 握手是秒级的,不预热会让第一次 harness_list/dispatch 卡住。
// 预热是后台的,不阻塞 stdin 开始服务。
void scheduler.detectAll().catch((err) => log(`预热探测失败: ${String(err)}`));

const TOOLS = [
  {
    name: 'harness_list',
    description:
      '列出本机可用的 agent harness:层级(1=ACP会话协议 2=双向流 3=一次性子进程)、支持的审批档位、当前可用性与版本。派发前先用它选人。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'harness_models',
    description:
      '列出各家 harness **自己声明**支持的模型,带出处与核查时间。没自报的会返回 declared:false + 空列表 —— ' +
      '那必须当成"未知"渲染,不许填默认值(填了就等于派一个不存在的模型)。选定后用 harness_dispatch 的 model 参数。',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: '忽略缓存,重新向各家取一次清单' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'harness_dispatch',
    description:
      '把子任务派发给指定 harness,**立刻返回 task_id**(不阻塞)。之后用 harness_poll 轮询、harness_result 取结果。',
    inputSchema: {
      type: 'object',
      properties: {
        harness: { type: 'string', description: 'harness id,取值见 harness_list' },
        prompt: { type: 'string', description: '交给该 harness 的完整指令' },
        cwd: { type: 'string', description: '工作目录(Windows 绝对路径)' },
        approval: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'full'],
          description: '审批档位,必填无默认。full 会让该模型在无人确认下改动磁盘',
        },
        max_wall_ms: { type: 'integer', description: '墙钟上限(毫秒),必填。超时即中断进程树' },
        max_tokens: { type: 'integer', description: '可选 token 上限,超限即中断并标 failed' },
        allow_full: { type: 'boolean', description: "approval='full' 时必须显式给 true,否则拒绝" },
        allow_unisolated_write: {
          type: 'boolean',
          description:
            '写任务在非 git 目录下默认被拒(要求独立 worktree)。确实不需要隔离时显式给 true,结果会标记 isolated=false',
        },
        resume_session_id: { type: 'string', description: '恢复指定会话(层级②③支持)' },
        fork_session_id: { type: 'string', description: '从指定会话 fork 出新分支(层级②支持)' },
        output_schema: { type: 'string', description: 'JSON Schema 文件路径,要求结构化输出' },
        model: {
          type: 'string',
          description:
            '指定该 worker 用哪个模型。跨厂商不可用时可让同一家换模型获得多样性,' +
            '但换模型不等于跨厂商,不要把它当成交叉验证来宣称',
        },
      },
      required: ['harness', 'prompt', 'cwd', 'approval', 'max_wall_ms'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_poll',
    description: '查任务状态:是否结束、状态、已产出多少事件、用量、最后一个事件。不阻塞。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_result',
    description:
      '取任务结果。未跑完则返回 finished=false(不阻塞),此时继续用 harness_poll 轮询。' +
      '写任务的 result.diff 是 worker 改动的 unified diff —— 交叉评审时直接把它交给另一家当输入。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'harness_events',
    description: '取归一化事件流(status/message/tool_call/tool_result/diff/usage/error/result),用于跟踪过程。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        since_seq: { type: 'integer', description: '只取 seq >= 该值的事件,省略则全取' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
] as const;

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    isError,
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) throw new DispatchRejected(`${key} 必填且必须是非空字符串`);
  return v;
}

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'harness_list': {
      const report = await scheduler.detectAll();
      return textResult(
        report.map((r) => ({
          id: r.id,
          displayName: r.displayName,
          tier: r.tier,
          supportedApprovals: r.supportedApprovals,
          available: r.available,
          version: r.version,
          note: r.detail,
        })),
      );
    }

    case 'harness_models':
      return textResult(await scheduler.models(args.force === true));

    case 'harness_dispatch': {
      const session: SessionMode = args.resume_session_id
        ? { mode: 'resume', sessionId: String(args.resume_session_id) }
        : args.fork_session_id
          ? { mode: 'fork', sessionId: String(args.fork_session_id) }
          : { mode: 'fresh' };

      const spec: TaskSpec = {
        taskId: crypto.randomUUID(),
        harness: requireString(args, 'harness'),
        prompt: requireString(args, 'prompt'),
        cwd: requireString(args, 'cwd'),
        approval: requireString(args, 'approval') as ApprovalLevel,
        budget: {
          maxWallMs: Number(args.max_wall_ms),
          maxTokens: args.max_tokens === undefined ? undefined : Number(args.max_tokens),
        },
        session,
        outputSchemaPath: typeof args.output_schema === 'string' ? args.output_schema : undefined,
        model: typeof args.model === 'string' ? args.model : undefined,
        allowedFull: args.allow_full === true,
        allowUnisolatedWrite: args.allow_unisolated_write === true,
      };

      // 不在这里 await detectAll():dispatch 会在**校验之后**自己等探测,
      // 放在这里会让"参数非法/审批未开闸"这类拒绝也白等一整轮 ACP 握手(实测 8s)。
      const ack = await scheduler.dispatch(spec);
      return textResult({
        task_id: ack.taskId,
        harness: spec.harness,
        model: spec.model,
        isolated: ack.isolated,
        worktree: ack.worktreePath,
        // 每次派发现场重算:让用户在派发后就看见"这批数据到底发去了哪",
        // 而不是去翻可能已过期的 harness_list。该 harness 不自报时整个字段缺失。
        egress: ack.egress
          ? {
              endpoint_host: ack.egress.endpointHost,
              native_anthropic: ack.egress.nativeAnthropic,
              source: ack.egress.source,
              prompt_bytes: ack.egress.promptBytes,
              proxy_clues: ack.egress.proxyClues,
              notice: ack.egress.notice,
            }
          : undefined,
        hint: '用 harness_poll 轮询,harness_result 取结果',
      });
    }

    case 'harness_poll':
      return textResult(scheduler.poll(requireString(args, 'task_id')));

    case 'harness_result': {
      const taskId = requireString(args, 'task_id');
      const snap = scheduler.poll(taskId);
      if (!snap.finished) {
        return textResult({ task_id: taskId, finished: false, hint: '任务仍在跑,继续用 harness_poll 轮询' });
      }
      return textResult(await scheduler.collect(taskId));
    }

    case 'harness_events': {
      const taskId = requireString(args, 'task_id');
      const since = typeof args.since_seq === 'number' ? args.since_seq : undefined;
      const events = scheduler.events(taskId).filter((e) => since === undefined || e.seq >= since);
      return textResult({ task_id: taskId, count: events.length, events });
    }

    default:
      throw new DispatchRejected(`未知工具: ${name}`);
  }
}

async function handleMessage(msg: any): Promise<unknown | undefined> {
  const { id, method, params } = msg ?? {};

  // 通知:没有 id,不需要回
  if (id === undefined) {
    if (method === 'notifications/initialized') log('client initialized');
    return undefined;
  }

  try {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: negotiateVersion(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        return await callTool(name, args);
      }
      default:
        return { __error: { code: -32601, message: `method not found: ${method}` } };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (method === 'tools/call') {
      // 工具的失败是正常结果,按 isError 返回,让主脑能读到原因
      return textResult({ error: message }, true);
    }
    return { __error: { code: -32603, message } };
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
    return;
  }

  void handleMessage(msg).then((result) => {
    if (result === undefined) return;
    const response =
      (result as { __error?: unknown }).__error !== undefined
        ? { jsonrpc: '2.0', id: msg.id, error: (result as { __error: unknown }).__error }
        : { jsonrpc: '2.0', id: msg.id, result };
    process.stdout.write(JSON.stringify(response) + '\n');
  });
});

log(`started (${TOOLS.length} tools), waiting on stdin`);