# llms-bridge

让**你此刻正在用的那个 agent harness** 当主脑,把子任务派发给本机其它厂商的 harness
(Codex / Claude Code / CodeBuddy / OpenCode / Qwen / MiMo / OpenClaw …)去跑,再把过程与
产物收回来。

它解决的是一个具体问题:一家模型的自评不可靠 —— 你想让**另一家**来看你的改动。
桥就是一个 MCP server,对外只给六个原语,内部把各家的协议差异收敛掉。

规划见 [`PLAN.md`](./PLAN.md),治理与红线见 [`AGENTS.md`](./AGENTS.md)。

> **2026-10 local hardening (this checkout).** Fixes for defects reproduced on macOS, each with a
> regression test (`test/robustness`, `audit-diff-policy`, `credentials-budget`,
> `discovery-events-mcp`, opt-in `real-cli-mock`):
> crash-proof dispatch (oversized prompts, unwritable cwd, parser errors no longer kill the server);
> prompts delivered on stdin to claude/codex (a prompt starting with `--- a/` used to be parsed as an
> option); timeout/cancel terminate the whole process tree on POSIX; new `harness_cancel`;
> disk audit sees rewrites of already-dirty files, files inside untracked directories and ref
> changes; worktree diffs are taken against the base commit (worker commits were lost);
> local-only policies apply from sub-directories, worktrees and a user-wide file; credential
> variables of other vendors are withheld from workers and redaction covers common key names and
> secret-shaped values; token budgets count cache tokens and stop runs mid-way where the CLI reports
> usage while running; macOS/Linux CLI discovery (Claude Code's native installer, npm prefixes);
> paged `harness_events`; machine-independent tests and an `mcp-config` generator instead of
> `D:\LLMS_Bridge` config files.
**本机装了哪些版本、哪家能干活、哪家不通 —— 只在 PLAN.md 里带核实日期地记录,本文件不复制**,
因为这类事实会随版本漂移。

---

## 装与跑

零依赖、无构建步骤:靠 Node 的原生类型擦除直接跑 `.ts`。

```bash
node --version        # 需要 >= 23.6(package.json engines)
npm install           # dev-only: typescript + @types/node for `npm run check`; runtime stays dependency-free
npm run check         # tsc --noEmit
npm test              # 默认套件,**不消耗任何模型额度**,不依赖本机装了哪些 CLI
npm run test:machine  # opt-in: assertions about the author's workstation (installed CLIs)
npm run test:real-cli # opt-in: the real claude CLI against a local mock API (no model, no network)
npm run test:live     # 只有这条会真派发:需 LLMS_BRIDGE_LIVE=1
npm run detect        # 列出各家可用性与版本
npm run dispatch      # 命令行派发一次(调试用;正常入口是 MCP;Ctrl-C 会结束整棵进程树)
```

挂到宿主(**stdio 传输**,不需要任何本地端口)。Machine-specific config files are no longer kept in the
repository; generate the registration for this checkout instead:

```bash
node src/cli.ts mcp-config --host claude   # → claude mcp add --scope user llms-bridge -- <node> <abs path>/src/mcp-server.ts
node src/cli.ts mcp-config --host codex    # → codex mcp add llms-bridge -- …
node src/cli.ts mcp-config --host json     # → {"mcpServers": {...}} for Gemini / Qoder / other hosts
```

CLI discovery: PATH plus common install directories (`~/.local/bin`, `/opt/homebrew/bin`, npm
prefixes…). Override per harness with `LLMS_BRIDGE_<ID>_CLI=/path` (e.g. `LLMS_BRIDGE_CLAUDE_CLI`)
or `~/.llms-bridge/config.json` → `{"cli": {"claude": "/path"}}`.

## 对外只有七个原语

| 工具 | 干什么 |
|---|---|
| `harness_list` | 有哪些 harness、层级、支持的审批档位、当前可用性与版本;`usageReporting` says whether max_tokens can stop a run |
| `harness_models` | 各家**自己声明**的模型清单,带出处与核查时间 |
| `harness_dispatch` | 派发,**立刻返回 task_id**(不阻塞);ack lists applied policies, withheld credential variable *names* and `max_tokens_enforcement` |
| `harness_poll` | 轮询:是否结束、状态、事件数、用量 |
| `harness_result` | 取结构化结果 + worker 的产物 diff(against `base_commit`, worker commits included; capped by `max_diff_bytes`; full patch in `diffPath`) |
| `harness_events` | 归一化事件流,**分页**:`limit` (≤500), `max_bytes` (≤1 MB), `since_seq` → `next_seq`; raw payloads only with `include_raw` |
| `harness_cancel` | Cancel a running task: terminates the worker's whole process tree; status `cancelled` |

派发必填 `approval` 与 `max_wall_ms`,**没有默认值**:缺字段就拒绝,不"用缺省"。
`approval: "full"` 还要显式 `allow_full: true`,否则同样拒绝。

`harness_models` 返回 `declared: false` + 空清单时,意思是**它不自报**,不是"它没有模型"。
上层必须渲染成"未知",不许填一个看起来合理的默认型号 —— 面板有了假条目,用户就会照着派发,
然后拿到一个不存在的模型。

## 一次派发长什么样

主脑(你当前的会话)调用:

```jsonc
// tools/call → harness_dispatch
{
  "harness": "codex",
  "prompt": "评审 cwd 下 `changes.patch` 里的改动,只回答 LGTM / 不 LGTM 加理由",
  "cwd": "D:/some/git/repo",
  "approval": "read-only",     // 必填,无默认
  "max_wall_ms": 480000,       // 必填,到点杀进程树
  "max_tokens": 200000         // 可选
}
```

返回**立刻**给,不等 worker:

```jsonc
{
  "task_id": "1007571f-7062-4d6d-b768-01dc55eb416f",
  "harness": "codex",
  "isolated": true,
  "worktree": "…/.llms-bridge/worktrees/1007571f70624d6d",
  // 这个档位在**这一家**到底拦不拦得住:enforced / advisory / unknown(缺省)。
  // advisory = 桥实测过它不会因此收手;unknown = 桥没实测过。两者都不能当沙箱用。
  "approval_enforcement": "unknown",
  "approval_note": "桥没有实测过这家在 approval='read-only' 下会不会真的收手,按\"不确定\"对待。…",
  "egress": {
    "endpoint_host": "api.anthropic.com",
    "native_anthropic": true,
    "source": "未配置端点 → 该 CLI 默认值",
    "prompt_bytes": 163,
    "notice": "原生端点:数据将离开本机前往官方服务…"
  }
}
```

之后 `harness_poll` 看是否结束 → `harness_result` 取文本/用量/diff → `harness_events` 看过程。
写任务要把 `approval` 提到 `workspace-write`,桥会自动给它分配独立 worktree,源工作区不动。

worktree 的形态由调用方显式选(默认永远是"新建 + 隔离"):

| 参数 | 效果 | 结果里的标记 |
| --- | --- | --- |
| 都不给 | 在 `cwd` 的仓库里新建 `--detach` worktree | `isolated: true` + `worktree_path` |
| `reuse_worktree_path` | 复用已有 worktree(仅写档;先验"同仓库且非主工作区") | `isolated: true` |
| `allow_unisolated_write: true` | 直接写 `cwd`(git 仓库里也生效) | `isolated: false` |

### 档位拦不住时,用事实兜底

`approval` 是**意图**,不是结果。opencode 的 `read-only` 就实测过不拦:照样执行命令、
照样往 cwd 外写文件。所以桥在派发前后,会对**你给的那个 cwd** 各取一次 `git status` 与 HEAD
来比对,结果放进 `harness_result` 的 `diskAudit`:

```jsonc
{
  "status": "failed",           // 只读档改了盘 → 判 failed,不会停在 ok
  "reason": "越界改动:审批档位=read-only 隔离=false,但 D:/some/git/repo 被改动了 1 处文件",
  "diskAudit": {
    "audited": true,
    "cwd": "D:/some/git/repo",
    "changed": true,
    "paths": [{ "path": "notes/probe.txt", "before": "", "after": "??" }],
    "headMoved": false,
    "caveats": ["盲区1:被 .gitignore 排除的路径 git 不会报…", "盲区2:只审计这一个目录…", "…"]
  }
}
```

三条要说清:

- `audited: false`(**非 git 目录**)不等于 `changed: false`,更不等于"它没改动" —— 那是"没法验证"。
- 已隔离的写任务同样审计原目录:要抓的就是"跑出去动主仓库"。而 `allow_unisolated_write`
  下写 `cwd` 是你要的行为,不判越界(但 `changed` 照样如实报)。
- 审计**只报告,不回滚**。它也不覆盖 `.gitignore` 里的路径和仓库外的绝对路径写入 —— 盲区在
  `caveats` 里随结果一起带出,不藏。
- Method (2026-10): status codes **plus** a size/mtime/ctime fingerprint of every dirty or untracked
  path (`--untracked-files=all`) **plus** all refs. A rewrite of a file you had already modified,
  a new file inside an untracked folder, or a new branch/tag are now reported (`change: "content"`,
  `refsChanged`); the first version reported `changed: false` for the first two.

仓库级"数据能不能出本机"写在 `<仓库>/.llms-bridge/policy.json`(**文件不存在＝不限制**)。
Every applicable file counts and all must allow the dispatch: the cwd and each ancestor
(`<dir>/.llms-bridge/policy.json`), the main worktree of a linked worktree, and a user-wide
`~/.llms-bridge/policy.json`. (Before, a sub-directory or worktree cwd silently skipped the repo's policy.)

```jsonc
{ "cloud": { "allowHarnesses": ["claude"] } }   // 空数组 = 只允许端点在本机的 harness
```

端点**未知**一律按不可信处理 —— 今天只有 claude 自报 egress,所以空名单下它以外的都会被拒;
文件坏掉或键名写错也按拒处理(建它是为了限制,解析失败不该悄悄解除)。

任务状态只在进程内存里,但**账本、心跳与事件流都落盘**:派发即写 `<cwd>/.llms-bridge/tasks/<taskId>.json`
(含 prompt、结果正文、状态、用量、egress 主机)、`<taskId>.beat.json`(进度心跳),
并逐条追加 `<taskId>.events.jsonl`(status / message / tool_call / tool_result / diff / …)。
事件写盘前按字段名隐去凭证值,单字段与单任务分别有体积上限(`LLMS_BRIDGE_EVENT_FIELD_CAP` /
`LLMS_BRIDGE_EVENT_BYTES_CAP`),截断与撞上限都会留下可见标记 —— 差额由"盘上几行 vs 心跳记几条"暴露,不做静默丢。
索引在 `~/.llms-bridge/tasks-index.jsonl`。
宿主重启后 `harness_poll` / `harness_result` / `harness_events` 会自动回退读盘,返回 `fromJournal: true`;
记录停在 `running` 表示持有它的进程消失了。隔离任务的账本与事件流都在那个 worktree 里,
**清理 worktree 会连带删掉它们**。
这些正文只落本机:`.llms-bridge/` 在版本化的 `.gitignore` 里(worktree 容器另走
`.git/info/exclude`),所以它不进 diff、也不随 push 出去 —— 这是"正文可以落盘"的实际依据。

## 三层集成,一套事件模型

层级① ACP(ndjson JSON-RPC over stdio,可多轮)、② Claude 兼容 stream-json(双向流)、
③ 一次性子进程。层级④(宿主本地 API/CDP)与⑤(computer-use)在 PLAN.md 里标为未公开接口,
**桥目前不实现**。

差异只允许藏在 adapter 里,对外统一成:
`status` / `message` / `tool_call` / `tool_result` / `diff` / `usage` / `error` / `result`。

每个 adapter 必须实现 `detect()`。探测不通就**显式标记该 harness 不可用**,不许静默降级到别家。
ACP 的探测超时算"未判定"而不是"不可用"——会重试一次更宽的时间窗。

## 四道闸门

1. **凭证**:桥不读、不存、不转发任何云端厂商密钥,无例外。只复用各家 CLI 自己的登录态。
   Workers get a filtered environment: each adapter declares its own vendor's credential variables
   (`credentialEnv`); every other credential-looking variable is withheld (names reported in the ack,
   never values). Widen explicitly with `LLMS_BRIDGE_PASS_ENV=NAME,PREFIX_*`. Journal files are
   owner-only (0600/0700) and secret-shaped strings are redacted from stored prompts, events and returned text.
   唯一例外是宿主自己写在配置里的 **localhost 服务 token**,按字段白名单就地只读使用(见 AGENTS.md §1.1)。
2. **审批**:见上,必填无默认;绕过类档位必须用户当次点名。
   档位还分"拦不拦得住":每个档位随 `supportedApprovals` 一起给 `approvalEnforcement` ——
   `enforced`(实测拦住)/ `advisory`(实测**不**拦,如 opencode 的 read-only)/ `unknown`(没实测过)。
   **缺省是 `unknown`,不会替你假设拦住。**`harness_list`、派发 ack、结果三处都能看到。
3. **隔离**:可能改盘的 worker 一律分到独立 git worktree(`--detach`),源工作区不动。
   默认永远是"新建 + 隔离";`reuse_worktree_path`(复用已有 worktree,仅写档)与
   `allow_unisolated_write`(直接写 cwd,**git 仓库里也生效**)都必须显式传,且放弃隔离时
   结果/ack/账本三处都标 `isolated: false`。非 git 目录下的写任务默认拒绝。
   产物以 diff 回收,**不自动合并**。容器目录 `.llms-bridge/` 写进仓库**本地**的
   `.git/info/exclude`(不动版本化的 `.gitignore`,不为"桥跑过一次"污染你的 diff);
   `.scratch/` 是另一回事。清理 worktree 默认是 dry-run,要 `confirm` 才删,且只删桥自己创建的。
   隔离只保证默认落点,**越界由事后审计抓**:见上一节 `diskAudit`。
   仓库级"数据能否出本机"另有一道:见上方 `policy.json`。
4. **预算**:`max_wall_ms` 到点中断整棵进程树并标 `timeout`(POSIX: the worker runs in its own
   process group; SIGTERM then SIGKILL to the group; processes that daemonize themselves are out of
   reach);超限不许偷偷换更贵的模型续跑。`max_tokens` counts cumulative input (cache reads/writes
   included) + output. It stops the run mid-way for claude/codebuddy/opencode (usage streams), can only
   be judged afterwards for codex (usage arrives at the end), and is not enforceable for ACP agents.

产物 diff 有上限(`LLMS_BRIDGE_DIFF_CAP`,默认 200KB)。超限时 `diffTruncated: true` ——
**拿到这个标志就必须改变行为**:半份 diff 换来的评审结论比不评审更糟。

## 派发时会自报数据去向

`harness_dispatch` 的返回里带一个 `egress` 块:这次派发的数据会发往**哪个主机**、是不是原生
Anthropic 端点、端点是从哪一层读到的、以及本机代理线索。

为什么要它:同一个 harness id 背后可能是两个完全不同的数据去向 —— 一键切端点就能把
"发给国内中转"变成"发给官方",数据去向和账号风险面全变了。所以:

- 出口报告在派发时**现取**,不复用 `harness_list` 的缓存;
- Claude Code precedence (measured with the real CLI): `managed > .claude/settings.local.json >
  .claude/settings.json > user settings > process env`; Bedrock/Vertex switches are honoured; when
  layers disagree every candidate host is reported (`alternate_hosts`) and policies require all to be local.
  Codex: read from `config.toml` (`model_provider` / `base_url`); default provider = OpenAI
  (`api.openai.com` / `chatgpt.com`);
- 只报主机名,路径段与任何凭证值都不外带(连长度都不印);
- adapter 没实现 `egress()` 的就是**缺字段**,不替它编一份;
- 这一报告是**知情用**,不是判定 —— 请求到底走不走某个代理,桥无法验证,判断留给你。

## 给人看的面板（只读）

```
node src/cli.ts ui          # 打印实际 URL,并登记在 ~/.llms-bridge/ui.json
```

显示四件事:**当前进度**(在跑 / 在等输出 / 疑似失联 / 已结束 + 事件数 + 最后输出多久前)、
**分发情况**(按工作区分组:一个 worktree 一栏,里面是它的各轮往来 —— harness、模型、档位、是否隔离、结果或原因)、
**会话过程**(点任务号读那一轮的 prompt、逐条事件 `tool_call` / `tool_result` / `diff` 与结果原文)、
**各家 LLM 用量**(任务数、成败、token 合计、未自报用量的条数、用过哪些模型)。

三条边界，都是刻意的：

- **只读**。没有派发/取消/合并接口 —— 控制面仍然只有 MCP 那六个原语。
  面板能改状态的那一刻,它就成了第二个主脑,而它比主脑更没有上下文。
- **只听 `127.0.0.1`,端口由系统分配**(AGENTS.md 禁硬编码端口)。传 `--host 0.0.0.0` 会被直接拒绝:
  账本里躺着各家任务的 prompt 与模型原文。
- **数据只来自落盘账本 + 心跳 + 事件流文件**,所以面板和桥谁先起、桥重启几次都不影响它看到历史。
  面板是**另一个进程**,读不到桥的内存 —— 事件流不落盘之前,"正在跑的会话"根本无从显示。

进度为什么可信:`status:'running'` 单独看**毫无信息量**(进程被杀时它就永远停在 running)。
所以桥每 3 秒写一个几百字节的心跳(`.llms-bridge/tasks/<id>.beat.json`),面板据此区分
「在跑」「桥还在看着它但在等输出」「心跳断了(多半是桥进程没了)」。
**「在等输出」和「卡住了」从文件上分不开,面板就把这句分不开显示出来** —— 编一个结论比不显示更糟。

## 目录

```
src/
  types.ts        统一模型:TaskSpec / Adapter / BridgeEvent / 四道闸门的类型约束
  scheduler.ts    派发、并发、预算、隔离、事件累积与终态不变量
  worktree.ts     写任务的 git worktree 隔离、复用校验与 diff 回收
  audit.ts        事后磁盘审计:派发前后比对调用方 cwd,抓越界写(只报告,不回滚)
  enforcement.ts  档位的"拦不拦得住"语义:enforced / advisory / unknown,缺省 unknown
  redact.ts       事件出口按字段名隐去凭证值(按值形态判断会误伤预算要用的 token 计数)
  journal.ts      任务账本:进程消失后仍能回答"派发过什么、最后怎样、产出了什么",写进度心跳,并逐条落盘事件流
  ui.ts           只读观测面板(127.0.0.1 + 临时端口):进度、按工作区分组、点开看逐条往来、各家用量
  policy.ts       仓库级云策略(数据能不能出本机)
  egress.ts       数据去向自报(端点主机、是否原生、代理线索)
  locate.ts       找到各家真二进制(Windows 的 shim 不能直接 spawn)
  proc.ts         子进程与 stdout 逐行喂给 parser;超时杀进程树
  registry.ts     注册哪些 adapter
  mcp-server.ts   stdio JSON-RPC:六个原语与参数校验
  cli.ts          detect / dispatch 的命令行入口
  adapters/       一家的协议差异都在这层(acp / claude / codex / codebuddy / opencode)
test/             node --test,*.mjs;涉及真派发的由 LLMS_BRIDGE_LIVE=1 才开
```

## 已知边界

- **Windows**:npm 的 `.cmd` shim 不能直接 spawn(EINVAL),所以 `locate.ts` 从包的 `package.json`
  里解析真 bin;GUI 宿主的子进程不继承 PATH/`LOCALAPPDATA`,路径要能从常见安装位兜底。
- **不硬编码端口**:宿主自己的本地端口是启动时分配的临时值,必须从宿主自己的登记文件读。
- 桥**不是** provider 切换器,也**不是** MCP 路由器 —— 那是 `cc-switch` 与 `mcporter` 的活,
  本仓库复用它们,不重造。
