import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { LATE_FETCH_SCENARIO, lateFetchScenario } from "../doc-store-scenarios";
import { withDocStore } from "./doc-store-host";

// What only real storage shows of a Doc's stored copy: the types a record's columns hold, a keep
// or a late fetch undone with its transaction, and megabytes under `docCopy:` removed in batches.

// The failure of a call, as text. `then` alone is read from the call's promise: any other
// property of it is a pipelined call, which would fail unhandled alongside this one.
const failure = (call: PromiseLike<unknown>) =>
  call.then(() => undefined, (error: unknown) => String(error));

it("refuses a record whose columns are of the wrong types", async () => {
  const host = env.DOC_COPY_HOST.getByName("typed-record");
  await host.read({ a: "one" });
  const before = await host.counts();

  // Storage refuses text for the fetch's clock and a record with no id.
  expect(await failure(host.insertRecord("fetched_at"))).toMatch(/doc_copy\.fetched_at|datatype/i);
  expect(await failure(host.insertRecord("id"))).toMatch(/doc_copy\.id|NOT NULL/i);

  expect(await host.counts()).toEqual(before);
  expect(await host.tab("a")).toBe("one");
});

it("removes a copy of several megabytes under docCopy: in batches, and what is left survives a restart", async () => {
  let host = env.DOC_COPY_HOST.getByName("unread-copy");
  const others = ["docWriteReceipt", "pending:action:0000000001"];
  // What this activation remembers, to tell the one after the restart from it.
  await host.read({ a: "one" });
  expect(await host.fetches()).toBe(1);
  // Two parts of 3 MiB each: the index, and for each part a manifest and three chunks.
  await host.writeUnreadCopy(2, 3, others);
  const unread = async () => (await host.keys()).filter(key => key.startsWith("docCopy:"));
  expect(await unread()).toHaveLength(9);

  expect(await host.removeUnread(4)).toBe(false);
  expect(await unread()).toHaveLength(5);

  // Nothing records how far the removal got: the activation that follows scans again.
  expect(await failure(host.restart())).toContain("Restarted by the test.");
  host = env.DOC_COPY_HOST.getByName("unread-copy");
  expect(await host.fetches()).toBe(0);
  expect(await unread()).toHaveLength(5);
  expect(await host.removeUnread(4)).toBe(false);
  expect(await unread()).toHaveLength(1);
  expect(await host.removeUnread(4)).toBe(true);

  expect(await unread()).toEqual([]);
  expect(await host.keys()).toEqual(others);
  expect(await host.removeUnread(4)).toBe(true);
});

// The first tab's rows are written before the second's paragraph is found too large: held to a
// rollback.
it("leaves the earlier copy whole when a keep fails part way", async () => {
  const host = env.DOC_COPY_HOST.getByName("fails-midway");
  await host.read({ a: "one", b: "two" });
  const earlier = await host.counts();

  expect(await failure(host.read({ a: "uno", b: "too large for a row" })))
    .toContain('A paragraph of tab "b" of this Google Doc is too large to keep a copy of');

  await host.evict();
  expect(await host.counts()).toEqual(earlier);
  expect(await host.tab("a")).toBe("one");
  expect(await host.tab("b")).toBe("two");

  // The copy that follows is stored whole as well.
  expect(await host.read({ a: "uno", b: "dos" })).toEqual(["a", "b"]);
  await host.evict();
  expect(await host.tab("a")).toBe("uno");
  expect(await host.tab("b")).toBe("dos");
  expect(await host.counts()).toEqual(earlier);
});

it("commits a keep and the KV writes beside it together, and undoes both together", async () => {
  const host = env.DOC_COPY_HOST.getByName("beside");
  await host.keepBeside({ a: "one" }, "beside:first", false);

  expect(await host.keys()).toEqual(["beside:first"]);
  expect(await host.tab("a")).toBe("one");
  const kept = await host.counts();

  expect(await failure(host.keepBeside({ a: "uno", b: "dos" }, "beside:second", true)))
    .toContain("The transaction around the keep failed.");

  await host.evict();
  expect(await host.keys()).toEqual(["beside:first"]);
  expect(await host.counts()).toEqual(kept);
  expect(await host.tab("a")).toBe("one");
  expect(await host.tab("b")).toBeNull();
});

it("a late fetch replaces nothing, on real storage", async () => {
  expect(await withDocStore((_, storage) => lateFetchScenario(storage))).toEqual(LATE_FETCH_SCENARIO);
});
