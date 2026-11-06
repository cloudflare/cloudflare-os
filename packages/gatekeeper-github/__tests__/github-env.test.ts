import { describe, expect, it } from "vitest";
import { githubInstance, instanceUrl, webhookOrigin, type Env } from "../src/github-env";

const withOrigin = (WEBHOOK_ORIGIN?: string) => ({ WEBHOOK_ORIGIN }) as Env;

describe("webhookOrigin", () => {
  it("leaves GitHub hooks off until a deployment sets it", () => {
    expect(webhookOrigin(withOrigin())).toBeUndefined();
  });

  it("accepts an https origin, with or without a trailing slash", () => {
    expect(webhookOrigin(withOrigin("https://gadgets.example.com"))).toBe("https://gadgets.example.com");
    expect(webhookOrigin(withOrigin("https://Gadgets.Example.com/"))).toBe("https://gadgets.example.com");
  });

  it.each([
    "http://gadgets.example.com",
    "https://gadgets.example.com/gatekeeper/github",
    "https://user:secret@gadgets.example.com",
    "gadgets.example.com",
  ])("refuses %s, which webhooks would not reach safely", origin => {
    expect(() => webhookOrigin(withOrigin(origin))).toThrow("WEBHOOK_ORIGIN must be an https origin");
  });
});

describe("GitHub instance configuration", () => {
  const env = (values: Partial<Env> = {}) => values as Env;

  it("defaults to GitHub.com's separate API origin", () => {
    expect(githubInstance(env())).toMatchObject({ webOrigin: "https://github.com",
      apiOrigin: "https://github.com", restBase: "https://api.github.com",
      graphqlUrl: "https://api.github.com/graphql" });
  });

  it("supports a separate worker origin", () => {
    expect(githubInstance(env({ GITHUB_URL: "https://git.example.com/", GITHUB_API_URL: "https://git-api.example.com" }))).toEqual({
      webOrigin: "https://git.example.com", apiOrigin: "https://git-api.example.com",
      restBase: "https://git-api.example.com/api/v3", graphqlUrl: "https://git-api.example.com/api/graphql",
    });
  });

  it.each(["http://git.example.com", "https://user:secret@git.example.com", "https://git.example.com/root",
    "https://git.example.com/?x=1", "not a URL"])("rejects unsafe instance %s", url => {
    expect(() => instanceUrl(env({ GITHUB_URL: url }))).toThrow();
  });

  it("permits local HTTP for development", () => {
    expect(instanceUrl(env({ GITHUB_URL: "http://localhost:3001/" }))).toBe("http://localhost:3001");
  });
});
