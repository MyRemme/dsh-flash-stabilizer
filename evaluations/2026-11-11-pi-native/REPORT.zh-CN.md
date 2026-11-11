# Pi 原生模型测试记录（2026-11-11）

本轮 20 个样本中，1 个原始结束原因为 length，3 个没有最终正文；当前周期检测器确认 0 个。请求无附加提示审计全部通过。这些结果只描述本轮表现，不能据此归因采样器，也不能证明插件能改善模型输出。

仅使用 Pi 1.5.0 的底层 ModelRuntime，复用用户已确认的官方 DeepSeek-V4.1-Flash 连接，模型标识为 `deepseek-flash`。不经过 CLI 或 AgentSession。

## 实际请求审计

已完成 20/20 个正式样本；独立读取实际 HTTP 请求文件核验 20/20 个通过。每个请求都只有一条 user 消息，其文本与测试题逐字相同；没有 system/developer、AGENTS.md、CLAUDE.md、SYSTEM.md、skills、extensions、工具定义、历史或 @文件包装。插件不参与模型请求，重复检测仅在响应后离线执行。

每个样本均保留题目及请求 SHA256；对照 `summary.json` 可复核请求审计。审计边界为本地 Pi 发往既有连接的 HTTP 请求。

## 条件与结果

- 时间：2026-11-11T04:13:46.046Z 至 2026-11-11T04:21:50.499Z（UTC）。
- high/max 各重复两次；每题独立请求，未将失败输出回灌。
- 每次输出上限 16384 token，包含推理；单次超时 180 秒；客户端重试 0 次。
- 不覆盖 temperature/top_p；实际是否存在这两个字段逐项记入汇总。没有额外施加重复惩罚或纠正提示。
- 原始 finish_reason=length：1；SDK 报告截断但原始流未捕获 length：3；最终正文为空：3；当前周期检测器确认：0；超时：0。
- 3 个样本的原始响应副本读取中止；这类样本仅保留 Pi 已解析的输出/错误，不能独立补全缺失的 finish_reason 或 usage。汇总保留逐项 readError。
- 已报告输入 token 合计 330666，输出 41633；3 个样本 usage 缺失，不能将其按零用量或零费用计算。

| 测试题 | 次数 | 功能/人工通过 | 原始 length | 空正文 | 当前检测器确认 |
|---|---:|---:|---:|---:|---:|
| algorithm | 4 | 4 | 0 | 0 | 0 |
| checksum-a5 | 4 | 1 | 1 | 2 | 0 |
| parser-markup | 4 | 2 | 0 | 1 | 0 |
| context-8k-chars | 4 | 4 | 0 | 0 | 0 |
| context-280k-chars | 4 | 4 | 0 | 0 | 0 |

算法题检查 66 项（含不修改输入、接触区间不合并）；解析题检查 5 项，覆盖普通输入、无分隔符、单/三反引号及特殊标记作为数据。代码在单独的受限 Node VM 内执行，不提供 require/process，不执行模型生成的 shell。功能检查可能抽取 Markdown 围栏内函数，因此字面上的“只返回函数”格式另列。仅有 Markdown 围栏的差异不作为功能失败或采样退化证据。

校验串题故意包含长度不符的 SHA512 值；合理回答应明确指出问题，不应编造可用摘要。此项及上下文回答必须人工复核。带人工结论的样本在 `summary.json` 中附有依据。

| 样本 | 原始结束原因 | 输出 token | 正文字数 | 推理字数 | 功能/人工通过 | 纯函数格式 |
|---|---|---:|---:|---:|---|---|
| 01-algorithm-high-1 | stop | 860 | 462 | 2614 | true | true |
| 02-checksum-a5-high-1 | length | 16384 | 3652 | 48041 | false | — |
| 03-parser-markup-high-1 | stop | 2465 | 820 | 9006 | true | false |
| 04-context-8k-chars-high-1 | stop | 368 | 86 | 1624 | true | — |
| 05-context-280k-chars-high-1 | stop | 293 | 80 | 1270 | true | — |
| 06-algorithm-high-2 | stop | 785 | 729 | 2189 | true | true |
| 07-checksum-a5-high-2 | stop | 7696 | 3230 | 21604 | true | — |
| 08-parser-markup-high-2 | stop | 5301 | 571 | 19954 | true | true |
| 09-context-8k-chars-high-2 | stop | 289 | 86 | 1227 | true | — |
| 10-context-280k-chars-high-2 | stop | 327 | 80 | 1417 | true | — |
| 11-algorithm-max-1 | stop | 1178 | 593 | 4138 | true | true |
| 12-checksum-a5-max-1 | error | 缺失 | 0 | 50495 | false | — |
| 13-parser-markup-max-1 | stop | 2038 | 97 | 8318 | false | false |
| 14-context-8k-chars-max-1 | stop | 629 | 142 | 2776 | true | — |
| 15-context-280k-chars-max-1 | stop | 257 | 86 | 1091 | true | — |
| 16-algorithm-max-2 | stop | 1868 | 524 | 6715 | true | true |
| 17-checksum-a5-max-2 | error | 缺失 | 0 | 49916 | false | — |
| 18-parser-markup-max-2 | error | 缺失 | 0 | 66254 | false | false |
| 19-context-8k-chars-max-2 | stop | 301 | 80 | 1328 | true | — |
| 20-context-280k-chars-max-2 | stop | 594 | 86 | 2690 | true | — |

## 异常样本复核

- `02-checksum-a5-high-1`：正文指出摘要无效，但错误声称为56字符（实际54）；Dockerfile在 COPY -- 处截断，原始finish_reason=length。不能当完整可用答案。
- `12-checksum-a5-max-1`：没有最终正文；Pi错误称全部额度花在推理并被长度限制截断。原始流副本读取被中止，缺少可独立核验的finish_reason和usage。
- `13-parser-markup-max-1`：最终正文只有97字符的推理片段，讨论think标签/聊天模板，没有splitThinking函数。原始SSE的content字段也包含相同片段，finish_reason=stop，并非评估器抽取代码失败造成。
- `17-checksum-a5-max-2`：没有最终正文；Pi错误称全部额度花在推理并被长度限制截断。原始流副本读取被中止，缺少可独立核验的finish_reason和usage。
- `18-parser-markup-max-2`：没有最终正文；Pi报告思考耗尽长度额度，且没有可独立核验的原始finish_reason或usage。

上述校验串通过项只评价无效摘要处理是否合理，未实际执行 Docker 构建。长上下文的四次请求均为约 80,139 输入 token；与 GitHub 原案例相比，消息结构和工具反馈仍不同。

## 补充一次原始流诊断（不计入上述20次）

修正原始响应保存逻辑，使流中止时仍保留已经收到的字节，再对 max 校验串题补做一次。实际请求体 SHA256 为 `ce0a3c5f0043e1ea172024510e972eabdde7a01811bfef83e8c56f046c4db7c0`，与主批次 `12-checksum-a5-max-1、17-checksum-a5-max-2` 完全相同；没有改变提示、推理强度或输出额度。

此次仍无最终正文，收到约 55622 字符推理。原始 HTTP SSE 明确返回 `api_error`，消息为“DeepSeek: an empty reply (the model answered nothing; try again) — cut at its length, the whole output spent on reasoning”，并捕获了 [DONE]。没有正常的 finish_reason 或 usage，不能补造精确输出用量。虽然 SDK 同时中止副本读取，本次已保存中止前的错误帧和结束标记。

这确认该错误已经存在于配置连接返回的响应中，无须 AgentSession、项目提示或插件干预即可出现；它仍不能确定模型解码、输出额度与服务端处理各自的作用，更不能单凭此判定采样器退化。原始诊断与哈希证据见 `stream-diagnostic.json`。


## GitHub 案例来源与适用范围

- [DeepSeek-V3 #1008](https://github.com/deepseek-ai/DeepSeek-V3/issues/1008)：公开的 A5 校验串重复问题，属于旧模型。本次使用改写后的任务提示，仅作为跨版本回归素材。
- [deepseek-recipe #24](https://github.com/deepseek-ai/deepseek-recipe/issues/24)：报告 V4.1-Flash 在 vLLM 的长工具会话中只推理不作答、周期重复；原请求约 74,657 输入 token，107 条消息、26 个工具。完整历史未公开。本次使用 280,285 字符合成审计文本，实际 token 以汇总为准，不是原始会话复播。
- [vLLM #62935](https://github.com/vllm-project/vllm/issues/62935)：自托管 V4.1-Flash-1017 在长 Agent 请求中的退化报告，包含特殊标记/推理结束边界线索。原失败请求未公开。本次解析题只是症状类比。
- [DSH discussion #11943](https://github.com/deepseek-ai/deepseek-harness/discussions/11943)：长会话中迁移完成后重复说将执行操作而未继续产出；完整会话及真实结束原因不齐全。本次仅用合成迁移已完成/UI 待完成的阅读任务类比。

上述报告不能直接证明官方 API 也有同样故障；本轮结果只针对实际调用的模型及本轮题目。合成上下文是一条用户消息，没有复现长期工具反馈和失败历史回灌。

## 旧批次排除及结论边界

此前 `.compat-cache/pi-live` 的 CLI 测试虽然禁用了项目上下文文件，但使用了额外的中性系统提示和 @文件包装。它们全部作为探索记录排除，未计入本报告的样本数、正确率或异常统计。

有限输出额度导致的截断、无最终正文、格式错误与周期重复分别记录；不能把它们一律称为采样退化。未触发当前重复检测器也不能证明不存在重复。小样本无法估计线上故障发生率；没有服务端 logits 或采样器观测，不能据此确定采样器根因。此基线未验证插件的恢复效果。

## 本地证据与复跑

原始证据目录：`.\.compat-cache\pi-native\2026-11-11T04-13-46-035Z-baseline`（受 Git 忽略，不发布原始响应）。包括每次的 `.wire-request.json`、`.payload.json`、`.raw-response.json`、`.message.json`、`.answer.txt`、`.events.jsonl` 和总体 `results.json`。

使用已配置好的 Pi 连接：

```powershell
node scripts/test-pi-native.mjs smoke
node scripts/test-pi-native.mjs baseline
node scripts/summarize-pi-native.mjs '<本轮原始证据目录>'
```

baseline 默认发送 20 次收费模型请求；smoke 仅发送 1 次。用户配置不作修改，读取现有凭据仅用于请求鉴权，不将鉴权头写入证据。
