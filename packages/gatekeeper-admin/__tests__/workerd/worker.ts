// Test worker for the workerd suite. Re-exports the production entrypoints so the pool can bind
// the Durable Objects, and adds the Workshop's side of the gatekeeper, faked: the Admin API grant
// an account stores, the connect callback, and a Durable Object for the facet to live in.
//
// A `DurableObjectClass` from `ctx.exports.X({props})` is only reachable through `ctx.facets`,
// which is the same way the overseer instantiates a gatekeeper in production: hence TestHost.

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ConnectHandoff, GatekeeperUser, GatekeeperUserVerifier,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  AdminAccount, AdminGatekeeperImpl, AdminVerifier, GatekeeperVendor,
} from "../../src/admin.js";
import { SERVICES } from "../../src/surface.js";

export { default } from "../../src/admin.js";
// Named one by one: the pool derives `ctx.exports` from this module's own declarations, which an
// `export *` is not.
export {
  AdminAccount, AdminGatekeeperImpl, AdminVerifier, GatekeeperVendor, UserAccount,
} from "../../src/admin.js";

export const ROOT = "AdminApi";
export const VIEW = "AdminWorkspaceView";
export const USER_VIEW = "AdminUserView";
/** The view each open of the Admin API returns. */
const OPENS: Record<string, string> = { inspectWorkspace: VIEW, inspectUser: USER_VIEW };

type AccountProps = { userObjectId: string };

/** What the suite reaches through `ctx.exports`. */
export type TestExports = {
  GatekeeperVendor(options: object): Fetcher<GatekeeperVendor>;
  AdminAccount(options: { props: AccountProps }): Fetcher<AdminAccount>;
  AdminVerifier(options: { props: AccountProps }): Fetcher<AdminVerifier>;
  AdminGatekeeperImpl(options: { props: AccountProps }): DurableObjectClass<AdminGatekeeperImpl>;
  TestGrant(options: { props: { user: string } }): Fetcher<TestGrant>;
  TestConnectCallback(options: { props: { label: string } }): Fetcher<TestConnectCallback>;
};

/** A target with one method per name, each recording its call and answering with `answer`. */
export function recordingTarget(service: string, names: readonly string[],
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
        workshop.log.push(`${service}.${name}`);
        this.calls.push({ name, args });
        return answer(name, args);
      },
    });
  }
  return new Recording();
}

export type Recording = ReturnType<typeof recordingTarget>;

/**
 * The Workshop, as the fakes below stand in for it. The suite runs in this Worker's isolate, so
 * it reads and resets this state directly.
 */
export const workshop = {
  /** Who is a deployment admin now. */
  admins: new Set<string>(),
  /** What the fakes saw, in order: "open <user>", "observe <title>", "submit <tag>" and
   * "<service>.<method>". */
  log: [] as string[],
  /** Every Admin API a grant opened, and every view those opened, oldest first. */
  apis: [] as Recording[],
  views: [] as Recording[],
  /** Errors an Admin API method throws, by name, and the grant's open() under "open". */
  failures: new Map<string, Error>(),
  /** The label of every connect callback that was told its connection completed. */
  completed: [] as string[],
  /** Runs inside a grant's isAdmin() before it answers, as another request may meanwhile. */
  whileAsked: undefined as (() => Promise<unknown>) | undefined,

  reset(): void {
    this.admins.clear();
    this.log.length = 0;
    this.apis.length = 0;
    this.views.length = 0;
    this.failures.clear();
    this.completed.length = 0;
    this.whileAsked = undefined;
  },
};

/** What the suite's grant refuses to open for a user who is no deployment admin with. */
export const NOT_ADMIN = "The grant's user is not a deployment admin.";

/** Stands in for the AdminApiGrant the Workshop hands over when `user` connects the gatekeeper. */
export class TestGrant extends WorkerEntrypoint<Cloudflare.Env, { user: string }> {
  async isAdmin(): Promise<boolean> {
    await workshop.whileAsked?.();
    return workshop.admins.has(this.ctx.props.user);
  }

  async open(): Promise<Recording> {
    const { user } = this.ctx.props;
    workshop.log.push(`open ${user}`);
    const refusal = workshop.failures.get("open");
    if (refusal) throw refusal;
    if (!workshop.admins.has(user)) throw new Error(NOT_ADMIN);
    // The omitted names are served too, so a call that reached them would be seen.
    const api = recordingTarget(ROOT, [...SERVICES.get(ROOT)!, "setSiteName", "getUpdateStatus"],
        (name) => {
          const failure = workshop.failures.get(name);
          if (failure) throw failure;
          if (!Object.hasOwn(OPENS, name)) return { answered: name };
          const service = OPENS[name]!;
          const view = recordingTarget(service, SERVICES.get(service)!, (method) => ({ answered: method }));
          workshop.views.push(view);
          return view;
        });
    workshop.apis.push(api);
    return api;
  }
}

/** Stands in for the Workshop's connect callback. */
export class TestConnectCallback extends WorkerEntrypoint<Cloudflare.Env, { label: string }> {
  async complete(account: Fetcher<GatekeeperUser>): Promise<ConnectHandoff> {
    const { label } = this.ctx.props;
    // The account is the one the Workshop would persist: it must answer.
    await account.describe();
    workshop.completed.push(label);
    return { targetOrigin: "https://workshop.example", ticket: `ticket-${label}` };
  }
}

/** A Durable Object for a test to make the gatekeeper's facet in (see inHost() in the suite). */
export class TestHost extends DurableObject<Cloudflare.Env> {}

/** An observer as the Workshop names one to verifyObserverAccess(). */
export type Observer = { id: string; verifier: Fetcher<GatekeeperUserVerifier> };
