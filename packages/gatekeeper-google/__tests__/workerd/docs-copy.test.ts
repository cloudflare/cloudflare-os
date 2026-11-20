import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { LATE_FETCH_SCENARIO, lateFetchScenario } from "../doc-store-scenarios";
import { withDocStore } from "./doc-store-host";

// What only real storage shows of a Doc's stored copy: the types a record's columns hold, a keep
// that fails part way through its transaction, what an activation after an eviction reads, and
// the removal of megabytes under `docCopy:` a batch at a time.

const EMPTY = { doc_copy: 0, doc_md: 0, doc_result: 0, doc_run: 0, doc_seq: 0, doc_version: 0 };
// The failure of a call, as text. `then` alone is read from the call's promise: any other
// property of it is a pipelined call, which would fail unhandled alongside this one.
const failure = (call: PromiseLike<unknown>) =>
  call.then(() => undefined, (error: unknown) => String(error));

it("refuses a record whose columns are of the wrong types", async () => {
  const host = env.DOC_COPY_HOST.getByName("typed-record");
  await host.read({ a: "one" });
  const before = await host.counts();

  // Text where the clock of the fetch goes, and a record with no id: storage takes neither, so
  // no reader of a record has to ask what its columns hold.
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

it("removes the keys under docCopy: as its copy is read, and stores the copy in rows", async () => {
  const host = env.DOC_COPY_HOST.getByName("unread-copy-read");
  // Twenty keys: sixteen go when the copy's lifecycle is built, and the rest at its first read.
  await host.writeUnreadCopy(1, 18, []);
  expect(await host.keys()).toHaveLength(20);

  expect(await host.read({ a: "one" })).toEqual(["a"]);

  expect(await host.keys()).toEqual([]);
  expect(await host.tab("a")).toBe("one");
  // One tab of one run: the run with its rendering, its context, its run list and its version.
  expect(await host.counts())
    .toEqual({ ...EMPTY, doc_copy: 1, doc_run: 2, doc_md: 1, doc_seq: 1, doc_version: 1 });
});

it("keeps the copy across an eviction, serves it without a fetch and decodes only the tab that is read", async () => {
  const host = env.DOC_COPY_HOST.getByName("evicted");
  await host.read({ a: "one", b: "two", c: "three" });
  expect(await host.fetches()).toBe(1);
  expect(await host.decodes()).toBe(0);

  await host.evict();

  expect(await host.current()).toEqual(["a", "b", "c"]);
  expect(await host.fetches()).toBe(1);
  expect(await host.decodes()).toBe(0);
  expect(await host.tab("b")).toBe("two");
  expect(await host.decodes()).toBe(1);
  // Nothing decoded is kept: a second read of the tab reads its rows again.
  expect(await host.tab("b")).toBe("two");
  expect(await host.decodes()).toBe(2);
});

// The first tab's rows are written before the second tab's paragraph is found too large. This holds the
// rollback, not the limit: the store's own test on real storage is the test of that.
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

it("leaves no row of a tab a later fetch does not list or lists under another id", async () => {
  const host = env.DOC_COPY_HOST.getByName("renames");
  await host.read({ a: "one", b: "two" });
  // Two versions, each a run list and a run with its rendering, and the context the two share.
  const two = { ...EMPTY, doc_copy: 1, doc_run: 3, doc_md: 2, doc_seq: 2, doc_version: 2 };
  expect(await host.counts()).toEqual(two);

  // The same text under another id is another version over the same run.
  expect(await host.read({ a: "one", c: "two" })).toEqual(["a", "c"]);

  expect(await host.counts()).toEqual(two);
  expect(await host.tab("b")).toBeNull();
  expect(await host.tab("c")).toBe("two");

  expect(await host.read({ a: "one" })).toEqual(["a"]);

  // One tab of one run: the run with its rendering, its context, its run list and its version.
  expect(await host.counts())
    .toEqual({ ...EMPTY, doc_copy: 1, doc_run: 2, doc_md: 1, doc_seq: 1, doc_version: 1 });
  expect(await host.tab("c")).toBeNull();
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
