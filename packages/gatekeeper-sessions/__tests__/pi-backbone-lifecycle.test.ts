import { afterEach, describe, expect, it, vi } from "vitest";
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
    containerFetch:vi.fn(async (url: unknown, init: RequestInit, port: number) => {
      // Simulate the normal RPC serialization boundary before receiver-side Request construction.
      if (typeof url !== "string" || Object.getPrototypeOf(init) !== Object.prototype || "signal" in init) {
        throw new TypeError("Request and AbortSignal cannot cross normal RPC");
      }
      const request = new Request(url, JSON.parse(JSON.stringify(init)));
      expect(new URL(request.url).port).toBe(String(port));
      return new Response('{"isStreaming":false}');
    }),
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
  afterEach(() => vi.useRealTimers());
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
    expect(f.sandbox.containerFetch).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:4097/", {method:"POST",body:'{"type":"get_state"}',redirect:"manual"}, 4097,
    );
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

  it.each(["sandbox", "generation", "terminal", "runtime", "stop", "archive", "expiry", "version", "handle"])("rejects %s invalidation before dispatch", async kind => {
    const f = fixture();
    const connection = await f.registry.connectPi(owner,"s");
    const ticket = f.values.get("pi-connection:s");
    if (kind === "sandbox") f.values.set("session:s", {...f.record,sandboxId:"replacement"});
    if (kind === "generation") f.values.set("session:s", {...f.record,generation:4});
    if (kind === "terminal") f.values.set("session:s", {...f.record,terminalId:"replacement"});
    if (kind === "runtime") f.values.set("session:s", {...f.record,runtime:"opencode"});
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

  it("reauthorizes the owner and repositories and does not dispatch after authorization fails", async () => {
    const f = fixture();
    const connection = await f.registry.connectPi(owner,"s");
    f.configure.mockClear();
    f.configure.mockRejectedValueOnce(new Error("repository access revoked"));
    await expect(f.registry.callPi(owner,"s",connection.connectionId,{type:"prompt",message:"hello"})).rejects.toThrow("repository access revoked");
    expect(f.configure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId:"s",sandboxId:"box",generation:3,owner,repositories:["jarvis"],
    }));
    expect(f.sandbox.containerFetch).not.toHaveBeenCalled();
  });

  it.each(["resolve", "resolve with stalled cancel", "reject"])("bounds a stalled fetch and ignores its late %s without activity or retries", async settlement => {
    vi.useFakeTimers();
    const f = fixture();
    f.record.lastActiveAt = new Date(Date.now() - 60_000);
    const connection = await f.registry.connectPi(owner,"s");
    const fetch = Promise.withResolvers<Response>();
    f.sandbox.containerFetch.mockReturnValueOnce(fetch.promise);
    const call = f.registry.callPi(owner,"s",connection.connectionId,{type:"prompt",message:"hello"});
    const settled = vi.fn();
    void call.then(settled, settled);
    const rejected = expect(call).rejects.toThrow("outcome unknown. Do not retry writes automatically.");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).not.toHaveBeenCalled();
    expect(f.sandbox.containerFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    const cancel = vi.fn(() => settlement === "resolve with stalled cancel"
      ? new Promise<void>(() => {}) : Promise.reject(new Error("late cancel failed")));
    if (settlement !== "reject") fetch.resolve(new Response(new ReadableStream({cancel})));
    else fetch.reject(new Error("late fetch failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(settlement === "reject" ? 0 : 1);
    expect(f.values.get("session:s")).toBe(f.record);
    expect(f.sandbox.containerFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stall", "reject"])("uses one fetch/body deadline and releases the active reader even when cancel will %s", async cleanup => {
    vi.useFakeTimers();
    const f = fixture();
    f.record.lastActiveAt = new Date(Date.now() - 60_000);
    const connection = await f.registry.connectPi(owner,"s");
    const fetch = Promise.withResolvers<Response>();
    const cancel = vi.fn(() => cleanup === "stall" ? new Promise<void>(() => {}) : Promise.reject(new Error("cancel failed")));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); },
      cancel,
    });
    f.sandbox.containerFetch.mockReturnValueOnce(fetch.promise);
    const call = f.registry.callPi(owner,"s",connection.connectionId,{type:"get_state"});
    const rejected = expect(call).rejects.toThrow("outcome unknown. Do not retry writes automatically.");
    await vi.advanceTimersByTimeAsync(20_000);
    fetch.resolve(new Response(body));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(body.locked).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(f.values.get("session:s")).toBe(f.record);
    expect(f.sandbox.containerFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["http", "redirect", "json", "oversize", "read", "fetch"])("rejects %s failure without activity or retries and clears the deadline", async failure => {
    vi.useFakeTimers();
    const f = fixture();
    f.record.lastActiveAt = new Date(Date.now() - 60_000);
    const connection = await f.registry.connectPi(owner,"s");
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (failure === "read") controller.error(new Error("read failed"));
        else controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    if (failure === "fetch") f.sandbox.containerFetch.mockRejectedValueOnce(new Error("fetch failed"));
    else f.sandbox.containerFetch.mockResolvedValueOnce(failure === "oversize" || failure === "read"
      ? new Response(body)
      : new Response(failure === "json" ? "not json" : "{}", {
        status:failure === "http" ? 500 : 200,
        headers:failure === "redirect" ? {Location:"https://elsewhere.test"} : {},
      }));
    await expect(f.registry.callPi(owner,"s",connection.connectionId,{type:"get_state"})).rejects.toThrow();
    if (failure === "oversize") expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(f.values.get("session:s")).toBe(f.record);
    expect(f.sandbox.containerFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["generation", "runtime", "expiry"])("rechecks %s after the entire body is consumed", async fence => {
    const f = fixture();
    f.record.lastActiveAt = new Date(Date.now() - 60_000);
    const connection = await f.registry.connectPi(owner,"s");
    f.sandbox.containerFetch.mockResolvedValueOnce(new Response(new ReadableStream({
      pull(controller) {
        if (fence === "expiry") f.values.get("pi-connection:s").expiresAt = 0;
        else f.values.set("session:s", {...f.record,...(fence === "generation" ? {generation:4} : {runtime:"opencode"})});
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }, {highWaterMark:0})));
    await expect(f.registry.callPi(owner,"s",connection.connectionId,{type:"get_state"})).rejects.toThrow();
    expect(f.values.get("session:s").lastActiveAt).toEqual(f.record.lastActiveAt);
    expect(f.sandbox.containerFetch).toHaveBeenCalledTimes(1);
  });

  it("updates activity only after a complete valid success and clears the deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.record.lastActiveAt = new Date(Date.now() - 60_000);
    const connection = await f.registry.connectPi(owner,"s");
    await expect(f.registry.callPi(owner,"s",connection.connectionId,{type:"get_state"})).resolves.toEqual({json:'{"isStreaming":false}'});
    expect(f.values.get("session:s").lastActiveAt).toEqual(new Date());
    expect(vi.getTimerCount()).toBe(0);
  });
});
