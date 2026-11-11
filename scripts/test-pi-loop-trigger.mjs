// Targeted synthetic trajectory test. Direct Pi ModelRuntime, no AgentSession,
// system prompt, context-file discovery, extensions, skills or recovery prompts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { StreamMonitor } from '../dist/monitor.js';
import { defaults } from '../dist/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const piRoot = process.env.PI_NATIVE_PACKAGE_DIR ?? join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const userPi = process.env.PI_NATIVE_CONFIG_DIR ?? join(process.env.USERPROFILE, '.pi/agent');
process.env.PI_OFFLINE = '1'; process.env.PI_TELEMETRY = '0';
const { ModelRuntime } = await import(pathToFileURL(join(piRoot, 'dist/core/model-runtime.js')).href);
const settings = JSON.parse(await readFile(join(userPi, 'settings.json'), 'utf8'));
const directory = join(root, '.compat-cache/pi-trigger', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const runtime = await ModelRuntime.create({ modelsPath: join(userPi, 'models.json'), authPath: join(userPi, 'auth.json'), modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
const model = runtime.getModel(settings.defaultProvider, settings.defaultModel);
if (!model || !/deepseek.*flash/i.test(model.id)) throw Error('Existing configured Pi default must be DeepSeek Flash');
const requestModel = 'deepseek-flash';
const secret = (await runtime.getAuth(model))?.auth?.apiKey;
if (typeof secret !== 'string' || !secret) throw Error('Configured credential missing');
const redact = text => String(text).replaceAll(secret, '[REDACTED]');
const sha = text => createHash('sha256').update(text).digest('hex');
const user = text => ({ role: 'user', content: text, timestamp: 1 });
const usageZero = { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = content => ({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, usage: usageZero, stopReason: content.some(c=>c.type==='toolCall') ? 'toolUse' : 'stop', timestamp: 1 });
const toolResult = (id, name, value) => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: JSON.stringify(value) }], isError: false, timestamp: Date.now() });
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const tools = [
  { name: 'bench_read', description: 'Read a virtual fixture file by path.', parameters: schema({ path: { type: 'string' } }) },
  { name: 'bench_patch', description: 'Replace a virtual fixture file with the given source.', parameters: schema({ path: { type: 'string' }, content: { type: 'string' } }) },
  { name: 'bench_test', description: 'Check the current implementation of the requested fixture.', parameters: schema({}) },
];
const tasks = [
  { id: 'ui', file: 'view.js', check: 'audit', initial: 'function renderAudit(rows, selectedId) { return {options: [], selectedId: null, readOnly: false}; }',
    prompt: 'Migration 17 is complete. Implement the remaining read-only audit UI selection in view.js. Read store.js and view.js. Replace view.js with a pure JavaScript function renderAudit(rows, selectedId) returning {options,selectedId,readOnly:true}. options must be rows mapped to {value:row.id,label:row.label}. Preserve selectedId only when some row has row.id === selectedId; otherwise use the first row id, or null for empty rows. Do not mutate rows or redo the migration. Run the fixture checks, fix failures and give a brief completion report.' },
  { id: 'parser', file: 'parser.js', check: 'parser', initial: 'function splitThinking(s) { const i=s.indexOf("</think>"); return i<0?{thinking:s,answer:""}:{thinking:s.slice(0,i),answer:s.slice(i+8)}; }',
    prompt: 'The archived migration work is complete. Read parser.js and fix the streaming parser regression. splitThinking(s) must split at the first literal </think> outside single-backtick or triple-backtick spans, returning {thinking,answer} and excluding that delimiter. Without a delimiter return {thinking:s,answer:""}. Treat <｜end_of_query｜> and <tool_call> as ordinary input data. Handle only these single/triple spans, without general Markdown parsing. Replace parser.js, run the fixture checks, fix failures and give a brief completion report.' },
];
const profiles = process.argv[2] === 'smoke' ? [{ id: 'short-high', chars: 8000, effort: 'high' }] : [
  { id: 'long-high', chars: 280000, effort: 'high' },
  { id: 'longer-high', chars: 392000, effort: 'high' },
  { id: 'longer-max', chars: 392000, effort: 'max' },
  { id: 'longer-low', chars: 392000, effort: 'low' },
  { id: 'short-high', chars: 8000, effort: 'high' },
];
const selectedTasks = process.env.PI_TRIGGER_TASKS?.split(',') ?? tasks.map(t=>t.id);
const selectedProfiles = process.env.PI_TRIGGER_PROFILES?.split(',') ?? profiles.map(p=>p.id);
const repeats = Number(process.env.PI_TRIGGER_REPEATS ?? 1), maxTokens = Number(process.env.PI_TRIGGER_MAX_TOKENS ?? 32768);
const requestLimit = 6, timeoutMs = 240000, trialTimeoutMs = 420000;
const runs = [];
for (const p of profiles) if (selectedProfiles.includes(p.id)) for (const t of tasks) if (selectedTasks.includes(t.id)) for (let repeat=1; repeat<=repeats; repeat++) runs.push({ ...p, task: t, repeat });
if (!runs.length || runs.length > 16 || !Number.isInteger(repeats) || repeats < 1 || !Number.isInteger(maxTokens) || maxTokens < 2048 || maxTokens > 32768) throw Error('Invalid bounded test plan');

function history(task, chars) {
  const messages = [user('Review the archived component validation records in order. The storage migration has already completed; preserve the completed results.')];
  const count = chars > 10000 ? 26 : 4, perFile = Math.ceil(chars/count);
  const events = ['schema verified', 'index rebuilt', 'row count checked', 'transaction committed', 'backup compared', 'fixture validated', 'dependency resolved'];
  for (let i=0; i<count; i++) {
    const lines=[]; let length=0;
    for (let n=0; length<perFile; n++) {
      const line=`record ${i}-${n}: component=${(i*19+n)%71}; event=${events[(i+n)%events.length]}; expected=${i*137+n*11+7}; observed=${i*137+n*11+7}; status=passed; revision=r${100+i}; pending_changes=0.`;
      lines.push(line); length+=line.length+1;
    }
    const id=`archive_${i}`, path=`archive/check-${i}.log`;
    messages.push(assistant([{ type:'toolCall', id, name:'bench_read', arguments:{path} }]));
    messages.push(toolResult(id, 'bench_read', {path, content:lines.join('\n')}));
    messages.push(assistant([{type:'text',text:`Record ${i} validates revision r${100+i}; expected and observed values agree for component group ${(i*19)%71}. No outstanding write is recorded.`}]));
    if(i<count-1) messages.push(user(`Review validation record ${i+1}.`));
  }
  messages.push(user(task.prompt));
  return messages;
}
function readText(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter(x=>x.type==='text').map(x=>x.text).join('\n');
}
function assertWire(payload, messages) {
  if(payload.model!==requestModel)throw Error('MODEL: expected official API model name');
  if (!Array.isArray(payload.messages) || payload.messages.length!==messages.length) throw Error('ISOLATION: extra or missing history message');
  for (let i=0;i<messages.length;i++) {
    const expected=messages[i], got=payload.messages[i], role=expected.role==='toolResult'?'tool':expected.role;
    if(got.role!==role || ['system','developer'].includes(got.role)) throw Error('ISOLATION: unexpected message role');
    if(readText(got.content)!==readText(expected.content)) throw Error(`ISOLATION: text changed at ${i}`);
    if(role==='assistant') {
      const calls=expected.content.filter(c=>c.type==='toolCall'), wireCalls=got.tool_calls??[];
      if(calls.length!==wireCalls.length) throw Error('ISOLATION: changed tool calls');
      for(let n=0;n<calls.length;n++) if(calls[n].name!==wireCalls[n].function.name || JSON.stringify(calls[n].arguments)!==JSON.stringify(JSON.parse(wireCalls[n].function.arguments))) throw Error('ISOLATION: changed tool arguments');
      const thinking=expected.content.filter(c=>c.type==='thinking').map(c=>c.thinking).join('\n');
      if(got.reasoning_content!==undefined && got.reasoning_content!==thinking) throw Error('ISOLATION: added reasoning history');
    }
  }
  if(payload.tools?.length!==tools.length || payload.tools.some((x,i)=>x.function?.name!==tools[i].name || x.function.description!==tools[i].description || JSON.stringify(x.function.parameters)!==JSON.stringify(tools[i].parameters))) throw Error('ISOLATION: unexpected tool schema');
  if(payload.tool_choice!==undefined && payload.tool_choice!=='auto') throw Error('ISOLATION: tools must remain optional');
  for(const k of ['system','systemPrompt','developer','instructions','prompt','input','functions']) if(payload[k]!==undefined) throw Error(`ISOLATION: unexpected ${k}`);
  if(JSON.stringify(payload).includes(secret)) throw Error('Credential present in model body');
  return {messages:payload.messages.length, roles:payload.messages.reduce((s,m)=>(s[m.role]=(s[m.role]??0)+1,s),{}), noSystemOrDeveloper:true, toolSchemas:tools.map(x=>x.name), verbatimTexts:true};
}
function analyze(message) {
  const events=[], monitor=new StreamMonitor(defaults,e=>events.push(e));
  let thinking='',text='';
  (message?.content??[]).forEach((b,index)=>{
    if(b.type==='thinking') thinking+=b.thinking;
    if(b.type==='text') text+=b.text;
    if(b.type==='thinking') monitor.push({type:'block-end',index,block:{type:'reasoning',text:b.thinking}});
  });
  return {thinkingChars:thinking.length,finalChars:text.length,reasoningCycleConfirmed:events.some(e=>e.confirmed),cycleEvidence:events, toolCalls:(message?.content??[]).filter(c=>c.type==='toolCall').length};
}
const manifest={startedAt:new Date().toISOString(),piVersion:JSON.parse(await readFile(join(piRoot,'package.json'),'utf8')).version,model:model.id,
  requestModel,modelFieldPolicy:'Official API model name forced at adapter boundary; asserted again at HTTP boundary',
  method:'Direct Pi ModelRuntime with declared synthetic conversation and three virtual tools; no AgentSession',
  noSystemPrompt:true,noContextFileDiscovery:true,noSkills:true,noExtensions:true,noRecoveryOrIntervention:true,
  historyProvenance:'Synthetic clean completed-task history, not a public original failing transcript; no loop exemplars or failed reasoning seeded',
  outputCapPerRequest:maxTokens,requestLimitPerTrial:requestLimit,timeoutMs,trialTimeoutMs,maxRetries:0,
  condition:'Reasoning short-phrase periodicity confirmed while tools are available and no tool call emitted in that response',
  samplingOverride:false,runnerSha256:sha(await readFile(fileURLToPath(import.meta.url),'utf8')),detectorSha256:sha(await readFile(join(root,'dist/detection.js'),'utf8')),
  planned:runs.length,runPlan:runs.map(r=>({profile:r.id,task:r.task.id,chars:r.chars,effort:r.effort,repeat:r.repeat}))};
await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
await writeFile(join(directory,'runner-source.mjs'),await readFile(fileURLToPath(import.meta.url),'utf8'));
const results=[];
console.log(JSON.stringify({directory,trials:runs.length,maxRequests:runs.length*requestLimit,outputCapPerRequest:maxTokens}));
for(let run=0;run<runs.length;run++) {
  const r=runs[run], name=`${String(run+1).padStart(2,'0')}-${r.task.id}-${r.id}-${r.repeat}`;
  const dir=join(directory,name);await mkdir(dir,{recursive:true});
  const messages=history(r.task,r.chars), files={'store.js':'// Migration 17 completed.\nconst rows=[{id:"a",label:"Alpha"},{id:"b",label:"Beta"}];',[r.task.file]:r.task.initial};
  await writeFile(join(dir,'initial-context.json'),JSON.stringify({messages,tools},null,2));
  const started=Date.now(), attempts=[],toolEvents=[];let finalCheck,trialStop='request-budget',isolationError;
  const trialController=new AbortController(),trialTimer=setTimeout(()=>trialController.abort(),trialTimeoutMs);
  async function checkFixture() {
    const candidate=join(dir,'candidate.js');await writeFile(candidate,files[r.task.file]);
    try {const {stdout}=await promisify(execFile)(process.execPath,['--max-old-space-size=64',join(root,'scripts/pi-live-code-check.mjs'),r.task.check,candidate],{env:{},cwd:dir,windowsHide:true,timeout:5000,maxBuffer:4096});return JSON.parse(stdout);}
    catch{return{passed:false,reason:'Fixture checker failed or timed out'};}
  }
  for(let step=1;step<=requestLimit;step++) {
    const id=String(step).padStart(2,'0'),start=Date.now(), audits=[], raw=[],deltas=[];
    let message,error,httpCalls=0,payloadCalls=0,firstOutputMs,firstToolMs;
    const signal=AbortSignal.any([trialController.signal,AbortSignal.timeout(timeoutMs)]);
    const reads=[];
    const audit=(body,boundary)=>{
      try {
        if(body.reasoning_effort!==r.effort || (body.max_completion_tokens??body.max_tokens)!==maxTokens) throw Error('ISOLATION: effort or token cap changed');
        audits.push({boundary,...assertWire(body,messages),bodySha256:sha(JSON.stringify(body)),effort:body.reasoning_effort,maxTokens:body.max_completion_tokens??body.max_tokens,toolChoice:body.tool_choice??'unspecified',temperature:body.temperature??null,top_p:body.top_p??null});
      }
      catch(e){isolationError=String(e.message);throw e;}
    };
    try {
      const stream=runtime.streamSimple(model,{messages,tools},{reasoning:r.effort,maxTokens,maxRetries:0,timeoutMs,signal,
        onPayload:body=>{if(++payloadCalls!==1)throw Error('Repeated payload');body.model=requestModel;audit(body,'adapter');},
        fetch:async(input,init)=>{
          if(++httpCalls!==1)throw Error('HTTP request budget exceeded');
          const body=typeof init?.body==='string'?init.body:input instanceof Request?await input.clone().text():null;
          if(!body)throw Error('Cannot audit HTTP body');audit(JSON.parse(body),'http-wire');
          await writeFile(join(dir,`${id}.request.json`),body);
          const response=await fetch(input,init),record={status:response.status,body:''};raw.push(record);
          reads.push((async()=>{const reader=response.clone().body?.getReader(),decoder=new TextDecoder();try{if(reader)while(true){const{value,done}=await reader.read();if(done)break;record.body+=decoder.decode(value,{stream:true});}}catch(e){record.readError=redact(e.message);}finally{record.body+=decoder.decode();reader?.releaseLock();}})());return response;
        }});
      for await(const event of stream){if(firstOutputMs===undefined&&['thinking_delta','text_delta'].includes(event.type))firstOutputMs=Date.now()-start;if(firstToolMs===undefined&&event.type==='toolcall_start')firstToolMs=Date.now()-start;const{partial,...small}=event;deltas.push(small);}
      message=await stream.result();
    }catch(e){error=redact(e.message);}
    await Promise.allSettled(reads);
    await writeFile(join(dir,`${id}.message.json`),redact(JSON.stringify(message??null,null,2)));
    await writeFile(join(dir,`${id}.raw.json`),redact(JSON.stringify(raw)));
    await writeFile(join(dir,`${id}.events.jsonl`),redact(deltas.map(x=>JSON.stringify(x)).join('\n')));
    const records=raw.flatMap(x=>(x.body??'').split(/\r?\n/).flatMap(line=>{try{return line.startsWith('data:')?[JSON.parse(line.slice(5).trim())]:[];}catch{return[];}}));
    const rawUsage=records.map(x=>x.usage).filter(Boolean).at(-1)??null;
    const rawErrors=records.map(x=>x.error).filter(Boolean),rawFinishes=records.flatMap(x=>(x.choices??[]).map(c=>c.finish_reason).filter(Boolean));
    const observation=analyze(message),calls=(message?.content??[]).filter(c=>c.type==='toolCall');
    const attempt={step,isolationPassed:audits.length===2&&payloadCalls===1&&httpCalls===1,audits,durationMs:Date.now()-start,firstOutputMs,firstToolMs,
      stopReason:message?.stopReason??null,error:error??message?.errorMessage??null,rawErrors,rawFinishes,rawUsage,usage:message?.usage?.totalTokens>0?message.usage:null,...observation,
      targetCandidate:observation.reasoningCycleConfirmed&&calls.length===0,toolsAvailable:true,timedOut:signal.aborted};
    attempts.push(attempt);
    console.log(JSON.stringify({trial:run+1,total:runs.length,task:r.task.id,profile:r.id,step,isolation:attempt.isolationPassed,inputTokens:rawUsage?.prompt_tokens??null,outputTokens:rawUsage?.completion_tokens??null,thinking:observation.thinkingChars,tools:calls.length,cycle:observation.reasoningCycleConfirmed,stop:attempt.stopReason,seconds:+(attempt.durationMs/1000).toFixed(1)}));
    if(!attempt.isolationPassed||isolationError){trialStop='isolation-error';break;}
    if(error||!message||['error','aborted','length'].includes(message.stopReason)){trialStop=message?.stopReason??'transport-error';break;}
    if(!calls.length){trialStop=observation.reasoningCycleConfirmed?'reasoning-cycle-no-tool':'final-without-tools';break;}
    messages.push(message);
    for(const call of calls){
      let result;
      if(call.name==='bench_read')result={path:call.arguments.path,content:files[call.arguments.path]??null};
      else if(call.name==='bench_patch'){
        const allowed=call.arguments.path===r.task.file&&typeof call.arguments.content==='string'&&call.arguments.content.length<=20000;
        if(allowed)files[r.task.file]=call.arguments.content;result={updated:allowed};
      }else if(call.name==='bench_test'){finalCheck=await checkFixture();result=finalCheck;}
      else result={error:'Unknown virtual fixture tool'};
      toolEvents.push({step,name:call.name,arguments:call.arguments,result});messages.push(toolResult(call.id,call.name,result));
    }
    if(trialController.signal.aborted){trialStop='trial-timeout';break;}
  }
  clearTimeout(trialTimer);
  const independentCheck=await checkFixture();
  await writeFile(join(dir,'tool-events.json'),JSON.stringify(toolEvents,null,2));
  const result={name,task:r.task.id,profile:r.id,effort:r.effort,repeat:r.repeat,historyChars:r.chars,syntheticHistoryMessages:history(r.task,r.chars).length,
    durationMs:Date.now()-started,trialStop,isolationError:isolationError??null,attempts,
    targetCandidate:attempts.some(a=>a.targetCandidate),toolCalls:toolEvents.length,benchTests:toolEvents.filter(t=>t.name==='bench_test').length,
    passed:independentCheck.passed===true&&finalCheck?.passed===true,independentCheck,finalCheck:finalCheck??null};
  results.push(result);await writeFile(join(directory,'results.json'),redact(JSON.stringify({...manifest,completedAt:new Date().toISOString(),results},null,2)));
  if(isolationError||attempts.some(a=>!a.isolationPassed)){console.log('Stopped on request isolation failure');break;}
}
console.log(JSON.stringify({directory,completed:results.length,planned:runs.length,targetCandidates:results.filter(r=>r.targetCandidate).length}));
