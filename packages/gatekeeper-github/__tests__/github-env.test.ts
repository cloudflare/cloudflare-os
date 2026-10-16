import { describe, expect, it } from "vitest";
import { webhookOrigin, type Env } from "../src/github-env";

const withOrigin = (WEBHOOK_ORIGIN?: string) => ({ WEBHOOK_ORIGIN }) as Env;

describe("webhookOrigin", () => {
  it("leaves GitHub hooks off until a deployment sets it", () => {
    expect(webhookOrigin(withOrigin())).toBeUndefined();
  });

  it("accepts an https origin, with or without a trailing slash", () => {
    expect(webhookOrigin(withOrigin("https://gadgets.example.com"))).toBe("https://gadgets.example.com");
    expect(webhookOrigin(withOrigin("https://Gadgets.Example.com/"))).toBe("https://gadgets.example.com");
  });

  it.each([
    "http://gadgets.example.com",
    "https://gadgets.example.com/gatekeeper/github",
    "https://user:secret@gadgets.example.com",
    "gadgets.example.com",
  ])("refuses %s, which webhooks would not reach safely", origin => {
    expect(() => webhookOrigin(withOrigin(origin))).toThrow("WEBHOOK_ORIGIN must be an https origin");
  });
});
