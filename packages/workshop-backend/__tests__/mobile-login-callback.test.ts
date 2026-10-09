import { describe, expect, it } from "vitest";
import { mobileLoginCallback } from "../src/auth/mobile-login-callback";

const origin = "https://install.example.test";
const state = "abcdefab-0000-0000-0000-000000000001";
const fields = {
  state, publicKey: "A".repeat(87), salt: "B".repeat(43),
  iv: "C".repeat(16), ciphertext: "D".repeat(128),
};

function request(body: URLSearchParams, options?: { origin?: string; method?: string }): Request {
  return new Request(`${origin}/api/mobile-login/callback`, {
    method: options?.method ?? "POST",
    headers: {
      Origin: options?.origin ?? origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: options?.method === "GET" ? undefined : body,
  });
}

describe("installation mobile login callback", () => {
  it("redirects the encrypted handoff to the app without exposing credentials", async () => {
    const response = await mobileLoginCallback(request(new URLSearchParams(fields)));
    expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("Location")!);
    expect(callback.protocol).toBe("cloudflare-os:");
    expect(callback.host).toBe("install-connected");
    expect(Object.fromEntries(callback.searchParams)).toEqual(fields);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
  });

  it("rejects cross-origin posts, duplicates, extras, and malformed fields", async () => {
    expect((await mobileLoginCallback(request(new URLSearchParams(fields),
      { origin: "https://other.example.test" }))).status).toBe(403);
    for (const edits of [
      (form: URLSearchParams) => form.append("state", state),
      (form: URLSearchParams) => form.append("next", "https://other.example.test"),
      (form: URLSearchParams) => form.set("ciphertext", "not+base64"),
      (form: URLSearchParams) => form.delete("iv"),
    ]) {
      const form = new URLSearchParams(fields);
      edits(form);
      expect((await mobileLoginCallback(request(form))).status).toBe(400);
    }
    expect((await mobileLoginCallback(request(new URLSearchParams(fields),
      { method: "GET" }))).status).toBe(400);
  });

  it("bounds the handoff size", async () => {
    const form = new URLSearchParams({ ...fields, ciphertext: "D".repeat(20_001) });
    expect((await mobileLoginCallback(request(form))).status).toBe(413);
  });
});
