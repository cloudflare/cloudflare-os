import { describe, expect, it } from "vitest";
import {
  findResourceType, getGrantedResourceTypeIds, getResourceTypeId, requestedResourceUrlPatterns,
  resolveRequestedResource, resourceTypeUrlPattern, type SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";
import { filterEnabledResources, normalizeAdminConfig } from "../src/admin-config";

const repository: SupportedResource = {
  id: "repository", urlPattern: "https://git.example/repos/:repo", title: "Repository", description: "Code",
};
const issue: SupportedResource = {
  id: "issue", urlPattern: "https://git.example/repos/:repo/issues/:id", title: "Issue", description: "Issue",
};
const renamed = { ...repository, urlPattern: "https://git.example/projects/:repo" };

describe("vendor-scoped resource type identity", () => {
  it("keeps an ID reference working across pattern changes and never falls back from an unknown ID", () => {
    expect(findResourceType([renamed, issue], "repository", repository.urlPattern)).toEqual(renamed);
    expect(findResourceType([repository], "retired", repository.urlPattern)).toBeUndefined();
    expect(findResourceType([repository], undefined, repository.urlPattern)).toEqual(repository);
    expect(findResourceType([renamed], undefined, repository.urlPattern)).toBeUndefined();
    expect(findResourceType([repository], undefined, "https://git.example/repos/*")).toBeUndefined();
  });

  it("supports older gatekeepers without IDs without inventing one from a title", () => {
    const legacy = { ...repository, id: undefined };
    expect(getResourceTypeId(legacy)).toBe(legacy.urlPattern);
    expect(findResourceType([legacy], legacy.urlPattern)).toEqual(legacy);
    expect(findResourceType([legacy], legacy.title)).toBeUndefined();
  });

  it("selects an explicit connection type and rejects an unknown ID despite a matching URL", () => {
    expect(resolveRequestedResource([renamed, issue], undefined, "repository"))
      .toEqual({ ok: true, resource: renamed });
    expect(resolveRequestedResource([repository], "https://git.example/repos/test", "retired").ok)
      .toBe(false);
  });

  it("translates only exact legacy grants and preserves empty-vs-full and ID precedence", () => {
    expect(getGrantedResourceTypeIds({}, [repository])).toBeUndefined();
    expect(getGrantedResourceTypeIds({ grantedResourceUrlPatterns: [] }, [repository])).toEqual([]);
    expect(getGrantedResourceTypeIds({ grantedResourceUrlPatterns: [repository.urlPattern] }, [repository]))
      .toEqual(["repository"]);
    expect(getGrantedResourceTypeIds({ grantedResourceUrlPatterns: [repository.urlPattern] }, [renamed]))
      .toEqual([]);
    expect(getGrantedResourceTypeIds({
      grantedResourceTypeIds: [], grantedResourceUrlPatterns: [repository.urlPattern],
    }, [repository])).toEqual([]);
    expect(getGrantedResourceTypeIds({ grantedResourceTypeIds: ["repository"] }, [renamed]))
      .toEqual(["repository"]);
  });

  it("keeps account-connect scope selection explicit, including no resources", () => {
    expect(requestedResourceUrlPatterns(undefined, [repository])).toBeUndefined();
    expect(requestedResourceUrlPatterns({ resourceTypeIds: [] }, [repository])).toEqual([]);
    expect(requestedResourceUrlPatterns({ resourceTypeIds: ["repository"] }, [renamed]))
      .toEqual([renamed.urlPattern]);
    expect(() => requestedResourceUrlPatterns({ resourceTypeIds: ["retired"] }, [repository])).toThrow();
    expect(() => requestedResourceUrlPatterns({ resourceTypeIds: [], resourceUrlPatterns: [] }, [repository]))
      .toThrow("not both");
    expect(resourceTypeUrlPattern([repository], repository.urlPattern)).toBe(repository.urlPattern);
    expect(() => resourceTypeUrlPattern([renamed], repository.urlPattern)).toThrow();
  });
});

describe("resource restriction migration", () => {
  it("keeps ID restrictions enforced after a URL pattern changes", () => {
    const config = normalizeAdminConfig({ disabledResourceTypeIds: { git: ["repository"] } });
    expect(filterEnabledResources(config, "git", [renamed, issue])).toEqual([issue]);
    expect(filterEnabledResources(config, "other-vendor", [renamed])).toEqual([renamed]);
  });

  it("applies exact legacy restrictions and blocks the vendor when one can no longer be identified", () => {
    const config = normalizeAdminConfig({ disabledResources: { git: [repository.urlPattern] } });
    expect(filterEnabledResources(config, "git", [repository, issue])).toEqual([issue]);
    expect(filterEnabledResources(config, "git", [renamed, issue])).toEqual([]);
    // An account narrowing its list does not make a known vendor type an unknown restriction.
    expect(filterEnabledResources(config, "git", [issue], [repository, issue])).toEqual([issue]);
  });
});
