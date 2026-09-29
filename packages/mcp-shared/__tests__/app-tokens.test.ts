import { expect, it } from "vitest";

import {
  appLinkUrl,
  appTokenKey,
  appTokenPointerKey,
  planAppLink,
  type AppTokenRecord,
} from "../src/app-tokens.js";
import type { AppBinding, AppCallSnapshot } from "../src/apps.js";

const BASE_URL = "https://mcp.example/gatekeeper/mcp";
const ACCOUNT_ID = "a1".repeat(32);
const URI = "ui://events/board";
const NOW = 1_700_000_000_000;

const binding: AppBinding = {
  endpoint: "https://mcp.example/rpc",
  serverName: "Example MCP",
  scope: { tools: ["search_events"] },
  trust: "byo",
};

// The account's storage, held in a map. The mix of a value under a pointer key and a value under a
// token key is what makes both readable below without a cast.
type Links = Map<string, string | AppTokenRecord>;

/**
 * What `account.ts` does with a plan, so a mint can be run repeatedly without a Durable Object: read
 * the pointer, read the record it names, plan, delete what the plan supersedes, write both keys.
 */
function mint(
  links: Links,
  uri: string,
  options: { now: number; title?: string; call?: AppCallSnapshot; binding?: AppBinding },
): { token: string; record: AppTokenRecord; url: string } {
  const minted = options.binding ?? binding;
  const pointerKey = appTokenPointerKey(minted.endpoint, uri);
  const pointer = links.get(pointerKey);
  const named = typeof pointer === "string" ? links.get(appTokenKey(pointer)) : undefined;
  const plan = planAppLink({
    binding: minted,
    resource: { uri, title: options.title },
    call: options.call,
    pointer: typeof pointer === "string" ? pointer : undefined,
    existing: typeof named === "object" ? named : undefined,
    now: options.now,
  });
  if (plan.superseded !== undefined) links.delete(appTokenKey(plan.superseded));
  links.set(appTokenKey(plan.token), plan.record);
  links.set(pointerKey, plan.token);
  return { token: plan.token, record: plan.record, url: appLinkUrl(BASE_URL, ACCOUNT_ID, plan.token) };
}

it("mints one record and one pointer for a resource", () => {
  const links: Links = new Map();
  const { token, record, url } = mint(links, URI, {
    title: "Event board",
    call: { toolName: "search_events", input: { q: "today" }, result: { events: [] } },
    now: NOW,
  });

  // The route only answers a 64-hex token in that position, so a mint that produced any other shape
  // would hand out a link nothing serves.
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(url).toBe(`${BASE_URL}/app/${ACCOUNT_ID}/${token}`);
  expect([...links.keys()].toSorted()).toEqual([
    appTokenKey(token),
    appTokenPointerKey(binding.endpoint, URI),
  ].toSorted());
  expect(record).toEqual({
    binding,
    uri: URI,
    title: "Event board",
    createdAt: NOW,
    expiresAt: record.expiresAt,
    call: { toolName: "search_events", input: { q: "today" }, result: { events: [] } },
  });
});

it("reuses the link a resource already has, and writes no second record", () => {
  const links: Links = new Map();
  const first = mint(links, URI, {
    call: { toolName: "search_events", input: { q: "yesterday" }, result: { events: [] } },
    now: NOW,
  });
  const second = mint(links, URI, {
    call: { toolName: "search_events", input: { q: "today" }, result: { events: [1] } },
    now: NOW + 60_000,
  });

  expect(second.token).toBe(first.token);
  expect(second.url).toBe(first.url);
  // The keys are the whole account's app-link state: a second mint of one resource must not add any.
  expect([...links.keys()].toSorted()).toEqual([
    appTokenKey(first.token),
    appTokenPointerKey(binding.endpoint, URI),
  ].toSorted());
  expect(second.record.call?.input).toEqual({ q: "today" });
});

it("rotates a link that has expired and deletes the record it replaced", () => {
  const links: Links = new Map();
  const first = mint(links, URI, { now: NOW });
  const second = mint(links, URI, { now: first.record.expiresAt });

  expect(second.token).not.toBe(first.token);
  // Nothing points at the old record any more, and storage has no `list`: left behind, it could never
  // be found or removed again.
  expect(links.get(appTokenKey(first.token))).toBeUndefined();
  expect(links.size).toBe(2);
});

it("replaces a live link whose endpoint has since renamed the resource", () => {
  const links: Links = new Map();
  const first = mint(links, URI, { now: NOW });
  // A portal connector asking for namespaced URIs: the stored record names a resource its endpoint
  // no longer answers to, so reusing it would hand back a link that renders nothing.
  const second = mint(links, URI, {
    now: NOW + 1_000,
    binding: { ...binding, resourceUriPrefix: "portal-server_" },
  });

  expect(second.token).not.toBe(first.token);
  expect(links.has(appTokenKey(first.token))).toBe(false);
  expect(second.record.binding.resourceUriPrefix).toBe("portal-server_");
});

it("keeps the records bounded by the resources a binding renders", () => {
  const links: Links = new Map();
  for (const now of [NOW, NOW + 1_000, NOW + 2_000]) mint(links, URI, { now });
  mint(links, "ui://events/detail", { now: NOW });

  // One record and one pointer per resource, however often each was minted.
  expect(links.size).toBe(4);
});

it("drops a result too large for storage rather than the whole link", () => {
  const links: Links = new Map();
  const { token, record } = mint(links, URI, {
    call: { toolName: "search_events", input: { q: "wide" }, result: "x".repeat(200 * 1024) },
    now: NOW,
  });

  expect(record.resultDropped).toBe(true);
  expect(record.call).toEqual({ toolName: "search_events", input: { q: "wide" } });
  expect(links.get(appTokenKey(token))).toBe(record);
});

it("fills the result back in when a later call fits", () => {
  const links: Links = new Map();
  const wide = { toolName: "search_events", input: {}, result: "x".repeat(200 * 1024) };
  expect(mint(links, URI, { call: wide, now: NOW }).record.resultDropped).toBe(true);

  const narrow = mint(links, URI, {
    call: { toolName: "search_events", input: {}, result: { kept: true } },
    now: NOW + 1_000,
  });

  expect(narrow.record.resultDropped).toBeUndefined();
  expect(narrow.record.call?.result).toEqual({ kept: true });
});
