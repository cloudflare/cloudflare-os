import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piBridgeSource, validatePiCommand } from "../src/pi-backbone.js";

// A real local subprocess with only a mocked JSONL child. No runtime, model, or production connection.
async function bridge(options: { largeHistory?: boolean; dialogTimeout?: number; drainTimeout?: number; ignoreTerm?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-bridge-test-"));
  const ledger = join(dir, "spawns");
  const beforeExit = join(dir, "before-exit");
  const mock = `const largeHistory = ${options.largeHistory === true};
    require('node:fs').appendFileSync(${JSON.stringify(ledger)}, process.pid+'\\n');
    ${options.ignoreTerm ? "process.on('SIGTERM', () => {});" : ""}\n` + String.raw`
    const {createInterface} = require('node:readline');
    const {writeFileSync,writeSync,closeSync} = require('node:fs');
    function emit(value) {process.stdout.write(JSON.stringify(value)+'\n');}
    let waiting;
    createInterface({input:process.stdin}).on('line', line => {
      const c=JSON.parse(line);
      if(c.type==='extension_ui_response') {
        emit({type:'dialog_answer', confirmed:c.confirmed, cancelled:c.cancelled});
        if(waiting) {
          emit({type:'response',id:waiting.id,command:waiting.type,success:true,data:{cancelled:c.cancelled}});
          waiting=undefined;
        }
        return;
      }
      if(c.message?.startsWith('wait-')) {
        waiting=c;
        emit({type:'extension_ui_request',id:'waiter',method:c.message==='wait-editor'?'editor':'confirm',
          ...(c.message==='wait-timeout'?{timeout:20}:{})});
        return; // Upstream cannot finish this command until an actual dialog response arrives.
      }
      if(c.message==='die') {process.exit(1); return;}
      if(c.message==='stdin-close') {
        setInterval(() => {}, 1000); // Keep the child and stdout alive after closing stdin.
        process.stdin.once('close', () => {
          // Standard input can retain fd 0 after destroy(); ensure the pipe reader is gone.
          try {closeSync(0);} catch (error) {if(error.code!=='EBADF') throw error;}
          emit({type:'stdin_closed'});
          emit({type:'response',id:c.id,command:c.type,success:true,data:{closed:true}});
        });
        process.stdin.destroy();
        return;
      }
      if(c.message==='malformed') {process.stdout.write('not-json\n'); return;}
      if(c.message==='oversize-stall' || c.message==='oversize-trickle' || c.message==='oversize-eof') {
        process.stdout.write('{"text":"'+'x'.repeat(3*1024*1024), () => {
          if(c.message==='oversize-eof') closeSync(1);
          if(c.message==='oversize-trickle') setInterval(() => process.stdout.write('x'), 10);
        });
        setInterval(() => {}, 1000); // Deliberately alive, without completing the frame.
        return;
      }
      if(c.message==='stdout-eof') {
        writeSync(1, '{"type":'); closeSync(1);
        setInterval(() => {}, 1000); // EOF must clean up a live child, not await its exit.
        return;
      }
      if(largeHistory && c.type==='get_entries') {
        process.stdout.write(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,
          data:{entries:[{text:'x'.repeat(8*1024*1024)}]}})+'\n'+JSON.stringify({type:'history_drained'})+'\n');
        return;
      }
      if(c.message==='overflow') {for(let i=0;i<300;i++) emit({type:'message_update',i});}
      if(c.type==='export_html') writeFileSync(c.outputPath,'<script>untrusted()</script>');
      if(c.type==='prompt') {
        emit({type:'extension_ui_request',id:'d1',method:'confirm',title:'Continue?'});
        emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:c.message}]}});
        emit({type:'agent_end'}); emit({type:'agent_settled'});
      }
      const data = c.type==='get_entries' ? {entries:[{id:'entry',type:'message'}]} :
        c.type==='get_messages' ? {messages:[{role:'user',content:'hello'}]} :
        c.type==='get_state' ? {isStreaming:false,sessionId:'mock-session',pid:process.pid} : {accepted:true,received:c.message};
      // Split protocol frames across chunks, keeping stderr separate.
      const frame=JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data})+'\n';
      process.stdout.write(frame.slice(0,8)); process.stdout.write(frame.slice(8));
      process.stderr.write('not protocol\n');
    });`;
  const source = piBridgeSource().replace(/^const argv = .*;\n/, `const argv = ${JSON.stringify([process.execPath, "-e", mock])};\n`)
    .replace(/^if \(JSON.parse\(readFileSync.*\n/m, "") // The only executable here is the local mock above.
    .replace("/workspace/.odie-pi/owner-bridge.lock", join(dir, "lock"))
    .replace("const DIALOG_TIMEOUT = 30000;", `const DIALOG_TIMEOUT = ${options.dialogTimeout ?? 30000};`)
    .replace("const DRAIN_TIMEOUT = 5000;", `const DRAIN_TIMEOUT = ${options.drainTimeout ?? 5000};`)
    .replace("server.listen(4097", "server.listen(0")
    .replace("'Pi owner bridge ready\\n'", "String(server.address().port)+'\\n'")
    + `\nprocess.once('beforeExit', () => { writeFileSync(${JSON.stringify(beforeExit)}, 'natural'); });
       import { writeFileSync } from 'node:fs';`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {stdio:["pipe", "pipe", "pipe"]});
  child.stderr.resume();
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bridge startup timeout")), 5000);
    child.once("error", reject);
    child.once("exit", code => {clearTimeout(timer); reject(new Error(`Bridge exited ${code}`));});
    child.stdout.once("data", data => {clearTimeout(timer); resolve(Number(data.toString().trim()));});
  });
  return {
    child, port,
    async spawnPids() { return (await readFile(ledger, "utf8")).trim().split("\n").map(Number); },
    async naturalExit() { return readFile(beforeExit, "utf8"); },
    async duplicate() {
      const duplicate = spawn(process.execPath, ["--input-type=module", "-e", source], {stdio:"ignore"});
      try {
        await vi.waitFor(() => expect(duplicate.exitCode !== null || duplicate.signalCode !== null).toBe(true), {timeout:2000});
        return duplicate.exitCode;
      } finally {
        if (duplicate.exitCode === null && duplicate.signalCode === null) duplicate.kill("SIGKILL");
        await vi.waitFor(() => expect(duplicate.exitCode !== null || duplicate.signalCode !== null).toBe(true), {timeout:1000});
      }
    },
    async call(command: Record<string, unknown>) {
      const response = await fetch(`http://127.0.0.1:${port}/`, {method:"POST", body:JSON.stringify(command)});
      return {status:response.status, data:await response.json() as any};
    },
    async close() {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), {timeout:2500});
      } finally {
        // Emergency cleanup only: assertions in shutdown tests run before this teardown.
        for (const pid of (await readFile(ledger, "utf8")).trim().split("\n").map(Number)) {
          try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), {timeout:1000});
        await rm(dir, {recursive:true,force:true});
      }
    },
  };
}

describe("Pi owner bridge subprocess", () => {
  it.each([false, true])("exits naturally with open stdin and an active partial HTTP request (ignore SIGTERM: %s)", async ignoreTerm => {
    const b = await bridge({ignoreTerm});
    let partial: ClientRequest | undefined;
    try {
      const pid = (await b.call({type:"get_state"})).data.pid;
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(await b.duplicate()).toBe(1);
      expect(await b.spawnPids()).toEqual([pid]);
      partial = request({host:"127.0.0.1",port:b.port,path:"/",method:"POST",agent:false,
        headers:{Expect:"100-continue","Content-Length":"100"}});
      let accepted = false, closed = false;
      partial.on("continue", () => { accepted = true; });
      partial.on("close", () => { closed = true; });
      partial.on("error", () => {}); // Expected reset at the shutdown deadline.
      partial.flushHeaders();
      await vi.waitFor(() => expect(accepted).toBe(true));
      partial.write('{'); // Never finish the accepted request or close the parent stdin pipe.
      expect(closed).toBe(false);
      expect(b.child.stdin.writableEnded).toBe(false);
      b.child.kill("SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(b.child.exitCode).toBeNull();
      expect(b.child.signalCode).toBeNull();
      expect(closed).toBe(false);
      if (ignoreTerm) expect(() => process.kill(pid, 0)).not.toThrow();
      else await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {timeout:500});
      b.child.kill("SIGTERM"); // Repeated signals must not reset the deadline.
      await vi.waitFor(() => {
        expect(b.child.exitCode).toBe(0);
        expect(b.child.signalCode).toBeNull();
        expect(closed).toBe(true);
        expect(() => process.kill(b.child.pid!, 0)).toThrow();
        expect(() => process.kill(pid, 0)).toThrow();
      }, {timeout:2000});
      expect(b.child.stdin.writableEnded).toBe(false);
      expect(await b.naturalExit()).toBe("natural");
      expect(await b.duplicate()).toBe(1);
      expect(await b.spawnPids()).toEqual([pid]);
    } finally {partial?.destroy(); await b.close();}
  });

  it("serves real correlated history/state/input/cancel, settlement, dialogs and untrusted exports", async () => {
    const b = await bridge();
    try {
      expect((await b.call({type:"get_state"})).data.sessionId).toBe("mock-session");
      expect(await b.duplicate()).toBe(1); // Exclusive retained lock, before spawning the mock brain.
      expect((await b.call({type:"get_entries"})).data.entries[0].id).toBe("entry");
      expect((await b.call({type:"get_messages"})).data.messages).toHaveLength(1);
      expect((await b.call({type:"prompt",message:"hello 世界"})).status).toBe(200);
      const events = (await b.call({type:"events",after:0})).data;
      expect(events.events.map((e: any) => e.data.type)).toContain("agent_settled");
      expect(events.events.find((e: any) => e.data.type === "message_end").data.message.content[0].text).toBe("hello 世界");
      expect(events.dialogs).toHaveLength(1);
      expect((await b.call({type:"extension_ui_response",id:"unknown",confirmed:true})).status).toBe(409);
      expect((await b.call({type:"extension_ui_response",id:"d1",confirmed:false})).status).toBe(200);
      expect((await b.call({type:"abort"})).status).toBe(200);
      const artifact = (await b.call({type:"export_html"})).data;
      expect(Buffer.from(artifact.base64,"base64").toString()).toContain("<script>");
      expect(artifact.filename).toBe("pi-session.html");
      await b.call({type:"prompt",message:"overflow"});
      expect((await b.call({type:"events",after:0})).data.truncated).toBe(true);
      expect((await b.call({type:"prompt",message:"die"})).status).toBe(409);
      expect((await b.call({type:"events",after:0})).data.dead).toBe(true);
    } finally {await b.close();}
  });

  it("fails closed on malformed stdout and does not resurrect the subprocess", async () => {
    const b = await bridge();
    try {
      expect((await b.call({type:"prompt",message:"malformed"})).status).toBe(409);
      expect((await b.call({type:"get_state"})).status).toBe(409);
      expect((await b.call({type:"events",after:0})).data.dead).toBe(true);
    } finally {await b.close();}
  });

  it.each(["wait-timeout", "wait-no-timeout", "wait-editor"])("cancels upstream %s dialogs on expiry, releasing a waiting command", async message => {
    const b = await bridge({dialogTimeout:80});
    try {
      const reply = await b.call({type:"prompt",message});
      expect(reply).toEqual({status:200,data:{cancelled:true}});
      const events = (await b.call({type:"events",after:0})).data;
      expect(events.dialogs).toEqual([]);
      expect(events.events.filter((e: any) => e.data.type === "dialog_answer").map((e: any) => e.data.cancelled)).toEqual([true]);
      expect((await b.call({type:"extension_ui_response",id:"waiter",confirmed:true})).status).toBe(409);
      expect((await b.call({type:"get_state"})).status).toBe(200);
    } finally {await b.close();}
  });

  it("drains an oversized valid history frame without killing Pi and resumes parsing at LF", async () => {
    const b = await bridge({largeHistory:true,drainTimeout:1000});
    try {
      const pid = (await b.call({type:"get_state"})).data.pid;
      const history = await b.call({type:"get_entries"});
      expect(history.status).toBe(409);
      expect(history.data.error).toMatch(/too large.*outcomes unknown/);
      await vi.waitFor(async () => {
        const events = (await b.call({type:"events",after:0})).data;
        expect(events.dead).toBe(false);
        expect(events.events.map((e: any) => e.data.type)).toContain("history_drained");
        expect(events.events.map((e: any) => e.data.type)).toContain("bridge_frame_omitted");
      });
      // LF must cancel the deadline, not merely allow a short-lived recovery.
      await new Promise(resolve => setTimeout(resolve,1100));
      expect((await b.call({type:"events",after:0})).data.dead).toBe(false);
      expect((await b.call({type:"get_state"})).data.pid).toBe(pid);
      expect((await b.call({type:"abort"})).status).toBe(200);
    } finally {await b.close();}
  });

  it.each(["oversize-stall", "oversize-trickle"])("bounds %s drain time and cleans up the child", async message => {
    const b = await bridge({drainTimeout:80});
    try {
      const pid = (await b.call({type:"get_state"})).data.pid;
      expect((await b.call({type:"prompt",message})).status).toBe(409);
      await vi.waitFor(async () => {
        const events = (await b.call({type:"events",after:0})).data;
        expect(events.dead).toBe(true);
        expect(events.events.map((e: any) => e.data.type)).toContain("bridge_exit");
        expect(() => process.kill(pid,0)).toThrow();
      });
      expect((await b.call({type:"abort"})).status).toBe(409);
    } finally {await b.close();}
  });

  it.each(["stdout-eof", "oversize-eof"])("fails and cleans up an alive child on %s before the drain deadline", async message => {
    const b = await bridge({drainTimeout:10000});
    try {
      const pid = (await b.call({type:"get_state"})).data.pid;
      expect((await b.call({type:"prompt",message})).status).toBe(409);
      await vi.waitFor(async () => {
        expect((await b.call({type:"events",after:0})).data.dead).toBe(true);
        expect(() => process.kill(pid,0)).toThrow();
      }, {timeout:1000});
      expect((await b.call({type:"get_state"})).status).toBe(409);
    } finally {await b.close();}
  });

  it("kills an alive child on stdin write error before bridge teardown", async () => {
    const b = await bridge();
    try {
      const pid = (await b.call({type:"get_state"})).data.pid;
      expect(await b.call({type:"prompt",message:"stdin-close"})).toEqual({status:200,data:{closed:true}});
      const closed = (await b.call({type:"events",after:0})).data;
      expect(closed.events.map((e: any) => e.data.type)).toContain("stdin_closed");
      expect(closed.dead).toBe(false);
      expect(() => process.kill(pid,0)).not.toThrow();

      expect((await b.call({type:"get_state"})).status).toBe(409);
      const failed = (await b.call({type:"events",after:0})).data;
      expect(failed.dead).toBe(true);
      expect(failed.events.map((e: any) => e.data.type)).toContain("bridge_exit");
      await vi.waitFor(() => {
        expect(() => process.kill(pid,0)).toThrow();
      }, {timeout:1000});
    } finally {await b.close();}
  });

  it("does not send a later cancellation after an explicit dialog answer", async () => {
    const b = await bridge({dialogTimeout:300});
    try {
      const waiting = b.call({type:"prompt",message:"wait-no-timeout"});
      await vi.waitFor(async () => {
        expect((await b.call({type:"events",after:0})).data.dialogs).toHaveLength(1);
      });
      expect((await b.call({type:"extension_ui_response",id:"waiter",confirmed:false})).status).toBe(200);
      expect((await waiting).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve,350));
      const events = (await b.call({type:"events",after:0})).data;
      expect(events.dialogs).toEqual([]);
      const answers = events.events.filter((e: any) => e.data.type === "dialog_answer");
      expect(answers).toHaveLength(1);
      expect(answers[0].data).toEqual({type:"dialog_answer",confirmed:false});
    } finally {await b.close();}
  });

  it.each(["\\", '"', "\u0000"])("transports a full decoded input boundary with JSON escaping (%j)", async character => {
    const b = await bridge();
    try {
      const command = {type:"prompt" as const,message:character.repeat(32768)};
      expect(validatePiCommand(command)).toBe(command);
      const response = await b.call(command);
      expect(response.status).toBe(200);
      expect(response.data.received).toBe(command.message);
      expect((await b.call({type:"abort"})).status).toBe(200);
    } finally {await b.close();}
  });

  it("terminates its actual child when the supervisor is stopped", async () => {
    const b = await bridge();
    let pid: number;
    try {pid = (await b.call({type:"get_state"})).data.pid;}
    finally {await b.close();}
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("rejects authority-bearing fields and unsupported protocol commands", () => {
    for (const command of [{type:"bash",command:"ls"}, {type:"export_html",outputPath:"/etc/passwd"},
      {type:"get_state",sessionId:"other"}, {type:"events",after:-1}, {type:"prompt",message:"a".repeat(32769)}]) {
      expect(() => validatePiCommand(command as never)).toThrow();
    }
    expect(validatePiCommand({type:"abort"})).toEqual({type:"abort"});
  });
});
