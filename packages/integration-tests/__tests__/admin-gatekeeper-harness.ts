// What the admin gatekeeper suite uses: the real gatekeeper booted beside the Workshop, three
// deployment admins, and the steps every case repeats (connect an account, add the connection to
// a workspace, run an agent's turn whose code uses it).

import { fileURLToPath, URL } from "node:url";
import type { RpcStub } from "capnweb";
import {
  getAdminAccessErrorCode, getAdminGrantErrorCode, getOpenWorkspaceErrorCode,
  type ActionLogEntry, type AdminApi, type AdminAuditRecord, type AdminContentRequest,
  type AdminWriteRecord, type AiChatAuthorInfo, type AiModelConfig, type AuthenticatedApi,
  type ChatMessageOptions, type GatekeeperClient, type Overseer, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { loadAllChatHistory } from "../src/agent-session.js";
import {
  ADMIN_USERNAME, startHarness, type GatekeeperSpec, type Harness, type WorkerConfig,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE, scriptedChatCompletions,
  type ChatCompletionStep,
} from "../src/mock-model.js";
import type { Handler } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, MAX_OBSERVER_PROMPTS, nextUsernames,
  ObserverConfigRecorder, signUp, stubFor, waitFor, waitForIdleChat, type ConnectedAccount,
} from "../src/rpc-client.js";

/** The vendor id the Workshop derives from the gatekeeper's service binding. */
export const VENDOR = "admin";
/** The gatekeeper's Worker, as the harness names it. */
const ADMIN_GATEKEEPER_WORKER = "gatekeeper-admin";
/** The one resource of an admin gatekeeper account. */
export const DEPLOYMENT_URL = "admin://deployment";
/** The admin who owns the triage workspaces. */
export const OWNER = ADMIN_USERNAME;
/** A second admin, who collaborates in the owner's workspaces. */
export const GRACE = "grace";
/** A third admin, who never connects the gatekeeper. */
export const HEIDI = "heidi";

const ADMIN_GATEKEEPER_DIR = fileURLToPath(new URL("../../gatekeeper-admin/", import.meta.url));

/** The real admin gatekeeper, booted from its prebuilt validated tree. */
export function adminGatekeeper(): GatekeeperSpec {
  return {
    binding: "ADMIN",
    dir: ADMIN_GATEKEEPER_DIR,
    // The task graph builds this tree before any test file boots a Worker.
    patch: config => { delete config.build; },
  };
}

/**
 * A Workshop patch whose deployment has `admins` as its admins, lets them read content where a
 * grant is live, and takes writes to workspaces.
 */
export const withAdmins = (admins: string[] = [OWNER, GRACE, HEIDI]) => (config: WorkerConfig) => {
  config.vars = {
    ...config.vars, ADMINS: admins, ADMIN_WORKSPACE_ACCESS_MAX: "content",
    ADMIN_WORKSPACE_WRITES: "on",
  };
};

/** The Workshop and the admin gatekeeper, with gadget execution: every suite runs agent code. */
export function startAdminHarness(gatekeepers: GatekeeperSpec[] = []): Promise<Harness> {
  return startHarness({
    gatekeepers: [adminGatekeeper(), ...gatekeepers],
    patchWorkshop: withAdmins(),
    enableGadgetExecution: true,
  });
}

const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
/** What a message carries to say which scripted turn it starts. */
const TURN_MARKER = /#turn\d+#/g;

/** One scripted turn: the steps the model answers the turn's requests with, in order. */
export type TurnScript = {
  /** Put in the message that starts the turn: the model finds the turn's steps by it. */
  marker: string;
  /** The model requests the turn has made so far. */
  requests: unknown[];
  /** True once every step has been served: the turn ran to its end. */
  done(): boolean;
};

/**
 * A scripted model that finds what to answer in the request itself, so that turns can overlap.
 *
 * `scriptedModelRouter()` answers a model's requests from one queue, in the order they arrive.
 * These suites leave a turn paused on an action while another chat runs, and let a gadget spawn
 * an agent while its own turn is open, so the order of requests is not the order of the script.
 * Here the message that starts a turn carries a marker, and a request is answered with the step
 * that follows the turn's last one: as many steps in as the request holds replies of the model
 * after that message.
 */
export function turnModels(): {
  handler: Handler;
  model: { profile: AiChatAuthorInfo; config: AiModelConfig };
  turn(steps: readonly ChatCompletionStep[]): TurnScript;
} {
  const turns = new Map<string, { steps: readonly ChatCompletionStep[]; script: TurnScript; served: number }>();
  return {
    model: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    async handler(url, method, headers, request) {
      if (method !== "POST" || !url.pathname.endsWith(CHAT_COMPLETIONS_SUFFIX)) return null;
      const body = await request.clone().json() as { messages?: { role: string; content?: unknown }[] };
      const messages = body.messages ?? [];
      let marker: string | undefined;
      let startedAt = -1;
      for (const [index, message] of messages.entries()) {
        const named = message.role === "user" &&
            JSON.stringify(message.content ?? "").match(TURN_MARKER)?.at(-1);
        if (named) [marker, startedAt] = [named, index];
      }
      const turn = marker === undefined ? undefined : turns.get(marker);
      const step = turn?.steps[
          messages.slice(startedAt + 1).filter(message => message.role === "assistant").length];
      // The shared script answers a title or naming request itself and leaves the step unused; a
      // request no turn expects finds no step, and fails there.
      const answer = scriptedChatCompletions(step ? [step] : []);
      const response = await answer.handler(url, method, headers, request);
      if (turn && step && answer.remainingSteps() === 0) {
        turn.served++;
        turn.script.requests.push(body);
      }
      return response;
    },
    turn(steps) {
      const marker = `#turn${turns.size + 1}#`;
      const script: TurnScript = {
        marker, requests: [], done: () => turns.get(marker)!.served === steps.length,
      };
      turns.set(marker, { steps, script, served: 0 });
      return script;
    },
  };
}

/** A signed-in user, whose chats run the suite's scripted model. */
export type SuiteUser = {
  name: string;
  api: RpcStub<AuthenticatedApi>;
  models: ReturnType<typeof turnModels>;
};

/** The suite's Workshop, its models, and what it disposes at the end. */
export type Suite = {
  harness: Harness;
  models: ReturnType<typeof turnModels>;
  scope: DisposableStack;
};

/** Signs `name` up, with a scripted model. */
export async function newUser(suite: Suite, name: string, displayName?: string)
    : Promise<SuiteUser> {
  const api = suite.scope.use(
      await signUp(suite.scope.use(connect(suite.harness.url)), name, displayName));
  const { profile, config } = suite.models.model;
  await api.addModel(profile, config);
  return { name, api, models: suite.models };
}

/** A fresh user who is no admin, named after `prefix`. */
export async function newMember(suite: Suite, prefix: string): Promise<SuiteUser> {
  const [name] = nextUsernames(prefix);
  return newUser(suite, name!);
}

/**
 * `user` on a connection of their own. Every workspace these suites open is opened on one: a
 * workspace that restarts (when a collaborator is removed, say) ends each session that held it,
 * and that must not take the user's other capabilities with it.
 */
export async function reconnect(suite: Suite, user: SuiteUser): Promise<RpcStub<AuthenticatedApi>> {
  return suite.scope.use(await logIn(suite.scope.use(connect(suite.harness.url)), user.name));
}

/** `user` signed in again, after a redeploy ended every session. */
export async function signedInAgain(suite: Suite, user: SuiteUser): Promise<SuiteUser> {
  return { ...user, api: await reconnect(suite, user) };
}

/** The Admin API of `user`, who must be a deployment admin. */
export async function adminApiOf(suite: Suite, user: SuiteUser): Promise<RpcStub<AdminApi>> {
  const admin = await user.api.getAdminApi();
  if (admin === null) throw new Error(`The Admin API was unavailable to ${user.name}`);
  return suite.scope.use(admin);
}

/** The user's accounts of the admin gatekeeper, as the Gatekeepers page reads them. */
export async function adminAccounts(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount[]> {
  return (await listConnectedAccounts(api)).filter(account => account.vendorId === VENDOR);
}

/**
 * Connects the admin gatekeeper for `user` as the Gatekeepers page does: the connect flow, the
 * popup's visit to the gatekeeper's link, and the handoff the popup redeems. Returns the account.
 */
export async function connectAdminAccount(suite: Suite, user: SuiteUser): Promise<ConnectedAccount> {
  const { url, nonce } = await user.api.connectAccount(VENDOR);
  const page = await suite.harness.fetchWorker(ADMIN_GATEKEEPER_WORKER, url);
  const ticket = /var ticket = (".*?");\n/.exec(await page.text());
  if (ticket === null) throw new Error("The gatekeeper's connect page carried no handoff");
  await user.api.completeConnectHandoff(JSON.parse(ticket[1]!), nonce);
  return waitFor(`${user.name}'s admin gatekeeper account`, async () =>
    (await adminAccounts(user.api))[0] ?? null);
}

/** A workspace's admin connection: its workpiece id, and what a chat needs to name it. */
export type AdminConnection = {
  id: WorkpieceId;
  client: RpcStub<GatekeeperClient<any>>;
  description: ResourceDescription;
};

/** Adds the admin connection to `ws` with the account `accountId`. */
export async function addAdminConnection(ws: RpcStub<Overseer>, accountId: number)
    : Promise<AdminConnection> {
  const client = await ws.newGatekeeper(accountId, DEPLOYMENT_URL);
  if (client === null) throw new Error("The admin connection was not added");
  return { id: await client.getId(), client, description: await client.describe() };
}

/** A workspace of `user`, titled so that the admins' directory lists it under a known name. */
export async function newWorkspace(suite: Suite, user: SuiteUser, title: string)
    : Promise<{ ws: RpcStub<Overseer>; id: string }> {
  const ws = suite.scope.use(await (await reconnect(suite, user)).newWorkspace());
  await ws.setTitle(title);
  return { ws, id: (await ws.getMetadata()).id };
}

/** Whether the workspace is marked as holding restricted data. */
export async function isRestricted(ws: RpcStub<Overseer>): Promise<boolean> {
  return (await ws.getMetadata()).containsRestrictedData === true;
}

/**
 * What one `attempt()` of a turn's code left: the call's answer, or the message it was refused
 * with. A refusal's code does not cross into an agent's code, so a coded refusal is known there
 * by its message, which is as stable as its code.
 */
export type Attempt = { value?: unknown; error?: string };

/**
 * A turn's code: `body` runs with `env`, `self`, `restore` and `attempt(name, fn)`, which records under
 * `name` what `fn` resolved to or how it rejected. A name on an RPC stub is always callable, so a
 * method an agent must not have is shown by calling it.
 */
export const agentCode = (body: string) => `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  const out = {};
  const attempt = async (name, fn) => {
    try {
      const value = await fn();
      out[name] = { value: value === undefined ? null : value };
    } catch (error) {
      out[name] = { error: String(error && error.message || error) };
    }
  };
  ${body}
  console.log("RESULT:" + JSON.stringify(out));
}`;

const RESULT = /RESULT:(\{.*\})/;
let callSeq = 0;

/** What each run of agentCode() in the chat recorded, oldest first. */
export async function codeResults(ws: RpcStub<Overseer>, chatId: number)
    : Promise<Record<string, Attempt>[]> {
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  return history.flatMap(entry => entry.type === "message" ? entry.toolCalls ?? [] : [])
      .flatMap(call => {
        const match = call.toolName === "executeCode" ? RESULT.exec(call.output ?? "") : null;
        return match ? [JSON.parse(match[1]!) as Record<string, Attempt>] : [];
      });
}

/** The executeCode step of a script, running `body` (see agentCode()). */
export const codeStep = (body: string) => ({
  toolCall: { id: `code-${++callSeq}`, name: "executeCode", arguments: { code: agentCode(body) } },
});

/** One turn of a scripted agent. */
export type Turn = {
  chatId: number;
  script: TurnScript;
  /** True while the turn's code waits on an action nobody has decided. */
  paused(): boolean;
  /** What the turn's code recorded, once it has run to its end. */
  results(): Promise<Record<string, Attempt>>;
  /** Waits for the turn to end, once the action it paused on was decided, and returns results(). */
  resumed(): Promise<Record<string, Attempt>>;
};

/**
 * Starts one turn in `ws` as `user`, answered with `steps`. With `connection` the message names
 * it, which puts it in the chat's env as `ADMIN`, the name the gatekeeper suggests. With no
 * `chatId` the turn starts a chat. Resolves once the turn has ended or paused.
 */
export async function scriptedTurn(
    user: SuiteUser, ws: RpcStub<Overseer>, steps: readonly ChatCompletionStep[],
    options: { chatId?: number; connection?: AdminConnection } = {})
    : Promise<{ chatId: number; script: TurnScript }> {
  const script = user.models.turn(steps);
  const message = `${script.marker} ${options.connection ? "Use [0]." : "Go on."}`;
  const sent: ChatMessageOptions | undefined = options.connection && { capsules: [{
    position: message.indexOf("[0]"), length: "[0]".length, gatekeeperId: options.connection.id,
    description: options.connection.description, vendorId: VENDOR,
  }] };
  let chatId = options.chatId;
  if (chatId === undefined) chatId = await ws.newChat(message, SCRIPTED_MODEL_ID, sent);
  else await ws.sendChatMessage(chatId, message, SCRIPTED_MODEL_ID, sent);
  await waitFor("the turn's first step to be asked for", async () => script.requests.length >= 1 || null);
  await waitForIdleChat(ws, chatId);
  return { chatId, script };
}

/**
 * Runs one turn in `ws` as `user`, whose agent runs `body` (see agentCode()), as scriptedTurn()
 * starts one.
 */
export async function agentTurn(
    user: SuiteUser, ws: RpcStub<Overseer>, body: string,
    options: { chatId?: number; connection?: AdminConnection } = {}): Promise<Turn> {
  const { chatId: chat, script } = await scriptedTurn(
      user, ws, [codeStep(body), { text: "Done." }], options);

  const results = async () => {
    const outputs = await codeResults(ws, chat);
    if (outputs.length === 0) throw new Error("The turn's code left no result");
    return outputs.at(-1)!;
  };
  return {
    chatId: chat,
    script,
    paused: () => !script.done(),
    results,
    async resumed() {
      await waitFor("the turn to end", async () => script.done() || null);
      await waitForIdleChat(ws, chat);
      return results();
    },
  };
}

/** The titles of the workspace's observations, newest first. */
export async function observationTitles(ws: RpcStub<Overseer>): Promise<string[]> {
  return (await ws.listActions({ filter: "observation" })).entries
      .map(entry => entry.description.title);
}

/** The audit log's records, newest first, as `admin` lists them. */
export async function auditRecords(
    admin: RpcStub<AdminApi>, query: Parameters<AdminApi["listAdminAudit"]>[0] = {})
    : Promise<AdminAuditRecord[]> {
  const found: AdminAuditRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await admin.listAdminAudit({ limit: 200, ...query, cursor });
    found.push(...page.records);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found;
}

/** The vendors of a workspace's connections, read through an audited view as `admin`. */
export async function connectionVendors(admin: RpcStub<AdminApi>, workspaceId: string)
    : Promise<(string | undefined)[]> {
  using view = await admin.inspectWorkspace(workspaceId, "Checking the workspace's connections");
  return (await view.listGatekeepers()).map(connection => connection.vendorId);
}

/**
 * Opens `workspaceId` as `user`, redeeming `shareKey` when given, and answering the observer step
 * with `accountId` when given: with none, an open that reaches that step fails there. The caller
 * disposes the workspace.
 */
export async function openAs(
    suite: Suite, user: SuiteUser, workspaceId: string,
    options: { shareKey?: string; accountId?: number } = {}): Promise<RpcStub<Overseer>> {
  const recorder = new ObserverConfigRecorder();
  if (options.accountId !== undefined) {
    recorder.alwaysChoose(options.accountId, MAX_OBSERVER_PROMPTS);
  }
  using callback = stubFor(recorder);
  const api = await reconnect(suite, user);
  return await api.openWorkspace(workspaceId, options.shareKey, callback);
}

/**
 * How opening `workspaceId` ends for `user`: "opened", the code of an expected refusal, or the
 * message of any other.
 */
export async function opening(
    suite: Suite, user: SuiteUser, workspaceId: string,
    options: { shareKey?: string; accountId?: number } = {}): Promise<string> {
  try {
    (await openAs(suite, user, workspaceId, options))[Symbol.dispose]();
    return "opened";
  } catch (error) {
    return getOpenWorkspaceErrorCode(error) ?? (error instanceof Error ? error.message : String(error));
  }
}

/**
 * What the observer step asks of `user`, who opens `workspaceId` and has no account to answer it
 * with: the vendor of each connection it wants an account for, and how the open then ends.
 */
export async function observerStep(suite: Suite, user: SuiteUser, workspaceId: string)
    : Promise<{ asked: string[]; outcome: string }> {
  const recorder = new ObserverConfigRecorder();
  for (let prompt = 0; prompt < MAX_OBSERVER_PROMPTS; prompt++) recorder.respondWith(() => []);
  using callback = stubFor(recorder);
  const api = await reconnect(suite, user);
  let outcome = "opened";
  try {
    (await api.openWorkspace(workspaceId, undefined, callback))[Symbol.dispose]();
  } catch (error) {
    outcome = getOpenWorkspaceErrorCode(error) ?? (error instanceof Error ? error.message : String(error));
  }
  return { asked: (recorder.calls[0] ?? []).map(need => need.vendorId), outcome };
}

/** The profile ids of everyone the workspace is shared with. */
export async function collaboratorIds(ws: RpcStub<Overseer>): Promise<string[]> {
  return (await ws.listCollaborators()).map(collaborator => collaborator.profile.id);
}

/** The tag of each of the gatekeeper's action kinds. */
export const TAGS = {
  workspaceWriteRequest: "workspace-write-request",
  contentAccessRequest: "content-access-request",
} as const;

/** An action of the workspace's log. */
export type ActionEntry = ActionLogEntry & { type: "action" };

/** The workspace's actions of the admin gatekeeper, oldest first. */
export async function adminActions(ws: RpcStub<Overseer>, filter?: "pending")
    : Promise<ActionEntry[]> {
  const { entries } = await ws.listActions(filter ? { filter } : { filter: "action" });
  return entries.filter((entry): entry is ActionEntry =>
    entry.type === "action" &&
        Object.values(TAGS).includes(entry.description.actionKind?.tag as never))
      .toSorted((a, b) => a.id - b.id);
}

/** Waits until the workspace has `count` pending actions of the admin gatekeeper. */
export function pendingActions(ws: RpcStub<Overseer>, count: number): Promise<ActionEntry[]> {
  return waitFor(`${count} pending admin action(s)`, async () => {
    const pending = await adminActions(ws, "pending");
    return pending.length === count ? pending : null;
  });
}

/**
 * Time for the workspace to have applied an action it would apply unasked: the drain runs after
 * the submit returns. A case that asserts an action was NOT applied waits this long first.
 */
export async function settle(ws: RpcStub<Overseer>): Promise<void> {
  await ws.listActions();
  await new Promise(resolve => setTimeout(resolve, 400));
}

/**
 * `api`'s admin's approval of the content access request `requestId`: the request as the approval
 * left it, or the code the approval is refused with.
 */
export async function approveContent(api: RpcStub<AdminApi>, requestId: string)
    : Promise<AdminContentRequest | string> {
  try {
    return await api.approveContentAccess(requestId);
  } catch (error) {
    const code = getAdminGrantErrorCode(error) ?? getAdminAccessErrorCode(error);
    if (code === undefined) throw error;
    return code;
  }
}

/** Waits until the admins' directory lists the workspace: content is requested only for one. */
export async function listed(admin: RpcStub<AdminApi>, owner: string, workspaceId: string)
    : Promise<void> {
  await waitFor("the workspace to be listed", async () =>
    (await admin.listWorkspaces({ owner })).workspaces
        .some(workspace => workspace.id === workspaceId) || null);
}

/** The content access requests filed for `workspaceId` through the admin gatekeeper, oldest first. */
export async function requestsFiled(admin: RpcStub<AdminApi>, workspaceId: string)
    : Promise<AdminContentRequest[]> {
  return (await admin.listContentAccessRequests())
      .filter(request => request.workspaceId === workspaceId && request.via === "gatekeeper")
      .toSorted((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
}

/**
 * The writes made to `workspaceId` through the admin gatekeeper, oldest first, as the audit log
 * records them.
 */
export async function writesMade(admin: RpcStub<AdminApi>, workspaceId: string)
    : Promise<AdminWriteRecord[]> {
  const records = await auditRecords(admin, { kind: "write", workspace: workspaceId });
  return records.flatMap(record =>
    record.kind === "write" && record.via === "gatekeeper" ? [record] : []).toReversed();
}
