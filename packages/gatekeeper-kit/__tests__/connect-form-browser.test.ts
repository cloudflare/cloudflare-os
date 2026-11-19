// The guarded connect form in a real browser. What a browser sends as `Origin` when it posts a
// form depends on the page's `Referrer-Policy`, which no test that builds its own `Request` can
// see: a form served through `htmlResponse` renders correctly and can never be submitted. Needs
// Chromium (`playwright install chromium`, see docs/testing.md).

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONNECT_FORM_NONCE_FIELD, connectFormHtml, formPageResponse, htmlResponse, readConnectForm,
} from "../src/connect-pages";

const NONCE = "f".repeat(64);

/** What the server saw of each submission: the `Origin` the browser sent and the fields it read. */
type Submission = { origin: string | undefined; fields: Record<string, string> | undefined };

let server: Server;
let browser: Browser;
let page: Page;
/** The gatekeeper's configured base URL, on `127.0.0.1`. */
let baseUrl: string;
/** The same server under another origin, standing in for another site. */
let otherSite: string;
const submissions: Submission[] = [];

/** The form, posting to the gatekeeper's own `/key` whichever origin serves the page. */
const form = (): string => connectFormHtml({
  title: "Connect Vendor", intro: "Paste a key.", action: `${baseUrl}/key`, nonce: NONCE,
  fields: [{ name: "key", label: "API key", secret: true }],
});

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  return new Request(`${baseUrl}${incoming.url}`, {
    method: incoming.method, headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function respond(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/form") return formPageResponse(form());
  // The mistake `formPageResponse` exists to prevent.
  if (pathname === "/form-without-referrer") return htmlResponse(form());
  // Another site's copy of the form, served as a site that wants its origin sent would serve it.
  if (pathname === "/copied-form") return new Response(form(), { headers: { "Content-Type": "text/html" } });
  if (pathname === "/key") {
    const read = await readConnectForm(req, { origin: baseUrl });
    const refused = read instanceof Response;
    submissions.push({
      origin: req.headers.get("Origin") ?? undefined,
      fields: refused ? undefined : Object.fromEntries(read),
    });
    return refused ? read : htmlResponse("<!DOCTYPE html><title>Accepted</title><h1>Accepted</h1>");
  }
  return new Response("Not found", { status: 404 });
}

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    void toRequest(incoming).then(respond).then(async response => {
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    }).catch((error: unknown) => {
      // Answered, so a broken handler fails the test at once instead of at the browser's timeout.
      outgoing.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  otherSite = `http://localhost:${port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});

afterEach(async () => {
  await page?.close();
  submissions.length = 0;
});

/** Opens `url`, types a key into the form and submits it; resolves with the page that answers. */
async function submitFrom(url: string): Promise<{ status: number | undefined; heading: string }> {
  page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  await page.goto(url);
  await page.getByLabel("API key").fill("s3cret key&=");
  const [response] = await Promise.all([
    page.waitForResponse(posted => posted.request().method() === "POST"),
    page.getByRole("button", { name: "Connect" }).click(),
  ]);
  // The answer is a new document: wait for it, so the heading read is not the form's own.
  await page.waitForURL(`${baseUrl}/key`);
  return { status: response.status(), heading: await page.getByRole("heading").innerText() };
}

describe("the connect form in Chromium", () => {
  it("submits from a page served with formPageResponse", async () => {
    const answer = await submitFrom(`${baseUrl}/form`);
    expect(answer).toEqual({ status: 200, heading: "Accepted" });
    expect(submissions).toEqual([{
      origin: baseUrl,
      fields: { [CONNECT_FORM_NONCE_FIELD]: NONCE, key: "s3cret key&=" },
    }]);
  });

  it("masks the key and focuses it", async () => {
    page = await browser.newPage();
    await page.goto(`${baseUrl}/form`);
    const key = page.getByLabel("API key");
    expect(await key.getAttribute("type")).toBe("password");
    // A string, because this package's sources are not typed against the DOM.
    expect(await page.evaluate("document.activeElement?.id")).toBe("key");
  });

  // Why the form is not served through `htmlResponse`: under `no-referrer` the browser names no
  // origin, and the guard cannot tell the gatekeeper's own page from anyone else's.
  it("cannot submit from a page served with htmlResponse", async () => {
    const answer = await submitFrom(`${baseUrl}/form-without-referrer`);
    expect(answer).toEqual({ status: 403, heading: "Connection failed" });
    expect(submissions).toEqual([{ origin: "null", fields: undefined }]);
  });

  it("refuses a copy of the form posted from another site", async () => {
    const answer = await submitFrom(`${otherSite}/copied-form`);
    expect(answer).toEqual({ status: 403, heading: "Connection failed" });
    expect(submissions).toEqual([{ origin: otherSite, fields: undefined }]);
  });
});
