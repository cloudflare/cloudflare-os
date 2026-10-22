// A ChatGPT subscription model's token goes only to the workspace's owner, and only while nobody
// else can reach the workspace (see chatGptAccess() in overseer.ts). Runs against a real
// OverseerDurableObject (the TEST_OVERSEER binding); the owner's user object is the only fake.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_ID = "owner-user-do";
const OWNER = "alice";
const OWNER_CALLER = { profileId: OWNER, isOwner: true };
const PRIVATE = /private while it uses your ChatGPT subscription/;
const UNSHARE = "Stop sharing this workspace to use your ChatGPT subscription here.";

let counter = 0;

// Runs `f` against a fresh workspace owned by OWNER_ID, whose owner's user object hands out
// `token()`'s result.
function inWorkspace(f: (impl: any, getToken: ReturnType<typeof vi.fn>) => Promise<void>,
                     token: () => Promise<{ token: string; expiresAt: Date }> = async () =>
                         ({ token: "access", expiresAt: new Date(Date.now() + 3600_000) })) {
  let stub = env.TEST_OVERSEER.getByName(`chatgpt-lock-${++counter}`);
  return runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_ID;
    impl.ownerProfileId = OWNER;
    let getToken = vi.fn(token);
    impl.ownerUserDo = () => ({ getChatGptAccessToken: getToken });
    await f(impl, getToken);
  });
}

function shareWith(impl: any, profileId: string) {
  impl.storage.collaborators.put({
    profile: { type: "user", id: profileId, name: profileId },
    addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
  });
}

describe("ChatGPT subscription models in a workspace", () => {
  it("lock the workspace to its owner at first use", () => inWorkspace(async impl => {
    expect(impl.storage.ownerOnly.get()).toBe(false);
    expect((await impl.chatGptAccess(OWNER_ID)).token).toBe("access");
    expect(impl.storage.ownerOnly.get()).toBe(true);

    let sharing = await impl.getSharingManager();
    expect(() => sharing.addCollaborator(
        { caller: OWNER_CALLER, profile: { type: "user", id: "bob", name: "bob" }, role: "use" }))
        .toThrow(PRIVATE);
    await expect(sharing.createShareLink({ caller: OWNER_CALLER, role: "use" })).rejects.toThrow(PRIVATE);
    let redeemed = await sharing.redeemShareKey({
      rawKey: "00".repeat(16), profileId: "bob", fetchProfile: async () => ({}),
    }).catch((e: unknown) => e);
    expect(getOpenGadgetErrorCode(redeemed)).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
  }));

  // open() and receiveExternalMessage() admit a non-owner only through authorizeCollaborator.
  it("keep out a collaborator the workspace had before it was shared", () =>
      inWorkspace(async impl => {
    await impl.chatGptAccess(OWNER_ID);
    // Written past the sharing manager, as one left over from before the lock would be.
    shareWith(impl, "bob");
    expect(await impl.authorizeCollaborator("bob", undefined)).toBeNull();
  }));

  it("are refused in a workspace shared with someone", () => inWorkspace(async (impl, getToken) => {
    shareWith(impl, "bob");
    await expect(impl.chatGptAccess(OWNER_ID)).rejects.toThrow(UNSHARE);
    expect(impl.storage.ownerOnly.get()).toBe(false);
    expect(getToken).not.toHaveBeenCalled();
  }));

  it("are refused in a workspace with a share link", () => inWorkspace(async impl => {
    let sharing = await impl.getSharingManager();
    await sharing.createShareLink({ caller: OWNER_CALLER, role: "use" });
    await expect(impl.chatGptAccess(OWNER_ID)).rejects.toThrow(UNSHARE);
  }));

  it("are refused while a removed collaborator's session lives on", () => inWorkspace(async impl => {
    let leave = impl.joinSession("use");
    await expect(impl.chatGptAccess(OWNER_ID)).rejects.toThrow(UNSHARE);
    leave();
    await expect(impl.chatGptAccess(OWNER_ID)).resolves.toBeDefined();
  }));

  it("run only for the workspace's owner", () => inWorkspace(async (impl, getToken) => {
    await expect(impl.chatGptAccess("collaborator-user-do"))
        .rejects.toThrow("ChatGPT subscription models only run in workspaces you own.");
    expect(impl.storage.ownerOnly.get()).toBe(false);
    expect(getToken).not.toHaveBeenCalled();
  }));

  // So that signing out, or an admin turning the feature off, stops a turn already running.
  it("ask the owner's user object for the token on every request", () =>
      inWorkspace(async (impl, getToken) => {
    await impl.chatGptAccess(OWNER_ID);
    getToken.mockRejectedValueOnce(new Error("Sign in with ChatGPT to use this model."));
    await expect(impl.chatGptAccess(OWNER_ID)).rejects.toThrow("Sign in with ChatGPT");
    expect(getToken).toHaveBeenCalledTimes(2);

    impl.allowSharing();
    shareWith(impl, "bob");
    await expect(impl.chatGptAccess(OWNER_ID)).rejects.toThrow(UNSHARE);
    expect(getToken).toHaveBeenCalledTimes(2);
  }));

  it("refuse a token whose workspace was shared while it was fetched", () => {
    let impl: any;
    return inWorkspace(async workspace => {
      impl = workspace;
      await impl.chatGptAccess(OWNER_ID).then(
          () => { throw new Error("expected a refusal"); },
          (error: Error) => expect(error.message).toBe(UNSHARE));
    }, async () => {
      impl.allowSharing();
      shareWith(impl, "bob");
      return { token: "access", expiresAt: new Date(Date.now() + 3600_000) };
    });
  });

  describe("allowing sharing again", () => {
    it("is refused while an agent turn is running", () => inWorkspace(async impl => {
      await impl.chatGptAccess(OWNER_ID);
      impl.storage.activeAgents.put({
        chatId: 0, initiatorUserId: OWNER_ID, modelId: "chatgpt/gpt-5.5",
        initiator: { type: "user", id: OWNER, name: OWNER },
      });
      expect(() => impl.allowSharing()).toThrow("Wait for the agent to finish");
      expect(impl.storage.ownerOnly.get()).toBe(true);
    }));

    it("lets the workspace be shared, after which leftover uses fail closed", () =>
        inWorkspace(async impl => {
      await impl.chatGptAccess(OWNER_ID);
      impl.allowSharing();
      expect(impl.storage.ownerOnly.get()).toBe(false);

      let sharing = await impl.getSharingManager();
      sharing.addCollaborator({
        caller: OWNER_CALLER, profile: { type: "user", id: "bob", name: "bob" }, role: "use",
      });
      // A model binding, spawner or `self` stub made while it was locked.
      await expect(impl.chatGptAccess(OWNER_ID)).rejects.toThrow(UNSHARE);

      // Unshared, the next use locks it again.
      sharing.removeCollaborator(OWNER_CALLER, "bob", []);
      await impl.chatGptAccess(OWNER_ID);
      expect(impl.storage.ownerOnly.get()).toBe(true);
    }));
  });
});
