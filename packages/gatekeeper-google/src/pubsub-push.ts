// The Pub/Sub push endpoint, `POST {BASE_URL}/pubsub`, shared by Chat and Gmail hooks: Workspace
// Events publishes to the Chat topic and Gmail to the Gmail topic (which may be the same one), and
// every push subscription delivering here authenticates as one service account. A push is routed
// by its shape, not its topic: Workspace Events sets CloudEvents attributes, while a Gmail push has
// none and carries only `{emailAddress, historyId}` as its data.

import { createRemoteJWKSet, jwtVerify } from "jose";
import { ingestChatPush } from "./chat-hooks";
import { ingestGmailPush } from "./gmail-hooks";
import { getBaseUrl, type GoogleOAuthEnv } from "./oauth";

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

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

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
