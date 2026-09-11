import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

const textEncoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodedSegment(value) {
  return bytesToBase64Url(textEncoder.encode(value));
}

function dataUrl(namespace, key, payloadHash) {
  if (payloadHash === undefined) {
    // Legacy layout, retained so metadata written by the first version of this service remains
    // readable. Do not put new payloads here: an overwrite would change the bytes underneath a
    // reader that had already fetched the old metadata.
    return `http://local-storage.invalid/${encodedSegment(namespace)}/${encodedSegment(key)}`;
  }

  // Payloads are immutable and addressed by their content. Publishing the hash in PlatformStorage
  // is therefore the single atomic step that makes a put visible. The marker contains a character
  // outside base64url's alphabet, so it cannot collide with a legacy encoded namespace.
  return `http://local-storage.invalid/@payloads/${encodedSegment(namespace)}/${payloadHash}`;
}

async function bodyBytes(value) {
  if (typeof value === "string") return textEncoder.encode(value);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

async function putFile(files, url, bytes) {
  const response = await files.fetch(url, { method: "PUT", body: bytes });
  if (!response.ok) {
    throw new Error(`Local storage write failed with status ${response.status}.`);
  }
}

async function getFile(files, url) {
  const response = await files.fetch(url);
  if (!response.ok) {
    throw new Error(`Local storage index points to a missing payload (${response.status}).`);
  }
  return response;
}

/** Persistent metadata for the file-backed KV and R2 service fakes. */
export class PlatformStorage extends DurableObject {
  async get(key) {
    return (await this.ctx.storage.kv.get(key)) ?? null;
  }

  async put(key, value) {
    await this.ctx.storage.kv.put(key, value);
  }

  async delete(key) {
    await this.ctx.storage.kv.delete(key);
  }
}

function serviceNamespace(service) {
  const namespace = service.ctx.props?.namespace;
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error("The local storage service needs a namespace prop.");
  }
  return namespace;
}

function metadataFor(service, namespace) {
  return service.ctx.exports.PlatformStorage.getByName(namespace);
}

/** Minimal KVNamespace-compatible API, exposed through a JSRPC service binding. */
export class KvNamespace extends WorkerEntrypoint {
  async get(key, typeOrOptions = "text") {
    const namespace = serviceNamespace(this);
    const metadata = await metadataFor(this, namespace).get(key);
    if (metadata === null) return null;

    const response = await getFile(this.env.DATA, dataUrl(namespace, key, metadata.payloadHash));
    const type = typeof typeOrOptions === "string"
      ? typeOrOptions
      : (typeOrOptions?.type ?? "text");
    switch (type) {
      case "text": return response.text();
      case "json": return response.json();
      case "arrayBuffer": return response.arrayBuffer();
      case "stream": return response.body;
      default: throw new Error(`Unsupported local KV get type: ${type}`);
    }
  }

  async put(key, value) {
    const namespace = serviceNamespace(this);
    const bytes = await bodyBytes(value);
    const payloadHash = await sha256(bytes);
    await putFile(this.env.DATA, dataUrl(namespace, key, payloadHash), bytes);
    await metadataFor(this, namespace).put(key, { size: bytes.byteLength, payloadHash });
  }

  async delete(key) {
    // DiskDirectory intentionally has no delete API. Removing the authoritative index entry makes
    // the object unreachable; its payload may be reused by a later write of the same content.
    await metadataFor(this, serviceNamespace(this)).delete(key);
  }
}

function r2Object(key, bytes, metadata) {
  return {
    key,
    size: bytes.byteLength,
    etag: metadata.etag,
    httpEtag: `"${metadata.etag}"`,
    uploaded: metadata.uploaded,
    httpMetadata: metadata.httpMetadata,
    customMetadata: {},
  };
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Minimal R2Bucket-compatible API, exposed through a JSRPC service binding. */
export class R2Bucket extends WorkerEntrypoint {
  async get(key) {
    const namespace = serviceNamespace(this);
    const metadata = await metadataFor(this, namespace).get(key);
    if (metadata === null) return null;

    const response = await getFile(this.env.DATA, dataUrl(namespace, key, metadata.payloadHash));
    return {
      ...r2Object(key, { byteLength: metadata.size }, metadata),
      body: response.body,
      bodyUsed: false,
    };
  }

  async put(key, value, options = {}) {
    const namespace = serviceNamespace(this);
    const bytes = await bodyBytes(value);
    const payloadHash = await sha256(bytes);
    const metadata = {
      size: bytes.byteLength,
      etag: payloadHash,
      payloadHash,
      uploaded: new Date(),
      httpMetadata: options.httpMetadata ?? {},
    };
    await putFile(this.env.DATA, dataUrl(namespace, key, payloadHash), bytes);
    await metadataFor(this, namespace).put(key, metadata);
    return r2Object(key, bytes, metadata);
  }

  async delete(keys) {
    const metadata = metadataFor(this, serviceNamespace(this));
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      await metadata.delete(key);
    }
  }
}

class AiGateway extends RpcTarget {
  async getLog() {
    // Standalone workerd has no Cloudflare AI Gateway usage ledger. Returning zero keeps the
    // optional platform-gateway accounting path deterministic when an operator enables it.
    return { cost: 0 };
  }
}

const TEXT_DOCUMENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "text/csv",
]);

/** Small Workers AI facade used when the native AI binding is unavailable. */
export class WorkersAi extends WorkerEntrypoint {
  async fetch() {
    return new Response(
      "The local Workers AI fake does not provide AI Gateway inference. Configure a BYOK model.",
      { status: 501 },
    );
  }

  async toMarkdown(file) {
    const type = file.blob.type.split(";", 1)[0].toLowerCase();
    if (!TEXT_DOCUMENT_TYPES.has(type)) {
      return {
        format: "error",
        error: `The local Workers AI fake cannot convert ${type || "this file type"}.`,
      };
    }
    // HTML and XML are valid Markdown inline HTML. Keeping the source intact is deliberately
    // lossless; operators can replace this entrypoint with a richer local converter later.
    return { format: "markdown", data: await file.blob.text() };
  }

  gateway() {
    return new AiGateway();
  }
}

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function contentType(path) {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES.get(dot < 0 ? "" : path.slice(dot).toLowerCase())
    ?? "application/octet-stream";
}

/** Static frontend service with MIME handling and SPA fallback. */
export class StaticAssets extends WorkerEntrypoint {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    let path = new URL(request.url).pathname;
    if (path === "/") path = "/index.html";
    let response = await this.env.ASSETS.fetch(`http://assets.invalid${path}`, {
      method: request.method,
    });
    if (response.status === 404) {
      path = "/index.html";
      response = await this.env.ASSETS.fetch("http://assets.invalid/index.html", {
        method: request.method,
      });
    }

    const headers = new Headers(response.headers);
    headers.set("Content-Type", contentType(path));
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", path === "/index.html"
      ? "no-cache"
      : "public, max-age=31536000, immutable");
    return new Response(response.body, { status: response.status, headers });
  }
}
