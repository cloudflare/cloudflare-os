// PagerDuty, faked at the `fetch` boundary for the workerd suites. Installed with `vi.stubGlobal`,
// which reaches the gatekeeper because the whole suite -- test file, TestHooks, and the Durable
// Objects -- runs in one isolate. It plays the identity service (token endpoint, ID-token signing
// keys) and both regions' REST hosts: a token names a user, and only that user's region answers it.
// The fake keeps state, so a change an approved action makes is visible to the reads that follow,
// and a user can be refused an object (`hide`). A test injects an answer with `on()`, whose routes
// answer before the built-in ones, latest first. Anything unrouted, or sent elsewhere, fails.

import { env, runInDurableObject } from "cloudflare:test";
import { SignJWT, base64url, type JWK } from "jose";
import { vi } from "vitest";
import { identityOf } from "../../src/pagerduty-credentials";
import { ID_TOKEN_ISSUER, SCOPES, apiOrigin, type Region } from "../../src/pagerduty-env";
import type {
  WireAlert, WireAssignment, WireIncident, WireLogEntry, WireNote, WireOnCall, WireOverride, WirePriority, WireRef, WireSchedule,
  WireService, WireShift, WireShiftOverride, WireTeam, WireUser,
} from "../../src/pagerduty-normalize";
import SIGNING_JWK from "./id-token-key.json";
import type { GatekeeperProps, Outcome, Step } from "./worker";

export const IDENTITY = "https://identity.pagerduty.com";

// A fixed RS256 signing key, as PagerDuty signs with, so the gatekeeper's cached key set stays valid
// across every suite.
const SIGNING_KEY: JWK = SIGNING_JWK;

export type Account = { id: string; region: Region; subdomain: string };
export type FakeUser = WireUser & { account: Account };

export const ACME: Account = { id: "PACME01", region: "us", subdomain: "acme" };
export const EURO: Account = { id: "PEURO01", region: "eu", subdomain: "euro" };

const user = (id: string, name: string, account: Account, role = "user"): FakeUser => ({
  id, type: "user", name, email: `${name.toLowerCase()}@${account.subdomain}.test`, role, time_zone: "Etc/UTC",
  html_url: `https://${account.subdomain}.pagerduty.com/users/${id}`, account,
});

export const ALICE = user("PALICE1", "Alice", ACME);
export const BOB = user("PBOB001", "Bob", ACME);
/** A Limited Stakeholder, who sees no incidents or services. */
export const CAROL = user("PCAROL1", "Carol", ACME, "read_only_limited_user");
export const DAVE = user("PDAVE01", "Dave", EURO);

const ref = (type: string, id: string, name: string): WireRef => ({ id, type: `${type}_reference`, summary: name });

export const TEAM = ref("team", "PTEAM01", "Platform");
export const OTHER_TEAM = ref("team", "PTEAM02", "Payments");
export const POLICY = ref("escalation_policy", "PEP0001", "Platform on call");
export const OTHER_POLICY = ref("escalation_policy", "PEP0002", "Payments on call");
export const SERVICE = ref("service", "PSVC001", "API");
export const OTHER_SERVICE = ref("service", "PSVC002", "Billing");
export const SCHEDULE = ref("schedule", "PSCH001", "Platform primary");
export const OTHER_SCHEDULE = ref("schedule", "PSCH002", "Payments primary");
/** A shift-based schedule, which only PagerDuty's v3 API serves. */
export const SHIFT_SCHEDULE = ref("schedule", "PSCH003", "Follow the sun");
export const PRIORITY: WirePriority = { id: "PPRI001", name: "P1" };

export type FakeRequest = { method: string; url: URL; headers: Headers; body?: string; userId?: string };
type Handler = (request: FakeRequest) => Response | undefined | Promise<Response | undefined>;

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), { status: 200, ...init, headers: { "content-type": "application/json" } });
}

const error = (status: number, message: string) => json({ error: { code: status * 10, message } }, { status });

/** A listing page of `rows`, as PagerDuty's classic offset pagination answers. */
function page(url: URL, key: string, rows: unknown[]): Response {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 25);
  return json({ [key]: rows.slice(offset, offset + limit), offset, limit, more: offset + limit < rows.length });
}

/** Whether `row` belongs to one of the teams `url` filters by. */
const inTeams = (url: URL, row: { teams?: WireRef[] }): boolean => {
  const teams = url.searchParams.getAll("team_ids[]");
  return teams.length === 0 || (row.teams ?? []).some(({ id }) => teams.includes(id));
};

export class FakePagerDuty {
  readonly requests: FakeRequest[] = [];
  readonly users = new Map<string, FakeUser>([ALICE, BOB, CAROL, DAVE].map(u => [u.id, { ...u }]));
  readonly teams = new Map<string, WireTeam>([TEAM, OTHER_TEAM].map(t => [t.id, { ...t, type: "team", name: t.summary }]));
  readonly services = new Map<string, WireService>([
    [SERVICE.id, { ...SERVICE, type: "service", name: "API", status: "active", teams: [TEAM], escalation_policy: POLICY }],
    [OTHER_SERVICE.id, { ...OTHER_SERVICE, type: "service", name: "Billing", status: "active", teams: [OTHER_TEAM], escalation_policy: OTHER_POLICY }],
  ]);
  readonly policies: (WireRef & { teams: WireRef[] })[] = [{ ...POLICY, teams: [TEAM] }, { ...OTHER_POLICY, teams: [OTHER_TEAM] }];
  readonly schedules = new Map<string, WireSchedule>([
    [SCHEDULE.id, { ...SCHEDULE, type: "schedule", name: "Platform primary", time_zone: "Etc/UTC", teams: [TEAM], escalation_policies: [POLICY] }],
    [OTHER_SCHEDULE.id, { ...OTHER_SCHEDULE, type: "schedule", name: "Payments primary", time_zone: "Etc/UTC", teams: [OTHER_TEAM], escalation_policies: [OTHER_POLICY] }],
  ]);
  /** Shift-based schedules, as `GET /v3/schedules/{id}` describes them. */
  readonly shiftSchedules = new Map<string, WireSchedule>([
    [SHIFT_SCHEDULE.id, { ...SHIFT_SCHEDULE, type: "schedule_v3", name: "Follow the sun", time_zone: "Etc/UTC", teams: [TEAM], escalation_policies: [POLICY] }],
  ]);
  /** Each shift-based schedule's final schedule. */
  readonly assignments = new Map<string, WireAssignment[]>();
  readonly shiftOverrides = new Map<string, WireShiftOverride[]>();
  readonly incidents = new Map<string, WireIncident>();
  readonly notes = new Map<string, WireNote[]>();
  /** Each incident's log, oldest first, as PagerDuty lists it. */
  readonly logEntries = new Map<string, WireLogEntry[]>();
  readonly alerts = new Map<string, WireAlert[]>();
  readonly shifts = new Map<string, WireShift[]>();
  readonly overrides = new Map<string, WireOverride[]>();
  readonly priorities: WirePriority[] = [PRIORITY, { id: "PPRI002", name: "P2" }];
  oncalls: WireOnCall[] = [];
  /** The scopes the token endpoint grants. */
  grantedScopes = SCOPES.join(" ");
  /**
   * Adjusts the ID token's claims, `iss`, `aud` and `exp` among them, for tests of what the
   * gatekeeper reads from them.
   */
  claims: (user: FakeUser, claims: Record<string, unknown>) => Record<string, unknown> = (_user, claims) => claims;
  /** The key the ID token is signed with; a test may swap in one PagerDuty never published. */
  idTokenKey: JWK | CryptoKey = SIGNING_KEY;
  /** Which user each access or refresh token belongs to. */
  readonly tokens = new Map<string, string>();
  /** Which user each authorization code authorizes, and the PKCE challenge its authorize request carried. */
  readonly codes = new Map<string, { userId: string; codeChallenge: string }>();
  /** `user:object` pairs PagerDuty refuses to open, and with which status. */
  readonly #hidden = new Map<string, number>();
  #routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
  #next = 1;

  install(): this {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => this.#handle(input, init));
    return this;
  }

  /** Answers before the built-in routes; return `undefined` to fall through to them. */
  on(method: string, pattern: RegExp, handler: Handler): this {
    this.#routes.unshift({ method, pattern, handler });
    return this;
  }

  /** Makes PagerDuty refuse `userId` the object `id`, with 403 or 404. */
  hide(userId: string, id: string, status: 403 | 404 = 403): this {
    this.#hidden.set(`${userId}:${id}`, status);
    return this;
  }

  /** The recorded requests matching, optionally only those made with `userId`'s token. */
  matching(method: string, pattern: RegExp, userId?: string): FakeRequest[] {
    return this.requests.filter(r => r.method === method && pattern.test(r.url.pathname + r.url.search)
      && (userId === undefined || r.userId === userId));
  }

  /** The requests that would change something at PagerDuty. */
  writes(): FakeRequest[] {
    return this.requests.filter(r => r.method !== "GET" && r.url.origin !== IDENTITY);
  }

  /** Adds an incident on `service`, open and assigned to Alice unless `extra` says otherwise. */
  incident(service: WireRef, extra: Partial<WireIncident> = {}): WireIncident {
    const n = this.#next++;
    const wire: WireIncident = {
      id: `PINC${String(n).padStart(3, "0")}`, type: "incident", incident_number: n, title: `Incident ${n}`,
      status: "triggered", urgency: "high", priority: null, service,
      teams: [this.services.get(service.id)!.teams![0]], escalation_policy: this.services.get(service.id)!.escalation_policy,
      assignments: [{ assignee: ref("user", ALICE.id, ALICE.name!) }], acknowledgements: [],
      created_at: new Date(Date.now() - n * 60_000).toISOString(), html_url: `https://acme.pagerduty.com/incidents/${n}`,
      alert_counts: { all: 0 }, ...extra,
    };
    this.incidents.set(wire.id, wire);
    return wire;
  }

  /** Mints a token for `userId`, as a code exchange or refresh would. */
  grant(userId: string) {
    const n = this.#next++;
    this.tokens.set(`access-${n}`, userId);
    this.tokens.set(`refresh-${n}`, userId);
    return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 86_400, token_type: "bearer", scope: this.grantedScopes };
  }

  async #handle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const recorded: FakeRequest = { method: request.method, url, headers: new Headers(request.headers) };
    if (request.body) recorded.body = await request.text();
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (token !== undefined) recorded.userId = this.tokens.get(token);
    this.requests.push(recorded);
    if (url.origin === IDENTITY) return await this.#identity(recorded);
    if (url.origin !== apiOrigin("us") && url.origin !== apiOrigin("eu")) {
      throw new Error(`fake PagerDuty: ${request.method} ${url} was not sent to PagerDuty`);
    }
    if (request.redirect !== "manual") throw new Error(`fake PagerDuty: ${request.method} ${url} would follow redirects`);
    for (const route of this.#routes) {
      if (route.method === request.method && route.pattern.test(url.pathname + url.search)) {
        const answer = await route.handler(recorded);
        if (answer) return answer;
      }
    }
    return this.#rest(recorded);
  }

  async #identity(request: FakeRequest): Promise<Response> {
    const { method, url } = request;
    if (method === "GET" && url.pathname === "/global/oauth/anonymous/jwks") {
      const { kty, kid, n, e } = SIGNING_KEY;
      return json({ keys: [{ kty, kid, n, e, alg: "RS256", use: "sig" }] });
    }
    if (method !== "POST" || url.pathname !== "/oauth/token") throw new Error(`fake PagerDuty: ${method} ${url} is not routed`);
    const form = new URLSearchParams(request.body);
    if (form.get("client_id") !== "test-client-id" || form.get("client_secret") !== "test-client-secret") {
      return json({ error: "invalid_client" }, { status: 401 });
    }
    let grantee: string | undefined;
    if (form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      // PKCE (S256): the verifier must hash to the challenge the authorize request committed to.
      const verifier = new TextEncoder().encode(form.get("code_verifier") ?? "");
      const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", verifier)));
      if (code?.codeChallenge === challenge) grantee = code.userId;
    } else {
      grantee = this.tokens.get(form.get("refresh_token") ?? "");
    }
    if (grantee === undefined) return json({ error: "invalid_grant" }, { status: 400 });
    const who = this.users.get(grantee)!;
    const now = Math.floor(Date.now() / 1000);
    const claims = this.claims(who, {
      user_id: who.id, account_id: who.account.id, subdomain: who.account.subdomain,
      region: who.account.region === "eu" ? "EU" : "UnitedStates",
      iss: ID_TOKEN_ISSUER, aud: [apiOrigin(who.account.region), "test-client-id"], iat: now, exp: now + 3600,
    });
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: SIGNING_KEY.kid })
      .sign(this.idTokenKey);
    return json({ ...this.grant(grantee), id_token: idToken });
  }

  #rest(request: FakeRequest): Response {
    const { method, url } = request;
    const me = request.userId === undefined ? undefined : this.users.get(request.userId);
    // A token works only on its account's regional host.
    if (!me || url.origin !== apiOrigin(me.account.region)) return error(401, "Authentication failed");
    if (request.headers.get("accept") !== "application/vnd.pagerduty+json;version=2") return error(406, "Unversioned");
    if (method !== "GET" && request.headers.get("from") !== me.email) return error(400, "From header must name a user");
    const path = url.pathname;
    const body = () => JSON.parse(request.body ?? "{}");
    const segments = path.split("/").slice(1);
    // A v3 path names its object one segment further in.
    const object = segments[0] === "v3" ? segments.slice(1) : segments;
    const id = object[1];
    const hidden = id ? this.#hidden.get(`${me.id}:${id}`) : undefined;
    if (method === "GET" && object.length === 2 && hidden) return error(hidden, "Not allowed");
    const query = url.searchParams.get("query")?.toLowerCase();
    const named = (row: WireRef) => !query || (row.name ?? row.summary ?? "").toLowerCase().includes(query);
    let match: RegExpMatchArray | null;

    if (method === "GET" && path === "/users/me") {
      const { account: _account, ...wire } = me;
      return json({ user: wire });
    }
    if (method === "GET" && (match = path.match(/^\/users\/(\w+)$/))) {
      const found = this.users.get(match[1]);
      return found ? json({ user: found }) : error(404, "Not found");
    }
    if (method === "GET" && path === "/users") {
      return page(url, "users", [...this.users.values()].filter(u => u.account === me.account
        && (!query || u.email.includes(query) || u.name!.toLowerCase().includes(query))));
    }
    if (method === "GET" && path === "/priorities") return page(url, "priorities", this.priorities);
    if (method === "GET" && path === "/teams") return page(url, "teams", [...this.teams.values()].filter(named));
    if (method === "GET" && (match = path.match(/^\/teams\/(\w+)$/))) {
      const team = this.teams.get(match[1]);
      return team ? json({ team }) : error(404, "Not found");
    }
    if (method === "GET" && (match = path.match(/^\/teams\/(\w+)\/members$/))) {
      return page(url, "members", match[1] === TEAM.id ? [{ user: this.users.get(ALICE.id), role: "manager" }] : []);
    }
    if (method === "GET" && path === "/services") {
      return page(url, "services", [...this.services.values()].filter(s => named(s) && inTeams(url, s)));
    }
    if (method === "GET" && (match = path.match(/^\/services\/(\w+)$/))) {
      const service = this.services.get(match[1]);
      return service ? json({ service }) : error(404, "Not found");
    }
    if (method === "GET" && path === "/escalation_policies") {
      return page(url, "escalation_policies", this.policies.filter(p => inTeams(url, p)));
    }
    if (method === "GET" && (match = path.match(/^\/escalation_policies\/(\w+)$/))) {
      const policy = this.policies.find(p => p.id === match![1]);
      return policy ? json({ escalation_policy: policy }) : error(404, "Not found");
    }
    if (method === "GET" && path === "/oncalls") {
      const policies = url.searchParams.getAll("escalation_policy_ids[]");
      const schedules = url.searchParams.getAll("schedule_ids[]");
      const users = url.searchParams.getAll("user_ids[]");
      return page(url, "oncalls", this.oncalls.filter(o => (!policies.length || policies.includes(o.escalation_policy.id))
        && (!schedules.length || (o.schedule && schedules.includes(o.schedule.id)))
        && (!users.length || users.includes(o.user.id))));
    }
    if (method === "GET" && path === "/schedules") {
      return page(url, "schedules", [...this.schedules.values()].filter(s => named(s) && inTeams(url, s)));
    }
    if (method === "GET" && (match = path.match(/^\/schedules\/(\w+)$/))) {
      const schedule = this.schedules.get(match[1]);
      if (!schedule) return error(404, "Not found");
      return json({ schedule: { ...schedule, final_schedule: { rendered_schedule_entries: this.shifts.get(schedule.id) ?? [] } } });
    }
    if (method === "GET" && path === "/v3/schedules") {
      return page(url, "schedules", [...this.shiftSchedules.values()].filter(s => named(s) && inTeams(url, s))
        .map(s => ({ id: s.id, type: "schedule_v3_reference", summary: s.name, html_url: s.html_url })));
    }
    if (method === "GET" && (match = path.match(/^\/v3\/schedules\/(\w+)(\/overrides)?$/))) {
      const [, scheduleId, overrides] = match;
      // v3 answers 400 for a layer-based schedule, as PagerDuty documents.
      if (this.schedules.has(scheduleId)) return error(400, "This schedule is not shift-based");
      const schedule = this.shiftSchedules.get(scheduleId);
      if (!schedule) return error(404, "Not found");
      const assignments = this.assignments.get(scheduleId) ?? [];
      const changes = this.shiftOverrides.get(scheduleId) ?? [];
      if (overrides) return json({ overrides: changes });
      const include = url.searchParams.getAll("include[]");
      const userIds = new Set([...assignments.map(a => a.member), ...changes.map(o => o.overriding_member)].flatMap(m => m.user_id ?? []));
      return json({ schedule: {
        ...schedule,
        ...(include.includes("final_schedule") ? { final_schedule: { type: "final_schedule", computed_shift_assignments: assignments } } : {}),
        ...(include.includes("users")
          ? { users: [...userIds].map(userId => ref("user", userId, this.users.get(userId)!.name!)) } : {}),
      } });
    }
    if ((match = path.match(/^\/schedules\/(\w+)\/overrides(?:\/(\w+))?$/))) {
      const [, scheduleId, overrideId] = match;
      const list = this.overrides.get(scheduleId) ?? [];
      // As PagerDuty documents: ids only in the editable view, which leaves out overrides already over.
      if (method === "GET") {
        return json({ overrides: url.searchParams.has("editable")
          ? list.filter(o => Date.parse(o.end) > Date.now()) : list.map(({ id: _, ...o }) => o) });
      }
      if (method === "POST") {
        const results = (body().overrides as WireShift[]).map(o => {
          const made: WireOverride = { id: `POVR${this.#next++}`, start: o.start, end: o.end, user: o.user };
          this.overrides.set(scheduleId, [...this.overrides.get(scheduleId) ?? [], made]);
          return { status: 201, override: made };
        });
        return json(results, { status: 201 });
      }
      if (method === "DELETE") {
        if (!list.some(o => o.id === overrideId)) return error(404, "Not found");
        this.overrides.set(scheduleId, list.filter(o => o.id !== overrideId));
        return new Response(null, { status: 204 });
      }
    }
    if (method === "GET" && path === "/incidents") {
      const statuses = url.searchParams.getAll("statuses[]");
      const services = url.searchParams.getAll("service_ids[]");
      const users = url.searchParams.getAll("user_ids[]");
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");
      return page(url, "incidents", [...this.incidents.values()].filter(i => (!statuses.length || statuses.includes(i.status))
        && (!services.length || services.includes(i.service.id)) && inTeams(url, i)
        && (!users.length || (i.assignments ?? []).some(({ assignee }) => users.includes(assignee.id)))
        && (!since || i.created_at >= since) && (!until || i.created_at < until))
        .toSorted((a, b) => b.created_at.localeCompare(a.created_at)));
    }
    if (method === "POST" && path === "/incidents") {
      const { incident } = body();
      return json({ incident: this.incident(this.services.get(incident.service.id)!, { title: incident.title }) }, { status: 201 });
    }
    if ((match = path.match(/^\/incidents\/(\w+)(?:\/(\w+))?$/))) {
      const [, key, sub] = match;
      const incident = this.incidents.get(key) ?? [...this.incidents.values()].find(i => String(i.incident_number) === key);
      if (!incident) return error(404, "Not found");
      if (method === "GET" && !sub) return json({ incident });
      if (method === "GET" && sub === "alerts") return page(url, "alerts", this.alerts.get(incident.id) ?? []);
      if (method === "GET" && sub === "log_entries") return page(url, "log_entries", this.logEntries.get(incident.id) ?? []);
      if (method === "GET" && sub === "notes") return json({ notes: this.notes.get(incident.id) ?? [] });
      if (method === "PUT" && !sub) {
        const { incident: change } = body();
        if (change.status) incident.status = change.status;
        if (change.title) incident.title = change.title;
        return json({ incident });
      }
      if (method === "POST" && sub === "notes") {
        const note: WireNote = { id: `PNOTE${this.#next++}`, content: body().note.content, created_at: new Date().toISOString(), user: me };
        this.notes.set(incident.id, [...this.notes.get(incident.id) ?? [], note]);
        return json({ note }, { status: 201 });
      }
      if (method === "POST" && (sub === "snooze" || sub === "responder_requests" || sub === "status_updates")) {
        return json({ incident }, { status: 201 });
      }
    }
    throw new Error(`fake PagerDuty: ${method} ${url} is not routed`);
  }
}

/**
 * Seeds a connected account for `who` whose token PagerDuty will accept and that needs no refresh,
 * the way a completed connect leaves one. Returns the account id.
 */
export async function seedAccount(pd: FakePagerDuty, who: FakeUser = ALICE): Promise<string> {
  const grant = pd.grant(who.id);
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("credentials", {
      accessToken: grant.access_token, refreshToken: grant.refresh_token, expiresAt: Date.now() + 3_600_000, scopes: [...SCOPES],
    });
    const { account } = who;
    state.storage.kv.put("identity", identityOf(
      { region: account.region, subdomain: account.subdomain, accountId: account.id, userId: who.id }, who));
  });
  return accountId.toString();
}

export function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

export function hooks() {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

/** A forwarded call's result, rethrown here when it failed. */
export function unwrap<T>(outcome: Outcome<T>): T {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok;
}

/** A forwarded call's failure message, failing the test when it succeeded. */
export function failure(outcome: Outcome<unknown>): string {
  if (!("error" in outcome)) throw new Error(`expected a failure, got ${JSON.stringify(outcome.ok)}`);
  return outcome.error;
}

export type Binding = { resourceKind: "account" } | { resourceKind: "team" | "service" | "incident" | "schedule"; id: string };

/** A binding of Alice's connection to drive, and what its reads report. */
export async function bound(binding: Binding = { resourceKind: "account" }, pd = new FakePagerDuty().install()) {
  const props = { userObjectId: await seedAccount(pd), region: "us", subdomain: "acme", ...binding } as GatekeeperProps;
  const name = crypto.randomUUID();
  return {
    pd, name, props,
    run: async (steps: Step[], pages?: number, between?: Step[][]) =>
      unwrap(await hooks().run(name, props, steps, pages ? { pages, between } : {})),
    attempt: async (steps: Step[], pages?: number, between?: Step[][]) =>
      failure(await hooks().run(name, props, steps, pages ? { pages, between } : {})),
    /** What each observation so far reported, order aside. */
    reported: async () => (await hooks().queueLog(name)).observations.map(o => new Set(o.subresources)),
  };
}

/** The subresource ID of Acme's account, or of one object in it. */
export function sub(kind?: string, id?: string): string {
  return kind ? `region/us/account/${ACME.id}/${kind}/${id}` : `region/us/account/${ACME.id}`;
}
