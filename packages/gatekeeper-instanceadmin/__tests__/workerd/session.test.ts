// The facet, the account, the vendor, and the sessions the facet opens. Every session comes from
// the facet's startSession(), over RPC, in the capnwebValidate() build: so these cases fail if
// that method loses its @skipRpcValidation(), which would wrap the session in a proxy refusing
// every Admin API method.

import { createExecutionContext } from "cloudflare:test";
import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint, env } from "cloudflare:workers";
import type { ApiShape } from "@gadgets/api-schema/schema";
import { ADMIN_BINDING_SUBRESOURCE } from "@gadgets/workshop-shared/admin-agent";
import {
  ADMIN_WRITE_ARGS, type AdminWriteAction, ISSUE_REPORT_IMAGE_TYPES, ISSUE_REPORT_PRIORITIES,
  ISSUE_REPORT_STATUSES, MAX_ISSUE_REPORT_TEXT_LENGTH, issueReportStatusForReporter,
} from "@gadgets/workshop-shared/api";
import {
  type ActionDescription, matchesResourceUrlPattern, type ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it, vi } from "vitest";
import { TAKE_OVER_BY_PERSON } from "../../src/actions.js";
import { ADMIN_SUBRESOURCE, forwarderFor } from "../../src/forward.js";
import { ADMIN_SCHEMA, SERVICES, generatedDeclarations, kindOf } from "../../src/surface.js";
import HAND_WRITTEN_TYPES from "../../src/types.txt";
import * as WORKER from "../../src/worker.js";
import { GatekeeperVendor } from "../../src/worker.js";
import WRANGLER_CONFIG from "../../wrangler.jsonc?raw";

const ROOT = "AdminApi";
const VIEW = "AdminWorkspaceView";
const USER_VIEW = "AdminUserView";
/** The view each open of the Admin API returns. */
const OPENS: Record<string, string> = { inspectWorkspace: VIEW, inspectUser: USER_VIEW };
/** The account's one resource, as the Workshop and a workspace's owner name it. */
const DEPLOYMENT_URL = "instanceadmin://deployment";

/** A session's stub, as an agent's code sees it: the schema's methods, which its type can't name. */
type Session = Disposable & Record<string, (...args: unknown[]) => Promise<any>>;

/** What the fakes saw, in order: "getAdminApi", "observe <title>" and "<service>.<method>". */
type Log = string[];

/** A target with one method per name, each recording its call and answering with `answer`. */
function recordingTarget(service: string, names: readonly string[], log: Log,
    answer: (name: string, args: unknown[]) => unknown) {
  class Recording extends RpcTarget {
    readonly calls: { name: string; args: unknown[] }[] = [];
    disposed = 0;

    [Symbol.dispose](): void {
      this.disposed++;
    }
  }
  for (const name of names) {
    Object.defineProperty(Recording.prototype, name, {
      value: async function (this: Recording, ...args: unknown[]) {
        log.push(`${service}.${name}`);
        this.calls.push({ name, args });
        return answer(name, args);
      },
    });
  }
  return new Recording();
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

/** The Workshop's side of one session: the queue, the Admin API it lends, and the views opened. */
function workshop() {
  const log: Log = [];
  const views: ReturnType<typeof recordingTarget>[] = [];
  const failures = new Map<string, Error>();
  // The omitted names are served too, so a call that reached them would be seen.
  const admin = recordingTarget(ROOT, [...SERVICES.get(ROOT)!, "setSiteName", "getUpdateStatus"], log,
      (name) => {
        const failure = failures.get(name);
        if (failure) throw failure;
        if (Object.hasOwn(OPENS, name)) {
          const service = OPENS[name]!;
          const view = recordingTarget(
              service, SERVICES.get(service)!, log, (method) => ({ answered: method }));
          views.push(view);
          return view;
        }
        if (name === "readIssueReportImage") return new Blob([BYTES]).stream();
        return { answered: name };
      });

  class Queue extends RpcTarget {
    readonly observations: ObservationDescription[] = [];
    refuseObservations = false;
    refuseLend: Error | undefined;
    disposed = 0;

    async getAdminApi() {
      log.push("getAdminApi");
      if (this.refuseLend) throw this.refuseLend;
      return admin;
    }

    async authorizeObservation(description: ObservationDescription): Promise<void> {
      log.push(`observe ${description.title}`);
      this.observations.push(description);
      if (this.refuseObservations) throw new Error("The approval queue refused this observation.");
    }

    async submitAction(_action: number, description: ActionDescription): Promise<void> {
      log.push(`submit ${description.actionKind?.tag}`);
    }

    [Symbol.dispose](): void {
      this.disposed++;
    }
  }
  return { log, admin, views, failures, queue: new Queue() };
}

let facets = 0;
const facet = (name = `facet-${++facets}`) => env.INSTANCE_ADMIN_GATEKEEPER.getByName(name);

/** A session from a facet of its own, over `queue`. */
async function openSession(queue: RpcTarget): Promise<Session> {
  return await facet().startSession(queue as never) as unknown as Session;
}

/**
 * What `call` rejects with. Settled through then() alone: `expect(...).rejects` reads other
 * properties of the RPC promise, each a pipelined promise of its own that rejects unhandled.
 */
function rejection(call: Promise<unknown>): Promise<Error> {
  return call.then(() => new Error("did not reject"), (error: Error) => error);
}

/** A value that fits `shape`, for a required argument. */
function sample(shape: ApiShape): unknown {
  switch (shape.kind) {
    case "string": return "x";
    case "number": return 1;
    case "boolean": return true;
    case "literal": return shape.value;
    case "ref": return sample(ADMIN_SCHEMA.shapes[shape.name]!);
    case "union": return sample(shape.branches.find((branch) => branch.kind !== "undefined")!);
    case "array": return [];
    case "object":
      return Object.fromEntries(Object.entries(shape.properties)
          .filter(([, property]) => !(property.kind === "union" &&
              property.branches.some((branch) => branch.kind === "undefined")))
          .map(([key, property]) => [key, sample(property)]));
    default: throw new Error(`no sample for a ${shape.kind}`);
  }
}

/**
 * Arguments that fit `service.name`: one for each required parameter. A write request's are
 * those its sample action takes, which the schema does not say.
 */
function sampleArguments(service: string, name: string): unknown[] {
  const method = ADMIN_SCHEMA.services[service]!.methods.find((candidate) => candidate.name === name)!;
  const args = method.params.filter((param) => !param.optional).map((param) => sample(param.type));
  if (service === ROOT && name === "requestWorkspaceWrite") {
    const { required } = ADMIN_WRITE_ARGS[args[1] as AdminWriteAction];
    args[2] = Object.fromEntries(required.map((argument) => [argument, 1]));
  }
  return args;
}

/** An account and the vendor, as the Workshop reaches them: through the Worker's exports. */
const account = () => createExecutionContext().exports.InstanceAdminAccount({});
const vendor = () => createExecutionContext().exports.GatekeeperVendor({});

const READS = SERVICES.get(ROOT)!.filter((name) => kindOf(name) === "read");
const ACTS = SERVICES.get(ROOT)!.filter((name) => kindOf(name) === "act");

/** `values` as a declaration writes a union of string literals. */
const union = (values: readonly string[]) => values.map((value) => `"${value}"`).join(" | ");

describe("the facet", () => {
  it("describes the binding", async () => {
    expect(await facet().describe()).toEqual({
      url: DEPLOYMENT_URL,
      title: "Deployment admin",
      snippet: "This deployment's Admin API, as the workspace's owner.",
      suggestedBindingName: "ADMIN",
      tsType: "AdminBinding",
      hookTsType: "IssueReportHook",
    });
  });

  it("serves the generated declarations followed by the hand-written ones", async () => {
    const generated = generatedDeclarations();
    expect(await facet().getTypeScriptTypes()).toBe(`${generated}\n${HAND_WRITTEN_TYPES}`);
    expect(HAND_WRITTEN_TYPES).toContain("export interface AdminBinding extends AdminApi");
    // The hand-written part names these two, which only the generated part declares.
    expect(generated).toMatch(/^export interface AdminApi \{$/m);
    expect(generated).toMatch(/^export interface AdminWorkspaceView \{$/m);
    expect(HAND_WRITTEN_TYPES).not.toMatch(/^export interface (AdminApi|AdminWorkspaceView) /m);
  });

  it("declares the report session by hand, in full, with the values the Admin API has", () => {
    expect(HAND_WRITTEN_TYPES).toMatch(/^ {2}openIssueReport\(reportId: string\): Promise<IssueReportSession>;$/m);
    expect(HAND_WRITTEN_TYPES).toMatch(/^export interface IssueReportSession \{$/m);
    expect(HAND_WRITTEN_TYPES).toMatch(/^export interface ScopedIssueReport \{$/m);
    for (const signature of [
      "get(): Promise<ScopedIssueReport>;",
      "readImage(imageId: string): Promise<ReadableStream<Uint8Array>>;",
      "reply(text: string): Promise<void>;",
      "inspectWorkspace(reason: string): Promise<AdminWorkspaceView>;",
    ]) {
      expect(HAND_WRITTEN_TYPES).toContain(`\n  ${signature}\n`);
    }
    expect(HAND_WRITTEN_TYPES).toContain(`priority: ${union(ISSUE_REPORT_PRIORITIES)};`);
    // The statuses a reporter reads, which are all a report session returns. A union that
    // does not fit its line is wrapped after a bar.
    const read = ISSUE_REPORT_STATUSES.filter(
        (status) => issueReportStatusForReporter(status) === status);
    expect(read).toEqual([
      "new", "investigating", "answered", "waitingOnReporter", "withAdmin", "fixProposed", "closed",
    ]);
    const unwrapped = HAND_WRITTEN_TYPES.replace(/ \|\n +/g, " | ");
    expect(unwrapped).toContain(`\n  status: ${union(read)};`);
    expect(unwrapped).toContain(`\n    status?: ${union(read)};`);
    expect(HAND_WRITTEN_TYPES).toContain(`type: ${union(ISSUE_REPORT_IMAGE_TYPES)};`);
    expect(HAND_WRITTEN_TYPES).toContain(`at most ${MAX_ISSUE_REPORT_TEXT_LENGTH} characters`);
    // What a restricted reporter's workspace does to the workspace that reads it, and what a
    // rule still applies there: never this session's reply.
    expect(HAND_WRITTEN_TYPES.replace(/\n +\* /g, " ")).toContain(
        "When that workspace holds restricted data, every answer of the view marks THIS " +
        "workspace as holding restricted data too: from the first one on, nothing here is " +
        "applied without a person (a reply through this session included; a rule may still " +
        "apply an admins-only note, a change of status and a claim or release of the whole " +
        "binding) and web fetches reach only trusted hosts.");
    // How a session is handed to a spawned agent: never from the report id.
    expect(HAND_WRITTEN_TYPES).toContain("never from the report id");
    expect(HAND_WRITTEN_TYPES).toContain("crypto.randomUUID()");
  });

  it("has no agent catalog", async () => {
    expect(await facet().getAgentCatalog()).toBeNull();
  });

  it("allows every observer it is asked about, and keeps no observer state", async () => {
    const worker = createExecutionContext().exports;
    const gatekeeper = facet();
    const observers = [
      { id: "owner", verifier: await worker.InstanceAdminAccount({}).getVerifier() },
      { id: "second-admin", verifier: await worker.InstanceAdminAccount({}).getVerifier() },
    ];
    await expect(gatekeeper.verifyObserverAccess(observers, [ADMIN_SUBRESOURCE]))
        .resolves.toEqual({ allowedObserverIds: ["owner", "second-admin"] });
    await expect(gatekeeper.verifyObserverAccess(observers, []))
        .resolves.toEqual({ allowedObserverIds: ["owner", "second-admin"] });
    await expect(gatekeeper.verifyObserverAccess([], [ADMIN_SUBRESOURCE]))
        .resolves.toEqual({ allowedObserverIds: [] });
    await expect(gatekeeper.getHistoricalSubresources()).resolves.toEqual([]);
    await expect(gatekeeper.addObserver("second-admin", observers[1]!.verifier)).resolves.toBeUndefined();
    await expect(gatekeeper.removeObserver("second-admin")).resolves.toBeUndefined();
  });
});

describe("the account", () => {
  it("declares no singleton and no UI, so it is injected into no workspace", async () => {
    const description = await account().describe();
    expect(description.displayName).toBe("Deployment admin");
    expect(description).not.toHaveProperty("singleton");
    expect(description).not.toHaveProperty("providesUi");
  });

  it("offers the one resource, and gives its class for that URL alone", async () => {
    const resources = await account().getSupportedResources();
    expect(resources.map((resource) => [resource.id, resource.urlPattern]))
        .toEqual([["deployment", DEPLOYMENT_URL]]);
    expect(matchesResourceUrlPattern(resources[0]!.urlPattern, DEPLOYMENT_URL)).toBe(true);

    const found = await account().getGatekeeperClassFor(DEPLOYMENT_URL);
    expect(found.resource.urlPattern).toBe(DEPLOYMENT_URL);
    for (const url of ["instanceadmin://deployment/", "instanceadmin://other", "https://example.com/"]) {
      expect((await rejection(account().getGatekeeperClassFor(url))).message, url)
          .toBe("The admin gatekeeper has one resource, instanceadmin://deployment.");
    }
  });

  it("adds the resource through a frame with nothing to choose", async () => {
    const frame = await account().startResourceConfigurator("deployment");
    expect(frame.iframeHtml).toContain("only deployment admins can open this workspace");
    const ui = frame.ui as unknown as { resourceUrl(): Promise<string> };
    expect(await ui.resourceUrl()).toBe(DEPLOYMENT_URL);
    for (const type of ["https://*", "other"]) {
      expect((await rejection(account().startResourceConfigurator(type))).message, type)
          .toBe("The admin gatekeeper has one resource, instanceadmin://deployment.");
    }
  });

  it("has no connect flow, and revokes having done nothing", async () => {
    await expect(account().revoke()).resolves.toBeUndefined();
    await expect(account().ensureResources(["deployment"])).resolves.toEqual({});
    await expect(account().getAuthenticatedEmail()).resolves.toBeNull();
    expect((await rejection(account().reconnect())).message).toMatch(/no connect flow/);
    expect((await rejection(account().commitReconnect("stage"))).message).toMatch(/no connect flow/);
  });
});

describe("the vendor", () => {
  it("auto-provisions, for deployment admins, and says what removing the account does", async () => {
    const description = await vendor().describe();
    expect(description.displayName).toBe("Deployment admin");
    expect(description.autoProvisionsAccount).toBe(true);
    expect(description.providesAuth).toBe(false);
    expect(description.tagline).toMatch(/deployment admin/);
    expect(description.description).toMatch(/^For deployment admins only\./);
    expect(description.description).toContain("admits only deployment admins");
    expect(description.description!.endsWith(" Removing this account ends every connection made " +
        "with it, in every workspace you own, until you add it again.")).toBe(true);
  });

  it("advertises no creatable resource and cannot create one", async () => {
    const resources = await vendor().getSupportedResources();
    expect(resources.map((resource) => resource.urlPattern)).toEqual([DEPLOYMENT_URL]);
    for (const resource of resources) {
      expect(resource).not.toHaveProperty("creatable");
      expect(resource).not.toHaveProperty("creationConfigurator");
    }
    expect("createResource" in GatekeeperVendor.prototype).toBe(false);
    const createResource = (vendor() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)
        .createResource!;
    expect(await rejection(createResource(DEPLOYMENT_URL, "Another"))).not.toHaveProperty(
        "message", "did not reject");
  });

  it("mints accounts that are all alike, with no connect flow", async () => {
    const minted = await vendor().createAccount();
    expect(await minted.describe()).toEqual(await account().describe());
    expect((await rejection(vendor().connectAccount(undefined as never))).message)
        .not.toBe("did not reject");
  });

  it("serves the binding's declarations, and takes the report store's events", async () => {
    expect(await vendor().getTypeScriptTypes()).toBe(await facet().getTypeScriptTypes());
    await expect(vendor().issueReportEvents([
      { kind: "reported", id: "e1", reportId: "r1", priority: "low", at: new Date(0) },
      { kind: "investigationComplete", id: "e2", reportId: "r1", status: "answered", at: new Date(1) },
    ])).resolves.toBeUndefined();
  });
});

describe("the Worker", () => {
  // The runtime does not start a Worker whose entry module exports a value that is no handler,
  // such as a string constant. This pool loads the module without that check.
  it("exports classes and nothing else", () => {
    const exported = Object.entries(WORKER);
    expect(exported.map(([name]) => name)).toContain("default");
    for (const [name, value] of exported) expect(typeof value, name).toBe("function");
  });

  // Wrangler makes a Durable Object of every class a migration names, bound or not, and the
  // runtime does not start a Worker that exports no such class.
  it("exports every Durable Object class its migrations name", () => {
    const config: { migrations: { new_sqlite_classes?: string[]; new_classes?: string[] }[] } =
        JSON.parse(WRANGLER_CONFIG.replace(/^\s*\/\/.*$/gm, ""));
    const migrated = config.migrations.flatMap(
        (migration) => [...(migration.new_sqlite_classes ?? []), ...(migration.new_classes ?? [])]);
    expect(migrated).toEqual(["InstanceAdminGatekeeper", "IssueReportHookDriver"]);
    const exported: Record<string, unknown> = WORKER;
    for (const name of migrated) {
      const exportedClass = exported[name] as { prototype?: unknown } | undefined;
      expect(exportedClass?.prototype, name).toBeInstanceOf(DurableObject);
    }
  });

  // The facet mints a hook's controller through ctx.exports, which holds only what the entry
  // module exports.
  it("exports the hook controller", () => {
    expect(WORKER.IssueReportHookController.prototype).toBeInstanceOf(WorkerEntrypoint);
  });
});

describe("a session's reads", () => {
  it("are lent, then observed, then forwarded with their arguments", async () => {
    const { log, admin, queue } = workshop();
    using session = await openSession(queue);

    expect(await session.listUsers!({ limit: 2 })).toEqual({ answered: "listUsers" });

    expect(log).toEqual(["getAdminApi", "observe Admin API: listUsers", "AdminApi.listUsers"]);
    expect(admin.calls).toEqual([{ name: "listUsers", args: [{ limit: 2 }] }]);
    expect(ADMIN_SUBRESOURCE).toBe(ADMIN_BINDING_SUBRESOURCE);
    expect(queue.observations).toEqual([{
      title: "Admin API: listUsers",
      description: "Call `listUsers()` of this deployment's Admin API, as this workspace's owner.",
      fields: [{ label: "Arguments", kind: "json", value: JSON.stringify([{ limit: 2 }], null, 2) }],
      subresources: [ADMIN_BINDING_SUBRESOURCE],
      containsRestrictedData: true,
    }]);
  });

  it("ask who the binding's admin is as any read: observed, flagged and forwarded", async () => {
    const { log, admin, queue } = workshop();
    using session = await openSession(queue);

    expect(READS).toContain("whoami");
    expect(await session.whoami!()).toEqual({ answered: "whoami" });

    expect(log).toEqual(["getAdminApi", "observe Admin API: whoami", "AdminApi.whoami"]);
    expect(admin.calls).toEqual([{ name: "whoami", args: [] }]);
    expect(queue.observations).toEqual([{
      title: "Admin API: whoami",
      description: "Call `whoami()` of this deployment's Admin API, as this workspace's owner.",
      subresources: [ADMIN_BINDING_SUBRESOURCE],
      containsRestrictedData: true,
    }]);
  });

  it("show no arguments for a call that was given none", async () => {
    const { queue } = workshop();
    using session = await openSession(queue);

    await session.getSettings!();
    await session.listUsers!(undefined);

    expect(queue.observations.map((observation) => observation.fields)).toEqual([undefined, undefined]);
  });

  it("each mark the workspace, on the root and on a view it opened, under the binding's id", async () => {
    const { log, admin, views, queue } = workshop();
    using session = await openSession(queue);

    for (const name of READS) await session[name]!(...sampleArguments(ROOT, name));
    using view = await session.inspectWorkspace!("workspace-1", "a check") as Session;
    for (const name of SERVICES.get(VIEW)!) await view[name]!(...sampleArguments(VIEW, name));
    using account = await session.inspectUser!("user-1", "a check") as Session;
    for (const name of SERVICES.get(USER_VIEW)!) {
      await account[name]!(...sampleArguments(USER_VIEW, name));
    }

    const calls = [...READS.map((name) => `Admin API: ${name}`), "Admin API: inspectWorkspace",
      ...SERVICES.get(VIEW)!.map((name) => `Admin view: ${name}`), "Admin API: inspectUser",
      ...SERVICES.get(USER_VIEW)!.map((name) => `Admin view: ${name}`)];
    expect(queue.observations.map((observation) => observation.title)).toEqual(calls);
    for (const observation of queue.observations) {
      expect(observation.subresources, observation.title).toEqual([ADMIN_BINDING_SUBRESOURCE]);
      expect(observation.containsRestrictedData, observation.title).toBe(true);
    }
    expect(admin.calls.map((call) => call.name))
        .toEqual([...READS, "inspectWorkspace", "inspectUser"]);
    expect(views.at(-2)!.calls.map((call) => call.name)).toEqual(SERVICES.get(VIEW));
    expect(views.at(-1)!.calls.map((call) => call.name)).toEqual(SERVICES.get(USER_VIEW));
    // One lend for the whole session, asked for by its first read.
    expect(log.filter((entry) => entry === "getAdminApi")).toEqual(["getAdminApi"]);
    expect(log[0]).toBe("getAdminApi");
  });

  it("ask for the lend once, however many arrive together", async () => {
    const { log, queue } = workshop();
    using session = await openSession(queue);

    await Promise.all([session.listUsers!(), session.listWorkspaces!(), session.getSettings!()]);

    expect(log.filter((entry) => entry === "getAdminApi")).toHaveLength(1);
    expect(queue.observations).toHaveLength(3);
  });

  it("forward nothing when the observation is refused", async () => {
    const { log, admin, queue } = workshop();
    queue.refuseObservations = true;
    using session = await openSession(queue);

    expect((await rejection(session.listUsers!())).message)
        .toBe("The approval queue refused this observation.");

    expect(log).toEqual(["getAdminApi", "observe Admin API: listUsers"]);
    expect(admin.calls).toEqual([]);
  });

  it("observe nothing when the lend is refused, and ask again at the next read", async () => {
    const { log, admin, queue } = workshop();
    queue.refuseLend = new Error("Only this workspace's owner can open the admin connection directly.");
    using session = await openSession(queue);

    expect((await rejection(session.listUsers!())).message)
        .toBe("Only this workspace's owner can open the admin connection directly.");
    expect((await rejection(session.inspectWorkspace!("workspace-1", "a check"))).message)
        .toBe("Only this workspace's owner can open the admin connection directly.");
    expect(log).toEqual(["getAdminApi", "getAdminApi"]);
    expect(queue.observations).toEqual([]);
    expect(admin.calls).toEqual([]);

    queue.refuseLend = undefined;
    expect(await session.listUsers!()).toEqual({ answered: "listUsers" });
    await session.getSettings!();
    expect(log).toEqual([
      "getAdminApi", "getAdminApi",
      "getAdminApi", "observe Admin API: listUsers", "AdminApi.listUsers",
      "observe Admin API: getSettings", "AdminApi.getSettings",
    ]);
  });

  it("refuse malformed arguments before the queue is touched", async () => {
    const { log, queue } = workshop();
    using session = await openSession(queue);

    const refusal = await rejection(session.listUsers!({ limit: "many" }));
    expect(refusal.message).toMatch(/^Invalid arguments for AdminApi\.listUsers: /);
    expect(refusal.message).toContain("limit");
    expect((await rejection(session.getIssueReport!())).message)
        .toMatch(/^Invalid arguments for AdminApi\.getIssueReport: /);
    expect((await rejection(session.getSettings!("extra"))).message)
        .toMatch(/^Invalid arguments for AdminApi\.getSettings: /);

    expect(log).toEqual([]);
  });

  it("pass an error of the lent Admin API on as thrown, having observed the call", async () => {
    const { log, failures, queue } = workshop();
    failures.set("getIssueReport", new Error("No such issue report."));
    using session = await openSession(queue);

    expect((await rejection(session.getIssueReport!("missing"))).message).toBe("No such issue report.");

    expect(log).toEqual(["getAdminApi", "observe Admin API: getIssueReport", "AdminApi.getIssueReport"]);
  });

  it("hand a stream to the caller unread", async () => {
    const { queue } = workshop();
    using session = await openSession(queue);

    const stream = await session.readIssueReportImage!("report-1", "image-1");

    expect(stream).toBeInstanceOf(ReadableStream);
    expect(new Uint8Array(await new Response(stream as ReadableStream).arrayBuffer())).toEqual(BYTES);
    expect(queue.observations.map((observation) => observation.title))
        .toEqual(["Admin API: readIssueReportImage"]);
  });
});

describe("a view a session opened", () => {
  it("is wrapped: each call is observed, then forwarded, after the call that opened it returned", async () => {
    const { log, views, queue } = workshop();
    using session = await openSession(queue);

    using view = await session.inspectWorkspace!("workspace-1", "a check", { access: "metadata" }) as Session;
    await session.getSettings!();
    expect(await view.getChat!(4, 9)).toEqual({ answered: "getChat" });
    expect(await view.describe!()).toEqual({ answered: "describe" });

    expect(log).toEqual([
      "getAdminApi", "observe Admin API: inspectWorkspace", "AdminApi.inspectWorkspace",
      "observe Admin API: getSettings", "AdminApi.getSettings",
      "observe Admin view: getChat", "AdminWorkspaceView.getChat",
      "observe Admin view: describe", "AdminWorkspaceView.describe",
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]!.calls).toEqual([{ name: "getChat", args: [4, 9] }, { name: "describe", args: [] }]);
    expect(queue.observations.at(-2)).toEqual({
      title: "Admin view: getChat",
      description: "Call `getChat()` of an admin's view of a workspace.",
      fields: [{ label: "Arguments", kind: "json", value: JSON.stringify([4, 9], null, 2) }],
      subresources: [ADMIN_BINDING_SUBRESOURCE],
      containsRestrictedData: true,
    });
  });

  it("of a user's account is wrapped the same way, and answers nothing of a workspace's view",
      async () => {
    const { log, views, queue } = workshop();
    using session = await openSession(queue);

    using view = await session.inspectUser!("user-1", "a check", { lifetimeSeconds: 60 }) as Session;
    expect(await view.listConnectedAccounts!()).toEqual({ answered: "listConnectedAccounts" });

    expect(log).toEqual([
      "getAdminApi", "observe Admin API: inspectUser", "AdminApi.inspectUser",
      "observe Admin view: listConnectedAccounts", "AdminUserView.listConnectedAccounts",
    ]);
    expect(views[0]!.calls).toEqual([{ name: "listConnectedAccounts", args: [] }]);
    expect(queue.observations.at(-1)).toEqual({
      title: "Admin view: listConnectedAccounts",
      description: "Call `listConnectedAccounts()` of an admin's view of a user's account.",
      subresources: [ADMIN_BINDING_SUBRESOURCE],
      containsRestrictedData: true,
    });

    log.length = 0;
    for (const name of ["getChat", "readFile", "inspectUser", "listUsers"]) {
      expect((await rejection(view[name]!(1))).message, name).not.toBe("did not reject");
    }
    expect(log).toEqual([]);
  });

  it("checks its own arguments, and exposes no method of the root", async () => {
    const { log, queue } = workshop();
    using session = await openSession(queue);
    using view = await session.inspectWorkspace!("workspace-1", "a check") as Session;
    log.length = 0;

    expect((await rejection(view.getChat!("four"))).message)
        .toMatch(/^Invalid arguments for AdminWorkspaceView\.getChat: /);
    expect((await rejection(view.listUsers!())).message).not.toBe("did not reject");
    expect((await rejection(view.inspectWorkspace!("workspace-2", "another"))).message)
        .not.toBe("did not reject");

    expect(log).toEqual([]);
  });

  it("observes as it was made: with another id, and no mark, when its opener says so", async () => {
    const { log, queue } = workshop();
    const target = recordingTarget(VIEW, SERVICES.get(VIEW)!, log, (name) => ({ answered: name }));
    using view = new (forwarderFor(VIEW))(
        new RpcStub(queue) as never, { restricted: false, subresource: "x" }, new RpcStub(target),
    ) as unknown as Session;

    expect(await view.describe!()).toEqual({ answered: "describe" });

    expect(log).toEqual(["observe Admin view: describe", "AdminWorkspaceView.describe"]);
    expect(queue.observations).toEqual([{
      title: "Admin view: describe",
      description: "Call `describe()` of an admin's view of a workspace.",
      subresources: ["x"],
    }]);
  });

  it("is made over the capability it forwards to, and the root over none", () => {
    const { queue } = workshop();
    const options = { restricted: true, subresource: ADMIN_SUBRESOURCE };
    expect(() => new (forwarderFor(VIEW))(new RpcStub(queue) as never, options)).toThrow(/needs a capability/);
    expect(() => new (forwarderFor(ROOT))(new RpcStub(queue) as never, options, new RpcStub(queue)))
        .toThrow(/takes no capability/);
    expect(() => forwarderFor("Elsewhere")).toThrow("The Admin API schema has no service Elsewhere.");
  });
});

describe("what a session refuses", () => {
  it("to run an act method: it is queued, and nothing is lent, observed or forwarded", async () => {
    const { log, admin, queue } = workshop();
    using session = await openSession(queue);

    expect(ACTS.toSorted()).toEqual([
      "addIssueReportEntry", "claimIssueReport", "releaseIssueReport", "requestWorkspaceWrite",
      "setIssueReportStatus",
    ]);
    for (const name of ACTS) {
      expect(await session[name]!(...sampleArguments(ROOT, name)), name).toBeUndefined();
    }

    // The sample entry is an admins-only one, and the sample request asks for content access.
    expect(log.toSorted()).toEqual([
      "submit content-access-request", "submit issue-report-assignment",
      "submit issue-report-assignment", "submit issue-report-note", "submit issue-report-status",
    ]);
    expect(admin.calls).toEqual([]);
    expect(queue.observations).toEqual([]);
  });

  it("to take a report over: the claim is rejected, and nothing is queued", async () => {
    const { log, admin, queue } = workshop();
    using session = await openSession(queue);

    // Whoever it names, an admin or nobody.
    for (const takeOverFrom of ["grace@example.test", ""]) {
      expect((await rejection(session.claimIssueReport!("report-1", { takeOverFrom }))).message)
          .toBe(TAKE_OVER_BY_PERSON);
    }
    expect(TAKE_OVER_BY_PERSON).toMatch(/^Only a person takes an issue report/);
    expect(TAKE_OVER_BY_PERSON).toContain("without takeOverFrom");
    // An option the claim does not have is the argument check's to refuse.
    expect((await rejection(session.claimIssueReport!("report-1", { takeOverFrom: true }))).message)
        .toMatch(/^Invalid arguments for AdminApi\.claimIssueReport: /);
    expect((await rejection(session.releaseIssueReport!("report-1", { takeOverFrom: "grace" })))
        .message).toMatch(/^Invalid arguments for AdminApi\.releaseIssueReport: /);
    expect(log).toEqual([]);
    expect(admin.calls).toEqual([]);

    // Without the option, or with it unset, the claim is queued.
    expect(await session.claimIssueReport!("report-1", { takeOverFrom: undefined }))
        .toBeUndefined();
    expect(await session.claimIssueReport!("report-1")).toBeUndefined();
    expect(log).toEqual(["submit issue-report-assignment", "submit issue-report-assignment"]);
    expect(queue.observations).toEqual([]);
  });

  it("an act method on a session that was given no actions", async () => {
    const { log, queue } = workshop();
    using session = new (forwarderFor(ROOT))(
        new RpcStub(queue) as never, { restricted: true, subresource: ADMIN_SUBRESOURCE },
    ) as unknown as Session;

    for (const name of ACTS) {
      expect((await rejection(session[name]!(...sampleArguments(ROOT, name)))).message, name)
          .toBe(`AdminApi.${name}() has no action defined for it.`);
    }

    expect(log).toEqual([]);
  });

  it("an omitted method, and every name the schema does not hold", async () => {
    const { log, queue } = workshop();
    using session = await openSession(queue);

    // Every name on an RPC stub is callable, so only the call's rejection says it is not served.
    for (const name of ["setSiteName", "getUpdateStatus", "approveWorkspaceWrite", "serving",
      "#call", "#lend", "#queue", "describe", "get", "reply", "readImage"]) {
      expect((await rejection(session[name]!("x"))).message, name).not.toBe("did not reject");
    }

    expect(log).toEqual([]);
  });

  it("defines the schema's methods and nothing else, and keeps its state private", () => {
    for (const [service, names] of SERVICES) {
      const prototype = forwarderFor(service).prototype as object;
      expect(Object.getOwnPropertyNames(prototype).toSorted(), service)
          .toEqual(["constructor", ...names].toSorted());
      for (const name of names) {
        expect(Object.getOwnPropertyDescriptor(prototype, name), name)
            .toMatchObject({ enumerable: false, writable: false, configurable: false });
      }
      // What the served classes share adds no method a caller could reach.
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(prototype))).toEqual(["constructor"]);
    }
    const { queue } = workshop();
    using session = new (forwarderFor(ROOT))(
        new RpcStub(queue) as never, { restricted: true, subresource: ADMIN_SUBRESOURCE });
    expect(Reflect.ownKeys(session)).toEqual([]);
  });
});

describe("disposal", () => {
  it("releases the queue, the lent Admin API and a view's stub", async () => {
    const { admin, views, queue } = workshop();
    const session = await openSession(queue);
    await session.listUsers!();
    const view = await session.inspectWorkspace!("workspace-1", "a check") as Session;
    await view.describe!();
    expect([queue.disposed, admin.disposed, views[0]!.disposed]).toEqual([0, 0, 0]);

    view[Symbol.dispose]();
    await vi.waitFor(() => expect(views[0]!.disposed).toBe(1));
    expect([queue.disposed, admin.disposed]).toEqual([0, 0]);
    // A view carries what it observes with, and nothing to queue an action through.
    expect((await rejection(view.addIssueReportEntry!("report-1", "x", "admins"))).message)
        .not.toBe("did not reject");

    session[Symbol.dispose]();
    await vi.waitFor(() => expect([queue.disposed, admin.disposed]).toEqual([1, 1]));
  });

  it("releases the queue of a session that was lent nothing", async () => {
    const { admin, queue } = workshop();
    queue.refuseLend = new Error("Gatekeeper is disabled.");
    const session = await openSession(queue);
    await rejection(session.listUsers!());

    session[Symbol.dispose]();

    await vi.waitFor(() => expect(queue.disposed).toBe(1));
    expect(admin.disposed).toBe(0);
  });
});
