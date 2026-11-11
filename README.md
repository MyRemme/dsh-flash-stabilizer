# DSH Flash Stabilizer 0.1.3

DeepSeek Harness 原生 Cordis 插件，监控 Flash 模型的重复推理、正文和重复工具结果，提供可选的有限软纠正。包内含构建产物，安装时不需要编译。

## 当前可用功能

- 流式检测确定性周期重复，包括“好。执行。好。”一类短句轮转；按会话、模型请求和内容块隔离，连续多次观测后确认。
- 同次请求确认重复后释放检测窗口、停止后续扫描，仍原样转发全部输出；重叠流分别绑定请求状态，旧流结束不会清除新流监控。
- 排除工具参数 JSON，跳过 Markdown 代码围栏，降低重复模板代码的敏感度。
- 对五分钟内相同工具、相同参数且结果不变的重复执行告警。结果变化会重置该指纹的计数。
- `observe` 默认只告警；`assist` 在确认重复后等待当前回合正常结束或耗尽输出，再通过宿主 `agent.followup()` 开启独立纠正回合，每个用户任务最多两次。错误、用户停止、新用户输入、禁用会话或卸载会取消待执行的纠正，不向当前步骤注入消息。
- 提供原生「Flash 防空转」侧栏、插件详情面板和重复告警提示，显示监控请求数、最近监控时间、检测记录及实际纠正动作。
- 面板复用 DSH 原生按钮、开关、图标及明暗主题；每个对话的输入框下方显示独立监控状态，点击可查看该对话的重复原因、轮次、步骤和实际动作。
- 提供暂停 / 继续、刷新、离线自检及去标识日志导出；另支持会话级开关和有界本地 JSONL 日志。

插件不改写流、历史、工具参数或采样设置，不自行执行、跳过或重放工具。`assist` 会增加后续模型回合和费用；当前回合需要自行结束，纠正提示才可能生效。独立回合避免宿主保留 `max-tokens` 状态而在执行一次工具后提前停止。

**本版未开放自动中断和自动恢复。** `mode: auto` 会明确警告并降级为 `observe`。真实提供方的取消后续接、用户停止竞态及跨重启恢复预算尚未完成验证。内存中的软纠正预算在新用户输入、会话状态被回收或插件重新加载后重置。

本版尚未实现 Git diff、文件哈希、编译/测试格式解析、语义循环判断或质量验收，不宣称达到计划书中的检出率、恢复率、节省 Token 或代码能力指标。当前工具告警仅代表“调用及结果重复”，不能证明任务没有进展。

## 版本覆盖

截至 **2026-11-11**，已审查官方 GitHub 的 37 个发布条目，范围为 `0.1.0-rc.7` 至 `0.2.2-rc.1`；具体条目和证据见 [兼容性矩阵](compatibility/MATRIX.md)。

- 35 个能取得 npm 宿主包的版本通过真实 Cordis / AgentLoop / Session / Tools 核心测试，使用确定性模型适配器。
- `0.1.2-alpha.1`、`0.1.3-alpha.1` 缺少对应 npm 宿主发布包，只有源码审查和协议回放覆盖，尚无运行验证。
- 新版使用 `agent/assistant-stream`，早期版本使用原样转发的 `llm/stream` 适配器。
- 未知版本按观察接口回退，但安装器可能因明确的 `engines.dsh` 版本白名单拒绝安装；需要补充验证后更新包。源码修改版、第三方分支及将来的版本不在承诺范围内。

核心测试不等于真实 DeepSeek API、桌面端安装或真实任务效果测试。插件自身要求 Node.js >=22.18.0，同时必须满足所用 DSH 版本自身的 Node.js 要求；当前全部测试在 Windows / Node.js 24.20.0 上运行。

## 查看是否生效

在侧栏打开 **Flash 防空转**，或进入 **插件 → dsh-flash-stabilizer → 配置**。新增前端模块后可能需要刷新 Harness 页面。

- 「监控在线」表示服务已连接并启用；「已监控请求」及「最近监控请求」在实际匹配的 Flash 请求开始消费时更新。
- 对话输入框下方的「Flash」状态分别显示待请求、监控中、最近请求未发现重复、模型不匹配、暂停或检测不完整。当前请求状态与历史告警分开；历史重复不会覆盖新请求的状态。
- 点击对话状态可查看周期长度、重复次数、推理或正文类型以及轮次与步骤。观察模式明确显示「仅告警，未拦截、未中断输出」；待纠正、纠正已提交及请求中断分别记录，不代表恢复或中断成功。
- 检测确认后显示界内告警和记录；纠正意图、已提交及预算耗尽分别标注。「已提交纠正」是累计提交数，不代表恢复成功。
- 「暂停监控」不会停止模型或工具，只撤销待执行纠正并停止监控；恢复从下一次请求开始。暂停状态在插件重载后重置。
- 「离线自检」只用内存样本检测，不调用模型、不修改会话、不计入真实告警。
- 「导出诊断日志」导出最近 100 条内存事件及累计统计，默认无需开启磁盘日志。插件重载会清空内存记录；磁盘日志开关及写入故障会在面板显示。

界面使用 Harness 原生插槽和已认证连接。35 版本核心宿主测试不等于所有版本的界面测试；旧版没有对应界面或连接服务时，后台监控可独立运行。

## 安装与卸载

先确认 `dsh` CLI 可用，并确定你实际使用的 profile 名称。下面以 `desktop` 为例；其他 profile 请替换两条命令中的 `desktop`。安装到哪个 profile，就只在该 profile 中生效。

```powershell
dsh plugin --profile desktop add ./artifacts/dsh-flash-stabilizer-0.1.3.tgz
dsh --profile desktop --dump-config
```

检查组合后的配置包含 `id: flash-stabilizer` / `name: dsh-flash-stabilizer`，再重新启动相应 profile 的 DSH。原包默认 `mode: observe`。

```powershell
dsh plugin --profile desktop remove dsh-flash-stabilizer
```

安装包保存在本地，源码保存在私有 GitHub 仓库，未发布到 npm 或 GitHub Releases。安装方式依据 [官方插件打包教程](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.zh.md)。

## 配置

在所用 profile 的 `cordis.patch.yml` 中覆盖插件行。例如启用软纠正和本地日志：

```yaml
- id: flash-stabilizer
  config:
    mode: assist
    models: [deepseek-flash, deepseek-v4-flash, deepseek-v4.1-flash, deepseek-v4-flash-vision-exp]
    maxRecoveries: 2
    logDir: 'D:/DSH-Logs/flash-stabilizer'
```

该 patch 替换此行的整个 config；未写字段由插件默认值补齐。更高优先级的 home patch 或 `--patch` 仍可覆盖它。修改后按宿主支持的方式重新加载配置或重启。

模型匹配使用 DSH 请求中的**模型标识**，不使用界面显示名称。可精确匹配整个标识，或匹配 `/`、`:` 分隔后的末段，例如默认覆盖 `fixture:deepseek-v4.1-flash` 和 `fixture/nested/deepseek-v4.1-flash`；其他别名应加进 `models`。`providers` 为空表示不限制提供方；不会观察压缩等带 `purpose` 的辅助请求。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关，设为 false 后不注册监听 |
| `mode` | `observe` | `observe` / `assist`；`auto` 在本版降级 |
| `models` | 上例四个别名 | 精确匹配完整标识或路由末段 |
| `providers` | `[]` | 可选的提供方标识限制 |
| `disabledSessions` | `[]` | 不启用监控的会话 ID |
| `windowChars` | `4096` | 每个内容块的检测窗口，最多 16384 字符 |
| `minChars` | `1536` | 开始检测所需字符数 |
| `checkEveryChars` | `256` | 独立检查之间至少新增的字符数，最小 64 |
| `minPeriod` / `maxPeriod` | `16` / `512` | 检测重复周期长度 |
| `minRepeats` | `6` | 周期重复次数，最小 4 |
| `confirmations` | `3` | 连续确认次数，最小 2 |
| `toolRepeatLimit` | `4` | 相同工具和结果告警阈值，最小 3 |
| `maxRecoveries` | `2` | `assist` 的追加上限，允许 0–2 |
| `maxSessions` | `128` | 内存中跟踪的会话上限，最多 1024 |
| `logDir` | 空字符串 | 默认不写日志；设置目录后开启 |
| `maxLogBytes` | `2097152` | 每个日志文件的上限；允许 4096–16777216 字节 |
| `hostVersion` | 空字符串 | 仅在元数据不可见时提供版本提示，不能解锁自动干预 |
| `language` | `zh` | 提示语言 `zh` / `en` |

窗口要求 `512 <= minChars <= windowChars`；重复周期要求 `8 <= minPeriod <= maxPeriod <= 1024`，且 `maxPeriod * minRepeats <= windowChars`。不符合约束的配置会拒绝加载。

需要暂停全部监控时覆盖 `config: { enabled: false }`。每个会话也可在可信的宿主插件中调用公开服务；这不是在普通聊天框输入的命令：

```typescript
ctx.flashStabilizer.status()
ctx.flashStabilizer.sessionStatus(sessionId)
ctx.flashStabilizer.setSessionEnabled(sessionId, false)
ctx.flashStabilizer.setSessionEnabled(sessionId, true)
```

`status()` 返回兼容性、实际模式、监控请求计数、会话数量、去标识最近记录和日志状态。`recovery` 事件计数包含暂存纠正意图、提交后续回合和预算耗尽等事件，不能作为恢复成功率。

## 日志与误告警

默认在面板保留最近 100 条去标识诊断事件，同时在宿主日志中给出高风险告警，不持久保存输出内容。启用 `logDir` 后最多保留 `events.jsonl`、`events.previous.jsonl` 两个文件；队列有上限，拥塞时丢弃诊断事件，I/O 错误会停写并保留宿主运行。

日志只含事件类型、时间、风险分数、字符数、周期、重复次数、内容类型、轮次、步骤、动作及截短的会话 ID 哈希，不含原始推理、正文、命令、参数、错误或凭据。哈希是去标识措施，不是加密或完全匿名化。内存计数及会话跟踪会在重载后清空；会话计数在状态回收后重新跟踪时也会重置。每个对话的详情从全局最近 100 条事件筛选，不保证永久保存全部历史。

风险分数是启发式评分，**不是循环概率**。有意重复文本、未加围栏的模板及必要的重复测试仍可能触发告警；此时保持 observe，或关闭该会话的监控。

## 开发与复现

```powershell
npm ci --ignore-scripts
npm run check
npm run test:versions
npm run matrix
npm run diagnose
npm pack --pack-destination artifacts --cache .npm-cache
node scripts/test-package.mjs artifacts/dsh-flash-stabilizer-0.1.3.tgz
```

`npm run check` 包含类型检查、构建及 144 项自动化测试，包含真实 React / DOM 中的面板与会话交互、会话数据隔离及 Cordis 作用域中的路由注册和卸载。`test:versions` 从 npm 为各版本创建隔离宿主（需要网络），将整套 DSH 依赖固定到所测发行版；缺少发布包的版本记为 unavailable。`test-package.mjs` 复用这些宿主，解压交付包并验证包内代码、实际宿主版本识别、两种流适配、独立纠正回合上限、耗尽输出后的工具结果续接、用户停止和卸载。

优化前构建可保存在仓库外或 `.compat-cache/`，用 `node scripts/benchmark-detection.mjs '<旧版 dist 目录>'` 对照 10,100 组输入及长流告警结果，并测量本地检测耗时。这是检测器基准，不是模型生成速度、Token 消耗或恢复质量测试。

上述自动化和兼容性测试使用确定性输出，不需要 API Key。源码在 `src/`，测试在 `tests/`，审查报告在 [FEASIBILITY_REVIEW.zh-CN.md](FEASIBILITY_REVIEW.zh-CN.md)，每版本接口来源及 SHA 在 `compatibility/releases.json`。

### 真实模型的原生基线

`scripts/test-pi-native.mjs` 通过本地 Pi 的底层 `ModelRuntime`，复用已配置的 DeepSeek Flash 连接。它不创建 AgentSession；实际 HTTP 请求必须只有一条与测试题逐字相同的 user 消息，不带系统提示、项目上下文、技能、扩展、工具、历史或 `@文件` 包装。发现额外输入立即停止；本插件不介入请求。

```powershell
node scripts/test-pi-native.mjs smoke
node scripts/test-pi-native.mjs baseline
node scripts/summarize-pi-native.mjs '<输出的原始证据目录>'
```

smoke 发送 1 次真实请求；baseline 默认发送 20 次，high/max 各重复两次，每次输出上限 16,384 token、180 秒超时、零重试。它们会产生模型费用，不属于 `npm test`。原始请求与响应放在受 Git 忽略的 `.compat-cache/pi-native/`；报告器离线复核请求及题目哈希，输出到 `evaluations/`。校验串与上下文回答另需人工复核，详情见 [原生测试报告](evaluations/2026-11-11-pi-native/REPORT.zh-CN.md)。

可用 `PI_NATIVE_CASES`、`PI_NATIVE_EFFORTS`、`PI_NATIVE_REPEATS`、`PI_NATIVE_MAX_TOKENS` 缩小批次；Windows 默认读取 `%APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent` 与 `%USERPROFILE%/.pi/agent`，可通过 `PI_NATIVE_PACKAGE_DIR`、`PI_NATIVE_CONFIG_DIR` 指定。脚本不修改用户配置，不写入鉴权头。

`scripts/test-pi-live.mjs` 是早期的 Agent 探索测试，含中性系统提示和文件输入包装，其结果不计入原生基线。这里的纯模型测试也不等于插件干预有效性测试。

针对“长上下文＋high推理，短句轮转但不调用工具”的条件，另有 `scripts/test-pi-loop-trigger.mjs`：直接通过 ModelRuntime 发送显式合成多轮历史及三个虚拟工具，无系统提示、AgentSession 或恢复干预。它对照短/长历史与high/max/low，默认10组、每组最多6次请求、每请求32,768输出token，会发生模型费用。`scripts/summarize-pi-trigger.mjs '<原始证据目录>'` 离线独立核验全部请求和工具结果，并检查推理周期；[触发条件补测报告](evaluations/2026-11-11-pi-trigger/REPORT.zh-CN.md) 与纯模型基线分开记录。单元回放中循环可检出，不代表模型实测已复现该循环。

## 后续验收

已从本机 DSH 日志找到 20 个去重的真实短句空转样本，保持原始 delta 边界回放后均触发检测；DSH 0.2.2-rc.1 隔离宿主也验证了取消原流和提交一次纠正续接。真实模型重新触发与恢复效果尚未完成，发布包仍不开放 auto。完整口径与数据边界见 [本地会话验证报告](evaluations/2026-11-11-dsh-local/REPORT.zh-CN.md)。

自动取消/恢复需要补齐真实提供方断流、会话持久化与重放、用户停止优先级、宿主重试组合、恢复预算持久化。代码进展模块需要单独实现文件/Git/测试证据适配。完成这些验证和真实任务对照评估后，再发布对应能力的版本。
