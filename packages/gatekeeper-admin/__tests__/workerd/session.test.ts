// The facet and the sessions it opens. Every session comes from the facet's startSession(), over
// RPC, in the capnwebValidate() build: so these cases fail if that method loses its
// @skipRpcValidation(), which would wrap the session in a proxy refusing every Admin API method.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApiShape } from "@gadgets/api-schema/schema";
import { GLOBAL_SUBRESOURCE_ID } from "@gadgets/gatekeeper-kit/subresource-ids";
import { ADMIN_ACCESS_ERROR_CODES, createAdminAccessError } from "@gadgets/workshop-shared/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SUBRESOURCE, forwarderFor } from "../../src/forward.js";
import { ADMIN_SCHEMA, SERVICES, generatedDeclarations, kindOf } from "../../src/surface.js";
import HAND_WRITTEN_TYPES from "../../src/types.txt";
import {
  Queue, accountOf, connectAccount, observer, openSession, rejection, withFacet, type Session,
} from "./harness.js";
import { ROOT, USER_VIEW, VIEW, recordingTarget, workshop } from "./worker.js";

/** The account's one resource, as the Workshop and a workspace's owner name it. */
const DEPLOYMENT_URL = "admin://deployment";
/** What a call is refused with once the account's user is no deployment admin. */
const NOT_ADMIN = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin).message;
const NOT_CONNECTED = "This deployment admin account is no longer connected.";
/** A forwarder's check of the account, for one made here rather than by the facet. */
const admin = async () => {};

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

/** Arguments that fit `service.name`: one for each required parameter. */
function sampleArguments(service: string, name: string): unknown[] {
  const method = ADMIN_SCHEMA.services[service]!.methods.find((candidate) => candidate.name === name)!;
  return method.params.filter((param) => !param.optional).map((param) => sample(param.type));
}

const READS = SERVICES.get(ROOT)!.filter((name) => kindOf(name) === "read");

/** Runs `body` with a session of a connection made from ada's account, and its queue. */
async function withSession<T>(body: (session: Session, queue: Queue) => Promise<T>): Promise<T> {
  const userObjectId = await connectAccount("ada");
  workshop.log.length = 0;
  return withFacet(userObjectId, async (facet) => {
    const queue = new Queue();
    using session = await openSession(facet, queue);
    return await body(session, queue);
  });
}

beforeEach(() => workshop.reset());

describe("the facet", () => {
  it("describes the binding", async () => {
    expect(await withFacet(await connectAccount("ada"), (facet) => facet.describe())).toEqual({
      url: DEPLOYMENT_URL,
      title: "Deployment admin",
      snippet: "This deployment's Admin API, as the admin who connected it.",
      suggestedBindingName: "ADMIN",
      tsType: "AdminBinding",
    });
  });

  it("serves the generated declarations followed by the hand-written ones", async () => {
    const generated = generatedDeclarations();
    expect(await withFacet(await connectAccount("ada"), (facet) => facet.getTypeScriptTypes()))
        .toBe(`${generated}\n${HAND_WRITTEN_TYPES}`);
    expect(HAND_WRITTEN_TYPES).toContain("export interface AdminBinding extends AdminApi");
    // The hand-written part names these two, which only the generated part declares.
    expect(generated).toMatch(/^export interface AdminApi \{$/m);
    expect(generated).toMatch(/^export interface AdminWorkspaceView \{$/m);
    expect(HAND_WRITTEN_TYPES).not.toMatch(/^export interface (AdminApi|AdminWorkspaceView) /m);
  });

  it("has no action: none is auto-approvable, and each entry point refuses", async () => {
    await withFacet(await connectAccount("ada"), async (facet) => {
      expect(await facet.getAutoApprovableActions()).toEqual([]);
      expect(await facet.getAgentCatalog()).toBeNull();
      const refusals = await Promise.all([
        rejection(facet.applyAction(7, new RpcStub(new (class extends RpcTarget {})()) as never)),
        rejection(facet.rejectAction(7)),
        rejection(facet.revertAction(7)),
      ]);
      expect(refusals.map((refusal) => refusal.message))
          .toEqual(Array(3).fill("The admin gatekeeper has no action 7."));
    });
  });
});

describe("observer verification", () => {
  it("allows the observers whose own account says its user is a deployment admin now", async () => {
    const [ada, grace, heidi] =
        [await connectAccount("ada"), await connectAccount("grace"), await connectAccount("heidi")];
    await withFacet(ada, async (facet) => {
      const observers = [await observer("second", grace), await observer("third", heidi)];
      expect(ADMIN_SUBRESOURCE).toBe(GLOBAL_SUBRESOURCE_ID);
      expect(await facet.verifyObserverAccess(observers, [ADMIN_SUBRESOURCE]))
          .toEqual({ allowedObserverIds: ["second", "third"] });

      // Nothing is kept between calls: a demotion is seen by the next one, and so is its end.
      workshop.admins.delete("heidi");
      expect(await facet.verifyObserverAccess(observers, [ADMIN_SUBRESOURCE]))
          .toEqual({ allowedObserverIds: ["second"] });
      workshop.admins.add("heidi");
      expect(await facet.verifyObserverAccess(observers, [ADMIN_SUBRESOURCE]))
          .toEqual({ allowedObserverIds: ["second", "third"] });

      // The connection's own admin being demoted changes nothing for the observers.
      workshop.admins.delete("ada");
      expect(await facet.verifyObserverAccess(observers, [ADMIN_SUBRESOURCE]))
          .toEqual({ allowedObserverIds: ["second", "third"] });
      expect(await facet.verifyObserverAccess([], [ADMIN_SUBRESOURCE]))
          .toEqual({ allowedObserverIds: [] });
    });
  });

  it("refuses an id the binding never reports, and a question about none", async () => {
    const [ada, grace] = [await connectAccount("ada"), await connectAccount("grace")];
    await withFacet(ada, async (facet) => {
      const observers = [await observer("second", grace)];
      for (const ids of [["admin:deployment"], [ADMIN_SUBRESOURCE, "other"], [""]]) {
        expect((await rejection(facet.verifyObserverAccess(observers, ids))).message, String(ids))
            .toBe("This connection was asked about a resource it never reported.");
      }
      expect((await rejection(facet.verifyObserverAccess(observers, []))).message)
          .toBe("There are no subresources to check access to.");
    });
  });

  it("fails the whole check when an observer's account was removed: nobody is allowed", async () => {
    const [ada, grace, heidi] =
        [await connectAccount("ada"), await connectAccount("grace"), await connectAccount("heidi")];
    await withFacet(ada, async (facet) => {
      const observers = [await observer("second", grace), await observer("third", heidi)];
      await accountOf(heidi).revoke();
      expect((await rejection(facet.verifyObserverAccess(observers, [ADMIN_SUBRESOURCE]))).message)
          .toBe("This deployment admin account is no longer connected.");
    });
  });

  it("keeps no observer state and reports no history", async () => {
    const [ada, grace] = [await connectAccount("ada"), await connectAccount("grace")];
    await withFacet(ada, async (facet) => {
      const { verifier } = await observer("second", grace);
      await expect(facet.getHistoricalSubresources()).resolves.toEqual([]);
      await expect(facet.addObserver("second", verifier)).resolves.toBeUndefined();
      await expect(facet.removeObserver("second")).resolves.toBeUndefined();
    });
    expect(workshop.log).toEqual([]);
  });
});

describe("a session's reads", () => {
  it("are opened, then forwarded with their arguments, then observed", async () => {
    await withSession(async (session, queue) => {
      expect(await session.listUsers!({ limit: 2 })).toEqual({ answered: "listUsers" });

      expect(workshop.log).toEqual(["open ada", "AdminApi.listUsers", "observe Admin API: listUsers"]);
      expect(workshop.apis[0]!.calls).toEqual([{ name: "listUsers", args: [{ limit: 2 }] }]);
      expect(queue.observations).toEqual([{
        title: "Admin API: listUsers",
        description: "Call `listUsers()` of this deployment's Admin API, as the admin who connected it.",
        fields: [{ label: "Arguments", kind: "json", value: JSON.stringify([{ limit: 2 }], null, 2) }],
        subresources: [GLOBAL_SUBRESOURCE_ID],
        containsRestrictedData: true,
      }]);
    });
  });

  it("show no arguments for a call that was given none", async () => {
    await withSession(async (session, queue) => {
      await session.getSettings!();
      await session.listUsers!(undefined);
      expect(queue.observations.map((observation) => observation.fields)).toEqual([undefined, undefined]);
    });
  });

  it("each mark the workspace and name the binding's one requirement, on the root and on a view", async () => {
    await withSession(async (session, queue) => {
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
        expect(observation.subresources, observation.title).toEqual([GLOBAL_SUBRESOURCE_ID]);
        expect(observation.containsRestrictedData, observation.title).toBe(true);
      }
      expect(workshop.apis[0]!.calls.map((call) => call.name))
          .toEqual([...READS, "inspectWorkspace", "inspectUser"]);
      expect(workshop.views.at(-2)!.calls.map((call) => call.name)).toEqual(SERVICES.get(VIEW));
      expect(workshop.views.at(-1)!.calls.map((call) => call.name)).toEqual(SERVICES.get(USER_VIEW));
      // One Admin API for the whole session, opened by its first read.
      expect(workshop.log.filter((entry) => entry.startsWith("open "))).toEqual(["open ada"]);
      expect(workshop.log[0]).toBe("open ada");
    });
  });

  it("open the Admin API once, however many arrive together", async () => {
    await withSession(async (session, queue) => {
      await Promise.all([session.listUsers!(), session.listWorkspaces!(), session.getSettings!()]);
      expect(workshop.log.filter((entry) => entry.startsWith("open "))).toHaveLength(1);
      expect(queue.observations).toHaveLength(3);
    });
  });

  it("answer nothing when the observation is refused, and let go of a view it opened", async () => {
    await withSession(async (session, queue) => {
      queue.refuseObservations = true;
      expect((await rejection(session.listUsers!())).message)
          .toBe("The approval queue refused this observation.");
      expect(workshop.log).toEqual(["open ada", "AdminApi.listUsers", "observe Admin API: listUsers"]);

      expect((await rejection(session.inspectWorkspace!("workspace-1", "a check"))).message)
          .toBe("The approval queue refused this observation.");
      await vi.waitFor(() => expect(workshop.views[0]!.disposed).toBe(1));
      expect(workshop.views[0]!.calls).toEqual([]);
    });
  });

  it("observe nothing when the Admin API does not open, and ask again at the next read", async () => {
    await withSession(async (session, queue) => {
      workshop.failures.set("open", new Error("The Workshop is restarting."));
      expect((await rejection(session.listUsers!())).message).toBe("The Workshop is restarting.");
      expect((await rejection(session.inspectWorkspace!("workspace-1", "a check"))).message)
          .toBe("The Workshop is restarting.");
      expect(workshop.log).toEqual(["open ada", "open ada"]);
      expect(queue.observations).toEqual([]);

      workshop.failures.clear();
      expect(await session.listUsers!()).toEqual({ answered: "listUsers" });
      await session.getSettings!();
      expect(workshop.log).toEqual([
        "open ada", "open ada",
        "open ada", "AdminApi.listUsers", "observe Admin API: listUsers",
        "AdminApi.getSettings", "observe Admin API: getSettings",
      ]);
    });
  });

  it("stop, on the session already open and on its views, once the account's admin is demoted", async () => {
    await withSession(async (session, queue) => {
      await session.listUsers!();
      using view = await session.inspectWorkspace!("workspace-1", "a check") as Session;
      await view.describe!();
      const seen = [...workshop.log];

      workshop.admins.delete("ada");
      expect((await rejection(session.listUsers!())).message).toBe(NOT_ADMIN);
      expect((await rejection(view.describe!())).message).toBe(NOT_ADMIN);
      // Nothing was observed or forwarded for either.
      expect(workshop.log).toEqual(seen);
      expect(queue.observations).toHaveLength(3);

      workshop.admins.add("ada");
      expect(await view.describe!()).toEqual({ answered: "describe" });
      expect(await session.listUsers!()).toEqual({ answered: "listUsers" });
    });
  });

  it("stop for good, on the session already open and on its views, once the account is removed", async () => {
    const userObjectId = await connectAccount("ada");
    await withFacet(userObjectId, async (facet) => {
      const queue = new Queue();
      using session = await openSession(facet, queue);
      await session.listUsers!();
      using view = await session.inspectWorkspace!("workspace-1", "a check") as Session;
      const seen = [...workshop.log];

      await accountOf(userObjectId).revoke();
      expect((await rejection(session.listUsers!())).message).toBe(NOT_CONNECTED);
      expect((await rejection(view.describe!())).message).toBe(NOT_CONNECTED);
      expect(workshop.log).toEqual(seen);
      expect(queue.observations).toHaveLength(2);
    });
  });

  it("answer nothing when the account is removed while the observation waits", async () => {
    const userObjectId = await connectAccount("ada");
    await withFacet(userObjectId, async (facet) => {
      const queue = new Queue();
      using session = await openSession(facet, queue);
      queue.whileObserving = () => accountOf(userObjectId).revoke();

      expect((await rejection(session.inspectWorkspace!("workspace-1", "a check"))).message)
          .toBe(NOT_CONNECTED);
      // The view the call had opened is let go, undelivered.
      await vi.waitFor(() => expect(workshop.views[0]!.disposed).toBe(1));
      expect((await rejection(session.listUsers!())).message).toBe(NOT_CONNECTED);
    });
  });

  it("refuse malformed arguments before anything is opened or observed", async () => {
    await withSession(async (session) => {
      const refusal = await rejection(session.listUsers!({ limit: "many" }));
      expect(refusal.message).toMatch(/^Invalid arguments for AdminApi\.listUsers: /);
      expect(refusal.message).toContain("limit");
      expect((await rejection(session.inspectWorkspace!())).message)
          .toMatch(/^Invalid arguments for AdminApi\.inspectWorkspace: /);
      expect((await rejection(session.getSettings!("extra"))).message)
          .toMatch(/^Invalid arguments for AdminApi\.getSettings: /);
      expect(workshop.log).toEqual([]);
    });
  });

  it("pass an error of the Admin API on as thrown, and observe nothing: a refused call read nothing", async () => {
    await withSession(async (session, queue) => {
      workshop.failures.set("listWorkspaces", new Error("The directory is unavailable."));
      workshop.failures.set("inspectWorkspace", new Error("Admin access to workspaces is off."));
      expect((await rejection(session.listWorkspaces!())).message)
          .toBe("The directory is unavailable.");
      expect((await rejection(session.inspectWorkspace!("workspace-1", "a check"))).message)
          .toBe("Admin access to workspaces is off.");
      expect(workshop.log).toEqual(
          ["open ada", "AdminApi.listWorkspaces", "AdminApi.inspectWorkspace"]);
      expect(queue.observations).toEqual([]);
    });
  });
});

describe("a view a session opened", () => {
  it("is wrapped: each call is forwarded, then observed, after the call that opened it returned", async () => {
    await withSession(async (session, queue) => {
      using view = await session.inspectWorkspace!("workspace-1", "a check", { lifetimeSeconds: 60 }) as Session;
      await session.getSettings!();
      expect(await view.getChatState!(4)).toEqual({ answered: "getChatState" });
      expect(await view.describe!()).toEqual({ answered: "describe" });

      expect(workshop.log).toEqual([
        "open ada", "AdminApi.inspectWorkspace", "observe Admin API: inspectWorkspace",
        "AdminApi.getSettings", "observe Admin API: getSettings",
        "AdminWorkspaceView.getChatState", "observe Admin view: getChatState",
        "AdminWorkspaceView.describe", "observe Admin view: describe",
      ]);
      // The view's own lifetime is the Admin API's to decide: the arguments pass as given.
      expect(workshop.apis[0]!.calls[0]).toEqual(
          { name: "inspectWorkspace", args: ["workspace-1", "a check", { lifetimeSeconds: 60 }] });
      expect(workshop.views).toHaveLength(1);
      expect(workshop.views[0]!.calls)
          .toEqual([{ name: "getChatState", args: [4] }, { name: "describe", args: [] }]);
      expect(queue.observations.at(-2)).toEqual({
        title: "Admin view: getChatState",
        description: "Call `getChatState()` of an admin's view of a workspace.",
        fields: [{ label: "Arguments", kind: "json", value: JSON.stringify([4], null, 2) }],
        subresources: [GLOBAL_SUBRESOURCE_ID],
        containsRestrictedData: true,
      });
    });
  });

  it("of a user's account is wrapped the same way, and answers nothing of a workspace's view", async () => {
    await withSession(async (session, queue) => {
      using view = await session.inspectUser!("user-1", "a check", { lifetimeSeconds: 60 }) as Session;
      expect(await view.listConnectedAccounts!()).toEqual({ answered: "listConnectedAccounts" });

      expect(workshop.log).toEqual([
        "open ada", "AdminApi.inspectUser", "observe Admin API: inspectUser",
        "AdminUserView.listConnectedAccounts", "observe Admin view: listConnectedAccounts",
      ]);
      expect(workshop.views[0]!.calls).toEqual([{ name: "listConnectedAccounts", args: [] }]);
      expect(queue.observations.at(-1)).toEqual({
        title: "Admin view: listConnectedAccounts",
        description: "Call `listConnectedAccounts()` of an admin's view of a user's account.",
        subresources: [GLOBAL_SUBRESOURCE_ID],
        containsRestrictedData: true,
      });

      workshop.log.length = 0;
      for (const name of ["getChatState", "listFiles", "inspectUser", "listUsers"]) {
        expect((await rejection(view[name]!(1))).message, name).not.toBe("did not reject");
      }
      expect(workshop.log).toEqual([]);
    });
  });

  it("checks its own arguments, and exposes no method of the root", async () => {
    await withSession(async (session) => {
      using view = await session.inspectWorkspace!("workspace-1", "a check") as Session;
      workshop.log.length = 0;

      expect((await rejection(view.getChatState!("four"))).message)
          .toMatch(/^Invalid arguments for AdminWorkspaceView\.getChatState: /);
      expect((await rejection(view.listUsers!())).message).not.toBe("did not reject");
      expect((await rejection(view.inspectWorkspace!("workspace-2", "another"))).message)
          .not.toBe("did not reject");
      expect(workshop.log).toEqual([]);
    });
  });

  it("is made over the capability it forwards to, and the root over what opens one", () => {
    const queue = () => new RpcStub(new Queue()) as never;
    const view = new RpcStub(new (class extends RpcTarget {})());
    expect(() => new (forwarderFor(VIEW))(queue(), admin, { open: async () => view }))
        .toThrow("A session of AdminWorkspaceView needs a view to forward to.");
    expect(() => new (forwarderFor(ROOT))(queue(), admin, { view }))
        .toThrow("A session of AdminApi opens the Admin API itself.");
    expect(() => forwarderFor("Elsewhere")).toThrow("The Admin API schema has no service Elsewhere.");
  });
});

describe("what a session refuses", () => {
  it("an omitted method, and every name the schema does not hold", async () => {
    await withSession(async (session) => {
      // Every name on an RPC stub is callable, so only the call's rejection says it is not served.
      for (const name of ["setSiteName", "getUpdateStatus", "checkForUpdates", "writeWorkspace",
        "serving", "#call", "#target", "#queue", "describe"]) {
        expect((await rejection(session[name]!("x"))).message, name).not.toBe("did not reject");
      }
      expect(workshop.log).toEqual([]);
    });
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
    using session = new (forwarderFor(ROOT))(
        new RpcStub(new Queue()) as never, admin, { open: async () => { throw new Error("unused"); } });
    expect(Reflect.ownKeys(session)).toEqual([]);
  });
});

describe("disposal", () => {
  it("releases the queue and a view's stub", async () => {
    const userObjectId = await connectAccount("ada");
    await withFacet(userObjectId, async (facet) => {
      const queue = new Queue();
      const session = await openSession(facet, queue);
      const view = await session.inspectWorkspace!("workspace-1", "a check") as Session;
      await view.describe!();
      expect([queue.disposed, workshop.views[0]!.disposed]).toEqual([0, 0]);

      view[Symbol.dispose]();
      await vi.waitFor(() => expect(workshop.views[0]!.disposed).toBe(1));
      expect(queue.disposed).toBe(0);

      session[Symbol.dispose]();
      await vi.waitFor(() => expect(queue.disposed).toBe(1));
    });
  });

  // Made here rather than by the facet: the runtime does not run the disposer of a target an
  // entrypoint returned, which is how the suite's grant hands out its Admin API.
  it("releases the Admin API a session opened", async () => {
    const api = recordingTarget(ROOT, SERVICES.get(ROOT)!, (name) => ({ answered: name }));
    const queue = new Queue();
    const session = new (forwarderFor(ROOT))(
        new RpcStub(queue) as never, admin, { open: async () => new RpcStub(api) },
    ) as unknown as Session;
    expect(await session.listUsers!()).toEqual({ answered: "listUsers" });
    expect([queue.disposed, api.disposed]).toEqual([0, 0]);

    session[Symbol.dispose]();

    await vi.waitFor(() => expect([queue.disposed, api.disposed]).toEqual([1, 1]));
  });

  it("releases the queue of a session that was refused the Admin API", async () => {
    const userObjectId = await connectAccount("ada");
    workshop.admins.delete("ada");
    await withFacet(userObjectId, async (facet) => {
      const queue = new Queue();
      const session = await openSession(facet, queue);
      await rejection(session.listUsers!());

      session[Symbol.dispose]();

      await vi.waitFor(() => expect(queue.disposed).toBe(1));
      expect(workshop.apis).toEqual([]);
    });
  });
});
