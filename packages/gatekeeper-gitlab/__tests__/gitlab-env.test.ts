// Instance configuration: where the Worker sends requests, what it attaches, and how a
// misconfiguration fails -- by name, at the first request, rather than as a login redirect.

import { describe, expect, it } from "vitest";
import {
  codeAccessCacheTtlMs, gitlabInstance, instanceCodeSearchEnabled, instanceHost, instanceUrl, supportedResources,
} from "../src/gitlab-env";

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

describe("codeAccessCacheTtlMs", () => {
  it("defaults to a day, and takes GITLAB_CODE_ACCESS_CACHE_TTL_SECONDS in seconds", () => {
    expect(codeAccessCacheTtlMs(env({}))).toBe(86_400_000);
    expect(codeAccessCacheTtlMs(env({ GITLAB_CODE_ACCESS_CACHE_TTL_SECONDS: "" }))).toBe(86_400_000);
    expect(codeAccessCacheTtlMs(env({ GITLAB_CODE_ACCESS_CACHE_TTL_SECONDS: "600" }))).toBe(600_000);
  });

  it.each(["0", "-5", "1.5", "10s", " 60", "9007199254740993"])("refuses %j by the variable's name", value => {
    expect(() => codeAccessCacheTtlMs(env({ GITLAB_CODE_ACCESS_CACHE_TTL_SECONDS: value })))
      .toThrow(/GITLAB_CODE_ACCESS_CACHE_TTL_SECONDS/);
  });
});

describe("instanceCodeSearchEnabled", () => {
  it.each(["true", "1", "TRUE", " True "])("turns the Instance type on for %j", value => {
    expect(instanceCodeSearchEnabled(env({ GITLAB_INSTANCE_CODE_SEARCH: value }))).toBe(true);
  });

  it.each([undefined, "", "false", "0", "FALSE", " 0 "])("leaves it off for %j", value => {
    expect(instanceCodeSearchEnabled(env({ GITLAB_INSTANCE_CODE_SEARCH: value }))).toBe(false);
  });

  it.each(["yes", "on", "2", "truthy"])("refuses %j by the variable's name rather than guessing", value => {
    expect(() => instanceCodeSearchEnabled(env({ GITLAB_INSTANCE_CODE_SEARCH: value })))
      .toThrow(/GITLAB_INSTANCE_CODE_SEARCH/);
  });
});

describe("instanceHost", () => {
  it("is URL.host of the browser-facing instance, with a non-default port", () => {
    expect(instanceHost(env({}))).toBe("gitlab.com");
    expect(instanceHost(env({ GITLAB_URL: "https://gitlab.example.com/" }))).toBe("gitlab.example.com");
    expect(instanceHost(env({ GITLAB_URL: "https://gitlab.example.com:8443" }))).toBe("gitlab.example.com:8443");
    expect(instanceHost(env({ GITLAB_URL: "https://gitlab.example.com:443" }))).toBe("gitlab.example.com");
  });
});

describe("supportedResources", () => {
  const GITLAB_URL = "https://gitlab.example.com";

  it("offers only the project types unless instance code search is on", () => {
    for (const value of [undefined, "false"]) {
      const resources = supportedResources(env({ GITLAB_URL, GITLAB_INSTANCE_CODE_SEARCH: value }));
      expect(resources.instance).toBeUndefined();
      expect(resources.all).toEqual([resources.mergeRequest, resources.issue, resources.project]);
    }
  });

  it("appends the Instance type at the instance root when it is on", () => {
    const resources = supportedResources(env({ GITLAB_URL, GITLAB_INSTANCE_CODE_SEARCH: "true" }));
    expect(resources.instance).toEqual({
      urlPattern: "https://gitlab.example.com/",
      title: "GitLab instance code",
      description: "Search and read code in every project you can read on gitlab.example.com.",
    });
    expect(resources.all).toEqual([resources.mergeRequest, resources.issue, resources.project, resources.instance]);
  });

  it("matches the root alone, never a project URL, and the project pattern never matches the root", () => {
    const resources = supportedResources(env({ GITLAB_URL, GITLAB_INSTANCE_CODE_SEARCH: "true" }));
    const instance = new URLPattern(resources.instance!.urlPattern);
    const project = new URLPattern(resources.project.urlPattern);
    expect(instance.test("https://gitlab.example.com/")).toBe(true);
    expect(instance.test("https://gitlab.example.com")).toBe(true);
    expect(instance.test("https://gitlab.example.com/group/project")).toBe(false);
    expect(instance.test("https://other.example.com/")).toBe(false);
    expect(project.test("https://gitlab.example.com/")).toBe(false);
  });

  it("fails by the variable's name when it is set to something unrecognised", () => {
    expect(() => supportedResources(env({ GITLAB_URL, GITLAB_INSTANCE_CODE_SEARCH: "yes" })))
      .toThrow(/GITLAB_INSTANCE_CODE_SEARCH/);
  });
});
