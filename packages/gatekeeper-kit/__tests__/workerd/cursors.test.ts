import { describe, expect, it, vi } from "vitest";
import {
  ArrayCursor,
  OffsetCursor,
  PageNumberCursor,
  TokenCursor,
  type TokenPage,
} from "../../src/cursors";

type Issue = { id: number; open: boolean };

/** Pages a fixed list the way a provider does: a short page means the end. */
function pagedApi(items: Issue[]) {
  return vi.fn(async (page: number, perPage: number) =>
    items.slice((page - 1) * perPage, page * perPage));
}

/** Serves a scripted sequence of token pages; past the end the provider reports exhaustion. */
function tokenApi(pages: TokenPage<Issue>[]) {
  let index = 0;
  return vi.fn(async (_token: string | undefined, _perPage: number) =>
    pages[index++] ?? { items: [] });
}

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
    expect(() => new ArrayCursor([1], 0)).toThrow(/positive integer/);
    expect(() => new ArrayCursor([1], 1.5)).toThrow(/positive integer/);
  });
});

describe("PageNumberCursor", () => {
  it("fetches only the provider pages a page of results needs", async () => {
    const fetchPage = pagedApi([1, 2, 3, 4, 5].map(id => ({ id, open: true })));
    const cursor = new PageNumberCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 2 });

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledOnce();

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([3, 4]);
    expect((await cursor.next())?.map(issue => issue.id)).toEqual([5]);
    expect(await cursor.next()).toBeNull();
  });

  it("serializes concurrent callers instead of duplicating and skipping pages", async () => {
    const items = [1, 2, 3, 4, 5, 6].map(id => ({ id, open: true }));
    const fetchPage = pagedApi(items);
    const cursor = new PageNumberCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 2 });

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
    const cursor = new PageNumberCursor<Issue>({ fetchPage, pageSize: 100, remotePageSize: 100 });

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
    const cursor = new PageNumberCursor<Issue>({ fetchPage: async () => [], pageSize: 1 });

    expect((cursor as unknown as Record<string, unknown>).loadMore).toBeUndefined();
  });

  it("reports the end rather than an error when the provider is simply empty", async () => {
    const cursor = new PageNumberCursor<Issue>({ fetchPage: async () => [], pageSize: 2 });

    expect(await cursor.next()).toBeNull();
  });

  it("walks past a page holding only rows the caller may not see", async () => {
    // The shape that truncates GitHub's issue list today: page 1 is entirely dropped rows.
    const pages = [[{ id: 1, open: false }, { id: 2, open: false }], [{ id: 3, open: true }]];
    const cursor = new PageNumberCursor<Issue>({
      fetchPage: async page => pages[page - 1] ?? [],
      retain: items => items.filter(issue => issue.open),
      pageSize: 2,
      remotePageSize: 2,
    });

    expect(ids(await cursor.next())).toEqual([3]);
    expect(await cursor.next()).toBeNull();
  });

  it("bounds one call rather than walking a whole history of dropped pages", async () => {
    const fetchPage = vi.fn(async () => [{ id: 1, open: false }]);
    const cursor = new PageNumberCursor<Issue>(
      { fetchPage, retain: () => [], pageSize: 2, remotePageSize: 1 });

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
    expect(() => new PageNumberCursor<Issue>({ fetchPage, pageSize: 0 })).toThrow(/positive integer/);
    expect(() => new PageNumberCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 0 }))
      .toThrow(/positive integer/);
    expect(() => new PageNumberCursor<Issue>({ fetchPage, pageSize: 2.5 }))
      .toThrow(/positive integer/);
  });
});

describe("OffsetCursor", () => {
  it("advances by the rows returned, so a capping provider skips nothing", async () => {
    const items = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, open: true }));
    // Answers 20 to a request for 100, as jira's silent `maxResults` clamp does. Page arithmetic
    // over this shape would request offsets 0, 100, ... and lose rows 20-99 without an error.
    const fetchPage = vi.fn(async (offset: number) => items.slice(offset, offset + 20));
    const cursor = new OffsetCursor<Issue>({ fetchPage, pageSize: 100, remotePageSize: 100 });

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
    const cursor = new TokenCursor<Issue>({ fetchPage, pageSize: 10, remotePageSize: 25 });

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
    const cursor = new TokenCursor<Issue>({ fetchPage, pageSize: 2 });

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
    const cursor = new TokenCursor<Issue>({ fetchPage, pageSize: 10 });

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
    const cursor = new TokenCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 2 });

    const pages = await Promise.all([cursor.next(), cursor.next(), cursor.next()]);

    expect(pages.map(page => ids(page))).toEqual([[1, 2], [3, 4], [5]]);
    expect(fetchPage.mock.calls.map(([token]) => token)).toEqual([undefined, "a", "b"]);
  });

  it("rejects page sizes that would never terminate", () => {
    const fetchPage = tokenApi([]);
    expect(() => new TokenCursor<Issue>({ fetchPage, pageSize: 0 })).toThrow(/positive integer/);
    expect(() => new TokenCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 1.5 }))
      .toThrow(/positive integer/);
  });
});
