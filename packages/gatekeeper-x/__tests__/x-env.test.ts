import { describe, expect, it } from "vitest";
import {
  BASE_SCOPES, DEFAULT_DAILY_READ_LIMIT, RESOURCES, RESOURCE_SCOPES, dailyReadLimit, grantedResourcePatterns,
  kindOfPattern, scopesFor, webhookUrl, type Env,
} from "../src/x-env";

describe("scopesFor", () => {
  it("asks for every resource's scopes when no resource types are named", () => {
    const all = new Set(scopesFor());
    for (const scope of [...BASE_SCOPES, ...Object.values(RESOURCE_SCOPES).flat()]) expect(all.has(scope)).toBe(true);
  });

  it("asks for nothing beyond identity and refresh for an empty list", () => {
    expect(scopesFor([]).toSorted()).toEqual([...BASE_SCOPES].toSorted());
  });

  it("asks for only what the named resource types need", () => {
    expect(scopesFor([RESOURCES.profile.urlPattern]).toSorted()).toEqual([...BASE_SCOPES].toSorted());
    expect(scopesFor([RESOURCES.list.urlPattern]).toSorted())
      .toEqual([...BASE_SCOPES, "list.read", "list.write"].toSorted());
    expect(scopesFor([RESOURCES.post.urlPattern])).not.toContain("follows.write");
  });

  it("refuses a resource type that isn't X's", () => {
    expect(() => scopesFor(["https://example.com/*"])).toThrow(/Unknown X resource type/);
  });
});

describe("grantedResourcePatterns", () => {
  it("covers each resource type whose scopes were all granted", () => {
    expect(grantedResourcePatterns([...BASE_SCOPES])).toEqual([RESOURCES.profile.urlPattern]);
    expect(grantedResourcePatterns(scopesFor([RESOURCES.list.urlPattern])))
      .toEqual([RESOURCES.list.urlPattern, RESOURCES.profile.urlPattern]);
    expect(grantedResourcePatterns(scopesFor()).toSorted())
      .toEqual(Object.values(RESOURCES).map(resource => resource.urlPattern).toSorted());
  });

  it("covers nothing without the base scopes", () => {
    expect(grantedResourcePatterns(["tweet.read", "users.read"])).toEqual([]);
  });

  it("round-trips through scopesFor for every resource type", () => {
    for (const resource of Object.values(RESOURCES)) {
      expect(grantedResourcePatterns(scopesFor([resource.urlPattern]))).toContain(resource.urlPattern);
    }
  });
});

describe("kindOfPattern", () => {
  it("names each resource type by its pattern", () => {
    expect(kindOfPattern(RESOURCES.account.urlPattern)).toBe("account");
    expect(kindOfPattern(RESOURCES.post.urlPattern)).toBe("post");
    expect(kindOfPattern("https://x.com/*")).toBeUndefined();
  });
});

describe("webhookUrl", () => {
  const env = (origin: string | undefined, token: string | undefined) =>
    ({ WEBHOOK_ORIGIN: origin, X_APP_BEARER_TOKEN: token, BASE_URL: "https://gadgets.example.com/gatekeeper/x" }) as Env;

  it("is where X delivers once both settings are present", () => {
    expect(webhookUrl(env("https://hooks.example.com", "app-token"))).toBe("https://hooks.example.com/gatekeeper/x/webhook");
    expect(webhookUrl(env("https://Hooks.Example.com/", "app-token"))).toBe("https://hooks.example.com/gatekeeper/x/webhook");
  });

  it("is absent until both are set", () => {
    expect(webhookUrl(env(undefined, "app-token"))).toBeUndefined();
    expect(webhookUrl(env("https://hooks.example.com", undefined))).toBeUndefined();
    expect(webhookUrl(env("https://hooks.example.com", ""))).toBeUndefined();
  });

  it.each(["http://hooks.example.com", "https://hooks.example.com:8443", "https://hooks.example.com/path", "not a url"])(
    "refuses %s, which X would not deliver to", origin => {
      expect(() => webhookUrl(env(origin, "app-token"))).toThrow(/https origin without a port/);
    });
});

describe("dailyReadLimit", () => {
  const env = (value?: string) => ({ X_DAILY_READ_LIMIT: value }) as Env;

  it("defaults, and treats anything unreadable as the default", () => {
    expect(dailyReadLimit(env())).toBe(DEFAULT_DAILY_READ_LIMIT);
    expect(dailyReadLimit(env(""))).toBe(DEFAULT_DAILY_READ_LIMIT);
    expect(dailyReadLimit(env("lots"))).toBe(DEFAULT_DAILY_READ_LIMIT);
    expect(dailyReadLimit(env("-5"))).toBe(DEFAULT_DAILY_READ_LIMIT);
    expect(dailyReadLimit(env("1.5"))).toBe(DEFAULT_DAILY_READ_LIMIT);
  });

  it("takes a deployment's own limit, and 0 as none", () => {
    expect(dailyReadLimit(env(" 500 "))).toBe(500);
    expect(dailyReadLimit(env("0"))).toBeNull();
  });
});
