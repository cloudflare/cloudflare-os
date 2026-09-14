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
});
