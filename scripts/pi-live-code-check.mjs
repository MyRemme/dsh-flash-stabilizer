import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const kind = process.argv[2], code = readFileSync(process.argv[3], 'utf8');
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const tests = kind === 'code' ? `
const tests = [[], [[1,2],[2,3]], [[1,4],[2,3],[4,5]], [[0,0],[2,2]], [[-5,-2],[-3,0],[1,9],[2,4]], [[1,5],[1,3],[0,2]]];
let seed=12345;
for(let n=0;n<60;n++){const a=[];for(let i=0;i<10;i++){seed=(seed*1664525+1013904223)>>>0;const start=seed%40-20;seed=(seed*1664525+1013904223)>>>0;a.push([start,start+seed%9]);}tests.push(a);}
function reference(a){const b=a.filter(([s,e])=>s<e).map(x=>[...x]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]),out=[];for(const x of b){const p=out.at(-1);if(p&&x[0]<p[1])p[1]=Math.max(p[1],x[1]);else out.push(x);}return out;}
let passes=0;for(const a of tests){const before=JSON.stringify(a),expected=JSON.stringify(reference(a));const result=mergeIntervals(a);if(JSON.stringify(result)!==expected||JSON.stringify(a)!==before)throw Error('Incorrect output or input mutation');passes++;}
JSON.stringify({passed:true,checks:passes});
` : kind === 'audit' ? `
const original=[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}];
let checks=0;
for(const [rows,id,want]of [[original,'b','b'],[original,'missing','a'],[original,null,'a'],[[],null,null]]){
 const before=JSON.stringify(rows),got=renderAudit(rows,id);
 if(got.readOnly!==true||got.selectedId!==want||JSON.stringify(rows)!==before)throw Error('Case '+checks+': expected selectedId='+JSON.stringify(want)+' and readOnly=true without input mutation; got '+JSON.stringify(got));
 if(JSON.stringify(got.options)!==JSON.stringify(rows.map(r=>({value:r.id,label:r.label}))))throw Error('Incorrect options');checks++;
}
JSON.stringify({passed:true,checks});
` : `
const cases=[['abc</think>def',{thinking:'abc',answer:'def'}],['abc',{thinking:'abc',answer:''}],['x \\x60</think>\\x60 y</think>z',{thinking:'x \\x60</think>\\x60 y',answer:'z'}],['a \\x60\\x60\\x60</think>\\x60\\x60\\x60 b</think>c',{thinking:'a \\x60\\x60\\x60</think>\\x60\\x60\\x60 b',answer:'c'}],['<｜end_of_query｜><tool_call></think>ok',{thinking:'<｜end_of_query｜><tool_call>',answer:'ok'}]];
for(const [s,want]of cases){const got=splitThinking(s);if(got.thinking!==want.thinking||got.answer!==want.answer)throw Error('Incorrect delimiter parsing');}
JSON.stringify({passed:true,checks:cases.length});
`;
try { console.log(vm.runInContext(code + '\n' + tests, context, { timeout: 1000 })); }
catch (error) { console.log(JSON.stringify({ passed: false, reason: String(error.message).slice(0, 1000) })); }
