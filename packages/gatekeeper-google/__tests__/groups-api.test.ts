import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GoogleGroupsApi, celString, groupEmailFromLink, groupSearchQuery, groupUrl, groupsApiDisabled,
  groupsErrorStatus, normalizeEmail, validateSearchText,
} from "../src/groups-api";
import { parseResourceUrl } from "../src/resources";

const FORUM = "cloudidentity.googleapis.com/groups.discussion_forum";

let requests: URL[] = [];

/** Answers each Cloud Identity request from `routes`, keyed by path; anything else is a 404. */
function stubGoogle(routes: Record<string, (url: URL) => Response>): void {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    let route = routes[url.pathname];
    return route ? route(url) : notFound();
  }));
}

function notFound(): Response {
  return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
}

function forbidden(): Response {
  return Response.json({ error: { code: 403, status: "PERMISSION_DENIED" } }, { status: 403 });
}

const api = () => new GoogleGroupsApi(async () => "access-token");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GoogleGroupsApi", () => {
  it("looks a group up by address and reads it as agent-facing metadata", async () => {
    stubGoogle({
      "/v1/groups:lookup": () => Response.json({ name: "groups/g1" }),
      "/v1/groups/g1": () => Response.json({
        name: "groups/g1",
        groupKey: { id: "Eng-Oncall@Example.com" },
        additionalGroupKeys: [{ id: "pager@example.com" }],
        parent: "customers/C01abc",
        displayName: "Eng on-call",
        description: "Who gets paged",
        createTime: "2024-05-01T12:00:00Z",
        labels: {
          [FORUM]: "", "cloudidentity.googleapis.com/groups.security": "",
          "cloudidentity.googleapis.com/groups.locked": "",
        },
      }),
    });

    let id = await api().lookupGroup("Eng-Oncall@Example.com");
    expect(requests[0].searchParams.get("groupKey.id")).toBe("eng-oncall@example.com");
    expect(await api().getGroup(id)).toEqual({
      parent: "customers/C01abc",
      info: {
        id: "groups/g1",
        email: "eng-oncall@example.com",
        aliases: ["pager@example.com"],
        name: "Eng on-call",
        description: "Who gets paged",
        url: "https://groups.google.com/a/example.com/g/eng-oncall",
        security: true,
        dynamic: false,
        locked: true,
        createdAt: new Date("2024-05-01T12:00:00Z"),
      },
    });
  });

  it("names a group with no display name by its address", async () => {
    stubGoogle({ "/v1/groups/g1": () => Response.json({ name: "groups/g1", groupKey: { id: "team@example.com" } }) });
    let { info } = await api().getGroup("groups/g1");
    expect(info.name).toBe("team@example.com");
    expect(info.aliases).toEqual([]);
    expect(info).not.toHaveProperty("createdAt");
  });

  // The ID is interpolated into every request path, so anything but Google's own shape is refused
  // before a request is made.
  it.each(["groups/../customers", "groups/", "customers/C01", "groups/a/memberships/b"])(
    "refuses the group ID %j without a request", async id => {
      stubGoogle({});
      await expect(api().getGroup(id)).rejects.toThrow("Not a valid Google Group ID.");
      expect(requests).toEqual([]);
    });

  it("lists direct members a page at a time, reporting each one's highest role", async () => {
    stubGoogle({
      "/v1/groups/g1/memberships": url => url.searchParams.get("pageToken") === "p2"
        ? Response.json({ memberships: [{ preferredMemberKey: { id: "bots@example.com" }, type: "GROUP", roles: [{ name: "MEMBER" }] }] })
        : Response.json({
          memberships: [
            { preferredMemberKey: { id: "Ada@Example.com" }, type: "USER", createTime: "2025-01-02T00:00:00Z",
              roles: [{ name: "MEMBER" }, { name: "OWNER" }] },
            { preferredMemberKey: { id: "grace@example.com" }, type: "USER", roles: [{ name: "MANAGER" }, { name: "MEMBER" }] },
            { preferredMemberKey: { id: "ci@proj.iam.gserviceaccount.com" }, type: "SERVICE_ACCOUNT" },
            // Not an address, so not lowercased: Google's identifiers may be case-sensitive.
            { preferredMemberKey: { id: "Drive-1" }, type: "SHARED_DRIVE", roles: [{ name: "MEMBER" }] },
            // Identity-mapped members carry an external ID, not an address, and are left out.
            { preferredMemberKey: { id: "user-42", namespace: "identitysources/abc" }, type: "USER" },
          ],
          nextPageToken: "p2",
        }),
    });

    let first = await api().listMembers("groups/g1");
    expect(requests[0].searchParams.get("view")).toBe("FULL");
    expect(requests[0].searchParams.get("pageSize")).toBe("200");
    expect(first).toEqual({
      items: [
        { email: "ada@example.com", kind: "user", role: "owner", addedAt: new Date("2025-01-02T00:00:00Z") },
        { email: "grace@example.com", kind: "user", role: "manager" },
        { email: "ci@proj.iam.gserviceaccount.com", kind: "serviceAccount", role: "member" },
        { email: "Drive-1", kind: "other", role: "member" },
      ],
      nextPageToken: "p2",
    });
    expect(await api().listMembers("groups/g1", "p2")).toEqual({
      items: [{ email: "bots@example.com", kind: "group", role: "member" }],
    });
  });

  it("finds a direct member by address, and reports none for someone who is not one", async () => {
    stubGoogle({
      "/v1/groups/g1/memberships:lookup": url => url.searchParams.get("memberKey.id") === "ada@example.com"
        ? Response.json({ name: "groups/g1/memberships/m1" }) : notFound(),
      "/v1/groups/g1/memberships/m1": () => Response.json({
        name: "groups/g1/memberships/m1", preferredMemberKey: { id: "ada@example.com" }, type: "USER",
        roles: [{ name: "MANAGER" }, { name: "MEMBER" }],
      }),
      "/v1/groups/g1/memberships": () => Response.json({ memberships: [] }),
    });
    expect(await api().findMember("groups/g1", "ADA@example.com"))
      .toEqual({ email: "ada@example.com", kind: "user", role: "manager" });
    expect(await api().findMember("groups/g1", "bob@example.com")).toBeNull();
  });

  // "Not found" from the lookup is only an answer while the member list can still be read: a group
  // that has gone may answer the lookup the same way.
  it("throws, rather than reporting no member, when the group itself is gone", async () => {
    stubGoogle({});
    await expect(api().findMember("groups/g1", "bob@example.com")).rejects.toThrow("[http=404]");
  });

  // A refusal is not an answer: a group whose members the caller cannot see must not read as one
  // that has no such member.
  it("throws, rather than reporting no member, when the members cannot be seen", async () => {
    stubGoogle({ "/v1/groups/g1/memberships:lookup": () => forbidden() });
    await expect(api().findMember("groups/g1", "ada@example.com")).rejects.toThrow("[http=403]");
  });

  it("tells a disabled API apart from a refusal, by Google's own reason", async () => {
    stubGoogle({
      "/v1/groups/g1": () => Response.json({
        error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] },
      }, { status: 403 }),
      "/v1/groups/g2": () => forbidden(),
    });
    let disabled = await api().getGroup("groups/g1").catch((error: unknown) => error);
    let refused = await api().getGroup("groups/g2").catch((error: unknown) => error);
    expect([groupsErrorStatus(disabled), groupsApiDisabled(disabled)]).toEqual([403, true]);
    expect([groupsErrorStatus(refused), groupsApiDisabled(refused)]).toEqual([403, false]);
    // A failure that is not Google's answer carries no status at all.
    expect(groupsErrorStatus(new Error("Failed to refresh access token: 401 Unauthorized"))).toBeUndefined();
  });

  it("refuses a membership Google says belongs to another group", async () => {
    stubGoogle({
      "/v1/groups/g1/memberships:lookup": () => Response.json({ name: "groups/g2/memberships/m1" }),
    });
    await expect(api().findMember("groups/g1", "ada@example.com"))
      .rejects.toThrow("unexpected membership");
  });

  it("lists the groups someone directly belongs to, with their role in each", async () => {
    stubGoogle({
      "/v1/groups/-/memberships:searchDirectGroups": () => Response.json({
        memberships: [{
          group: "groups/g1", groupKey: { id: "team@example.com" }, displayName: "Team",
          description: "The team", labels: { [FORUM]: "", "cloudidentity.googleapis.com/groups.dynamic": "" },
          roles: [{ name: "MEMBER" }],
        }],
        nextPageToken: "next",
      }),
    });
    expect(await api().listGroupsOf("Ada@Example.com")).toEqual({
      items: [{
        role: "member",
        info: {
          id: "groups/g1", email: "team@example.com", name: "Team", description: "The team",
          url: "https://groups.google.com/a/example.com/g/team", security: false, dynamic: true,
          locked: false,
        },
      }],
      nextPageToken: "next",
    });
    expect(requests[0].searchParams.get("query"))
      .toBe(`member_key_id == 'ada@example.com' && '${FORUM}' in labels`);
  });

  it("searches with the query it is given, a page at a time", async () => {
    stubGoogle({
      "/v1/groups:search": () => Response.json({
        groups: [{ name: "groups/g1", groupKey: { id: "eng@example.com" }, displayName: "Engineering" }],
      }),
    });
    let query = groupSearchQuery("customers/C01abc", "display_name", "eng");
    let page = await api().searchGroups(query, "token-2");
    expect(page.items.map(info => info.email)).toEqual(["eng@example.com"]);
    expect(page).not.toHaveProperty("nextPageToken");
    expect(requests[0].searchParams.get("query")).toBe(query);
    expect(requests[0].searchParams.get("pageToken")).toBe("token-2");
  });

  describe("findCustomer", () => {
    it("takes the owner of the account's first group in its own domain", async () => {
      stubGoogle({
        "/v1/groups/-/memberships:searchDirectGroups": () => Response.json({
          memberships: [
            { group: "groups/ext", groupKey: { id: "partners@other.com" } },
            { group: "groups/g1", groupKey: { id: "team@example.com" } },
          ],
        }),
        "/v1/groups/g1": () => Response.json({
          name: "groups/g1", groupKey: { id: "team@example.com" }, parent: "customers/C01abc",
        }),
      });
      expect(await api().findCustomer("me@example.com")).toBe("customers/C01abc");
      // A group of another organization is never read, let alone taken as the account's own.
      expect(requests.map(url => url.pathname)).not.toContain("/v1/groups/ext");
    });

    it("passes over an own-domain group that can no longer be read", async () => {
      stubGoogle({
        "/v1/groups/-/memberships:searchDirectGroups": () => Response.json({
          memberships: [
            { group: "groups/gone", groupKey: { id: "old@example.com" } },
            { group: "groups/g1", groupKey: { id: "team@example.com" } },
          ],
        }),
        "/v1/groups/gone": () => forbidden(),
        "/v1/groups/g1": () => Response.json({
          name: "groups/g1", groupKey: { id: "team@example.com" }, parent: "customers/C01abc",
        }),
      });
      expect(await api().findCustomer("me@example.com")).toBe("customers/C01abc");
    });

    // Without a cap, an account in a thousand groups Google returns without an owner would read
    // every one of them on every search.
    it("gives up after a few own-domain groups that name no owner", async () => {
      stubGoogle({
        "/v1/groups/-/memberships:searchDirectGroups": () => Response.json({
          memberships: Array.from({ length: 10 }, (_, i) =>
            ({ group: `groups/g${i}`, groupKey: { id: `team${i}@example.com` } })),
        }),
        ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`/v1/groups/g${i}`,
          () => Response.json({ name: `groups/g${i}`, groupKey: { id: `team${i}@example.com` } })])),
      });
      expect(await api().findCustomer("me@example.com")).toBeNull();
      expect(requests.filter(url => /^\/v1\/groups\/g\d$/.test(url.pathname))).toHaveLength(3);
    });

    it("reports no customer for an account in no group of its own domain", async () => {
      stubGoogle({
        "/v1/groups/-/memberships:searchDirectGroups": () => Response.json({
          memberships: [{ group: "groups/ext", groupKey: { id: "partners@other.com" } }],
        }),
      });
      expect(await api().findCustomer("me@example.com")).toBeNull();
    });
  });
});

describe("Google Groups query text", () => {
  // Caller text reaches a CEL query only as a string literal, so it can never close the literal and
  // widen the search past the account's own organization.
  it("escapes quotes and backslashes in search text", () => {
    expect(celString("dan's \\ team")).toBe("'dan\\'s \\\\ team'");
    expect(groupSearchQuery("customers/C01abc", "group_key", "x' || true || 'y")).toBe(
      `parent == 'customers/C01abc' && '${FORUM}' in labels && ` +
      "group_key.contains('x\\' || true || \\'y')");
  });

  // Addresses are lowercase, so lowercasing the address search can only help it match; how Google
  // compares names is undocumented, so the name search keeps the text as given.
  it("lowercases only the address search", () => {
    expect(groupSearchQuery("customers/C01abc", "group_key", "Eng")).toContain("group_key.contains('eng')");
    expect(groupSearchQuery("customers/C01abc", "display_name", "Eng")).toContain("display_name.contains('Eng')");
  });

  it.each([
    ["empty", "   ", "required"],
    ["too long", "x".repeat(101), "at most 100"],
    ["a control character", "eng\nteam", "control characters"],
  ])("refuses %s search text", (_name, text, message) => {
    expect(() => validateSearchText(text)).toThrow(message);
  });

  it("refuses a malformed customer", () => {
    expect(() => groupSearchQuery("customers/C01' || true", "display_name", "x"))
      .toThrow("Not a valid Google Workspace customer.");
  });
});

describe("Google Groups addresses and links", () => {
  it.each([
    "team", "team@", "@example.com", "te am@example.com", "team@localhost", "a@b@example.com",
    // The Kelvin sign lowercases to an ASCII `k`, so it must be refused before lowercasing.
    "\u212Ateam@example.com", "team@\u212Aexample.com",
  ])("refuses %j as an address", value => {
    expect(() => normalizeEmail(value)).toThrow("Expected an email address");
  });

  it("lowercases an address it accepts", () => {
    expect(normalizeEmail("  Eng-Team@Example.COM ")).toBe("eng-team@example.com");
  });

  it.each([
    ["the group's page", "https://groups.google.com/a/example.com/g/team", "team@example.com"],
    ["its members page", "https://groups.google.com/a/example.com/g/team/members", "team@example.com"],
    ["a conversation in it", "https://groups.google.com/a/example.com/g/team/c/abc123", "team@example.com"],
    ["an encoded name", "https://groups.google.com/a/Example.com/g/dan%27s.team", "dan's.team@example.com"],
  ])("reads the group's address from %s", (_name, link, email) => {
    expect(groupEmailFromLink(link)).toBe(email);
  });

  it.each([
    "team@example.com",
    "https://groups.google.com/g/team",
    "https://groups.google.com/my-groups",
    "http://groups.google.com/a/example.com/g/team",
    "https://groups.google.com.evil.example/a/example.com/g/team",
    "https://groups.google.com/a/example.com/g/%ZZ",
  ])("reads no group from %j", text => {
    expect(groupEmailFromLink(text)).toBeUndefined();
  });

  // The URL a group's metadata reports is the one an agent can request a connection with.
  it("reports each group's URL in the form its binding parses", () => {
    for (let email of ["team@example.com", "dan's+ops@sub.example.com"]) {
      expect(parseResourceUrl(groupUrl(email))).toEqual({ kind: "group", groupEmail: email });
    }
  });
});
