import {describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import type {CodeChange} from "@gadgets/workshop-shared/code-change";
declare module "cloudflare:workers" { interface ProvidedEnv {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}}
type Impl = OverseerDurableObject["impl"];
const AUTHOR = {type: "agent" as const, id: "test", name: "Test"};
const USER = {type: "user" as const, id: "test-user", name: "Test"};
async function inKernel<T>(name: string, test: (impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), instance => test(instance.impl));
}
async function step(impl: Impl, chatId: number, change: CodeChange) {
  await impl.commitAgentStep(chatId, AUTHOR, [], {changes: [{change}], createdGadgets: [],
    createdWorktrees: [], addedBindings: [], worktreeCommits: [], blueprintMerges: []});
}
describe("attachment worktree ingress", () => {
  it.each([Uint8Array.of(239, 187, 191, 65), Uint8Array.of(255, 65)])(
    "preserves attachment bytes without lossy UTF-8 projection (%j)", bytes => inKernel(crypto.randomUUID(), async impl => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: bytes, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/csv", name: "input.csv",
      }});
      const chatId = await impl.newChat(env.TEST_USER.getByName(crypto.randomUUID()),
        {profile: USER}, "Read this CSV", undefined, [{id}]);
      expect(await impl.getChatAttachmentData(chatId, id)).toEqual(bytes);
      const attachment = impl.storage.chatAttachmentContent.get(id)!;
      const context = impl.getChatAgentContext(chatId);
      if (bytes[0] === 255) {
        expect(context.attachments).toBeUndefined();
        expect(attachment.data).toEqual(bytes);
      } else {
        expect(context.attachments).toBeDefined();
        expect(attachment.data).toBeUndefined();
        const tree = impl.storage.gadgets.get(context.attachments!.worktreeId)!;
        expect(tree.type === "worktree" && await impl.readFileAtCommit(tree.baseCommit, "input.csv")).toBe("\ufeffA");
      }
    }),
  );

  it.each([false, true])("projects text uploads beyond the former file-size cap (existing worktree: %s)", existing => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const stage = (data: Uint8Array, name: string) => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data, state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/plain", name,
      }});
      return {id};
    };
    const bytes = new TextEncoder().encode("x".repeat(512 * 1024 + 1));
    const upload = stage(bytes, "large.txt");
    const chatId = existing
      ? await impl.newChat(user, {profile: USER}, "Initial", undefined, [stage(new TextEncoder().encode("small"), "small.txt")])
      : await impl.newChat(user, {profile: USER}, "Read this", undefined, [upload]);
    if (existing) await impl.sendChatMessage(user, {profile: USER}, chatId, "Read this", undefined, [upload]);
    const returned = await impl.getChatAttachmentData(chatId, upload.id);
    expect(returned.byteLength).toBe(bytes.byteLength);
    // Verify byte identity without an element-by-element matcher over a large upload.
    expect(await crypto.subtle.digest("SHA-256", returned)).toEqual(await crypto.subtle.digest("SHA-256", bytes));
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state).toMatchObject({type: "committed", chatId});
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state).toHaveProperty("workspacePath", "large.txt");
    expect(impl.getChatAgentContext(chatId).attachments).toBeDefined();
    expect([...impl.storage.chats.list()].some(message => message.type === "message" &&
      message.attachments?.some(attachment => attachment.id === upload.id))).toBe(true);
  }));

  it.each(["pending", "accepted", "directory"])("does not overwrite %s agent-created attachment-worktree paths", mode => inKernel(crypto.randomUUID(), async impl => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const stage = (text: string, name: string) => {
      const id = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put({fileId: id, data: new TextEncoder().encode(text), state: {
        type: "staged", uploadedAt: Date.now(), mimeType: "text/csv", name,
      }});
      return {id};
    };
    const chatId = await impl.newChat(user, {profile: USER}, "Initial", undefined, [stage("input", "input.csv")]);
    const worktreeId = impl.getChatAgentContext(chatId).attachments!.worktreeId;
    const generatedPath = mode === "directory" ? "report.csv/part.txt" : "report.csv";
    await step(impl, chatId, {[worktreeId]: [[generatedPath, {set: "agent-created"}]]});
    if (mode === "accepted") expect(await impl.mergeChanges(chatId, {profile: USER}, USER.id)).toEqual({outcome: "merged"});
    const upload = stage("uploaded", "report.csv");
    await impl.sendChatMessage(user, {profile: USER}, chatId, "Another attachment", undefined, [upload]);
    expect(impl.storage.chatAttachmentContent.get(upload.id)?.state).toMatchObject({workspacePath: "report-2.csv"});
    const content = await impl.getCurrentChatContent(chatId, impl.storage.chatMeta.get(chatId)!);
    expect(content.get(worktreeId)?.get(generatedPath) ?? await impl.readFileAtCommit(impl.getWorktreePinBase(worktreeId)!, generatedPath)).toBe("agent-created");
    expect(content.get(worktreeId)?.get("report-2.csv")).toBe("uploaded");
  }));
});
