// The Pub/Sub push endpoint, `POST {BASE_URL}/pubsub`, shared by Chat and Gmail hooks: Workspace
// Events publishes to the Chat topic and Gmail to the Gmail topic (which may be the same one), and
// every push subscription delivering here authenticates as one service account. A push is routed
// by its shape, not its topic: Workspace Events sets CloudEvents attributes, while a Gmail push has
// none and carries only `{emailAddress, historyId}` as its data.

import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import { ingestChatPush } from "./chat-hooks";
import { ingestGmailPush } from "./gmail-hooks";
import { getBaseUrl, type GoogleOAuthEnv } from "./oauth";
import { googleUpstream, type NamedOperation } from "./upstream";

/**
 * Deployment settings for Google push delivery. Chat hooks need the Chat topic and Gmail hooks the
 * Gmail topic, each together with the push service account; a hook whose settings are missing is
 * refused.
 */
export type PushHooksEnv = {
  /** `projects/{project}/topics/{topic}` that Workspace Events publishes Chat events to. */
  PUBSUB_CHAT_TOPIC?: string;
  /** `projects/{project}/topics/{topic}` that Gmail publishes mailbox changes to; may be the Chat topic. */
  PUBSUB_GMAIL_TOPIC?: string;
  /** The service account every push subscription delivering to `/pubsub` authenticates as. */
  PUBSUB_PUSH_SERVICE_ACCOUNT?: string;
};

/** Whether this deployment has configured push delivery of Chat events, without which no Chat hook can be subscribed. */
export function chatHooksConfigured(env: PushHooksEnv): boolean {
  return !!env.PUBSUB_CHAT_TOPIC && !!env.PUBSUB_PUSH_SERVICE_ACCOUNT;
}

/** Whether this deployment has configured push delivery of Gmail changes, without which no Gmail hook can be subscribed. */
export function gmailHooksConfigured(env: PushHooksEnv): boolean {
  return !!env.PUBSUB_GMAIL_TOPIC && !!env.PUBSUB_PUSH_SERVICE_ACCOUNT;
}

// The most that is read of the keys' answer. Google publishes a handful of keys in a few KiB: a
// body past this is no key set, and is refused before it is buffered whole.
const JWKS_MAX_BYTES = 256 * 1024;

// Whether a body is the JSON of a key set: an object that holds a list of keys.
function holdsKeys(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    // Each key an object, as jose requires of every entry; which keys it uses is jose's to say.
    return typeof parsed === "object" && parsed !== null && "keys" in parsed && Array.isArray(parsed.keys)
      && parsed.keys.every((key: unknown) => typeof key === "object" && key !== null && !Array.isArray(key));
  } catch {
    return false;
  }
}

// The fetch `jose` downloads the keys with, sent through the upstream as the GET `jose` asks
// for, with no credential. The body of a success is read within the request, so that the request
// is counted by what it holds: one that is no JSON, or holds no list of keys, is an error. `jose`
// is handed that answer all the same, as a copy with the same status, headers and body, and so
// reads, keeps and refuses the keys as it does those of any fetch. An answer of any other status
// is handed on as it came: `jose` reads no body of it.
async function fetchKeys(url: string, init: RequestInit): Promise<Response> {
  const answered = await googleUpstream.read(url, {
    ...init, operation: "certs.get" satisfies NamedOperation, service: "google-oauth",
  }, async response => {
    // A failure is handed on as it came and counted by its status. So is a success that is no 200,
    // which jose refuses without reading it: it is counted an error by its status.
    if (!response.ok) return { response, usable: true };
    if (response.status !== 200) return { response, usable: true, unexpected: true };
    // An answer that has no body is copied with none: a status such as 204 takes no other.
    const bodiless = response.body === null;
    const body = await readTextCapped(response, JWKS_MAX_BYTES);
    const { status, statusText, headers } = response;
    return {
      response: new Response(bodiless ? null : body, { status, statusText, headers }),
      usable: holdsKeys(body),
    };
  }, ({ usable, unexpected }) => unexpected ? { outcome: "error", reason: "http" }
    : usable ? undefined : { outcome: "error", reason: "parse" });
  return answered.response;
}

// The keys Google signs a push's token with, fetched through the upstream so that the fetch is
// counted.
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  [customFetch]: fetchKeys,
});

type PubSubPush = {
  message: { attributes?: Record<string, string>; data?: string };
};

/**
 * Handle one authenticated Pub/Sub push: hand it to the driver it concerns. A 5xx makes Pub/Sub
 * redeliver; anything not about new messages is acknowledged and ignored.
 */
export async function handlePubSubPush(request: Request, env: Cloudflare.Env & GoogleOAuthEnv & PushHooksEnv,
                                       exports: Cloudflare.Exports): Promise<Response> {
  if (!chatHooksConfigured(env) && !gmailHooksConfigured(env)) return new Response("Not Found", { status: 404 });
  try {
    const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
    const { payload } = await jwtVerify(token, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: `${getBaseUrl(env)}/pubsub`,
    });
    if (payload.email !== env.PUBSUB_PUSH_SERVICE_ACCOUNT || payload.email_verified !== true) {
      throw new Error("Unexpected push identity");
    }
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { attributes = {}, data = "" } = (await request.json<PubSubPush>()).message;
  let text: string;
  try {
    text = new TextDecoder().decode(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
  } catch {
    // Acknowledged: redelivering an undecodable payload would only repeat it for the topic's
    // whole retention period.
    return new Response(null, { status: 204 });
  }
  if (attributes["ce-type"] !== undefined) await ingestChatPush(attributes, text, exports);
  else await ingestGmailPush(text, exports);
  return new Response(null, { status: 204 });
}
