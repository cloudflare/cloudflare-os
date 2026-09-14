// Instance configuration: where the Worker sends requests, what it attaches, and how a
// misconfiguration fails -- by name, at the first request, rather than as a login redirect.

import { describe, expect, it } from "vitest";
import { gitlabInstance, instanceUrl } from "../src/gitlab-env";

const env = (vars: Record<string, string | undefined>) => vars as never;

describe("gitlabInstance", () => {
  it("talks to gitlab.com with no headers when nothing is configured", () => {
    expect(gitlabInstance(env({}))).toEqual({ apiOrigin: "https://gitlab.com", headers: {} });
    expect(instanceUrl(env({}))).toBe("https://gitlab.com");
  });

  it("sends requests to GITLAB_API_URL when it differs from the browser-facing GITLAB_URL", () => {
    const e = env({ GITLAB_URL: "https://gitlab.example.com/", GITLAB_API_URL: "https://gitlab-access.example.com/" });
    expect(instanceUrl(e)).toBe("https://gitlab.example.com");
    expect(gitlabInstance(e).apiOrigin).toBe("https://gitlab-access.example.com");
  });

  it("attaches the Access service-token pair when both halves are set", () => {
    expect(gitlabInstance(env({ CF_ACCESS_CLIENT_ID: "id", CF_ACCESS_CLIENT_SECRET: "secret" })).headers).toEqual({
      "CF-Access-Client-Id": "id",
      "CF-Access-Client-Secret": "secret",
    });
  });

  it("refuses half a service token rather than talking to the instance without one", () => {
    expect(() => gitlabInstance(env({ CF_ACCESS_CLIENT_ID: "id" }))).toThrow(/must be set together/);
    expect(() => gitlabInstance(env({ CF_ACCESS_CLIENT_SECRET: "secret" }))).toThrow(/must be set together/);
  });

  it("refuses a plain-http instance, which would carry tokens and the client secret in the clear", () => {
    // Either URL: the API origin receives every token; the browser-facing one hosts the
    // authorization page users are sent to.
    expect(() => gitlabInstance(env({ GITLAB_API_URL: "http://gitlab.example.com" }))).toThrow(/GITLAB_API_URL must use https/);
    expect(() => instanceUrl(env({ GITLAB_URL: "http://gitlab.example.com" }))).toThrow(/GITLAB_URL must use https/);
    expect(() => instanceUrl(env({ GITLAB_URL: "ftp://gitlab.example.com" }))).toThrow(/GITLAB_URL must use https/);
    expect(() => instanceUrl(env({ GITLAB_URL: "gitlab.example.com" }))).toThrow(/GITLAB_URL is not a valid URL/);
    expect(() => instanceUrl(env({ GITLAB_URL: "https://user:pw@gitlab.example.com" }))).toThrow(/must not include credentials/);
    // The message names the variable, never its value.
    let message = "";
    try { instanceUrl(env({ GITLAB_URL: "http://secret-host.internal" })); } catch (error) { message = String(error); }
    expect(message).toMatch(/GITLAB_URL/);
    expect(message).not.toContain("secret-host");
  });

  it("accepts http on loopback for a GitLab run locally", () => {
    expect(instanceUrl(env({ GITLAB_URL: "http://localhost:8929/" }))).toBe("http://localhost:8929");
    expect(gitlabInstance(env({ GITLAB_API_URL: "http://127.0.0.1:8929" })).apiOrigin).toBe("http://127.0.0.1:8929");
    expect(instanceUrl(env({ GITLAB_URL: "http://[::1]:8929" }))).toBe("http://[::1]:8929");
  });

  it("refuses a relative URL root rather than dropping it: every path is built from the origin", () => {
    // Dropped, `/gitlab` would leave `https://example.com/api/v4/…` carrying the token to
    // whatever answers at that host's root; kept, nothing downstream would honour it.
    expect(() => instanceUrl(env({ GITLAB_URL: "https://example.com/gitlab" }))).toThrow(/GITLAB_URL must be an origin/);
    expect(() => gitlabInstance(env({ GITLAB_API_URL: "https://example.com/gitlab/" }))).toThrow(/GITLAB_API_URL must be an origin/);
    expect(() => instanceUrl(env({ GITLAB_URL: "https://example.com/?x=1" }))).toThrow(/must be an origin/);
    // A bare trailing slash is the same origin.
    expect(instanceUrl(env({ GITLAB_URL: "https://gitlab.example.com/" }))).toBe("https://gitlab.example.com");
  });
});
