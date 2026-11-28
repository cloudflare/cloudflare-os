import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  WEB_SEARCH_IN_MODEL, WEB_SEARCH_PROVIDER_SETTING,
} from "@gadgets/workshop-shared/web-search-gatekeeper";
import { FALLBACK_SETTING, PROVIDER_SETTING, search } from "../src/search.js";

type WebSearch = Ai["websearch"];

function respond(items: unknown[]): WebSearch {
  return async () => Response.json({ items, metadata: { query: "q", requestId: "r", latencyMs: 1 } });
}

const insufficientCredits: WebSearch = async () =>
  new Response("insufficient credits for q", { status: 402 });

function recorder() {
  const descriptions: ObservationDescription[] = [];
  return {
    descriptions,
    audit: async (description: ObservationDescription) => {
      descriptions.push(description);
    },
  };
}

const refuse = async () => { throw new Error("refused"); };

// A gateway other than "default", so a test can tell the configured one was used.
function env(websearch: WebSearch) {
  return { AI: { websearch }, CF_AI_GATEWAY: "instance-ai" };
}

describe("search", () => {
  it("searches the configured gateway with the default provider and keeps only the result fields",
      async () => {
    const websearch = vi.fn(respond([{
      url: "https://developers.cloudflare.com/workers/",
      title: "Cloudflare Workers",
      description: "Build serverless applications.",
      lastModifiedDate: "2026-09-30",
      faviconUrl: "https://developers.cloudflare.com/favicon.png",
    }]));

    const results = await search(env(websearch), {}, "workers docs", recorder().audit);

    expect(websearch).toHaveBeenCalledWith(
        { gatewayId: "instance-ai", query: "workers docs", provider: "ceramic", limit: 10 });
    expect(results).toEqual([{
      url: "https://developers.cloudflare.com/workers/",
      title: "Cloudflare Workers",
      description: "Build serverless applications.",
      lastModifiedDate: "2026-09-30",
    }]);
  });

  it("searches the default gateway when none is configured", async () => {
    const websearch = vi.fn(respond([]));

    await search({ AI: { websearch } }, {}, "q", recorder().audit);

    expect(websearch).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "default" }));
  });

  it("sends and records nothing for a query outside the API's 1 to 1,024 characters", async () => {
    const websearch = vi.fn(respond([]));
    const { audit, descriptions } = recorder();

    for (const query of ["", "q".repeat(1025)]) {
      await expect(search(env(websearch), {}, query, audit)).rejects.toThrow("1 to 1024 characters");
    }
    await search(env(websearch), {}, "q".repeat(1024), audit);
    expect(websearch).toHaveBeenCalledTimes(1);
    expect(descriptions).toHaveLength(1);
  });

  it("records the exact query, restricted by nothing", async () => {
    const { audit, descriptions } = recorder();

    await search(env(respond([])), {}, "`code` and **markdown**", audit);

    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toMatchObject({
      fields: [{ label: "Query", kind: "inline", value: "`code` and **markdown**" }],
      subresources: [],
    });
  });

  it("sends nothing when the record is refused", async () => {
    const websearch = vi.fn(respond([]));

    await expect(search(env(websearch), {}, "q", refuse)).rejects.toThrow("refused");
    expect(websearch).not.toHaveBeenCalled();
  });

  it("keeps the record of a search that fails after it was sent", async () => {
    const failures: WebSearch[] = [
      insufficientCredits,
      async () => { throw new Error("binding unavailable"); },
      async () => Response.json({ unexpected: true }),
    ];
    for (const websearch of failures) {
      const { audit, descriptions } = recorder();
      await expect(search(env(websearch), {}, "q", audit)).rejects.toThrow();
      expect(descriptions).toHaveLength(1);
    }
  });

  it("reports a failed search's status without the provider's body", async () => {
    await expect(search(env(insufficientCredits), {}, "q", recorder().audit))
      .rejects.toThrow(/^Web search failed with HTTP 402\.$/);
  });
});

// What the admin stored: nothing for a setting left at its default.
function stored(provider?: string, fallback?: string): Record<string, string> {
  return {
    ...(provider !== undefined && { [PROVIDER_SETTING.id]: provider }),
    ...(fallback !== undefined && { [FALLBACK_SETTING.id]: fallback }),
  };
}

describe("the admin's Search provider", () => {
  it("is declared under the names the Workshop reads, with a default that is not the model's provider",
      () => {
    expect(PROVIDER_SETTING.id).toBe(WEB_SEARCH_PROVIDER_SETTING);
    expect(PROVIDER_SETTING.defaultValue).not.toBe(WEB_SEARCH_IN_MODEL);
    expect(PROVIDER_SETTING.options.map(option => option.value)).toContain(WEB_SEARCH_IN_MODEL);
    expect(FALLBACK_SETTING.shownWhen)
        .toEqual({ settingId: WEB_SEARCH_PROVIDER_SETTING, value: WEB_SEARCH_IN_MODEL });
    for (const setting of [PROVIDER_SETTING, FALLBACK_SETTING]) {
      expect(setting.options.map(option => option.value)).toContain(setting.defaultValue);
    }
  });

  it("sends each search to the provider that the settings choose, once, and records that provider",
      async () => {
    const cases: [Record<string, string>, string][] = [
      [stored(), "ceramic"],
      [stored("ceramic"), "ceramic"],
      [stored("linkup"), "linkup"],
      [stored("exa"), "exa"],
      // A fallback applies only under the model's provider.
      [stored(undefined, "exa"), "ceramic"],
      [stored("linkup", "exa"), "linkup"],
      [stored("linkup", "none"), "linkup"],
      [stored("linkup", "bing"), "linkup"],
      [stored(WEB_SEARCH_IN_MODEL, "ceramic"), "ceramic"],
      [stored(WEB_SEARCH_IN_MODEL, "linkup"), "linkup"],
      [stored(WEB_SEARCH_IN_MODEL, "exa"), "exa"],
    ];
    for (const [settings, provider] of cases) {
      const websearch = vi.fn(respond([]));
      const { audit, descriptions } = recorder();

      await search(env(websearch), settings, "q", audit);

      expect(websearch.mock.calls, JSON.stringify(settings))
          .toEqual([[expect.objectContaining({ provider, query: "q" })]]);
      expect(descriptions.map(record => record.description), JSON.stringify(settings))
          .toEqual([expect.stringContaining(`"${provider}"`)]);
    }
  });

  it("records and sends nothing under the model's provider with no fallback, and says why",
      async () => {
    const refusal = async (settings: Record<string, string>) => {
      const websearch = vi.fn(respond([]));
      const { audit, descriptions } = recorder();
      const failure = await search(env(websearch), settings, "q", audit)
          .then(() => undefined, (error: unknown) => String(error));
      expect(websearch).not.toHaveBeenCalled();
      expect(descriptions).toEqual([]);
      return failure;
    };

    const noFallback = await refusal(stored(WEB_SEARCH_IN_MODEL));
    expect(noFallback).toBeDefined();
    expect(await refusal(stored(WEB_SEARCH_IN_MODEL, "none"))).toBe(noFallback);
    // The caller is told another thing than for a choice this version does not know.
    expect(await refusal(stored(WEB_SEARCH_IN_MODEL, "bing"))).not.toBe(noFallback);
  });

  it("records and sends nothing for a stored choice it does not know, and uses no default",
      async () => {
    const unknown = [
      stored("bing"), stored(""), stored("MODEL"), stored("Ceramic"), stored("none"),
      stored("bing", "exa"),
      stored(WEB_SEARCH_IN_MODEL, "bing"), stored(WEB_SEARCH_IN_MODEL, ""),
      stored(WEB_SEARCH_IN_MODEL, WEB_SEARCH_IN_MODEL),
    ];
    for (const settings of unknown) {
      const websearch = vi.fn(respond([]));
      const { audit, descriptions } = recorder();

      await expect(search(env(websearch), settings, "q", audit), JSON.stringify(settings))
          .rejects.toThrow();
      expect(websearch).not.toHaveBeenCalled();
      expect(descriptions).toEqual([]);
    }
  });

  it("does not try another provider when a search fails", async () => {
    const websearch = vi.fn(insufficientCredits);

    await expect(search(env(websearch), stored(WEB_SEARCH_IN_MODEL, "exa"), "q", recorder().audit))
        .rejects.toThrow("HTTP 402");
    await expect(search(env(websearch), stored("linkup", "exa"), "q", recorder().audit))
        .rejects.toThrow("HTTP 402");
    expect(websearch.mock.calls.map(([options]) => options.provider)).toEqual(["exa", "linkup"]);
  });
});
