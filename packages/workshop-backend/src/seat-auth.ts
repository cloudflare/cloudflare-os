// Thin forwarder to the seat proxy, which owns all provider OAuth.
//
// Cloudflare OS never sees a provider token: enrollment returns an opaque handle
// that is stored as an ordinary AiModelConfig.apiToken and sent where an API key
// would go. Everything here is one HTTP call and a shape translation.

import type { SeatProvider, SeatStartResult, SeatCompleteResult }
  from "@gadgets/workshop-shared/seat-types";

type FetchLike = typeof fetch;

// Narrow env type, matching the Pick<Cloudflare.Env, ...> convention used elsewhere in this
// package (e.g. blueprint-archive.ts, format-blueprints.ts) instead of the ambient global `Env`,
// which is the raw wrangler-generated type and doesn't carry the env.d.ts augmentations.
type SeatAuthEnv = Pick<Cloudflare.Env, "SEAT_PROXY_URL">;

export function seatProxyUrl(env: SeatAuthEnv): string {
  const url = env.SEAT_PROXY_URL;
  if (!url) throw new Error("Seat sign-in is not configured on this server.");
  return url.replace(/\/+$/, "");
}

// The proxy rejects any owner that is not already case-folded: on a case-insensitive
// filesystem "Alice" and "alice" would be the same credential directory while the
// proxy's own lookup stayed case-sensitive, which was a real cross-user hijack.
// Cloudflare OS usernames are not guaranteed lowercase, so fold here.
function ownerHeader(owner: string): Record<string, string> {
  return { "X-Seat-Owner": owner.toLowerCase() };
}

async function readJson(response: Response, what: string): Promise<any> {
  if (!response.ok) {
    // Deliberately does not include the body: it comes from another service and
    // must not be echoed into a user-facing error.
    throw new Error(`Seat ${what} failed (${response.status}).`);
  }
  return await response.json();
}

export async function startSeatAuth(
    env: SeatAuthEnv, owner: string, provider: SeatProvider,
    fetchImpl: FetchLike = fetch): Promise<SeatStartResult> {
  const base = seatProxyUrl(env);
  const response = await fetchImpl(`${base}/enroll/${provider}/start`, {
    method: "POST",
    headers: { ...ownerHeader(owner) },
  });
  const body = await readJson(response, "sign-in");
  if (body.kind === "device_code") {
    return {
      enrollId: body.enroll_id,
      kind: "device_code",
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      interval: body.interval,
    };
  }
  return { enrollId: body.enroll_id, kind: "authorize_url", url: body.url };
}

export async function completeSeatAuth(
    env: SeatAuthEnv, owner: string, provider: SeatProvider, enrollId: string,
    code: string | undefined,
    fetchImpl: FetchLike = fetch): Promise<SeatCompleteResult> {
  const base = seatProxyUrl(env);
  const response = await fetchImpl(`${base}/enroll/${provider}/complete`, {
    method: "POST",
    headers: { ...ownerHeader(owner), "content-type": "application/json" },
    body: JSON.stringify(code === undefined
      ? { enroll_id: enrollId }
      : { enroll_id: enrollId, code }),
  });
  const body = await readJson(response, "sign-in");
  if (body.status === "pending") return { status: "pending" };
  return {
    status: "complete",
    handle: body.handle,
    models: body.models ?? [],
    // The relay mount matching the provider. The frontend stores this as the
    // model's apiUrl so inference is routed through the proxy.
    apiUrl: `${base}/${provider}`,
  };
}

export async function revokeSeat(
    env: SeatAuthEnv, owner: string, handle: string,
    fetchImpl: FetchLike = fetch): Promise<void> {
  const base = seatProxyUrl(env);
  const response = await fetchImpl(`${base}/enroll/${handle}`, {
    method: "DELETE",
    headers: { ...ownerHeader(owner) },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Seat revocation failed (${response.status}).`);
  }
}
