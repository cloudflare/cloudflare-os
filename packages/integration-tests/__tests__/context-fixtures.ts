// The real Context Library gatekeeper as the integration suites boot it: this tree's build, or the
// release before this one for the suite that upgrades it in place, plus the accounts and workspaces
// those suites read collections through.

import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import type { ContextApi, ContextLibrary } from "../../gatekeeper-context/src/context-types.js";
import { upgradeBaseDir } from "../scripts/build-upgrade-base.js";
import { readWorkerConfig, redeployWorker, type GatekeeperSpec, type Harness } from "../src/harness.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, signUp, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";

const CONTEXT_DIR = fileURLToPath(new URL("../../gatekeeper-context/", import.meta.url));
const UPGRADE_BASE_DIR = upgradeBaseDir("gatekeeper-context");
export const CONTEXT_VENDOR_ID = "context";
export const DOCUMENT_PATH = "plan.md";
export const DOCUMENT = { description: "Owner-only launch plan", body: "Launch code: private-context." };

/** This tree's gatekeeper-context, from the validated tree the task graph builds before any suite. */
export function contextGatekeeper(): GatekeeperSpec {
  return { binding: "CONTEXT", dir: CONTEXT_DIR, patch: config => { delete config.build; } };
}

/** gatekeeper-context as the release before this one shipped it: the bundle `build:upgrade-base` leaves. */
export function baseContextGatekeeper(): GatekeeperSpec {
  return {
    binding: "CONTEXT",
    dir: UPGRADE_BASE_DIR,
    patch: config => {
      delete config.build;
      config.main = join(UPGRADE_BASE_DIR, "bundle/index.js");
    },
  };
}

/** Deploy this tree's gatekeeper-context over the running one, keeping its storage. */
export async function upgradeContext(harness: Harness): Promise<void> {
  const config = readWorkerConfig(CONTEXT_DIR);
  delete config.build;
  await redeployWorker(harness, config);
}

export type ContextUser = Disposable & {
  username: string;
  api: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  context: RpcStub<ContextApi>;
};

/**
 * `username` signed in, with their Context account and its management API. A new user signs up and
 * provisions the account; an existing one, after a redeploy broke their sessions, logs in again.
 */
export async function contextUser(harness: Harness, username: string, existing = false)
    : Promise<ContextUser> {
  using stack = new DisposableStack();
  const connection = stack.use(connect(harness.url));
  const api = stack.use(existing ? await logIn(connection, username) : await signUp(connection, username));
  if (!existing) await api.provisionAmbientAccount(CONTEXT_VENDOR_ID);
  const account = await waitFor("the Context account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(entry => entry.vendorId === CONTEXT_VENDOR_ID) ?? null);
  const frame = await api.getGatekeeperApp(CONTEXT_VENDOR_ID);
  if (frame === null) throw new Error("The Context management app is unavailable");
  const context = stack.use(frame.ui as unknown as RpcStub<ContextApi>);
  return Object.assign(stack.move(), { username, api, account, context });
}

export function newContextUser(harness: Harness, prefix: string): Promise<ContextUser> {
  const [username] = nextUsernames(prefix);
  if (username === undefined) throw new Error("Missing test username");
  return contextUser(harness, username);
}

/** A session on `workspace`'s ambient Context binding. */
export async function contextSession(workspace: RpcStub<Overseer>) {
  using stack = new DisposableStack();
  const requirement = await waitFor("the workspace's ambient Context binding", async () =>
    (await workspace.listObserverRequirements("build"))
      .find(entry => entry.vendorId === CONTEXT_VENDOR_ID) ?? null);
  const binding = stack.use(await workspace.getGatekeeperById(requirement.gatekeeperId));
  const session = stack.use(await binding.openSession() as RpcStub<ContextLibrary>);
  return Object.assign(stack.move(), { session });
}

/** A new workspace of `owner`'s, with a private collection holding DOCUMENT and a session to read it. */
export async function privateWorkspace(owner: ContextUser) {
  using stack = new DisposableStack();
  const collection = await owner.context.createContextCollection(
    `${owner.username} private collection`, "Private discovery metadata", "private");
  await owner.context.putContextDocument(collection.id, DOCUMENT_PATH, DOCUMENT);
  const workspace = stack.use(await owner.api.newWorkspace());
  const { id: workspaceId } = await workspace.getMetadata();
  const { session } = stack.use(await contextSession(workspace));
  return Object.assign(stack.move(), {
    collection, workspace, workspaceId, session, docId: `${collection.id}/${DOCUMENT_PATH}`,
  });
}
