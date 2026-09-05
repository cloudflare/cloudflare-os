import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingSessionSummary, OpenCodeUserCustomization } from "@gadgets/workshop-shared/api";
import { zstdCompressSync } from "node:zlib";

const sandboxState = vi.hoisted(() => ({ sandboxes: new Map<string, any>() }));

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class ContainerProxy {},
  Sandbox: class Sandbox {},
  getSandbox: vi.fn((_namespace: unknown, id: string) => {
    const sandbox = sandboxState.sandboxes.get(id);
    if (!sandbox) throw new Error(`Unexpected sandbox ${id}`);
    return sandbox;
  }),
}));

vi.mock("../src/github-app.js", () => ({
  mintGitHubCodingSessionToken: vi.fn(async () => ({ token: "github-token", expiresAt: Date.now() + 60_000 })),
}));

const { CodingSessionPolicy, CodingSessionRegistry, GatekeeperVendor } = await import("../src/sessions.js");
const { getSandbox } = await import("@cloudflare/sandbox");

const OPENCODE_COMMAND = [
  "/bin/bash",
  "-lc",
  "cd /workspace/jarvis && exec opencode",
];

type StoredRecord = Omit<CodingSessionSummary, "runtime"> & {
  runtime?: CodingSessionSummary["runtime"];
  primeAgent?: true;
  sandboxId: string;
  terminalId?: string;
  shellTerminalId?: string;
  opencodeServerProcessId?: string;
  opencodeServerVersion?: number;
};

function createKv() {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string): T | undefined => values.get(key) as T | undefined),
    put: vi.fn((key: string, value: unknown) => { values.set(key, value); }),
    delete: vi.fn((key: string) => values.delete(key)),
    list: vi.fn(<T,>({ prefix }: { prefix: string }): Map<string, T> =>
      new Map([...values].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>)),
    values,
  };
}

function startupRecord(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    sandboxId: "sandbox-1",
    runtime: "opencode",
    phase: "authorize",
    nextRepositoryIndex: 0,
    attempt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createPolicy() {
  const kv = createKv();
  const setAlarm = vi.fn(async () => undefined);
  const deleteAlarm = vi.fn(async () => undefined);
  const registry = { startupSucceeded: vi.fn(async () => true), startupFailed: vi.fn(() => true) };
  const namespace = { idFromName: vi.fn((name: string) => name), get: vi.fn(() => registry) };
  const tools = {
    prepareSessionStartup: vi.fn(async (): Promise<OpenCodeUserCustomization> => ({ plugins: [], skills: [] })),
  };
  const policy = new CodingSessionPolicy() as InstanceType<typeof CodingSessionPolicy> & {
    env: Record<string, unknown>;
    ctx: { storage: { kv: typeof kv; setAlarm: typeof setAlarm; deleteAlarm: typeof deleteAlarm }; id: { toString(): string }; exports: { CodingSessionRegistry: typeof namespace } };
  };
  policy.env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
    SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
    WORKSHOP_TOOLS: tools,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "key",
    GITHUB_APP_INSTALLATION_ID: "2",
  };
  policy.ctx = { storage: { kv, setAlarm, deleteAlarm }, id: { toString: () => "policy-1" }, exports: { CodingSessionRegistry: namespace } };
  kv.put("policy", {
    sessionId: "session-1",
    sandboxId: "sandbox-1",
    runtime: "opencode",
    owner: { userId: "user-1", email: "user@example.com" },
    repositories: ["jarvis"],
  });
  return { policy, kv, setAlarm, deleteAlarm, registry, tools };
}

function createRegistryWith(record: StoredRecord) {
  const kv = createKv();
  const setAlarm = vi.fn(async () => undefined);
  const deleteAlarm = vi.fn(async () => undefined);
  const transactionSync = vi.fn(<T,>(callback: () => T): T => {
    const snapshot = new Map(kv.values);
    try {
      return callback();
    } catch (error) {
      kv.values.clear();
      for (const [key, value] of snapshot) kv.values.set(key, value);
      throw error;
    }
  });
  kv.put(`session:${record.id}`, record);
  const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
    ctx: { storage: {
      kv: typeof kv; setAlarm: typeof setAlarm; deleteAlarm: typeof deleteAlarm;
      transactionSync: typeof transactionSync;
    } };
  };
  registry.ctx = { storage: { kv, setAlarm, deleteAlarm, transactionSync } };
  return { registry, kv, setAlarm, deleteAlarm, transactionSync };
}

function startingRecord(overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: "session-1",
    title: "Repair",
    repositories: ["jarvis"],
    runtime: "opencode",
    status: "starting",
    createdAt: new Date("2026-08-18T00:00:00Z"),
    lastActiveAt: new Date("2026-08-18T00:00:00Z"),
    sandboxId: "sandbox-1",
    ...overrides,
  };
}

function processHandle(id: string, state: "running" | "exited" = "exited", code = 0) {
  return {
    id,
    kill: vi.fn(async () => undefined),
    waitForPort: vi.fn(async () => undefined),
    status: vi.fn(async () => state === "running" ? { state } : { state, exit: { code, timedOut: false } }),
    waitForExit: vi.fn(async () => ({ code, timedOut: false })),
  };
}

function createStartupSandbox() {
  const processes = new Map<string, ReturnType<typeof processHandle>>();
  let ready = false;
  const terminal = {
    id: "term-primary",
    getSnapshot: vi.fn(async () => ({ id: "term-primary", command: OPENCODE_COMMAND, cwd: "/workspace/jarvis", status: "running" })),
    terminate: vi.fn(),
  };
  const sandbox = {
    configureGitHubAuth: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    getProcess: vi.fn(async (id: string) => processes.get(id) ?? null),
    listTerminals: vi.fn(async () => []),
    createTerminal: vi.fn(async () => terminal),
    exec: vi.fn(async (command: string[]) => {
      if (command[0] === "git" && command[1] === "-C") return processHandle("check", "exited", ready ? 0 : 1);
      if (command[0] === "rm") return processHandle("rm");
      if (command[0] === "sh") return processHandle("defaults");
      const clone = processHandle("clone-1", "running");
      processes.set("clone-1", clone);
      ready = true;
      return clone;
    }),
    processes,
  };
  sandboxState.sandboxes.set("sandbox-1", sandbox);
  return sandbox;
}

describe("coding session asynchronous startup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sandboxState.sandboxes.clear();
    vi.clearAllMocks();
  });

  it("accepts omitted legacy preflight but rejects an explicitly empty development selection before create", async () => {
    const kv = createKv();
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      ctx: { storage: any };
    };
    registry.ctx = { storage: {
      kv,
      setAlarm: vi.fn(async () => undefined),
      deleteAlarm: vi.fn(async () => undefined),
      transactionSync: (callback: () => unknown) => callback(),
    } };
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_CAPACITY: { getByName: () => ({ snapshot: vi.fn(async () => ({ available: true, active: 0, limit: 1 })) }) },
    };

    await expect(registry.preflightSession({ title: "Legacy", repositories: ["jarvis"] }, "user-1")).resolves.toMatchObject({
      canCreate: true,
      issues: [],
      selectedTier: "standard-1",
    });
    await expect(registry.preflightSession({
      title: "Empty", repositories: ["jarvis"], developmentStack: {},
    }, "user-1")).resolves.toMatchObject({
      canCreate: false,
      issues: [expect.objectContaining({ code: "invalid-selection" })],
    });
    await expect(registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Empty", repositories: ["jarvis"], developmentStack: {} },
    )).rejects.toThrow("Select a development profile or at least one development component.");
    expect(kv.values.size).toBe(0);
  });

  it("fails closed before writing when a development plan reaches writer-disabled mode", async () => {
    const kv = createKv();
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>; ctx: { storage: any };
    };
    registry.env = { CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "false" };
    registry.ctx = { storage: { kv } };
    vi.spyOn(registry, "preflightSession").mockResolvedValue({
      catalogRevision: 1, selection: { componentIds: ["x"] }, resolvedComponentIds: ["x"],
      selectedTier: "standard-1", capacity: { available: true, active: 0, limit: 1 },
      issues: [], canCreate: true,
    } as any);

    await expect(registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Dark", repositories: ["jarvis"], developmentStack: { componentIds: ["x"] } },
    )).rejects.toThrow("Development sessions require durable lifecycle support.");
    expect(kv.values.size).toBe(0);
  });

  it("create returns a persisted starting session before deferred startup work runs", async () => {
    const kv = createKv();
    const scheduled = vi.fn(async () => undefined);
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>;
      ctx: { storage: any };
    };
    const policy = { configure: vi.fn(), startSessionStartup: scheduled };
    const tools = { prepareSessionStartup: vi.fn() };
    registry.env = {
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
      WORKSHOP_TOOLS: tools,
    };
    registry.ctx = { storage: {
      kv, setAlarm: vi.fn(async () => undefined), deleteAlarm: vi.fn(async () => undefined),
      transactionSync: (callback: () => unknown) => callback(),
    } };

    const summary = await registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Repair", repositories: ["jarvis"] },
    );

    expect(summary.status).toBe("starting");
    expect(kv.get<StoredRecord>(`session:${summary.id}`)?.status).toBe("starting");
    expect(scheduled).toHaveBeenCalledOnce();
    expect(kv.get(`start:${summary.id}`)).toBeUndefined();
    expect(kv.get(`stop:${summary.id}`)).toBeUndefined();
    expect(tools.prepareSessionStartup).not.toHaveBeenCalled();
  });

  it("keeps legacy direct startup cleanup and emits no lifecycle operation keys when the flag is false", async () => {
    const kv = createKv();
    const destroy = vi.fn(async () => undefined);
    vi.mocked(getSandbox).mockReturnValueOnce({ destroy } as any);
    const policy = {
      configure: vi.fn(),
      startSessionStartup: vi.fn(async () => { throw new Error("alarm unavailable"); }),
    };
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>; ctx: { storage: any };
    };
    registry.env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "false",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
    };
    registry.ctx = { storage: { kv } };

    const summary = await registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Repair", repositories: ["jarvis"] },
    );

    expect(summary).toMatchObject({ status: "failed", error: "alarm unavailable" });
    expect(destroy).toHaveBeenCalledOnce();
    expect(kv.get(`start:${summary.id}`)).toBeUndefined();
    expect(kv.get(`stop:${summary.id}`)).toBeUndefined();
  });

  it("resumes configure-phase start work after persistence before scheduling", async () => {
    const kv = createKv();
    const configure = vi.fn()
      .mockRejectedValueOnce(new Error("configure unavailable"))
      .mockResolvedValue(undefined);
    const startSessionStartup = vi.fn(async () => undefined);
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>; ctx: { storage: any };
    };
    registry.env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ configure, startSessionStartup }) },
    };
    registry.ctx = { storage: {
      kv, setAlarm: vi.fn(async () => undefined), deleteAlarm: vi.fn(async () => undefined),
      transactionSync: (callback: () => unknown) => callback(),
    } };

    const summary = await registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Repair", repositories: ["jarvis"] },
    );
    expect(kv.get<any>(`start:${summary.id}`)).toMatchObject({ phase: "configure", attempts: 1 });
    expect(startSessionStartup).not.toHaveBeenCalled();

    await registry.alarm();
    expect(configure).toHaveBeenCalledTimes(2);
    expect(startSessionStartup).toHaveBeenCalledOnce();
    expect(kv.get(`start:${summary.id}`)).toBeUndefined();
  });

  it("replays schedule-phase work after a lost startup acceptance response", async () => {
    const kv = createKv();
    let accepted = false;
    const startSessionStartup = vi.fn(async () => {
      if (!accepted) {
        accepted = true;
        throw new Error("response lost");
      }
    });
    const policy = { configure: vi.fn(), startSessionStartup };
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>; ctx: { storage: any };
    };
    registry.env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
    };
    registry.ctx = { storage: {
      kv, setAlarm: vi.fn(async () => undefined), deleteAlarm: vi.fn(async () => undefined),
      transactionSync: (callback: () => unknown) => callback(),
    } };

    const summary = await registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Repair", repositories: ["jarvis"] },
    );
    expect(kv.get<any>(`start:${summary.id}`)).toMatchObject({ phase: "schedule", attempts: 1 });

    await registry.alarm();
    expect(startSessionStartup).toHaveBeenCalledTimes(2);
    expect(kv.get(`start:${summary.id}`)).toBeUndefined();
  });

  it("stores Prime sessions in a rollback-readable Pi record while exposing Prime publicly", async () => {
    const kv = createKv();
    const policy = { configure: vi.fn(), startSessionStartup: vi.fn(async () => undefined) };
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>;
      ctx: { storage: any };
    };
    registry.env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
      WORKSHOP_TOOLS: { prepareSessionStartup: vi.fn() },
      CODING_SESSION_PI_RUNTIME_ENABLED: "true",
      TEAM_PI_CODEX_BASE_URL: "https://team-pi-proxy.unison.totango.com/api/odie",
      TEAM_PI_CODEX_HMAC_SECRET: "worker-secret",
    };
    registry.ctx = { storage: {
      kv, setAlarm: vi.fn(async () => undefined), deleteAlarm: vi.fn(async () => undefined),
      transactionSync: (callback: () => unknown) => callback(),
    } };

    const summary = await registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Prime", repositories: ["jarvis"], runtime: "prime-agent" },
    );

    expect(summary.runtime).toBe("prime-agent");
    expect(kv.get<StoredRecord>(`session:${summary.id}`)).toMatchObject({
      runtime: "pi", primeAgent: true,
    });
    expect(policy.configure).toHaveBeenCalledWith(expect.objectContaining({ runtime: "prime-agent" }));
  });

  it("rolls back startup state when its alarm cannot be scheduled", async () => {
    const { policy, kv, setAlarm } = createPolicy();
    setAlarm.mockRejectedValueOnce(new Error("alarm unavailable"));

    await expect(policy.startSessionStartup(startupRecord())).rejects.toThrow("alarm unavailable");

    expect(kv.get("startup")).toBeUndefined();
  });

  it("retries and durably fences a session when startup cannot be scheduled", async () => {
    const kv = createKv();
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>;
      ctx: { storage: any };
    };
    registry.env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: {
        idFromName: (id: string) => id,
        get: () => ({
          configure: vi.fn(), cancelSessionStartup: vi.fn(async () => undefined),
          startSessionStartup: vi.fn(async () => { throw new Error("alarm unavailable"); }),
        }),
      },
    };
    registry.ctx = { storage: {
      kv,
      setAlarm: vi.fn(async () => undefined),
      deleteAlarm: vi.fn(async () => undefined),
      transactionSync: (callback: () => unknown) => callback(),
    } };

    const summary = await registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Repair", repositories: ["jarvis"] },
    );

    expect(summary).toMatchObject({ status: "starting" });
    expect(kv.get<any>(`start:${summary.id}`)).toMatchObject({ attempts: 1, phase: "schedule" });
    await registry.alarm();
    await registry.alarm();
    expect(kv.get<StoredRecord>(`session:${summary.id}`)).toMatchObject({
      status: "stopping", error: "Coding session startup could not be scheduled.",
    });
    expect(kv.get<any>(`stop:${summary.id}`)).toMatchObject({ phase: "cancel" });
  });

  it("alarm progresses through clone, materialization, and running terminal storage", async () => {
    const { policy, kv, registry, tools } = createPolicy();
    const sandbox = createStartupSandbox();
    kv.put("startup", startupRecord());

    await policy.alarm();
    expect(tools.prepareSessionStartup).toHaveBeenCalledOnce();
    expect(sandbox.configureGitHubAuth).toHaveBeenCalledOnce();
    expect(kv.get<any>("startup")?.phase).toBe("clone");

    await policy.alarm();
    expect(kv.get<any>("startup")?.cloneProcesses).toEqual([{ repositoryIndex: 0, processId: "clone-1" }]);
    sandbox.processes.set("clone-1", processHandle("clone-1", "exited", 0));
    await policy.alarm();
    expect(kv.get<any>("startup")?.phase).toBe("materialize");

    await policy.alarm();
    expect(sandbox.mkdir).toHaveBeenCalled();
    expect(kv.get<any>("startup")?.phase).toBe("terminal");

    await policy.alarm();
    expect(registry.startupSucceeded).toHaveBeenCalledWith("session-1", 0, "sandbox-1", "term-primary");
    expect(kv.get("startup")).toBeUndefined();
  });

  it("materializes OpenCode defaults once and starts OpenCode with Workshop MCP when Team PI is unconfigured", async () => {
    const { policy, kv } = createPolicy();
    const sandbox = createStartupSandbox();
    kv.put("startup", startupRecord({ phase: "materialize" }));

    await policy.alarm();

    expect(sandbox.exec).toHaveBeenCalledWith([
      "sh", "-lc",
      "if [ -d /opt/odie-valhalla/opencode ]; then " +
        "cp -R /opt/odie-valhalla/opencode/command/. /workspace/.odie-opencode/command/ && " +
        "cp -R /opt/odie-valhalla/opencode/skills/. /workspace/.odie-opencode/skills/; " +
        "fi",
    ], { timeout: 30_000 });

    await policy.alarm();

    const terminalOptions = sandbox.createTerminal.mock.calls[0]?.[0];
    expect(terminalOptions.env).toMatchObject({
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_CONFIG_DIR: "/workspace/.odie-opencode",
    });
    const config = JSON.parse(terminalOptions.env.OPENCODE_CONFIG_CONTENT);
    expect(config).toMatchObject({
      share: "disabled",
      mcp: {
        workshop: {
          type: "remote",
          url: "https://workshop-mcp.internal/mcp",
          oauth: false,
          enabled: true,
          timeout: 30_000,
        },
      },
      plugin: [],
    });
    expect(config.provider).toBeUndefined();
    expect(config.enabled_providers).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(config.small_model).toBeUndefined();
  });

  it("materializes and launches Prime Agent without exposing relay credentials", async () => {
    const { policy, kv } = createPolicy();
    const sandbox = createStartupSandbox();
    policy.env.TEAM_PI_CODEX_BASE_URL = "https://team-pi-proxy.unison.totango.com/api/odie";
    policy.env.TEAM_PI_CODEX_HMAC_SECRET = "worker-only-secret";
    kv.put("policy", {
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      runtime: "prime-agent",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["jarvis"],
    });
    kv.put("startup", startupRecord({ runtime: "prime-agent", phase: "materialize" }));

    await policy.alarm();

    expect(sandbox.mkdir).toHaveBeenCalledWith("/workspace/.odie-prime-agent", { recursive: true });
    const written = sandbox.writeFile.mock.calls.map(([file, content]) => [file, String(content)]);
    expect(written.map(([file]) => file)).toEqual([
      "/workspace/.odie-prime-agent/odie-runtime.ts",
      "/workspace/.odie-prime-agent/settings.json",
    ]);
    expect(JSON.stringify(written)).not.toContain("worker-only-secret");

    await policy.alarm();

    expect(sandbox.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.arrayContaining(["/usr/local/bin/prime-agent", "--offline"]),
      cwd: "/workspace/jarvis",
      env: expect.objectContaining({
        PRIME_AGENT_CODING_AGENT_DIR: "/workspace/.odie-prime-agent",
        PRIME_AGENT_KERNEL_PYTHON: "/opt/odie-prime-agent/kernel-venv/bin/python",
      }),
      bufferSize: 256 * 1024,
    }));
    expect(JSON.stringify(sandbox.createTerminal.mock.calls)).not.toContain("worker-only-secret");
  });

  it("enforces separate encoded and decoded Team PI Codex request limits", async () => {
    const { policy } = createPolicy();
    policy.env.TEAM_PI_CODEX_BASE_URL = "https://team-pi.example.test/api/odie";
    policy.env.TEAM_PI_CODEX_HMAC_SECRET = "worker-only-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    const identityBody = new Uint8Array(4 * 1024 * 1024 + 1);
    const identity = await policy.forwardTeamPiCodexRequest(new Request(
      "https://team-pi.example.test/api/odie/codex/responses",
      { method: "POST", body: identityBody },
    ));
    expect(identity.status).toBe(204);
    const forwardedBody = fetchMock.mock.calls[0]![1]!.body as Uint8Array;
    expect(forwardedBody.byteLength).toBe(identityBody.byteLength);

    const compressedOverflow = zstdCompressSync(new Uint8Array(8 * 1024 * 1024 + 1));
    const overflow = await policy.forwardTeamPiCodexRequest(new Request(
      "https://team-pi.example.test/api/odie/codex/responses",
      { method: "POST", body: compressedOverflow, headers: { "Content-Encoding": "zstd" } },
    ));
    expect(overflow.status).toBe(413);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects malformed or oversized compressed Team PI Codex requests", async () => {
    const { policy } = createPolicy();
    policy.env.TEAM_PI_CODEX_BASE_URL = "https://team-pi.example.test/api/odie";
    policy.env.TEAM_PI_CODEX_HMAC_SECRET = "worker-only-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const malformed = await policy.forwardTeamPiCodexRequest(new Request(
      "https://team-pi.example.test/api/odie/codex/responses",
      { method: "POST", body: "not-zstd", headers: { "Content-Encoding": "zstd" } },
    ));
    expect(malformed.status).toBe(400);

    const oversized = await policy.forwardTeamPiCodexRequest(new Request(
      "https://team-pi.example.test/api/odie/codex/responses",
      { method: "POST", body: new Uint8Array(4 * 1024 * 1024 + 1), headers: { "Content-Encoding": "zstd" } },
    ));
    expect(oversized.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records bounded startup failure after repeated alarm failures", async () => {
    const { policy, kv, registry, tools } = createPolicy();
    const sandbox = createStartupSandbox();
    tools.prepareSessionStartup.mockRejectedValue(new Error("x".repeat(800)));
    kv.put("startup", startupRecord({ attempt: 2 }));

    await policy.alarm();

    expect(registry.startupFailed).toHaveBeenCalledWith("session-1", 0, "sandbox-1", "x".repeat(500), true);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(kv.get("startup")).toBeUndefined();
  });

  it("retains startup state when final sandbox destroy is unavailable", async () => {
    const { policy, kv, registry, tools, setAlarm } = createPolicy();
    const sandbox = createStartupSandbox();
    sandbox.destroy.mockRejectedValue(new Error("destroy unavailable"));
    tools.prepareSessionStartup.mockRejectedValue(new Error("authorization failed"));
    kv.put("startup", startupRecord({ attempt: 2 }));

    await expect(policy.alarm()).resolves.toBeUndefined();

    expect(kv.get<any>("startup")).toMatchObject({ failureError: "authorization failed" });
    expect(registry.startupFailed).toHaveBeenCalledWith(
      "session-1", 0, "sandbox-1", "authorization failed", false);
    expect(setAlarm).toHaveBeenCalled();
  });

  it("continues retained failure cleanup without resuming startup phases", async () => {
    const { policy, kv, registry, tools } = createPolicy();
    const sandbox = createStartupSandbox();
    sandbox.destroy.mockRejectedValueOnce(new Error("destroy unavailable"));
    tools.prepareSessionStartup.mockRejectedValue(new Error("authorization failed"));
    kv.put("startup", startupRecord({ attempt: 2 }));
    await expect(policy.alarm()).resolves.toBeUndefined();
    tools.prepareSessionStartup.mockClear();
    registry.startupFailed.mockClear();

    await policy.alarm();

    expect(tools.prepareSessionStartup).not.toHaveBeenCalled();
    expect(registry.startupFailed).toHaveBeenCalledWith("session-1", 0, "sandbox-1", "authorization failed", true);
    expect(kv.get("startup")).toBeUndefined();
  });

  it("retains startup state when registry failure finalization is unavailable", async () => {
    const { policy, kv, registry, tools } = createPolicy();
    createStartupSandbox();
    tools.prepareSessionStartup.mockRejectedValue(new Error("authorization failed"));
    registry.startupFailed.mockRejectedValue(new Error("registry unavailable"));
    kv.put("startup", startupRecord({ attempt: 2 }));

    await expect(policy.alarm()).rejects.toThrow("registry unavailable");

    expect(kv.get("startup")).toBeDefined();
  });

  it("duplicate terminal alarm adopts one matching primary and cleans duplicates", async () => {
    const { policy, kv, registry } = createPolicy();
    const sandbox = createStartupSandbox();
    const duplicate = {
      id: "term-duplicate",
      getSnapshot: vi.fn(async () => ({ id: "term-duplicate", command: OPENCODE_COMMAND, cwd: "/workspace/jarvis", status: "running" })),
      terminate: vi.fn(),
    };
    sandbox.listTerminals.mockResolvedValue([await sandbox.createTerminal(), duplicate]);
    sandbox.createTerminal.mockClear();
    kv.put("startup", startupRecord({ phase: "terminal" }));

    await policy.alarm();

    expect(sandbox.createTerminal).not.toHaveBeenCalled();
    expect(duplicate.terminate).toHaveBeenCalledOnce();
    expect(registry.startupSucceeded).toHaveBeenCalledWith("session-1", 0, "sandbox-1", "term-primary");
  });

  it("stale successful completion is ignored and destroys the old sandbox", async () => {
    const { policy, kv, registry } = createPolicy();
    const sandbox = createStartupSandbox();
    registry.startupSucceeded.mockResolvedValue(false);
    kv.put("startup", startupRecord({ phase: "terminal" }));

    await policy.alarm();

    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(kv.get("startup")).toBeUndefined();
  });

  it("retains stale-success startup state when old sandbox destroy fails", async () => {
    const { policy, kv, registry } = createPolicy();
    const sandbox = createStartupSandbox();
    sandbox.destroy.mockRejectedValue(new Error("destroy unavailable"));
    registry.startupSucceeded.mockResolvedValue(false);
    kv.put("startup", startupRecord({ phase: "terminal" }));

    await policy.alarm();

    expect(kv.get<any>("startup")).toMatchObject({ phase: "terminal", attempt: 1 });
  });

  it("negotiates Workshop MCP initialize without claiming change notifications", async () => {
    const { policy } = createPolicy();
    const request = (protocolVersion: unknown) => policy.handleWorkshopMcpRequest(
      new Request("https://workshop-mcp.internal/mcp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion },
        }),
      }));

    const initialized = await request("2025-03-26");
    expect(initialized.headers.get("MCP-Protocol-Version")).toBeNull();
    await expect(initialized.json()).resolves.toMatchObject({
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} } },
    });
    const current = await request("2099-01-01");
    expect(current.headers.get("MCP-Protocol-Version")).toBeNull();
    await expect(current.json()).resolves.toMatchObject({
      result: { protocolVersion: "2025-06-18" },
    });
    const invalid = await request(null);
    expect(invalid.headers.get("MCP-Protocol-Version")).toBeNull();
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it("rejects an unsupported post-initialize MCP protocol version", async () => {
    const { policy } = createPolicy();
    const response = await policy.handleWorkshopMcpRequest(
      new Request("https://workshop-mcp.internal/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2099-01-01",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Unsupported MCP protocol version.");
  });

  it.each([
    ["initialize", undefined, { protocolVersion: "2025-06-18" }],
    ["tools/list", null, undefined],
    ["resources/list", undefined, undefined],
    ["resources/read", null, { uri: "ui://workshop/mcp-1/generation-a/ui%3A%2F%2Fapp" }],
    ["tools/call", null, { name: "mcp-1__read", arguments: {} }],
  ])("rejects request-only %s without a non-null id", async (method, id, params) => {
    const { policy } = createPolicy();
    const response = await policy.handleWorkshopMcpRequest(
      new Request("https://workshop-mcp.internal/mcp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }));
    await expect(response.json()).resolves.toMatchObject({
      id: null,
      error: { code: -32600 },
    });
  });

  it("passes the sandbox generation fence to Workshop MCP tool methods", async () => {
    const { policy, kv } = createPolicy();
    const tools = policy.env.WORKSHOP_TOOLS as {
      listTools: ReturnType<typeof vi.fn>;
      listResources: ReturnType<typeof vi.fn>;
      readResource: ReturnType<typeof vi.fn>;
      callTool: ReturnType<typeof vi.fn>;
      getActionResult: ReturnType<typeof vi.fn>;
    };
    tools.listTools = vi.fn(async () => []);
    tools.listResources = vi.fn(async () => []);
    tools.readResource = vi.fn(async () => ({ contents: [] }));
    tools.callTool = vi.fn(async () => ({ content: [] }));
    tools.getActionResult = vi.fn(async () => ({ content: [] }));

    await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "vendor__read", arguments: { a: 1 } } }),
    }));
    await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/list" }),
    }));
    await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/read",
        params: { uri: "ui://workshop/vendor-1/generation-a/ui%3A%2F%2Fapp" } }),
    }));
    await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workshop_action_result", arguments: { tool: "vendor__write", actionId: 7 } } }),
    }));

    const owner = kv.get<any>("policy").owner;
    expect(tools.listTools).toHaveBeenCalledWith(owner, "session-1", "sandbox-1");
    expect(tools.listResources).toHaveBeenCalledWith(owner, "session-1", "sandbox-1");
    expect(tools.readResource).toHaveBeenCalledWith(
      owner, "session-1", "ui://workshop/vendor-1/generation-a/ui%3A%2F%2Fapp", "sandbox-1");
    expect(tools.callTool).toHaveBeenCalledWith(owner, "session-1", "vendor__read", { a: 1 }, "sandbox-1");
    expect(tools.getActionResult).toHaveBeenCalledWith(owner, "session-1", "vendor__write", 7, "sandbox-1");
  });

  it("rejects Workshop MCP requests without a sandbox generation", async () => {
    const { policy, kv } = createPolicy();
    const tools = policy.env.WORKSHOP_TOOLS as { listTools: ReturnType<typeof vi.fn> };
    tools.listTools = vi.fn(async () => []);
    kv.put("policy", {
      sessionId: "session-1",
      runtime: "opencode",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["jarvis"],
    });

    const response = await policy.handleWorkshopMcpRequest(new Request("https://workshop-mcp.internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));

    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Workshop MCP sandboxId is not configured." },
    });
    expect(tools.listTools).not.toHaveBeenCalled();
  });

  it("retains terminal startup state when success finalization is unavailable", async () => {
    const { policy, kv, registry } = createPolicy();
    createStartupSandbox();
    registry.startupSucceeded.mockRejectedValue(new Error("registry unavailable"));
    kv.put("startup", startupRecord({ phase: "terminal" }));

    await policy.alarm();

    expect(kv.get<any>("startup")).toMatchObject({ phase: "terminal", attempt: 1 });
  });

  it("registry ignores old generation completion after restart, stop, or archive invalidates it", async () => {
    for (const record of [
      startingRecord({ sandboxId: "sandbox-2" }),
      startingRecord({ status: "stopped" }),
      startingRecord({ status: "stopped", archivedAt: new Date("2026-08-19T00:00:00Z") }),
    ]) {
      const { registry, kv } = createRegistryWith(record);
      await expect(registry.startupSucceeded("session-1", 0, "sandbox-1", "term-old")).resolves.toBe(false);
      expect(kv.get<StoredRecord>("session:session-1")?.terminalId).toBeUndefined();
    }
  });

  it("registry reports only the current running sandbox generation", () => {
    const { registry } = createRegistryWith(startingRecord({ status: "running", terminalId: "term-1" }));

    expect(registry.isCurrentSessionGeneration("session-1", "sandbox-1")).toBe(true);
    expect(registry.isCurrentSessionGeneration("session-1", "sandbox-old")).toBe(false);
  });

  it("expires an unconfigured token policy ticket without requiring a sandbox policy", async () => {
    const { policy, kv } = createPolicy();
    kv.delete("policy");
    await policy.storeTicket({
      sandboxId: "sandbox-1", terminalId: "terminal-1", userId: "user-1",
      sessionId: "session-1", terminalKind: "opencode", expiresAt: Date.now() - 1,
    });
    await expect(policy.alarm()).resolves.toBeUndefined();
    expect(kv.get("ticket")).toBeUndefined();
  });

  it("fails component status without component APIs when the primary terminal container is absent", async () => {
    const { policy, kv, registry } = createPolicy();
    (registry as any).developmentUpdated = vi.fn(async () => true);
    const executionSpec = {
      processes: [{ id: "service", phase: "service", argv: ["service"], cwd: "/workspace", environment: [] }],
      images: [], minimumDiskBytes: 1, requirements: { configuration: [], capabilities: [] },
      readiness: [{ processId: "service", kind: "tcp", port: 3000, timeoutMs: 10 }],
      liveness: [{ processId: "service", kind: "tcp", port: 3000, timeoutMs: 10 }],
      applications: [], logs: { maxBytes: 100, maxLines: 10 }, restart: { maxAttempts: 0, backoffMs: 0 },
      stop: { processOrder: ["service"], graceMs: 10 }, dataDisposition: "disposable", egress: [],
    } as any;
    const intent = {
      sessionId: "session-1", sandboxId: "sandbox-1", generation: 1, catalogRevision: 1,
      instanceTier: "standard-1", components: [{
        id: "api", revision: 1, title: "API", dependencyIds: [], applications: [], executionSpec,
      }],
    } as any;
    kv.put("policy", { ...kv.get<any>("policy"), generation: 1, developmentIntent: intent });
    kv.put("primary-terminal-id", "term-1");
    kv.put("development-supervision", {
      generation: 1, sandboxId: "sandbox-1", updatedAt: 1,
      components: { api: { status: "pending", processes: {}, completedJobs: [],
        logs: { cursors: {}, text: "", bytes: 0, lines: 0, truncated: false, terminals: {} }, updatedAt: 1 } },
    });
    const exec = vi.fn();
    const exists = vi.fn();
    sandboxState.sandboxes.set("sandbox-1", { listTerminals: vi.fn(async () => []), exec, exists });
    await policy.alarm();
    expect(exec).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(kv.get<any>("development-supervision").components.api).toMatchObject({ status: "failed" });
    expect(registry.developmentUpdated).toHaveBeenCalledOnce();
  });

  it("serializes paused reconcile before cleanup so no launch occurs after the cleanup fence", async () => {
    const { policy, kv, registry } = createPolicy();
    (registry as any).developmentUpdated = vi.fn(async () => true);
    const executionSpec = {
      processes: [{ id: "service", phase: "service", argv: ["service"], cwd: "/workspace", environment: [] }],
      images: [], minimumDiskBytes: 1, requirements: { configuration: [], capabilities: [] },
      readiness: [{ processId: "service", kind: "tcp", port: 3000, timeoutMs: 10 }],
      liveness: [{ processId: "service", kind: "tcp", port: 3000, timeoutMs: 10 }],
      applications: [], logs: { maxBytes: 100, maxLines: 10 }, restart: { maxAttempts: 0, backoffMs: 0 },
      stop: { processOrder: ["service"], graceMs: 10 }, dataDisposition: "disposable", egress: [],
    } as any;
    const intent = { sessionId: "session-1", sandboxId: "sandbox-1", generation: 1, catalogRevision: 1,
      instanceTier: "standard-1", components: [{ id: "api", revision: 1, title: "API", dependencyIds: [], applications: [], executionSpec }] } as any;
    kv.put("policy", { ...kv.get<any>("policy"), generation: 1, developmentIntent: intent });
    kv.put("primary-terminal-id", "term-1");
    kv.put("development-supervision", { generation: 1, sandboxId: "sandbox-1", updatedAt: 1,
      components: { api: { status: "pending", processes: {}, completedJobs: [],
        logs: { cursors: {}, text: "", bytes: 0, lines: 0, truncated: false, terminals: {} }, updatedAt: 1 } } });
    let releaseTerminals!: () => void;
    const terminalGate = new Promise<void>(resolve => { releaseTerminals = resolve; });
    const kill = vi.fn(async () => undefined);
    const process = {
      id: "process-1", pid: 1, exitCode: Promise.resolve(0),
      status: vi.fn(async () => ({ id: "process-1", pid: 1,
        command: ["/usr/bin/env", "ODIE_SUPERVISION_MARKER=g1:api:service:a0", "service"],
        cwd: "/workspace", startedAt: "0", state: "running" as const })),
      logs: vi.fn(async () => new ReadableStream({ start: controller => controller.close() })),
      waitForPort: vi.fn(async () => undefined), kill,
      waitForExit: vi.fn(async () => ({ code: 0 })),
    } as any;
    const exec = vi.fn(async () => process);
    const sandbox = {
      listTerminals: vi.fn(async () => { await terminalGate; return [{ id: "term-1" }]; }),
      exec, getProcess: vi.fn(async () => process),
      listProcesses: vi.fn(async () => [await process.status()]),
    };
    sandboxState.sandboxes.set("sandbox-1", sandbox);
    const alarm = policy.alarm();
    await Promise.resolve();
    const cleanup = policy.cleanupDevelopment("session-1", 1, "sandbox-1");
    expect(exec).not.toHaveBeenCalled();
    releaseTerminals();
    await alarm;
    await cleanup;
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.invocationCallOrder[0]).toBeLessThan(kill.mock.invocationCallOrder[0]!);
    expect(kv.get("development-supervision")).toBeUndefined();
  });

  it("ticket alarm behavior remains isolated from startup state", async () => {
    const { policy, kv } = createPolicy();
    kv.put("ticket", { expiresAt: Date.now() - 1 });
    await policy.alarm();
    expect(kv.get("ticket")).toBeUndefined();

    createStartupSandbox();
    kv.put("ticket", { expiresAt: Date.now() - 1 });
    kv.put("startup", startupRecord({ phase: "clone" }));
    await policy.alarm();
    expect(kv.get("ticket")).toBeDefined();
  });

  it("recovers from a missing clone process by cleaning the partial path and restarting clone", async () => {
    const { policy, kv } = createPolicy();
    const sandbox = createStartupSandbox();
    kv.put("startup", startupRecord({
      phase: "clone",
      nextRepositoryIndex: 1,
      cloneProcesses: [{ repositoryIndex: 0, processId: "missing" }],
      attempt: 0,
    }));

    await policy.alarm();

    expect(sandbox.getProcess).toHaveBeenCalledWith("missing");
    expect(sandbox.exec.mock.calls.some(([command]) => command[0] === "rm")).toBe(true);
    expect(kv.get<any>("startup")?.cloneProcesses).toEqual([{ repositoryIndex: 0, processId: "clone-1" }]);
  });

  it("cancels startup only for the configured session generation", async () => {
    const { policy, kv, deleteAlarm } = createPolicy();
    kv.put("startup", startupRecord());

    await policy.cancelSessionStartup("session-1", 0, "sandbox-old");
    expect(kv.get("startup")).toBeDefined();
    expect(deleteAlarm).not.toHaveBeenCalled();

    await policy.cancelSessionStartup("session-1", 0, "sandbox-1");
    expect(kv.get("startup")).toBeUndefined();
    expect(deleteAlarm).toHaveBeenCalledOnce();
  });

  it("persists a cancellation fence before configuration and rejects the delayed exact start", async () => {
    const { policy, kv } = createPolicy();
    kv.delete("policy");

    await policy.cancelSessionStartup("session-1", 1, "sandbox-1");
    policy.configure({
      sessionId: "session-1", sandboxId: "sandbox-1", generation: 1, runtime: "opencode",
      owner: { userId: "user-1", email: "user@example.com" }, repositories: ["jarvis"],
    });

    await expect(policy.startSessionStartup(startupRecord({ generation: 1 })))
      .rejects.toThrow("Coding session startup was cancelled.");
    expect(kv.get("startup")).toBeUndefined();
  });

  it("serializes an accepted start before cancellation and deletes it under the same lifecycle fence", async () => {
    const { policy, kv, setAlarm } = createPolicy();
    let releaseAlarm!: () => void;
    let enteredAlarm!: () => void;
    const alarmEntered = new Promise<void>(resolve => { enteredAlarm = resolve; });
    setAlarm.mockImplementationOnce(() => {
      enteredAlarm();
      return new Promise<void>(resolve => { releaseAlarm = resolve; });
    });

    const starting = policy.startSessionStartup(startupRecord());
    await alarmEntered;
    const canceling = policy.cancelSessionStartup("session-1", 0, "sandbox-1");
    expect(kv.get("startup")).toBeDefined();
    releaseAlarm();
    await starting;
    await canceling;

    expect(kv.get("startup")).toBeUndefined();
  });

  it("treats missing policy as no authorized development cleanup work", async () => {
    const { policy, kv } = createPolicy();
    kv.delete("policy");
    vi.mocked(getSandbox).mockClear();

    await expect(policy.cleanupDevelopment("session-1", 1, "sandbox-1")).resolves.toBeUndefined();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("backfills a missing sandbox generation on a matching legacy policy", () => {
    const { policy, kv } = createPolicy();
    kv.put("policy", {
      sessionId: "session-1",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["jarvis"],
    });

    policy.configure({
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["jarvis"],
    });

    expect(kv.get<any>("policy")?.sandboxId).toBe("sandbox-1");
  });

  it("rejects a different sandbox generation routed to the same policy object", () => {
    const { policy } = createPolicy();

    expect(() => policy.configure({
      sessionId: "session-1",
      sandboxId: "sandbox-2",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["jarvis"],
    })).toThrow("Coding session policy is immutable.");
  });

  it("does not recreate start work when stop wins an in-flight configure", async () => {
    const kv = createKv();
    let releaseConfigure!: () => void;
    let enteredConfigure!: () => void;
    const configureEntered = new Promise<void>(resolve => { enteredConfigure = resolve; });
    const configure = vi.fn(() => {
      enteredConfigure();
      return new Promise<void>(resolve => { releaseConfigure = resolve; });
    });
    const policy = {
      configure, startSessionStartup: vi.fn(), cancelSessionStartup: vi.fn(async () => undefined),
    };
    const destroy = vi.fn(async () => undefined);
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>; ctx: { storage: any };
    };
    registry.env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
    };
    registry.ctx = { storage: {
      kv, setAlarm: vi.fn(async () => undefined), deleteAlarm: vi.fn(async () => undefined),
      transactionSync: (callback: () => unknown) => callback(),
    } };

    const creating = registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Repair", repositories: ["jarvis"] },
    );
    await configureEntered;
    const [sessionKey, persisted] = [...kv.values].find(([key]) => key.startsWith("session:"))!;
    const sessionId = sessionKey.slice("session:".length);
    sandboxState.sandboxes.set((persisted as StoredRecord).sandboxId, { destroy });

    await registry.stopSession(sessionId);
    releaseConfigure();
    await expect(creating).resolves.toMatchObject({ status: "stopped" });
    expect(kv.get(`start:${sessionId}`)).toBeUndefined();
    expect(policy.startSessionStartup).not.toHaveBeenCalled();
  });

  it("atomically removes durable start work before awaiting cancellation", async () => {
    const { registry, kv } = createRegistryWith(startingRecord());
    kv.put("start:session-1", {
      sessionId: "session-1", sandboxId: "sandbox-1", generation: 0,
      owner: { userId: "user-1", email: "user@example.com" }, attempts: 0, phase: "schedule",
    });
    let releaseCancel!: () => void;
    let enteredCancel!: () => void;
    const cancelEntered = new Promise<void>(resolve => { enteredCancel = resolve; });
    const cancelSessionStartup = vi.fn(() => {
      enteredCancel();
      return new Promise<void>(resolve => { releaseCancel = resolve; });
    });
    sandboxState.sandboxes.set("sandbox-1", { destroy: vi.fn(async () => undefined) });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "false",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ cancelSessionStartup }) },
    };

    const stopping = registry.stopSession("session-1");
    await cancelEntered;
    expect(kv.get("start:session-1")).toBeUndefined();
    expect(kv.get<any>("stop:session-1")).toMatchObject({ phase: "cancel" });
    releaseCancel();
    await stopping;
  });

  it("uses legacy direct stop without lifecycle operation keys when the writer flag is false", async () => {
    const { registry, kv } = createRegistryWith(startingRecord());
    const cancelSessionStartup = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "false",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ cancelSessionStartup }) },
    };

    await registry.stopSession("session-1");

    expect(cancelSessionStartup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(kv.get("start:session-1")).toBeUndefined();
    expect(kv.get("stop:session-1")).toBeUndefined();
    expect(kv.get<any>("session:session-1")).toMatchObject({ status: "stopped" });
  });

  it("cancels durable startup before destroying a starting sandbox", async () => {
    const { registry } = createRegistryWith(startingRecord());
    const cancelSessionStartup = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: {
        idFromName: (id: string) => id,
        get: () => ({ cancelSessionStartup }),
      },
    };

    await registry.stopSession("session-1");

    expect(cancelSessionStartup).toHaveBeenCalledWith("session-1", 0, "sandbox-1");
    expect(cancelSessionStartup.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]!);
  });

  it("retains durable stop work when startup cancellation fails", async () => {
    const { registry, kv } = createRegistryWith(startingRecord());
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: {
        idFromName: (id: string) => id,
        get: () => ({ cancelSessionStartup: vi.fn(async () => { throw new Error("cancel failed"); }) }),
      },
    };

    await expect(registry.stopSession("session-1")).rejects.toThrow("cancel failed");

    expect(destroy).not.toHaveBeenCalled();
    expect(kv.get<StoredRecord>("session:session-1")).toMatchObject({ status: "stopping" });
    expect(kv.get<any>("stop:session-1")).toMatchObject({ phase: "cancel" });
  });

  it("keeps durable stop work fenced when sandbox destruction fails", async () => {
    const { registry, kv } = createRegistryWith(startingRecord({ status: "running", terminalId: "terminal-1" }));
    sandboxState.sandboxes.set("sandbox-1", {
      destroy: vi.fn(async () => { throw new Error("destroy failed"); }),
    });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ cancelSessionStartup: vi.fn() }) },
    };

    await expect(registry.stopSession("session-1")).rejects.toThrow("destroy failed");

    expect(kv.get<StoredRecord>("session:session-1")).toMatchObject({
      status: "stopping",
      terminalId: "terminal-1",
    });
    expect(kv.get<any>("stop:session-1")).toMatchObject({ phase: "destroy", sandboxId: "sandbox-1" });
  });

  it("resets retry accounting when startup advances to another phase", async () => {
    const { policy, kv } = createPolicy();
    const sandbox = createStartupSandbox();
    kv.put("startup", startupRecord({ attempt: 2 }));

    await policy.alarm();
    expect(kv.get<any>("startup")).toMatchObject({ phase: "clone", attempt: 0 });

    kv.put("startup", startupRecord({
      phase: "clone",
      nextRepositoryIndex: 1,
      completedRepositoryIndexes: [0],
      attempt: 2,
    }));
    await policy.alarm();
    expect(kv.get<any>("startup")).toMatchObject({ phase: "materialize", attempt: 0 });

    kv.put("startup", startupRecord({ phase: "materialize", attempt: 2 }));
    await policy.alarm();
    expect(sandbox.mkdir).toHaveBeenCalled();
    expect(kv.get<any>("startup")).toMatchObject({ phase: "terminal", attempt: 0 });
  });

  it("starts at most two repository clones concurrently and checkpoints their handles", async () => {
    const { policy, kv } = createPolicy();
    kv.put("policy", {
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      runtime: "opencode",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["alpha", "beta", "gamma"],
    });
    const processes = new Map<string, ReturnType<typeof processHandle>>();
    const sandbox = {
      getProcess: vi.fn(async (id: string) => processes.get(id) ?? null),
      exec: vi.fn(async (command: string[]) => {
        if (command[0] === "git" && command[1] === "-C") return processHandle("check", "exited", 1);
        if (command[0] === "rm") return processHandle("rm");
        const repository = command.at(-1)!.split("/").at(-1)!;
        const process = processHandle(`clone-${repository}`, "running");
        processes.set(process.id, process);
        return process;
      }),
    };
    sandboxState.sandboxes.set("sandbox-1", sandbox);
    kv.put("startup", startupRecord({ phase: "clone" }));

    await policy.alarm();

    expect(kv.get<any>("startup")).toMatchObject({
      nextRepositoryIndex: 2,
      cloneProcesses: [
        { repositoryIndex: 0, processId: "clone-alpha" },
        { repositoryIndex: 1, processId: "clone-beta" },
      ],
    });
    expect(sandbox.exec.mock.calls.filter(([command]) => command[0] === "git" && command[1] === "clone")).toHaveLength(2);
  });

  it("stops a running sibling clone before retrying a failed clone phase", async () => {
    const { policy, kv } = createPolicy();
    kv.put("policy", {
      sessionId: "session-1",
      sandboxId: "sandbox-1",
      runtime: "opencode",
      owner: { userId: "user-1", email: "user@example.com" },
      repositories: ["alpha", "beta"],
    });
    const failed = processHandle("clone-alpha", "exited", 1);
    const running = processHandle("clone-beta", "running");
    const processes = new Map([[failed.id, failed], [running.id, running]]);
    sandboxState.sandboxes.set("sandbox-1", {
      getProcess: vi.fn(async (id: string) => processes.get(id) ?? null),
    });
    kv.put("startup", startupRecord({
      phase: "clone",
      nextRepositoryIndex: 2,
      cloneProcesses: [
        { repositoryIndex: 0, processId: failed.id },
        { repositoryIndex: 1, processId: running.id },
      ],
    }));

    await policy.alarm();

    expect(running.kill).toHaveBeenCalledWith(15);
    expect(kv.get<any>("startup")).toMatchObject({ phase: "clone", nextRepositoryIndex: 0, attempt: 1 });
    expect(kv.get<any>("startup")?.cloneProcesses).toBeUndefined();
  });

  it("does not persist or schedule when a heavy reservation loses the admission race", async () => {
    const kv = createKv();
    const reserve = vi.fn(async () => { throw new Error("Coding session capacity is unavailable."); });
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>; ctx: { storage: { kv: typeof kv } };
    };
    registry.env = { CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true", SESSION_CAPACITY: { getByName: () => ({ reserve }) } };
    registry.ctx = { storage: { kv } };
    vi.spyOn(registry, "preflightSession").mockResolvedValue({
      catalogRevision: 1, selection: { componentIds: ["x"], requestedTier: "standard-2" },
      resolvedComponentIds: ["x"], selectedTier: "standard-2",
      capacity: { available: true, active: 0, limit: 1 }, issues: [], canCreate: true,
    });

    await expect(registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Heavy", repositories: ["jarvis"], developmentStack: { componentIds: ["x"] } },
    )).rejects.toThrow("current eligible server plan");
    expect(reserve).not.toHaveBeenCalled();
    expect([...kv.values.keys()].some(key => key.startsWith("session:"))).toBe(false);
  });

  it("activates only the exact current heavy generation after startup succeeds", async () => {
    const lease = {
      tier: "standard-2" as const, reservationId: "lease-1", sessionId: "session-1",
      generation: 1, sandboxId: "sandbox-1", userId: "user-1",
    };
    const record = startingRecord({
      generation: 1, instanceTier: "standard-2", capacityLease: lease,
      development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-2" },
    } as any);
    const { registry, kv } = createRegistryWith(record);
    const activate = vi.fn(async (key: typeof lease) => ({
      ...key, state: "active" as const, createdAt: 1, updatedAt: 2,
    }));
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_CAPACITY: { getByName: () => ({ activate }) },
    };

    await expect(registry.startupSucceeded("session-1", 0, "sandbox-1", "stale")).resolves.toBe(false);
    await expect(registry.startupSucceeded("session-1", 1, "sandbox-1", "term-1")).resolves.toBe(true);
    await expect(registry.startupSucceeded("session-1", 1, "sandbox-1", "term-1")).resolves.toBe(true);
    expect(activate).toHaveBeenCalledOnce();
    expect(kv.get<any>("session:session-1")).toMatchObject({ status: "running", terminalId: "term-1" });
  });

  it("routes a heavy stop by tier, destroys before release, and retries a failed release", async () => {
    const lease = {
      tier: "standard-3" as const, reservationId: "lease-1", sessionId: "session-1",
      generation: 1, sandboxId: "sandbox-1", userId: "user-1",
    };
    const { registry, kv } = createRegistryWith(startingRecord({
      status: "running", terminalId: "term-1", generation: 1, instanceTier: "standard-3",
      capacityLease: lease, development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-3" },
    } as any));
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    const release = vi.fn(async () => { throw new Error("capacity unavailable"); });
    const standard3 = { name: "standard-3", idFromName: (id: string) => ({ toString: () => id }) };
    const setAlarm = vi.fn(async () => undefined);
    (registry as typeof registry & { env: Record<string, unknown>; ctx: any }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { name: "standard-1" },
      SESSION_SANDBOX_STANDARD_3: standard3,
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ cancelSessionStartup: vi.fn() }) },
      SESSION_CAPACITY: { getByName: () => ({ release }) },
    };
    (registry as typeof registry & { ctx: any }).ctx.storage.setAlarm = setAlarm;

    await expect(registry.stopSession("session-1")).rejects.toThrow("capacity unavailable");
    expect(vi.mocked(getSandbox)).toHaveBeenCalledWith(standard3, "sandbox-1");
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!);
    expect(kv.get<any>("stop:session-1")).toMatchObject({ phase: "release", lease });
    expect(kv.get<any>("session:session-1")).toMatchObject({ status: "stopping", capacityLease: lease });

    release.mockResolvedValue(undefined);
    await registry.alarm();
    expect(release).toHaveBeenCalledTimes(2);
    expect(kv.get("stop:session-1")).toBeUndefined();
    expect(kv.get<any>("session:session-1")).toMatchObject({ status: "stopped", capacityLease: undefined });
  });

  it("cleans development processes before durable stop destroy and finalize", async () => {
    const { registry, kv } = createRegistryWith(startingRecord({
      status: "running", terminalId: "term-1", generation: 1,
      development: { catalogRevision: 1, componentIds: ["api"], instanceTier: "standard-1" },
    } as any));
    const cleanupDevelopment = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "false",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ cancelSessionStartup: vi.fn(), cleanupDevelopment }) },
    };
    await registry.stopSession("session-1");
    expect(cleanupDevelopment.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]!);
    expect(kv.get<any>("session:session-1")).toMatchObject({ status: "stopped", terminalId: undefined });
    expect(kv.get("stop:session-1")).toBeUndefined();
  });

  it("keeps legacy restart scheduling free of new start and stop operation keys when the flag is false", async () => {
    const { registry, kv } = createRegistryWith(startingRecord({ status: "stopped" }));
    sandboxState.sandboxes.set("sandbox-1", { destroy: vi.fn(async () => undefined) });
    const policy = { configure: vi.fn(), startSessionStartup: vi.fn(async () => undefined) };
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "false",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
    };

    await expect(registry.restartSession(
      "session-1", { userId: "user-1", email: "user@example.com" },
    )).resolves.toMatchObject({ status: "starting" });

    expect(policy.startSessionStartup).toHaveBeenCalledOnce();
    expect([...kv.values.keys()].some(key => key.startsWith("start:"))).toBe(false);
    expect([...kv.values.keys()].some(key => key.startsWith("stop:"))).toBe(false);
  });

  it("prepares replacement intent and cleans development processes before restart destroy", async () => {
    const { registry, kv } = createRegistryWith(startingRecord({
      status: "running", terminalId: "term-1", generation: 1,
      development: { catalogRevision: 1, componentIds: ["api"], instanceTier: "standard-1" },
    } as any));
    const prepareDevelopmentRestart = vi.fn(async () => undefined);
    const cleanupDevelopment = vi.fn(async () => undefined);
    const configure = vi.fn();
    const startSessionStartup = vi.fn();
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    const policy = {
      hasDevelopmentIntent: vi.fn(() => true),
      prepareDevelopmentRestart, cleanupDevelopment, configure, startSessionStartup,
    };
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
    };
    const restarted = await registry.restartSession(
      "session-1", { userId: "user-1", email: "user@example.com" },
    );
    expect(restarted.status).toBe("starting");
    expect(prepareDevelopmentRestart.mock.invocationCallOrder[0])
      .toBeLessThan(cleanupDevelopment.mock.invocationCallOrder[0]!);
    expect(cleanupDevelopment.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]!);
    expect(kv.get<any>("session:session-1")).toMatchObject({ generation: 2, status: "starting" });
  });

  it("destroys then atomically transfers a heavy lease to the next generation", async () => {
    const lease = {
      tier: "standard-4" as const, reservationId: "lease-1", sessionId: "session-1",
      generation: 1, sandboxId: "sandbox-1", userId: "user-1",
    };
    const { registry, kv } = createRegistryWith(startingRecord({
      status: "running", terminalId: "term-1", generation: 1, instanceTier: "standard-4",
      capacityLease: lease, development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-4" },
    } as any));
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    const transfer = vi.fn(async (_old: typeof lease, replacement: any) => ({
      ...lease, ...replacement, state: "reserved" as const, createdAt: 1, updatedAt: 2, expiresAt: 3,
    }));
    const policy = { configure: vi.fn(), startSessionStartup: vi.fn() };
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: {}, SESSION_SANDBOX_STANDARD_4: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_CAPACITY: { getByName: () => ({ transfer }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
    };

    const summary = await registry.restartSession("session-1", { userId: "user-1", email: "user@example.com" });
    expect(summary.status).toBe("starting");
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(transfer.mock.invocationCallOrder[0]!);
    expect(kv.get<any>("session:session-1")).toMatchObject({
      generation: 2, status: "starting", capacityLease: { tier: "standard-4", generation: 2 },
    });
    expect(policy.configure).toHaveBeenCalledWith(expect.objectContaining({ generation: 2, instanceTier: "standard-4" }));
  });


  it("routes vendor preflight capacity snapshots with the authenticated owner id", async () => {
    const preflightSession = vi.fn(async () => ({ canCreate: true }));
    const vendor = new GatekeeperVendor() as InstanceType<typeof GatekeeperVendor> & {
      ctx: { exports: { CodingSessionRegistry: unknown } };
    };
    vendor.ctx = { exports: { CodingSessionRegistry: {
      idFromName: (id: string) => id,
      get: () => ({ preflightSession }),
    } } };
    const request = { title: "Plan", repositories: ["jarvis"] } as const;

    await vendor.preflightSession({ userId: "user-7", email: "user@example.com" }, request);
    expect(preflightSession).toHaveBeenCalledWith(request, "user-7");
  });

  it("uses the heavy tier and confirms destruction before final startup failure", async () => {
    const { policy, kv, registry } = createPolicy();
    kv.put("policy", {
      sessionId: "session-1", sandboxId: "sandbox-1", generation: 1, instanceTier: "standard-2",
      runtime: "opencode", owner: { userId: "user-1", email: "user@example.com" }, repositories: ["jarvis"],
    });
    kv.put("startup", startupRecord({ generation: 1, failureError: "failed" }));
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    const standard2 = { name: "standard-2" };
    (policy as typeof policy & { env: Record<string, unknown> }).env.SESSION_SANDBOX_STANDARD_2 = standard2;

    await policy.alarm();
    expect(vi.mocked(getSandbox)).toHaveBeenCalledWith(standard2, "sandbox-1");
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(registry.startupFailed.mock.invocationCallOrder[0]!);
    expect(registry.startupFailed).toHaveBeenCalledWith("session-1", 1, "sandbox-1", "failed", true);
  });

  it("resumes both restart crash windows without losing the transferred lease", async () => {
    const lease = {
      tier: "standard-2" as const, reservationId: "old", sessionId: "session-1",
      generation: 1, sandboxId: "sandbox-1", userId: "user-1",
    };
    for (const afterTransfer of [false, true]) {
      const { registry, kv } = createRegistryWith(startingRecord({
        status: "stopping", generation: 1, instanceTier: "standard-2", capacityLease: lease,
        development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-2" },
      } as any));
      const replacement = { reservationId: "new", generation: 2, sandboxId: "sandbox-2" };
      const newLease = { ...lease, ...replacement };
      kv.put("restart:session-1", {
        sessionId: "session-1", owner: { userId: "user-1", email: "user@example.com" },
        oldSandboxId: "sandbox-1", oldGeneration: 1, instanceTier: "standard-2",
        oldLease: lease, newSandboxId: "sandbox-2", newGeneration: 2, replacement,
        ...(afterTransfer ? { newLease } : {}), phase: afterTransfer ? "schedule" : "transfer",
      });
      const transfer = vi.fn(async () => ({ ...newLease, state: "reserved" as const, createdAt: 1, updatedAt: 2 }));
      const policy = { configure: vi.fn(), startSessionStartup: vi.fn() };
      (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
        SESSION_SANDBOX: {},
        SESSION_SANDBOX_STANDARD_2: { idFromName: (id: string) => ({ toString: () => id }) },
        SESSION_CAPACITY: { getByName: () => ({ transfer }) },
        SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
      };

      await registry.alarm();
      expect(transfer).toHaveBeenCalledTimes(afterTransfer ? 0 : 1);
      expect(kv.get<any>("session:session-1")).toMatchObject({
        status: "starting", generation: 2, sandboxId: "sandbox-2",
        capacityLease: { reservationId: "new", generation: 2 },
      });
      expect(kv.get("restart:session-1")).toBeUndefined();
    }
  });


  it("arms durable restart recovery before awaiting sandbox destruction", async () => {
    const lease = {
      tier: "standard-2" as const, reservationId: "old", sessionId: "session-1",
      generation: 1, sandboxId: "sandbox-1", userId: "user-1",
    };
    const { registry, kv, setAlarm } = createRegistryWith(startingRecord({
      status: "running", generation: 1, instanceTier: "standard-2", capacityLease: lease,
      development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-2" },
    } as any));
    let finishDestroy!: () => void;
    const destroy = vi.fn(() => new Promise<void>(resolve => { finishDestroy = resolve; }));
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    const transfer = vi.fn(async (_old: typeof lease, replacement: any) => ({
      ...lease, ...replacement, state: "reserved" as const, createdAt: 1, updatedAt: 2,
    }));
    const policy = { configure: vi.fn(), startSessionStartup: vi.fn() };
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: {},
      SESSION_SANDBOX_STANDARD_2: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_CAPACITY: { getByName: () => ({ transfer }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
    };

    kv.put.mockClear();
    setAlarm.mockClear();
    const restarting = registry.restartSession("session-1", { userId: "user-1", email: "user@example.com" });
    await Promise.resolve();
    await Promise.resolve();
    expect(setAlarm).toHaveBeenCalled();
    expect(kv.put).toHaveBeenCalledWith("session:session-1", expect.objectContaining({ status: "stopping" }));
    expect(kv.put).toHaveBeenCalledWith("restart:session-1", expect.anything());
    expect(setAlarm.mock.invocationCallOrder[0]).toBeLessThan(kv.put.mock.invocationCallOrder[0]!);
    expect(destroy).toHaveBeenCalled();
    expect(setAlarm.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]!);
    expect(kv.get("restart:session-1")).toBeDefined();
    finishDestroy();
    await restarting;
  });

  it("rejects stop and archive while durable restart work exists", async () => {
    const { registry, kv } = createRegistryWith(startingRecord({ status: "stopping" }));
    kv.put("restart:session-1", { phase: "transfer" });
    await expect(registry.stopSession("session-1")).rejects.toThrow("already changing state");
    await expect(registry.archiveSession("session-1")).rejects.toThrow("already changing state");
  });

  it("does not rewind same-generation startup progress when scheduling is retried", async () => {
    const { policy, kv, setAlarm } = createPolicy();
    kv.put("startup", startupRecord({ generation: 1, phase: "clone", nextRepositoryIndex: 1 }));

    await policy.startSessionStartup(startupRecord({ generation: 1, phase: "authorize" }));

    expect(kv.get<any>("startup")).toMatchObject({ generation: 1, phase: "clone", nextRepositoryIndex: 1 });
    expect(setAlarm).toHaveBeenCalled();
  });

  it("cleans completed restart work instead of rescheduling a terminal generation", async () => {
    const { registry, kv, setAlarm, deleteAlarm } = createRegistryWith(startingRecord({
      status: "running", sandboxId: "sandbox-2", generation: 2,
      development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-1" },
    } as any));
    kv.put("restart:session-1", {
      sessionId: "session-1", owner: { userId: "user-1", email: "user@example.com" },
      oldSandboxId: "sandbox-1", oldGeneration: 1, instanceTier: "standard-1",
      newSandboxId: "sandbox-2", newGeneration: 2, phase: "schedule",
    });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {};

    await registry.alarm();

    expect(setAlarm).toHaveBeenCalled();
    expect(kv.get("restart:session-1")).toBeUndefined();
    expect(deleteAlarm).toHaveBeenCalled();
  });

  it("keeps a failed heavy reservation in stopping until confirmed destruction releases it", async () => {
    const lease = {
      tier: "standard-2" as const, reservationId: "lease-1", sessionId: "session-1",
      generation: 1, sandboxId: "sandbox-1", userId: "user-1",
    };
    const { registry, kv } = createRegistryWith(startingRecord({
      generation: 1, instanceTier: "standard-2", capacityLease: lease,
      development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-2" },
    } as any));
    await registry.startupFailed("session-1", 1, "sandbox-1", "startup failed", false);
    expect(kv.get<any>("session:session-1")).toMatchObject({ status: "stopping", capacityLease: lease });
    await expect(registry.restartSession(
      "session-1", { userId: "user-1", email: "user@example.com" },
    )).rejects.toThrow("already changing state");

    const destroy = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: {},
      SESSION_SANDBOX_STANDARD_2: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ cancelSessionStartup: vi.fn() }) },
      SESSION_CAPACITY: { getByName: () => ({ release }) },
    };
    await registry.stopSession("session-1");
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!);
    expect(kv.get<any>("session:session-1")).toMatchObject({ status: "stopped", capacityLease: undefined });
  });


  it("leaves restart metadata unchanged when the required first recovery alarm cannot be armed", async () => {
    const { registry, kv, setAlarm } = createRegistryWith(startingRecord({
      status: "running", terminalId: "term-1",
    }));
    const prior = kv.get<StoredRecord>("session:session-1");
    const destroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    setAlarm.mockRejectedValueOnce(new Error("alarm unavailable"));
    kv.put.mockClear();
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: {}, SESSION_POLICIES: {},
    };

    await expect(registry.restartSession(
      "session-1", { userId: "user-1", email: "user@example.com" },
    )).rejects.toThrow("alarm unavailable");
    expect(destroy).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.get("restart:session-1")).toBeUndefined();
    expect(kv.get("session:session-1")).toEqual(prior);
  });

  it("does no external alarm work when the required pre-arm fails", async () => {
    const lease = {
      tier: "standard-2" as const, reservationId: "lease-1", sessionId: "session-1",
      generation: 1, sandboxId: "sandbox-1", userId: "user-1",
    };
    const { registry, kv, setAlarm } = createRegistryWith(startingRecord());
    kv.put("pending-release:lease-1", lease);
    setAlarm.mockRejectedValueOnce(new Error("alarm unavailable"));
    const release = vi.fn(async () => undefined);
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_CAPACITY: { getByName: () => ({ release }) },
    };

    await expect(registry.alarm()).rejects.toThrow("alarm unavailable");
    expect(release).not.toHaveBeenCalled();
    expect(kv.get("pending-release:lease-1")).toEqual(lease);
  });

  it("rejects a fabricated executable plan before persisting generation authority", async () => {
    const kv = createKv();
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>; ctx: { storage: { kv: typeof kv } };
    };
    registry.env = { CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true" };
    registry.ctx = { storage: { kv } };
    vi.spyOn(registry, "preflightSession").mockResolvedValue({
      catalogRevision: 1, selection: { componentIds: ["x"] }, resolvedComponentIds: ["x"],
      selectedTier: "standard-2", capacity: { available: true, active: 0, limit: 1 }, issues: [], canCreate: true,
    } as any);
    await expect(registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Heavy", repositories: ["jarvis"], developmentStack: { componentIds: ["x"] } },
    )).rejects.toThrow("current eligible server plan");
    expect([...kv.values.keys()].some(key => key.startsWith("session:"))).toBe(false);
  });

  it("recovers initial standard-1 schedule and destroy failure from durable stop alarm", async () => {
    const kv = createKv();
    const setAlarm = vi.fn(async () => undefined);
    const deleteAlarm = vi.fn(async () => undefined);
    const firstDestroy = vi.fn(async () => { throw new Error("destroy unavailable"); });
    vi.mocked(getSandbox).mockReturnValueOnce({ destroy: firstDestroy } as any);
    const policy = {
      configure: vi.fn(), cancelSessionStartup: vi.fn(),
      startSessionStartup: vi.fn(async () => { throw new Error("schedule unavailable"); }),
    };
    const registry = new CodingSessionRegistry() as InstanceType<typeof CodingSessionRegistry> & {
      env: Record<string, unknown>; ctx: any;
    };
    registry.env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
    };
    registry.ctx = { storage: { kv, setAlarm, deleteAlarm, transactionSync: (callback: () => unknown) => callback() } };
    const summary = await registry.createSession(
      { userId: "user-1", email: "user@example.com" },
      { title: "Terminal", repositories: ["jarvis"] },
    );
    expect(summary.status).toBe("starting");
    await registry.alarm();
    await registry.alarm();
    expect(kv.get<any>(`stop:${summary.id}`)).toMatchObject({ phase: "cancel", instanceTier: "standard-1" });
    const retryDestroy = vi.fn(async () => undefined);
    sandboxState.sandboxes.set(summary.id, { destroy: retryDestroy });
    await registry.alarm();
    await registry.alarm();
    expect(kv.get<any>(`session:${summary.id}`)).toMatchObject({ status: "stopped" });
    expect(kv.get(`stop:${summary.id}`)).toBeUndefined();
  });

  it("retains stopping state when a starting heavy sandbox cannot be destroyed", async () => {
    const lease = {
      tier: "standard-3" as const, reservationId: "lease-1", sessionId: "session-1",
      generation: 1, sandboxId: "sandbox-1", userId: "user-1",
    };
    const { registry, kv } = createRegistryWith(startingRecord({
      generation: 1, instanceTier: "standard-3", capacityLease: lease,
      development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-3" },
    } as any));
    const destroy = vi.fn(async () => { throw new Error("destroy unavailable"); });
    sandboxState.sandboxes.set("sandbox-1", { destroy });
    const cancelSessionStartup = vi.fn(async () => undefined);
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: {},
      SESSION_SANDBOX_STANDARD_3: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ cancelSessionStartup }) },
    };

    await expect(registry.stopSession("session-1")).rejects.toThrow("destroy unavailable");
    expect(kv.get<any>("session:session-1")).toMatchObject({
      status: "stopping", capacityLease: lease,
    });
    expect(kv.get<any>("stop:session-1")).toMatchObject({ phase: "destroy" });
    await expect(registry.restartSession(
      "session-1", { userId: "user-1", email: "user@example.com" },
    )).rejects.toThrow("already changing state");
  });


  for (const tier of ["standard-1", "standard-2"] as const) {
    it(`rejects an intent-less ${tier} development restart before mutating authority`, async () => {
      const lease = tier === "standard-2" ? {
        tier, reservationId: "lease-1", sessionId: "session-1", generation: 1,
        sandboxId: "sandbox-1", userId: "user-1",
      } : undefined;
      const original = startingRecord({
        status: "running", terminalId: "term-1", generation: 1, instanceTier: tier,
        ...(lease ? { capacityLease: lease } : {}),
        development: { catalogRevision: 1, componentIds: ["api"], instanceTier: tier },
      } as any);
      const { registry, kv } = createRegistryWith(original);
      const reserve = vi.fn();
      (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
        SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
        SESSION_SANDBOX_STANDARD_2: { idFromName: (id: string) => ({ toString: () => id }) },
        SESSION_CAPACITY: { getByName: () => ({ reserve }) },
        SESSION_POLICIES: { idFromName: (id: string) => id, get: () => ({ hasDevelopmentIntent: () => false }) },
      };
      await expect(registry.restartSession(
        "session-1", { userId: "user-1", email: "user@example.com" },
      )).rejects.toThrow("requires a new session");
      expect(kv.get("session:session-1")).toEqual(original);
      expect(kv.get("restart:session-1")).toBeUndefined();
      expect(reserve).not.toHaveBeenCalled();
    });
  }

  it("atomically rolls back stopping metadata when restart work persistence fails", async () => {
    const original = startingRecord({ status: "running", terminalId: "term-1" });
    const { registry, kv, setAlarm } = createRegistryWith(original);
    kv.put.mockImplementation((key: string, value: unknown) => {
      if (key === "restart:session-1") throw new Error("restart write failed");
      kv.values.set(key, value);
    });
    (registry as typeof registry & { env: Record<string, unknown> }).env = { SESSION_SANDBOX: {} };

    await expect(registry.restartSession(
      "session-1", { userId: "user-1", email: "user@example.com" },
    )).rejects.toThrow("restart write failed");
    expect(kv.get("session:session-1")).toEqual(original);
    expect(kv.get("restart:session-1")).toBeUndefined();
    expect(setAlarm).toHaveBeenCalledOnce();
  });


  it("keeps heavy generation and capacity authority out of public session summaries", async () => {
    const lease = {
      tier: "standard-3" as const, reservationId: "secret-reservation", sessionId: "session-1",
      generation: 4, sandboxId: "secret-sandbox", userId: "secret-user",
    };
    const development = {
      catalogRevision: 7, profileId: "profile", componentIds: ["component"], instanceTier: "standard-3" as const,
    };
    const { registry } = createRegistryWith(startingRecord({
      status: "running", sandboxId: "secret-sandbox", generation: 4, instanceTier: "standard-3",
      capacityLease: lease, development,
    } as any));

    const listed = (await registry.listSessions())[0]!;
    const metadata = registry.getSessionMetadata("session-1")!;
    for (const summary of [listed, metadata]) {
      expect(summary).not.toHaveProperty("sandboxId");
      expect(summary).not.toHaveProperty("generation");
      expect(summary).not.toHaveProperty("instanceTier");
      expect(summary).not.toHaveProperty("capacityLease");
      expect(summary.development).toEqual(development);
      expect(JSON.stringify(summary)).not.toContain("secret-reservation");
      expect(JSON.stringify(summary)).not.toContain("secret-user");
    }
  });


  it("lets the vendor validate a generation-one sandbox while exact stale generation checks fail", async () => {
    const { registry } = createRegistryWith(startingRecord({
      status: "running", sandboxId: "sandbox-1", generation: 1,
      development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-1" },
    } as any));
    const vendor = new GatekeeperVendor() as InstanceType<typeof GatekeeperVendor> & {
      ctx: { exports: { CodingSessionRegistry: unknown } };
    };
    vendor.ctx = { exports: { CodingSessionRegistry: {
      idFromName: (id: string) => id,
      get: () => registry,
    } } };

    expect(await Promise.resolve(vendor.isCurrentSessionGeneration(
      { userId: "user-1", email: "user@example.com" }, "session-1", "sandbox-1",
    ))).toBe(true);
    expect(registry.isCurrentSessionGeneration("session-1", "sandbox-1", 0)).toBe(false);
    expect(registry.isCurrentSessionGeneration("session-1", "sandbox-1", 1)).toBe(true);
  });

  for (const restartStatus of ["stopped", "failed"] as const) {
    it(`reserves fresh heavy capacity when restarting a ${restartStatus} released session`, async () => {
      const { registry, kv } = createRegistryWith(startingRecord({
        status: restartStatus, generation: 1, instanceTier: "standard-2", capacityLease: undefined,
        development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-2" },
      } as any));
      const reserve = vi.fn(async (key: any) => ({
        ...key, state: "reserved" as const, createdAt: 1, updatedAt: 2, expiresAt: 3,
      }));
      const transfer = vi.fn();
      const destroy = vi.fn(async () => undefined);
      sandboxState.sandboxes.set("sandbox-1", { destroy });
      const policy = { configure: vi.fn(), startSessionStartup: vi.fn() };
      (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
        SESSION_SANDBOX: {},
        SESSION_SANDBOX_STANDARD_2: { idFromName: (id: string) => ({ toString: () => id }) },
        SESSION_CAPACITY: { getByName: () => ({ reserve, transfer }) },
        SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
      };

      const summary = await registry.restartSession(
        "session-1", { userId: "user-1", email: "user@example.com" },
      );
      expect(summary.status).toBe("starting");
      expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
        tier: "standard-2", sessionId: "session-1", generation: 2, userId: "user-1",
      }));
      expect(transfer).not.toHaveBeenCalled();
      expect(kv.get<any>("session:session-1")).toMatchObject({
        status: "starting", generation: 2,
        capacityLease: { tier: "standard-2", generation: 2, userId: "user-1" },
      });
    });
  }

  it("leaves a released heavy session exact when fresh reservation is unavailable", async () => {
    const original = startingRecord({
      status: "stopped", generation: 1, instanceTier: "standard-3", capacityLease: undefined,
      development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-3" },
    } as any);
    const { registry, kv, setAlarm } = createRegistryWith(original);
    const reserve = vi.fn(async () => { throw new Error("capacity unavailable"); });
    const destroy = vi.fn();
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_CAPACITY: { getByName: () => ({ reserve }) },
    };

    await expect(registry.restartSession(
      "session-1", { userId: "user-1", email: "user@example.com" },
    )).rejects.toThrow("capacity unavailable");
    expect(kv.get("session:session-1")).toEqual(original);
    expect(setAlarm).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  for (const failurePoint of ["pre-arm", "transaction"] as const) {
    it(`releases a fresh heavy restart reservation after ${failurePoint} failure`, async () => {
      const original = startingRecord({
        status: "stopped", generation: 1, instanceTier: "standard-4", capacityLease: undefined,
        development: { catalogRevision: 1, componentIds: [], instanceTier: "standard-4" },
      } as any);
      const { registry, kv, setAlarm } = createRegistryWith(original);
      const reserve = vi.fn(async (key: any) => ({
        ...key, state: "reserved" as const, createdAt: 1, updatedAt: 2, expiresAt: 3,
      }));
      const release = vi.fn(async () => undefined);
      const destroy = vi.fn();
      (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
        SESSION_CAPACITY: { getByName: () => ({ reserve, release }) },
      };
      if (failurePoint === "pre-arm") {
        setAlarm.mockRejectedValueOnce(new Error("alarm unavailable"));
      } else {
        kv.put.mockImplementation((key: string, value: unknown) => {
          if (key === "restart:session-1") throw new Error("restart write failed");
          kv.values.set(key, value);
        });
      }

      await expect(registry.restartSession(
        "session-1", { userId: "user-1", email: "user@example.com" },
      )).rejects.toThrow(failurePoint === "pre-arm" ? "alarm unavailable" : "restart write failed");
      expect(release).toHaveBeenCalledWith(expect.objectContaining({
        tier: "standard-4", sessionId: "session-1", generation: 2,
      }));
      expect(kv.get("session:session-1")).toEqual(original);
      expect(kv.get("restart:session-1")).toBeUndefined();
      expect(destroy).not.toHaveBeenCalled();
    });
  }


  it("rejects a stopped standard-1 restart at the active-session limit", async () => {
    const original = startingRecord({ status: "stopped" });
    const { registry, kv, setAlarm } = createRegistryWith(original);
    for (let index = 0; index < 5; index++) {
      const active = startingRecord({
        id: `active-${index}`, sandboxId: `sandbox-${index}`, status: "running", terminalId: `term-${index}`,
      });
      kv.put(`session:${active.id}`, active);
    }
    (registry as typeof registry & { env: Record<string, unknown> }).env = {};

    await expect(registry.restartSession(
      "session-1", { userId: "user-1", email: "user@example.com" },
    )).rejects.toThrow("at most 5 active coding sessions");
    expect(setAlarm).not.toHaveBeenCalled();
    expect(kv.get("session:session-1")).toEqual(original);
  });

  it("rechecks the active-session limit after awaiting the restart alarm", async () => {
    const original = startingRecord({ status: "stopped" });
    const { registry, kv, setAlarm } = createRegistryWith(original);
    for (let index = 0; index < 4; index++) {
      const active = startingRecord({
        id: `active-${index}`, sandboxId: `sandbox-${index}`, status: "running", terminalId: `term-${index}`,
      });
      kv.put(`session:${active.id}`, active);
    }
    let finishAlarm!: () => void;
    setAlarm.mockImplementationOnce(() => new Promise<void>(resolve => { finishAlarm = resolve; }));
    const destroy = vi.fn();
    (registry as typeof registry & { env: Record<string, unknown> }).env = { SESSION_SANDBOX: {} };

    const restarting = registry.restartSession(
      "session-1", { userId: "user-1", email: "user@example.com" },
    );
    while (!setAlarm.mock.calls.length) await Promise.resolve();
    const raced = startingRecord({
      id: "active-race", sandboxId: "sandbox-race", status: "running", terminalId: "term-race",
    });
    kv.put(`session:${raced.id}`, raced);
    finishAlarm();

    await expect(restarting).rejects.toThrow("at most 5 active coding sessions");
    expect(destroy).not.toHaveBeenCalled();
    expect(kv.get("session:session-1")).toEqual(original);
    expect(kv.get("restart:session-1")).toBeUndefined();
  });


  it("atomically admits only one of two stopped restarts at the remaining active slot", async () => {
    const sessionA = startingRecord({ id: "session-a", sandboxId: "old-a", status: "stopped" });
    const sessionB = startingRecord({ id: "session-b", sandboxId: "old-b", status: "stopped" });
    const { registry, kv, setAlarm } = createRegistryWith(sessionA);
    kv.put("session:session-b", sessionB);
    for (let index = 0; index < 4; index++) {
      const active = startingRecord({
        id: `active-${index}`, sandboxId: `active-sandbox-${index}`,
        status: "running", terminalId: `term-${index}`,
      });
      kv.put(`session:${active.id}`, active);
    }
    sandboxState.sandboxes.set("old-a", { destroy: vi.fn(async () => undefined) });
    sandboxState.sandboxes.set("old-b", { destroy: vi.fn(async () => undefined) });
    const policy = { configure: vi.fn(), startSessionStartup: vi.fn() };
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      CODING_SESSION_DURABLE_LIFECYCLE_ENABLED: "true",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
    };
    const finishAlarms: Array<() => void> = [];
    setAlarm.mockImplementation(() => {
      if (finishAlarms.length >= 2) return Promise.resolve();
      return new Promise<void>(resolve => { finishAlarms.push(resolve); });
    });
    const owner = { userId: "user-1", email: "user@example.com" };

    const restartA = registry.restartSession("session-a", owner);
    const restartB = registry.restartSession("session-b", owner);
    while (finishAlarms.length < 2) await Promise.resolve();
    finishAlarms[0]!();
    while (kv.get<any>("session:session-a")?.status === "stopped") await Promise.resolve();
    finishAlarms[1]!();

    await expect(restartA).resolves.toMatchObject({ id: "session-a", status: "starting" });
    await expect(restartB).rejects.toThrow("at most 5 active coding sessions");
    expect(kv.get("session:session-b")).toEqual(sessionB);
    expect(kv.get("restart:session-b")).toBeUndefined();
  });


  it("persists generation-fenced component failure without changing the running terminal", () => {
    const running = startingRecord({ status: "running", terminalId: "terminal-1", generation: 2,
      development: { catalogRevision: 1, componentIds: ["api"], instanceTier: "standard-1" } } as any);
    const { registry, kv } = createRegistryWith(running);
    const update = {
      sessionId: "session-1", sandboxId: "sandbox-1", generation: 2,
      components: [{ id: "api", title: "API", status: "failed" as const,
        message: "Service failed.", updatedAt: new Date(10) }],
      applications: [{ id: "app", componentId: "api", title: "App", status: "failed" as const,
        message: "Service failed.", previewAvailable: false as const }],
    };
    expect(registry.developmentUpdated(update)).toBe(true);
    expect(registry.getDevelopmentStatus("session-1")).toMatchObject({ generation: 2, components: [{ status: "failed" }] });
    const publicJson = JSON.stringify(registry.getDevelopmentStatus("session-1"));
    for (const internal of ["sandboxId", "diagnostics", "executionSpec", "processId", "argv", "environment"]) {
      expect(publicJson).not.toContain(internal);
    }
    expect(kv.get<any>("session:session-1")).toMatchObject({ status: "running", terminalId: "terminal-1" });

    expect(registry.developmentUpdated({ ...update, sandboxId: "old", generation: 1 })).toBe(false);
    expect(registry.getDevelopmentStatus("session-1").generation).toBe(2);
  });

  it("starts and reuses one OpenCode server per running OpenCode generation with startup env parity", async () => {
    const running = startingRecord({ status: "running", terminalId: "term-primary", generation: 3 });
    const { registry, kv } = createRegistryWith(running);
    const policy = { configure: vi.fn(), storeOpenCodeTicket: vi.fn() };
    const customization: OpenCodeUserCustomization = {
      plugins: ["@acme/opencode-plugin@1.2.3"],
      skills: [{ name: "repair", description: "Fix things", instructions: "Always verify." }],
    };
    const tools = { prepareSessionStartup: vi.fn(async () => customization) };
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      BASE_URL: "https://workshop.example.test/gatekeeper/sessions",
      EDITOR_CAPABILITY_HMAC_SECRET: "editor-test-secret",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
      WORKSHOP_TOOLS: tools,
      TEAM_PI_CODEX_BASE_URL: "https://team-pi.example.test/",
    };
    const process = processHandle("opencode-server-1", "running");
    const sandbox = {
      getTerminal: vi.fn(async () => ({ getSnapshot: vi.fn(async () => ({ status: "running" })) })),
      getProcess: vi.fn(async (id: string) => id === process.id ? process : null),
      exec: vi.fn(async () => process),
      destroy: vi.fn(async () => undefined),
    };
    sandboxState.sandboxes.set("sandbox-1", sandbox);
    const owner = { userId: "user-1", email: "user@example.com" };

    const [first, second] = await Promise.all([
      registry.mintOpenCodeCapability(owner, "session-1"),
      registry.mintOpenCodeCapability(owner, "session-1"),
    ]);

    expect(first.url).toMatch(/^https:\/\/workshop\.example\.test\/gatekeeper\/sessions\/opencode\//);
    expect(second.url).toMatch(/^https:\/\/workshop\.example\.test\/gatekeeper\/sessions\/opencode\//);
    expect(sandbox.exec).toHaveBeenCalledOnce();
    expect(sandbox.exec).toHaveBeenCalledWith([
      "opencode", "serve", "--hostname", "0.0.0.0", "--port", "40913", "--mdns", "false",
    ], expect.objectContaining({
      cwd: "/workspace/jarvis",
      env: expect.objectContaining({
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_CONFIG_DIR: "/workspace/.odie-opencode",
      }),
    }));
    const env = sandbox.exec.mock.calls[0]![1]!.env as Record<string, string>;
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      model: "openai/gpt-6-astra",
      small_model: "openai/gpt-6-astra",
      plugin: customization.plugins,
      mcp: { workshop: { enabled: true } },
      provider: { openai: { models: { "gpt-6-astra": {
        name: "GPT-6 Astra",
        limit: { context: 1_050_000, output: 128_000 },
        cost: {
          input: 10,
          output: 50,
          cache_read: 1,
          cache_write: 12.5,
        },
      }, "gpt-5.6-sol": {
        name: "GPT 5.6 Sol",
        limit: { context: 1_050_000, output: 128_000 },
      } } } },
    });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider.openai.models["gpt-6-astra"].cost)
      .not.toHaveProperty("context_over_200k");
    expect(process.waitForPort).toHaveBeenCalledWith(40_913, expect.objectContaining({ path: "/global/health" }));
    expect(tools.prepareSessionStartup).toHaveBeenCalledTimes(2);
    expect(policy.storeOpenCodeTicket).toHaveBeenCalledTimes(2);
    expect(kv.get<StoredRecord>("session:session-1")?.opencodeServerProcessId).toBe("opencode-server-1");
    expect(kv.get<StoredRecord>("session:session-1")?.opencodeServerVersion).toBe(1);

    await registry.mintOpenCodeCapability(owner, "session-1");
    expect(sandbox.exec).toHaveBeenCalledOnce();

    const current = kv.get<StoredRecord>("session:session-1")!;
    kv.put("session:session-1", { ...current, opencodeServerVersion: undefined });
    await registry.mintOpenCodeCapability(owner, "session-1");
    expect(process.kill).toHaveBeenCalledWith(15);
    expect(sandbox.exec).toHaveBeenCalledTimes(2);

    const migrated = kv.get<StoredRecord>("session:session-1")!;
    kv.put("session:session-1", { ...migrated, opencodeServerVersion: undefined });
    process.waitForExit.mockResolvedValue({ code: 0, timedOut: true });
    await expect(registry.mintOpenCodeCapability(owner, "session-1"))
      .rejects.toThrow("OpenCode server failed to stop. Restart the session to continue.");
    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
    expect(kv.get<StoredRecord>("session:session-1")).toMatchObject({
      status: "failed",
      opencodeServerProcessId: undefined,
      opencodeServerVersion: undefined,
    });
  });

  it("stops a freshly-created OpenCode server when the session generation goes stale", async () => {
    const running = startingRecord({ status: "running", terminalId: "term-primary", generation: 1 });
    const { registry, kv } = createRegistryWith(running);
    const policy = { configure: vi.fn(), storeOpenCodeTicket: vi.fn() };
    (registry as typeof registry & { env: Record<string, unknown> }).env = {
      BASE_URL: "https://workshop.example.test",
      EDITOR_CAPABILITY_HMAC_SECRET: "editor-test-secret",
      SESSION_SANDBOX: { idFromName: (id: string) => ({ toString: () => id }) },
      SESSION_POLICIES: { idFromName: (id: string) => id, get: () => policy },
      WORKSHOP_TOOLS: { prepareSessionStartup: vi.fn(async () => ({ plugins: [], skills: [] })) },
    };
    const process = processHandle("opencode-server-stale", "running");
    process.waitForPort.mockImplementation(async () => {
      kv.put("session:session-1", { ...running, generation: 2, sandboxId: "sandbox-2" });
    });
    sandboxState.sandboxes.set("sandbox-1", {
      getTerminal: vi.fn(async () => ({ getSnapshot: vi.fn(async () => ({ status: "running" })) })),
      getProcess: vi.fn(async () => process),
      exec: vi.fn(async () => process),
      destroy: vi.fn(async () => undefined),
    });

    await expect(registry.mintOpenCodeCapability(
      { userId: "user-1", email: "user@example.com" }, "session-1",
    )).rejects.toThrow("Coding session is not running.");
    expect(process.kill.mock.calls).toEqual([[15]]);
    expect(policy.storeOpenCodeTicket).not.toHaveBeenCalled();
  });

  it("deletes expired OpenCode capability tickets on the policy alarm", async () => {
    const { policy, kv, deleteAlarm } = createPolicy();
    const expiresAt = Date.now() + 1_000;
    await policy.storeOpenCodeTicket({
      sandboxId: "sandbox-1",
      userId: "user-1",
      sessionId: "session-1",
      generation: 0,
      instanceTier: "standard-1",
      expiresAt,
    });

    const now = vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    await policy.alarm();

    expect(kv.get("opencodeTicket")).toBeUndefined();
    expect(deleteAlarm).toHaveBeenCalled();
    now.mockRestore();
  });

});
