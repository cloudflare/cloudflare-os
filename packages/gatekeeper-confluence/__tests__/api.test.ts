import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceApi, ConfluenceApiError } from "../src/confluence-api";

const fetchFromNetwork = globalThis.fetch;
const ICON_PATH = "/ex/confluence/cloud/wiki/rest/api/icon/space";
const MEDIA_URL = "https://api.media.atlassian.com/image";
const IMAGE = new Uint8Array([137, 80, 78, 71]);

let server: Server;
let origin: string;
let respond: (request: IncomingMessage, response: ServerResponse) => void;
let requests: { path: string; authorization: string | undefined }[];

beforeEach(async () => {
  requests = [];
  respond = (_request, response) => { response.writeHead(404).end(); };
  server = createServer((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    respond(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listener address.");
  origin = `http://127.0.0.1:${address.port}`;

  // Substitute only the transport destination. Real fetch still handles redirects and streams.
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.atlassian.com" && url.origin !== "https://api.media.atlassian.com") {
      throw new Error(`Unexpected fetch origin: ${url.origin}`);
    }
    return fetchFromNetwork(`${origin}${url.pathname}${url.search}`, init);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

function api() {
  return new ConfluenceApi({ cloudId: "cloud", webBase: "https://site.atlassian.net/wiki", getToken: async () => "test-token" });
}

function serveImage(response: ServerResponse) {
  response.writeHead(200, { "Content-Type": "image/png" }).end(IMAGE);
}

describe("downloadSpaceIcon", () => {
  it("downloads an icon exactly at the byte cap without sending credentials to the media host", async () => {
    respond = (request, response) => {
      if (request.url === ICON_PATH) response.writeHead(302, { Location: MEDIA_URL }).end();
      else serveImage(response);
    };

    await expect(api().downloadSpaceIcon("/wiki/rest/api/icon/space", IMAGE.byteLength)).resolves.toEqual({
      data: IMAGE, mediaType: "image/png",
    });
    expect(requests).toEqual([
      { path: ICON_PATH, authorization: "Bearer test-token" },
      { path: "/image", authorization: undefined },
    ]);
  });

  it("refuses a redirect from the media host without fetching its destination", async () => {
    respond = (request, response) => {
      if (request.url === ICON_PATH) response.writeHead(302, { Location: MEDIA_URL }).end();
      else if (request.url === "/image") response.writeHead(302, { Location: `${origin}/unexpected` }).end();
      else serveImage(response);
    };

    await expect(api().downloadSpaceIcon("/rest/api/icon/space", 4)).rejects.toMatchObject({
      status: 302, constructor: ConfluenceApiError,
    });
    expect(requests.map(request => request.path)).toEqual([ICON_PATH, "/image"]);
  });

  it.each([
    "https://other.example/image",
    "https://api.media.atlassian.com.other.example/image",
    "http://api.media.atlassian.com/image",
  ])("refuses a first-hop redirect to %s before contacting it", async target => {
    respond = (_request, response) => { response.writeHead(302, { Location: target }).end(); };

    await expect(api().downloadSpaceIcon("/rest/api/icon/space", 4)).rejects.toMatchObject({
      status: 502, constructor: ConfluenceApiError,
    });
    expect(requests.map(request => request.path)).toEqual([ICON_PATH]);
  });

  it("refuses an icon whose declared length exceeds the byte cap", async () => {
    respond = (request, response) => {
      if (request.url === ICON_PATH) response.writeHead(302, { Location: MEDIA_URL }).end();
      else response.writeHead(200, { "Content-Type": "image/png", "Content-Length": IMAGE.byteLength }).end(IMAGE);
    };

    await expect(api().downloadSpaceIcon("/rest/api/icon/space", IMAGE.byteLength - 1)).rejects.toMatchObject({
      status: 413, constructor: ConfluenceApiError,
    });
  });

  it("enforces the byte cap while streaming an icon without a declared length", async () => {
    respond = (request, response) => {
      if (request.url === ICON_PATH) response.writeHead(302, { Location: MEDIA_URL }).end();
      else {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.write(IMAGE.subarray(0, 2));
        response.end(IMAGE.subarray(2));
      }
    };

    await expect(api().downloadSpaceIcon("/rest/api/icon/space", IMAGE.byteLength - 1)).rejects.toMatchObject({
      status: 413, constructor: ConfluenceApiError,
    });
  });
});
