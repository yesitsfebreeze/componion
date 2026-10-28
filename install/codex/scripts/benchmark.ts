/** Reproducible local preparation benchmark. No model or network requests. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeIndex, parseRollout } from './core';
const dir=await mkdtemp(join(tmpdir(),'componion-bench-'));const previous=process.env.CODEX_HOME;
process.env.CODEX_HOME=dir;
const sid='benchmark',path=join(dir,'rollout.jsonl');
const row=(type:string,payload:any)=>JSON.stringify({type,payload});
const body=[row('session_meta',{id:sid}),...Array.from({length:2000},(_,i)=>[
 row('response_item',{type:'function_call',name:'exec_command',call_id:'c'+i,arguments:'{"cmd":"read fixture"}'}),
 row('response_item',{type:'function_call_output',call_id:'c'+i,output:'result '+i+' '+('fixture Ω '.repeat(800))})]).flat()].join('\n');
await writeFile(path,body);const legacyDir=join(dir,'legacy');await mkdir(legacyDir);
// Original path: read to discover, reread to parse, serial exclusive writes even for existing archives.
async function legacy() {
 await readFile(path,'utf8');const data=parseRollout(await readFile(path,'utf8'));
 for(const entry of data.entries) {try{await writeFile(join(legacyDir,entry.id),entry.text,{flag:'wx'});}catch(e:any){if(e.code!=='EEXIST')throw e;}}
 return data.entries.map(e=>`${e.id}: ${e.text.replace(/\s+/g,' ').slice(0,100)}`).join('\n');
}
const measure=async(fn:()=>Promise<any>)=>{const t=performance.now();await fn();return performance.now()-t;};
const median=(xs:number[])=>xs.sort((a,b)=>a-b)[Math.floor(xs.length/2)];
try {
 const oldCold=await measure(legacy),newCold=await measure(()=>makeIndex(sid,path,undefined,{fast:true}));
 const old:number[]=[],fast:number[]=[];
 for(let i=0;i<7;i++){old.push(await measure(legacy));fast.push(await measure(()=>makeIndex(sid,path,undefined,{fast:true})));}
 const baseline=median(old),cached=median(fast);
 console.log(JSON.stringify({fixtureBytes:Buffer.byteLength(body),toolOutputs:2000,runs:7,cold:{legacyMs:oldCold,fastMs:newCold,speedup:oldCold/newCold},unchanged:{legacyMedianMs:baseline,fastMedianMs:cached,speedup:baseline/cached},scope:'Local archive/index preparation only. Baseline excludes network grading; native model compaction latency is not measured.'},null,2));
}finally{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;await rm(dir,{recursive:true,force:true});}
