import { afterEach, describe, expect, it, vi } from "vitest";
import {
  XApi, XApiError, XCreditsError, XRateLimitError, XTransportError, billableResources, isOutcomeUnknown,
  isXAuthError, pageQuery, requireData, xTime,
} from "../src/x-api";

function respond(status: number, body?: unknown, headers: Record<string, string> = {}): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
    { status, headers })));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

afterEach(() => vi.unstubAllGlobals());

describe("XApi requests", () => {
  it("sends the bearer token and only the query values given", async () => {
    respond(200, { data: [] });
    await new XApi("token-1").get("/2/users/1/tweets", { max_results: 5, pagination_token: undefined });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.x.com/2/users/1/tweets?max_results=5");
    expect(init).toMatchObject({ method: "GET", redirect: "manual", headers: { Authorization: "Bearer token-1" } });
  });

  it("posts JSON", async () => {
    respond(201, { data: { id: "5", text: "hi" } });
    const envelope = await new XApi("t").post<{ id: string }>("/2/tweets", { text: "hi" });
    expect(envelope.data?.id).toBe("5");
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ text: "hi" }) });
    expect(new Headers(init!.headers).get("Content-Type")).toBe("application/json");
  });

  it("uploads an image as multipart, as a post image", async () => {
    respond(200, { data: { id: "1880028106020515840", media_key: "3_1880028106020515840" } });
    const id = await new XApi("t").uploadImage(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");
    expect(id).toBe("1880028106020515840");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.x.com/2/media/upload");
    const form = init?.body as FormData;
    expect(form.get("media_category")).toBe("tweet_image");
    expect((form.get("media") as Blob).type).toBe("image/jpeg");
  });

  it("refuses an upload that names no media", async () => {
    respond(200, { data: {} });
    expect(await failure(new XApi("t").uploadImage(new Uint8Array([1]), "image/png"))).toBeInstanceOf(XApiError);
  });
});

describe("XApi failures", () => {
  it("reads a 429 as the rate limit, with when it resets", async () => {
    const reset = Date.UTC(2026, 9, 10, 14, 30) / 1000;
    respond(429, { title: "Too Many Requests" }, { "x-rate-limit-reset": String(reset) });
    const error = await failure(new XApi("t").get("/2/users/me"));
    expect(error).toBeInstanceOf(XRateLimitError);
    expect((error as XRateLimitError).resetAt).toBe(reset * 1000);
    expect((error as Error).message).toContain("14:30 UTC");
  });

  it("reads exhausted credits as such, whatever the status", async () => {
    respond(402, { title: "Payment Required" });
    expect(await failure(new XApi("t").get("/2/users/me"))).toBeInstanceOf(XCreditsError);
    respond(429, { type: "https://api.twitter.com/2/problems/usage-capped", title: "Usage capped" });
    expect(await failure(new XApi("t").get("/2/users/me"))).toBeInstanceOf(XCreditsError);
  });

  it("tells a credential rejection from a refusal", async () => {
    respond(401, { title: "Unauthorized", detail: "Unauthorized" });
    const unauthorized = await failure(new XApi("t").get("/2/users/me"));
    expect(isXAuthError(unauthorized)).toBe(true);
    respond(403, { detail: "You are not allowed to create a Tweet with duplicate content." });
    const duplicate = await failure(new XApi("t").post("/2/tweets", { text: "x" }));
    expect(isXAuthError(duplicate)).toBe(false);
    expect((duplicate as XApiError).isDuplicate).toBe(true);
    expect((duplicate as Error).message).toBe("X: You are not allowed to create a Tweet with duplicate content.");
  });

  it("never follows a redirect", async () => {
    respond(302, undefined, { location: "https://elsewhere.example/" });
    const error = await failure(new XApi("t").get("/2/users/me"));
    expect((error as XApiError).status).toBe(302);
  });

  it("reads a lost answer as an unknown outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network connection lost"); }));
    const lost = await failure(new XApi("t").post("/2/tweets", { text: "x" }));
    expect(lost).toBeInstanceOf(XTransportError);
    expect(isOutcomeUnknown(lost)).toBe(true);
    respond(503, "upstream unavailable");
    expect(isOutcomeUnknown(await failure(new XApi("t").post("/2/tweets", { text: "x" })))).toBe(true);
    respond(400, { detail: "bad" });
    expect(isOutcomeUnknown(await failure(new XApi("t").post("/2/tweets", { text: "x" })))).toBe(false);
  });

  it("refuses a success that is not JSON", async () => {
    respond(200, "<html>");
    expect((await failure(new XApi("t").get("/2/users/me")) as XApiError).status).toBe(502);
  });
});

describe("requireData", () => {
  it("reads X's in-band errors as not found or not visible", () => {
    expect(() => requireData({ errors: [{ type: "https://api.twitter.com/2/problems/resource-not-found" }] }, "post"))
      .toThrow(expect.objectContaining({ status: 404, message: "X has no post with that ID, or it was deleted." }));
    expect(() => requireData({ errors: [{ type: "https://api.twitter.com/2/problems/not-authorized-for-resource" }] }, "post"))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(requireData({ data: { id: "1" } }, "post")).toEqual({ id: "1" });
  });
});

describe("helpers", () => {
  it("clamps page sizes into each endpoint's bounds", () => {
    expect(pageQuery(5, undefined, { min: 10, max: 100 }, "next_token")).toEqual({ max_results: 10 });
    expect(pageQuery(500, "abc", { min: 1, max: 100 })).toEqual({ max_results: 100, pagination_token: "abc" });
    expect(pageQuery(20, "abc", { min: 10, max: 100 }, "next_token")).toEqual({ max_results: 20, next_token: "abc" });
  });

  it("counts what X bills: rows and expanded users and posts", () => {
    expect(billableResources({ data: [{}, {}], includes: { users: [{ id: "1" }], tweets: [{ id: "2" }] } })).toBe(4);
    expect(billableResources({ data: { id: "1" } })).toBe(1);
    expect(billableResources({ errors: [{}] })).toBe(0);
  });

  it("formats times as X takes them", () => {
    expect(xTime(new Date("2026-10-10T12:34:56.789Z"))).toBe("2026-10-10T12:34:56Z");
  });
});
