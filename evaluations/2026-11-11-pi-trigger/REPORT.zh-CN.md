# 长上下文与高推理努力触发条件补测

本批完成 10/10 组、47 次实际模型请求。独立请求审计 47/47 通过；目标候选 0 组，其中推理重复且无工具/最终正文 0 组。完成代码修改并通过工具检查 9 组。此结果只描述本批合成任务，不能估计线上发生率。

## 测试针对的现象

用户指出的现象是：长上下文叠加 high reasoning effort 后，推理中短句机械轮转，同时不调用可用工具。空回复、长推理、长度截断或错误答案本身均不算命中。

使用本地 Pi 1.5.0 的 ModelRuntime，复用用户已确认的官方 Flash 连接。不创建 AgentSession，不读取 AGENTS.md/CLAUDE.md/SYSTEM.md，不加载技能、扩展或纠正提示。请求没有 system/developer 消息。工具仅有显式声明的三个虚拟文件接口：bench_read、bench_patch、bench_test；tool_choice 未强制指定某工具。

长组初始上下文为 105 条合成消息：27 user、52 assistant、26 tool，包含26次已成功的历史读取及结果；短组为17条合成消息。没有将循环短句、失败推理或“避免循环”等干预语句放入历史。历史是本地构造的已完成验证记录，不是 GitHub 原始失败会话。模型后续工具请求和反馈均为本次实际执行。

只给定工具结构是为了观察“工具可用而模型不调用”。这与上一份完全无工具的纯模型基线分开记录。

## 条件与结果

- 对照：短历史/high、长历史/high、更长历史/high、更长历史/max、更长历史/low，分别执行 UI 和解析器两个任务，每格1组。
- 任务：迁移完成后的只读UI选择；带反引号与特殊标记的解析器修复。均需读取、改写、运行虚拟检查并返回结果。
- high/max/low、原文消息、工具结构、实际请求 SHA256 均在适配器和HTTP边界核验，再由离线报告器重新读取请求和工具日志独立核验。
- 每请求上限 32768 输出token；最多 6 请求/组；请求超时 240 秒、单组上限 420 秒；零客户端重试。不改变温度/top_p、不加入重复惩罚、不加载插件或自动恢复。
- 0 次用量缺失；未知用量不按零费用计算。这里的“低熵”通过文本重复观察，未测量服务端logits分布的熵。
- 3 组触及6次请求预算；它们仍在调用工具，不能当作“只推理、不调用工具”的命中，也不能把预算停止当作模型自行停滞。
- 4 组收到检查器对 CommonJS/ESM 导出的限制反馈。这是纯函数VM检查器的环境限制，不视为模型能力退化证据；9组通过仅表示本地函数检查通过，不代表真实仓库构建质量。

| 任务 / 条件 | 首请求输入token | 请求数 | 实际工具调用 | 工具检查通过 | 推理重复且无工具 | 同时无正文 | 结束 |
|---|---:|---:|---:|---|---|---|---|
| ui / long-high | 89386 | 4 | 4 | true | false | false | final-without-tools |
| parser / long-high | 89379 | 6 | 6 | false | false | false | request-budget |
| ui / longer-high | 124024 | 4 | 4 | true | false | false | final-without-tools |
| parser / longer-high | 124017 | 6 | 6 | true | false | false | request-budget |
| ui / longer-max | 124024 | 4 | 4 | true | false | false | final-without-tools |
| parser / longer-max | 124017 | 4 | 5 | true | false | false | final-without-tools |
| ui / longer-low | 124024 | 4 | 4 | true | false | false | final-without-tools |
| parser / longer-low | 124017 | 6 | 6 | true | false | false | request-budget |
| ui / short-high | 3418 | 4 | 4 | true | false | false | final-without-tools |
| parser / short-high | 3411 | 5 | 4 | true | false | false | final-without-tools |

## 重复检查与插件修复

修复了两个真实检测盲点：原检测器跳过少于6种不同字符的重复单元，导致短中文轮转可能漏报；四字符片段每隔一个位置采样，可能在奇数大小流式分块下把同一英文周期判断为新内容。现在至少要求两个不同字母（包括汉字），并使用所有相邻四字符片段；标点、单字和纯数字重复不确认。代码围栏、工具参数和独立内容块仍分别处理。

新增用户给出的中英文轮转回归，覆盖1/7/73/4096字符分块及非语义重复负例；完整类型检查、构建和84项自动化测试通过。单元回放只证明检测能力，不当作模型实测复现。

更新后的0.1.0安装包已重打包；真实DSH宿主核心的安装包验证 35 个通过、2 个缺少宿主包、0 个失败。宿主验证使用确定性提供方，模型实测单列于上文。包SHA256：`034f0ca27974b579a275b25a2a832c6903d012925f60858ed8c64308acca8e5e`。

另外离线检查规范化词/汉字周期，消除大小写、标点和空白差异；128个文本单元窗口内至少8轮、覆盖率85%以上才记候选。其检测例子从未发给模型。候选还需结合完整推理与实际工具调用人工复核。检测器无命中不能排除更松散的语义循环。

## 与已有证据的关系

[前一份纯模型基线](../2026-11-11-pi-native/REPORT.zh-CN.md) 的空回复/截断并不等于本次目标症状。此前的长文本阅读题，也不能替代有工具可用的多轮轨迹。本轮仍无法复播未公开的原始长期会话。

参考：[deepseek-recipe #24](https://github.com/deepseek-ai/deepseek-recipe/issues/24)、[vLLM #62935](https://github.com/vllm-project/vllm/issues/62935)、[DSH discussion #11943](https://github.com/deepseek-ai/deepseek-harness/discussions/11943)。这些案例没有提供完整公开失败历史，因此本轮是条件类比，不是原请求复现，也不是采样器根因验证。

原始证据目录：`.compat-cache/pi-trigger/2026-11-11T04-34-50-983Z`（受Git忽略）。每组保存初始显式上下文、后续实际HTTP请求、原始响应、模型消息、增量与工具结果；本报告 `summary.json` 包含逐请求核验、检测证据和哈希。

复跑（会发生模型费用）：

```powershell
node scripts/test-pi-loop-trigger.mjs
node scripts/summarize-pi-trigger.mjs '<输出的证据目录>'
```

可用 PI_TRIGGER_TASKS、PI_TRIGGER_PROFILES、PI_TRIGGER_REPEATS 缩小批次；smoke 参数仅做短轨迹验证。模型的原始输出不被检测器修改，观察结果不回灌给模型。
