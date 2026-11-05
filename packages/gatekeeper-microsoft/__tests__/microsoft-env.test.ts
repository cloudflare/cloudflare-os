import { describe, expect, it } from "vitest";
import {
  MicrosoftConfigurationError, SHAREPOINT_RESOURCE, acceptsTenant, effectiveSharePoint, getBasePath, getRedirectUri,
  grantedResourcePatterns, grantedSharePoint, oauthEndpoints, scopesFor, sharePointAccess, tenantPolicy, type Env,
  OUTLOOK_RESOURCE, effectiveOutlookAccess, grantedOutlookAccess, grantsSharedMailboxes, outlookAccess,
} from "../src/microsoft-env";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const OTHER = "11111111-2222-3333-4444-555555555555";
const env = (values: Partial<Env> = {}) => values as Env;

describe("tenantPolicy", () => {
  it("signs in against one tenant named by ID or verified domain", () => {
    expect(tenantPolicy(env({ MICROSOFT_TENANT_ID: ` ${TENANT} ` }))).toEqual({ kind: "single", authority: TENANT });
    expect(tenantPolicy(env({ MICROSOFT_TENANT_ID: "contoso.onmicrosoft.com" }))).toEqual({ kind: "single", authority: "contoso.onmicrosoft.com" });
  });

  it("accepts any organization only with an allowlist of tenant IDs", () => {
    const policy = tenantPolicy(env({ MICROSOFT_ALLOWED_TENANT_IDS: ` ${TENANT.toUpperCase()}, ${OTHER},, ` }));
    expect(policy).toEqual({ kind: "allowlist", authority: "organizations", tenantIds: new Set([TENANT, OTHER]) });
    expect(tenantPolicy(env({ MICROSOFT_TENANT_ID: "Organizations", MICROSOFT_ALLOWED_TENANT_IDS: TENANT })).kind).toBe("allowlist");
  });

  it("refuses organizations with no allowlist, the default, since any company could connect", () => {
    expect(() => tenantPolicy(env())).toThrow(MicrosoftConfigurationError);
    expect(() => tenantPolicy(env({ MICROSOFT_ALLOWED_TENANT_IDS: " , " }))).toThrow(/names none it trusts/);
  });

  it("refuses an allowlist of domains, which a token's tid never matches", () => {
    expect(() => tenantPolicy(env({ MICROSOFT_ALLOWED_TENANT_IDS: `${TENANT},contoso.com` }))).toThrow(/tenant IDs \(GUIDs\), not domains/);
  });

  it.each(["common", "consumers"])("refuses %s, which admits personal accounts with no SharePoint", tenant => {
    expect(() => tenantPolicy(env({ MICROSOFT_TENANT_ID: tenant }))).toThrow(/personal Microsoft accounts have no SharePoint/);
  });

  it.each(["not a tenant", "../evil", "contoso", "https://login.microsoftonline.com/x"])("refuses %j", tenant => {
    expect(() => tenantPolicy(env({ MICROSOFT_TENANT_ID: tenant }))).toThrow(/must be a tenant ID, a verified domain/);
  });
});

describe("acceptsTenant", () => {
  const allowlist = tenantPolicy(env({ MICROSOFT_ALLOWED_TENANT_IDS: TENANT }));
  const single = tenantPolicy(env({ MICROSOFT_TENANT_ID: TENANT }));

  it("checks a token's tenant against the allowlist, in any case", () => {
    expect(acceptsTenant(allowlist, TENANT.toUpperCase())).toBe(true);
    expect(acceptsTenant(allowlist, OTHER)).toBe(false);
  });

  it("checks a token's tenant against an authority named by ID", () => {
    expect(acceptsTenant(single, TENANT.toUpperCase())).toBe(true);
    expect(acceptsTenant(single, OTHER)).toBe(false);
  });

  it("holds a connection to the tenant it was first made in, even when the authority is a domain", () => {
    const domain = tenantPolicy(env({ MICROSOFT_TENANT_ID: "contoso.com" }));
    expect(acceptsTenant(domain, OTHER)).toBe(true);
    expect(acceptsTenant(domain, TENANT, TENANT)).toBe(true);
    expect(acceptsTenant(domain, OTHER, TENANT)).toBe(false);
    expect(acceptsTenant(single, TENANT, OTHER)).toBe(false);
  });
});

describe("endpoints", () => {
  it("builds the authority's OAuth endpoints, encoding it", () => {
    expect(oauthEndpoints(TENANT)).toEqual({
      authorize: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
      token: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    });
  });

  it("derives the callback from the base URL, without a trailing slash", () => {
    expect(getRedirectUri(env({ BASE_URL: "https://gadgets.example/gatekeeper/microsoft/" }))).toBe("https://gadgets.example/gatekeeper/microsoft/oauth");
    expect(getBasePath(env({ BASE_URL: "https://gadgets.example/gatekeeper/microsoft" }))).toBe("/gatekeeper/microsoft");
  });
});

describe("sharePointAccess", () => {
  it("is write when unset, read for anything the deployment didn't spell as write", () => {
    expect(sharePointAccess(env())).toBe("write");
    expect(sharePointAccess(env({ MICROSOFT_SHAREPOINT_ACCESS: "" }))).toBe("write");
    expect(sharePointAccess(env({ MICROSOFT_SHAREPOINT_ACCESS: " Write " }))).toBe("write");
    expect(sharePointAccess(env({ MICROSOFT_SHAREPOINT_ACCESS: " READ " }))).toBe("read");
    expect(sharePointAccess(env({ MICROSOFT_SHAREPOINT_ACCESS: "readonly" }))).toBe("read");
  });
});

describe("scopesFor", () => {
  const sharePoint = [SHAREPOINT_RESOURCE.urlPattern];

  it("asks for the base scopes plus the access level's Graph permissions, qualified", () => {
    expect(scopesFor(env({ MICROSOFT_SHAREPOINT_ACCESS: "read" }), sharePoint)).toEqual([
      "openid", "profile", "email", "offline_access", "User.Read",
      "https://graph.microsoft.com/Sites.Read.All", "https://graph.microsoft.com/Files.Read.All",
    ]);
    expect(scopesFor(env(), sharePoint)).toContain("https://graph.microsoft.com/Sites.ReadWrite.All");
  });

  it("asks for Outlook's permissions at the deployment's Outlook ceiling", () => {
    const outlook = [OUTLOOK_RESOURCE.urlPattern];
    expect(scopesFor(env(), outlook)).toEqual(expect.arrayContaining([
      "https://graph.microsoft.com/Mail.ReadWrite", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/People.Read",
    ]));
    const draft = scopesFor(env({ MICROSOFT_OUTLOOK_ACCESS: "draft" }), outlook);
    expect(draft).toContain("https://graph.microsoft.com/Mail.ReadWrite");
    expect(draft).not.toContain("https://graph.microsoft.com/Mail.Send");
    expect(scopesFor(env({ MICROSOFT_OUTLOOK_ACCESS: "read" }), outlook)).not.toContain("https://graph.microsoft.com/Mail.ReadWrite");
    // An unrecognized ceiling is the safe side.
    expect(outlookAccess(env({ MICROSOFT_OUTLOOK_ACCESS: "everything" }))).toBe("read");
    expect(outlookAccess(env())).toBe("send");
  });

  it("asks for Sites.Selected and the user's own files when the deployment wants selected sites, or misspells all", () => {
    const selected = scopesFor(env({ MICROSOFT_SHAREPOINT_SITES: "Selected" }), sharePoint);
    expect(scopesFor(env({ MICROSOFT_SHAREPOINT_SITES: "al" }), sharePoint)).toEqual(selected);
    expect(selected).toEqual(expect.arrayContaining(["https://graph.microsoft.com/Sites.Selected", "https://graph.microsoft.com/Files.ReadWrite"]));
    expect(selected.some(scope => scope.endsWith(".All"))).toBe(false);
    expect(scopesFor(env({ MICROSOFT_SHAREPOINT_SITES: "selected", MICROSOFT_SHAREPOINT_ACCESS: "read" }), sharePoint))
      .toContain("https://graph.microsoft.com/Files.Read");
    // Unset or `all` is every site, the default.
    expect(scopesFor(env({ MICROSOFT_SHAREPOINT_SITES: " All " }), sharePoint)).toContain("https://graph.microsoft.com/Sites.ReadWrite.All");
  });

  it("asks for nothing beyond sign-in for no resource types, and refuses unknown ones", () => {
    expect(scopesFor(env(), [])).toEqual(["openid", "profile", "email", "offline_access", "User.Read"]);
    expect(scopesFor(env(), sharePoint)).toHaveLength(7);
    expect(() => scopesFor(env(), ["https://*.google.com/*"])).toThrow(/Unknown Microsoft 365 resource type/);
  });
});

describe("reading an Outlook grant", () => {
  const mail = ["User.Read", "Mail.ReadWrite", "People.Read"];

  it("reads send, draft and read from the mail permissions, and needs the People API", () => {
    expect(grantedOutlookAccess([...mail, "Mail.Send"])).toBe("send");
    expect(grantedOutlookAccess(mail)).toBe("draft");
    expect(grantedOutlookAccess(["User.Read", "Mail.Read", "People.Read"])).toBe("read");
    expect(grantedOutlookAccess(["User.Read", "Mail.ReadWrite"])).toBeNull();
    expect(grantedResourcePatterns(mail)).toEqual([OUTLOOK_RESOURCE.urlPattern]);
  });

  it("narrows a binding to the lowest of what it chose, the ceiling and the grant", () => {
    expect(effectiveOutlookAccess(env(), [...mail, "Mail.Send"], "send")).toBe("send");
    expect(effectiveOutlookAccess(env(), mail, "send")).toBe("draft");
    expect(effectiveOutlookAccess(env({ MICROSOFT_OUTLOOK_ACCESS: "draft" }), [...mail, "Mail.Send"], "send")).toBe("draft");
    expect(effectiveOutlookAccess(env(), [...mail, "Mail.Send"], "read")).toBe("read");
    expect(effectiveOutlookAccess(env(), ["User.Read"], "send")).toBeNull();
  });

  it("opens shared mailboxes only with the .Shared permissions for the level", () => {
    const lookup = [...mail, "User.ReadBasic.All"];
    expect(grantsSharedMailboxes([...lookup, "Mail.ReadWrite.Shared"], "draft")).toBe(true);
    expect(grantsSharedMailboxes([...lookup, "Mail.ReadWrite.Shared"], "send")).toBe(false);
    expect(grantsSharedMailboxes(mail, "read")).toBe(false);
  });

  it("opens shared mailboxes only when the grant can look up their owner", () => {
    expect(grantsSharedMailboxes([...mail, "Mail.ReadWrite.Shared"], "read")).toBe(false);
  });
});

describe("reading a grant", () => {
  const read = ["https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Sites.Read.All", "https://graph.microsoft.com/Files.Read.All"];
  const write = ["User.Read", "Sites.ReadWrite.All", "Files.ReadWrite.All"];

  it("reads Entra's scopes whether qualified or bare, in any case", () => {
    expect(grantedSharePoint(read)?.access).toBe("read");
    expect(grantedSharePoint(write)?.access).toBe("write");
    expect(grantedSharePoint(["user.read", "sites.readwrite.all", "FILES.READWRITE.ALL"])?.access).toBe("write");
  });

  it("counts a ReadWrite permission as covering read", () => {
    expect(grantedSharePoint(["Sites.ReadWrite.All", "Files.Read.All"])?.access).toBe("read");
  });

  it("is write only when both ReadWrite permissions were consented", () => {
    expect(grantedSharePoint(["Sites.ReadWrite.All"])).toBeNull();
    expect(grantedSharePoint(["Files.ReadWrite.All", "Sites.Read.All"])?.access).toBe("read");
    expect(grantedSharePoint(["openid", "User.Read"])).toBeNull();
  });

  it("covers the SharePoint resource only with User.Read and a SharePoint grant", () => {
    expect(grantedResourcePatterns(read)).toEqual([SHAREPOINT_RESOURCE.urlPattern]);
    expect(grantedResourcePatterns(["Sites.Read.All", "Files.Read.All"])).toEqual([]);
    expect(grantedResourcePatterns(["User.Read"])).toEqual([]);
  });

  it("reads Sites.Selected as only the granted sites, with OneDrive only alongside Files.Read or ReadWrite", () => {
    expect(grantedSharePoint(["User.Read", "Sites.Selected", "Files.ReadWrite"])).toEqual({ sites: "selected", access: "write", oneDrive: true });
    expect(grantedSharePoint(["User.Read", "Sites.Selected", "Files.Read"])).toMatchObject({ oneDrive: true });
    expect(grantedSharePoint(["User.Read", "Sites.Selected"])).toMatchObject({ sites: "selected", oneDrive: false });
    expect(grantedResourcePatterns(["User.Read", "Sites.Selected"])).toEqual([SHAREPOINT_RESOURCE.urlPattern]);
    // Every site wins when the grant holds both, whatever the deployment asked for.
    expect(grantedSharePoint([...write, "Sites.Selected"])).toMatchObject({ sites: "all", access: "write" });
    expect(effectiveSharePoint(env({ MICROSOFT_SHAREPOINT_ACCESS: "read" }), ["User.Read", "Sites.Selected"])).toMatchObject({ access: "read" });
  });

  it("narrows a binding to the lower of the deployment's ceiling and the grant", () => {
    expect(effectiveSharePoint(env(), write)?.access).toBe("write");
    expect(effectiveSharePoint(env(), read)?.access).toBe("read");
    expect(effectiveSharePoint(env({ MICROSOFT_SHAREPOINT_ACCESS: "read" }), write)?.access).toBe("read");
    expect(effectiveSharePoint(env({ MICROSOFT_SHAREPOINT_ACCESS: "read" }), ["User.Read"])).toBeNull();
  });
});
