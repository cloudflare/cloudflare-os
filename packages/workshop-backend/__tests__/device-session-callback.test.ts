import { describe, expect, it, vi } from "vitest";
import type { DeviceSessionHandoff } from "@gadgets/workshop-shared/api";
import { deviceSessionCallback } from "../src/auth/device-session-callback";

const origin = "https://install.example.test";
const state = "ABCDEFab-0000-0000-0000-000000000001";
const handoffId = "a".repeat(64);
const handoff: DeviceSessionHandoff = {
  publicKey: "A".repeat(87),
  salt: "B".repeat(43),
  iv: "C".repeat(16),
  ciphertext: "D".repeat(128),
};

function request(body: URLSearchParams, options?: {
  origin?: string;
  method?: string;
  mode?: string;
  destination?: string;
}): Request {
  return new Request(`${origin}/api/device-session/callback`, {
    method: options?.method ?? "POST",
    headers: {
      Origin: options?.origin ?? origin,
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": options?.mode ?? "navigate",
      "Sec-Fetch-Dest": options?.destination ?? "document",
    },
    body: options?.method === "GET" ? undefined : body,
  });
}

describe("device session callback", () => {
  it("consumes the server-held handoff and redirects to the claimed HTTPS app link", async () => {
    const consume = vi.fn().mockResolvedValue(handoff);
    const response = await deviceSessionCallback(
      request(new URLSearchParams({ handoffId, state })),
      consume,
    );
    expect(consume).toHaveBeenCalledWith(handoffId, state);
    expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("Location")!);
    expect(callback.origin + callback.pathname).toBe("https://os.cloudflare.app/oauthredirect");
    expect(Object.fromEntries(callback.searchParams)).toEqual({
      cfos_callback: "install-connected",
      state,
      ...handoff,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("rejects script fetches, frames, cross-origin posts, and malformed handles", async () => {
    const consume = vi.fn().mockResolvedValue(handoff);
    for (const candidate of [
      request(new URLSearchParams({ handoffId, state }), { mode: "cors" }),
      request(new URLSearchParams({ handoffId, state }), { destination: "iframe" }),
      request(new URLSearchParams({ handoffId, state }), { origin: "https://other.test" }),
      request(new URLSearchParams({ handoffId: "bad", state })),
      request(new URLSearchParams([
        ["handoffId", handoffId], ["state", state], ["state", state],
      ])),
      request(new URLSearchParams({ handoffId, state }), { method: "GET" }),
    ]) {
      expect((await deviceSessionCallback(candidate, consume)).status).toBeGreaterThanOrEqual(400);
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it("reports an already consumed or expired transfer", async () => {
    const response = await deviceSessionCallback(
      request(new URLSearchParams({ handoffId, state })),
      vi.fn().mockResolvedValue(null),
    );
    expect(response.status).toBe(410);
  });
});
