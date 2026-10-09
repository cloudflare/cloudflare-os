import type { MobileHandoff } from "@gadgets/workshop-shared/api";

const STATE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_FORM_BYTES = 20_000;

/**
 * Accept a sealed handoff posted to its own installation. A real HTTP redirect, rather than
 * JavaScript navigation to a custom scheme, completes the native authentication session.
 */
export async function mobileLoginCallback(req: Request): Promise<Response> {
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  if (req.method !== "POST" ||
      req.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !==
        "application/x-www-form-urlencoded") {
    return new Response("Invalid mobile login request.", { status: 400, headers });
  }
  const origin = req.headers.get("Origin");
  if (origin !== new URL(req.url).origin) {
    return new Response("Cross-origin mobile login not allowed.", { status: 403, headers });
  }

  const reader = req.body?.getReader();
  if (!reader) return new Response("Invalid mobile login handoff.", { status: 400, headers });
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_FORM_BYTES) {
      await reader.cancel();
      return new Response("Mobile login request too large.", { status: 413, headers });
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  const form = new URLSearchParams(body);
  const expected = ["state", "publicKey", "salt", "iv", "ciphertext"] as const;
  const fields: Record<string, string> = {};
  if ([...form.keys()].length !== expected.length) {
    return new Response("Invalid mobile login handoff.", { status: 400, headers });
  }
  for (const field of expected) {
    const values = form.getAll(field);
    if (values.length !== 1) {
      return new Response("Invalid mobile login handoff.", { status: 400, headers });
    }
    fields[field] = values[0];
  }
  const { state, publicKey, salt, iv, ciphertext } = fields;
  if (!STATE.test(state) || !validBase64URL(publicKey, 87) ||
      !validBase64URL(salt, 43) || !validBase64URL(iv, 16) ||
      !validBase64URL(ciphertext) || ciphertext.length > 16_000) {
    return new Response("Invalid mobile login handoff.", { status: 400, headers });
  }

  const sealed: MobileHandoff = { publicKey, salt, iv, ciphertext };
  const callback = new URL("cloudflare-os://install-connected");
  for (const [name, value] of Object.entries({ state, ...sealed })) {
    callback.searchParams.set(name, value);
  }
  return new Response(null, { status: 303, headers: { ...headers, Location: callback.href } });
}

function validBase64URL(value: string, length?: number): boolean {
  return (length === undefined || value.length === length) && BASE64URL.test(value);
}
