import { afterEach, expect, it, vi } from "vitest";
import { listAccounts } from "../src/ai-gateway-billing/cloudflare/account-service";

const TOKEN = "test-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One `/accounts` page, shaped like Cloudflare's envelope. */
function page(count: number, offset: number, perPage: number, totalCount?: number): Response {
  return Response.json({
    success: true,
    result: Array.from({ length: count }, (_, index) => ({
      id: `id-${offset + index}`,
      name: `account-${offset + index}`,
    })),
    result_info: { page: 1, per_page: perPage, count, total_count: totalCount },
  });
}

it("walks every page rather than stopping at the provider's default page size", async () => {
  // `/accounts` is paginated and defaults to 20 per page, so the unpaginated GET this replaced hid
  // every account after the first 20 -- the user could not pick one of them to bill.
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    urls.push(String(input));
    return urls.length === 1 ? page(50, 0, 50, 57) : page(7, 50, 50, 57);
  }));

  const accounts = await listAccounts(TOKEN);

  expect(accounts).toHaveLength(57);
  expect(accounts.at(-1)).toEqual({ accountId: "id-56", accountName: "account-56" });
  expect(urls[0]).toContain("per_page=50");
  expect(urls[1]).toContain("page=2");
});

it("stops on a short page and on the reported total", async () => {
  const shortPage = vi.fn(async () => page(3, 0, 50));
  vi.stubGlobal("fetch", shortPage);
  expect(await listAccounts(TOKEN)).toHaveLength(3);
  expect(shortPage).toHaveBeenCalledTimes(1);

  const exactPage = vi.fn(async () => page(50, 0, 50, 50));
  vi.stubGlobal("fetch", exactPage);
  expect(await listAccounts(TOKEN)).toHaveLength(50);
  expect(exactPage).toHaveBeenCalledTimes(1);
});

it("caps the walk so a misbehaving provider cannot loop forever", async () => {
  const fetchSpy = vi.fn(async () => page(50, 0, 50, 100_000));
  vi.stubGlobal("fetch", fetchSpy);

  await listAccounts(TOKEN);

  expect(fetchSpy).toHaveBeenCalledTimes(10);
});

it("keeps the accounts gathered before a mid-walk failure", async () => {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    call++;
    return call === 1 ? page(50, 0, 50, 99) : new Response("nope", { status: 500 });
  }));

  // A partial list beats none: the alternative is showing the user no accounts at all.
  expect(await listAccounts(TOKEN)).toHaveLength(50);
});

it("returns no accounts when the first page fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));

  expect(await listAccounts(TOKEN)).toEqual([]);
});
