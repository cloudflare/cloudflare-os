// Observers of a GitHub repository's data through the real Workshop and the real GitHub gatekeeper,
// with only GitHub itself faked (github-fake.ts). Every read the binding makes reports the
// repository it read, `repo/<id>`, and the kernel checks it against each collaborator's own GitHub
// account (docs/observers.md §10): a collaborator is admitted only if their token can read the
// repository, and a read is refused while a collaborator who can't read it would see it.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  AuthenticatedApi, Overseer, PresenceParticipant, PresenceSubscriber,
} from "@gadgets/workshop-shared/api";
import { startHarness, type Harness } from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder, signUp, stubFor,
  RpcTarget, waitFor, waitForIdleChat, type ConnectedAccount,
} from "../src/rpc-client.js";
import { connectGitHub, FakeGitHub, githubGatekeeper } from "./github-fake.js";

/** The workspace's roster of present participants, as its presence subscription reports it. */
class PresenceRecorder extends RpcTarget implements PresenceSubscriber {
  readonly participants = new Map<string, PresenceParticipant>();
  init(participants: PresenceParticipant[]): void {
    this.participants.clear();
    for (const participant of participants) this.participants.set(participant.key, participant);
  }

  add(participant: PresenceParticipant): void {
    this.participants.set(participant.key, participant);
  }

  remove(key: string): void {
    this.participants.delete(key);
  }
}

const github = new FakeGitHub();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler, github.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [githubGatekeeper()], enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** The Workshop's refusal of a read, for a reported subresource a collaborator can't read. */
const READ_REFUSED = "blocked because it contains data that a current collaborator";

/** What the agent runs to read the repository through the chat's GITHUB binding. */
const READ_METADATA = `export default async function(self, env) {
  return await env.GITHUB.getMetadata();
}`;

/** A chat turn that reads the repository's metadata, then answers. */
const readTurn = (id: string): ChatCompletionStep[] => [
  { toolCall: { id, name: "executeCode", arguments: { code: READ_METADATA } } },
  { text: "Read." },
];

type GitHubUser = Disposable & {
  username: string;
  api: RpcStub<AuthenticatedApi>;
  account: ConnectedAccount;
  /** The token the fake issued their GitHub account. */
  token: string;
};

/** A fresh Workshop user who has connected their own GitHub account. */
async function gitHubUser(prefix: string): Promise<GitHubUser> {
  using stack = new DisposableStack();
  const [username] = nextUsernames(prefix);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  const account = await connectGitHub(harness, api, username!);
  return Object.assign(stack.move(), { username: username!, api, account, token: `token-${username}` });
}

type OwnerWorkspace = Disposable & {
  ws: RpcStub<Overseer>;
  workspaceId: string;
  connectionId: number;
  repo: { id: number; name: string };
  model: RoutedScriptedModel;
};

/**
 * `owner`'s workspace with `acme/<repo>` connected through their account and bound as GITHUB to
 * a gadget, so the workspace's chats get it too; the agent follows `steps`.
 */
async function ownerWorkspace(owner: GitHubUser, steps: ChatCompletionStep[])
    : Promise<OwnerWorkspace> {
  using stack = new DisposableStack();
  const model = models.script(steps);
  await owner.api.addModel(model.userModel.profile, model.userModel.config);
  const repo = github.addRepository(`widgets-${owner.username}`);
  const ws = stack.use(await owner.api.newWorkspace());
  const { id: workspaceId } = await ws.getMetadata();
  const connection = await ws.newGatekeeper(owner.account.id, `https://github.com/acme/${repo.name}`);
  if (!connection) throw new Error("Failed to connect the repository");
  stack.use(connection);
  using reader = await ws.createGadget("Reader", undefined, "READER");
  // Bound before any chat opens: a permanent edge seeds a new chat's env under its name.
  const connectionId = await connection.getId();
  await reader.bind("GITHUB", connectionId);
  return Object.assign(stack.move(), { ws, workspaceId, connectionId, repo, model });
}

/** `collaborator` opens the workspace, choosing their own GitHub account at every prompt. */
async function opens(collaborator: GitHubUser, workspaceId: string)
    : Promise<{ recorder: ObserverConfigRecorder; error?: Error }> {
  const recorder = new ObserverConfigRecorder()
    .alwaysChoose(collaborator.account.id, MAX_OBSERVER_PROMPTS);
  using callback = stubFor(recorder);
  try {
    (await collaborator.api.openWorkspace(workspaceId, undefined, callback))[Symbol.dispose]();
    return { recorder };
  } catch (error) {
    return { recorder, error: error as Error };
  }
}

/** Expect the agent's `nth` model request to carry, for tool call `id`, a result containing `text`. */
function expectToolResult(model: RoutedScriptedModel, nth: number, id: string, text: string): void {
  expect(model.requests[nth]).toMatchObject({ messages: expect.arrayContaining([
    expect.objectContaining({ role: "tool", tool_call_id: id, content: expect.stringContaining(text) }),
  ]) });
}

/** The requests that carried `token` to repository `repo`, by id or by name. */
function repoRequestsWith(token: string, repo: { id: number; name: string }): string[] {
  return github.requestsWith(token).filter(request =>
    request.includes(`/repositories/${repo.id}`) || request.includes(`/repos/acme/${repo.name}`));
}

it.concurrent("a chat's read admits only collaborators whose own GitHub token can read the repository",
    async () => {
  using owner = await gitHubUser("githubobsowner");
  using state = await ownerWorkspace(owner, readTurn("read"));
  const { ws, workspaceId, connectionId, repo, model } = state;

  // The agent reads the repository through the chat's binding.
  const chatId = await ws.newChat("Read the repository.", SCRIPTED_MODEL_ID);
  await waitFor("the read turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);
  expectToolResult(model, 1, "read", `acme/${repo.name}`);
  const { entries: observations } = await ws.listActions({ filter: "observation" });
  expect(observations.map(entry => entry.description.title))
    .toContain(`Read repository metadata for acme/${repo.name}`);
  // Beyond the probe by name that pinned it, the owner's token addressed the repository by its id.
  expect(repoRequestsWith(owner.token, repo).filter(request =>
    request !== `GET /repos/acme/${repo.name}` && !request.includes(`/repositories/${repo.id}`)))
    .toEqual([]);

  // A collaborator whose own token can read the repository is admitted, checked with that token by
  // its id, and, for what reads made by name may have read, by its name.
  using carol = await gitHubUser("githubobscarol");
  await ws.addCollaborator(carol.username, "workspace");
  const admitted = await opens(carol, workspaceId);
  expect(admitted.error).toBeUndefined();
  expect(admitted.recorder.calls[0]!.map(need => need.gatekeeperId)).toContain(connectionId);
  const carolChecks = repoRequestsWith(carol.token, repo);
  expect(carolChecks.length).toBeGreaterThan(0);
  expect(new Set(carolChecks)).toEqual(new Set([`GET /repositories/${repo.id}`, `GET /repos/acme/${repo.name}`]));

  // One whose token can't (GitHub answers it 404) is refused, at this connection.
  using dave = await gitHubUser("githubobsdave");
  github.setVisibleTo(repo.name, dave.token, false);
  await ws.addCollaborator(dave.username, "workspace");
  const refused = await opens(dave, workspaceId);
  expect(refused.error).toBeDefined();
  expect(refused.recorder.calls.at(-1)!.filter(need => need.failure)).toEqual([
    expect.objectContaining({ gatekeeperId: connectionId }),
  ]);
  const daveChecks = repoRequestsWith(dave.token, repo);
  expect(daveChecks.length).toBeGreaterThan(0);
  expect(new Set(daveChecks)).toEqual(new Set([`GET /repositories/${repo.id}`, `GET /repos/acme/${repo.name}`]));
});

it.concurrent("a chat's read is refused only while a collaborator who can't read the repository is online",
    async () => {
  using owner = await gitHubUser("githubobsreadowner");
  using state = await ownerWorkspace(owner, [...readTurn("refused"), ...readTurn("offline")]);
  const { ws, workspaceId, repo, model } = state;

  // Both collaborators are admitted while they can read the repository; nothing has been read
  // yet, so only the connection's own live check of each token runs.
  using bob = await gitHubUser("githubobsreadbob");
  using carol = await gitHubUser("githubobsreadcarol");
  await ws.addCollaborator(bob.username, "workspace");
  await ws.addCollaborator(carol.username, "workspace");
  using bobCallback = stubFor(
    new ObserverConfigRecorder().alwaysChoose(bob.account.id, MAX_OBSERVER_PROMPTS));
  const bobSession = await bob.api.openWorkspace(workspaceId, undefined, bobCallback);
  const presence = new PresenceRecorder();
  using presenceStub = stubFor(presence);
  using _presence = await ws.subscribeToPresence(presenceStub);
  const bobPresent = () => [...presence.participants.values()].some(entry => entry.user.id === bob.username);
  await waitFor("Bob's presence", async () => bobPresent() || null);
  expect((await opens(carol, workspaceId)).error).toBeUndefined();

  // Bob loses access on GitHub while his session is open. The agent's read is refused: the
  // kernel checked the repository it reported against him with his own token.
  github.setVisibleTo(repo.name, bob.token, false);
  const chatId = await ws.newChat("Read the repository.", SCRIPTED_MODEL_ID);
  await waitFor("the refused read turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expectToolResult(model, 1, "refused", READ_REFUSED);
  expect(repoRequestsWith(bob.token, repo).at(-1)).toBe(`GET /repositories/${repo.id}`);
  expect((await ws.listActions({ filter: "observation" })).entries.map(entry => entry.description.title))
    .not.toContain(`Read repository metadata for acme/${repo.name}`);

  // Once Bob closes his session, he is not asked: the same read succeeds and is recorded. His
  // session and his presence end in the same disposal.
  bobSession[Symbol.dispose]();
  await waitFor("Bob's session to close", async () => bobPresent() ? null : true);
  const bobChecks = repoRequestsWith(bob.token, repo).length;
  await ws.sendChatMessage(chatId, "Read it again.", SCRIPTED_MODEL_ID);
  await waitFor("the offline read turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  expectToolResult(model, 3, "offline", `acme/${repo.name}`);
  expect(repoRequestsWith(bob.token, repo)).toHaveLength(bobChecks);

  // When he comes back, his admission checks what was read meanwhile, and refuses him.
  const refused = await opens(bob, workspaceId);
  expect(refused.error).toBeDefined();
  expect(repoRequestsWith(bob.token, repo).slice(bobChecks)).toContain(`GET /repositories/${repo.id}`);
});
