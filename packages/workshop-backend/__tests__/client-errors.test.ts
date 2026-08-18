import { describe, expect, it, vi } from "vitest";
import { handleClientErrorRequest } from "../src/client-errors.js";

const validReport = {
  schemaVersion: 1,
  failureSite: "workshop.render",
  severity: "fatal",
  handled: false,
  captureMechanism: "react",
  surface: "workshop",
  sessionId: "session-12345678",
  pageLocation: "https://workshop.example/workspace/123",
  reportedUserId: "person@example.com",
  exception: { type: "Error", message: "boom", stack: "Error: boom" },
};

function request(body: unknown = validReport, init: RequestInit = {}) {
  return new Request("https://workshop.example/api/client-errors", {
    method: "POST",
    headers: { origin: "https://workshop.example", "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

function setup() {
  const report = vi.fn().mockResolvedValue(undefined);
  const limit = vi.fn().mockResolvedValue({ success: true });
  const waits: Promise<unknown>[] = [];
  return {
    env: {
      FRONTEND_ERROR_REPORTER: { report },
      FRONTEND_ERROR_RATE_LIMITER: { limit },
    },
    ctx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) },
    report,
    limit,
    waits,
  };
}

const accessEnv = {
  CF_ACCESS_AUD: "workshop-audience",
  CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
};

describe("handleClientErrorRequest", () => {
  it("requires POST, same-origin JSON", async () => {
    const { env, ctx } = setup();
    expect((await handleClientErrorRequest(request(undefined, { method: "PUT", body: null }), env, ctx)).status)
      .toBe(405);
    expect((await handleClientErrorRequest(request(validReport, {
      headers: { origin: "https://evil.example", "content-type": "application/json" },
    }), env, ctx)).status).toBe(403);
    expect((await handleClientErrorRequest(request(validReport, {
      headers: { origin: "https://workshop.example", "content-type": "text/plain" },
    }), env, ctx)).status).toBe(415);
  });

  it("rejects oversized bodies and unsupported report versions", async () => {
    const { env, ctx } = setup();
    const oversized = request({ ...validReport, padding: "x".repeat(129 * 1024) });
    expect((await handleClientErrorRequest(oversized, env, ctx)).status).toBe(413);
    expect((await handleClientErrorRequest(request({ ...validReport, schemaVersion: 2 }), env, ctx)).status)
      .toBe(400);
  });

  it.each([
    ["multibyte", "界"],
    ["JSON-escaped", "\u0000"],
  ])("accepts a valid maximum-length %s stack", async (_name, character) => {
    const { env, ctx, report } = setup();
    const response = await handleClientErrorRequest(request({
      ...validReport,
      exception: { type: "Error", message: "boom", stack: character.repeat(16_384) },
    }), env, ctx);

    expect(response.status).toBe(204);
    expect(report).toHaveBeenCalledOnce();
  });

  it("forwards useful error data when optional metadata is malformed", async () => {
    const { env, ctx, report } = setup();
    const response = await handleClientErrorRequest(request({
      ...validReport,
      severity: "critical",
      handled: "yes",
      captureMechanism: "unknown",
      surface: "gadget",
      sessionId: 42,
      gadgetId: { invalid: true },
      browser: { family: "Netscape", platform: "Linux" },
    }), env, ctx);

    expect(response.status).toBe(204);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      failureSite: "workshop.render",
      severity: "error",
      handled: true,
      attributes: expect.objectContaining({
        captureMechanism: "explicit",
        surface: "workshop",
        browserPlatform: "Linux",
      }),
    }));
    expect(report.mock.calls[0][0].attributes).not.toHaveProperty("sessionId");
    expect(report.mock.calls[0][0].attributes).not.toHaveProperty("gadgetId");
  });

  it("assigns server occurrence metadata and dispatches a normalized event", async () => {
    const { env, ctx, report, limit, waits } = setup();
    const req = request(validReport, {
      headers: {
        origin: "https://workshop.example",
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.1",
      },
    });
    expect((await handleClientErrorRequest(req, env, ctx)).status).toBe(204);
    expect(limit).toHaveBeenCalledWith({ key: "192.0.2.1" });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      failureSite: "workshop.render",
      severity: "fatal",
      handled: false,
      occurrenceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      occurredAt: expect.any(String),
      attributes: expect.objectContaining({
        captureMechanism: "react",
        surface: "workshop",
        pageLocation: "https://workshop.example/workspace/123",
        reportedUserId: "person@example.com",
      }),
    }));
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
  });

  it("forwards the client's unverified user claim without vetting it", async () => {
    const { env, ctx, report } = setup();
    const claimed = { ...validReport, reportedUserId: "someone-elses@example.com" };

    expect((await handleClientErrorRequest(request(claimed), env, ctx)).status).toBe(204);
    // The endpoint has no credential, so this value is a claim. It travels as a diagnostic
    // attribute and must never be read to make a decision.
    expect(report.mock.calls[0][0].attributes)
      .toMatchObject({ reportedUserId: "someone-elses@example.com" });
  });

  it("omits page and user attributes when the report carries neither", async () => {
    const { env, ctx, report } = setup();
    const anonymous = { ...validReport, reportedUserId: undefined, pageLocation: undefined };

    expect((await handleClientErrorRequest(request(anonymous), env, ctx)).status).toBe(204);
    const { attributes } = report.mock.calls[0][0];
    expect(attributes).not.toHaveProperty("reportedUserId");
    expect(attributes).not.toHaveProperty("pageLocation");
  });

  it("rate-limits distinct verified Access users independently behind one IP", async () => {
    const { env, ctx, limit } = setup();
    const verifyAccess = vi.fn()
      .mockResolvedValueOnce({ sub: "user-1" })
      .mockResolvedValueOnce({ sub: "user-2" })
      .mockResolvedValueOnce({ sub: "user-1" });
    const accessRequest = () => request(validReport, {
      headers: {
        origin: "https://workshop.example",
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.1",
        "cf-access-jwt-assertion": "signed-token",
      },
    });
    const accessBoundEnv = { ...env, ...accessEnv };

    await handleClientErrorRequest(accessRequest(), accessBoundEnv, ctx, verifyAccess);
    await handleClientErrorRequest(accessRequest(), accessBoundEnv, ctx, verifyAccess);
    await handleClientErrorRequest(accessRequest(), accessBoundEnv, ctx, verifyAccess);

    expect(limit.mock.calls.map(([options]) => options.key)).toEqual([
      "access-sub:user-1",
      "access-sub:user-2",
      "access-sub:user-1",
    ]);
  });

  it("rejects missing or invalid Access identity before limiting or parsing", async () => {
    const { env, ctx, limit } = setup();
    const verifyAccess = vi.fn().mockResolvedValue(null);
    const accessRequest = request(validReport, {
      headers: {
        origin: "https://workshop.example",
        "content-type": "application/json",
      },
    });
    const bodyRead = vi.spyOn(accessRequest.body!, "getReader")
      .mockImplementation(() => { throw new Error("body read"); });

    expect((await handleClientErrorRequest(
      accessRequest, { ...env, ...accessEnv }, ctx, verifyAccess,
    )).status).toBe(403);
    expect(limit).not.toHaveBeenCalled();
    expect(bodyRead).not.toHaveBeenCalled();
  });

  it("does not dispatch unless both optional bindings exist or the IP limit succeeds", async () => {
    const { env, ctx, report } = setup();
    expect((await handleClientErrorRequest(request(), {
      FRONTEND_ERROR_REPORTER: env.FRONTEND_ERROR_REPORTER,
    }, ctx)).status).toBe(204);
    expect(report).not.toHaveBeenCalled();

    env.FRONTEND_ERROR_RATE_LIMITER.limit.mockResolvedValue({ success: false });
    expect((await handleClientErrorRequest(request(), env, ctx)).status).toBe(204);
    expect(report).not.toHaveBeenCalled();
  });

  it("does not read the body when reporting is unbound or the IP limit is exhausted", async () => {
    const { env, ctx } = setup();
    const unbound = request();
    const unboundRead = vi.spyOn(unbound.body!, "getReader")
      .mockImplementation(() => { throw new Error("body read"); });
    expect(await handleClientErrorRequest(unbound, {}, ctx)).toHaveProperty("status", 204);
    expect(unboundRead).not.toHaveBeenCalled();

    env.FRONTEND_ERROR_RATE_LIMITER.limit.mockResolvedValue({ success: false });
    const limited = request();
    const limitedRead = vi.spyOn(limited.body!, "getReader")
      .mockImplementation(() => { throw new Error("body read"); });
    expect(await handleClientErrorRequest(limited, env, ctx)).toHaveProperty("status", 204);
    expect(limitedRead).not.toHaveBeenCalled();
  });

  it("isolates Reporter and limiter failures from the browser", async () => {
    const { env, ctx } = setup();
    env.FRONTEND_ERROR_RATE_LIMITER.limit.mockRejectedValueOnce(new Error("limiter unavailable"));
    expect((await handleClientErrorRequest(request(), env, ctx)).status).toBe(204);

    env.FRONTEND_ERROR_REPORTER.report.mockRejectedValueOnce(new Error("reporter unavailable"));
    expect((await handleClientErrorRequest(request(), env, ctx)).status).toBe(204);
  });
});
