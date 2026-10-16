import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { search } from "../src/search.js";

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
  it("searches the configured gateway with the pinned provider and keeps only the result fields",
      async () => {
    const websearch = vi.fn(respond([{
      url: "https://developers.cloudflare.com/workers/",
      title: "Cloudflare Workers",
      description: "Build serverless applications.",
      lastModifiedDate: "2026-09-30",
      faviconUrl: "https://developers.cloudflare.com/favicon.png",
    }]));

    const results = await search(env(websearch), "workers docs", recorder().audit);

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

    await search({ AI: { websearch } }, "q", recorder().audit);

    expect(websearch).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "default" }));
  });

  it("sends and records nothing for a query outside the API's 1 to 1,024 characters", async () => {
    const websearch = vi.fn(respond([]));
    const { audit, descriptions } = recorder();

    for (const query of ["", "q".repeat(1025)]) {
      await expect(search(env(websearch), query, audit)).rejects.toThrow("1 to 1024 characters");
    }
    await search(env(websearch), "q".repeat(1024), audit);
    expect(websearch).toHaveBeenCalledTimes(1);
    expect(descriptions).toHaveLength(1);
  });

  it("records the exact query", async () => {
    const { audit, descriptions } = recorder();

    await search(env(respond([])), "`code` and **markdown**", audit);

    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toMatchObject({
      fields: [{ label: "Query", kind: "inline", value: "`code` and **markdown**" }],
    });
  });

  it("sends nothing when the record is refused", async () => {
    const websearch = vi.fn(respond([]));

    await expect(search(env(websearch), "q", refuse)).rejects.toThrow("refused");
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
      await expect(search(env(websearch), "q", audit)).rejects.toThrow();
      expect(descriptions).toHaveLength(1);
    }
  });

  it("reports a failed search's status without the provider's body", async () => {
    await expect(search(env(insufficientCredits), "q", recorder().audit))
      .rejects.toThrow(/^Web search failed with HTTP 402\.$/);
  });
});
