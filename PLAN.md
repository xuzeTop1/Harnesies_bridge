# LLMS_Bridge 规划

> 建立 2026-09-19,同日修订(纳入 GUI 宿主的本地 API/CDP 入口)。
> 本文件"本机现状"与端口号均为 2026-09-19 实测,核实方式:安装目录 + 注册表(HKCU/HKLM/
> WOW6432Node 三视图)+ PATH + 进程 + 本地端口 HTTP 探测。
> **端口是每次启动都会变的临时值,版本与能力也会漂移。引用前按 AGENTS.md 的"证据纪律"重查。**

## 1. 目标

在**用户当前所在的任意 agent 会话**里(Codex / Claude Code / Gemini / Qoder / WorkBuddy …),
能当场决定把子任务交给本机**另一个厂商的 harness** 去执行,并把结果收回来。
主脑不是一个固定的 harness,而是"你此刻正在用的那个"。

## 2. 非目标(第一版明确不做)

- **不自造私有桥接协议**。能用 ACP 就用 ACP,能用 stream-json 就用 stream-json,
  能用宿主自己的 MCP 面就用 MCP。
- **不为 GUI 宿主做像素级 computer-use**。它们有本地 API/CDP 入口(见 §4 层级④),
  像素模拟只作为最后手段。
- **不集中托管任何厂商的 API key**。见 AGENTS.md 铁律一(含 2026-09-19 关于本地 API token 的补充)。
- **不替换 cc-switch / mcporter**。provider 切换、MCP 路由已有现成件。
- **不做 GUI**。第一版是库 + MCP server,控制面走各宿主现有会话。

## 3. 本机现状(2026-09-19 实测)

### 3.1 可作主脑的宿主(有 skill/MCP 扩展面,能把桥挂进去)

| 宿主 | 版本 | 挂载桥的位置 |
|---|---|---|
| Codex CLI | 0.155.0-alpha.9.2 | `codex mcp add`;skill 在 `~/.codex/skills/`;`~/.codex/AGENTS.md` 现为 0 行(空) |
| Claude Code | 2.1.224 | `--mcp-config` / settings;skill 在 `~/.claude/`、`~/.agents/skills/` |
| Gemini CLI | 0.60.0 | MCP 配置 + extensions;`--policy` / `--admin-policy` 策略引擎 |
| Qoder CN | 0.3.3 | **`~/.qoder-cn/mcp-router.json` 本地 MCP router**(HTTP,见 §4④) |
| WorkBuddy | 5.5.6 | **`~/.workbuddy/mcp.json`**(`mcpServers`)+ `mcp-approvals.json` 审批面 |
| QoderWork CN | 0.9.12 | `~/.qoderworkcn/` 的 `skills/`、`commands/`、`boot-services/` |

> Codex 的 `~/.codex/skills/` 支持**skill 自带 MCP server 与 triggers**,本机
> `nature-academic-search` 即活样本:`config/mcp-snippet.json` + `config/triggers-*.toml` +
> `mcp-server/` + `manifest.yaml`。这是"一次打包、宿主自动触发"的现成模板。

### 3.2 可作 worker 的 CLI

| harness | 版本 | 入口位置 | 层级 |
|---|---|---|---|
| Gemini CLI | 0.47.0 | `D:\DevEnv\node_global` | ① |
| Qwen Code | 0.18.1 | `D:\DevEnv\node_global` | ① |
| MiMo(小米) | 0.1.6 | `D:\DevEnv\node_global` | ① |
| OpenClaw | 2026.3.13 | `D:\DevEnv\node_global` | ① |
| Claude Code | 2.1.224 | `D:\DevEnv\node_global` | ② |
| Codex CLI | 0.155.0-alpha.9.2 | `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>` | ③ |
| CodeBuddy(腾讯) | 1.2.1 | `D:\DevEnv\node_global`(`cbc` 同版本别名) | ③ |
| Comate CLI(百度) | 1.0.7 | `D:\DevEnv\node_global` | ③(机器可读输出待验证) |
| OpenCode | 1.18.30 | `D:\DevEnv\node_global` | 装坏了,缺 `opencode-windows-x64` |

> **阻塞(2026-09-19 实测)**:本机 Claude Code 当前**跑不通** —— 它指向第三方代理
> (模型 `deepseek-v4-flash[1m]`、`apiKeySource: "none"`),调用返回 `API Error: 402 Insufficient Balance`。
> 适配器已实现且事件归一化已验证,但无法端到端产出真实回复。任何把 Claude 当 worker 的方案先卡在这里。

### 3.3 外围件(复用,不要重写)

`cc-switch`(`D:\CCSwitch`)、`mcporter` 0.7.3、`agent-browser` 0.27.3、
Ollama 0.31.1(`D:\Ollama`,模型 `D:\Ollama_Model`)——本地零边际成本档位。

### 3.4 配置残留(主程序已不在)

`~/.cursor`、`~/.trae-cn`、`~/.codebuddycn`、`~/.junie`、`~/.copilot`

### 3.5 解封凭证的动作清单 —— **当前瓶颈在这里,不在桥**

桥已建完并验证,**跨厂商协同也已跑通**(codex 生产 → 腾讯 CodeBuddy 评审,live 用例在内)。
下表是**各家 worker 的解锁状态**,列的是"还需要你本人操作"的事;
凡我没实测过确切命令的,都标了「未核实」,不要把猜测当步骤用。

| harness | 阻塞点(实测) | 解封动作 | 依据 |
|---|---|---|---|
| codex | 无 | —— | 能真正产出文本(层级③);**但不是唯一一家**,见 §3.6 与 CodeBuddy |
| Claude Code | ~~`402 Insufficient Balance`~~ → **2026-09-19 15:35 已解封** | 无需动作(用户已重置 deepseek 额度) | 桥内真派发实测:`status: ok`、`text: "pong"`、`init model=deepseek-v4-flash[1m] mode=plan`、4.5s。**注意成本:一个单词回复烧了 30169 input tokens**(系统提示开销) |
| Qwen Code | ACP 通,`session/new` 返 `-32000 Authentication required` | 二选一:跑 `qwen --auth-type=openai`,或设 `OPENAI_API_KEY` 环境变量 | `initialize` 返回的 `authMethods[0]._meta.args = ["--auth-type=openai"]` |
| Gemini CLI | **已不再是"未登录"**:带代理环境变量后 OAuth 登录成功,但 Google 判决页列**四个产品全未授权**(Code Assist / Cloud Code / Gemini CLI / Antigravity) | 只剩两条:`--project_id` 绑档位,或 AI Studio `GEMINI_API_KEY`。目录信任已不是瓶颈 | 实测见 §3.6 |
| MiMo | ACP 会话以 `end_turn` 结束但**零文本零 usage** | 配模型(**未核实**具体做法) | 实测会话正常结束却无产出 |
| OpenCode | npm shim 装坏 | `npm i -g opencode-windows-x64`(或 `-baseline`) | 实测报错原文就给了这两个包名 |
| Antigravity | agentapi 入口与鉴权已通,但 agent 不执行 | 已停手,见 §M3 | —— |
| Qoder CN | —— | 把桥放进项目级 `.mcp.json` / `.qoder/.mcp.json`,再到 Qoder 界面里确认 | app.asar 确认它读这两个文件;**GUI 内验证未做** |

优先级建议(2026-09-19 修订):**跨厂商那一步已经兑现了** —— 靠的是腾讯 CodeBuddy 复用 WorkBuddy
登录态,不需要任何新凭证(见 §3.6 与 `test/cross-review.test.mjs` 的 live 用例)。
此前这里写的"跨厂商是唯一还没兑现的收益点"**是错的**。现在充值 Claude 只属于"多一家档位",
不再是解锁项目收益的前提。

### 3.6 Gemini 登录为什么一直失败 —— 实测根因是**代理**,不是浏览器(2026-09-19)

**此前版本是错的**:我先后归因为"回调监听器超时死掉"和"非交互 stdin 被拒",两条都不成立。
真实链路是:`gemini -p` 能正常开浏览器、**授权码也确实打进了本机监听端口**(日志里有回调连接记录,
浏览器也渲染出"登录成功页"),失败发生在**下一步**——CLI 自己拿 code 去换 token 时:

```
Error authenticating: FatalAuthenticationError ... /token failed, reason: connect ETIMEDOUT 173.194.202.95:443
exitCode: 41
```

原因:浏览器走系统代理(`127.0.0.1:7897`),但 **Node 的全局 fetch 默认不读系统代理**,
所以 `oauth2.googleapis.com` 直连超时。**浏览器侧永远看不出问题**,它只是把 code 交出去然后等一个
不会来的响应——这就是"网页一直转圈"的全部真相。

实测对照(同一条 `POST https://oauth2.googleapis.com/token`):

| 方式 | 结果 |
|---|---|
| `curl` 直连 | `000`,8s 超时 |
| `curl -x http://127.0.0.1:7897` | `404`(端点可达,GET 无参数属正常) |
| `node -e fetch(...)` 裸跑 | `UND_ERR_CONNECT_TIMEOUT` —— 与 gemini 报错**完全一致** |
| `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node -e fetch(...)` | Google 返回 `unsupported_grant_type` —— **应用层应答,链路已通** |

**解封动作**:登录必须在带代理环境变量的进程里跑(Node 24 才支持这个开关):

```
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=localhost,127.0.0.1 gemini -p "..."
```

**结果(2026-09-19 15:25 实测)**:加上那两个环境变量后 **OAuth 登录真的成功了** ——
`~/.gemini/oauth_creds.json` 的 mtime 从 6/26 变成当天。但紧接着 Google 服务端把**账号档位**拒了:

```
IneligibleTierError: ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT', tierId: 'free-tier',
  tierName: 'Gemini Code Assist for individuals',
  reasonMessage: 'This client is no longer supported ... please migrate to the Antigravity suite' }]
```

也就是说 Gemini 在这台机器上**卡在两层墙,而且第二层不是我能配置的**:
代理墙(已破)→ Google 已停止对个人免费档支持这个 CLI 客户端(策略墙,不可绕)。

**Google 自己的判决页(2026-09-19 15:32,用户浏览器落在
`developers.google.com/gemini-code-assist/auth/auth_failure_gemini`)**:

> 错误:身份验证未成功完成。以下产品**尚未获得访问您账号的授权**:
> Gemini Code Assist · 使用 Gemini Code Assist 的 Cloud Code · **Gemini CLI** · **Antigravity**
> (页面"最后更新时间(UTC):2026-09-07")

这张页比 CLI 的 `IneligibleTierError` 更彻底:它说明该 Google 账号对**四个产品全都没授权**,
所以**"改走 Antigravity"这条退路对本账号也是死的**(原先只是记为"agent 不执行、我主动停手")。
**可走的路只剩两条,都需要用户本人**:① 把 CLI 绑到有相应档位的 Cloud project(`--project_id`);
② 改用 AI Studio 的 `GEMINI_API_KEY`(按铁律 1,桥不保管它,只作为该 CLI 进程的环境变量)。
**结论:层级① 的 Gemini 在本机按"不可用"记账,不要再投入时间。**

两个副作用记清楚:① 授权码一次性,失败一次就得重新走 consent;② 登录成功后**仍有一道目录信任闸门**
(`Gemini CLI is not running in a trusted directory`,可用 `--skip-trust` / `GEMINI_CLI_TRUST_WORKSPACE=true` /
交互模式信任该目录),那是**安全边界而非故障**,由用户决定,桥不代改 `~/.gemini/trustedFolders.json`。

**可推广的结论**:凡是"浏览器 OAuth 卡住但没报错"的 CLI,先怀疑**子进程自己的 HTTP 客户端不走系统代理**。
本机的聚合代理只救浏览器,不救 Node/Go 写的 CLI —— Claude Code / Qwen 若出现同类症状,同一招先试。

**独立佐证(2026-09-19,来自用户自己的工具链)**:桌面 `Antigravity 中文代理版.lnk` →
`D:\vpn\start-antigravity-cn.cmd` → 同名 `.ps1`,其内容**只有**两件事:
`HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy = http://127.0.0.1:7897` + `NO_PROXY=localhost,127.0.0.1`
(外加 `LANG=zh_CN.UTF-8`),然后 `Start-Process Antigravity.exe --lang=zh-CN`。
即用户早就在用"给进程塞代理环境变量"这一招让 Antigravity 出网 —— 与上面诊断同一条路。

**上面那个"遗留矛盾"已由用户截图(2026-09-19 15:37)推翻,更正如下 —— 此前"大概是另一个账号"的猜测是错的。**
Antigravity 登录的**就是同一个 Google 账号**(账号标识已在入库前抹去,界面上可见),而且**功能正常**:
项目列表、会话历史、模型选择器 `Gemini 3.8 Flash High`、`Security Preset: Turbo Mode`、
`Artifact Review Policy: Always Proceed` 都在。

**这张页不能当判决用(2026-09-19 用户更正,我此前读过头了)**:标题是"登录失败 / 身份验证未成功完成",
它只说明**这次 OAuth 流程没走完**,所列四个产品因此**没有拿到授权**——这是"没登录成"的后果,
**既不能证明也不能否定账号权限**。我当时把它当成"Google 对账号的判决",是过度解读。

真正有证据力的只有两条,而且它们不矛盾:

- **CLI 侧**:`IneligibleTierError / UNSUPPORTED_CLIENT / tierId: 'free-tier'`,原文是
  "This client is no longer supported for Gemini Code Assist for individuals … migrate to the Antigravity suite"。
  这是服务端对**客户端+档位**的策略答复,不是"未登录"类错误。
- **Antigravity 侧**(用户截图 15:37):**同一个 Google 账号**在 Antigravity 里**功能完全正常**
  (项目列表、会话历史、`Gemini 3.8 Flash High`、`Turbo Mode`、`Always Proceed`)。
  → **账号有权,被退役的是 `gemini` 这个 CLI 客户端**,与 Google 那句"迁到 Antigravity"自洽。

**最终定案(2026-09-19 15:45,用户在真实交互 PowerShell 里跑,带全套代理变量)**:
菜单里直接印出 ——

> Failed to sign in. Message: **This client is no longer supported for Gemini Code Assist for
> individuals.** To continue using Gemini, please migrate to the Antigravity suite of products

同一窗口**不设**代理时报的却是"Authentication consent could not be obtained"。
两句一对比就把两道墙分清了:**代理墙导致换 token 失败(已破);破掉之后露出的是客户端退役墙(不可绕)。**
所以此前"大概是登录没走完"的怀疑到此为止 —— 登录走完了,服务端仍然拒绝这个 CLI。

**因此结论是**:账号有权,墙在客户端。Antigravity 重新成为候选 worker,但**不等于可用**:
它此前的卡点是 `agentapi` 无头入口不执行,且它的项目就是用户的真实工作区(另外两个无关项目的目录,
名称已在入库前抹去),
`Always Proceed` + `Turbo Mode` 意味着派错地方会直接改真实文件。**在没想清楚隔离之前,不要往它派发。**

**"升级 CLI 能不能救"已排除(2026-09-19 实测)**:本机 `@google/gemini-cli` 是 **0.60.0**,
`npm view @google/gemini-cli version` 也是 **0.60.0** —— 装的就是最新版,Google 仍然拒绝这个客户端。
所以剩下的只有 `--project_id`(需有档位的 Cloud project)或 AI Studio `GEMINI_API_KEY` 两条,
**升级/重装都无效,别再往这个方向试**。
(附带更正:本文 §3.1/§3.2 的"0.47.0"是当天早些时候的漂移值,现值 0.60.0。)

## 4. 核心设计:五级集成模型

按"能不能持会话 / 用什么口子接"分级。**各级编排语义天生不一致**,桥的核心工作量就是把它们
归一化成同一套 `dispatch / poll / collect` 语汇。差异必须收敛在 adapter 内,不许漏到调度器。

### ① 会话协议(长连接、多轮、可取消)——语义最完整

原生 ACP(Agent Client Protocol)。桥内跑 ACP client,持 JSON-RPC 长连接。

Gemini `--acp` · Qwen `--acp` · MiMo `mimo acp` · OpenClaw `openclaw acp`

### ② 双向流 + 会话恢复

非标准协议,能力等价。桥需常驻子进程、按行写 JSON。

Claude Code:`--input-format stream-json`(仅与 `--print` 同用)、`--resume`、
`--session-id <uuid>`、`--fork-session`(恢复时新建 session ID,可在同上下文上并行开分支)、
`--json-schema <schema>`(**结构化输出,本级关键**)、`--agents <json>`。

### ③ 一次性子进程(无状态,无上下文继承)

Codex `codex exec`(另有 `review` / `resume` / `fork` / `apply`)· CodeBuddy · Comate CLI

### ④ 本地 API / CDP(GUI 宿主,2026-09-19 新确认)

| 宿主 | 口子 | 实测 |
|---|---|---|
| Qoder CN | 本地 MCP router,`http://127.0.0.1:57913` | `/`、`/health`、`/mcp` 全 401(需 `mcp-router.json` 的 `apiKey`);另有 50358 返 404 |
| Antigravity | **CDP**,`http://127.0.0.1:63004` | `/json/version` 返 Chrome/146.0.7680.72 + Electron/41.0.2 + `webSocketDebuggerUrl`;`/json/list` 有 live page target。另有 63005 为 401 JSON API |
| WorkBuddy | 本地 HTTP + MCP | 52347 返应用 HTML;18488/61924/63603 对根路径 404(API 路径待探) |

**这一级的两种用法不同,别混:**

- **当主脑**(推荐优先):把桥注册进宿主自己的 MCP 配置(Qoder 的 `mcp-router.json`、
  WorkBuddy 的 `mcp.json`),宿主就能在它自己的会话里调用桥。
- **当 worker**:走本地 API 或 CDP 驱动。Antigravity 用 Playwright `connectOverCDP` 接 63004,
  比像素模拟可靠得多;Qoder 的 MCP router 需要 token。

### ⑤ computer-use(最后手段)

仅当 ①~④ 全不可用时。现有件:`QoderComputerUse`(`~/.qoder-cn/bin/`)、
`codex-computer-use-swift`、`agent-browser`。慢且脆,且必须走 AGENTS.md 的审批闸门。

### 4.1 一个必须记住的否定性结论

`codex agents` / `codex queue --thread <UUID>` / `codex fork` / `--remote ws://` / `app-server` /
`exec-server`,以及 Claude 的 `~/.claude/daemon/`(`control.key` / `dispatch` / `pty-pids`,
状态含 `supervisorPid` + `workers`),**全都是域内编排**——队列里只能塞自家 session。

> 因此:**"主 harness 当大脑"这个角色不由任何厂商的 harness 提供,由本项目的桥提供。**
> 各宿主只是桥里"当前接入的编译器",可随时替换。

### 4.2 端口的动态发现(硬约束)

上面所有端口都是**进程启动时分配的临时值**,下次重启就变。adapter 必须:

- 从宿主自己的登记文件读端口/凭证(`~/.workbuddy/tencent-docs-engine.port`、
  `~/.qoder-cn/mcp-router.json` 的 `pid`/`baseUrl`、Antigravity 的 CDP 启动参数),
- 或从受管进程反查监听端口。
- **禁止把端口号硬编码进源码**;`detect()` 找不到就显式标记该宿主不可用。

## 5. 架构分层

```
   ┌──────────────┬──────────────┬──────────────┬─────────────┐
   │ Codex        │ Claude Code  │ Gemini       │ Qoder /     │
   │ (当前会话)   │ (当前会话)   │ (当前会话)   │ WorkBuddy   │
   └──────┬───────┴──────┬───────┴──────┬───────┴──────┬──────┘
          └──────────────┴──────────────┴──────────────┘
                        │ 同一个 MCP server,挂进 N 家宿主
          ┌─────────────▼──────────────────────────────┐
          │  llms-bridge MCP server                    │
          │  harness.list / dispatch / poll / collect / cost │
          └─────────────┬──────────────────────────────┘
                        │
          ┌─────────────▼──────────────────────────────┐
          │  统一任务模型 + 调度器                      │
          │  审批闸门 / 成本上限 / worktree 隔离          │
          └──┬────────┬────────┬────────┬──────────────┘
             │        │        │        │
        ┌────▼───┐┌───▼────┐┌──▼─────┐┌─▼──────────┐
        │ACP ①   ││流 ②    ││一次性 ③││本地API/CDP ④│
        └────────┘└────────┘└────────┘└────────────┘
                                        (⑤ computer-use 兜底)
```

### 5.1 统一任务模型

```jsonc
{
  "task_id": "uuid",
  "harness": "gemini",              // 必须显式指定;不做按能力自动选人(见 §8)
  "prompt": "...",
  "cwd": "D:\\...\\worktrees\\<task_id>",
  "approval": "workspace-write",    // 必填,无默认值,见 AGENTS.md
  "budget": { "max_tokens": 0, "max_wall_ms": 0 },
  "session": { "mode": "fresh" },   // fresh | resume | fork
  "model": "gpt-5.6-sol"            // 可选。换模型 ≠ 跨厂商(见下)
}
```

**关于 `model`(2026-09-19 新增)**:codex 与 claude 的 adapter 已支持按任务指定模型
(codex `-m <model>`,claude `--model <model>`)。加它是因为本机 codex 走聚合代理
(`model_provider = "custom"`、`base_url = https://api.yescode.cloud`、默认模型 `gpt-5.6-sol`),
一个 provider 后面可能挂多家模型 —— 在跨厂商被凭证卡住时,这是唯一还够得着的多样性来源。

但必须分清:**换模型 ≠ 跨厂商。** 同一家换模型能减少"同一模型的固定盲区",
消除不了"同一厂商/同一代理的一致盲区"。任何场景下都不许把它宣称成"已做交叉评审"。

### 5.2 统一事件模型

**以 Claude 的 stream-json 为基准**(最完整),其它厂商向它归一化:

```
status | message | tool_call | tool_result | diff | usage | error | result
```

### 5.3 关键设计约束

1. **`dispatch` 必须异步**。worker 跑几分钟到几十分钟,同步等会拖超时;立即返 `task_id`,
   `poll` / 通知回传。
2. **MCP server 不持有凭证**,只做派发。各 CLI 复用自身登录态。本地 API token 的处理见
   AGENTS.md 铁律一补充条款。
3. **并行 worker 各自 git worktree —— 已实现**(`src/worktree.ts`)。

   写任务(`approval != read-only`)在 git 仓库下自动分配 `--detach` worktree,
   路径为 `<repo>/.llms-bridge/worktrees/<taskId>`;worker 的 cwd 换成该 worktree,
   **源仓库不动**。跑完 `git add -A` + `git diff --cached` 把改动回收成一条 `diff` 事件
   (统一事件模型里 `diff` 类型的第一个真实使用点),worktree **保留**不删,路径回传给调用方。
   容器目录写进仓库本地的 `.git/info/exclude`(而非版本化的 `.gitignore`),源仓库 `git status`
   因此保持干净。

   非 git 目录下的写任务**默认拒绝**,必须显式传 `allowUnisolatedWrite: true` 才放行,
   且结果标记 `isolated: false`;此时仍禁止同一 cwd 并发写。

   实测(2026-09-19,一次性测试仓库):写任务 `isolated=true`,源仓库根目录无新文件、
   `git status` 干净、worktree 内存在 worker 创建的文件、`git worktree list` 两边 HEAD 一致。
   配套验证:非 git 目录被拒(附铁律三理由);显式放弃隔离后放行并标 `isolated=false`。
4. **五级语义差异显式标注**:① 可多轮;② 靠 `--fork-session` 开分支;③ 无上下文继承;
   ④ 端口动态、需鉴权;⑤ 慢且脆。

### 5.4 验证方式:`npm test`

`node --test`,零依赖(用 Node 内置 test runner)。
**2026-09-21 07:07 实测:56 个用例 / 53 通过 / 0 失败 / 3 按设计跳过**(整套约 77 秒)。
引用这句前先重跑 —— 用例数会随功能漂,写死的数字就是下一个漂移点(今天已经从 19 漂到这里两次)。

| 文件 | 覆盖 |
|---|---|
| `test/mcp-protocol.test.mjs` | MCP 握手与工具清单、**四个闸门必须真的拦住**(full 未开闸 / 缺预算 / 未知 harness / 非 git 目录写任务)、`harness_list` 结构契约;**GUI 宿主 stdio 兼容不变量**(未 `initialize` 就请求 `tools/list` 必须存活有应答;非 JSON 行必须回 `-32700` 而不崩 —— Qoder 会先发探测请求,应答不了就挂不进) |
| `test/worktree.test.mjs` | 隔离不变量:源仓库干净、容器目录进 `.git/info/exclude` 而非 `.gitignore`、worker 写的文件不出现在源仓库、diff 可回收、回收无残留、并行 worktree 互不干扰、`--detach` 不污染分支、清理默认 dry-run |
| `test/isolation-stub.test.mjs` | **用桩适配器覆盖"写任务→worktree→diff 回收→超长截断"整条链,零额度**。此前这条链只能靠真派发覆盖,改坏了要花钱才知道。含 `diffTruncated` 的三态契约(false / true / 无 diff 时 undefined),以及**沙箱根不变量**:交给 adapter 的 `spec.cwd` 必须是 worktree 而非源仓库 —— 已用变异测试验证这条会红(把 `createRun(runSpec)` 换成 `createRun(原 spec)` 后仅它失败,其余三条照样绿,说明该不变量此前无人看守) |
| `test/adapters.test.mjs` | 统一契约(id 唯一、tier 合法、审批档位合法)、三级横截面都有代表、未探测就 `plan()` 必须抛错、`detect()` 不可用必须给出原因 |
| `test/cross-review.test.mjs` | 评审基线与隔离边界(零额度,默认跑);跨厂商评审 + **三家投票**(需额度,默认跳过) |

**写测试文件时注意**:`test/*.test.mjs` 是**纯 JS**,不能出现 TS 语法(类型标注、`import type`、
非空断言 `!`),否则整份文件加载即失败 —— 已经栽过一次。类型只在 `src/*.ts` 里用。

**真实派发与交叉评审会花模型额度,默认跳过**;要跑用 `LLMS_BRIDGE_LIVE=1 npm test`
(或 `npm run test:live`)。默认套件**零额度消耗**。整套约 72 秒,其中约 16 秒是层级① 的真实
ACP 握手(固有开销)、约 8 秒是 `harness_list` 的并行探测 —— 这两块都是外部 CLI 的启动成本,
不是桥自己的开销。

### 5.5 一条性能约束(踩过)

**探测必须排在参数校验之后。** 曾经在 MCP handler 里先 `await detectAll()` 再 `dispatch()`,
导致"审批未开闸"这类纯拒绝也要白等一整轮 ACP 握手 —— 实测 **8146ms**。
移到校验之后降到 **37ms**。派发路径上任何"先做重活再校验"的写法都会重现这个毛病。

另外:`detectAll()` 结果必须缓存且**并行**探测(各家 ACP 不通的会等到超时,串行会叠加);
MCP server 启动时应后台预热,否则第一次调用要等一整个探测周期。

## 6. 里程碑

### M1 — 三级横截面(先打通,不铺适配器)

各取一条,跑通 `dispatch → 结构化 result`:

- ① ACP:Gemini `--acp`
- ② 双向流:Claude `--input-format stream-json` + `--json-schema`
- ③ 一次性:Codex `exec`

验收:三条路径返回同构的 `result` 事件。

**M1 进度(2026-09-19)**

- ③ Codex —— **已端到端跑通**。`status: ok`、`text: "pong"`、用量 20169/5,7 条事件归一化。
- ② Claude —— 适配器已实现,`detect()` 与事件归一化已验证;因账号余额阻塞,只跑出
  `status: failed` + 402 原因(如实报告,未假装成功)。
- ① ACP —— **已实现并协议验证**。写成通用 adapter(`src/adapters/acp.ts`),不绑某一家。
  - **Gemini `--acp` 本机失效**:进程存活但 stdout/stderr 一个字节都不出(`--experimental-acp`、
    protocolVersion 1/13 都试过)。bundle 里确实有 ACP 实现,是入口不工作 → **未注册**。
  - **Qwen `--acp`**:握手成功,`qwen-code 0.18.1 (ACP v1)`;`session/new` 返回 -32000 未鉴权。
  - **MiMo `mimo acp`**:握手成功,报的 agent 名却是 **`OpenCode 0.1.6`** —— 说明 MiMo CLI 是
    OpenCode 的套壳(这也解释了为何 OpenCode 自己的 npm shim 坏了却能用 mimo)。
    `session/new` 成功,`session/prompt` 以 `stopReason: end_turn` 正常结束,
    **但无任何文本产出、usage 全为 0** → 判定为失败并给出可执行原因(模型未配置/未鉴权)。
  - **OpenClaw `openclaw acp`**:initialize 无响应 → 未通过。
  - 修掉两个真 bug:①会话型协议是我们主动 kill 才结束,退出码天然非零,不能据此判失败
    (改为协议自报完成即算完成);②"end_turn 但零文本零 usage"必须显式报失败,
    否则主脑会拿到一个空洞的成功。
- 骨架已落:`src/types.ts`(统一模型)、`src/scheduler.ts`(异步 dispatch/poll/collect + 审批闸门
  + 预算中断 + 并发写保护)、`src/proc.ts`(进程树中断)、`src/locate.ts`(动态定位,不硬编码路径)。

**已实测的枚举/形状(写进 adapter,不要凭记忆改)**

- Codex `-s`: `read-only` / `workspace-write` / `danger-full-access`
- Codex `approval_policy`: `untrusted` / `on-failure` / `on-request` / `granular` / `never`
- Claude `--permission-mode`: `acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan`
- Codex `exec --json` 事件:`thread.started` / `item.started|updated|completed` / `turn.started` /
  `turn.completed`。已实测的 item.type:`agent_message`、`error`、`mcp_tool_call`
  (字段 `server/tool/arguments/result/error/status`)。注意 `item.type === "error"` 也用于
  **非致命告警**(如配置项被忽略),成败只看退出码。
- ACP(层级①):ndjson over stdio,`protocolVersion: 1`;
  `initialize` → `{protocolVersion, agentInfo:{name,title,version}, authMethods, agentCapabilities:{loadSession, promptCapabilities, sessionCapabilities:{list,resume}}}`;
  `session/new {cwd, mcpServers}` → `{sessionId}`,未鉴权返回 `{code:-32000, message:"Authentication required..."}`;
  `session/prompt {sessionId, prompt:[{type:'text',text}]}` → 流式 `session/update` 通知,
  最终响应含 `{stopReason, usage}`。已观察到的 update 取值:`available_commands_update`、
  `usage_update`;`agent_message_chunk` 尚未观察到(因无一家能真正产出文本)。

### M2 — 挂进多家宿主(本项目的真正价值所在)

**状态:Codex 已打通(2026-09-19 实测验收)。** 在 Codex 会话里成功调用桥的工具并拿回结果:

```
{"type":"mcp_tool_call","server":"llms-bridge","tool":"harness_list",...,"status":"completed"}
{"type":"agent_message","text":"qwen\nclaude\ncodex"}
```

#### 更正:项目级 `.mcp.json` 对 Codex **无效**

此前从 Codex 二进制的配置发现路径表里读到 `.mcp.json`,推断"放一份项目级 `.mcp.json`
就能被 Codex 采纳"——**实测推翻了这个推断**。在项目根放 `.mcp.json` 后,`codex exec`
只挂上了自己的内置 MCP 工具,桥的工具不可见(模型直接回 "harness_list unavailable")。

教训:字符串表里有某个路径 ≠ 运行时会在该项目上下文里加载它。二进制里的路径清单可能用于
别的用途(如按需导入其它工具的配置)。

**可用的挂载方式(已验证)**:写 `~/.codex/config.toml` 的 `[mcp_servers.*]`
(即 `codex mcp add`),或用 `-c` 参数临时注入而不落盘:

```
codex exec -c 'mcp_servers.llms-bridge.command="node"' \
           -c 'mcp_servers.llms-bridge.args=["<绝对路径>/src/mcp-server.ts"]' ...
```

`codex mcp list` 会显示 `llms-bridge ... enabled`,确认挂载成功。

#### 硬约束:宿主审批策略会拦 MCP 工具调用

实测 `-s read-only` 下工具调用被拒:

```
{"server":"llms-bridge","tool":"harness_list",
 "error":{"message":"MCP tool call requires approval, but approval policy is never"},"status":"failed"}
```

原因:`-s read-only` 隐含 `approval_policy=never`。
`approval_policy` 合法取值:`untrusted` / `on-failure` / `on-request` / `granular` / `never`。

无人值守场景用 **`--approve-for-me`**(走自动审查通道)后可正常调用。
注意 `--dangerously-bypass-approvals-and-sandbox` 是 AGENTS.md 明令默认禁用的档位,不要用它绕。

> 这条要写进"如何把桥装进某宿主"的说明里:**不是装上就能用,宿主的审批策略必须允许 MCP 调用**。
> 这与桥自己的 `approval` 字段是两层不同的闸门,别混。

#### 各宿主实测结果(2026-09-19)

| 宿主 | 挂载方式(实测) | 当前状态 |
|---|---|---|
| **Codex** | ✅ `codex mcp add llms-bridge -- node <abs>/src/mcp-server.ts`(写进 `~/.codex/config.toml`) | **可用** —— 普通会话里已实际调到桥。**项目级 `.mcp.json` 对它无效**(实测证伪) |
| **Claude Code** | ✅ 项目级 `.mcp.json`(它读这个) | **未测,不是"待批准"** —— 早先那条 `⏸ Pending approval` 是在**别的 cwd** 观察到的,不能拿来当本项目的结论。实测(2026-09-19 13:38)`~/.claude.json` 的 32 个项目条目里**没有 `D:\LLMS_Bridge`**,即 Claude Code **从未在这个目录启动过**,所以桥有没有被认出、要不要批准,**两说**。往项目 `.claude/settings.json` 加 `enabledMcpjsonServers` 已实测**无效**(信任状态记在 `~/.claude.json` 的按项目条目里)。要做的事只有一件:在项目目录**交互式跑一次 `claude`**。另:其 `ANTHROPIC_BASE_URL = https://api.deepseek.com/anthropic` |
| **Gemini** | ✅ 项目级 `.gemini/settings.json`(`gemini mcp add --scope project`) | **已注册但被禁用** —— `disabled because this folder is untrusted`。解法见 §3.5 |
| **Qoder CN** | ✅ 项目级 `.qoder/.mcp.json` + 项目 `.mcp.json` | **配置已就位**(app.asar 确认它读这两个路径:`sourcePath: Ae(A,".qoder",".mcp.json")`),**GUI 内确认未做** |
| **WorkBuddy** | ❌ **手改 `~/.workbuddy/mcp.json` 不生效**(此前我记的"正门"是错的) | **实测否证(2026-09-21)**:按 `command`/`args` 加入 `llms-bridge` 后启动 WorkBuddy —— 它**不回写该文件**(mtime 仍是我写入的时间)、**不生成审批条目**(`mcp-approvals.json` 只有 `mcd-mcp`/`lighthouse-ops`)、**UI 无任何提示**。**已还原**,与备份逐字节一致。要走它自己的连接器 UI。 |

结论:**各厂商的 MCP 发现行为不一致,不能靠一份 `.mcp.json` 通吃。**
每个宿主都要单独实测并记录,这正是 `AGENTS.md` 要求"断言前穷举验证"的原因。

> 一个真实踩到的坑:用 `cat > .qoder/.mcp.json <<'EOF'` 写 Windows 路径时,`\\` 被吃成单个 `\`,
> 在 JSON 里 `\L`/`\s` 是**非法转义**、解析直接失败。写含 Windows 路径的 JSON 一律走 Write 工具,
> 并在写完后用 `JSON.parse` 校验一遍。

#### 第二道闸门:宿主自己的 MCP 审批

两家都拦,但拦法不同:

- **Codex**:`-s read-only` 隐含 `approval_policy=never`,直接失败;`--approve-for-me` 可过。
- **Claude Code**:报 `⏸ Pending approval (run claude to approve)` —— 需要在交互式会话里批准一次。

所以"装进宿主"这件事分两步:**① 让宿主发现这个 server ② 让宿主批准调用它**。
第二步是人机交互或策略配置,桥管不了,必须写进使用说明。

前置:`mcporter config import <kind>` 在本机对 claude / cursor / gemini / windsurf / vscode
一律返回 "No entries found",只有 Codex 的 config.toml 里有 server —— 没有现成注册点可导入,得主动写。

验收(针对"任意一家"):在**任意**一家的会话里,都能调起桥并派活给另一家。
**当前:Codex 已完成端到端验收;Claude 已"被发现",待批准(且受余额阻塞)。其余未测。**

### M2.5 — 补齐宿主接入

按 §6 M2 表格逐个实测,每接一家就记录:挂载方式、审批方式、实测证据。
优先 Qoder(疑似白捡)与 Gemini。

### M3 — 层级④ 打通

**Antigravity 有官方无头 agent 入口(2026-09-19 发现,但执行未跑通)**

入口在语言服务器里,不是独立 CLI:

```
%LOCALAPPDATA%\Programs\antigravity\resources\bin\language_server.exe agentapi <cmd>
~/.gemini/antigravity/bin/agentapi.bat            # 等价包装(由 Antigravity 自己维护)
```

命令面(实测 `--help`):

```
get-conversation-metadata <conversation_id>
new-conversation [--model=<flash_lite|flash|pro>] [--title=<title>] [--profile=<profile>] <prompt>
send-message [--title=<title>] <recipient_id> <content>
```

**跑通需要的三个环境变量**(都是二进制的字符串表里读出来的,不是猜的):

| 变量 | 值从哪来 | 实测 |
|---|---|---|
| `ANTIGRAVITY_LS_ADDRESS` | 运行中的 LS 端口。63006 是 **gRPC** 口(报 preface/EOF),**63007 才是对的 HTTP 口** | 缺了报 `ANTIGRAVITY_LS_ADDRESS is not set` |
| `ANTIGRAVITY_CSRF_TOKEN` | 63007 的 UI HTML 里 `__APP_CONFIG__.csrfToken`(会轮换,每次现取) | 缺了报 `Unauthenticated: missing CSRF token` |
| `ANTIGRAVITY_PROJECT_ID` | `%APPDATA%\Antigravity\app_storage.json` 的 `lastCreatedProjectId` | 缺了报 `project_id is required when providing project_env_config` |

三个都给齐后 —— **`new-conversation` 成功返回 conversationId**,即鉴权链完全正确:

```json
{"response":{"newConversation":{"prompt":"Reply with exactly one word: pong",
 "conversationId":"b97b73f8-..."}}}
```

**但 agent 没有真的跑**:会话 db(`~/.gemini/antigravity/conversations/<id>.db`)只有 2 个
step、status 恒为 3,25 秒无进展;`get-conversation-metadata` 只返回 metadata 不含回复;
db 是 **protobuf 字节数组**(`steps`/`gen_metadata`),扫可读 ASCII 只找到**提问**、没有回答。

推测原因之一:会话绑的 workspace 是 LS 自己的默认目录(本机上指向另一个无关项目,名称已抹去),
而不是我们给的 cwd,
可能要求该 workspace 正在 IDE 里打开、由 IDE 驱动执行。

**结论:入口与鉴权已查明可用,但"派活 → 取回复"这条链还差执行/取回两环,当前不可用。**
要继续就得逆向 LS 的 gRPC(`GetTrajectory` / `load_trajectory`,proto schema 未知)——成本较高,
按"未公开接口、best-effort"对待,不要在上面赌关键路径。

**其余宿主**

- **Qoder CN —— 正确路径是走它自己的 MCP 配置,不要驱动它的内部运行时。**
  已核实:`app.asar` 明确读项目级 `.mcp.json` / `mcp.json`,以及 `.qoder/.mcp.json`
  (`sourcePath: Ae(A,".qoder",".mcp.json")`)。所以把桥放进这些文件即可被 Qoder 采纳。
  **但要由用户在 Qoder 界面里确认** —— GUI 内验证未做。
- **不要试图直接 spawn Qoder 的 agent 引擎。** 它的运行清单
  (`~/.qoder-cn/logs/runs/*/manifest.json`)确实暴露了完整调用形态:
  `Qoder CN.exe <...>/qoder-worker-runtime.obf.mjs --print --output-format stream-json
  --input-format stream-json --model qfmodel --permission-mode acceptEdits --mcp-config {...}`,
  即一个 Claude Code 兼容 CLI,理论上可直接当 worker。**但实测执行被安全护栏拦下**
  (理由是绕过厂商意图的宿主环境、且可能违反许可),**这个判定是对的,不要再尝试**。
  另注:它的 MCP router 是**会话级**路径
  (`127.0.0.1:57913/mcp/sessions/<sessionToken>/servers/<serverId>`,头用 `X-Api-Key`),
  说明那是给它自己 agent 运行用的,不是给外部注册用的。
- **Antigravity CDP**(63004)仍在,可作为另一条 best-effort 路径。

### M4 — 交叉评审闭环

让第二家 harness 审第一家的 diff。**这是多厂商协同真正的收益点**,否则只是并行跑同一个模型。

**已实现的部分(机制)**

- `TaskResult.diff` —— worker 的 unified diff 直接放在结果里,**一步可取**,不用去翻事件流。
  这是交叉评审的输入。超长会截断并标注。
- **固定流程写进了 SKILL.md**(五步:生产 → 轮询 → 取 diff → 把 diff 交给另一家评审 → 一起呈现),
  让主脑照做,而不是每次自己发明。配套四条纪律:
  ① reviewer 用 `read-only`(评审不需要写权限);② reviewer 必须是**另一家**,自审不算;
  ③ `diff` 为空就别评审(空转);④ **不自动合并**,把 worktree 路径与 diff 交给用户决定。
- skill 里还写明了前置条件:`harness_list` 里必须有两家 `available: true` **且 note 不含
  "未鉴权/未配置"**,否则要如实告诉用户"当前只有一家能跑,做不了交叉评审"。

**验证状态(必须分清)**

| 维度 | 状态 |
|---|---|
| 流程机制(隔离 → 回收 diff → 交给第二轮 → 取结论) | 有 live 用例 `test/cross-review.test.mjs`,由 `LLMS_BRIDGE_LIVE=1` 开启 |
| 评审用仓库的基线/隔离边界 | 默认套件里就跑(零额度) |
| **跨厂商**本身 | **未验证**。本机只有 codex 一家能产出文本,所以 live 用例里 producer 与 reviewer 都是 codex —— 验的是机制,不是"跨厂商"。第二家凭证解封后必须重验,不要在文档里混为一谈 |
| 只剩一家时的降级做法 | 支持给同一家传 `model` 获得**模型级**差异(codex `-m` / claude `--model`,零额度单测已覆盖 argv 构造)。**但这必须如实标注为"同一家的另一个模型",不得说成跨厂商交叉评审** |

### M5 — 下沉为 skill + 常驻策略

**已完成的部分(2026-09-19 实测验收)**

- skill 落在 `~/.codex/skills/llms-bridge/`:`SKILL.md` + `config/triggers-llms-bridge.toml` +
  `config/mcp-snippet.json`(注册参考 + 撤销命令)。
- 桥用 Codex 官方命令注册进全局:`codex mcp add llms-bridge -- node D:\LLMS_Bridge\src\mcp-server.ts`
  → `codex mcp list` 显示 `enabled`。**注意项目级 `.mcp.json` 对 Codex 无效**(已实测),必须走这条路。
- **验收**:在**普通** Codex 会话(不带任何 `-c` 注入)里调用成功,`harness_list` 回出全部五家
  及其真实可用性与 note:
  ```
  {"type":"mcp_tool_call","server":"llms-bridge","tool":"harness_list",...,"status":"completed"}
  {"type":"agent_message","text":"qwen\nmimo\nopenclaw\nclaude\ncodex"}
  ```
- 撤销:`codex mcp remove llms-bridge`;skill 是新增目录,删 `~/.codex/skills/llms-bridge/` 即可。

**SKILL.md 的设计要点**(不是随手写的说明)

- description 只覆盖两类**真有价值**的场景:交叉验证、成本分流;并明确"没有这两个特征就别派发"。
- 正文要求先调 `harness_list` **读 note** 再决定 —— 因为 `available: true` 只说明二进制与协议通了,
  `note` 里才写着"未鉴权/模型未配置"这类"装了但用不了"。
- 失败处理写成规则:`reason` 提示凭证问题时**如实上报是哪一家缺什么,不许换一家假装完成,
  也不许重试同一家**。

**未完成**

- 挪到共享 `~/.agents/skills/`(Codex 会读,但对其它宿主的实际读取仍未实测,先不挪)。
- 各宿主的常驻策略:目前只有本仓库的 `AGENTS.md`。`~/.codex/AGENTS.md`(全局,当前 0 行)未写 ——
  要写"超过 N 行的改动至少两家交叉评审"这类默认路由规则时需要用户先定 N 与默认档位。

## 7. 风险

| 风险 | 对策 |
|---|---|
| 默认开 yolo 类开关,跨厂商派发失控 | `approval` 必填;默认拒绝全权模式。见 AGENTS.md |
| 桥成为凭证集中点,一处失守全线沦陷 | 桥不落盘 key;本地 API token 只就地复用。见 AGENTS.md |
| MCP 同步调用被长任务拖死 | `dispatch` 异步 + `poll` |
| 并行写盘互相覆盖 | 每 worker 一个 worktree |
| 端口/版本漂移导致 adapter 静默失效 | `detect()` 动态发现;失败显式标记不可用,不静默降级 |
| 五级语义不一致导致调度器逻辑分叉 | 差异收敛在 adapter 内,对外只暴露统一事件模型 |
| CDP/本地 API 属宿主未公开接口,上游一变即断 | 层级④ 视为 best-effort,不承认为稳定契约;失败回落到③或⑤ |

## 8. 待验证与未实现(诚实记账板)

### 8.1 已结掉(不要再当未知项)

- ~~Qoder 的 MCP router 是否接受外部注册的 MCP server~~ → **不接受**。实测其 URL 形如
  `127.0.0.1:57913/mcp/sessions/<sessionToken>/servers/<serverId>`(头用 `X-Api-Key`,
  值在 `~/.qoder-cn/mcp-router.json`),是**会话级**的,给它自己的 agent 运行用。
- **更正(2026-09-19 晚):上一条曾写"挂桥进 Qoder 要走项目级 `.mcp.json`",这不完整、且方向也不对。**
  GUI 的「添加自定义 MCP」弹窗明说配置保存到 **`~/.qoder-cn/settings.json` 的 `mcpServers` 字段** ——
  这才是它给用户注册外部 server 的正门。两条实测补充:
  ① 项目级 `.mcp.json` 与 `.qoder/.mcp.json` **确实没有**把桥带进会话(本会话就起在 `D:\LLMS_Bridge`,
  而其权威工具清单里没有 `llms-bridge`);② 用户级 `~/.qoder-cn/shared_client/mcp.json` 的
  `mcpServers` 是**空对象**,故那里不是当前生效的注册面。
  已按弹窗形态备好 stdio 配置并用**同一 node 二进制实测握手成功**(`tools/list` 返回 5 个原语):
  `{"mcpServers":{"llms-bridge":{"command":"D:\\node.js\\node.exe","args":["D:\\LLMS_Bridge\\src\\mcp-server.ts"]}}}`。
  注意 `settings.json` 里原本有 `enabledPlugins`,若导入采用整体覆盖而非合并会把它冲掉 —— 已留备份
  `~/.qoder-cn/settings.json.bak-llmsbridge`。**GUI 内导入结果仍未验证**(见 §8.2)。
- ~~Antigravity 的 CDP 口是否需显式开~~ → **默认就开**。其 userData 下有 `DevToolsActivePort`
  (QoderWork CN 同样有),说明 Electron 侧已启用远程调试;实测 `127.0.0.1:63004` 可连,
  `/json/version` 返回 `webSocketDebuggerUrl`。
- ~~各厂商 ACP 的版本差异~~ → 差异主要不在**版本号**而在**实现是否真的入口可用**:
  qwen / mimo 的 `--acp` / `acp` 握手正常(均报 ACP v1),gemini 的 `--acp` 与
  `--experimental-acp` **静默无响应**(进程存活、零字节输出),openclaw 的 `acp` initialize 无响应。
  **⚠ 但 gemini 那条测于未鉴权状态,不能当"ACP 入口坏了"的结论**(2026-09-19 晚补注):
  当天查明该账号被 Google 挡在 "This client is no longer supported for Gemini Code Assist for
  individuals",静默很可能就是鉴权被拒的表现。若将来用别的鉴权形态登录成功,这条要**重测**。
- ~~M5 的 skill 是否真被 Codex 加载~~ → **是**。实测让 Codex 列出可用 skill,
  `llms-bridge` 在列表里(与 `nature-academic-search`、`powershell-first` 等并列)。

### 8.2 仍未验证

1. WorkBuddy 的本地 HTTP 口到底服务什么(根路径 404,API 路径未探明)。**注意端口会变** ——
   2026-09-19 实测已从 `18488/52347/61924/61932/63603` 变为 `18488/54319/54320`
   (Qoder 那边同样从 57913 挪走了)。这正是"禁止硬编码端口"那条约束的活证据。
2. OpenCode 修复后(`npm i -g opencode-windows-x64`)是否支持 ACP。
3. ~~Qoder 用户级导入是否真的把桥带进会话~~ → **已结项(2026-09-20 11:09),双重证据。**
   - **配置侧**:`~/.qoder-cn/settings.json` 的 `mcpServers.llms-bridge` 已落盘,字段只有
     `command`/`args`、**无 env**;且 `enabledPlugins` 仍在 —— 说明 Qoder 是**合并**写入而非整体覆盖,
     此前担心的"导入冲掉插件配置"没有发生。
   - **宿主侧**:扩展管理 →「连接器 1」显示 **llms-bridge ● 可用 · STDIO · 无需认证**,
     五个工具(`harness_list`/`dispatch`/`poll`/`result`/`events`)全部被发现并渲染出说明。
   - **调用侧**:从 Qoder 会话内真调 `harness_list` 拿回六家实时探测。这同时验证了三件事:
     stdio 形态被接受(与 §8.2b 从 bundle 读到的推断一致)、桥能过 Qoder 的 pre-initialize era 探测
     (此前只在离线复现里验过)、以及 **`localAppData()` 那个修复在真实 GUI 子进程里生效**
     —— codex 与 codebuddy 从"误报不可用"恢复为 AVAILABLE,比模拟环境更有说服力。
   - **踩过的弯路记此**:「预览导入」(`previewImport`)只弹预览、**不写盘**;真正写入的是其后的
     「添加 MCP」(`addAction`,同名时 `replaceAction`「替换并启动 MCP」)。
4. ~~三家投票评审~~ 与 **端到端闭环**:
   - **闭环已在真实 GUI 宿主里跑通(2026-09-20 11:11)** —— 从 Qoder 会话内调
     `harness_dispatch`(codebuddy / read-only / `max_wall_ms=480000`)→ 对方**真的读了**
     `src/locate.ts` → `harness_result` 返回 `status: ok`、9 个事件、20 秒、`isolated: false`。
     评审内容也站得住(它额外指出兜底里 `existsSync` 的作用,即"变量存在但路径不存在也回退")。
     **这是项目最初那个目标第一次被完整演示:你正在用的这个会话,把子任务派给了另一家的模型。**
   - 三家投票(codex 生产 → codebuddy + claude 并发评审)第一次跑出**分歧**
     (codebuddy LGTM / claude 不 LGTM,`一致=false`),第二次因**并发把单路耗时拉过 240s 墙钟**而失败;
     预算已按实测提到 480s。**分歧理由仍未读到** —— 这是 §8.2 当前唯一还缺的核心证据。
     注意别把"两家一致"当结论:谁对要读原文,不是数票。
5. **Antigravity 若要成为 worker,前置是隔离而不是鉴权**:需用户在 `Settings → Projects → Add Folder`
   建一个专用空目录,并先查清"agent 不执行"那个真问题。**不得导出其 token/cookie(铁律 1 无例外)。**
6. **stdio 形态是否被 GUI 宿主接受 —— Qoder 已证实接受;WorkBuddy 仍未证实(我此前推错了一次)。**

   **更正记录**:本节 2026-09-19 版曾写"两家都接受 stdio,桥不需要 HTTP 传输层"。
   **WorkBuddy 那半句是错的**,来源是我读到了 `loadPluginMcpServers` 里的
   `if (!cfg.type) cfg.type = typeof cfg.command === "string" ? "stdio" : …`
   —— 那是**插件配置**的归一化路径,**不是** `~/.workbuddy/mcp.json` 的用户加载路径。
   我把插件侧行为推广到了用户侧。2026-09-21 实测否证:手改 mcp.json 加 stdio 条目后,
   WorkBuddy 启动时**不回写、不建审批、UI 无提示**(详见上方宿主矩阵行)。**条目已还原。**
   所以 WorkBuddy 的连接器有它自己的注册流程(`CUSTOM_MCP_PREFIX` / `readCustomMcpConfigForConnect`,
   写入走 `writeCustomMcpConfig()`),**手填文件不是入口**。
   它到底能不能挂 stdio server,**仍未验证** —— 只能走它的 UI 试;若它的 UI 只收 URL,
   那"桥需要一个 HTTP(streamable)传输层"这个结论就要**重新启用**,不能拿现在这半条证据当已解决。

   - **Qoder**:`transportKind === "stdio"` + `readStdioServerParams()`,要求 `params.command` 是 string;
     stdio 走 `kind:"legacy"`。它会在正式 `initialize` 前用**短命兄弟进程**发探测请求
     ("stdio era negotiation on a DISPOSABLE SIBLING"),桥已实测能应答且不退出(见 §5.4 的兼容用例)。
   - **WorkBuddy —— 以下三条是读到的事实,但都**不能**推出"手改 mcp.json 就能挂上":**
     1. `loadPluginMcpServers` 里确有 `if (!cfg.type) cfg.type = cfg.command ? "stdio" : cfg.url ? "http"`。
        **注意函数名 —— 这是插件配置的归一化路径,不是用户 `mcp.json` 的加载路径。**
     2. 审批面 `~/.workbuddy/mcp-approvals.json` 键形如 `<哈希>::<server 名>` → 毫秒时间戳;
        哈希算的是**该 server 自己的配置对象**(`calculateConfigHash(nextConfig)`),不是整个文件,
        所以改别的 server 不会让它重批,改这个 server 的 command/args 才会。
     3. `customMcpConfigPath = join(configDir,"mcp.json")`,而 `openMcpConfig()` 就是
        `openPath(该文件)` —— 它**确实**给你打开这个文件看/改,但连接器实体另有注册流程
        (`CUSTOM_MCP_PREFIX` / `readCustomMcpConfigForConnect`,写入走 `writeCustomMcpConfig()`)。

     **实测否证(2026-09-21)**:按 ③ 推断"手改是正门",于是往 `mcp.json` 合并了
     `llms-bridge`(`command`+`args`,不写 `type`)。WorkBuddy 启动后:**不回写该文件**(mtime 未变)、
     **不生成审批条目**、**UI 无任何提示**。条目**已还原**,与备份逐字节一致。
     所以第 3 条那句"openPath 就是让你改"我读得太浅 —— 它打开的是**查看/由程序维护**的文件。

   **结论修正**:此前本节写"两家都接受 stdio,桥不需要 HTTP 传输层" —— **WorkBuddy 那半句作废**。
   它能否挂 stdio server **仍未验证**,只能走它自己的连接器 UI;若那 UI 只收 URL,
   "桥需要 HTTP(streamable)传输层"这个结论要**重新启用**,不能拿现在这半条证据当已解决。

### 8.2b 已结掉(2026-09-19,不要再当未知项)

- ~~桥挂进 Qoder 后 `harness_list` 报 codex / codebuddy 不可用,是宿主或 CLI 的问题吗~~ →
  **不是,是桥自己的环境依赖 bug,已修复并验证(2026-09-20)。**
  根因:`resolveCodex()` 与 codebuddy 的 `bundledCliPath()` 都**只读 `process.env.LOCALAPPDATA`**,
  而 **GUI 宿主拉起的子进程不保证继承它**(实测:同一进程里 `LOCALAPPDATA` 未设置时,
  `USERPROFILE` 与 `os.homedir()` 仍然正确)。后果是分叉成两种症状 ——
  codex 整段跳过目录搜索、掉到 `which('codex')`(不在 PATH)→ 报"找不到";
  codebuddy 则返回 null 并**退回 PATH 上那份无扩展名的 npm shim** → `spawn EINVAL`。
  两个 harness 同时"变不可用",而 `harness_list` 是主脑唯一的依据 —— **这张表报错比没有表更糟**。
  修法:新增 `locate.ts` 的 `localAppData()`(env 优先,缺失则按 `join(homedir(),'AppData','Local')` 推),
  两处统一走它。**验证方式**:在**同时删掉 `LOCALAPPDATA` 与 `USERPROFILE`** 的子进程里跑 `detect()`,
  修复后 codex(`0.155.0-alpha.9.2`)与 codebuddy(`2.137.1`,WorkBuddy bundled)均 AVAILABLE。
  教训:**定位二进制不得依赖厂商特定环境变量,须能从 `os.homedir()` 推。**
  另记一次自查失误:我先前用 `find … | head -3` 看该目录,把 `codex.exe` 截掉了,
  于是断言"codex.exe 不存在" —— 又一次违反"断言本机状态前穷举验证"。

- ~~事件流里为什么有两条一模一样的 `result`~~ → **系统性缺陷,已修(2026-09-20)。**
  这条**只有在真实宿主里才看得见**:从 Qoder 调 `harness_events`(增量拉取)时,
  seq 7 与 seq 8 是**文本完全相同**的两条终态 result。根因:三个适配器都会把协议里的
  result 行翻译成 `result` 事件,而 `scheduler.#execute` 收尾时**无条件再 push 一条** ——
  于是**每个任务**的终态都翻倍。危害不是难看:主脑按 `since_seq` 跟踪进度时要把答案读两遍
  (双份上下文),而且会怀疑"是不是结束了两次"。
  修法:收尾那条改为**仅在解析器没交出同文本 result 时才补**(层级③ 的 codex 不发 result 行,
  仍需补上,否则终态缺失)。
  回归:`test/isolation-stub.test.mjs` 两条用例钉住不变量 —— **无论适配器发不发 result,
  终态都必须恰好一条**(桩 worker 通过 stdout 哨兵行模拟两种形态,零额度)。
  **并已在真实宿主里复验(2026-09-20 17:00)**:从 Qoder 会话内派 codebuddy 只读任务,
  事件序列为 `status, status, message, result` —— **result 恰好一条**(修复前是同文本两条)。
  顺带确证桥进程已随 Qoder 重载换新:旧 task_id 调 `harness_events` 返回"未知 taskId",
  说明宿主里跑的是当前代码,而不是启动时的旧快照。
  **教训**:单测里"事件数"从没被断言过,所以这个翻倍活了很久;真实宿主的一次调用就把它照出来了。

- ~~桥的 stdout 会不会被非协议内容污染~~ → **不会,全量扫过**。Qoder 的失败文案里有
  `outputLimitExceeded`("MCP 进程输出超过安全上限…请检查进程是否持续输出非协议内容")与
  `initializationTimeout`("请检查命令是否会等待交互输入")两条,都是 stdio server 的常见死法。
  实测:`grep -rn "console\.log" src/` 的 **11 处命中全部在 `src/cli.ts`**(面向人的独立入口),
  `mcp-server.ts` / `scheduler.ts` / `adapters/*` / `proc.ts` / `worktree.ts` 零命中;
  MCP 路径上唯一的 `process.stdout.write` 就是 JSON-RPC 响应本身,日志一律走 stderr
  (离线握手实测已看到 `[llms-bridge] started` 出现在 stderr)。
  启动时那轮 `detectAll()` 也是 `void` 掉的后台任务,不阻塞 `initialize` 应答(实测约 250ms)。

- ~~Codex 是否读共享 `~/.agents/skills/`~~ → **不读,两次实验证实**。
  ① 往 `~/.agents/skills/zz-probe-skill/` 放一个只有 `SKILL.md` 的 skill → Codex 的可用列表里**没有**它;
  ② 约 40 分钟后重建同一探针并等 60 秒再问 → **仍然没有**,故"缓存会过期"这一假设不成立;
  ③ 把探针放进 `~/.claude/skills/` → 同样不可见(与二进制里 `.claude/skills` 0 命中一致)。
  **实践结论:要给 Codex 用就直接放 `~/.codex/skills/`** —— 已实测有效,`llms-bridge` 即为证。
- **未解异常(不下结论)**:`powershell-first` 同时存在于 `~/.agents/skills/`、`~/.zcode/skills/`、
  `~/.claude/skills/`,却出现在 Codex 的可用 skill 列表里,而上述三个目录 Codex 都不读。
  它也不在 `~/.codex/skills/`(那里是 `.system/` 内置项 + nature-*/ponytail/scientific-writing/llms-bridge),
  按名字在 `~/.codex/plugins` 里也搜不到。`~/.codex/.codex-global-state.json` 里的命中是
  UI/会话状态(窗口位置、工作区根、thread 记录),**不是 skill 登记表**。**来源不明。**
- ~~Comate CLI 是否有机器可读输出~~ → **有**。`comatecli run -q ... -d event-stream|task-json|delta-stream`
  是真正的无头命令,输出 JSONL 事件(含 `pending-approvals`)。但实测 assistant 以 `status: failed` 收尾
  → **能跑但产不出,当前不可用**。
- ~~Gemini 的"目录信任"闸门做法~~ → `~/.gemini/trustedFolders.json`,格式为
  「小写+正斜杠绝对路径 → `TRUST_FOLDER` / `TRUST_PARENT` / `DO_NOT_TRUST`」;
  `d:/llms_bridge` 不在其中,故 `gemini mcp list` 报 "disabled because this folder is untrusted"。
  解法:加一行,或在项目目录交互式跑一次 gemini 并接受信任提示(**安全边界配置,授权由用户决定**)。
- ~~MiMo 要配哪种模型才能产出文本~~ → 根因是**根本没配**:`~/.config/mimocode/mimocode.jsonc`
  只有一行 `$schema`,没有任何 provider/model。用 `-m provider/model` 或在配置里加 provider。

### 8.3 未实现(不要按文档当成已有)

1. **按能力标签自动选人**。`TaskSpec` **没有** `capabilities` 字段,调度器也不做能力匹配 ——
   `harness` 必须显式指定。原因:能力标签需要各 harness 的**可信**能力元数据,而我没有可验证的
   来源(凭空写"qwen 支持 1M 上下文"这类是编数字,AGENTS.md 禁止)。要做得先有实测依据。
   目前唯一可用的多样性手段是显式指定 `model`(见 §5.1),而**清单从哪来**已由
   `harness_models` 解决(2026-09-21):`Adapter.listModels?()` 只接受**各家自己声明**的清单,
   实测六家里只有 `codebuddy` 的 `--help` 会打印 `Currently supported: (…)`(19 项,含 `auto`),
   其余五家返回 `declared:false` + 空列表 + 原因。
   **契约**:面板/大脑**不得**为 `declared:false` 的 harness 填默认模型或借用别家名字 ——
   宁可显示"未知"。用户点名要一家未自报的模型时应拒绝并说明,而不是猜一个相近的。
   用例见 `test/adapters.test.mjs` 的 `models()` 两条(假适配器零额度 + codebuddy 锚点断言)。
2. **层级① 的三个 spec 选项未接**:`model`、`session`(resume/fork)、`output_schema`。
   ACP 侧都没实现,传了会被忽略 —— 但**不会静默丢弃**:连接成功后会各回一条 `error` 事件说明
   (见 `acp.ts` 的 `unsupportedOptionEvents()`)。需要模型级差异请用层级②③。
3. **层级① 的写档位:客户端侧文件面已实现并单测通过,但仍未对调用方声明。**
   根因已查明(2026-09-19,从 qwen 内嵌的 `@agentclientprotocol/sdk` 取真实形状):
   **ACP 把文件读写放在客户端这一侧** —— agent 反向调用 `fs/read_text_file` / `fs/write_text_file`
   (参数 `{path, content, _meta?}`,写成功回 `{}`)。桥此前对所有反向方法一律回 `-32601`,
   所以层级① 的 agent **物理上写不了任何文件** —— 这才是只能声明 `read-only` 的真正原因,
   不是"权限协商没写"。
   现已实现(`src/adapters/acp.ts`):
   - **能力声明**:此前 `initialize` 发的是 `clientCapabilities: {}`,而 SDK 里
     `zClientCapabilities.fs` 默认 `{readTextFile:false, writeTextFile:false}` —— 不声明 agent 就**根本不会来调
     fs/\*,处理器等于不存在**(这是"实现了但用不上"的活教材)。现在按档位声明
     `fs:{readTextFile:true, writeTextFile: approval!=='read-only'}`、`terminal:false`。
   - `fs/read_text_file` / `fs/write_text_file` 真处理,带 `confine()` 路径限制(逐级回退到最近已存在祖先
     再 `realpath`,挡 `..`、绝对路径、符号链接逃逸),按 `approval` 放行(read-only 拒写),
     并落 `tool_call` / `tool_result` / `error` 事件让主脑看得见。
   - `session/request_permission`:**只从对方给的 `options` 里按 `kind` 选**(qwen 的校验器会拒绝不在
     集合内的 `optionId`,所以绝不自己编);写档位选 `allow_once` 而**永不选 `allow_always`** —— 后者是把
     整个会话的写权限一次批掉,超出本次任务的 approval 与 worktree 隔离的承诺;read-only 选 `reject_*`;
     无可用选项回 `{outcome:{outcome:'cancelled'}}`。
     形状坑:`zRequestPermissionResponse.outcome` 是**嵌套判别联合**,平铺写会静默不合规。
   - `terminal/*` 一律拒绝:那等于让 agent 绕开写档位直接执行命令。
   用例:`test/acp-fs.test.mjs`,10 条,**不 spawn 任何进程、零额度**。
   **仍不翻 `ACP_WRITE_APPROVALS_WIRED` 的原因**:没有真 agent 端到端跑过。此时对外声明
   `workspace-write` 会让调用方以为拿到了写权限,而实际链路是否如预期仍未经受检验。
   **翻转的前置:一次已鉴权 ACP agent 的完整写任务实测**(即 §3.5 里 qwen 那条"用户登录"的动作)。
4. **层级④ 的 worker 通道**。Antigravity 的 `agentapi` 鉴权链已通但 agent 不执行(已停手);
   Qoder 内部运行时被安全护栏拦下(已停手);CDP 驱动未做。
5. **M0 的并行多厂商**:并行 worktree 隔离已实现,且已有三家可产出文本
   (codex / codebuddy / claude)。两路并发评审在 `test/cross-review.test.mjs` 的三家投票用例里
   已实测(`Promise.all` 派发,互不干扰)。**尚未做的**是"同一任务并行派给多家、再比对/合并产出"
   这一层编排 —— 目前只有"一家生产、多家评审"这一种拓扑。