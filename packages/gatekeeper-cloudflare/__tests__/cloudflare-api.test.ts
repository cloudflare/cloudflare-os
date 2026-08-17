import { afterEach, expect, it, vi } from "vitest";
import { listAccounts } from "../src/cloudflare-api";

const TOKEN = "test-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One `/accounts` page, shaped like Cloudflare's envelope. */
function page(names: string[], perPage: number, totalCount?: number): Response {
  return Response.json({
    success: true,
    result: names.map(name => ({ id: `${name}-id`, name })),
    result_info: { page: 1, per_page: perPage, count: names.length, total_count: totalCount },
  });
}

function names(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) => `account-${offset + index}`);
}

it("walks every page rather than stopping at the provider's default page size", async () => {
  // `/accounts` defaults to 20 per page, so an unpaginated GET silently hides the rest: the accounts
  // beyond the first page could not be selected, and searching for one found nothing.
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    urls.push(String(input));
    return urls.length === 1 ? page(names(50), 50, 62) : page(names(12, 50), 50, 62);
  }));

  const accounts = await listAccounts(TOKEN);

  expect(accounts).toHaveLength(62);
  expect(accounts.at(-1)).toEqual({ accountId: "account-61-id", accountName: "account-61" });
  expect(urls[0]).toContain("page=1");
  expect(urls[0]).toContain("per_page=50");
  expect(urls[1]).toContain("page=2");
});

it("stops on a short page without asking for another", async () => {
  const fetchSpy = vi.fn(async () => page(names(3), 50));
  vi.stubGlobal("fetch", fetchSpy);

  expect(await listAccounts(TOKEN)).toHaveLength(3);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it("stops once the reported total is reached, even on a full page", async () => {
  // A provider that returns exactly `per_page` results on the final page would otherwise cost one
  // extra empty request per call.
  const fetchSpy = vi.fn(async () => page(names(50), 50, 50));
  vi.stubGlobal("fetch", fetchSpy);

  expect(await listAccounts(TOKEN)).toHaveLength(50);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it("honours a page size the provider lowered below the request", async () => {
  let call = 0;
  const fetchSpy = vi.fn(async () => {
    call++;
    return call === 1 ? page(names(20), 20) : page(names(5, 20), 20);
  });
  vi.stubGlobal("fetch", fetchSpy);

  // 20 results is short of the 50 requested, but the provider reported that 20 *was* the page size,
  // so the page is full and the walk must continue. Comparing against the requested size instead
  // would reintroduce the original truncation against any account that caps `per_page`.
  expect(await listAccounts(TOKEN)).toHaveLength(25);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it("keeps the accounts gathered before a mid-walk failure", async () => {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    call++;
    return call === 1 ? page(names(50), 50, 99) : new Response("nope", { status: 500 });
  }));

  // A partial list is more useful than none, and the caller cannot tell a truncated list from a
  // complete one -- so this is deliberately not an error.
  expect(await listAccounts(TOKEN)).toHaveLength(50);
});

it("caps the walk so a misbehaving provider cannot loop forever", async () => {
  // Every page is full and the total is never reached, which without a cap is an infinite walk.
  const fetchSpy = vi.fn(async () => page(names(50), 50, 100_000));
  vi.stubGlobal("fetch", fetchSpy);

  await listAccounts(TOKEN);

  expect(fetchSpy).toHaveBeenCalledTimes(10);
});

it("returns no accounts when the first page fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));

  expect(await listAccounts(TOKEN)).toEqual([]);
});
