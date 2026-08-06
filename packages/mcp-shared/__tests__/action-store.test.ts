import { describe, expect, it } from "vite-plus/test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { ActionStore } from "../src/action-store.js";
import { McpProtocolError, McpSessionExpiredError } from "../src/client.js";

type TestSql = ConstructorParameters<typeof ActionStore>[0];

function fakeSql(): TestSql {
  const db = new DatabaseSync(":memory:");
  return {
    exec<T>(query: string, ...bindings: SQLInputValue[]) {
      const rows = bindings.length > 0
        ? db.prepare(query).all(...bindings)
        : /^\s*(?:SELECT|INSERT.*RETURNING)/is.test(query)
          ? db.prepare(query).all()
          : (db.exec(query), []);
      return {
        toArray: () => rows as T[],
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
          return rows[0] as T;
        },
      };
    },
  } as unknown as TestSql;
}

const log = { debug() {}, info() {}, warn() {}, error() {}, with() { return log; } };
const ok = async () => ({ content: [{ type: "text" as const, text: "done" }] });

describe("ActionStore", () => {
  it("keeps a decided action available until the Gadget collects it", async () => {
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", { to: "a@b.c" });
    await store.apply(staged.id, fn => fn({ callTool: ok } as never), log);
    expect(store.get(staged.id)?.state).toBe("applied");
    expect(store.get(staged.id)?.result?.text).toBe("done");
  });

  it("retains only recent terminal actions without pruning pending ones", async () => {
    const sql = fakeSql();
    const store = new ActionStore(sql);
    const pending = store.stage("send", { pending: true });
    for (let i = 0; i < 250; i++) {
      const staged = store.stage("send", { i });
      await store.apply(staged.id, fn => fn({ callTool: ok } as never), log);
    }
    const { count } = sql.exec<{ count: number }>("SELECT count(*) AS count FROM mcp_actions").one();
    expect(count).toBe(101);
    expect(store.get(pending.id)?.state).toBe("pending");
    expect(store.get(251)?.state).toBe("applied");
    expect(store.get(2)).toBeUndefined();
    store.reject(pending.id);
    expect(store.get(pending.id)).toBeUndefined();
  });

  it("refuses to queue more calls than a Gadget could plausibly be waiting on", () => {
    // Pending records cannot be pruned, so without a cap they are an unbounded write primitive: a
    // Gadget that queues calls and never collects them grows the Durable Object forever.
    const store = new ActionStore(fakeSql());
    for (let i = 0; i < 50; i++) store.stage("send", { i });
    expect(() => store.stage("send", { overflow: true })).toThrow(/awaiting approval/);
  });

  it("rejects arguments that cannot be stored safely", () => {
    const store = new ActionStore(fakeSql());
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => store.stage("send", circular)).toThrow(/JSON-compatible/);
    expect(() => store.stage("send", { body: "x".repeat(70_000) })).toThrow(/too large/);
  });

  it("frees a pending slot however the call was decided", async () => {
    const store = new ActionStore(fakeSql());
    for (let i = 0; i < 48; i++) store.stage("send", { i });
    const applied = store.stage("send", { applied: true });
    const rejected = store.stage("send", { rejected: true });
    expect(() => store.stage("send", {})).toThrow();

    await store.apply(applied.id, fn => fn({ callTool: ok } as never), log);
    store.reject(rejected.id);
    expect(() => store.stage("send", {})).not.toThrow();
    expect(() => store.stage("send", {})).not.toThrow();
  });

  it("records a declined call as retryable, distinct from a rejection", async () => {
    // The server answered, so the tool did not run and another attempt cannot duplicate anything.
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", {});
    const declined = async () => {
      throw new McpProtocolError("MCP server rejected: unknown tool", -32601, "declined");
    };
    await expect(store.apply(staged.id, fn => fn({ callTool: declined } as never), log))
      .rejects.toThrow(/unknown tool/);

    const record = store.get(staged.id);
    expect(record?.state).toBe("failed");
    expect(record?.retryable).toBe(true);
    expect(record?.error).toContain("unknown tool");

    // And the retry really is offered.
    await store.apply(staged.id, fn => fn({ callTool: ok } as never), log);
    expect(store.get(staged.id)?.state).toBe("applied");
  });

  it("closes a call that failed after dispatch, rather than offering to send it again", async () => {
    // A connection dropped while reading the reply is indistinguishable from one dropped before the
    // server acted, so the request may already have been carried out. Retrying is how one approval
    // becomes two writes, and MCP has no inverse operation to undo the second.
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", {});
    let calls = 0;
    const dropped = async () => {
      calls++;
      throw new McpProtocolError("MCP server returned a non-JSON response.");
    };

    await expect(store.apply(staged.id, fn => fn({ callTool: dropped } as never), log))
      .rejects.toThrow(/may or may not have taken effect/);

    const record = store.get(staged.id);
    expect(record?.state).toBe("failed");
    expect(record?.retryable).toBe(false);

    // A second apply is refused without reaching the server.
    await expect(store.apply(staged.id, fn => fn({ callTool: dropped } as never), log))
      .rejects.toThrow(/may or may not have taken effect/);
    expect(calls).toBe(1);
  });

  it("treats an unrecognised failure as possibly performed", async () => {
    // Fails safe. A throw site that has not said what it means is not evidence the tool never ran.
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", {});
    const boom = async () => { throw new Error("upstream exploded"); };
    await expect(store.apply(staged.id, fn => fn({ callTool: boom } as never), log))
      .rejects.toThrow(/may or may not have taken effect/);
    expect(store.get(staged.id)?.retryable).toBe(false);
  });

  it("does not accumulate records for an endpoint where every call fails", async () => {
    // Pruning used to happen only on the success and rejection paths, so a server that failed every
    // call retained one record per attempt: retention was enforced only by the outcomes a
    // persistently broken endpoint never produces. The facet Durable Object grew without bound.
    const sql = fakeSql();
    const store = new ActionStore(sql);
    const declined = async () => {
      throw new McpProtocolError("MCP server rejected: unknown tool", -32601, "declined");
    };

    for (let attempt = 0; attempt < 250; attempt++) {
      const staged = store.stage("send", { attempt });
      await expect(store.apply(staged.id, fn => fn({ callTool: declined } as never), log))
        .rejects.toThrow();
    }

    const { count } = sql.exec<{ count: number }>("SELECT count(*) AS count FROM mcp_actions").one();
    expect(count).toBe(100);
  });

  it("still keeps a failed record long enough for the Gadget to collect it", async () => {
    // Pruning must not reach the record that just failed: the Gadget learns the outcome by asking
    // for it afterwards.
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", {});
    const declined = async () => {
      throw new McpProtocolError("MCP server rejected: unknown tool", -32601, "declined");
    };
    await expect(store.apply(staged.id, fn => fn({ callTool: declined } as never), log))
      .rejects.toThrow();

    expect(store.get(staged.id)?.state).toBe("failed");
  });

  it("does not retry a write after an apparent transport-session expiry", async () => {
    // MCP says a session-bearing 404 means no dispatch, but a fronting proxy can produce the same
    // response after the upstream accepted the write. The two cases are indistinguishable here.
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", {});
    let calls = 0;
    const expired = async () => {
      calls++;
      throw new McpSessionExpiredError();
    };

    await expect(store.apply(staged.id, fn => fn({ callTool: expired } as never), log))
      .rejects.toThrow(/may or may not have taken effect/);
    expect(store.get(staged.id)?.retryable).toBe(false);

    await expect(store.apply(staged.id, fn => fn({ callTool: expired } as never), log))
      .rejects.toThrow(/may or may not have taken effect/);
    expect(calls).toBe(1);
  });

  it("applies an approved call once even if two applies race", async () => {
    // Both callers used to read the record as `pending` before either wrote, so both called the
    // tool. MCP describes no inverse operation, so the duplicate write cannot be undone -- the
    // claim has to be taken before the first await, not after the call returns.
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", { to: "a@b.c" });
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { content: [] };
    };

    const [first, second] = await Promise.allSettled([
      store.apply(staged.id, fn => fn({ callTool: slow } as never), log),
      store.apply(staged.id, fn => fn({ callTool: slow } as never), log),
    ]);

    expect(calls).toBe(1);
    expect(store.get(staged.id)?.state).toBe("applied");
    // The loser is told why rather than silently succeeding, so a genuine double-apply is visible.
    const outcomes = [first.status, second.status].toSorted();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
  });

  it("does not reject an action after application has started", async () => {
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", {});
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const applying = store.apply(staged.id, async fn => {
      await blocked;
      return fn({ callTool: ok } as never);
    }, log);

    expect(store.get(staged.id)?.state).toBe("applying");
    expect(() => store.reject(staged.id)).toThrow(/already being applied/);
    release();
    await applying;
    expect(store.get(staged.id)?.state).toBe("applied");
  });

  it("closes a claim whose Durable Object died mid-apply, without re-sending the call", async () => {
    // The activation died somewhere between sending the call and recording the reply, and which side
    // of the send it died on is not knowable from here. MCP offers no idempotency key to make a
    // repeat harmless and no inverse operation to undo one, so re-running the tool could duplicate a
    // write permanently. The action is closed as failed and a person decides what to do.
    const sql = fakeSql();
    const store = new ActionStore(sql);
    const staged = store.stage("send", {});
    sql.exec(
      "UPDATE mcp_actions SET state = 'applying', claimed_at = ? WHERE id = ?",
      Date.now() - 5 * 60 * 1000,
      staged.id,
    );
    const recovered = new ActionStore(sql);

    let calls = 0;
    const counting = async () => { calls++; return { content: [] }; };
    await expect(recovered.apply(staged.id, fn => fn({ callTool: counting } as never), log))
      .rejects.toThrow(/may or may not have taken effect/);

    expect(calls).toBe(0);
    expect(recovered.get(staged.id)?.state).toBe("failed");
  });

  it("does not let claims nobody will settle consume the queue permanently", async () => {
    // Only the next `apply()` for that same id settles an expired claim, and an evicted Durable
    // Object never makes one. Counting those rows retired the binding one interruption at a time.
    const sql = fakeSql();
    const store = new ActionStore(sql);
    for (let n = 0; n < 50; n++) store.stage("send", { n });
    sql.exec(
      "UPDATE mcp_actions SET state = 'applying', claimed_at = ?",
      Date.now() - 5 * 60 * 1000,
    );

    expect(new ActionStore(sql).stage("send", { n: 50 }).state).toBe("pending");
  });

  it("does not retire a live slow call when another action is staged", async () => {
    const sql = fakeSql();
    const store = new ActionStore(sql);
    const staged = store.stage("send", {});
    let release!: () => void;
    const applying = store.apply(staged.id, async fn => {
      await new Promise<void>(resolve => { release = resolve; });
      return fn({ callTool: ok } as never);
    }, log);
    sql.exec(
      "UPDATE mcp_actions SET claimed_at = ? WHERE id = ?",
      Date.now() - 5 * 60 * 1000,
      staged.id,
    );

    store.stage("send", { another: true });
    expect(store.get(staged.id)?.state).toBe("applying");
    release();
    await applying;
  });

  it("retires abandoned claims so their argument payloads remain bounded", () => {
    const sql = fakeSql();
    let store = new ActionStore(sql);
    for (let batch = 0; batch < 3; batch++) {
      for (let n = 0; n < 50; n++) store.stage("send", { batch, n });
      sql.exec(
        "UPDATE mcp_actions SET state = 'applying', claimed_at = ? WHERE state = 'pending'",
        Date.now() - 5 * 60 * 1000,
      );
      store = new ActionStore(sql);
    }
    store.stage("send", { final: true });

    const { applying } = sql.exec<{ applying: number }>(
      "SELECT count(*) AS applying FROM mcp_actions WHERE state = 'applying'").one();
    const { total } = sql.exec<{ total: number }>(
      "SELECT count(*) AS total FROM mcp_actions").one();
    expect(applying).toBe(0);
    expect(total).toBeLessThanOrEqual(101);
  });

  it("settles the record even when the result cannot be read back", async () => {
    // Everything after the call has already happened externally. A throw while flattening or
    // encoding a server-supplied payload used to leave the action `applying`, so the claim aged out
    // and the next attempt re-ran a tool call that had already taken effect. Losing the result is
    // recoverable; repeating the write is not.
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", {});
    let calls = 0;
    const poison = async () => {
      calls++;
      // Serializing this throws, which is the only way the post-call bookkeeping can fail.
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return { content: [{ type: "text" as const, text: "ok" }], structuredContent: circular };
    };

    await store.apply(staged.id, fn => fn({ callTool: poison } as never), log);
    expect(store.get(staged.id)?.state).toBe("applied");

    // And the settled state is what stops a re-drive: a second apply must not call the tool again.
    await store.apply(staged.id, fn => fn({ callTool: poison } as never), log);
    expect(calls).toBe(1);
  });

  it("bounds retained results by UTF-8 bytes", async () => {
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", {});
    const big = async () => ({ content: [{ type: "text" as const, text: "😀".repeat(40_000) }] });
    await store.apply(staged.id, fn => fn({ callTool: big } as never), log);
    expect(store.get(staged.id)?.state).toBe("applied");
    expect(store.get(staged.id)?.result?.text).toMatch(/too large to retain/);
  });

  it("is idempotent, because the Workshop may retry a call whose result it never saw", async () => {
    const store = new ActionStore(fakeSql());
    const staged = store.stage("send", {});
    let calls = 0;
    const counting = async () => { calls++; return { content: [] }; };
    await store.apply(staged.id, fn => fn({ callTool: counting } as never), log);
    await store.apply(staged.id, fn => fn({ callTool: counting } as never), log);
    expect(calls).toBe(1);
  });
});
