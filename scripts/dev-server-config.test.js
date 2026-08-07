import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getWranglerPortFromBackendHost, parseRunLocalArgs } from "./dev-server-config.js";

describe("getWranglerPortFromBackendHost", () => {
  it("extracts a port from a localhost backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost:9000"), "9000");
  });

  it("extracts a port from an IPv6 backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("[::1]:9001"), "9001");
  });

  it("extracts an explicit HTTP default port", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost:80"), "80");
  });

  it("returns null when the backend host has no port", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost"), null);
  });

  it("rejects invalid ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid IPv6 ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("[::1]:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects port zero", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:0"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid hosts", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("http://localhost:9000"),
        /VITE_BACKEND_HOST must include a valid host/);
  });
});

describe("parseRunLocalArgs", () => {
  it("extracts a separated port value and preserves other arguments", () => {
    assert.deepEqual(
        parseRunLocalArgs(["--use-workers-ai-binding", "--port", "8999"]),
        { port: "8999", passthroughArgs: ["--use-workers-ai-binding"] });
  });

  it("extracts an equals-separated port value", () => {
    assert.deepEqual(
        parseRunLocalArgs(["--port=8999"]),
        { port: "8999", passthroughArgs: [] });
  });

  it("rejects a missing port value", () => {
    assert.throws(() => parseRunLocalArgs(["--port"]), /--port requires a value/);
    assert.throws(() => parseRunLocalArgs(["--port="]), /--port requires a value/);
  });

  it("rejects an invalid port value", () => {
    assert.throws(() => parseRunLocalArgs(["--port", "0"]), /valid port/);
    assert.throws(() => parseRunLocalArgs(["--port=65536"]), /valid port/);
    assert.throws(() => parseRunLocalArgs(["--port", "invalid"]), /valid port/);
  });
});
