// The one membrane between the admin gatekeeper and AdminApi. The gatekeeper Worker holds no
// power of its own: a workspace lends it the Admin API of its owner, for a session's reads or for
// the one call of an approved action (OverseerImpl.lendAdminApi()), and every call the Worker
// makes through what it was lent is decided here, before AdminApi's own checks run. No Durable
// Object is in this file: what is lent, to whom and from where is the workspace's to say.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_USER_METHODS, DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS,
  createAdminAccessError, type AdminApi,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_AGENT_ACTIONS, ADMIN_AGENT_KINDS, type AdminAgentAction,
} from "@gadgets/workshop-shared/admin-agent";
import type { AdminAgentApi, AdminAgentMethod } from "@gadgets/workshop-shared/admin-gatekeeper";
import { ADMIN_METHOD_ANSWERS } from "./admin-access";
import { isDeploymentAdmin } from "./auth/config";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.admin.agent");

/**
 * What a lent Admin API is for:
 *   - a session: its "read" methods, until `until` (a time in milliseconds: the session's
 *     queue fixes it when it is made) and while `live()` does not throw (the queue says
 *     whether the session is over). `opener` is the profile id of the collaborator who opened
 *     the session directly from the connection, outside any chat: such a session is lent
 *     nothing unless the opener is the owner, because its records would name the owner and
 *     leave no trace of who called;
 *   - an approved action of `kind`: ONE call, the one ADMIN_AGENT_ACTIONS names for it, with
 *     its visibility. `autoApproved` says the approval was a rule's, not a person's, and
 *     `decidedBy` is the profile id of whoever approved (the rule's enabler for a rule).
 */
export type AdminAgentUse =
  | { for: "session"; until: number; live(): void; opener?: string }
  | { for: "action"; kind: AdminAgentAction; autoApproved: boolean; decidedBy: string };

/** A lent Admin API and the switch that ends it: after `end()`, every call through `api`, and
 * through any view `api` returned, is refused. A view is only ever handed out behind the same
 * switch (see restrictAdminApi()), so there is no stub of it that `end()` does not reach. */
export type AdminAgentLend = { api: RpcStub<AdminAgentApi>; end(): void };

/**
 * Why `method` with `args` may not run under `use`, or undefined when it may. Pure: no clock, no
 * environment. A name that is not an AdminApi method, an "omitted" method, an "act" method in a
 * session, anything but the action's own call in an action (with its visibility, or with a
 * request's action being "grantContentAccess" exactly when the kind's `grantsContent` is true),
 * each has a message that names the method and says what to do instead. No argument is quoted.
 */
export function adminAgentRefusal(use: AdminAgentUse, method: string, args: readonly unknown[])
    : string | undefined {
  // An own key only: "constructor", "toString" and "__proto__" are not methods of the API.
  if (!Object.hasOwn(ADMIN_AGENT_KINDS, method)) return `AdminApi has no method ${method}.`;
  let kind = ADMIN_AGENT_KINDS[method as keyof typeof ADMIN_AGENT_KINDS];
  if (kind === "omitted") {
    return `AdminApi.${method}() is not available through the admin gatekeeper.`;
  }
  if (use.for === "session") {
    return kind === "act" ? `AdminApi.${method}() runs only as an approved action.` : undefined;
  }
  let action = ADMIN_AGENT_ACTIONS[use.kind];
  if (method !== action.method) return `This action may only call AdminApi.${action.method}().`;
  if (action.visibility !== undefined && args[2] !== action.visibility) {
    return `This action may only write a "${action.visibility}" entry.`;
  }
  if (action.grantsContent !== undefined &&
      (args[1] === "grantContentAccess") !== action.grantsContent) {
    return action.grantsContent ? "This action may only ask for access to content."
        : "A request for access to content is an action of its own.";
  }
  return undefined;
}

/** `args` of a session's inspectWorkspace() or inspectUser() with the view's life capped at what
 * the lend has left (`remainingMs`, at least a second): `lifetimeSeconds` becomes the smaller of what was
 * asked (DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS when absent) and the whole seconds left, rounded
 * up. Arguments it does not understand are returned untouched, for AdminApi to refuse. */
export function capViewLifetime(args: readonly unknown[], remainingMs: number): unknown[] {
  let options = args[2] === undefined ? {} : args[2];
  if (typeof options !== "object" || options === null || Array.isArray(options)) return [...args];
  let asked = (options as { lifetimeSeconds?: unknown }).lifetimeSeconds;
  if (asked !== undefined && typeof asked !== "number") return [...args];
  let left = Math.max(1, Math.ceil(remainingMs / 1000));
  let lifetimeSeconds = Math.min(asked ?? DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS, left);
  // The reason may be absent too: the options keep their place, for AdminApi to refuse the rest.
  return [args[0], args[1], { ...options, lifetimeSeconds }, ...args.slice(3)];
}

/** The "read" methods of AdminApi whose result is a capability (a view), by the type system:
 * today "inspectWorkspace" and "inspectUser". Data and a byte stream have no `dup()`; a stub
 * has. */
type AdminAgentViewMethod = {
  [M in AdminAgentMethod<"read">]:
      Awaited<ReturnType<AdminApi[M]>> extends { dup(): unknown } ? M : never
}[AdminAgentMethod<"read">];

// Does not compile unless AdminAgentViewMethod is exactly these two. An error here names what the
// conditional above picks: a method that returns a view needs its entry in the table below, and
// a view it fails to recognise would be handed out answering nothing.
type ViewMethods = "inspectWorkspace" | "inspectUser";
const VIEW_METHODS: [AdminAgentViewMethod] extends [ViewMethods]
    ? [ViewMethods] extends [AdminAgentViewMethod] ? true : never : never = true;
void VIEW_METHODS;

type AdminAgentViewTable = {
  answers(name: string): boolean;
  cap(args: readonly unknown[], remainingMs: number): unknown[];
};

/**
 * What the view each such method returns may do through the membrane: `answers(name)`, whether
 * the view answers a method of that name, and `cap(args, remainingMs)`, the method's arguments
 * with the view's life capped at what the lend has left. Keyed by EVERY "read" method that
 * returns a capability, so a method added to AdminApi that returns a view does not compile
 * until it has an entry here: its kind in ADMIN_AGENT_KINDS alone would hand out a view that
 * answers nothing, and reusing another view's table would answer by coincidence of names.
 */
export const ADMIN_AGENT_VIEWS = {
  inspectWorkspace: {
    // ADMIN_METHOD_ANSWERS does not compile until it names every AdminWorkspaceView method;
    // "inspectWorkspace" is its entry for the open, which is not a method of the view.
    answers: name => Object.hasOwn(ADMIN_METHOD_ANSWERS, name) && name !== "inspectWorkspace",
    cap: capViewLifetime,
  },
  inspectUser: {
    // ADMIN_USER_METHODS names the open, which is not a method of the view, and every
    // AdminUserView method: a view of an account answers with metadata alone.
    answers: name => name !== "inspectUser" &&
        (ADMIN_USER_METHODS as readonly string[]).includes(name),
    cap: capViewLifetime,
  },
} satisfies Record<AdminAgentViewMethod, AdminAgentViewTable>;

// Whether `value` is a capability rather than data. A view comes back from the workspace's
// Durable Object as a native stub (`instanceof RpcStub`); a target or a function returned in
// process would become a stub on its way to the gatekeeper, so both count.
function isCapability(value: unknown): boolean {
  if (typeof value === "function" || value instanceof RpcTarget) return true;
  return value instanceof RpcStub;
}

// What the membrane's stubs are stubs of: a target with no method of its own.
class Membrane extends RpcTarget {}

// A stub that answers every method name by `call(name, args)` and nothing else: no property, no
// symbol and no `then` (it is not a thenable). `released()` runs when its last holder lets go.
// Built as the Overseer's makeHookFiringCallback() is: every wildcard property of a stub is a
// function, a refusal is a rejection of that call rather than a throw into the RPC machinery,
// and the Proxy is wrapped in a stub because workerd judges a Proxy returned as an RpcTarget
// non-pipelineable.
function answerBy(call: (name: string, args: unknown[]) => Promise<unknown>,
                  released?: () => void): RpcStub<Membrane> {
  return new RpcStub(new Proxy(new Membrane(), {
    get(_target, name) {
      if (name === Symbol.dispose) return released;
      if (typeof name === "symbol" || name === "then") return undefined;
      return async (...args: unknown[]) => call(name, args);
    },
  }));
}

const NO_METHOD = () => false;

type Method = (...args: unknown[]) => unknown;

/**
 * `api` as the admin gatekeeper may use it under `use`: a target that answers only AdminApi's
 * method names and, before each call, checks in this order that the lend has not ended or run
 * out (a session's `until`; an action's one call already made), that `admin` is still a
 * deployment admin (refused `notAdmin`), that a session is still live, that the deployment has
 * not turned the gatekeeper off (`off()` resolves to whether it has), and that
 * adminAgentRefusal() allows the call; then makes the call on `api`, whose own validation and
 * checks run as for any caller. A capability the call returns (a view) is returned behind the
 * same checks and the table ADMIN_AGENT_VIEWS keeps for the METHOD THAT RETURNED IT: it
 * answers the names that entry allows and no other, so nothing of the stub underneath (`dup`
 * least of all) can be reached and the view ends with the lend. A capability returned by a
 * method that has no entry, or by a view call, answers no name at all. A session's call of a
 * method that has an entry is given at most the time the lend has left as the view's life
 * (the entry's `cap`), so the view itself does not outlive the lend either.
 * Throws at once, lending nothing, when `use` is an auto-approved action of a kind whose
 * verdict is false, or a session whose time has passed. It holds no state but whether it has
 * ended, for an action whether its call was made, and the views it returned, which `end()`
 * releases. It logs the lend, never a call.
 */
export function restrictAdminApi(api: AdminApi, env: Cloudflare.Env, admin: string,
    use: AdminAgentUse, off: () => Promise<boolean>, now: () => number = () => Date.now())
    : AdminAgentLend {
  if (use.for === "action" && use.autoApproved && !ADMIN_AGENT_ACTIONS[use.kind].autoApprovable) {
    throw new Error("This kind of action is never auto-approved.");
  }
  const SESSION_ENDED = "This Admin API session has ended. Open a new one.";
  if (use.for === "session" && now() >= use.until) throw new Error(SESSION_ENDED);
  let ended = false;
  let called = false;
  // What releases each view handed out and still held.
  let views = new Set<() => void>();

  // What every call passes first, through the API and through a view alike. It runs up to its
  // one await synchronously, so of two calls an action's holder starts together only the first
  // finds `called` unset; a call refused further down has spent the action's lend all the same.
  let check = async () => {
    if (use.for === "action") {
      if (called) throw new Error("This action has made its one call.");
      called = true;
    }
    if (ended || (use.for === "session" && now() >= use.until)) {
      throw new Error(SESSION_ENDED);
    }
    if (!isDeploymentAdmin(env, admin)) {
      throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    }
    if (use.for === "session") use.live();
    if (await off()) throw new Error("Gatekeeper is disabled.");
  };

  // `result` as the gatekeeper gets it: a capability behind the checks and `answers`, anything
  // else as it is. A stream is passed on unread. What a view's own call returns is classified
  // by no table, so it answers nothing.
  let handOver = (result: unknown, answers: (name: string) => boolean): unknown => {
    if (!isCapability(result)) return result;
    let view = result as Partial<Disposable> & Record<string, Method>;
    // Lets go of the view underneath, once: when the gatekeeper does, or when the lend ends.
    let release = () => {
      if (views.delete(release)) view[Symbol.dispose]?.();
    };
    views.add(release);
    if (ended) release();
    return answerBy(async (name, args) => {
      await check();
      // Nothing is forwarded for any other name: the view underneath is a stub, whose own
      // `dup()` would hand back a copy of it outside these checks.
      if (!answers(name)) throw new Error(`This view has no method ${name}.`);
      return handOver(await Reflect.apply(view[name], view, args), NO_METHOD);
    }, release);
  };

  let lent = answerBy(async (name, args) => {
    await check();
    let refusal = adminAgentRefusal(use, name, args);
    if (refusal !== undefined) throw new Error(refusal);
    let view = Object.hasOwn(ADMIN_AGENT_VIEWS, name)
        ? ADMIN_AGENT_VIEWS[name as AdminAgentViewMethod] : undefined;
    if (view && use.for === "session") args = view.cap(args, use.until - now());
    let result = await Reflect.apply(api[name as AdminAgentMethod], api, args);
    return handOver(result, view?.answers ?? NO_METHOD);
  });

  logger.info("admin API lent to the admin gatekeeper", {
    event: "admin.agent.lent", operation: use.for === "action" ? use.kind : use.for,
  });
  return {
    // The Proxy answers any name, so no type describes it: this one says what the checks above
    // let through, which is all the gatekeeper is told it holds.
    api: lent as RpcStub<AdminAgentApi>,
    end() {
      ended = true;
      for (let release of views) release();
    },
  };
}
