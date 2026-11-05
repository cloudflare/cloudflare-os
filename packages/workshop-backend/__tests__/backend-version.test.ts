import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/server.js";
import { getServerConfig } from "../src/deployment-config.js";
import { VERSION_PATH } from "@gadgets/workshop-shared/api";

const METADATA = { id: "version-id", tag: "", timestamp: "2026-10-01T00:00:00.000Z" };
// The binding as it stands in each case: present, present with no id, and absent.
const WITH_ID = { CF_VERSION_METADATA: METADATA };
const EMPTY_ID = { CF_VERSION_METADATA: { ...METADATA, id: "" } };
const UNBOUND = { CF_VERSION_METADATA: undefined };

function envWith(vars: object): Cloudflare.Env {
  return { ...env, ...vars } as Cloudflare.Env;
}

async function fetchVersion(vars: object, method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
      new Request(`https://workshop.example${VERSION_PATH}`, { method }), envWith(vars), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// The pool binds no BLUEPRINTS namespace, where getServerConfig reads the admin config.
function config(vars: object) {
  return getServerConfig(envWith({ BLUEPRINTS: { get: async () => null }, ...vars }));
}

describe("the version endpoint", () => {
  it("answers the version id, uncached", async () => {
    const response = await fetchVersion(WITH_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: "version-id" });
  });

  it("answers null without a version id", async () => {
    expect(await (await fetchVersion(EMPTY_ID)).json()).toEqual({ version: null });
    expect(await (await fetchVersion(UNBOUND)).json()).toEqual({ version: null });
  });

  it("answers only GET", async () => {
    expect((await fetchVersion(WITH_ID, "POST")).status).toBe(404);
  });
});

describe("getServerConfig", () => {
  it("carries the version id of the backend answering", async () => {
    expect((await config(WITH_ID)).backendVersion).toBe("version-id");
  });

  it("carries no version without a version id", async () => {
    expect((await config(EMPTY_ID)).backendVersion).toBeUndefined();
    expect((await config(UNBOUND)).backendVersion).toBeUndefined();
  });
});
