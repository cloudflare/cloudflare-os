// The sessions the admin binding opens, built from the Admin API's schema: one class per service,
// with one method per method of that service, each a forward to the Admin API the Workshop lent
// the session (or to a view that API returned). A session decides nothing: the Workshop checks
// and records each call where it lands.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { checkArguments } from "@gadgets/api-schema/check";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import { createLogger } from "@gadgets/observability/logger";
import {
  ADMIN_BINDING_SUBRESOURCE, ADMIN_GATEKEEPER_VENDOR_ID,
} from "@gadgets/workshop-shared/admin-agent";
import type { AdminAgentQueue } from "@gadgets/workshop-shared/admin-gatekeeper";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { ADMIN_SCHEMA, SERVICES, kindOf } from "./surface.js";

// Event names only: a call's arguments, its result and the Admin API's errors (which can quote an
// argument) are deployment admin data, kept in the workspace's activity and the audit log.
const logger = createLogger<{ vendorId: string }>({
  component: "gatekeeper.instanceadmin", vendorId: ADMIN_GATEKEEPER_VENDOR_ID,
});

/**
 * The subresource id of every observation made through the whole admin binding. The Workshop
 * reads this id to keep a workspace that read through the binding admins-only for good, so it is
 * the Workshop's constant and never a literal here.
 */
export const ADMIN_SUBRESOURCE = ADMIN_BINDING_SUBRESOURCE;

/** What every observation of one forwarder carries. */
export interface ForwarderOptions {
  /** Whether what it reads marks the workspace as holding restricted data. */
  restricted: boolean;
  /** The one subresource id that says which capability made the observation. */
  subresource: string;
}

/** A capability a forwarder forwards to: the lent Admin API, or a view it returned. */
type Target = RpcStub<RpcTarget>;

/** A session of the admin binding, or a view one of its calls returned. */
export type AdminSession = RpcTarget & Disposable;

/**
 * The class forwarderFor() returns. It owns what it is made with: the queue, and for a view the
 * view's stub, are released when it is disposed. The entry service takes no `target` (its
 * session is lent one by the queue); every other service takes the view to forward to.
 */
export type ForwarderClass =
    new (queue: RpcStub<AdminAgentQueue>, options: ForwarderOptions, target?: Target) => AdminSession;

/**
 * Queues the action of one "act" method of AdminApi, given the session's queue and the call's
 * arguments, which fit the schema.
 */
export type ActRoute = (queue: RpcStub<AdminAgentQueue>, args: readonly unknown[]) => Promise<void>;

/** The route of each "act" method of AdminApi, by name. A method with none is refused. */
export const ACT_ROUTES = new Map<string, ActRoute>();

const ROOT = ADMIN_SCHEMA.entry;

/** What a view of each service is a view of, as a workspace's activity says it. */
const VIEWED: Record<string, string> = {
  AdminWorkspaceView: "a workspace",
  AdminUserView: "a user's account",
};

/** What a workspace's activity records for one forwarded call, before the call is made. */
function describeCall(
  service: string, name: string, args: readonly unknown[], options: ForwarderOptions,
): ObservationDescription {
  const root = service === ROOT;
  const viewed = Object.hasOwn(VIEWED, service) ? ` of ${VIEWED[service]}` : "";
  const rendered = buildDescription(root
      ? `Call \`${name}()\` of this deployment's Admin API, as this workspace's owner.`
      : `Call \`${name}()\` of an admin's view${viewed}.`);
  // A trailing argument left out is not one the call was given.
  const given = args.slice(0, args.findLastIndex((arg) => arg !== undefined) + 1);
  if (given.length > 0) rendered.json("Arguments", given);
  const { description, fields } = rendered.finish();
  return {
    title: `${root ? "Admin API" : "Admin view"}: ${name}`,
    description,
    ...(fields ? { fields } : {}),
    subresources: [options.subresource],
    ...(options.restricted ? { containsRestrictedData: true } : {}),
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
  readonly #queue: RpcStub<AdminAgentQueue>;
  readonly #options: ForwarderOptions;
  /** What calls are forwarded to: a view's stub, or the lent Admin API once a read asked for it. */
  #target: Promise<Target> | undefined;

  constructor(
    service: string, queue: RpcStub<AdminAgentQueue>, options: ForwarderOptions, target?: Target,
  ) {
    super();
    if ((service === ROOT) !== (target === undefined)) {
      throw new Error(`A session of ${service} ${target ? "takes no" : "needs a"} capability to forward to.`);
    }
    this.#service = service;
    this.#queue = queue;
    this.#options = options;
    this.#target = target && Promise.resolve(target);
  }

  /**
   * The class that serves `service`: one prototype method per method of the service, where
   * Workers RPC exposes it. Defined inside this class body so each reaches #call, and neither
   * enumerable, writable nor configurable.
   */
  static serving(service: string, methods: readonly string[]): ForwarderClass {
    class Served extends Forwarder {
      constructor(queue: RpcStub<AdminAgentQueue>, options: ForwarderOptions, target?: Target) {
        super(service, queue, options, target);
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
   * The capability calls are forwarded to. A root session asks its queue for the owner's Admin
   * API on its first read and keeps the stub that resolved; a refusal is thrown and not kept, so
   * the next read asks again.
   */
  #lend(): Promise<Target> {
    return this.#target ??= this.#askForLend();
  }

  async #askForLend(): Promise<Target> {
    try {
      return await this.#queue.getAdminApi();
    } catch (error) {
      this.#target = undefined;
      logger.info("admin api was not lent", { event: "session.lend_refused" });
      throw error;
    }
  }

  /**
   * Checks the arguments, then routes an "act" call to its action and forwards any other: lent
   * first, observed second, called third. A method the schema says returns a view answers with a
   * forwarder over it, which observes as this one does.
   */
  async #call(name: string, args: unknown[]): Promise<unknown> {
    const service = this.#service;
    const problems = checkArguments(ADMIN_SCHEMA, service, name, args);
    if (problems.length > 0) {
      throw new TypeError(`Invalid arguments for ${service}.${name}: ${problems.join("; ")}`);
    }
    if (service === ROOT && kindOf(name) === "act") {
      const route = ACT_ROUTES.get(name);
      if (!route) throw new Error(`${service}.${name}() has no action defined for it.`);
      return route(this.#queue, args);
    }

    // The lend is awaited before anything is observed, and no read is pipelined through a
    // pending lend. An observation that says its read holds restricted data marks the workspace
    // for good, so it must not be made for a call the Workshop was never going to answer: a
    // session that is lent nothing reads nothing, and marks nothing.
    const target = await this.#lend();
    // Before the call, so a refused observation reads nothing and the workspace is marked before
    // any data leaves the Workshop. A call the Admin API then refuses has still been observed.
    await this.#queue.authorizeObservation(describeCall(service, name, args, this.#options));

    let result: unknown;
    try {
      result = await Reflect.apply(Reflect.get(target, name), target, args);
    } catch (error) {
      logger.warn("admin api call failed", { event: "session.call_failed" });
      throw error;
    }
    const returns = ADMIN_SCHEMA.services[service]!.methods.find((method) => method.name === name)!.returns;
    if (returns.kind === "stub") {
      // The view's forwarder owns the returned stub, and a queue of its own to observe through.
      return new (forwarderFor(returns.service!))(this.#queue.dup(), this.#options, result as Target);
    }
    // Anything else is returned as it is: a stream is never read here.
    return result;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
    // A lend that was refused left nothing to release.
    void this.#target?.then((target) => target[Symbol.dispose](), () => {});
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
