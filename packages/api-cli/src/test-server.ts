// An in-process Cap'n Web server for the `cf-os api` suites. It serves the generator fixture's API
// (the one `generator/__fixtures__/generated/schema.json` describes, from the extractor fixture
// `packages/api-schema/__tests__/__fixtures__/api.ts` before its format additions, with a method
// whose argument holds secrets, one that reports the id of what it creates, and the `sketch`
// gatekeeper app UI `getPanel` reaches) and, for
// `open-workspace`, a sliver of the real API, as `RpcTarget`s that record every call and every
// disposal, served over a MessageChannel through the session factory the runtime takes. Test
// support only; not part of the build.

import { setImmediate as nextTurn } from "node:timers/promises";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import type { Remote, OpenConnection } from "./session.ts";

/** What the server saw. */
export interface ServerLog {
  /** Calls, as `Target.method` and the arguments received. */
  calls: { method: string; args: unknown[] }[];
  /** Targets whose `Symbol.dispose` ran, by name. */
  disposed: string[];
  /** Headers each connection was opened with. */
  headers: Record<string, string>[];
  /** Messages the client posted, in order: what had been sent when a server method ran. */
  sent: string[];
}

/** The log entry for calls of `method`. */
export function callsOf(log: ServerLog, method: string): unknown[][] {
  return log.calls.filter((call) => call.method === method).map((call) => call.args);
}

/** Waits until `ready()` holds, failing after five seconds: disposal crosses the channel asynchronously. */
export async function eventually(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await nextTurn();
  }
}

/** A disposable, named handle: the `RpcStub<{}>` a subscription or `lock` returns. */
class Handle extends RpcTarget {
  readonly #name: string;
  readonly #log: ServerLog;
  constructor(name: string, log: ServerLog) {
    super();
    this.#name = name;
    this.#log = log;
  }
  [Symbol.dispose](): void {
    this.#log.disposed.push(this.#name);
  }
}

/** The stored note the fixture hands out: one of every type JSON lacks. */
export function sampleNote(): Record<string, unknown> {
  return {
    id: 1,
    title: "First",
    created: new Date("2026-01-02T03:04:05.000Z"),
    size: 12345678901234567890n,
    body: new Uint8Array([1, 2, 3]),
    tags: ["a"],
    missing: undefined,
  };
}

/** Knobs for the fixture's behaviour. */
export interface FixtureOptions {
  /** What `login` accepts: the username and hash bytes (hex). */
  login?: { username: string; hashHex: string };
  /** `getAdmin` returns null. */
  noAdmin?: boolean;
  /** `getFrame` returns null. */
  noFrame?: boolean;
  /** `setMood` never returns. */
  hang?: boolean;
  /**
   * The accounts `createAccount` made, username to hash bytes (hex), which `login` accepts too. Made
   * on first use and kept here, so every connection served with the same options shares them.
   */
  accounts?: Map<string, string>;
  /** `createAccount` refuses, as the backend's does with signups closed. */
  signupsClosed?: boolean;
}

/** The fixture API's root, `FixturePublicApi`. */
export function fixtureRoot(log: ServerLog, options: FixtureOptions = {}): RpcTarget {
  const record = (method: string, args: unknown[]) => log.calls.push({ method, args });
  const accounts = options.accounts ??= new Map();

  class Admin extends RpcTarget {
    setBanner(text: string): void {
      record("setBanner", [text]);
      throw new Error(`banner refused: ${text}`);
    }
    [Symbol.dispose](): void {
      log.disposed.push("admin");
    }
  }

  class Untyped extends RpcTarget {
    echo(...args: unknown[]): unknown[] {
      record("echo", args);
      return args;
    }
    [Symbol.dispose](): void {
      log.disposed.push("untyped");
    }
  }

  /** The `sketch` app UI (`app-sketch.schema.json`), whichever `kind` getPanel was given. */
  class Sketch extends RpcTarget {
    draw(...args: unknown[]): unknown {
      record("draw", args);
      return args[1] ?? { text: "drawn" };
    }
    pick(...args: unknown[]): void {
      record("pick", args);
    }
    clear(): void {
      record("clear", []);
    }
    [Symbol.dispose](): void {
      log.disposed.push("sketch");
    }
  }

  class Notebook extends RpcTarget {
    readonly #id: string;
    constructor(id: string) {
      super();
      this.#id = id;
    }
    file(...args: unknown[]): void {
      record("file", args);
    }
    subscribe(subscriber: Remote, ...rest: unknown[]): Handle {
      record("subscribe", rest);
      // A callback outlives the call only as a duplicate, as the backend's subscribers are kept.
      const kept = subscriber.dup();
      void (async () => {
        await kept.added(sampleNote());
        await kept.removed(7);
        await kept.ready();
      })().catch((error: unknown) => record("subscriberFailed", [(error as Error).message]));
      return new Handle("subscription", log);
    }
    watchTitle(callback: Remote): Handle {
      const kept = callback.dup();
      void Promise.resolve(kept(`title of ${this.#id}`)).catch(() => {});
      return new Handle("watch", log);
    }
    lock(): Handle {
      record("lock", []);
      return new Handle("lock", log);
    }
    connect(): Untyped {
      return new Untyped();
    }
    upload(...args: unknown[]): void {
      record("upload", args);
    }
    outline(): unknown {
      record("outline", [this.#id]);
      return { title: this.#id, children: [{ title: "child", children: [] }] };
    }
    [Symbol.dispose](): void {
      log.disposed.push("notebook");
    }
  }

  class Authed extends RpcTarget {
    newNotebook(): Notebook {
      record("newNotebook", []);
      return new Notebook("made");
    }
    openNotebook(...args: unknown[]): Notebook {
      record("openNotebook", [...args, log.sent.some((message) => message.includes('"outline"'))]);
      return new Notebook(args[0] as string);
    }
    getAdmin(): Admin | null {
      return options.noAdmin ? null : new Admin();
    }
    // Each records whether the call on its capability had already been sent: a property hop
    // pipelines on the result, as a capability hop does.
    getFrame(): { html: string; ui: Untyped } | null {
      record("getFrame", [log.sent.some((message) => message.includes('"echo"'))]);
      return options.noFrame ? null : { html: "<p>frame</p>", ui: new Untyped() };
    }
    getPanel(kind: string): { html: string; ui: Sketch } {
      record("getPanel", [kind, log.sent.some((message) => message.includes('"draw"'))]);
      return { html: "<p>panel</p>", ui: new Sketch() };
    }
    getNotebookRef(): { id: string; notebook: Notebook } {
      record("getNotebookRef", [log.sent.some((message) => message.includes('"outline"'))]);
      return { id: "ref", notebook: new Notebook("ref") };
    }
    getPhoto(id: string): Uint8Array | null {
      record("getPhoto", [id]);
      return id === "none" ? null : new TextEncoder().encode(`photo ${id}`);
    }
    async importArchive(archive: ReadableStream<Uint8Array>): Promise<string> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of archive) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    }
    findNotes(...args: unknown[]): unknown[] {
      record("findNotes", args);
      return [{ id: 1, title: String(args[0]) }];
    }
    setMood(mood: string): Promise<void> | void {
      record("setMood", [mood]);
      if (options.hang) return new Promise(() => {});
    }
    setNickname(name: string | null): void {
      record("setNickname", [name]);
    }
    addRemote(remote: unknown): void {
      record("addRemote", [remote]);
    }
    [Symbol.dispose](): void {
      log.disposed.push("authed");
    }
  }

  class Root extends RpcTarget {
    ping(): void {
      record("ping", []);
    }
    authenticate(token: string): Authed {
      record("authenticate", [token]);
      if (token !== "good-token") throw new Error("invalid token");
      return new Authed();
    }
    authenticateFromCfAccess(): Authed {
      record("authenticateFromCfAccess", []);
      return new Authed();
    }
    login(username: string, hash: Uint8Array): string | null {
      record("login", [username, Buffer.from(hash).toString("hex")]);
      const expected = options.login;
      const hashHex = Buffer.from(hash).toString("hex");
      return (expected && expected.username === username && expected.hashHex === hashHex) || accounts.get(username) === hashHex
        ? "good-token"
        : null;
    }
    // Not in the fixture schema: `cf-os api create-account` calls it by name, as it calls the real one.
    createAccount(username: string, displayName: string, hash: Uint8Array): string | null {
      const hashHex = Buffer.from(hash).toString("hex");
      record("createAccount", [username, displayName, hashHex]);
      if (options.signupsClosed) throw new Error("New signups are currently disabled on this deployment.");
      if (accounts.has(username)) return null;
      accounts.set(username, hashHex);
      return `${username}:session-token`;
    }
    download(id: number): ReadableStream<Uint8Array> {
      record("download", [id]);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`note ${id}\n`));
          controller.enqueue(new TextEncoder().encode("second chunk\n"));
          controller.close();
        },
      });
    }
    [Symbol.dispose](): void {
      log.disposed.push("root");
    }
  }

  return new Root();
}

/** Knobs for {@link workshopRoot}'s `openWorkspace`. */
export interface WorkshopOptions {
  /** What openWorkspace asks configureObservers for. Without it, it asks nothing, as for the owner. */
  needs?: Record<string, unknown>[];
  /**
   * Ask a second time after a valid first answer, each need carrying a `failure`, as the overseer
   * re-asks for bindings that failed verification.
   */
  reask?: boolean;
}

/**
 * A sliver of the real API's root (`PublicApi`), served with the real table: `authenticate`, then
 * `openWorkspace`, which asks its `configureObservers` callback for account choices as the overseer
 * does (packages/workshop-backend/src/overseer.ts, `ensureObserver`), or `newWorkspace`, then the
 * workspace's `getMetadata` or `setTitle`; `getAvatar`, a byte result; and `getAdminApi`, null, as
 * for a caller who is not a deployment admin.
 */
export function workshopRoot(log: ServerLog, options: WorkshopOptions = {}): RpcTarget {
  const record = (method: string, args: unknown[]) => log.calls.push({ method, args });
  const needs = options.needs ?? [];
  const ids = new Set(needs.map((need) => need.gatekeeperId));

  /** The overseer's check of an answer: each choice for a binding it asked about, by a safe-integer account. */
  function validate(choices: unknown): void {
    const valid = Array.isArray(choices) && choices.every((choice: { gatekeeperId?: unknown; accountId?: unknown }) =>
      ids.has(choice?.gatekeeperId) && Number.isSafeInteger(choice?.accountId));
    if (!valid) throw new Error("The account choices returned by the client were invalid. Please try again.");
  }

  /** Asks `configureObservers`, recording its answer; a refusal denies the open. */
  async function ask(configureObservers: Remote, asked: Record<string, unknown>[]): Promise<void> {
    let choices: unknown;
    try {
      choices = await configureObservers.configure(asked);
    } catch (error) {
      throw new Error(`open refused: ${(error as Error).message}`, { cause: error });
    }
    record("configure", [choices]);
    validate(choices);
  }

  class Overseer extends RpcTarget {
    readonly #id: string;
    constructor(id: string) {
      super();
      this.#id = id;
    }
    getMetadata(): unknown {
      record("getMetadata", []);
      return { id: this.#id, title: `Workspace ${this.#id}` };
    }
    setTitle(title: string): void {
      record("setTitle", [title]);
    }
    [Symbol.dispose](): void {
      log.disposed.push("overseer");
    }
  }

  class Authed extends RpcTarget {
    // The callback is used only within the call, so it is not kept (no `dup()`).
    async openWorkspace(id: string, shareKey?: string, configureObservers?: Remote): Promise<Overseer> {
      record("openWorkspace", [id, shareKey ?? null, configureObservers !== undefined]);
      if (needs.length > 0) {
        if (configureObservers === undefined) {
          throw new Error("To open this workspace, you must choose connected accounts for the services it uses, " +
            "but no configuration channel was provided.");
        }
        await ask(configureObservers, needs);
        if (options.reask) {
          await ask(configureObservers, needs.map((need) => ({ ...need, failure: { accountId: 0, reason: "expired" } })));
        }
      }
      return new Overseer(id);
    }
    newWorkspace(): Overseer {
      record("newWorkspace", []);
      return new Overseer("new-1");
    }
    getAvatar(userId: string): Uint8Array {
      record("getAvatar", [userId]);
      return new TextEncoder().encode(`avatar of ${userId}`);
    }
    getAdminApi(): null {
      record("getAdminApi", []);
      return null;
    }
    [Symbol.dispose](): void {
      log.disposed.push("authed");
    }
  }

  class Root extends RpcTarget {
    authenticate(token: string): Authed {
      record("authenticate", [token]);
      if (token !== "good-token") throw new Error("invalid token");
      return new Authed();
    }
    [Symbol.dispose](): void {
      log.disposed.push("root");
    }
  }

  return new Root();
}

/**
 * A session factory serving `root()` over a fresh MessageChannel per connection. `close()` shuts the
 * ports, which would otherwise keep the test process alive.
 */
export function messagePortServer(log: ServerLog, root: () => RpcTarget): { open: OpenConnection; close(): void; opened: number } {
  const ports: MessagePort[] = [];
  const server = {
    opened: 0,
    open: ((url, headers) => {
      server.opened++;
      log.headers.push(headers);
      const { port1, port2 } = new MessageChannel();
      ports.push(port1, port2);
      const post = port1.postMessage.bind(port1);
      port1.postMessage = (message: unknown) => {
        log.sent.push(JSON.stringify(message, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value));
        post(message);
      };
      newMessagePortRpcSession(port2, root());
      return { main: newMessagePortRpcSession(port1), opened: () => true };
    }) as OpenConnection,
    close: () => {
      for (const port of ports) port.close();
    },
  };
  return server;
}

/** An empty log. */
export function serverLog(): ServerLog {
  return { calls: [], disposed: [], headers: [], sent: [] };
}
