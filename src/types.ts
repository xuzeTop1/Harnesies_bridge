import type { DiskAudit } from './audit.ts';

/**
 * 统一任务模型与事件模型。
 *
 * 事件模型以 Claude Code 的 stream-json 为基准(最完整),其它厂商向它归一化。
 * 五级集成的语义差异一律收敛在 adapter 内部,不许漏进调度器 —— 见 PLAN.md §4/§5。
 */

export type Tier = 1 | 2 | 3 | 4 | 5;

/**
 * 审批档位。`full` 对应各家的 yolo / bypass 开关,默认拒绝执行,
 * 必须由调用方在任务里显式声明 allowedFull 才放行 —— 见 AGENTS.md 铁律二。
 */
export type ApprovalLevel = 'read-only' | 'workspace-write' | 'full';

/**
 * 该档位到底是"桥拦住了"还是"只是个标签"。
 *
 * `unknown` 是**默认值**,不是占位:桥没实测过的档位不许宣称拦得住 ——
 * 把"我不知道"当"安全"是本项目最忌的静默降级(同云策略里"端点未知按不可信处理")。
 */
export type ApprovalEnforcement = 'enforced' | 'advisory' | 'unknown';

export interface Budget {
  /** 墙钟上限(毫秒)。超时即中断进程,结果标 timeout。 */
  maxWallMs: number;
  /** 可选的 token 上限。超限标 failed 并如实报告,不静默续跑。 */
  maxTokens?: number;
}

export type SessionMode =
  | { mode: 'fresh' }
  | { mode: 'resume'; sessionId: string }
  | { mode: 'fork'; sessionId: string };

export interface TaskSpec {
  taskId: string;
  harness: string;
  prompt: string;
  cwd: string;
  /** 必填,无默认值。缺字段即拒绝执行。 */
  approval: ApprovalLevel;
  /** 必填,无默认值。 */
  budget: Budget;
  session: SessionMode;
  /** 结构化输出用的 JSON Schema 文件路径。仅部分 harness 支持。 */
  outputSchemaPath?: string;
  /**
   * 指定该 worker 用哪个模型(如 `-m gpt-5.6-sol`)。
   *
   * 存在的理由:跨厂商被凭证卡住时,**同一家换不同模型**仍是一条可用的多样性来源 ——
   * 本机 codex 走聚合代理,一个 provider 后面挂多家模型。但要说清:
   * **换模型 ≠ 跨厂商**,别把同 vendor 的不同模型当成"交叉验证"来宣称。
   */
  model?: string;
  /** 显式开闸才会把 approval='full' 放行。 */
  allowedFull?: boolean;
  /**
   * 放弃 worktree 隔离的显式开关。
   * 写任务在非 git 目录下默认被拒(AGENTS.md 铁律三要求独立 worktree);
   * 确实不需要隔离时由调用方显式声明,并在结果里标记 isolated=false。
   *
   * 2026-09-24 起**在 git 仓库里同样生效**(此前 git 仓库是无条件分配 worktree,
   * 这个开关被忽略)。用户要求把"这次要不要 worktree"交给调用方决定,但默认仍是新建+隔离,
   * 放弃隔离必须显式,且 ack/结果/账本三处都会标 `isolated: false` —— 不许混成"隔离了"。
   */
  allowUnisolatedWrite?: boolean;
  /**
   * 复用**已有** worktree 当工作目录(多轮任务共用一份工作区,如 R7 那种人工建好的)。
   * **写档专用**:只读档传它会当场被拒(只读不分配 worktree;想让它读某个工作区的快照,
   * 直接把 cwd 指过去即可)。
   *
   * 为什么不直接把它当 cwd:实测会**嵌套**出一层新的 `A/.llms-bridge/worktrees/<新id>`,
   * 而不是复用 A。走这个字段时桥会先验:同仓库的、且**不是主工作区**的独立 worktree
   * (验不过当场拒)。写任务在这条路上会回收该 worktree 里**全部未提交改动**的 diff,
   * 不只本轮 —— 多轮共用时请把它当成预期行为。
   */
  reuseWorktreePath?: string;
}

export type EventType =
  | 'status'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'diff'
  | 'usage'
  | 'error'
  | 'result';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface BridgeEvent {
  taskId: string;
  seq: number;
  harness: string;
  tier: Tier;
  type: EventType;
  at: number;
  text?: string;
  usage?: Usage;
  /** 厂商原始载荷,便于排查与后续收紧解析。不保证跨厂商同构。 */
  raw?: unknown;
}

export type TaskStatus = 'ok' | 'failed' | 'timeout' | 'rejected';

export interface TaskResult {
  taskId: string;
  harness: string;
  tier: Tier;
  status: TaskStatus;
  text?: string;
  structured?: unknown;
  usage?: Usage;
  eventCount: number;
  startedAt: number;
  /**
   * 桥**观测到**结束的时刻。缺失只出现在一种情况:从账本里读回来的记录停在 `running`
   * (持有它的桥进程消失了,没人观测到结束)。那时**不许**用 startedAt 顶替 ——
   * 那会让"被中断"看起来像"开始即结束",据此判断时序会得出完全错误的结论。
   */
  endedAt?: number;
  /** 非 ok 时说明原因(超时 / 超预算 / 退出码 / 审批拒绝)。 */
  reason?: string;
  /** 是否给该 worker 分配了独立 worktree。 */
  isolated: boolean;
  /**
   * 这次用的审批档位**实际**拦不拦得住。'unknown' 是诚实的答案,不是缺数据。
   * 与 `isolated` 一样:宁可说"没保证",不许过度宣称。
   */
  approvalEnforcement?: ApprovalEnforcement;
  approvalNote?: string;
  /**
   * 派发前后对**调用方原始 cwd**做的磁盘比对。
   * 写档即使隔离在 worktree 里也会审计原目录 —— 要抓的正是"越界写到你的主仓库"。
   * `audited:false` 表示没审计成(通常是非 git 目录),那不等于"没改动"。
   */
  diskAudit?: DiskAudit;
  /** 指定的模型(没指定则为 undefined,即该 harness 的默认模型)。 */
  model?: string;
  /** 隔离时 worker 实际的工作目录;改动保留在这里,未合并回源仓库。 */
  worktreePath?: string;
  /**
   * worker 改动的 unified diff。交叉评审时把它塞给另一家 harness 当输入,
   * 所以放在结果里一步可取,不用去翻事件流。超长会被截断并标注。
   */
  diff?: string;
  /**
   * diff 是否因超长被截断。调用方**必须**在看这个字段为 true 时改变行为:
   * 拿半份 diff 去让另一家评审,换来的可能是一个自信而错误的 LGTM —— 那比不评审更糟。
   * 无 diff 时为 undefined,有 diff 未截断时为 false。
   */
  diffTruncated?: boolean;
  /**
   * 该结果来自**落盘账本**而非本进程内存:任务由上一个桥进程派发(宿主重启等),进程已消失。
   * 此时 `text` 等字段仍然可信,但 `eventCount` 为 0 —— 事件流只在内存里,无法回放。
   */
  fromJournal?: boolean;
  journalPath?: string;
}

export interface DetectResult {
  available: boolean;
  /** 实测到的版本;探测不到就留空,不要编。 */
  version?: string;
  detail?: string;
}

/**
 * 一次派发会把数据发往哪个主机 —— 见 src/egress.ts 的动机说明。
 * 只允许出现主机名与代理线索;任何凭证值(连长度都不许)不得进这个结构。
 */
export interface EgressReport {
  endpointHost: string;
  nativeAnthropic: boolean;
  /** 端点是从哪读到的,便于用户核对"我到底切了哪一层"。 */
  source: string;
  proxyClues: string[];
  /** 给人看的一句风险提示,不猜、不替用户决定。 */
  notice: string;
  /** 调度器在派发时填:这次实际外发的提示词体积。 */
  promptBytes?: number;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** 会话型协议(层级①)需要能往子进程 stdin 写请求。 */
  needsStdin?: boolean;
}

/** 每次任务一个,持有该次运行的解析状态(累积助手文本、用量、结构化结果)。 */
export interface RunParser {
  /** 子进程起来后调用一次,交出 stdin 写入器(仅 needsStdin 的 adapter 会用)。 */
  onStart?(write: (line: string) => void): void;
  parseLine(line: string): BridgeEvent[];
  /** 协议对话已完成、可以收工时返回 true;调度器据此中断进程。 */
  shouldStop?(): boolean;
  finalize(exitCode: number): {
    text?: string;
    structured?: unknown;
    usage?: Usage;
    errorText?: string;
  };
}

export interface Adapter {
  id: string;
  tier: Tier;
  displayName: string;
  /** 该 adapter 支持到哪几档审批。full 是否真放行由调度器按 allowedFull 决定。 */
  supportedApprovals: readonly ApprovalLevel[];
  /**
   * `supportedApprovals` 里哪些档位**真的拦得住**该 harness 写盘/执行命令。
   * 只允许出现桥自己实测过的结论;没列出来的档位由 enforcementOf() 判成 'unknown'。
   *
   * 为什么单列一个字段而不是直接把档位从 supportedApprovals 里删掉:删掉等于说"这家没有只读档",
   * 而事实是"这个标签不解决问题"——两者对调用方的决策含义不同。opencode 只有 read-only 可派,
   * 摘掉它就直接不可用了;如实标 advisory 才能让调用方**带着这个认知**去派。
   */
  approvalEnforcement?: Partial<Record<ApprovalLevel, 'enforced' | 'advisory'>>;
  detect(): Promise<DetectResult>;
  plan(spec: TaskSpec): SpawnPlan;
  createRun(spec: TaskSpec, taskId: string): RunParser;
  /**
   * 该 harness 能否**自己声明**它支持哪些模型。
   *
   * 返回 null 的意思是"它不自报",**不是**"它没有模型" —— 调用方必须把它渲染成"未知",
   * 绝不能填一份看起来合理的清单。AGENTS.md 禁止编造能力清单,而模型菜单正是最容易被编的地方:
   * 面板一旦有了假条目,用户就会照着它去派发,然后拿到一个不存在的模型。
   */
  listModels?(): Promise<ModelCatalog | null>;
  /**
   * 自报"这次派发的数据会发往哪个主机"。不实现 = 桥不知道,调用方**不许**替它编一个。
   * 用途见 src/egress.ts:同一个 harness id 可能对应原生端点或第三方中转,两者数据去向
   * 和账号风险面完全不同,而用户用 cc-switch 一键就能切换 —— 所以每次派发都要说清。
   */
  egress?(): Promise<EgressReport>;
}

/** 来自 harness 自身输出的模型清单。`source` 必须能回答"这是哪条命令在什么时候说的"。 */
export interface ModelCatalog {
  models: string[];
  /** 取到清单的依据,例如 `codebuddy --help` 的 `--model` 行。 */
  source: string;
  /** 本次解析的时间戳;清单会随版本漂移,所以必须带日期(AGENTS.md 证据纪律)。 */
  checkedAt: number;
}

/** `harness_models` 的返回单元。 */
export interface HarnessModels {
  id: string;
  displayName: string;
  available: boolean;
  /**
   * false = 这个 harness **不自己声明**模型清单(或解析失败)。
   * 此时 `models` 是空数组,调用方**必须显示"未知"**,不许拿"默认模型"或别家的清单顶上。
   */
  declared: boolean;
  models: string[];
  /** 清单出处,例如 `codebuddy --help 的 --model 行`。未声明时给出为什么未知。 */
  source?: string;
  checkedAt?: number;
}

/** 派发前就失败的路径(参数缺失、审批未放行、harness 不可用)统一抛这个。 */
export class DispatchRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DispatchRejected';
  }
}