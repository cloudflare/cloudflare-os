import { describe, expect, it } from "vitest";
import { NEXT_UI_VARIANT, UI_VARIANT_COOKIE } from "@gadgets/workshop-shared/feature-flags";
import { serveWorkshopPage } from "../src/ui-variant.js";

const ORIGIN = "https://workshop.example";
const NEXT_COOKIE = `${UI_VARIANT_COOKIE}=${NEXT_UI_VARIANT}`;
const HTML = "text/html,application/xhtml+xml,*/*;q=0.8";

// Assets that answer each request with the path it was asked for, and remember what it was asked.
function fakeAssets() {
  let requests: Request[] = [];
  let assets = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      let req = new Request(input, init);
      requests.push(req);
      return new Response(new URL(req.url).pathname, { headers: { "Content-Type": "text/plain" } });
    },
  } as Fetcher;
  return { assets, requests };
}

async function serve(path: string, init: { method?: string; accept?: string; cookie?: string } = {}) {
  let headers = new Headers();
  if (init.accept !== undefined) headers.set("Accept", init.accept);
  if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
  let { assets, requests } = fakeAssets();
  let response = await serveWorkshopPage(
      new Request(ORIGIN + path, { method: init.method ?? "GET", headers }), assets);
  return { response, requests, body: init.method === "HEAD" ? "" : await response.text() };
}

describe("serveWorkshopPage", () => {
  it("serves the old UI's page without the cookie", async () => {
    let { body, response } = await serve("/workspace/abc", { accept: HTML });
    expect(body).toBe("/workspace/abc");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it("serves the new UI's page with the cookie, among other cookies", async () => {
    let { body, response, requests } = await serve("/workspace/abc",
        { accept: HTML, cookie: `a=b; ${NEXT_COOKIE}; c=d` });
    expect(body).toBe("/next");
    expect(requests[0].headers.get("Accept")).toBe(HTML);
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it("serves the new UI's page at the root", async () => {
    expect((await serve("/", { accept: HTML, cookie: NEXT_COOKIE })).body).toBe("/next");
  });

  it("keeps a HEAD request a HEAD", async () => {
    let { requests } = await serve("/", { method: "HEAD", accept: HTML, cookie: NEXT_COOKIE });
    expect(requests[0].method).toBe("HEAD");
    expect(new URL(requests[0].url).pathname).toBe("/next");
  });

  it("ignores another value of the cookie", async () => {
    expect((await serve("/", { accept: HTML, cookie: `${UI_VARIANT_COOKIE}=classic` })).body).toBe("/");
  });

  it("passes a file through untouched, cookie or not", async () => {
    let { body, response } = await serve("/favicon.svg", { accept: HTML, cookie: NEXT_COOKIE });
    expect(body).toBe("/favicon.svg");
    expect(response.headers.get("Vary")).toBeNull();
  });

  it("passes a request that is not for HTML through untouched", async () => {
    let { body, response } = await serve("/workspace/abc", { accept: "*/*", cookie: NEXT_COOKIE });
    expect(body).toBe("/workspace/abc");
    expect(response.headers.get("Vary")).toBeNull();
  });

  it("passes a POST through untouched", async () => {
    let { body } = await serve("/workspace/abc", { method: "POST", accept: HTML, cookie: NEXT_COOKIE });
    expect(body).toBe("/workspace/abc");
  });
});
