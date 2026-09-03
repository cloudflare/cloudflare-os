import { describe, expect, it } from "vitest";
import { normalizeVendorEndpoint } from "../src/endpoint";

const hostPattern = /^[a-z0-9-]+\.mktorest\.com$/i;
const label = "Marketo REST endpoint";

describe("normalizeVendorEndpoint", () => {
  it("preserves the path and drops the query and fragment", () => {
    expect(normalizeVendorEndpoint(
      "https://123-abc.mktorest.com/rest/v1/?access_token=secret#part",
      { hostPattern, label },
    )).toBe("https://123-abc.mktorest.com/rest/v1");
  });

  it("requires HTTPS by default", () => {
    expect(() => normalizeVendorEndpoint("http://123-abc.mktorest.com", { hostPattern, label }))
      .toThrow("Marketo REST endpoint must use https.");
  });

  it("allows HTTP when HTTPS is not required", () => {
    expect(normalizeVendorEndpoint("http://123-abc.mktorest.com/path", {
      hostPattern,
      label,
      requireHttps: false,
    })).toBe("http://123-abc.mktorest.com/path");
  });

  it("refuses non-HTTP schemes even when HTTPS is not required", () => {
    expect(() => normalizeVendorEndpoint("javascript:alert(1)", {
      hostPattern,
      label,
      requireHttps: false,
    })).toThrow("Marketo REST endpoint must use http or https.");
  });

  it("refuses hosts outside the allowlist", () => {
    expect(() => normalizeVendorEndpoint("https://evil.com", { hostPattern, label }))
      .toThrow("That is not a recognized Marketo REST endpoint host.");
  });

  it("anchors an unanchored host pattern", () => {
    expect(() => normalizeVendorEndpoint("https://evil-marketo.com.attacker.net", {
      hostPattern: /marketo\.com/,
      label,
    })).toThrow("That is not a recognized Marketo REST endpoint host.");
  });

  it("anchors an alternation as one pattern", () => {
    const options = { hostPattern: /a\.com|sub\.a\.com/, label };

    expect(normalizeVendorEndpoint("https://a.com", options)).toBe("https://a.com");
    expect(normalizeVendorEndpoint("https://sub.a.com", options)).toBe("https://sub.a.com");
  });

  it("accepts and preserves a port while matching only the hostname", () => {
    expect(normalizeVendorEndpoint("https://ha.example.com:8123/hass/", {
      hostPattern: /^ha\.example\.com$/,
      label: "Home Assistant endpoint",
    })).toBe("https://ha.example.com:8123/hass");
  });

  it("refuses userinfo", () => {
    expect(() => normalizeVendorEndpoint("https://u:p@ha.example.com", {
      hostPattern: /^ha\.example\.com$/,
      label: "Home Assistant endpoint",
    })).toThrow("Home Assistant endpoint must not include credentials.");
  });

  it("does not accept an allowed hostname as a suffix", () => {
    expect(() => normalizeVendorEndpoint("https://123-abc.mktorest.com.evil.com", {
      hostPattern,
      label,
    })).toThrow("That is not a recognized Marketo REST endpoint host.");
  });

  it("reports unparseable input without echoing it", () => {
    expect(() => normalizeVendorEndpoint("not a url", { hostPattern, label }))
      .toThrow("Marketo REST endpoint is not a valid URL.");
  });

  it("refuses a stateful host pattern rather than alternating on identical input", () => {
    // `lastIndex` advances on every match, so a `g`/`y` pattern accepts the first call and refuses
    // the identical second one. Deterministically fatal beats intermittently wrong.
    for (const stateful of [/^[a-z0-9-]+\.mktorest\.com$/gi, /^[a-z0-9-]+\.mktorest\.com$/y]) {
      const call = () =>
        normalizeVendorEndpoint("https://123-abc.mktorest.com", { hostPattern: stateful, label });
      expect(call).toThrow("Marketo REST endpoint host pattern must not be global or sticky.");
      expect(call).toThrow(/must not be global or sticky/);
    }
  });

  it("keeps every refusal display-safe", () => {
    for (const raw of [
      "private invalid endpoint",
      "ftp://private.example.com/path",
      "https://private.example.com/path",
      "https://u:p@123-abc.mktorest.com",
    ]) {
      // An accepted endpoint returns the endpoint, which fails the label assertion below.
      let answer: string;
      try {
        answer = normalizeVendorEndpoint(raw, { hostPattern, label });
      } catch (error) {
        answer = (error as Error).message;
      }
      expect(answer).toContain(label);
      expect(answer).not.toContain(raw);
    }
  });
});
