import { describe, expect, it, vi } from "vitest";
import type {
  GatekeeperUserVerifier,
  GitCache,
  ObservationAuthorizer,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import {
  ArrayCursor,
  OffsetCursor,
  PageNumberCursor,
  TokenCursor,
  type TokenPage,
} from "../../src/cursors";
import { ObservationGate, trackedCollectionObservers } from "../../src/observers";
import { fakeKv } from "../fake-kv";

type Issue = { id: number; open: boolean };

/** Pages a fixed list the way a provider does: a short page means the end. */
function pagedApi(items: Issue[]) {
  return vi.fn(async (page: number, perPage: number) =>
    items.slice((page - 1) * perPage, page * perPage));
}

/** A real authorizer, so a gate built from its stub is type-checked rather than cast into place. */
class TestAuthorizer extends RpcTarget implements ObservationAuthorizer {
  readonly #seen: string[];

  constructor(seen: string[]) {
    super();
    this.#seen = seen;
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (description.excludeObservers?.length) {
      throw new Error(`cannot hide from ${description.excludeObservers.join(", ")}`);
    }
    this.#seen.push(description.description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Git cache is not used in this test.");
  }
}

/**
 * A stub over a fresh `TestAuthorizer` and the descriptions it accepted. Annotated, never cast: a
 * gate demanding the whole approval queue would fail to compile against it.
 */
function makeAuthorizer(): { authorizer: RpcStub<ObservationAuthorizer>; seen: string[] } {
  const seen: string[] = [];
  return { authorizer: new RpcStub(new TestAuthorizer(seen)), seen };
}

/** Serves a scripted sequence of token pages; past the end the provider reports exhaustion. */
function tokenApi(pages: TokenPage<Issue>[]) {
  let index = 0;
  return vi.fn(async (_token: string | undefined, _perPage: number) =>
    pages[index++] ?? { items: [] });
}

// Cursors must authorize the exact page they return; tests that assert on it pass their own.
const authorizePage = async () => {};

const ids = (page: Issue[] | null) => page?.map(issue => issue.id);

describe("ArrayCursor", () => {
  it("pages a held list, then reports the end", async () => {
    const cursor = new ArrayCursor([1, 2, 3], 2);

    expect(await cursor.next()).toEqual([1, 2]);
    expect(await cursor.next()).toEqual([3]);
    expect(await cursor.next()).toBeNull();
  });

  it("reports the end immediately for an empty list", async () => {
    expect(await new ArrayCursor([], 2).next()).toBeNull();
  });

  it("rejects a page size that would never terminate", () => {
    expect(() => new ArrayCursor([1], 0)).toThrow(/positive safe integer/);
    expect(() => new ArrayCursor([1], 1.5)).toThrow(/positive safe integer/);
  });
});

describe("PageNumberCursor", () => {
  it("fetches only the provider pages a page of results needs", async () => {
    const fetchPage = pagedApi([1, 2, 3, 4, 5].map(id => ({ id, open: true })));
    const cursor = new PageNumberCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 2, remotePageSize: 2 });

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledOnce();

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([3, 4]);
    expect((await cursor.next())?.map(issue => issue.id)).toEqual([5]);
    expect(await cursor.next()).toBeNull();
  });

  it("serializes concurrent callers instead of duplicating and skipping pages", async () => {
    const items = [1, 2, 3, 4, 5, 6].map(id => ({ id, open: true }));
    const fetchPage = pagedApi(items);
    const cursor = new PageNumberCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 2, remotePageSize: 2 });

    // A gadget can pipeline these; the provider page counter must not be read twice before it moves.
    const pages = await Promise.all([cursor.next(), cursor.next(), cursor.next()]);

    expect(pages.map(page => page?.map(issue => issue.id)))
      .toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  });

  it("keeps walking a provider that caps pages below the size asked for", async () => {
    const items = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, open: true }));
    // Answers 20 to a request for 100, as Cloudflare's own /accounts endpoint does.
    const fetchPage = vi.fn(async (page: number) => items.slice((page - 1) * 20, page * 20));
    const cursor = new PageNumberCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 100, remotePageSize: 100 });

    // Stopping at the first short page would have returned only the first 20.
    expect((await cursor.next())?.length).toBe(45);
    expect(await cursor.next()).toBeNull();
  });

  it("resumes after a provider rejection, which moved no paging state", async () => {
    const pages = [[{ id: 1, open: true }], [{ id: 2, open: true }]];
    let attempt = 0;
    const cursor = new PageNumberCursor<Issue>({
      fetchPage: async page => {
        if (++attempt === 1) throw new Error("provider 503");
        return pages[page - 1] ?? [];
      },
      authorizePage,
      pageSize: 1,
      remotePageSize: 1,
    });

    await expect(cursor.next()).rejects.toThrow("provider 503");
    // The same page, not the next one: a rejection consumed nothing.
    expect(await cursor.next()).toEqual([{ id: 1, open: true }]);
    expect(await cursor.next()).toEqual([{ id: 2, open: true }]);
  });

  it("resumes after a retain rejection, which moved no paging state", async () => {
    const pages = [[{ id: 1, open: true }], [{ id: 2, open: true }]];
    const fetchPage = vi.fn(async (page: number) => pages[page - 1] ?? []);
    let attempt = 0;
    const cursor = new PageNumberCursor<Issue>({
      fetchPage,
      retain: items => {
        if (++attempt === 1) throw new Error("authorization unavailable");
        return items;
      },
      authorizePage,
      pageSize: 1,
      remotePageSize: 1,
    });

    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    // Page 1 again. Advancing before `retain` would have skipped it for good.
    expect(await cursor.next()).toEqual([{ id: 1, open: true }]);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 1]);
  });

  it("exposes no paging method a stub holder could call", () => {
    // capnweb resolves string paths only; reached by name it would skip the queue.
    const cursor = new PageNumberCursor<Issue>(
      { fetchPage: async () => [], authorizePage, pageSize: 1 });

    expect((cursor as unknown as Record<string, unknown>).loadMore).toBeUndefined();
  });

  it("reports the end rather than an error when the provider is simply empty", async () => {
    const cursor = new PageNumberCursor<Issue>(
      { fetchPage: async () => [], authorizePage, pageSize: 2 });

    expect(await cursor.next()).toBeNull();
  });

  it("walks past a page holding only rows the caller may not see", async () => {
    // The shape that truncates GitHub's issue list today: page 1 is entirely dropped rows.
    const pages = [[{ id: 1, open: false }, { id: 2, open: false }], [{ id: 3, open: true }]];
    const cursor = new PageNumberCursor<Issue>({
      fetchPage: async page => pages[page - 1] ?? [],
      retain: items => items.filter(issue => issue.open),
      authorizePage,
      pageSize: 2,
      remotePageSize: 2,
    });

    expect(ids(await cursor.next())).toEqual([3]);
    expect(await cursor.next()).toBeNull();
  });

  it("bounds one call rather than walking a whole history of dropped pages", async () => {
    const fetchPage = vi.fn(async () => [{ id: 1, open: false }]);
    const cursor = new PageNumberCursor<Issue>(
      { fetchPage, retain: () => [], authorizePage, pageSize: 2, remotePageSize: 1 });

    // `[]` invites another call, where null would claim the list had ended.
    expect(await cursor.next()).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(10);
  });

  it("bounds one call when retained rows keep arriving too, not just empty pages", async () => {
    // One survivor every third page: a consecutive-empty window would never trip, and filling a
    // page of 100 would cost three hundred provider calls.
    const fetchPage = vi.fn(async (page: number) => [{ id: page, open: page % 3 === 0 }]);
    const cursor = new PageNumberCursor<Issue>({
      fetchPage,
      retain: items => items.filter(issue => issue.open),
      authorizePage,
      pageSize: 100,
      remotePageSize: 1,
    });

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([3, 6, 9]);
    expect(fetchPage).toHaveBeenCalledTimes(10);
    // The walk resumes where the window ended rather than starting over or skipping.
    expect((await cursor.next())?.map(issue => issue.id)).toEqual([12, 15, 18]);
  });

  it("rejects page sizes that would never terminate", () => {
    const fetchPage = pagedApi([]);
    expect(() => new PageNumberCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 0 })).toThrow(/positive safe integer/);
    expect(() => new PageNumberCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 2, remotePageSize: 0 }))
      .toThrow(/positive safe integer/);
    expect(() => new PageNumberCursor<Issue>({ fetchPage, authorizePage, pageSize: 2.5 }))
      .toThrow(/positive safe integer/);
  });

  it("releases what the caller acquired when it rejects the page size", () => {
    // The documented pattern leases a gate *before* constructing the cursor, so a throw that
    // skipped `dispose` would leak the duplicated stub on every rejected call.
    const dispose = vi.fn();

    expect(() => new PageNumberCursor<Issue>(
      { fetchPage: pagedApi([]), authorizePage, pageSize: 0, dispose }))
      .toThrow(/positive safe integer/);

    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("OffsetCursor", () => {
  it("advances by the rows returned, so a capping provider skips nothing", async () => {
    const items = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, open: true }));
    // Answers 20 to a request for 100, as jira's silent `maxResults` clamp does. Page arithmetic
    // over this shape would request offsets 0, 100, ... and lose rows 20-99 without an error.
    const fetchPage = vi.fn(async (offset: number) => items.slice(offset, offset + 20));
    const cursor = new OffsetCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 100, remotePageSize: 100 });

    expect((await cursor.next())?.length).toBe(45);
    expect(await cursor.next()).toBeNull();
    expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0, 20, 40, 45]);
  });

  it("advances by the raw page, not what retain kept", async () => {
    const items = [{ id: 1, open: false }, { id: 2, open: true }, { id: 3, open: true }];
    const fetchPage =
      vi.fn(async (offset: number, limit: number) => items.slice(offset, offset + limit));
    const cursor = new OffsetCursor<Issue>({
      fetchPage,
      retain: page => page.filter(issue => issue.open),
      authorizePage,
      pageSize: 10,
      remotePageSize: 2,
    });

    expect(ids(await cursor.next())).toEqual([2, 3]);
    expect(await cursor.next()).toBeNull();
    // Raw lengths moved the walk; dropped rows did not rewind it.
    expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0, 2, 3]);
  });

  it("resumes after a provider rejection, which moved no offset", async () => {
    const items = [{ id: 1, open: true }];
    let attempt = 0;
    const cursor = new OffsetCursor<Issue>({
      fetchPage: async offset => {
        if (++attempt === 1) throw new Error("provider 503");
        return items.slice(offset, offset + 1);
      },
      authorizePage,
      pageSize: 1,
      remotePageSize: 1,
    });

    await expect(cursor.next()).rejects.toThrow("provider 503");
    expect(ids(await cursor.next())).toEqual([1]);
    expect(await cursor.next()).toBeNull();
  });
});

describe("TokenCursor", () => {
  it("walks until the token is absent, not until a page is empty", async () => {
    // Marketo's shape: an empty window mid-walk, and `""` as a real continuation token. Ending on
    // either -- as page-number paging must -- silently truncates the walk.
    const fetchPage = tokenApi([
      { items: [{ id: 1, open: true }, { id: 2, open: true }], nextToken: "a" },
      { items: [], nextToken: "b" },
      { items: [{ id: 3, open: true }], nextToken: "" },
      { items: [{ id: 4, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 10, remotePageSize: 25 });

    expect(ids(await cursor.next())).toEqual([1, 2, 3, 4]);
    expect(await cursor.next()).toBeNull();
    expect(fetchPage.mock.calls).toEqual([
      [undefined, 25], ["a", 25], ["b", 25], ["", 25],
    ]);
  });

  it("ends the call rather than failing on a provider with nothing for this window", async () => {
    // An activity stream answers empty windows for a quiet period, so this is pacing, not a fault.
    const fetchPage = tokenApi([
      ...Array.from({ length: 12 }, (_, index) => ({ items: [], nextToken: `w${index}` })),
      { items: [{ id: 1, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>({ fetchPage, authorizePage, pageSize: 2 });

    // `[]` is a legal non-terminal page: only `null` ends a cursor, so the walk survives the cap.
    expect(await cursor.next()).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(10);
    expect(ids(await cursor.next())).toEqual([1]);
    expect(await cursor.next()).toBeNull();
  });

  it("re-sends the same token after a provider rejection", async () => {
    // The position lives in the cursor, so latching a transient failure would cost the whole walk.
    const asked: (string | undefined)[] = [];
    let attempt = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage: async token => {
        asked.push(token);
        if (++attempt === 2) throw new Error("provider 503");
        return { items: [{ id: attempt, open: true }], nextToken: attempt < 3 ? "t2" : undefined };
      },
      authorizePage,
      pageSize: 1,
    });

    expect(ids(await cursor.next())).toEqual([1]);
    await expect(cursor.next()).rejects.toThrow("provider 503");
    expect(ids(await cursor.next())).toEqual([3]);
    expect(asked).toEqual([undefined, "t2", "t2"]);
  });

  it("refuses a provider that echoes the token it was asked to continue from", async () => {
    const fetchPage = vi.fn(async (token: string | undefined): Promise<TokenPage<Issue>> =>
      token === undefined
        ? { items: [{ id: 1, open: true }], nextToken: "same" }
        : { items: [{ id: 2, open: true }], nextToken: token });
    const cursor = new TokenCursor<Issue>({ fetchPage, authorizePage, pageSize: 10 });

    await expect(cursor.next()).rejects.toThrow(/same continuation token/);
    await expect(cursor.next()).rejects.toThrow(/same continuation token/);
    expect(fetchPage.mock.calls.map(([token]) => token)).toEqual([undefined, "same", "same"]);
  });

  it("serializes concurrent callers instead of duplicating and skipping pages", async () => {
    const fetchPage = tokenApi([
      { items: [{ id: 1, open: true }, { id: 2, open: true }], nextToken: "a" },
      { items: [{ id: 3, open: true }, { id: 4, open: true }], nextToken: "b" },
      { items: [{ id: 5, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 2, remotePageSize: 2 });

    const pages = await Promise.all([cursor.next(), cursor.next(), cursor.next()]);

    expect(pages.map(page => ids(page))).toEqual([[1, 2], [3, 4], [5]]);
    expect(fetchPage.mock.calls.map(([token]) => token)).toEqual([undefined, "a", "b"]);
  });

  it("releases what the fetch callback owns, once, however often it is disposed", async () => {
    // A callback that duplicates a stub for the walk has nowhere else to release it: the cursor
    // stub's disposal is the only signal that the walk is over.
    const dispose = vi.fn();
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [{ id: 1, open: true }] }]),
      authorizePage,
      pageSize: 1,
      dispose,
    });
    expect(ids(await cursor.next())).toEqual([1]);

    cursor[Symbol.dispose]();
    cursor[Symbol.dispose]();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("authorizes the exact page it returns, including one served from the buffer", async () => {
    const fetchPage = tokenApi([
      { items: [1, 2, 3, 4, 5].map(id => ({ id, open: true })) },
    ]);
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>(
      { fetchPage, authorizePage: authorized, pageSize: 2, remotePageSize: 5 });

    expect(ids(await cursor.next())).toEqual([1, 2]);
    expect(ids(await cursor.next())).toEqual([3, 4]);

    // The second page came out of the buffer with no provider call, and was still authorized.
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(authorized.mock.calls).toEqual([
      [[{ id: 1, open: true }, { id: 2, open: true }], { terminal: false }],
      [[{ id: 3, open: true }, { id: 4, open: true }], { terminal: false }],
    ]);
  });

  it("re-offers a refused page rather than dropping it or re-fetching", async () => {
    const fetchPage = tokenApi([
      { items: [1, 2, 3, 4, 5].map(id => ({ id, open: true })) },
    ]);
    let call = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      authorizePage: async () => {
        if (++call === 2) throw new Error("authorization unavailable");
      },
      pageSize: 2,
      remotePageSize: 5,
    });

    expect(ids(await cursor.next())).toEqual([1, 2]);
    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    // The same items, and the provider position never rewound, so it must not be asked again.
    expect(ids(await cursor.next())).toEqual([3, 4]);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("re-offers a capped page unchanged, rather than growing what was refused", async () => {
    // A heavily filtered provider caps the window before the page is full. Refilling on retry
    // would hand the approver a larger page than the one they just refused.
    const fetchPage = vi.fn(async (page: number) => [{ id: page, open: page % 3 === 0 }]);
    const offered: number[][] = [];
    let call = 0;
    const cursor = new PageNumberCursor<Issue>({
      fetchPage,
      retain: rows => rows.filter(issue => issue.open),
      pageSize: 100,
      remotePageSize: 1,
      authorizePage: async items => {
        offered.push(items.map(issue => issue.id));
        if (++call === 1) throw new Error("authorization unavailable");
      },
    });

    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    expect(ids(await cursor.next())).toEqual([3, 6, 9]);

    expect(offered).toEqual([[3, 6, 9], [3, 6, 9]]);
    // The held page is served without asking the provider again.
    expect(fetchPage).toHaveBeenCalledTimes(10);
  });

  it("authorizes a spent fetch window, which discloses that the window held nothing", async () => {
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi(
        Array.from({ length: 12 }, (_, index) => ({ items: [], nextToken: `w${index}` }))),
      authorizePage: authorized,
      pageSize: 2,
    });

    // Not terminal: the walk continues, so the caller is told to ask again.
    expect(await cursor.next()).toEqual([]);
    expect(authorized.mock.calls).toEqual([[[], { terminal: false }]]);
  });

  it("still authorizes the terminal answer after empty windows disclosed no rows", async () => {
    // The empty windows were authorized, but none of them answered the query. Treating "authorized
    // something" as "disclosed something" would let the zero-result answer out unaudited.
    const seen: string[] = [];
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([
        ...Array.from({ length: 12 }, (_, index) => ({ items: [], nextToken: `w${index}` })),
        { items: [] },
      ]),
      pageSize: 2,
      authorizePage: async (items, { terminal }) =>
        void seen.push(`${terminal ? "terminal" : "window"}:${items.length}`),
    });

    expect(await cursor.next()).toEqual([]);
    expect(await cursor.next()).toBeNull();

    expect(seen).toEqual(["window:0", "terminal:0"]);
    // Still at most once: exhaustion asked again emits no duplicate.
    expect(await cursor.next()).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it("authorizes the zero-result answer a walk that disclosed nothing still gives", async () => {
    // `searchUsers(email) -> no matches` is an existence oracle: it answers a question about
    // provider data, so it cannot reach the gadget unaudited just because no row came back.
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [] }]),
      authorizePage: authorized,
      pageSize: 2,
    });

    expect(await cursor.next()).toBeNull();
    expect(authorized.mock.calls).toEqual([[[], { terminal: true }]]);

    // Exhaustion is idempotent: asking again repeats no observation.
    expect(await cursor.next()).toBeNull();
    expect(authorized).toHaveBeenCalledOnce();
  });

  it("does not re-authorize exhaustion for a walk that already returned a page", async () => {
    const authorized = vi.fn(async () => {});
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [{ id: 1, open: true }] }]),
      authorizePage: authorized,
      pageSize: 2,
    });

    expect(ids(await cursor.next())).toEqual([1]);
    expect(await cursor.next()).toBeNull();
    // The page was authorized; the `null` that follows discloses nothing new.
    expect(authorized.mock.calls).toEqual([[[{ id: 1, open: true }], { terminal: false }]]);
  });

  it("re-authorizes a refused zero-result answer on the next call", async () => {
    let call = 0;
    const authorized = vi.fn(async () => {
      if (++call === 1) throw new Error("authorization unavailable");
    });
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [] }]),
      authorizePage: authorized,
      pageSize: 2,
    });

    await expect(cursor.next()).rejects.toThrow("authorization unavailable");
    // The refusal left nothing recorded, so the retry must ask again rather than answer silently.
    expect(await cursor.next()).toBeNull();
    expect(authorized).toHaveBeenCalledTimes(2);
  });

  it("drives a real gate through every empty case the documented pattern must survive", async () => {
    // The other tests stub `authorizePage`, so they cannot catch a scope the gate itself refuses.
    // A spent window and an exhausted walk both arrive with no items, and `{ ids: [] }` is refused.
    const { authorizer, seen } = makeAuthorizer();
    using gate = new ObservationGate(
      authorizer,
      // A `sets` scope needs the strategy that actually checks them.
      trackedCollectionObservers({ kv: fakeKv(), hasCollectionAccess: async () => [] }));
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([
        { items: [], nextToken: "w0" },
        { items: [{ id: 1, open: true }] },
      ]),
      pageSize: 2,
      remotePageSize: 1,
      authorizePage: (issues, { terminal }) => issues.length === 0
        ? gate.authorize(
          { title: "Issues", description: terminal ? "None left." : "None visible yet." },
          { kind: "baseline" })
        : gate.authorize(
          { title: "Issues", description: `Read ${issues.length} issues.` },
          { kind: "collections", ids: issues.map(issue => issue.id.toString()) }),
    });

    // A page, then exhaustion. Neither may throw out of the gate.
    expect(ids(await cursor.next())).toEqual([1]);
    expect(await cursor.next()).toBeNull();
    expect(seen).toEqual(["Read 1 issues."]);
  });

  it("refuses a gated page through a real read-only authorizer stub", async () => {
    // The gate needs only `ObservationAuthorizer` -- exactly what a catalog or slash-command
    // handler is given.
    const { authorizer, seen } = makeAuthorizer();
    const strategy = trackedCollectionObservers<string[]>({
      kv: fakeKv(),
      hasCollectionAccess: async (allowed, collectionIds) =>
        collectionIds.map(id => allowed.includes(id)),
    });
    using gate = new ObservationGate(authorizer, strategy);
    await strategy.addObserver("limited", ["s1"] as unknown as Fetcher<GatekeeperUserVerifier>);

    using cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([{ items: [{ id: 1, open: true }] }]),
      pageSize: 1,
      authorizePage: issues => gate.authorize(
        { title: "Issues", description: `Read ${issues.length} issues.` },
        { kind: "collections", ids: ["s2"] }),
    });

    // The collaborator cannot see s2, so the derived exclusion refuses the page before its rows
    // reach the caller.
    await expect(cursor.next()).rejects.toThrow("cannot hide from limited");
    expect(seen).toEqual([]);
  });

  it("keeps authorizing after the session that made it is gone", async () => {
    // A cursor is returned to the gadget and walked later, so it outlives the call that made it.
    // Real stubs, so the lease's refcount is workerd's rather than the test's: releasing the
    // session must not close the handle the walk still holds.
    const { authorizer, seen } = makeAuthorizer();
    const session = new ObservationGate(
      authorizer, trackedCollectionObservers({ kv: fakeKv(), hasCollectionAccess: async () => [] }));
    const walk = session.lease();
    const cursor = new TokenCursor<Issue>({
      fetchPage: tokenApi([
        { items: [{ id: 1, open: true }], nextToken: "n" },
        { items: [{ id: 2, open: true }] },
      ]),
      pageSize: 1,
      remotePageSize: 1,
      // The cursor takes its own lease and releases it when the walk is dropped.
      authorizePage: items => walk.authorize(
        { title: "Issues", description: `Read ${items.length} issues.` },
        { kind: "collections", ids: items.map(issue => issue.id.toString()) }),
      dispose: () => walk[Symbol.dispose](),
    });

    expect(ids(await cursor.next())).toEqual([1]);
    session[Symbol.dispose]();

    // The walk must neither continue unaudited nor become unusable.
    expect(ids(await cursor.next())).toEqual([2]);
    expect(seen).toEqual(["Read 1 issues.", "Read 1 issues."]);
    cursor[Symbol.dispose]();
  });

  it("releases a lease without disturbing the session that opened it", async () => {
    const { authorizer, seen } = makeAuthorizer();
    using session = new ObservationGate(
      authorizer, trackedCollectionObservers({ kv: fakeKv(), hasCollectionAccess: async () => [] }));

    session.lease()[Symbol.dispose]();

    // The session still holds its own handle, so the walk ending does not end the session.
    await session.authorize({ title: "After", description: "Still open." }, { kind: "baseline" });
    expect(seen).toEqual(["Still open."]);
  });

  it("rejects page sizes that would never terminate", () => {
    const fetchPage = tokenApi([]);
    expect(() => new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 0 })).toThrow(/positive safe integer/);
    expect(() => new TokenCursor<Issue>(
      { fetchPage, authorizePage, pageSize: 2, remotePageSize: 1.5 }))
      .toThrow(/positive safe integer/);
  });
});
