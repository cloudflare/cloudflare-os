// The resource URL patterns, the server-side parser and the configurators each describe X's URLs,
// and none can share code: the patterns are strings the Workshop matches, and each configurator is
// transpiled alone by `scripts/build-gatekeeper-configurator.ts`, with no runtime imports. This test
// keeps the three in step. A URL resolves, through the same function the Workshop uses, to the
// resource the parser makes of it; and every configurator's resource URL resolves back to the
// resource it configures, naming what the user entered.

import { describe, expect, it } from "vitest";
import { resolveRequestedResource } from "@gadgets/workshop-shared/gatekeeper";
import accountConfigurator from "../src/configurator/x-account-configurator-ui.js";
import listConfigurator from "../src/configurator/x-list-configurator-ui.js";
import postConfigurator from "../src/configurator/x-post-configurator-ui.js";
import profileConfigurator from "../src/configurator/x-profile-configurator-ui.js";
import { ACCOUNT_URL, ALL_RESOURCES, RESOURCES, kindOfPattern } from "../src/x-env";
import { parseUsernameRef, parseXUrl } from "../src/x-urls";

// None of these configurators may ask the gatekeeper anything to build or pre-fill a URL.
const ui = new Proxy({}, {
  get(_target, property) { throw new Error(`the configurator must not call ui.${String(property)}`); },
}) as never;

function resolvedKind(url: string): string | undefined {
  const result = resolveRequestedResource(ALL_RESOURCES, url);
  return result.ok ? kindOfPattern(result.resource.urlPattern) : undefined;
}

const POSTS = [
  "https://x.com/jack/status/20",
  "https://twitter.com/jack/status/20",
  "https://www.x.com/jack/status/20",
  "https://mobile.twitter.com/jack/status/20",
  "https://x.com/jack/status/20?s=20&t=abcdef",
  "https://x.com/jack/status/20/photo/1",
  "https://x.com/jack/status/20/",
  "https://x.com/i/web/status/20",
  "https://x.com/i/status/20",
];
const LISTS = [
  "https://x.com/i/lists/1234",
  "https://twitter.com/i/lists/1234/members",
  "https://www.x.com/i/lists/1234/",
];
const PROFILES = [
  "https://x.com/jack",
  "https://x.com/jack/",
  "https://twitter.com/Jack_Dorsey",
  "https://www.x.com/jack",
  "https://mobile.x.com/jack",
  ...["with_replies", "media", "highlights", "articles", "followers", "following", "verified_followers"]
    .map(tab => `https://x.com/jack/${tab}`),
];

describe("URLs resolve to the resource the parser makes of them", () => {
  it.each([...POSTS, ...LISTS, ...PROFILES])("%s", url => {
    const parsed = parseXUrl(url);
    expect(parsed).not.toBeNull();
    expect(resolvedKind(url)).toBe(parsed!.kind);
  });

  it("resolves the account's own URL, and the bare site, to the whole account", () => {
    expect(resolvedKind(ACCOUNT_URL)).toBe("account");
    expect(parseXUrl(ACCOUNT_URL)).toEqual({ kind: "account" });
    expect(resolvedKind("https://x.com")).toBe("account");
    expect(resolvedKind("https://x.com/")).toBe("account");
  });

  it("never binds a page X reserves, though the profile pattern admits its shape", () => {
    // The pattern can't list X's reserved pages portably, so the Workshop may offer the profile
    // resource; the parser behind getGatekeeperClassFor refuses the binding, and so does the form.
    for (const url of ["https://x.com/home", "https://x.com/explore", "https://x.com/settings"]) {
      expect(parseXUrl(url)).toBeNull();
      expect(profileConfigurator.isReady!({ values: { username: new URL(url).pathname.slice(1) } })).toBe(false);
    }
  });

  it("matches nothing of X's on other hosts", () => {
    for (const url of ["https://docs.x.com/jack", "https://developer.x.com/en/docs", "https://example.com/jack/status/20"]) {
      expect(resolvedKind(url)).toBe("account");
      expect(parseXUrl(url)).toBeNull();
    }
  });
});

describe("the account configurator", () => {
  it("binds the whole account by a URL that names no user", async () => {
    const url = await accountConfigurator.resourceUrl();
    expect(url).toBe(ACCOUNT_URL);
    expect(resolvedKind(url)).toBe("account");
  });
});

describe("the post configurator", () => {
  it.each([...POSTS, "20"])("binds the post %s names", async input => {
    expect(postConfigurator.isReady!({ values: { postUrl: input } })).toBe(true);
    const url = await postConfigurator.resourceUrl({ values: { postUrl: input }, ui });
    expect(parseXUrl(url)).toEqual({ kind: "post", postId: "20" });
    expect(resolvedKind(url)).toBe("post");
  });

  it("pre-fills to the same resource URL it builds", async () => {
    for (const input of POSTS) {
      const url = await postConfigurator.resourceUrl({ values: { postUrl: input }, ui });
      const values = await postConfigurator.initialValuesFromResourceUrl!({
        resourceUrl: url, resourceUrlPattern: RESOURCES.post.urlPattern, ui,
      });
      expect(await postConfigurator.resourceUrl({ values, ui })).toBe(url);
    }
  });

  it.each(["", "https://x.com/jack", "https://x.com/i/lists/1234", "https://docs.x.com/jack/status/20", "abc"])(
    "isn't ready for %j", input => {
      expect(postConfigurator.isReady!({ values: { postUrl: input } })).toBe(false);
    });
});

describe("the profile configurator", () => {
  const inputs = [
    "jack", "@jack", "Jack_Dorsey", "https://x.com/jack", "https://twitter.com/jack/media", "@this_handle_is_too_long",
    "home", "@settings", "https://x.com/jack/status/20", "https://x.com/jack/likes", "has space", "", "@",
  ];

  it.each(inputs)("agrees with the server about %j", async input => {
    let expected: string | null;
    try {
      expected = parseUsernameRef(input);
    } catch {
      expected = null;
    }
    expect(profileConfigurator.isReady!({ values: { username: input } })).toBe(expected !== null);
    if (expected !== null) {
      const url = await profileConfigurator.resourceUrl({ values: { username: input }, ui });
      expect(parseXUrl(url)).toEqual({ kind: "profile", username: expected });
      expect(resolvedKind(url)).toBe("profile");
    }
  });

  it("is pre-filled by the runtime from the pattern's username group", async () => {
    for (const url of PROFILES) {
      const username = new URLPattern(RESOURCES.profile.urlPattern).exec(url.replace(/\/$/, ""))?.pathname.groups.username;
      expect(parseXUrl(url)).toEqual({ kind: "profile", username });
      expect(await profileConfigurator.resourceUrl({ values: { username }, ui })).toBe(`https://x.com/${username}`);
    }
  });
});

describe("the List configurator", () => {
  it("binds the chosen List", async () => {
    const url = await listConfigurator.resourceUrl({ values: { listId: "1234" }, ui });
    expect(parseXUrl(url)).toEqual({ kind: "list", listId: "1234" });
    expect(resolvedKind(url)).toBe("list");
    expect(listConfigurator.isReady!({ values: { listId: null } })).toBe(false);
  });

  it("is pre-filled by the runtime from the pattern's listId group", () => {
    for (const url of LISTS) {
      const listId = new URLPattern(RESOURCES.list.urlPattern).exec(url.replace(/\/$/, ""))?.pathname.groups.listId;
      expect(listId).toBe("1234");
    }
  });
});
