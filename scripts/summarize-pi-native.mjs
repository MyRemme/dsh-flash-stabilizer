// Offline verification/reporting; never sends model requests or reads credentials.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const input = resolve(process.argv[2] ?? '');
const rel = relative(join(root, '.compat-cache/pi-native'), input);
if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Specify a native run within .compat-cache/pi-native');
const batch = JSON.parse(await readFile(join(input, 'results.json'), 'utf8'));
const cases = JSON.parse(await readFile(join(input, 'cases.json'), 'utf8'));
let manual = {};
try { manual = JSON.parse(await readFile(join(input, 'manual-review.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const sha = text => createHash('sha256').update(text).digest('hex');
const rows = [];
for (const r of batch.results) {
  const c = cases.find(c => c.id === r.case);
  const bytes = await readFile(join(input, `${r.name}.wire-request.json`), 'utf8');
  const wire = JSON.parse(bytes);
  const m = wire.messages;
  const text = typeof m?.[0]?.content === 'string' ? m[0].content
    : m?.[0]?.content?.length === 1 && m[0].content[0].type === 'text' ? m[0].content[0].text : undefined;
  const banned = ['system', 'systemPrompt', 'developer', 'instructions', 'prompt', 'input', 'tools', 'functions', 'tool_choice', 'function_call'];
  const independentlyVerified = r.isolationPassed && m?.length === 1 && m[0].role === 'user' && text === c.prompt
    && Object.keys(m[0]).every(k => ['role', 'content'].includes(k)) && !banned.some(k => wire[k] !== undefined)
    && r.audit.length === 2 && r.audit.every(a => a.promptSha256 === sha(c.prompt) && a.bodySha256 === sha(bytes));
  if (!independentlyVerified) throw Error(`Request audit failed: ${r.name}`);
  const usage = r.rawUsage;
  const rawResponse = JSON.parse(await readFile(join(input, `${r.name}.raw-response.json`), 'utf8'));
  const usageKnown = usage?.total_tokens > 0 || r.usage?.totalTokens > 0;
  rows.push({
    name: r.name, case: r.case, effort: r.effort, repeat: r.repeat, isolationPassed: independentlyVerified,
    inputChars: text.length, promptSha256: sha(text), bodySha256: sha(bytes),
    inputTokens: usageKnown ? usage?.prompt_tokens ?? ((r.usage?.input ?? 0) + (r.usage?.cacheRead ?? 0)) : null,
    outputTokens: usageKnown ? usage?.completion_tokens ?? r.usage?.output ?? null : null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? r.usage?.reasoning ?? null,
    usageKnown, stopReason: r.stopReason, rawFinishes: r.rawFinishes, truncated: r.truncated,
    rawResponseReadErrors: rawResponse.map(x=>x.readError).filter(Boolean),
    timedOut: r.timedOut, error: r.error, finalChars: r.finalChars, thinkingChars: r.thinkingChars,
    emptyFinal: r.emptyFinal, repeatedByDetector: r.repetition.confirmedByCurrentDetector,
    longestA5Run: r.repetition.longestA5Run, longestIdenticalRun: r.repetition.longestIdenticalRun,
    functionalValidation: r.validation, manualReview: manual[r.name] ?? null,
    requestedEffort: wire.reasoning_effort ?? null, requestedOutputCap: wire.max_completion_tokens ?? wire.max_tokens,
    requestedTemperature: wire.temperature ?? null, requestedTopP: wire.top_p ?? null,
    seconds: +(r.durationMs / 1000).toFixed(1),
  });
}
const count = fn => rows.filter(fn).length;
const summary = {
  startedAt: batch.startedAt, completedAt: batch.completedAt, piVersion: batch.piVersion, model: batch.model,
  entryPoint: batch.entryPoint, planned: batch.requestBudget, completed: rows.length,
  maxTokens: batch.maxTokens, timeoutMs: batch.timeoutMs, maxRetries: batch.maxRetries,
  auditPassed: count(r => r.isolationPassed), rawLength: count(r => r.rawFinishes.includes('length')),
  truncationReportedWithoutRawLength: count(r => r.truncated && !r.rawFinishes.includes('length')),
  rawCaptureReadErrors: count(r => r.rawResponseReadErrors.length > 0),
  emptyFinal: count(r => r.emptyFinal), detectorRepeated: count(r => r.repeatedByDetector),
  timeouts: count(r => r.timedOut), missingUsage: count(r => !r.usageKnown),
  knownInputTokens: rows.reduce((n,r) => n + (r.inputTokens ?? 0), 0),
  knownOutputTokens: rows.reduce((n,r) => n + (r.outputTokens ?? 0), 0),
  limitations: batch.limitations, cases: batch.cases, results: rows,
};
const output = join(root, 'evaluations', `${batch.startedAt.slice(0,10)}-pi-native`);
await mkdir(output, { recursive: true });
let diagnostic;
if (process.argv[3]) {
  const diagnosticInput = resolve(process.argv[3]);
  const diagnosticRel = relative(join(root, '.compat-cache/pi-native'), diagnosticInput);
  if (!diagnosticRel || diagnosticRel.startsWith('..') || isAbsolute(diagnosticRel)) throw Error('Diagnostic must be within native cache');
  const db = JSON.parse(await readFile(join(diagnosticInput, 'results.json'), 'utf8'));
  if (db.results.length !== 1) throw Error('Expected a single diagnostic request');
  const r = db.results[0], bytes = await readFile(join(diagnosticInput, `${r.name}.wire-request.json`), 'utf8');
  const wire = JSON.parse(bytes), hash = sha(bytes);
  const matches = rows.filter(x => x.case === r.case && x.effort === r.effort && x.bodySha256 === hash);
  if (!r.isolationPassed || !matches.length || db.maxTokens !== batch.maxTokens) throw Error('Diagnostic request differs from baseline');
  const raw = JSON.parse(await readFile(join(diagnosticInput, `${r.name}.raw-response.json`), 'utf8'));
  const records = raw.flatMap(x => (x.body ?? '').split(/\r?\n/).flatMap(line => {
    if (!line.startsWith('data:')) return [];
    try { return [JSON.parse(line.slice(5).trim())]; } catch { return []; }
  }));
  diagnostic = {
    baselineStartedAt: batch.startedAt, startedAt: db.startedAt, completedAt: db.completedAt,
    excludedFromMain20: true, case: r.case, effort: r.effort, maxTokens: db.maxTokens,
    isolationPassed: true, bodySha256: hash, promptSha256: r.audit[0].promptSha256,
    matchingBaselineNames: matches.map(r=>r.name), rawErrors: records.map(x=>x.error).filter(Boolean),
    rawFinishes: r.rawFinishes, rawUsage: r.rawUsage, piError: r.error,
    finalChars: r.finalChars, thinkingChars: r.thinkingChars,
    repeatedByDetector: r.repetition.confirmedByCurrentDetector,
    doneMarkerCaptured: raw.some(x=>(x.body ?? '').includes('data: [DONE]')),
    rawResponseReadErrors: raw.map(x=>x.readError).filter(Boolean),
    rawDirectory: relative(root, diagnosticInput).replaceAll('\\', '/'),
  };
  await writeFile(join(output, 'stream-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
} else {
  try {
    const prior = JSON.parse(await readFile(join(output, 'stream-diagnostic.json'), 'utf8'));
    if (prior.baselineStartedAt === batch.startedAt) {
      diagnostic = prior;
      if (typeof diagnostic.rawDirectory === 'string' && isAbsolute(diagnostic.rawDirectory)) diagnostic.rawDirectory = relative(root, diagnostic.rawDirectory).replaceAll('\\', '/');
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
if (diagnostic) summary.streamDiagnostic = diagnostic;
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
const groups = [...new Set(rows.map(r => r.case))].map(id => {
  const rs = rows.filter(r => r.case === id), passed = rs.filter(r => r.manualReview?.passed ?? r.functionalValidation.passed).length;
  return `| ${id} | ${rs.length} | ${passed} | ${rs.filter(r=>r.rawFinishes.includes('length')).length} | ${rs.filter(r=>r.emptyFinal).length} | ${rs.filter(r=>r.repeatedByDetector).length} |`;
});
const details = rows.map(r => `| ${r.name} | ${r.rawFinishes.join(', ') || r.stopReason || '未知'} | ${r.outputTokens ?? '缺失'} | ${r.finalChars} | ${r.thinkingChars} | ${r.manualReview?.passed ?? r.functionalValidation.passed ?? '待人工'} | ${r.functionalValidation.formatPassed ?? '—'} |`);
const failedReviews = rows.filter(r => r.manualReview?.passed === false).map(r => `- \`${r.name}\`：${r.manualReview.reason}`);
const report = `# Pi 原生模型测试记录（${batch.startedAt.slice(0,10)}）

本轮 ${rows.length} 个样本中，${summary.rawLength} 个原始结束原因为 length，${summary.emptyFinal} 个没有最终正文；当前周期检测器确认 ${summary.detectorRepeated} 个。请求无附加提示审计全部通过。这些结果只描述本轮表现，不能据此归因采样器，也不能证明插件能改善模型输出。

仅使用 Pi ${batch.piVersion} 的底层 ModelRuntime，复用用户已确认的官方 DeepSeek-V4.1-Flash 连接，模型标识为 \`${batch.model}\`。不经过 CLI 或 AgentSession。

## 实际请求审计

已完成 ${rows.length}/${batch.requestBudget} 个正式样本；独立读取实际 HTTP 请求文件核验 ${summary.auditPassed}/${rows.length} 个通过。每个请求都只有一条 user 消息，其文本与测试题逐字相同；没有 system/developer、AGENTS.md、CLAUDE.md、SYSTEM.md、skills、extensions、工具定义、历史或 @文件包装。插件不参与模型请求，重复检测仅在响应后离线执行。

每个样本均保留题目及请求 SHA256；对照 \`summary.json\` 可复核请求审计。审计边界为本地 Pi 发往既有连接的 HTTP 请求。

## 条件与结果

- 时间：${batch.startedAt} 至 ${batch.completedAt}（UTC）。
- high/max 各重复两次；每题独立请求，未将失败输出回灌。
- 每次输出上限 ${batch.maxTokens} token，包含推理；单次超时 ${batch.timeoutMs / 1000} 秒；客户端重试 ${batch.maxRetries} 次。
- 不覆盖 temperature/top_p；实际是否存在这两个字段逐项记入汇总。没有额外施加重复惩罚或纠正提示。
- 原始 finish_reason=length：${summary.rawLength}；SDK 报告截断但原始流未捕获 length：${summary.truncationReportedWithoutRawLength}；最终正文为空：${summary.emptyFinal}；当前周期检测器确认：${summary.detectorRepeated}；超时：${summary.timeouts}。
- ${summary.rawCaptureReadErrors} 个样本的原始响应副本读取中止；这类样本仅保留 Pi 已解析的输出/错误，不能独立补全缺失的 finish_reason 或 usage。汇总保留逐项 readError。
- 已报告输入 token 合计 ${summary.knownInputTokens}，输出 ${summary.knownOutputTokens}；${summary.missingUsage} 个样本 usage 缺失，不能将其按零用量或零费用计算。

| 测试题 | 次数 | 功能/人工通过 | 原始 length | 空正文 | 当前检测器确认 |
|---|---:|---:|---:|---:|---:|
${groups.join('\n')}

算法题检查 66 项（含不修改输入、接触区间不合并）；解析题检查 5 项，覆盖普通输入、无分隔符、单/三反引号及特殊标记作为数据。代码在单独的受限 Node VM 内执行，不提供 require/process，不执行模型生成的 shell。功能检查可能抽取 Markdown 围栏内函数，因此字面上的“只返回函数”格式另列。仅有 Markdown 围栏的差异不作为功能失败或采样退化证据。

校验串题故意包含长度不符的 SHA512 值；合理回答应明确指出问题，不应编造可用摘要。此项及上下文回答必须人工复核。带人工结论的样本在 \`summary.json\` 中附有依据。

| 样本 | 原始结束原因 | 输出 token | 正文字数 | 推理字数 | 功能/人工通过 | 纯函数格式 |
|---|---|---:|---:|---:|---|---|
${details.join('\n')}

## 异常样本复核

${failedReviews.length ? failedReviews.join('\n') : '尚无人工标注的失败样本；空缺不代表没有异常，需结合逐项记录判断。'}

上述校验串通过项只评价无效摘要处理是否合理，未实际执行 Docker 构建。长上下文的四次请求均为约 80,139 输入 token；与 GitHub 原案例相比，消息结构和工具反馈仍不同。

${diagnostic ? `## 补充一次原始流诊断（不计入上述20次）

修正原始响应保存逻辑，使流中止时仍保留已经收到的字节，再对 max 校验串题补做一次。实际请求体 SHA256 为 \`${diagnostic.bodySha256}\`，与主批次 \`${diagnostic.matchingBaselineNames.join('、')}\` 完全相同；没有改变提示、推理强度或输出额度。

此次仍无最终正文，收到约 ${diagnostic.thinkingChars} 字符推理。原始 HTTP SSE 明确返回 \`api_error\`，消息为“${diagnostic.rawErrors[0]?.message ?? diagnostic.piError}”，并捕获了 [DONE]。没有正常的 finish_reason 或 usage，不能补造精确输出用量。虽然 SDK 同时中止副本读取，本次已保存中止前的错误帧和结束标记。

这确认该错误已经存在于配置连接返回的响应中，无须 AgentSession、项目提示或插件干预即可出现；它仍不能确定模型解码、输出额度与服务端处理各自的作用，更不能单凭此判定采样器退化。原始诊断与哈希证据见 \`stream-diagnostic.json\`。
` : ''}

## GitHub 案例来源与适用范围

- [DeepSeek-V3 #1008](https://github.com/deepseek-ai/DeepSeek-V3/issues/1008)：公开的 A5 校验串重复问题，属于旧模型。本次使用改写后的任务提示，仅作为跨版本回归素材。
- [deepseek-recipe #24](https://github.com/deepseek-ai/deepseek-recipe/issues/24)：报告 V4.1-Flash 在 vLLM 的长工具会话中只推理不作答、周期重复；原请求约 74,657 输入 token，107 条消息、26 个工具。完整历史未公开。本次使用 280,285 字符合成审计文本，实际 token 以汇总为准，不是原始会话复播。
- [vLLM #62935](https://github.com/vllm-project/vllm/issues/62935)：自托管 V4.1-Flash-1017 在长 Agent 请求中的退化报告，包含特殊标记/推理结束边界线索。原失败请求未公开。本次解析题只是症状类比。
- [DSH discussion #11943](https://github.com/deepseek-ai/deepseek-harness/discussions/11943)：长会话中迁移完成后重复说将执行操作而未继续产出；完整会话及真实结束原因不齐全。本次仅用合成迁移已完成/UI 待完成的阅读任务类比。

上述报告不能直接证明官方 API 也有同样故障；本轮结果只针对实际调用的模型及本轮题目。合成上下文是一条用户消息，没有复现长期工具反馈和失败历史回灌。

## 旧批次排除及结论边界

此前 \`.compat-cache/pi-live\` 的 CLI 测试虽然禁用了项目上下文文件，但使用了额外的中性系统提示和 @文件包装。它们全部作为探索记录排除，未计入本报告的样本数、正确率或异常统计。

有限输出额度导致的截断、无最终正文、格式错误与周期重复分别记录；不能把它们一律称为采样退化。未触发当前重复检测器也不能证明不存在重复。小样本无法估计线上故障发生率；没有服务端 logits 或采样器观测，不能据此确定采样器根因。此基线未验证插件的恢复效果。

## 本地证据与复跑

原始证据目录：\`${relative(root, input).replaceAll('\\', '/')}\`（受 Git 忽略，不发布原始响应）。包括每次的 \`.wire-request.json\`、\`.payload.json\`、\`.raw-response.json\`、\`.message.json\`、\`.answer.txt\`、\`.events.jsonl\` 和总体 \`results.json\`。

使用已配置好的 Pi 连接：

\`\`\`powershell
node scripts/test-pi-native.mjs smoke
node scripts/test-pi-native.mjs baseline
node scripts/summarize-pi-native.mjs '<本轮原始证据目录>'
\`\`\`

baseline 默认发送 20 次收费模型请求；smoke 仅发送 1 次。用户配置不作修改，读取现有凭据仅用于请求鉴权，不将鉴权头写入证据。
`;
await writeFile(join(output, 'REPORT.zh-CN.md'), report);
console.log(JSON.stringify({ report: join(output, 'REPORT.zh-CN.md'), completed: rows.length, audit: summary.auditPassed, length: summary.rawLength, empty: summary.emptyFinal, detector: summary.detectorRepeated, missingUsage: summary.missingUsage }));
