// The connect page: what it shows, what it accepts, and what it refuses before anything is sent
// to UniFi.

import { describe, expect, it } from "vitest";
import {
  connectFormHtml, ConsoleUrlError, formResponse, normalizeConsoleUrl, parseConnectForm, type ConnectPageMode,
} from "../src/connect-form";

const CONNECT: ConnectPageMode = { kind: "connect" };
const KEY = "AbCdEf0123456789-_abcdefghijklmnop";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe("console URLs", () => {
  it.each([
    ["https://192.168.1.1", "https://192.168.1.1"],
    ["192.168.1.1", "https://192.168.1.1"],
    ["https://unifi.example.com/", "https://unifi.example.com"],
    ["https://unifi.example.com:8443", "https://unifi.example.com:8443"],
    // A pasted UniFi page is cut back to the console.
    ["https://192.168.1.1/network/default/dashboard", "https://192.168.1.1"],
    ["https://192.168.1.1/protect/dashboard/all?x=1#frag", "https://192.168.1.1"],
    // A reverse proxy's prefix is kept.
    ["https://proxy.example.com/unifi/", "https://proxy.example.com/unifi"],
    ["http://localhost:8080", "http://localhost:8080"],
  ])("normalizes %s", (raw, normalized) => {
    expect(normalizeConsoleUrl(raw)).toBe(normalized);
  });

  it.each([
    ["", /Enter the console's address/],
    ["http://192.168.1.1", /Use https/],
    ["https://admin:secret@192.168.1.1", /Leave credentials out/],
    ["ftp://console", /must start with https/],
    ["https://exa mple.com", /isn't a valid address/],
  ])("refuses %j", (raw, message) => {
    expect(() => normalizeConsoleUrl(raw)).toThrow(ConsoleUrlError);
    expect(() => normalizeConsoleUrl(raw)).toThrow(message);
  });
});

describe("parsing submissions", () => {
  it("parses a cloud key", () => {
    expect(parseConnectForm(form({ mode: "cloud", cloudApiKey: ` ${KEY} ` }), CONNECT))
      .toEqual({ ok: true, input: { mode: "cloud", apiKey: KEY } });
  });

  it("parses a direct connection, with or without an Access token", () => {
    expect(parseConnectForm(form({ mode: "direct", consoleUrl: "192.168.1.1", localApiKey: KEY }), CONNECT))
      .toEqual({ ok: true, input: { mode: "direct", baseUrl: "https://192.168.1.1", apiKey: KEY } });
    expect(parseConnectForm(form({
      mode: "direct", consoleUrl: "https://unifi.example.com", localApiKey: KEY,
      accessClientId: "abc.access", accessClientSecret: "s3cret",
    }), CONNECT)).toEqual({
      ok: true,
      input: { mode: "direct", baseUrl: "https://unifi.example.com", apiKey: KEY, access: { clientId: "abc.access", clientSecret: "s3cret" } },
    });
  });

  it("refuses half an Access token, a bad URL, and things that aren't keys", () => {
    expect(parseConnectForm(form({ mode: "direct", consoleUrl: "https://c", localApiKey: KEY, accessClientId: "x" }), CONNECT))
      .toMatchObject({ ok: false, mode: "direct", message: expect.stringMatching(/both/) });
    expect(parseConnectForm(form({ mode: "direct", consoleUrl: "http://10.0.0.1", localApiKey: KEY }), CONNECT))
      .toMatchObject({ ok: false, mode: "direct", message: expect.stringMatching(/https/) });
    expect(parseConnectForm(form({ mode: "cloud", cloudApiKey: "short" }), CONNECT))
      .toMatchObject({ ok: false, mode: "cloud" });
    expect(parseConnectForm(form({ mode: "cloud", cloudApiKey: "has a space in it 0123456789" }), CONNECT))
      .toMatchObject({ ok: false, mode: "cloud" });
  });

  it("keeps a reconnect to its own mode, and ignores a direct reconnect's URL", () => {
    const reconnectDirect: ConnectPageMode = { kind: "reconnect", mode: "direct", baseUrl: "https://192.168.1.1" };
    expect(parseConnectForm(form({ mode: "cloud", cloudApiKey: KEY }), reconnectDirect))
      .toMatchObject({ ok: false, mode: "direct" });
    expect(parseConnectForm(form({ mode: "direct", consoleUrl: "https://evil.example", localApiKey: KEY }), reconnectDirect))
      .toEqual({ ok: true, input: { mode: "direct", apiKey: KEY } });
  });
});

describe("the page", () => {
  it("offers both modes on a new connection, posting back to its own link", () => {
    const html = connectFormHtml("/gatekeeper/unifi/a/b", CONNECT);
    expect(html).toContain('action="/gatekeeper/unifi/a/b"');
    expect(html).toContain('name="cloudApiKey"');
    expect(html).toContain('name="consoleUrl"');
    expect(html).toContain('type="password"');
  });

  it("shows only the account's mode on a reconnect, with the console URL fixed", () => {
    const html = connectFormHtml("/a", { kind: "reconnect", mode: "direct", baseUrl: "https://192.168.1.1" });
    expect(html).not.toContain("cloudApiKey");
    expect(html).not.toContain('name="consoleUrl"');
    expect(html).toContain("https://192.168.1.1");
  });

  it("escapes everything it echoes", () => {
    const html = connectFormHtml('/"><script>', CONNECT, { mode: "cloud", message: "<img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("is served so that the browser sends an Origin the POST can check", () => {
    const response = formResponse("<p>hi</p>");
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});
