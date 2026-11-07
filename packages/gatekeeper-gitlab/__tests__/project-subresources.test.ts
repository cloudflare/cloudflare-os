// The subresource IDs GitLab reads report, and the one parser verifyObserverAccess and the account
// check read them back with: each kind round-trips, and every other spelling is refused.

import { describe, expect, it } from "vitest";
import {
  instanceSubresourceId, parseGitLabSubresource, projectSubresourceId, repositorySubresourceId,
} from "../src/project-subresources";

describe("GitLab subresource IDs", () => {
  it("formats and parses each kind", () => {
    expect(projectSubresourceId(42)).toBe("project/42");
    expect(projectSubresourceId(42, "maintainer")).toBe("project/42/role/maintainer");
    expect(repositorySubresourceId(42)).toBe("repository/42");
    expect(instanceSubresourceId("gitlab.example.com")).toBe("instance/gitlab.example.com");
    expect(instanceSubresourceId("gitlab.example.com:8443")).toBe("instance/gitlab.example.com%3A8443");

    expect(parseGitLabSubresource("project/42")).toEqual({ kind: "project", projectId: 42 });
    expect(parseGitLabSubresource("project/42/role/developer"))
      .toEqual({ kind: "project", projectId: 42, minAccessLevel: 30 });
    expect(parseGitLabSubresource("repository/42")).toEqual({ kind: "repository", projectId: 42 });
    expect(parseGitLabSubresource("instance/gitlab.example.com%3A8443"))
      .toEqual({ kind: "instance", host: "gitlab.example.com:8443" });
  });

  it("refuses ids that are not positive safe integers, and hosts not spelled as URL.host spells them", () => {
    expect(() => repositorySubresourceId(0)).toThrow();
    expect(() => repositorySubresourceId(1.5)).toThrow();
    expect(() => instanceSubresourceId("GitLab.example.com")).toThrow();
    expect(() => instanceSubresourceId("gitlab.example.com:443")).toThrow();
    expect(() => instanceSubresourceId("gitlab.example.com/path")).toThrow();
    expect(() => instanceSubresourceId("")).toThrow();
  });

  it.each([
    "repository/042", "repository/-1", "repository/0", "repository/9007199254740993", "repository/4%32",
    "repository/42/role/developer", "gitlab/repository/42", "repository", "instance",
    "instance/GITLAB.EXAMPLE.COM", "instance/gitlab.example.com%3A443", "instance/a%2Fb",
    "project/42/repository/42", "project/42/role/owner", "global",
  ])("refuses %s", id => {
    expect(() => parseGitLabSubresource(id)).toThrow();
  });
});
