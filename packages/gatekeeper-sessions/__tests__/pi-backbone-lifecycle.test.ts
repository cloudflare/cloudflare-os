import { describe, expect, it, vi } from "vitest";
import { PI_BRIDGE_COMMAND } from "../src/pi-backbone.js";
import { piCommand } from "../src/runtime.js";

const state = vi.hoisted(() => ({sandbox: {} as any}));
vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {}, Sandbox: class {}, getSandbox: () => state.sandbox,
}));
const { CodingSessionRegistry, CodingSessionPolicy } = await import("../src/sessions.js");
const owner = {userId:"owner",email:"owner@example.test"};

function fixture(command = PI_BRIDGE_COMMAND) {
  const values = new Map<string, any>();
  const record = {id:"s",sandboxId:"box",generation:3,terminalId:"t",runtime:"pi",status:"running",repositories:["jarvis"],createdAt:new Date(),lastActiveAt:new Date()};
  values.set("session:s", record);
  const configure = vi.fn(async () => {});
  const registry = new CodingSessionRegistry() as any;
  registry.ctx = {storage:{kv:{get:(key: string) => values.get(key),put:(key: string,value: unknown) => values.set(key,value)}}};
  registry.env = {
    SESSION_SANDBOX:{idFromName:(id: string) => ({toString:() => id})},
    SESSION_POLICIES:{idFromName:(id: string) => id,get:() => ({configure})},
  };
  state.sandbox = {
    getTerminal:vi.fn(async () => ({getSnapshot:async () => ({status:"running",command})})),
    containerFetch:vi.fn(async () => new Response('{"isStreaming":false}')),
    createTerminal:vi.fn(),exec:vi.fn(),destroy:vi.fn(),
  };
  return {registry,record,values,configure,sandbox:state.sandbox};
}

function replayFixture(command: string[], status: string) {
  const f = fixture();
  const startupSucceeded = vi.fn(async () => true);
  const policy = new CodingSessionPolicy() as any;
  const values = new Map<string, any>([
    ["policy", {sessionId:"s",sandboxId:"box",generation:3,runtime:"pi",piWorkbench:true,owner,repositories:["jarvis"]}],
    ["startup", {phase:"terminal",sessionId:"s",sandboxId:"box",generation:3,runtime:"pi",attempt:0,nextRepositoryIndex:1,createdAt:Date.now(),updatedAt:Date.now()}],
  ]);
  policy.ctx = {
    id:{toString:() => "box"},
    storage:{kv:{get:(key: string) => values.get(key),put:(key: string,value: unknown) => values.set(key,value),delete:(key: string) => values.delete(key),list:() => new Map()},setAlarm:async () => {},deleteAlarm:async () => {}},
    exports:{CodingSessionRegistry:{idFromName:(id: string) => id,get:() => ({startupSucceeded})}},
  };
  policy.env = {...f.registry.env,WORKSHOP_TOOLS:{prepareSessionStartup:async () => ({plugins:[],skills:[]})}};
  f.sandbox.listTerminals = vi.fn(async () => [{id:"old",getSnapshot:async () => ({command,status,cwd:"/workspace/jarvis"})}]);
  f.sandbox.writeFile = vi.fn();
  return {f, policy, values, startupSucceeded};
}

describe("Pi generation lifecycle", () => {
  it.each([
    {status:"running",command:["/usr/local/bin/pi","--model","saved-selection"]},
    {status:"exited",command:PI_BRIDGE_COMMAND},
    {status:"exited",command:["/usr/local/bin/pi"]},
  ])("does not replace a $status primary process on startup replay ($command)", async ({status,command}) => {
    const {f, policy, values, startupSucceeded} = replayFixture(command,status);
    await policy.alarm();
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
    expect(f.sandbox.createTerminal).not.toHaveBeenCalled();
    if (status === "running") {
      expect(startupSucceeded).toHaveBeenCalledWith("s",3,"box","old");
      expect(values.has("startup")).toBe(false);
    } else {
      expect(startupSucceeded).not.toHaveBeenCalled();
      expect(values.get("startup").attempt).toBe(1);
    }
  });

  it("destroys the sandbox when startup completion loses its generation race", async () => {
    const {f, policy, values, startupSucceeded} = replayFixture(PI_BRIDGE_COMMAND,"running");
    startupSucceeded.mockResolvedValueOnce(false);
    await policy.alarm();
    expect(f.sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(values.has("startup")).toBe(false);
    expect(values.has("primary-terminal-id")).toBe(false);
  });

  it("stop destroys the Pi sandbox and invalidates an existing connection", async () => {
    const f = fixture();
    const connection = await f.registry.connectPi(owner,"s");
    await f.registry.stopSession("s");
    expect(f.sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(f.values.get("session:s").status).toBe("stopped");
    await expect(f.registry.callPi(owner,"s",connection.connectionId,{type:"get_state"})).rejects.toThrow();
    expect(f.sandbox.containerFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves the requested Pi interface through startup and replay (workbench: %s)", async piWorkbench => {
    const f = fixture();
    const startupSucceeded = vi.fn(async () => true);
    const policy = new CodingSessionPolicy() as any;
    const values = new Map<string, any>([
      ["policy", {sessionId:"s",sandboxId:"box",generation:3,runtime:"pi",owner,repositories:["jarvis"],...(piWorkbench ? {piWorkbench:true} : {})}],
    ]);
    policy.ctx = {
      id:{toString:() => "box"},
      storage:{kv:{get:(key: string) => values.get(key),put:(key: string,value: unknown) => values.set(key,value),delete:(key: string) => values.delete(key),list:() => new Map()},setAlarm:async () => {},deleteAlarm:async () => {}},
      exports:{CodingSessionRegistry:{idFromName:(id: string) => id,get:() => ({startupSucceeded})}},
    };
    policy.env = {...f.registry.env,WORKSHOP_TOOLS:{prepareSessionStartup:async () => ({plugins:[],skills:[]})}};
    const command = piWorkbench ? PI_BRIDGE_COMMAND : piCommand();
    const terminal = {id:"t",getSnapshot:async () => ({status:"running",command,cwd:"/workspace/jarvis"})};
    let terminals: typeof terminal[] = [];
    f.sandbox.listTerminals = vi.fn(async () => terminals);
    f.sandbox.writeFile = vi.fn(async () => {});
    f.sandbox.createTerminal.mockImplementation(async () => {terminals = [terminal]; return terminal;});
    const checkpoint = {phase:"terminal",sessionId:"s",sandboxId:"box",generation:3,runtime:"pi",attempt:0,nextRepositoryIndex:1,createdAt:Date.now(),updatedAt:Date.now()};
    values.set("startup", checkpoint);
    await policy.alarm();
    expect(f.sandbox.writeFile.mock.calls).toEqual(piWorkbench
      ? [["/workspace/.odie-pi/owner-bridge-v1.mjs", expect.stringContaining("--mode")]] : []);
    expect(f.sandbox.createTerminal).toHaveBeenCalledWith(expect.objectContaining({command}));
    expect(startupSucceeded).toHaveBeenCalledWith("s",3,"box","t");
    values.set("startup", checkpoint);
    await policy.alarm();
    expect(f.sandbox.createTerminal).toHaveBeenCalledTimes(1);
  });

  it("attaches and reconnects without launching a process; commands use only the fixed bridge destination", async () => {
    const f = fixture();
    const connection = await f.registry.connectPi(owner,"s");
    expect(connection.mode).toBe("rpc");
    expect(await f.registry.connectPi(owner,"s")).toEqual(connection);
    expect(await f.registry.callPi(owner,"s",connection.connectionId,{type:"get_state"})).toEqual({json:'{"isStreaming":false}'});
    expect(f.sandbox.containerFetch.mock.calls[0][0].url).toBe("http://127.0.0.1:4097/");
    expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.sandbox.createTerminal).not.toHaveBeenCalled();
  });

  it("keeps a legacy TUI terminal-only and gives Prime an explicit limitation", async () => {
    const f = fixture(["/usr/local/bin/pi"]);
    expect((await f.registry.connectPi(owner,"s")).mode).toBe("terminal");
    f.values.set("session:s",{...f.record,primeAgent:true});
    expect((await f.registry.connectPi(owner,"s")).reason).toContain("Prime");
    expect(f.sandbox.exec).not.toHaveBeenCalled();
    expect(f.sandbox.createTerminal).not.toHaveBeenCalled();
  });

  it.each(["sandbox", "generation", "terminal", "stop", "archive", "expiry", "version", "handle"])("rejects %s invalidation before dispatch", async kind => {
    const f = fixture();
    const connection = await f.registry.connectPi(owner,"s");
    const ticket = f.values.get("pi-connection:s");
    if (kind === "sandbox") f.values.set("session:s", {...f.record,sandboxId:"replacement"});
    if (kind === "generation") f.values.set("session:s", {...f.record,generation:4});
    if (kind === "terminal") f.values.set("session:s", {...f.record,terminalId:"replacement"});
    if (kind === "stop") f.values.set("session:s", {...f.record,status:"stopping"});
    if (kind === "archive") f.values.set("session:s", {...f.record,archivedAt:new Date()});
    if (kind === "expiry") ticket.expiresAt = 0;
    if (kind === "version") ticket.version = 2;
    await expect(f.registry.callPi(owner,"s",kind === "handle" ? "forged" : connection.connectionId,{type:"prompt",message:"hello"})).rejects.toThrow();
    expect(f.sandbox.containerFetch).not.toHaveBeenCalled();
  });

  it("fences policy reconfiguration and response races against stop/restart", async () => {
    const f = fixture();
    const connection = await f.registry.connectPi(owner,"s");
    f.configure.mockImplementationOnce(async () => {f.values.set("session:s", {...f.record,status:"stopping"});});
    await expect(f.registry.callPi(owner,"s",connection.connectionId,{type:"abort"})).rejects.toThrow();
    expect(f.sandbox.containerFetch).not.toHaveBeenCalled();
    f.values.set("session:s", f.record);
    f.sandbox.containerFetch.mockImplementationOnce(async () => {
      f.values.set("session:s", {...f.record,sandboxId:"replacement"});
      return new Response('{}');
    });
    await expect(f.registry.callPi(owner,"s",connection.connectionId,{type:"get_messages"})).rejects.toThrow();
  });
});
