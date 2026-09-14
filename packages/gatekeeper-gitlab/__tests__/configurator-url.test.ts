// The three configurator UIs each parse and build resource URLs that `parseResourceUrl` then has
// to accept, but they cannot share it: each configurator module is transpiled on its own by
// `scripts/build-gatekeeper-configurator.ts`, which only strips `@gadgets/configurator-ui` and
// type-only imports, so a runtime import would not resolve inside the sandboxed frame. The
// duplication is deliberate, and this test is what keeps the copies honest: every configurator's
// real `resourceUrl` must round-trip through the server-side parser to the values it was built
// from, and every configurator's pre-fill must agree with the server-side parser on the same
// URLs. A drift on either side -- a changed `/-/` marker, a lost `.git` strip -- shows up here
// rather than as a resource the backend rejects after the user has filled the form.

import { describe, expect, it } from "vitest";
import issueConfigurator from "../src/configurator/gitlab-issue-configurator-ui.js";
import mergeRequestConfigurator from "../src/configurator/gitlab-merge-request-configurator-ui.js";
import projectConfigurator from "../src/configurator/gitlab-project-configurator-ui.js";
import { supportedResources } from "../src/gitlab-env.js";
import { parseResourceUrl } from "../src/gitlab-normalize.js";

const INSTANCE = "https://gitlab.example.com";
const PATTERNS = supportedResources({ GITLAB_URL: INSTANCE } as never);

// `resourceUrl` may only ask the ui capability where the instance is, and pre-filling from a
// URL may not ask it anything: neither is a question the frame should put to the gatekeeper.
const ui = new Proxy({}, {
  get(_target, property) {
    if (property === "instanceUrl") return async () => INSTANCE;
    throw new Error(`resourceUrl must not call ui.${String(property)}`);
  },
}) as never;
const noUi = new Proxy({}, {
  get(_target, property) { throw new Error(`initialValuesFromResourceUrl must not call ui.${String(property)}`); },
}) as never;

describe("configurator resource URLs round-trip through the server-side parser", () => {
  it("project", async () => {
    const url = await projectConfigurator.resourceUrl!({ values: { projectPath: "group/sub/project" }, ui });
    expect(parseResourceUrl(INSTANCE, url as string)).toEqual({ projectPath: "group/sub/project", kind: "project" });
  });

  it("issue", async () => {
    const url = await issueConfigurator.resourceUrl!({ values: { projectPath: "group/project", issueIid: "42" }, ui });
    expect(parseResourceUrl(INSTANCE, url as string)).toEqual({ projectPath: "group/project", kind: "issue", iid: 42 });
  });

  it("merge request", async () => {
    const url = await mergeRequestConfigurator.resourceUrl!({ values: { projectPath: "group/project", mergeRequestIid: "7" }, ui });
    expect(parseResourceUrl(INSTANCE, url as string)).toEqual({ projectPath: "group/project", kind: "mergeRequest", iid: 7 });
  });
});

describe("configurator pre-fill agrees with the server-side parser", () => {
  const cases = [
    `${INSTANCE}/group/project`,
    `${INSTANCE}/group/sub/deeper/project.git`,
    `${INSTANCE}/group/project/-/tree/main/src`,
    `${INSTANCE}/group/project/-/issues/42`,
    `${INSTANCE}/group/sub/project/-/issues/42/designs`,
    `${INSTANCE}/group/project/-/merge_requests/7`,
    `${INSTANCE}/group/project/-/merge_requests/7/diffs`,
    `${INSTANCE}/group/project/-/issues/abc`,
    `${INSTANCE}/group/project/-/merge_requests/7x`,
    `${INSTANCE}/group/project/-/issues`,
    `${INSTANCE}/-/profile`,
    `${INSTANCE}/single-segment`,
    "https://elsewhere.example.com/group/project",
    "not a url",
  ];

  it("on the project path", () => {
    for (const url of cases) {
      const server = parseResourceUrl(INSTANCE, url);
      const expected = server ? { projectPath: server.projectPath } : {};
      for (const [name, configurator, pattern] of [
        ["project", projectConfigurator, PATTERNS.project.urlPattern],
        ["issue", issueConfigurator, PATTERNS.issue.urlPattern],
        ["merge request", mergeRequestConfigurator, PATTERNS.mergeRequest.urlPattern],
      ] as const) {
        const values = configurator.initialValuesFromResourceUrl!({ resourceUrl: url, resourceUrlPattern: pattern, ui: noUi });
        expect({ projectPath: (values as { projectPath?: string }).projectPath }, `${name}: ${url}`)
          .toEqual({ projectPath: expected.projectPath });
      }
    }
  });

  it("on the issue and merge request numbers", () => {
    for (const url of cases) {
      const server = parseResourceUrl(INSTANCE, url);
      const issue = issueConfigurator.initialValuesFromResourceUrl!(
        { resourceUrl: url, resourceUrlPattern: PATTERNS.issue.urlPattern, ui: noUi }) as { issueIid?: string | null };
      const mr = mergeRequestConfigurator.initialValuesFromResourceUrl!(
        { resourceUrl: url, resourceUrlPattern: PATTERNS.mergeRequest.urlPattern, ui: noUi }) as { mergeRequestIid?: string | null };
      expect(issue.issueIid ?? null, `issue: ${url}`).toBe(server?.kind === "issue" ? String(server.iid) : null);
      expect(mr.mergeRequestIid ?? null, `merge request: ${url}`).toBe(server?.kind === "mergeRequest" ? String(server.iid) : null);
    }
  });
});
