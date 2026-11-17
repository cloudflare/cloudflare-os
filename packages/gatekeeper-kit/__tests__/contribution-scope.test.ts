// contribution-scope.ts coverage: the contributor URL query grammar (strict: branchPrefix first,
// no unknown or repeated parameters, a prefix that names a namespace), its canonical inverse, and
// the branch and visibility checks a contributor binding applies to each write.

import { describe, expect, it } from "vitest";
import {
  assertContributionBranch,
  assertContributionVisibility,
  contributionScopeQuery,
  parseContributionScope,
  validateBranchPrefix,
} from "../src/contribution-scope";

const query = (text: string) => new URLSearchParams(text);
const SCOPE = { branchPrefix: "cloudflare-os/", allowPublic: false };
const PRIVATE = { isPublic: false, defaultBranch: "main" };

describe("parseContributionScope", () => {
  it("reads no scope from an empty query, and the scope from a well-formed one", () => {
    expect(parseContributionScope(query(""))).toBeNull();
    expect(parseContributionScope(query("branchPrefix=cloudflare-os/"))).toEqual(SCOPE);
    expect(parseContributionScope(query("branchPrefix=cloudflare-os%2F&allowPublic=true")))
      .toEqual({ branchPrefix: "cloudflare-os/", allowPublic: true });
    expect(parseContributionScope(query("branchPrefix=a/b/&allowPublic=false")))
      .toEqual({ branchPrefix: "a/b/", allowPublic: false });
  });

  it("refuses a query it would otherwise have to partly ignore", () => {
    // The resource pattern keys on branchPrefix coming first.
    expect(() => parseContributionScope(query("allowPublic=true&branchPrefix=x/"))).toThrow(/start its query/);
    expect(() => parseContributionScope(query("branchPrefix=x/&force=true"))).toThrow(/Unsupported/);
    expect(() => parseContributionScope(query("branchPrefix=x/&branchPrefix=y/"))).toThrow(/only once/);
    expect(() => parseContributionScope(query("branchPrefix=x/&allowPublic=yes"))).toThrow(/true or false/);
    expect(() => parseContributionScope(query("utm_source=x"))).toThrow(/start its query/);
  });

  it("refuses a prefix that is not a branch namespace", () => {
    for (const prefix of ["", "/", "main", "cloudflare-os", "a//", "../x/", "-x /", ".x/", "a..b/", "x".repeat(101) + "/"]) {
      expect(() => validateBranchPrefix(prefix), prefix).toThrow(/invalid branch/);
    }
    expect(validateBranchPrefix("cloudflare-os/fix/")).toBe("cloudflare-os/fix/");
  });
});

describe("contributionScopeQuery", () => {
  it("is the canonical inverse of the parser, with branchPrefix first and allowPublic only when true", () => {
    expect(contributionScopeQuery(SCOPE)).toBe("?branchPrefix=cloudflare-os%2F");
    const allow = { branchPrefix: "cloudflare-os/", allowPublic: true };
    expect(contributionScopeQuery(allow)).toBe("?branchPrefix=cloudflare-os%2F&allowPublic=true");
    for (const scope of [SCOPE, allow]) {
      expect(parseContributionScope(query(contributionScopeQuery(scope).slice(1)))).toEqual(scope);
    }
  });
});

describe("contribution checks", () => {
  it("allows only branches strictly under the prefix, never the default branch", () => {
    expect(assertContributionBranch(SCOPE, PRIVATE, "cloudflare-os/fix/1-2")).toBe("cloudflare-os/fix/1-2");
    for (const branch of ["main", "cloudflare-os", "cloudflare-os/", "cloudflare-osx/fix", "x/cloudflare-os/fix"]) {
      expect(() => assertContributionBranch(SCOPE, PRIVATE, branch), branch).toThrow();
    }
    // A default branch that happens to live under the prefix is still refused.
    expect(() => assertContributionBranch(SCOPE, { isPublic: false, defaultBranch: "cloudflare-os/main" }, "cloudflare-os/main"))
      .toThrow(/default branch/);
    // Names git would refuse never reach the prefix test.
    expect(() => assertContributionBranch(SCOPE, PRIVATE, "cloudflare-os/../main")).toThrow(/invalid branch/);
  });

  it("refuses a public repository unless the scope allows it", () => {
    expect(() => assertContributionVisibility(SCOPE, { isPublic: true, defaultBranch: "main" })).toThrow(/public/);
    expect(() => assertContributionVisibility({ ...SCOPE, allowPublic: true }, { isPublic: true, defaultBranch: "main" }))
      .not.toThrow();
    expect(() => assertContributionVisibility(SCOPE, PRIVATE)).not.toThrow();
  });
});
