import type { JWTPayload } from "jose";
import type { ApiSessionDurableObject } from "./server.js";

// Kept out of server.ts: the Worker's main module may export only handlers and classes, and
// workerd refuses to start a Worker whose main module exports a plain value.

/** The Cloudflare Access session the fetch handler verified for an API connection. */
export type ApiAccessSession = { payload: JWTPayload; jwt: string; email: string };

/**
 * Carries the verified Cloudflare Access session from the fetch handler to the session object.
 * Only the fetch handler can reach the object (it has no route of its own), and it always sets
 * this header itself, so a client cannot supply it.
 */
export const API_SESSION_HEADER = "X-Gadgets-Api-Session";

/**
 * Hands a WebSocket upgrade to a fresh ApiSessionDurableObject, with the Access session the fetch
 * handler verified (null when Access is off). The object is created next to this isolate.
 */
export function openApiSessionObject(
    req: Request, sessions: DurableObjectNamespace<ApiSessionDurableObject>,
    accessSession: ApiAccessSession | undefined): Promise<Response> {
  let headers = new Headers(req.headers);
  headers.set(API_SESSION_HEADER, JSON.stringify(accessSession ?? null));
  return sessions.get(sessions.newUniqueId()).fetch(new Request(req, { headers }));
}

