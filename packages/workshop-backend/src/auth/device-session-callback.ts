import type { DeviceSessionHandoff } from "@gadgets/workshop-shared/api";
import { isDeviceHandoffState } from "./device-session-handoff.js";

const CALLBACK_URL = "https://os.cloudflare.app/oauthredirect";
const HANDOFF_ID = /^[0-9a-f]{64}$/;

type ConsumeDeviceHandoff = (
  handoffId: string,
  state: string,
) => Promise<DeviceSessionHandoff | null>;

/**
 * Consume a staged transfer only from a same-origin top-level form navigation, then deliver its
 * encrypted envelope to the native app's claimed HTTPS callback. Page JavaScript never receives
 * the envelope or a credential, and the staged transfer is spent before the redirect leaves.
 */
export async function deviceSessionCallback(
    req: Request,
    consume: ConsumeDeviceHandoff,
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
  const handoffIds = form.getAll("handoffId");
  const states = form.getAll("state");
  const handoffId = handoffIds.length === 1 ? handoffIds[0] : null;
  const state = states.length === 1 ? states[0] : null;
  if (typeof handoffId !== "string" || !HANDOFF_ID.test(handoffId) ||
      typeof state !== "string" || !isDeviceHandoffState(state)) {
    return new Response("Invalid device session request.", { status: 400, headers });
  }

  const handoff = await consume(handoffId, state);
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
