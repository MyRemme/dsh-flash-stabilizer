// Independent, offline request verification and reasoning-cycle audit.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)), directory=resolve(process.argv[2]??'');
const rel=relative(join(root,'.compat-cache/pi-trigger'),directory);
if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Specify a pi-trigger run directory');
const batch=JSON.parse(await readFile(join(directory,'results.json'),'utf8'));
const sha=text=>createHash('sha256').update(text).digest('hex');
const readText=c=>typeof c==='string'?c:(c??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');

function lexicalCycle(text){
  // These are normalized text units, not provider tokenizer IDs or logits.
  const tokens=(text.toLowerCase().match(/[\u3400-\u9fff]|[a-z]+|\d+/g)??[]);
  let best={confirmed:false,coverage:0,periodTokens:0,repeats:0,windowEnd:0,unit:[]};
  for(let end=128;end<=tokens.length;end+=32){
    const start=end-128;
    for(let p=1;p<=16;p++){
      const unit=tokens.slice(end-p,end);
      if(new Set(unit).size<2)continue;
      let repeats=1;
      while(end-(repeats+1)*p>=start&&unit.every((t,i)=>t===tokens[end-(repeats+1)*p+i]))repeats++;
      const coverage=repeats*p/128;
      if(repeats>=8&&coverage>best.coverage)best={confirmed:coverage>=0.85,coverage,periodTokens:p,repeats,windowEnd:end,unit};
    }
  }
  return {...best,tokens:tokens.length};
}
// Validate the diagnostic on punctuation variants and changing prose without
// sending these examples to a model. Production detection has separate tests.
assert(lexicalCycle('好。执行。好。'.repeat(100)).confirmed);
assert(lexicalCycle('Write. Output! Let me write; '.repeat(100)).confirmed);
assert(!lexicalCycle(Array.from({length:200},(_,i)=>`Evidence ${i} excludes case ${i*i}; next inspect module ${i+1}.`).join(' ')).confirmed);

const rows=[];
for(const trial of batch.results){
  const dir=join(directory,trial.name), initial=JSON.parse(await readFile(join(dir,'initial-context.json'),'utf8'));
  const events=JSON.parse(await readFile(join(dir,'tool-events.json'),'utf8')), expected=[...initial.messages],attempts=[];
  for(const a of trial.attempts){
    const id=String(a.step).padStart(2,'0'),bytes=await readFile(join(dir,`${id}.request.json`),'utf8'),body=JSON.parse(bytes);
    assert.equal(body.messages.length,expected.length,'message count');
    assert(a.isolationPassed&&a.audits.length===2&&a.audits.every(x=>x.bodySha256===sha(bytes)),'runtime audit');
    assert.equal(body.reasoning_effort,trial.effort,'effort');
    assert.equal(body.max_completion_tokens??body.max_tokens,batch.outputCapPerRequest,'output cap');
    for(let i=0;i<expected.length;i++){
      const e=expected[i],m=body.messages[i];assert.equal(m.role,e.role==='toolResult'?'tool':e.role,'role');
      assert(!['system','developer'].includes(m.role),'no added instruction');
      assert.equal(readText(m.content),readText(e.content),'verbatim text');
      if(e.role==='toolResult')assert.equal(m.tool_call_id,e.toolCallId,'tool linkage');
      if(e.role==='assistant'){
        const calls=e.content.filter(b=>b.type==='toolCall');assert.equal(m.tool_calls?.length??0,calls.length,'tool call count');
        calls.forEach((c,n)=>{assert.equal(m.tool_calls[n].function.name,c.name);assert.deepEqual(JSON.parse(m.tool_calls[n].function.arguments),c.arguments);});
      }
    }
    assert.equal(body.tools.length,initial.tools.length,'tool schema count');
    initial.tools.forEach((t,i)=>{assert.equal(body.tools[i].function.name,t.name);assert.equal(body.tools[i].function.description,t.description);assert.deepEqual(body.tools[i].function.parameters,t.parameters);});
    for(const k of ['system','systemPrompt','developer','instructions','prompt','input','functions'])assert.equal(body[k],undefined,k);
    assert(body.tool_choice===undefined||body.tool_choice==='auto','tools optional');
    const message=JSON.parse(await readFile(join(dir,`${id}.message.json`),'utf8'));
    const thinking=(message?.content??[]).filter(b=>b.type==='thinking').map(b=>b.thinking).join('\n'),lexical=lexicalCycle(thinking);
    const raw=JSON.parse(await readFile(join(dir,`${id}.raw.json`),'utf8'));
    const wireReasoning=raw.flatMap(x=>(x.body??'').split(/\r?\n/).flatMap(line=>{try{const data=JSON.parse(line.replace(/^data:\s*/,''));return(data.choices??[]).map(c=>c.delta?.reasoning_content??'');}catch{return[];}})).join('');
    const wireLexical=lexicalCycle(wireReasoning);
    const candidate=(a.reasoningCycleConfirmed||lexical.confirmed||wireLexical.confirmed)&&a.toolCalls===0;
    attempts.push({...a,wireSha256:sha(bytes),independentAuditPassed:true,lexicalCycle:lexical,wireLexicalCycle:wireLexical,
      targetCandidate:candidate,strictNoAction:candidate&&a.finalChars===0,rawReadErrors:raw.map(x=>x.readError).filter(Boolean)});
    if(message?.content?.some(c=>c.type==='toolCall')){
      expected.push(message);
      for(const c of message.content.filter(c=>c.type==='toolCall')){
        const event=events.find(e=>e.step===a.step&&e.name===c.name&&JSON.stringify(e.arguments)===JSON.stringify(c.arguments));assert(event,'tool result recorded');
        expected.push({role:'toolResult',toolCallId:c.id,content:[{type:'text',text:JSON.stringify(event.result)}]});
      }
    }
  }
  rows.push({...trial,attempts,targetCandidate:attempts.some(a=>a.targetCandidate),strictNoAction:attempts.some(a=>a.strictNoAction),
    fixtureModuleFeedback:events.filter(e=>e.name==='bench_test'&&/module is not defined|Unexpected token 'export'/.test(e.result.reason??'')).map(e=>({step:e.step,reason:e.result.reason}))});
}
const attempts=rows.flatMap(r=>r.attempts);
const summary={startedAt:batch.startedAt,completedAt:batch.completedAt,piVersion:batch.piVersion,model:batch.model,planned:batch.planned,completed:rows.length,
  requests:attempts.length,independentAuditPassed:attempts.filter(a=>a.independentAuditPassed).length,
  targetCandidates:rows.filter(r=>r.targetCandidate).length,strictNoAction:rows.filter(r=>r.strictNoAction).length,
  requestBudgetLimited:rows.filter(r=>r.trialStop==='request-budget').length,
  trialsWithModuleFeedback:rows.filter(r=>r.fixtureModuleFeedback.length).length,
  passed:rows.filter(r=>r.passed).length,missingUsage:attempts.filter(a=>!a.rawUsage&& !a.usage).length,
  manifest:batch,results:rows};
const output=join(root,'evaluations',`${batch.startedAt.slice(0,10)}-pi-trigger`);await mkdir(output,{recursive:true});
const packagePath=join(root,'artifacts/dsh-flash-stabilizer-0.1.0.tgz');
const hosts=JSON.parse(await readFile(join(root,'compatibility/host-results.json'),'utf8'));
const packageValidation={path:relative(root,packagePath).replaceAll('\\','/'),sha256:createHash('sha256').update(await readFile(packagePath)).digest('hex'),
  hostTestedAt:hosts.testedAt,passed:hosts.results.filter(x=>x.status==='passed').length,
  unavailable:hosts.results.filter(x=>x.status==='unavailable').length,failed:hosts.results.filter(x=>x.status==='failed').length,
  hostProvider:'Deterministic mock provider in real DSH cores, separate from the Pi model test'};
summary.packageValidation=packageValidation;
await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2));
const table=rows.map(r=>`| ${r.task} / ${r.profile} | ${r.attempts[0]?.rawUsage?.prompt_tokens??r.attempts[0]?.usage?.input??'缺失'} | ${r.attempts.length} | ${r.toolCalls} | ${r.passed} | ${r.targetCandidate} | ${r.strictNoAction} | ${r.trialStop} |`).join('\n');
const report=`# 长上下文与高推理努力触发条件补测

本批完成 ${rows.length}/${batch.planned} 组、${attempts.length} 次实际模型请求。独立请求审计 ${summary.independentAuditPassed}/${attempts.length} 通过；目标候选 ${summary.targetCandidates} 组，其中推理重复且无工具/最终正文 ${summary.strictNoAction} 组。完成代码修改并通过工具检查 ${summary.passed} 组。此结果只描述本批合成任务，不能估计线上发生率。

## 测试针对的现象

用户指出的现象是：长上下文叠加 high reasoning effort 后，推理中短句机械轮转，同时不调用可用工具。空回复、长推理、长度截断或错误答案本身均不算命中。

使用本地 Pi ${batch.piVersion} 的 ModelRuntime，复用用户已确认的官方 Flash 连接。不创建 AgentSession，不读取 AGENTS.md/CLAUDE.md/SYSTEM.md，不加载技能、扩展或纠正提示。请求没有 system/developer 消息。工具仅有显式声明的三个虚拟文件接口：bench_read、bench_patch、bench_test；tool_choice 未强制指定某工具。

长组初始上下文为 105 条合成消息：27 user、52 assistant、26 tool，包含26次已成功的历史读取及结果；短组为17条合成消息。没有将循环短句、失败推理或“避免循环”等干预语句放入历史。历史是本地构造的已完成验证记录，不是 GitHub 原始失败会话。模型后续工具请求和反馈均为本次实际执行。

只给定工具结构是为了观察“工具可用而模型不调用”。这与上一份完全无工具的纯模型基线分开记录。

## 条件与结果

- 对照：短历史/high、长历史/high、更长历史/high、更长历史/max、更长历史/low，分别执行 UI 和解析器两个任务，每格1组。
- 任务：迁移完成后的只读UI选择；带反引号与特殊标记的解析器修复。均需读取、改写、运行虚拟检查并返回结果。
- high/max/low、原文消息、工具结构、实际请求 SHA256 均在适配器和HTTP边界核验，再由离线报告器重新读取请求和工具日志独立核验。
- 每请求上限 ${batch.outputCapPerRequest} 输出token；最多 ${batch.requestLimitPerTrial} 请求/组；请求超时 ${batch.timeoutMs/1000} 秒、单组上限 ${batch.trialTimeoutMs/1000} 秒；零客户端重试。不改变温度/top_p、不加入重复惩罚、不加载插件或自动恢复。
- ${summary.missingUsage} 次用量缺失；未知用量不按零费用计算。这里的“低熵”通过文本重复观察，未测量服务端logits分布的熵。
- ${summary.requestBudgetLimited} 组触及6次请求预算；它们仍在调用工具，不能当作“只推理、不调用工具”的命中，也不能把预算停止当作模型自行停滞。
- ${summary.trialsWithModuleFeedback} 组收到检查器对 CommonJS/ESM 导出的限制反馈。这是纯函数VM检查器的环境限制，不视为模型能力退化证据；9组通过仅表示本地函数检查通过，不代表真实仓库构建质量。

| 任务 / 条件 | 首请求输入token | 请求数 | 实际工具调用 | 工具检查通过 | 推理重复且无工具 | 同时无正文 | 结束 |
|---|---:|---:|---:|---|---|---|---|
${table}

## 重复检查与插件修复

修复了两个真实检测盲点：原检测器跳过少于6种不同字符的重复单元，导致短中文轮转可能漏报；四字符片段每隔一个位置采样，可能在奇数大小流式分块下把同一英文周期判断为新内容。现在至少要求两个不同字母（包括汉字），并使用所有相邻四字符片段；标点、单字和纯数字重复不确认。代码围栏、工具参数和独立内容块仍分别处理。

新增用户给出的中英文轮转回归，覆盖1/7/73/4096字符分块及非语义重复负例；完整类型检查、构建和84项自动化测试通过。单元回放只证明检测能力，不当作模型实测复现。

更新后的0.1.0安装包已重打包；真实DSH宿主核心的安装包验证 ${packageValidation.passed} 个通过、${packageValidation.unavailable} 个缺少宿主包、${packageValidation.failed} 个失败。宿主验证使用确定性提供方，模型实测单列于上文。包SHA256：\`${packageValidation.sha256}\`。

另外离线检查规范化词/汉字周期，消除大小写、标点和空白差异；128个文本单元窗口内至少8轮、覆盖率85%以上才记候选。其检测例子从未发给模型。候选还需结合完整推理与实际工具调用人工复核。检测器无命中不能排除更松散的语义循环。

## 与已有证据的关系

[前一份纯模型基线](../2026-11-11-pi-native/REPORT.zh-CN.md) 的空回复/截断并不等于本次目标症状。此前的长文本阅读题，也不能替代有工具可用的多轮轨迹。本轮仍无法复播未公开的原始长期会话。

参考：[deepseek-recipe #24](https://github.com/deepseek-ai/deepseek-recipe/issues/24)、[vLLM #62935](https://github.com/vllm-project/vllm/issues/62935)、[DSH discussion #11943](https://github.com/deepseek-ai/deepseek-harness/discussions/11943)。这些案例没有提供完整公开失败历史，因此本轮是条件类比，不是原请求复现，也不是采样器根因验证。

原始证据目录：\`${relative(root,directory).replaceAll('\\','/')}\`（受Git忽略）。每组保存初始显式上下文、后续实际HTTP请求、原始响应、模型消息、增量与工具结果；本报告 \`summary.json\` 包含逐请求核验、检测证据和哈希。

复跑（会发生模型费用）：

\`\`\`powershell
node scripts/test-pi-loop-trigger.mjs
node scripts/summarize-pi-trigger.mjs '<输出的证据目录>'
\`\`\`

可用 PI_TRIGGER_TASKS、PI_TRIGGER_PROFILES、PI_TRIGGER_REPEATS 缩小批次；smoke 参数仅做短轨迹验证。模型的原始输出不被检测器修改，观察结果不回灌给模型。
`;
await writeFile(join(output,'REPORT.zh-CN.md'),report);
console.log(JSON.stringify({report:join(output,'REPORT.zh-CN.md'),completed:rows.length,requests:attempts.length,audit:summary.independentAuditPassed,target:summary.targetCandidates,strictNoAction:summary.strictNoAction,passed:summary.passed}));
