import { describe, expect, it, vi } from "vitest";
import { CursorPager, DEFAULT_MAX_EMPTY_PAGES } from "../src/cursor";
import type { CursorPage, CursorPagerOptions } from "../src/cursor";

/** Serves a fixed script of pages, keyed by the token used to ask for them. */
function pageServer(pages: string[][]) {
  let requested: (string | undefined)[] = [];
  let fetchPage = async (pageToken: string | undefined): Promise<CursorPage<string>> => {
    requested.push(pageToken);
    let index = pageToken === undefined ? 0 : Number(pageToken);
    return {
      items: pages[index] ?? [],
      ...(index + 1 < pages.length ? { nextPageToken: String(index + 1) } : {}),
    };
  };
  return { fetchPage, requested };
}

function makePager(
  pages: string[][],
  overrides: Partial<CursorPagerOptions<string, string>> = {},
) {
  let server = pageServer(pages);
  let authorized: string[][] = [];
  let pager = new CursorPager<string, string>({
    provider: "TestProvider",
    fetchPage: server.fetchPage,
    buildEntries: async items => items,
    authorize: async entries => { authorized.push(entries); },
    ...overrides,
  });
  return { pager, authorized, requested: server.requested };
}

/** Drains a pager, guarding against a cursor that never terminates. */
async function drain(pager: CursorPager<string, string>, limit = 50): Promise<string[]> {
  let all: string[] = [];
  for (let i = 0; i < limit; i++) {
    let page = await pager.next();
    if (page === null) return all;
    all.push(...page);
  }
  throw new Error("cursor did not terminate");
}

describe("paging", () => {
  it("asks for the first page with no token", async () => {
    let { pager, requested } = makePager([["a"]]);
    await pager.next();
    expect(requested).toEqual([undefined]);
  });

  it("walks the pages in order and then ends", async () => {
    let { pager } = makePager([["a"], ["b"], ["c"]]);
    expect(await drain(pager)).toEqual(["a", "b", "c"]);
  });

  it("carries the provider's token into the following request", async () => {
    let { pager, requested } = makePager([["a"], ["b"]]);
    await pager.next();
    await pager.next();
    expect(requested).toEqual([undefined, "1"]);
  });

  it("stops asking once exhausted", async () => {
    let { pager, requested } = makePager([["a"]]);
    await pager.next();
    expect(await pager.next()).toBeNull();
    expect(await pager.next()).toBeNull();
    expect(requested).toEqual([undefined]);
  });

  it("reports the end immediately when the only page is empty", async () => {
    let { pager, authorized } = makePager([[]]);
    expect(await pager.next()).toBeNull();
    expect(authorized).toEqual([]);
  });
});

describe("pages with no usable results", () => {
  it("walks past pages the provider returned empty", async () => {
    let { pager, requested } = makePager([[], [], ["a"]]);
    expect(await pager.next()).toEqual(["a"]);
    expect(requested).toEqual([undefined, "1", "2"]);
  });

  // Drive filters each page against the bound folder, so a page can arrive full and end up empty.
  // That is not the end of the results, and must not be reported as one.
  it("walks past pages that a scope filter emptied", async () => {
    let { pager } = makePager([["skip"], ["skip"], ["keep"]], {
      buildEntries: async items => items.filter(item => item !== "skip"),
    });
    expect(await pager.next()).toEqual(["keep"]);
  });

  it("ends cleanly when the filter discards everything and no pages remain", async () => {
    let { pager } = makePager([["skip"], ["skip"]], {
      buildEntries: async () => [],
    });
    expect(await pager.next()).toBeNull();
  });

  it("gives up after the configured number of fruitless pages", async () => {
    let empty = Array.from({ length: 10 }, () => [] as string[]);
    let { pager } = makePager([...empty, ["a"]], {
      maxEmptyPages: 3,
    });
    await expect(pager.next()).rejects.toThrow(
      "TestProvider returned 3 pages with no usable results.");
  });

  it("defaults the budget to DEFAULT_MAX_EMPTY_PAGES", async () => {
    let pages = Array.from({ length: DEFAULT_MAX_EMPTY_PAGES + 1 }, () => [] as string[]);
    let { pager, requested } = makePager(pages.concat([["a"]]));
    await expect(pager.next()).rejects.toThrow(`returned ${DEFAULT_MAX_EMPTY_PAGES} pages`);
    expect(requested).toHaveLength(DEFAULT_MAX_EMPTY_PAGES);
  });

  it("counts the budget per call, not for the cursor's lifetime", async () => {
    let { pager } = makePager([[], ["a"], [], ["b"]], { maxEmptyPages: 2 });
    expect(await pager.next()).toEqual(["a"]);
    expect(await pager.next()).toEqual(["b"]);
  });
});

describe("malformed provider responses", () => {
  it("refuses a page token identical to the one just sent", async () => {
    let pager = new CursorPager<string, string>({
      provider: "TestProvider",
      fetchPage: async pageToken => ({ items: [], nextPageToken: pageToken ?? "loop" }),
      buildEntries: async items => items,
      authorize: async () => {},
    });
    await expect(pager.next()).rejects.toThrow("TestProvider returned a repeated page token.");
  });

  // A longer cycle is the same bug wearing a hat, and the empty-page cap does not catch it: the
  // pages come back full, so a drain would serve duplicates forever.
  it("refuses a token it followed earlier, not just the one it just sent", async () => {
    let tokens = ["1", "2", "1", "2"];
    let step = 0;
    let pager = new CursorPager<string, string>({
      provider: "TestProvider",
      fetchPage: async () => ({ items: [`p${step}`], nextPageToken: tokens[step++] }),
      buildEntries: async items => items,
      authorize: async () => {},
    });
    expect(await pager.next()).toEqual(["p0"]);
    expect(await pager.next()).toEqual(["p1"]);
    await expect(pager.next()).rejects.toThrow("TestProvider returned a repeated page token.");
  });

  it("still walks a long run of distinct tokens", async () => {
    let pager = makePager(Array.from({ length: 30 }, (_, i) => [`p${i}`])).pager;
    expect(await drain(pager)).toHaveLength(30);
  });
});

describe("authorization", () => {
  it("authorizes each disclosed page with the entries it will return", async () => {
    let { pager, authorized } = makePager([["a", "b"], ["c"]]);
    await drain(pager);
    expect(authorized).toEqual([["a", "b"], ["c"]]);
  });

  it("authorizes the surviving entries, not the raw page", async () => {
    let { pager, authorized } = makePager([["keep", "skip"]], {
      buildEntries: async items => items.filter(item => item !== "skip"),
    });
    await pager.next();
    expect(authorized).toEqual([["keep"]]);
  });

  it("does not ask about pages it walked past", async () => {
    let { pager, authorized } = makePager([[], [], ["a"]]);
    await pager.next();
    expect(authorized).toEqual([["a"]]);
  });

  // A denied read must not consume the page: the caller may retry after getting approval.
  it("leaves the position untouched when disclosure is denied", async () => {
    let denied = true;
    let { pager, requested } = makePager([["a"], ["b"]], {
      authorize: async () => {
        if (denied) throw new Error("denied");
      },
    });

    await expect(pager.next()).rejects.toThrow("denied");
    denied = false;
    expect(await pager.next()).toEqual(["a"]);
    expect(requested).toEqual([undefined, undefined]);
  });

  it("does not mark the cursor exhausted when the final page is denied", async () => {
    let denied = true;
    let { pager } = makePager([["a"]], {
      authorize: async () => {
        if (denied) throw new Error("denied");
      },
    });

    await expect(pager.next()).rejects.toThrow("denied");
    denied = false;
    expect(await pager.next()).toEqual(["a"]);
    expect(await pager.next()).toBeNull();
  });
});

describe("serialization", () => {
  it("never runs two fetches at once", async () => {
    let inFlight = 0;
    let peak = 0;
    let server = pageServer([["a"], ["b"], ["c"]]);
    let pager = new CursorPager<string, string>({
      provider: "TestProvider",
      fetchPage: async token => {
        peak = Math.max(peak, ++inFlight);
        await Promise.resolve();
        inFlight--;
        return server.fetchPage(token);
      },
      buildEntries: async items => items,
      authorize: async () => {},
    });

    await Promise.all([pager.next(), pager.next(), pager.next()]);
    expect(peak).toBe(1);
  });

  it("hands successive pages to callers that did not await", async () => {
    let { pager } = makePager([["a"], ["b"], ["c"]]);
    let pages = await Promise.all([pager.next(), pager.next(), pager.next()]);
    expect(pages).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps serving after a rejected call rather than wedging the queue", async () => {
    let attempt = 0;
    let { pager } = makePager([["a"], ["b"]], {
      authorize: async () => {
        if (attempt++ === 0) throw new Error("denied");
      },
    });

    let [first, second] = await Promise.allSettled([pager.next(), pager.next()]);
    expect(first.status).toBe("rejected");
    expect(second).toMatchObject({ status: "fulfilled", value: ["a"] });
  });
});

describe("buildEntries", () => {
  it("is given the raw items of exactly one page", async () => {
    let buildEntries = vi.fn(async (items: string[]) => items);
    let { pager } = makePager([["a", "b"], ["c"]], { buildEntries });
    await drain(pager);
    expect(buildEntries.mock.calls).toEqual([[["a", "b"]], [["c"]]]);
  });

  it("is not called again once the cursor is exhausted", async () => {
    let buildEntries = vi.fn(async (items: string[]) => items);
    let { pager } = makePager([["a"]], { buildEntries });
    await drain(pager);
    await pager.next();
    expect(buildEntries).toHaveBeenCalledTimes(1);
  });
});
