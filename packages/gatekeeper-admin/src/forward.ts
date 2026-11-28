// The sessions the admin binding opens, built from the Admin API's schema: one class per service,
// with one method per method of that service, each a forward to the Admin API the session opened
// from its account (or to a view that API returned). A session decides nothing: the Workshop
// checks and records each call where it lands.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { checkArguments } from "@gadgets/api-schema/check";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import { GLOBAL_SUBRESOURCE_ID } from "@gadgets/gatekeeper-kit/subresource-ids";
import { createLogger } from "@gadgets/observability/logger";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { ADMIN_SCHEMA, SERVICES } from "./surface.js";

// Event names only: a call's arguments, its result and the Admin API's errors (which can quote an
// argument) are deployment admin data, kept in the workspace's activity and the audit log.
const logger = createLogger<{ vendorId: string }>({
  component: "gatekeeper.admin", vendorId: "admin",
});

/**
 * The one access requirement of everything read through the admin binding: being a deployment
 * admin of this deployment, which each observer's own account answers (see
 * AdminGatekeeperImpl.verifyObserverAccess()). Connection-only access, as gatekeeper-kit's
 * USAGE.md has it: the deployment is the one instance every account connects to.
 */
export const ADMIN_SUBRESOURCE = GLOBAL_SUBRESOURCE_ID;

/** A capability a forwarder forwards to: the Admin API, or a view it returned. */
type Target = RpcStub<RpcTarget>;

/** A session of the admin binding, or a view one of its calls returned. */
export type AdminSession = RpcTarget & Disposable;

/** Opens the Admin API a session forwards to: the account's grant, asked now. */
export type OpenAdminApi = () => Promise<Target>;

/**
 * Refuses unless the account the connection was made from still holds its grant and its user is
 * a deployment admin now. A forwarder asks before every call it forwards and again before it
 * answers: the Admin API checks its admin when it is opened and a view knows nothing of the
 * account, so without this an open session would outlive a removed account, and its plain reads
 * a demotion.
 */
export type RequireAdmin = () => Promise<void>;

/**
 * What a forwarder forwards to. The entry service takes `open` (its session opens the Admin API
 * on first use); every other service takes the `view` an Admin API call returned.
 */
export type ForwarderSource = { open: OpenAdminApi } | { view: Target };

/**
 * The class forwarderFor() returns. It owns what it is made with: the queue, and for a view the
 * view's stub, are released when it is disposed.
 */
export type ForwarderClass = new (
  queue: RpcStub<ApprovalQueue>, requireAdmin: RequireAdmin, source: ForwarderSource,
) => AdminSession;

const ROOT = ADMIN_SCHEMA.entry;

/** What a view of each service is a view of, as a workspace's activity says it. */
const VIEWED: Record<string, string> = {
  AdminWorkspaceView: "a workspace",
  AdminUserView: "a user's account",
};

/**
 * A session's Admin API: opened on first use, and the stub that resolved is kept, so a session
 * makes its calls on one capability. A refusal is thrown and not kept, so the next use asks
 * again. What it opened is released when it is disposed.
 */
export class Opened {
  readonly #open: OpenAdminApi;
  #api: Promise<Target> | undefined;

  constructor(open: OpenAdminApi) {
    this.#open = open;
  }

  /** The Admin API. */
  get(): Promise<Target> {
    return this.#api ??= this.#ask();
  }

  async #ask(): Promise<Target> {
    try {
      return await this.#open();
    } catch (error) {
      this.#api = undefined;
      logger.info("admin api was not opened", { event: "session.open_refused" });
      throw error;
    }
  }

  [Symbol.dispose](): void {
    // An open that was refused left nothing to release.
    void this.#api?.then((api) => api[Symbol.dispose](), () => {});
  }
}

/** What a workspace's activity records for one forwarded call. */
function describeCall(service: string, name: string, args: readonly unknown[])
    : ObservationDescription & { subresources: string[] } {
  const root = service === ROOT;
  const viewed = Object.hasOwn(VIEWED, service) ? ` of ${VIEWED[service]}` : "";
  const rendered = buildDescription(root
      ? `Call \`${name}()\` of this deployment's Admin API, as the admin who connected it.`
      : `Call \`${name}()\` of an admin's view${viewed}.`);
  // A trailing argument left out is not one the call was given.
  const given = args.slice(0, args.findLastIndex((arg) => arg !== undefined) + 1);
  if (given.length > 0) rendered.json("Arguments", given);
  const { description, fields } = rendered.finish();
  return {
    title: `${root ? "Admin API" : "Admin view"}: ${name}`,
    description,
    ...(fields ? { fields } : {}),
    subresources: [ADMIN_SUBRESOURCE],
    containsRestrictedData: true,
  };
}

/**
 * One service of the Admin API's schema, served by forwarding each call.
 *
 * No @validateRpc(), the one exception to that rule here: a served class's methods come from the
 * schema at load, so its TypeScript type declares none of them and a validator built from it
 * would refuse them all. #call checks each call's arguments against the schema instead, and the
 * Workshop validates them again where the call lands.
 *
 * State lives in real private fields: RPC exposes an RpcTarget's properties as well as its
 * methods.
 */
class Forwarder extends RpcTarget {
  readonly #service: string;
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #requireAdmin: RequireAdmin;
  /** What calls are forwarded to: a view's stub, or the Admin API the session opens. */
  readonly #target: Target | Opened;

  constructor(
    service: string, queue: RpcStub<ApprovalQueue>, requireAdmin: RequireAdmin,
    source: ForwarderSource,
  ) {
    super();
    if ((service === ROOT) !== ("open" in source)) {
      throw new Error(`A session of ${service} ${service === ROOT
          ? "opens the Admin API itself" : "needs a view to forward to"}.`);
    }
    this.#service = service;
    this.#queue = queue;
    this.#requireAdmin = requireAdmin;
    this.#target = "open" in source ? new Opened(source.open) : source.view;
  }

  /**
   * The class that serves `service`: one prototype method per method of the service, where
   * Workers RPC exposes it. Defined inside this class body so each reaches #call, and neither
   * enumerable, writable nor configurable.
   */
  static serving(service: string, methods: readonly string[]): ForwarderClass {
    class Served extends Forwarder {
      constructor(
        queue: RpcStub<ApprovalQueue>, requireAdmin: RequireAdmin, source: ForwarderSource,
      ) {
        super(service, queue, requireAdmin, source);
      }
    }
    for (const name of methods) {
      Object.defineProperty(Served.prototype, name, {
        value: function (this: Forwarder, ...args: unknown[]) {
          return this.#call(name, args);
        },
      });
    }
    return Served;
  }

  /**
   * Checks the arguments and the account, then forwards the call: opened first, called second,
   * observed third, and only then answered. A method the schema says returns a view answers with
   * a forwarder over it, which checks and observes as this one does.
   */
  async #call(name: string, args: unknown[]): Promise<unknown> {
    const service = this.#service;
    const problems = checkArguments(ADMIN_SCHEMA, service, name, args);
    if (problems.length > 0) {
      throw new TypeError(`Invalid arguments for ${service}.${name}: ${problems.join("; ")}`);
    }
    await this.#requireAdmin();
    const target = this.#target instanceof Opened ? await this.#target.get() : this.#target;

    let result: unknown;
    try {
      result = await Reflect.apply(Reflect.get(target, name), target, args);
    } catch (error) {
      logger.warn("admin api call failed", { event: "session.call_failed" });
      throw error;
    }
    const returns = ADMIN_SCHEMA.services[service]!.methods.find((method) => method.name === name)!.returns;
    // A method the schema says returns a view is served by that view's forwarder.
    const viewClass = returns.kind === "stub" ? forwarderFor(returns.service!) : undefined;
    try {
      // After the call, so one the Admin API refused observes nothing: an observation that says
      // its read holds restricted data marks the workspace for good, and a refusal read nothing.
      // Before anything is answered, so a refused observation hands the caller nothing.
      await this.#queue.authorizeObservation(describeCall(service, name, args));
      // Asked again: an observation can wait on collaborators' checks, and an account removed
      // or an admin demoted meanwhile is handed nothing either.
      await this.#requireAdmin();
    } catch (error) {
      if (viewClass) (result as Target)[Symbol.dispose]();
      throw error;
    }
    if (viewClass) {
      // The view's forwarder owns the returned stub, and a queue of its own to observe through.
      return new viewClass(this.#queue.dup(), this.#requireAdmin, { view: result as Target });
    }
    // Anything else is returned as it is: a stream is never read here.
    return result;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
    this.#target[Symbol.dispose]();
  }
}

const FORWARDERS: ReadonlyMap<string, ForwarderClass> = new Map(
  [...SERVICES].map(([service, methods]) => [service, Forwarder.serving(service, methods)]),
);

/**
 * The session class of `service`, a service of ADMIN_SCHEMA: an RpcTarget with one method per
 * method of the service, defined at load.
 */
export function forwarderFor(service: string): ForwarderClass {
  const forwarder = FORWARDERS.get(service);
  if (!forwarder) throw new Error(`The Admin API schema has no service ${service}.`);
  return forwarder;
}
