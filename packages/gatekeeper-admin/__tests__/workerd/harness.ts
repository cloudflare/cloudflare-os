// What the workerd suites share: connecting an account as the Workshop does, the gatekeeper's
// facet made as the overseer makes it, and the approval queue a session is given.

import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { RpcTarget, env } from "cloudflare:workers";
import type {
  AdminApiGrant, GatekeeperConnectCallback, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import handler, { type AdminGatekeeperImpl } from "../../src/admin.js";
import { workshop, type Observer, type TestExports } from "./worker.js";

/** The Worker's entrypoints, as the Workshop reaches them. */
export const exported = () => createExecutionContext().exports as unknown as TestExports;

/** A session's stub, as an agent's code sees it: the schema's methods, which its type can't name. */
export type Session = Disposable & Record<string, (...args: unknown[]) => Promise<any>>;

/**
 * What `call` rejects with. Settled through then() alone: `expect(...).rejects` reads other
 * properties of the RPC promise, each a pipelined promise of its own that rejects unhandled.
 */
export function rejection(call: Promise<unknown>): Promise<Error> {
  return call.then(() => new Error("did not reject"), (error: Error) => error);
}

/** Starts a connection for `user`, as UserDurableObject.connectAccount() does for an admin. */
export async function startConnection(user: string, label = user)
    : Promise<{ url: string; userObjectId: string }> {
  const worker = exported();
  const { url } = await worker.GatekeeperVendor({}).connectAccount(
      worker.TestConnectCallback({ props: { label } }) as unknown as Fetcher<GatekeeperConnectCallback>,
      { adminApi: worker.TestGrant({ props: { user } }) as unknown as Fetcher<AdminApiGrant> });
  return { url, userObjectId: new URL(url).pathname.split("/").at(-2)! };
}

/** Opens a connect link, as the popup does. */
export const visit = (url: string) =>
  handler.fetch(new Request(url), env, createExecutionContext());

/** A connected account of `user`, a deployment admin: the id of its UserAccount. */
export async function connectAccount(user: string): Promise<string> {
  workshop.admins.add(user);
  const { url, userObjectId } = await startConnection(user);
  const page = await visit(url);
  if (!(await page.text()).includes(`ticket-${user}`)) throw new Error("The connection did not complete");
  return userObjectId;
}

/** The account of `userObjectId`, as the Workshop holds it. */
export const accountOf = (userObjectId: string) =>
  exported().AdminAccount({ props: { userObjectId } });

/** `userObjectId`'s account as an observer named `id`. */
export async function observer(id: string, userObjectId: string): Promise<Observer> {
  return { id, verifier: await accountOf(userObjectId).getVerifier() };
}

let hosts = 0;

/**
 * Runs `body` inside a Durable Object with the facet of a connection made from the account
 * `userObjectId`, as the overseer makes one. What `body` holds stays inside it: a stub made in a
 * Durable Object cannot be used from outside.
 */
export function withFacet<T>(
  userObjectId: string, body: (facet: DurableObjectStub<AdminGatekeeperImpl>) => Promise<T>,
): Promise<T> {
  return runInDurableObject(env.TEST_HOST.getByName(`host-${++hosts}`), (_host, state) => {
    const worker = state.exports as unknown as TestExports;
    return body(state.facets.get<AdminGatekeeperImpl>("gatekeeper", () => ({
      class: worker.AdminGatekeeperImpl({ props: { userObjectId } }),
    })) as unknown as DurableObjectStub<AdminGatekeeperImpl>);
  });
}

/** The approval queue of one session: it records each observation, and can refuse them. */
export class Queue extends RpcTarget {
  readonly observations: ObservationDescription[] = [];
  refuseObservations = false;
  /** Runs while an observation waits to be authorized, as a collaborator's check would. */
  whileObserving: (() => Promise<void>) | undefined;
  disposed = 0;

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    workshop.log.push(`observe ${description.title}`);
    this.observations.push(description);
    await this.whileObserving?.();
    if (this.refuseObservations) throw new Error("The approval queue refused this observation.");
  }

  [Symbol.dispose](): void {
    this.disposed++;
  }
}

/** A session of `facet` over `queue`. */
export async function openSession(
  facet: DurableObjectStub<AdminGatekeeperImpl>, queue: Queue,
): Promise<Session> {
  return await facet.startSession(queue as never) as unknown as Session;
}
