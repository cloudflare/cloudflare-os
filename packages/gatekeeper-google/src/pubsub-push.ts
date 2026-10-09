// The Pub/Sub push endpoint, `POST {BASE_URL}/pubsub`, shared by Chat and Gmail hooks: Workspace
// Events and Gmail publish to the same topic, whose push subscription authenticates as one
// service account. A push is routed by its shape: Workspace Events sets CloudEvents attributes,
// while a Gmail push has none and carries only `{emailAddress, historyId}` as its data.

import { createRemoteJWKSet, jwtVerify } from "jose";
import { ingestChatPush } from "./chat-hooks";
import { ingestGmailPush } from "./gmail-hooks";
import { getBaseUrl, type GoogleOAuthEnv } from "./oauth";

/** Deployment settings for Google push delivery; Chat and Gmail hooks are unavailable unless both are set. */
export type PushHooksEnv = {
  /** `projects/{project}/topics/{topic}` that Workspace Events and Gmail publish to. */
  PUBSUB_TOPIC?: string;
  /** The service account the topic's push subscription authenticates as. */
  PUBSUB_PUSH_SERVICE_ACCOUNT?: string;
};

/** Whether this deployment has configured push delivery, without which no hook can be subscribed. */
export function pushHooksConfigured(env: PushHooksEnv): boolean {
  return !!env.PUBSUB_TOPIC && !!env.PUBSUB_PUSH_SERVICE_ACCOUNT;
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
  if (!pushHooksConfigured(env)) return new Response("Not Found", { status: 404 });
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
