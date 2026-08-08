import { describe, expect, it, vi } from "vitest";
import { accessRateLimitKey, verifyCfAccessJwt, verifyMachineAccess } from "../src/access.js";

const joseMocks = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn().mockResolvedValue({ payload: { sub: "user-1" } }),
}));

vi.mock("jose", () => joseMocks);

const accessEnv = {
  CF_ACCESS_AUD: "workshop-audience",
  CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
};

describe("verifyCfAccessJwt", () => {
  it("reuses the remote JWK set for requests with the same issuer", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const otherEnv = {
      ...accessEnv,
      CF_ACCESS_ISS: "https://other-team.cloudflareaccess.com",
    };

    await verifyCfAccessJwt(request, accessEnv);
    await verifyCfAccessJwt(request, accessEnv);
    await verifyCfAccessJwt(request, otherEnv);

    expect(joseMocks.createRemoteJWKSet).toHaveBeenCalledTimes(2);
    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      1, new URL("https://team.cloudflareaccess.com/cdn-cgi/access/certs"),
    );
    expect(joseMocks.createRemoteJWKSet).toHaveBeenNthCalledWith(
      2, new URL("https://other-team.cloudflareaccess.com/cdn-cgi/access/certs"),
    );
  });

  it("rejects missing and invalid assertions", async () => {
    const requestWithoutToken = new Request("https://workshop.example/api/client-errors");
    const verifier = vi.fn();
    const missing = await verifyCfAccessJwt(requestWithoutToken, accessEnv, verifier);
    expect(missing).toBeNull();
    expect(verifier).not.toHaveBeenCalled();

    const requestWithToken = new Request("https://workshop.example/api/client-errors", {
      headers: { "cf-access-jwt-assertion": "invalid" },
    });
    verifier.mockRejectedValue(new Error("invalid signature"));
    const invalid = await verifyCfAccessJwt(requestWithToken, accessEnv, verifier);
    expect(invalid).toBeNull();
  });

  it("returns claims only after verification", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const verifier = vi.fn().mockResolvedValue({
      sub: "user-1", email: "person@example.com",
    });

    await expect(verifyCfAccessJwt(request, accessEnv, verifier)).resolves.toEqual({
      sub: "user-1", email: "person@example.com",
    });
  });
});

describe("accessRateLimitKey", () => {
  it("uses the verified subject and hashes email only as a fallback", async () => {
    await expect(accessRateLimitKey({ sub: "user-1", email: "person@example.com" }))
      .resolves.toBe("access-sub:user-1");
    const emailKey = await accessRateLimitKey({ email: "person@example.com" });
    expect(emailKey).toMatch(/^access-email:[0-9a-f]{64}$/);
    expect(emailKey).not.toContain("person@example.com");
  });
});

describe("verifyMachineAccess", () => {
  const machineEnv = {
    COMPANY_OS_MACHINE_ADMIN_EMAIL: "Admin@Example.com ",
    COMPANY_OS_MACHINE_TOKEN: "deployment-secret",
  };

  it("returns the normalized configured administrator for the exact bearer token", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { authorization: "Bearer deployment-secret" },
    });

    await expect(verifyMachineAccess(request, machineEnv)).resolves.toBe("admin@example.com");
  });

  it("rejects missing, malformed, and incorrect bearer tokens", async () => {
    await expect(verifyMachineAccess(
      new Request("https://workshop.example/api"), machineEnv,
    )).resolves.toBeNull();
    await expect(verifyMachineAccess(
      new Request("https://workshop.example/api", {
        headers: { authorization: "Basic deployment-secret" },
      }), machineEnv,
    )).resolves.toBeNull();
    await expect(verifyMachineAccess(
      new Request("https://workshop.example/api", {
        headers: { authorization: "Bearer wrong-secret" },
      }), machineEnv,
    )).resolves.toBeNull();
  });

  it("stays disabled unless both settings are present", async () => {
    const request = new Request("https://workshop.example/api", {
      headers: { authorization: "Bearer deployment-secret" },
    });

    await expect(verifyMachineAccess(request, {
      COMPANY_OS_MACHINE_ADMIN_EMAIL: "admin@example.com",
    })).resolves.toBeNull();
    await expect(verifyMachineAccess(request, {
      COMPANY_OS_MACHINE_TOKEN: "deployment-secret",
    })).resolves.toBeNull();
  });
});
