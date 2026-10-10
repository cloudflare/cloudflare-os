import { isDeviceHandoffState, type DeviceSessionHandoff } from "./device-session-handoff.js";

const CALLBACK_URL = "https://os.cloudflare.app/oauthredirect";
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

type ConsumeDeviceHandoff = (
  userDoId: string,
  state: string,
  ticket: string,
) => Promise<DeviceSessionHandoff | null>;

/**
 * Check browser navigation metadata and a one-use ticket before delivering the envelope to the
 * claimed HTTPS callback. Access installations additionally pass the verified user's DO id;
 * navigation headers alone do not authenticate a direct Worker request.
 */
export async function deviceSessionCallback(
    req: Request,
    consume: ConsumeDeviceHandoff,
    expectedUserDoId?: string,
): Promise<Response> {
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  const origin = new URL(req.url).origin;
  if (req.method !== "POST" || req.headers.get("Origin") !== origin ||
      req.headers.get("Sec-Fetch-Site") !== "same-origin" ||
      req.headers.get("Sec-Fetch-Mode") !== "navigate" ||
      req.headers.get("Sec-Fetch-Dest") !== "document") {
    return new Response("Invalid device session request.", { status: 403, headers });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("Invalid device session request.", { status: 400, headers });
  }
  const userDoIds = form.getAll("userDoId");
  const states = form.getAll("state");
  const tickets = form.getAll("ticket");
  const userDoId = userDoIds.length === 1 ? userDoIds[0] : null;
  const state = states.length === 1 ? states[0] : null;
  const ticket = tickets.length === 1 ? tickets[0] : null;
  if (typeof userDoId !== "string" || !LOWER_HEX_64.test(userDoId) ||
      typeof state !== "string" || !isDeviceHandoffState(state) ||
      typeof ticket !== "string" || !LOWER_HEX_64.test(ticket)) {
    return new Response("Invalid device session request.", { status: 400, headers });
  }
  if (expectedUserDoId !== undefined && userDoId !== expectedUserDoId) {
    return new Response("Invalid device session owner.", { status: 403, headers });
  }

  const handoff = await consume(userDoId, state, ticket);
  if (!handoff) {
    return new Response("This device session request has expired.", { status: 410, headers });
  }
  const callback = new URL(CALLBACK_URL);
  callback.searchParams.set("cfos_callback", "install-connected");
  for (const [name, value] of Object.entries({ state, ...handoff })) {
    callback.searchParams.set(name, value);
  }
  return new Response(null, {
    status: 303,
    headers: { ...headers, Location: callback.href },
  });
}
