import { env } from "cloudflare:test";
import type { RpcStub } from "cloudflare:workers";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleGroupImpl, GoogleGroupsSessionImpl, type GroupsContext } from "../../src/groups";
import { GoogleGroupsApi } from "../../src/groups-api";
import type { GoogleGroupEntry, GoogleGroupMember, GoogleGroupMembershipEntry } from "../../src/groups-types";
import { SharedApprovalQueue } from "../../src/shared-approval-queue";

const FORUM = "cloudidentity.googleapis.com/groups.discussion_forum";

/**
 * The approval queue as the sessions call it: it records what it authorizes, refuses an observation
 * when told to, and notes when the last capability holding it lets it go.
 */
class FakeQueue {
  readonly observations: ObservationDescription[] = [];
  /** Titles of observations to refuse, each once. */
  readonly refusing = new Set<string>();
  disposed = false;

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.refusing.delete(description.title)) throw new Error("Refused by the test.");
    this.observations.push(description);
  }

  async submitAction(): Promise<void> {
    throw new Error("Google Groups is read-only and must queue nothing");
  }

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}

/** The token the test worker's `UserAccount` issues for the account named `name`. */
function tokenFor(name: string): string {
  return `test-access-token:${env.USER_ACCOUNT.idFromName(name)}`;
}

type FakeMember = { email: string; type: string; roles: string[] };

type FakeGroup = {
  id: string;
  email: string;
  displayName?: string;
  parent?: string;
  members: FakeMember[];
  /** Accounts Google refuses the group to outright, as it does someone who cannot see it. */
  hiddenFrom?: string[];
  /** Accounts Google tells the group does not exist. */
  notFoundFor?: string[];
  /** Accounts that can see the group but not its members. */
  membersHiddenFrom?: string[];
  /** Accounts whose member reads fail with this status, as an outage would. */
  membersFailing?: Record<string, number>;
};

const member = (email: string, ...roles: string[]): FakeMember =>
  ({ email, type: "USER", roles: ["MEMBER", ...roles] });

function json(body: unknown, status = 200): Response {
  return Response.json(status === 200 ? body : { error: { code: status } }, { status });
}

/**
 * Cloud Identity and the userinfo endpoint, answering each request as the account its token names,
 * with Google's visibility rules: a hidden group is refused, and so are hidden members. Search
 * matches as CEL's `contains` does, case-sensitively.
 */
class FakeGoogle {
  groups: FakeGroup[] = [];
  /** Each request, with the account it was made as. */
  requests: { path: string; account: string; params: URLSearchParams }[] = [];
  /** Accounts every request from which fails with this status. */
  failing = new Map<string, number>();
  /** Accounts whose requests reach a project that has not enabled the Cloud Identity API. */
  disabled = new Set<string>();
  /** The Google account each test account's token stands for, when not its own. */
  subs = new Map<string, string>();
  searchPageSize = Infinity;
  #accounts = new Map<string, string>();

  constructor(accounts: string[]) {
    for (let name of accounts) this.#accounts.set(tokenFor(name), name);
  }

  install(): this {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      let url = new URL(input instanceof Request ? input.url : String(input));
      let token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
      let account = this.#accounts.get(token) ?? "unknown";
      this.requests.push({ path: url.pathname, account, params: url.searchParams });
      return this.#answer(url, account);
    }));
    return this;
  }

  paths(account = "test-user"): string[] {
    return this.requests.filter(request => request.account === account).map(request => request.path);
  }

  #answer(url: URL, account: string): Response {
    let failure = this.failing.get(account);
    if (failure !== undefined) return json(null, failure);
    if (url.hostname === "www.googleapis.com" && url.pathname === "/oauth2/v3/userinfo") {
      return json({
        sub: this.subs.get(account) ?? `sub-${account}`,
        email: account === "test-user" ? "me@example.com" : `${account}@example.com`,
      });
    }
    if (this.disabled.has(account)) {
      return Response.json({
        error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] },
      }, { status: 403 });
    }
    let path = url.pathname;
    let params = url.searchParams;
    if (path === "/v1/groups:lookup") {
      let group = this.groups.find(candidate => candidate.email === params.get("groupKey.id"));
      let refusal = group && this.#refusal(group, account);
      if (!group) return json(null, 404);
      return refusal ? json(null, refusal) : json({ name: `groups/${group.id}` });
    }
    if (path === "/v1/groups:search") return this.#search(params, account);
    if (path === "/v1/groups/-/memberships:searchDirectGroups") {
      let email = /member_key_id == '([^']+)'/.exec(params.get("query") ?? "")?.[1];
      return json({
        memberships: this.groups
          .filter(group => !this.#refusal(group, account) && !group.membersHiddenFrom?.includes(account) &&
            group.members.some(m => m.email === email))
          .map(group => ({
            group: `groups/${group.id}`, groupKey: { id: group.email }, displayName: group.displayName,
            labels: { [FORUM]: "" },
            roles: group.members.find(m => m.email === email)!.roles.map(name => ({ name })),
          })),
      });
    }
    let match = /^\/v1\/groups\/([^/:]+)(\/memberships(?::lookup|\/m(\d+))?)?$/.exec(path);
    let group = match && this.groups.find(candidate => candidate.id === match[1]);
    if (!match || !group) return json(null, 404);
    let refusal = this.#refusal(group, account);
    if (refusal) return json(null, refusal);
    if (match[2] === undefined) {
      return json({
        name: `groups/${group.id}`, groupKey: { id: group.email }, displayName: group.displayName,
        parent: group.parent, labels: { [FORUM]: "" },
      });
    }
    let membersStatus = group.membersFailing?.[account];
    if (membersStatus !== undefined) return json(null, membersStatus);
    if (group.membersHiddenFrom?.includes(account)) return json(null, 403);
    if (match[2] === "/memberships:lookup") {
      let index = group.members.findIndex(m => m.email === params.get("memberKey.id"));
      return index < 0 ? json(null, 404) : json({ name: `groups/${group.id}/memberships/m${index}` });
    }
    if (match[3] !== undefined) return json(membership(group.members[Number(match[3])]));
    let start = Number(params.get("pageToken") ?? 0);
    let end = start + Number(params.get("pageSize"));
    return json({
      memberships: group.members.slice(start, end).map(membership),
      ...(end < group.members.length ? { nextPageToken: String(end) } : {}),
    });
  }

  #search(params: URLSearchParams, account: string): Response {
    let query = params.get("query") ?? "";
    let parent = /parent == '([^']+)'/.exec(query)?.[1];
    let [, field, text] = /(display_name|group_key)\.contains\('((?:[^'\\]|\\.)*)'\)/.exec(query) ?? [];
    let found = this.groups.filter(group => group.parent === parent && !this.#refusal(group, account) &&
      (field === "display_name" ? group.displayName ?? "" : group.email).includes(text));
    // Page tokens with a colon in them, so a cursor that splits its own tokens carelessly breaks.
    let start = Number(params.get("pageToken")?.slice("page:".length) ?? 0);
    let end = start + this.searchPageSize;
    return json({
      groups: found.slice(start, end).map(group => ({
        name: `groups/${group.id}`, groupKey: { id: group.email }, displayName: group.displayName,
      })),
      ...(end < found.length ? { nextPageToken: `page:${end}` } : {}),
    });
  }

  #refusal(group: FakeGroup, account: string): number | undefined {
    if (group.hiddenFrom?.includes(account)) return 403;
    if (group.notFoundFor?.includes(account)) return 404;
    return undefined;
  }
}

function membership(entry: FakeMember) {
  return { preferredMemberKey: { id: entry.email }, type: entry.type, roles: entry.roles.map(name => ({ name })) };
}

/** Drains a cursor, returning everything it yielded. */
async function drain<T>(cursor: { next(): Promise<T[] | null> }): Promise<T[]> {
  let all: T[] = [];
  for (let page = await cursor.next(); page !== null; page = await cursor.next()) all.push(...page);
  return all;
}

let google: FakeGoogle;
let queue: FakeQueue;

function context(overrides: Partial<GroupsContext> = {}): GroupsContext {
  return {
    api: new GoogleGroupsApi(async () => tokenFor("test-user")),
    queue: new SharedApprovalQueue(queue as unknown as RpcStub<ApprovalQueue>),
    selfEmail: async () => "me@example.com",
    customer: async () => "customers/C01",
    ...overrides,
  };
}

const dispose = (value: unknown) => (value as Disposable)[Symbol.dispose]();

const TEAM: FakeGroup = {
  id: "g1", email: "team@example.com", displayName: "Team", parent: "customers/C01",
  members: [member("me@example.com", "OWNER"), member("ada@example.com", "MANAGER"), member("bob@example.com")],
};

beforeEach(() => {
  google = new FakeGoogle(["test-user", "viewer", "outsider", "stranger", "broken"]).install();
  google.groups = [structuredClone(TEAM)];
  queue = new FakeQueue();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a Google Group capability", () => {
  const team = () => new GoogleGroupImpl(context(), { id: "groups/g1", email: "team@example.com" });

  it("reads the group's metadata, observing what it read", async () => {
    let info = await team().getInfo();
    expect(info).toMatchObject({ id: "groups/g1", email: "team@example.com", name: "Team" });
    expect(queue.observations).toEqual([{
      title: "Read a Google Group",
      description: 'Read the name, email addresses, description and type of "Team" (`team@example.com`).',
    }]);
  });

  it("lists direct members a page at a time, observing each page before disclosing it", async () => {
    google.groups[0].members = Array.from({ length: 201 }, (_, i) => member(`user${i}@example.com`));
    let cursor = await team().listMembers();
    let first = await cursor.next();
    expect(first).toHaveLength(200);
    expect(first![0]).toEqual({ email: "user0@example.com", kind: "user", role: "member" });
    expect(await cursor.next()).toEqual([{ email: "user200@example.com", kind: "user", role: "member" }]);
    expect(await cursor.next()).toBeNull();
    expect(queue.observations.map(o => o.description)).toEqual([
      "Read the email addresses and roles of 200 direct member(s) of `team@example.com` (`groups/g1`).",
      "Read the email addresses and roles of 1 direct member(s) of `team@example.com` (`groups/g1`).",
    ]);
  });

  it("refuses to list members the account cannot see, observing nothing", async () => {
    google.groups[0].membersHiddenFrom = ["test-user"];
    let cursor = await team().listMembers();
    await expect(cursor.next())
      .rejects.toThrow("This account cannot see the members of the Google Group team@example.com.");
    expect(queue.observations).toEqual([]);
  });

  it("finds a direct member, and observes that someone else is not one", async () => {
    let group = team();
    expect(await group.findMember("Ada@Example.com"))
      .toEqual({ email: "ada@example.com", kind: "user", role: "manager" });
    expect(await group.findMember("zed@example.com")).toBeNull();
    expect(queue.observations.map(o => o.description)).toEqual([
      "Found that `ada@example.com` is a direct manager of `team@example.com` (`groups/g1`).",
      "Found that `zed@example.com` is not a direct member of `team@example.com` (`groups/g1`).",
    ]);
  });

  // The lookup answers "not found" for a group that has gone as for someone not in it.
  it("does not report someone as no member of a group that has gone", async () => {
    let group = team();
    google.groups = [];
    await expect(group.findMember("zed@example.com"))
      .rejects.toThrow("This account cannot see the members of the Google Group team@example.com.");
    expect(queue.observations).toEqual([]);
  });

  it("refuses an address that is not one, before asking Google", async () => {
    await expect(team().findMember("not an address")).rejects.toThrow("Expected an email address");
    expect(google.requests).toEqual([]);
  });

  it.each([
    ["metadata", "Read a Google Group", (group: GoogleGroupImpl) => group.getInfo()],
    ["a member lookup", "Look up a Google Group member", (group: GoogleGroupImpl) => group.findMember("ada@example.com")],
  ] as const)("withholds %s when its observation is refused", async (_name, title, read) => {
    queue.refusing.add(title);
    await expect(read(team())).rejects.toThrow("Refused by the test.");
  });

  it("says when the deployment has not enabled the Cloud Identity API", async () => {
    google.disabled.add("test-user");
    await expect(team().getInfo()).rejects.toThrow(
      "The Cloud Identity API, which Google Groups needs, is not enabled in this deployment's " +
      "Google Cloud project.");
  });
});

describe("a Google Groups account session", () => {
  it("opens the same group by address, ID, or a link into it", async () => {
    let session = new GoogleGroupsSessionImpl(context());
    for (let reference of [
      "Team@Example.com", "groups/g1", "https://groups.google.com/a/example.com/g/team/c/abc123",
    ]) {
      let entry: GoogleGroupEntry = await session.getGroup(reference);
      expect(entry.info.id).toBe("groups/g1");
      let members = await drain<GoogleGroupMember>(await entry.group.listMembers());
      expect(members.map(m => m.email)).toEqual(["me@example.com", "ada@example.com", "bob@example.com"]);
    }
    expect(queue.observations.filter(o => o.title === "Open a Google Group")).toHaveLength(3);
  });

  it("withholds a group it opened when the observation is refused", async () => {
    queue.refusing.add("Open a Google Group");
    await expect(new GoogleGroupsSessionImpl(context()).getGroup("team@example.com"))
      .rejects.toThrow("Refused by the test.");
  });

  it("explains a group it cannot open, observing nothing", async () => {
    google.groups.push({ id: "g2", email: "secret@example.com", members: [], hiddenFrom: ["test-user"] });
    let session = new GoogleGroupsSessionImpl(context());
    await expect(session.getGroup("secret@example.com"))
      .rejects.toThrow("No Google Group secret@example.com exists that this account can see.");
    await expect(session.getGroup("nobody@example.com"))
      .rejects.toThrow("No Google Group nobody@example.com exists that this account can see.");
    expect(queue.observations).toEqual([]);
  });

  it("refuses a reference that names no group", async () => {
    await expect(new GoogleGroupsSessionImpl(context()).getGroup("https://groups.google.com/g/team"))
      .rejects.toThrow("or a link into it of the form https://groups.google.com/a/<domain>/g/<name>.");
  });

  it("lists the connected account's own groups by default, as capabilities that read them", async () => {
    let entries = await drain<GoogleGroupMembershipEntry>(
      await new GoogleGroupsSessionImpl(context()).listGroupsOf());
    expect(entries.map(entry => [entry.info.email, entry.role])).toEqual([["team@example.com", "owner"]]);
    expect(google.requests.at(-1)!.params.get("query")).toContain("member_key_id == 'me@example.com'");
    expect(await entries[0].group.findMember("bob@example.com")).toMatchObject({ role: "member" });
    expect(queue.observations[0]).toEqual({
      title: "List the Google Groups someone belongs to",
      description: "Read 1 group(s) that `me@example.com` directly belongs to, with their role in each.",
    });
  });

  // Google leaves out groups whose members the caller cannot see, and the session adds none back.
  it("lists someone else's groups only where the account can see the members", async () => {
    google.groups.push({
      id: "g2", email: "private@example.com", members: [member("ada@example.com")],
      membersHiddenFrom: ["test-user"],
    });
    let entries = await drain<GoogleGroupMembershipEntry>(
      await new GoogleGroupsSessionImpl(context()).listGroupsOf("ada@example.com"));
    expect(entries.map(entry => [entry.info.email, entry.role])).toEqual([["team@example.com", "manager"]]);
  });

  it("searches names first, then addresses, returning each group once", async () => {
    google.groups = [
      { id: "g1", email: "eng-team@example.com", displayName: "Eng team", parent: "customers/C01", members: [] },
      { id: "g2", email: "all@example.com", displayName: "Engineering", parent: "customers/C01", members: [] },
      { id: "g3", email: "eng-platform@example.com", displayName: "Platform", parent: "customers/C01", members: [] },
      { id: "g4", email: "eng@other.com", displayName: "Eng elsewhere", parent: "customers/C99", members: [] },
    ];
    let entries = await drain<GoogleGroupEntry>(
      await new GoogleGroupsSessionImpl(context()).searchGroups(" Eng "));
    expect(entries.map(entry => entry.info.email))
      .toEqual(["eng-team@example.com", "all@example.com", "eng-platform@example.com"]);
    expect(queue.observations.map(o => o.title)).toEqual(["Search Google Groups", "Search Google Groups"]);
    expect(google.requests.map(request => request.params.get("query"))).toEqual([
      `parent == 'customers/C01' && '${FORUM}' in labels && display_name.contains('Eng')`,
      `parent == 'customers/C01' && '${FORUM}' in labels && group_key.contains('eng')`,
    ]);
  });

  // The cursor's own page token wraps Google's, which must reach Google exactly as Google gave it.
  it("pages each search with Google's own page tokens", async () => {
    google.searchPageSize = 2;
    google.groups = [
      { id: "g1", email: "one@example.com", displayName: "Eng one", parent: "customers/C01", members: [] },
      { id: "g2", email: "two@example.com", displayName: "Eng two", parent: "customers/C01", members: [] },
      { id: "g3", email: "three@example.com", displayName: "Eng three", parent: "customers/C01", members: [] },
      { id: "g4", email: "eng-platform@example.com", displayName: "Platform", parent: "customers/C01", members: [] },
    ];
    let entries = await drain<GoogleGroupEntry>(
      await new GoogleGroupsSessionImpl(context()).searchGroups("Eng"));
    expect(entries.map(entry => entry.info.email))
      .toEqual(["one@example.com", "two@example.com", "three@example.com", "eng-platform@example.com"]);
    expect(google.requests.map(request => [
      /(display_name|group_key)/.exec(request.params.get("query")!)![1], request.params.get("pageToken"),
    ])).toEqual([["display_name", null], ["display_name", "page:2"], ["group_key", null]]);
  });

  // A refused page is offered again: the groups on it were never disclosed, so they must not be
  // skipped as already returned.
  it("offers a refused search page again, groups and all", async () => {
    let cursor = await new GoogleGroupsSessionImpl(context()).searchGroups("Team");
    queue.refusing.add("Search Google Groups");
    await expect(cursor.next()).rejects.toThrow("Refused by the test.");
    expect((await cursor.next())!.map(entry => entry.info.email)).toEqual(["team@example.com"]);
  });

  it("refuses a search before reaching Google when the organization is unknown", async () => {
    let session = new GoogleGroupsSessionImpl(context({
      customer: async () => { throw new Error("no organization"); },
    }));
    await expect(session.searchGroups("eng")).rejects.toThrow("no organization");
    expect(google.requests).toEqual([]);
  });

  // Capabilities outlive the session that made them, so the queue goes only with the last of them,
  // and those on a refused page are let go at once.
  it("lets the approval queue go only once every capability holding it has gone", async () => {
    let session = new GoogleGroupsSessionImpl(context());
    let refused = await session.listGroupsOf();
    queue.refusing.add("List the Google Groups someone belongs to");
    await expect(refused.next()).rejects.toThrow("Refused by the test.");
    dispose(refused);
    let listed = await session.listGroupsOf();
    let [entry] = (await listed.next())!;
    dispose(listed);
    dispose(session);
    expect(queue.disposed).toBe(false);
    dispose(entry.group);
    expect(queue.disposed).toBe(true);
  });
});

describe("the Google Groups gatekeeper", () => {
  let facetCount = 0;
  const hooks = () => env.TEST_HOOKS.getByName("hooks");
  const facet = () => `groups-${++facetCount}`;

  it("describes a whole-account binding and a single-group binding", async () => {
    expect(await hooks().groupsDescribe(facet())).toEqual({
      url: "https://groups.google.com/",
      title: "Google Groups",
      snippet: "Find groups and read their members as the connected account. Read-only.",
      suggestedBindingName: "GOOGLE_GROUPS",
      tsType: "GoogleGroupsSession",
    });
    expect(await hooks().groupsDescribe(facet(), "team@example.com")).toEqual({
      url: "https://groups.google.com/a/example.com/g/team",
      title: "Team",
      snippet: "Google Group team@example.com",
      suggestedBindingName: "GOOGLE_GROUP",
      tsType: "GoogleGroup",
    });
  });

  // A group's address can be changed, and the old one given to a new group; the binding must not
  // follow the address to a group nobody chose, and its log must say which group it read.
  it("keeps a single-group binding on the group it first resolved", async () => {
    let name = facet();
    await hooks().groupsDescribe(name, "team@example.com");
    google.groups = [
      { ...structuredClone(TEAM), email: "team-old@example.com" },
      { id: "g2", email: "team@example.com", displayName: "New team", members: [member("eve@example.com")] },
    ];
    let { info, members, observations } = await hooks().groupsRead(name, "team@example.com");
    expect(info).toMatchObject({ id: "groups/g1", email: "team-old@example.com", name: "Team" });
    expect(members).toEqual(["me@example.com", "ada@example.com", "bob@example.com"]);
    expect(observations[1]).toContain("(`groups/g1`)");
  });

  // A single-group session is a `GoogleGroup`: none of the account-wide methods exist on it.
  it("confines a single-group binding to its group", async () => {
    google.groups.push({ id: "g2", email: "other@example.com", parent: "customers/C01", members: [] });
    let outcomes = await hooks().groupsAccountMethodsOnGroup(facet(), "team@example.com");
    expect(outcomes).toEqual(["searchGroups", "listGroupsOf", "getGroup"].map(method =>
      `${method}: The RPC receiver does not implement the method "${method}".`));
    expect(google.paths()).toEqual(["/v1/groups:lookup"]);
  });

  it("explains a single-group binding to a group the account cannot see", async () => {
    google.groups[0].hiddenFrom = ["test-user"];
    expect(await hooks().groupsRead(facet(), "team@example.com")).toEqual({
      error: expect.stringContaining("No Google Group team@example.com exists that this account can see."),
      observations: [],
    });
  });

  describe("collaborators", () => {
    it("refuses every collaborator on a whole-account binding, without asking Google", async () => {
      let error = await hooks().groupsAddObserver(facet(), undefined, "viewer");
      expect(error).toContain("cannot be shared with collaborators");
      expect(google.paths("viewer")).toEqual([]);
    });

    it("admits a collaborator whose own account can see the group and its members", async () => {
      expect(await hooks().groupsAddObserver(facet(), "team@example.com", "viewer")).toBeNull();
      expect(google.paths("viewer")).toEqual(["/v1/groups/g1", "/v1/groups/g1/memberships"]);
    });

    it.each([
      ["can see the group but not its members", { membersHiddenFrom: ["outsider"] }, "outsider"],
      ["cannot see the group at all", { hiddenFrom: ["stranger"] }, "stranger"],
      ["is told the group does not exist", { notFoundFor: ["stranger"] }, "stranger"],
    ])("refuses a collaborator who %s", async (_name, visibility, observer) => {
      Object.assign(google.groups[0], visibility);
      expect(await hooks().groupsAddObserver(facet(), "team@example.com", observer))
        .toContain("This collaborator cannot see the bound Google Group and its members");
    });

    // An outage must fail the open loudly, not quietly deny a collaborator who may have access.
    it.each([
      ["a malformed request", () => google.failing.set("broken", 400), "[http=400]"],
      ["an outage", () => google.failing.set("broken", 503), "[http=503]"],
      ["an outage reading the members", () => { google.groups[0].membersFailing = { broken: 503 }; }, "[http=503]"],
      ["a disabled API", () => google.disabled.add("broken"), "[http=403]"],
    ])("fails the check, rather than denying, on %s", async (_name, arrange, status) => {
      let name = facet();
      // The owner resolves the binding before anything fails.
      await hooks().groupsDescribe(name, "team@example.com");
      arrange();
      let error = await hooks().groupsAddObserver(name, "team@example.com", "broken");
      expect(error).toContain(status);
      expect(error).not.toContain("cannot see");
    });
  });

  describe("search", () => {
    it("finds the account's organization once, then searches it", async () => {
      let name = facet();
      for (let attempt = 0; attempt < 2; attempt++) {
        let result = await hooks().groupsSearch(name, "Team");
        // The address search finds only the group the name search returned, so its page, the last,
        // discloses nothing but the end of the results.
        expect(result).toEqual({
          emails: ["team@example.com"],
          observations: [expect.stringContaining(" 1 group(s)"), expect.stringContaining(" 0 group(s)")],
        });
      }
      expect(google.paths().filter(path => path === "/v1/groups/-/memberships:searchDirectGroups"))
        .toHaveLength(1);
    });

    it("finds the organization again after a reconnect as another Google account", async () => {
      let name = facet();
      await hooks().groupsSearch(name, "Team");
      google.subs.set("test-user", "sub-someone-else");
      await hooks().groupsSearch(name, "Team");
      expect(google.paths().filter(path => path === "/v1/groups/-/memberships:searchDirectGroups"))
        .toHaveLength(2);
    });

    it("explains why it cannot search for an account in no group of its own organization", async () => {
      google.groups[0].members = [];
      let result = await hooks().groupsSearch(facet(), "Team");
      expect(result.error).toContain("Could not tell which organization the connected account belongs to");
      expect(google.paths()).not.toContain("/v1/groups:search");
    });
  });
});
