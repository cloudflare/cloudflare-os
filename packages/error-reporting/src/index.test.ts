import { describe, expect, it } from "vitest";
import {
  FRONTEND_ERROR_MESSAGE_TYPE,
  MAX_MESSAGE_CHARS,
  MAX_STRING_CHARS,
  MAX_STACK_CHARS,
  extractFrontendFrameReport,
  normalizeFrontendErrorReport,
  serializeException,
} from "./index.js";

const report = {
  schemaVersion: 1,
  failureSite: "workshop.render",
  severity: "error",
  handled: false,
  captureMechanism: "react",
  surface: "workshop",
  sessionId: "session-12345678",
  exception: { type: "Error", message: "boom", stack: "Error: boom" },
} as const;

describe("serializeException", () => {
  it("turns hostile thrown values into bounded cloneable data", () => {
    const error = new Error("m".repeat(MAX_MESSAGE_CHARS + 1));
    error.stack = "s".repeat(MAX_STACK_CHARS + 1);
    expect(serializeException(error)).toEqual({
      type: "Error",
      message: "m".repeat(MAX_MESSAGE_CHARS),
      stack: "s".repeat(MAX_STACK_CHARS),
      truncated: true,
    });

    const hostile = {};
    Object.defineProperty(hostile, "message", {
      get() { throw new Error("getter invoked"); },
    });
    expect(() => serializeException(hostile)).not.toThrow();
    expect(serializeException(hostile)).toEqual({ type: "Object" });
  });

  it("retains readable Error fields when the stack accessor throws", () => {
    const error = new Error("still useful");
    Object.defineProperty(error, "stack", {
      get() { throw new Error("stack unavailable"); },
    });

    expect(serializeException(error)).toEqual({
      type: "Error",
      message: "still useful",
    });
  });
});

describe("normalizeFrontendErrorReport", () => {
  it("reconstructs only the final HTTP allowlist", () => {
    const decoded = normalizeFrontendErrorReport({
      ...report,
      pageLocation: "https://workshop.example/workspace/123",
      reportedUserId: "person@example.com",
      attributes: { prompt: "secret" },
      routeTemplate: "/gadget/:id",
      chatId: "chat-123",
      browser: { family: "Chromium", mobile: false, rawUserAgent: "secret" },
    });
    expect(decoded).toEqual({
      ...report,
      pageLocation: "https://workshop.example/workspace/123",
      reportedUserId: "person@example.com",
      browser: { family: "Chromium", mobile: false },
    });
    expect(decoded).not.toHaveProperty("attributes");
    expect(decoded).not.toHaveProperty("routeTemplate");
    expect(decoded).not.toHaveProperty("chatId");
  });

  it("bounds page and user context", () => {
    const long = `https://workshop.example/${"p".repeat(300)}`;
    const decoded = normalizeFrontendErrorReport({
      ...report,
      pageLocation: long,
      reportedUserId: "u".repeat(300),
    });

    expect(decoded).toEqual({
      ...report,
      pageLocation: long.slice(0, 256),
      reportedUserId: "u".repeat(256),
      truncated: true,
    });
  });

  it("drops credentials embedded in a page location", () => {
    // `href` keeps `user:password@`, so a textual strip of the query and fragment would carry it
    // through to the Reporter. Only a rebuild from the parsed URL removes it.
    const decoded = normalizeFrontendErrorReport({
      ...report,
      pageLocation: "https://user:secret@workshop.example/workspace/123?a=1#share=cap",
    });

    expect(decoded).toEqual({
      ...report,
      pageLocation: "https://workshop.example/workspace/123",
    });
  });

  it.each([
    ["a username with no password", "https://user@workshop.example/p", "https://workshop.example/p"],
    ["a password with no username", "https://:secret@workshop.example/p", "https://workshop.example/p"],
    ["a port", "https://workshop.example:8443/p", "https://workshop.example:8443/p"],
    ["plain http", "http://workshop.example/p", "http://workshop.example/p"],
  ])("keeps a page location with %s usable", (_case, pageLocation, expected) => {
    expect(normalizeFrontendErrorReport({ ...report, pageLocation }))
      .toEqual({ ...report, pageLocation: expected });
  });

  it.each([
    ["an opaque-origin frame", "about:srcdoc"],
    ["a data URL carrying its payload in the path", "data:text/html,<script>alert(1)</script>"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a local file path", "file:///etc/passwd"],
    ["a blob URL, whose origin and path would double up", "blob:https://workshop.example/uuid"],
    ["a string that is not a URL at all", "p".repeat(300)],
  ])("omits the page location for %s", (_case, pageLocation) => {
    // Reconstruction is only meaningful for http(s): every one of these either serializes an
    // opaque origin to a literal "null" prefix or smuggles content through the path.
    const decoded = normalizeFrontendErrorReport({ ...report, pageLocation });

    expect(decoded).toEqual(report);
    expect(decoded).not.toHaveProperty("pageLocation");
  });

  it("keeps only the part of a page location before a query or fragment", () => {
    const decoded = normalizeFrontendErrorReport({
      ...report,
      pageLocation: "https://workshop.example/workspace/123?token=secret#share=capability",
    });

    expect(decoded).toEqual({
      ...report,
      pageLocation: "https://workshop.example/workspace/123",
    });
  });

  it("does not mark a report truncated for the query string it strips", () => {
    const decoded = normalizeFrontendErrorReport({
      ...report,
      pageLocation: `https://workshop.example/p?${"q".repeat(400)}`,
    });

    expect(decoded).toEqual({ ...report, pageLocation: "https://workshop.example/p" });
  });

  it("keeps context sitting exactly on the bound without marking it truncated", () => {
    const prefix = "https://workshop.example/";
    const pageLocation = prefix + "p".repeat(MAX_STRING_CHARS - prefix.length);
    const reportedUserId = "u".repeat(MAX_STRING_CHARS);

    expect(normalizeFrontendErrorReport({ ...report, pageLocation, reportedUserId }))
      .toEqual({ ...report, pageLocation, reportedUserId });
  });

  it("normalizes malformed fields instead of losing the report", () => {
    const decoded = normalizeFrontendErrorReport({
      ...report,
      failureSite: "f".repeat(300),
      severity: "critical",
      handled: "yes",
      captureMechanism: "unknown",
      surface: "gadget",
      sessionId: 42,
      gadgetId: { invalid: true },
      browser: { family: "Netscape", platform: "Linux", mobile: "sometimes" },
      exception: { type: 42, message: "m".repeat(MAX_MESSAGE_CHARS + 1) },
      truncated: false,
    });

    expect(decoded).toMatchObject({
      schemaVersion: 1,
      failureSite: "f".repeat(256),
      severity: "error",
      handled: true,
      captureMechanism: "explicit",
      surface: "workshop",
      exception: { type: "Error", message: "m".repeat(MAX_MESSAGE_CHARS), truncated: true },
      browser: { platform: "Linux" },
      truncated: true,
    });
    expect(decoded).not.toHaveProperty("sessionId");
    expect(decoded).not.toHaveProperty("gadgetId");
  });

  it("rejects only invalid envelopes", () => {
    expect(normalizeFrontendErrorReport(null)).toBeNull();
    expect(normalizeFrontendErrorReport({ ...report, schemaVersion: 2 })).toBeNull();
  });

  it("round-trips exceptions with empty optional strings", () => {
    const emptyError = new Error("");
    emptyError.stack = "";
    const exceptions = [serializeException(emptyError), serializeException("")];

    for (const exception of exceptions) {
      expect(normalizeFrontendErrorReport({ ...report, exception })?.exception).toEqual(exception);
    }
  });
});

describe("extractFrontendFrameReport", () => {
  it("accepts only frame-owned failure data and returns a safe copy", () => {
    const input = {
      type: FRONTEND_ERROR_MESSAGE_TYPE,
      report: {
        failureSite: "frame.render",
        severity: "fatal",
        handled: false,
        captureMechanism: "react",
        exception: { type: "Error", message: "boom" },
        surface: "gadget",
        sessionId: "frame-claimed-session",
      },
    };
    expect(extractFrontendFrameReport(input)).toEqual({
      failureSite: "frame.render",
      severity: "fatal",
      handled: false,
      captureMechanism: "react",
      exception: { type: "Error", message: "boom" },
    });
    expect(extractFrontendFrameReport({ type: FRONTEND_ERROR_MESSAGE_TYPE })).toBeNull();
  });

  it("normalizes imperfect frame-owned data", () => {
    expect(extractFrontendFrameReport({
      type: FRONTEND_ERROR_MESSAGE_TYPE,
      report: {
        failureSite: "",
        severity: "critical",
        handled: "no",
        captureMechanism: "other",
        exception: "boom",
      },
    })).toEqual({
      failureSite: "frame.unknown",
      severity: "error",
      handled: true,
      captureMechanism: "explicit",
      exception: { type: "stringThrown", message: "boom" },
    });
  });
});
