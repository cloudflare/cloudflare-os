import { createWorld } from "./world.ts";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

let bamlBundle: Promise<{ code: string; wasm: Uint8Array }> | undefined;
async function bridge() {
  return (bamlBundle ??= (async () => {
    const entry = fileURLToPath(import.meta.resolve("@boundaryml/baml-bridge-web")).replace(
      "/dist/index.js",
      "/dist/workerd/index.js",
    );
    const result = await build({
      stdin: { contents: `export * from ${JSON.stringify(entry)};`, resolveDir: process.cwd() },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      conditions: ["workerd"],
      external: ["node:*", "*.wasm"],
    });
    const code = result.outputFiles[0].text.replace(
      /from "[^"\n]*bridge_web_core_bg.wasm"/g,
      'from "./bridge.wasm"',
    );
    return {
      code,
      wasm: await readFile(
        path.join(path.dirname(entry), "../workerd-wasm/bridge_web_core_bg.wasm"),
      ),
    };
  })());
}
export interface RuntimeResult {
  result?: unknown;
  state?: unknown;
  calls?: unknown[];
  error?: string;
  stage?: string;
  runtimeMs: number;
  compileMs?: number;
  requestMs?: number[];
}
/** Runs every candidate in a disposable workerd process with no credentials or outbound network. */
export async function execute(
  source: string,
  baml = false,
  bindings: string[] = [],
  repeat = 1,
): Promise<RuntimeResult> {
  const started = performance.now();
  const modules: {
    type: "ESModule" | "CompiledWasm";
    path: string;
    contents: string | Uint8Array;
  }[] = [];
  if (baml) {
    const b = await bridge();
    modules.push(
      { type: "ESModule", path: "/bridge.js", contents: b.code },
      { type: "CompiledWasm", path: "/bridge.wasm", contents: b.wasm },
    );
  } else modules.push({ type: "ESModule", path: "/agent.js", contents: source });
  const harness = `${baml ? 'import {initializeRuntime,callFunction,getRuntime,BamlTypeMap,setTypeMap} from "./bridge.js";' : 'import agent from "./agent.js";'}
 export default {async fetch(request, bindings) {
 const call=async(tool,input)=>{const response=await bindings.TOOLS.fetch("http://tools/",{method:"POST",body:JSON.stringify({tool,input})});const r=await response.json();if(r.error)throw Error(r.error);return r.value;};
 const env={TICKETS:{list:()=>call("list"),get:id=>call("get",id),close:input=>call("close",input),flaky:()=>call("flaky")},COUNTER:{read:()=>call("read"),write:value=>call("write",value),increment:()=>call("increment")},MCP:{query:input=>call("query",input)}};
 const self={report:value=>call("report",value)};
 let stage="compile", compileMs=0;
 try {
 ${baml ? `const start=Date.now();initializeRuntime(".",{"main.baml":${JSON.stringify(source)}});compileMs=Date.now()-start;` : ""}
 stage="execute";
 ${
   baml
     ? `const classes=Object.fromEntries(["Owner","Ticket","Metadata","CloseInput","Ok","Failure","Success","Filter","QueryInput","QueryResult"].map(n=>[n,class {constructor(fields){Object.assign(this,fields)}}]));
 setTypeMap(BamlTypeMap.fromLazyEntries({classes:Object.fromEntries(Object.entries(classes).map(([n,c])=>["user."+n,()=>c])),enums:{},typeAliases:{}}));
 const typed=(n,v)=>v==null?v:new classes[n](v);
 const ticket=v=>v==null?v:typed("Ticket",{...v,owner:typed("Owner",v.owner)});
 const oldList=env.TICKETS.list,oldGet=env.TICKETS.get,oldClose=env.TICKETS.close,oldFlaky=env.TICKETS.flaky,oldQuery=env.MCP.query;
 env.TICKETS.listRaw=async()=> (await oldList()).map(ticket);
 env.TICKETS.list=async()=>typed("QueryResult",{items:(await oldList()).map(ticket)});
 env.TICKETS.get=async id=>ticket(await oldGet(id));
 env.TICKETS.close=async x=>typed("Ok",await oldClose({...x,metadata:x.metadata??undefined}));
 env.TICKETS.flaky=async()=>{const r=await oldFlaky();return typed(r.ok?"Success":"Failure",r)};
 env.MCP.query=async x=>typed("QueryResult",{items:(await oldQuery({...x,limit:x.limit??undefined})).items.map(ticket)});`
     : ""
 }
 const callbacks={listRaw:env.TICKETS.listRaw,list:env.TICKETS.list,get:env.TICKETS.get,close:env.TICKETS.close,flaky:env.TICKETS.flaky,read:env.COUNTER.read,write:env.COUNTER.write,increment:env.COUNTER.increment,query:env.MCP.query};
 const args=Object.fromEntries(${JSON.stringify(bindings)}.map(k=>[k,callbacks[k]]));
 const result=${baml ? 'await callFunction(getRuntime(),"Main",args).then(r=>r.result())' : 'await agent(self,env,{waitUntil(p){throw Error("waitUntil unsupported in benchmark")}})'};
 return Response.json({result,compileMs});
 }catch(e){return Response.json({error:String(e),stage,compileMs})}
 }};`;
  modules.unshift({ type: "ESModule", path: "/harness.js", contents: harness });
  const world = createWorld();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      serviceBindings: { TOOLS: (request) => world.fetch(request) },
      modulesRoot: "/",
      compatibilityDate: "2026-10-01",
      compatibilityFlags: baml ? ["nodejs_compat"] : [],
      modules,
      outboundService: async () => new Response("network denied", { status: 403 }),
      log: new Log(LogLevel.NONE),
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let result: unknown;
    const requestMs: number[] = [];
    for (let i = 0; i < repeat; i++) {
      const requestStart = performance.now();
      result = await Promise.race([
        mf.dispatchFetch("http://benchmark/").then((r) => r.json()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("execution timeout")), 10000);
        }),
      ]);
      clearTimeout(timer);
      requestMs.push(performance.now() - requestStart);
    }
    return {
      ...(result as RuntimeResult),
      runtimeMs: performance.now() - started,
      state: world.state(),
      calls: world.calls,
      requestMs,
    };
  } catch (e) {
    return {
      error: String(e),
      stage: "startup",
      runtimeMs: performance.now() - started,
      state: world.state(),
      calls: world.calls,
    };
  } finally {
    clearTimeout(timer);
    await mf.dispose().catch(() => {});
  }
}
