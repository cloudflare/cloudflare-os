import { describe, expect, it } from "vitest";
import issue from "../src/configurator/github-issue-configurator-ui";
import pull from "../src/configurator/github-pull-request-configurator-ui";
import repo from "../src/configurator/github-repo-configurator-ui";

describe("Enterprise resource configurators", () => {
  const ui = { instanceUrl: async () => "https://git.example.com" } as never;

  it("constructs repository, issue and pull request URLs on the configured instance", async () => {
    expect(await repo.resourceUrl({ values: { repoFullName: "acme/app" }, ui }))
      .toBe("https://git.example.com/acme/app");
    expect(await issue.resourceUrl({ values: { repoFullName: "acme/app", issueNumber: "42" }, ui }))
      .toBe("https://git.example.com/acme/app/issues/42");
    expect(await pull.resourceUrl({ values: { repoFullName: "acme/app", pullNumber: "7" }, ui }))
      .toBe("https://git.example.com/acme/app/pull/7");
  });
});
