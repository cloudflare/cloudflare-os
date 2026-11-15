// What an issue report may name (OverseerDurableObject.issueReportContext(), which
// AuthenticatedApi.submitIssueReport() asks): a workspace its reporter owns or is a collaborator
// on, and a chat and gadget they can open there. Everything else is refused `contextNotFound`,
// and the check leaves the workspace as it found it.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) with its real sharing
// manager over stored collaborators; the accounts are fakes that answer a profile.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  ISSUE_REPORT_ERROR_CODES, getIssueReportErrorCode,
  type AiChatAuthorInfo, type IssueReportContext,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.test", name: "Owner" };
const BUILDER: AiChatAuthorInfo = { type: "user", id: "builder@example.test", name: "Builder" };
const VIEWER: AiChatAuthorInfo = { type: "user", id: "viewer@example.test", name: "Viewer" };
const STRANGER: AiChatAuthorInfo = { type: "user", id: "stranger@example.test", name: "Stranger" };
const CHAT_ID = 7;
// The gadget shared with VIEWER, one that is not, and a workpiece that is not a gadget.
const SHARED_GADGET = 100;
const OTHER_GADGET = 101;
const WORKTREE = 102;

// A user object's id, as the fake namespace derives it from the account's name.
function userIdOf(name: string): string {
  return `user-do:${name}`;
}

type Workspace = {
  impl: any;
  instance: OverseerDurableObject;
  state: DurableObjectState;
  // The account names whoamiIfExists() was asked of, in order.
  profileReads: string[];
};

// An initialised workspace of OWNER's with a chat, two gadgets and a worktree, shared with
// BUILDER (the whole workspace) and VIEWER (SHARED_GADGET alone).
async function withWorkspace(fn: (ws: Workspace) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`issue-report-context-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ws: Workspace = { impl, instance, state, profileReads: [] };
    let accounts = new Map([OWNER, BUILDER, VIEWER, STRANGER].map(user => [user.id, user]));
    impl.users = {
      idFromString: (id: string) => id,
      get: (id: string) => ({
        whoamiIfExists: async () => {
          let name = id.slice(userIdOf("").length);
          ws.profileReads.push(name);
          return accounts.get(name) ?? null;
        },
      }),
    };
    impl.ownerId = userIdOf(OWNER.id);
    impl.ownerProfileId = OWNER.id;
    impl.storage.ownerId.put(impl.ownerId);
    impl.storage.title.put("Quarterly plan");
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Plans", started: new Date(0), lastActive: new Date(0) });
    for (let [id, bindingName] of [[SHARED_GADGET, "APP"], [OTHER_GADGET, "NOTES"]] as const) {
      impl.storage.gadgets.put(
          { type: "gadget", id, title: bindingName, created: new Date(0), bindingName,
            bindings: {} });
    }
    impl.storage.gadgets.put({ ...impl.storage.gadgets.get(OTHER_GADGET), type: "worktree",
        id: WORKTREE, bindingName: "TREE" });
    let sharing = await impl.getSharingManager();
    let caller = { profileId: OWNER.id, isOwner: true };
    sharing.addCollaborator({ caller, profile: BUILDER, grant: "workspace" });
    sharing.addCollaborator({ caller, profile: VIEWER, grant: { gadgetId: SHARED_GADGET } });
    await fn(ws);
  });
}

type Named = Pick<IssueReportContext, "chatId" | "gadgetId">;

// What the workspace answers `user` for a report naming `context`: whether they own it, or
// "refused" for `contextNotFound`.
async function answer(ws: Workspace, user: AiChatAuthorInfo, context: Named = {})
    : Promise<{ owner: boolean } | "refused"> {
  try {
    return await ws.instance.issueReportContext(userIdOf(user.id), context);
  } catch (err) {
    expect(getIssueReportErrorCode(err)).toBe(ISSUE_REPORT_ERROR_CODES.contextNotFound);
    return "refused";
  }
}

// What a member could notice of the workspace: everything it stores, who is present, the
// sessions open and the alarm.
async function memberVisibleState(ws: Workspace) {
  return {
    storage: [...ws.state.storage.kv.list()],
    present: ws.impl.presenceSnapshot(),
    sessions: ws.impl.liveSessionCounts(),
    alarm: await ws.state.storage.getAlarm(),
  };
}

describe("the workspace an issue report names", () => {
  it("passes for its owner, whatever chat or gadget of it the report names",
      () => withWorkspace(async ws => {
    for (let context of [{}, { chatId: CHAT_ID }, { gadgetId: OTHER_GADGET },
        { chatId: CHAT_ID, gadgetId: SHARED_GADGET }]) {
      expect(await answer(ws, OWNER, context)).toStrictEqual({ owner: true });
    }
    // The owner is known by the id the workspace keeps: no account is asked.
    expect(ws.profileReads).toStrictEqual([]);
  }));

  it("passes for a collaborator who builds, who is not its owner", () => withWorkspace(async ws => {
    for (let context of [{}, { chatId: CHAT_ID }, { gadgetId: OTHER_GADGET }]) {
      expect(await answer(ws, BUILDER, context)).toStrictEqual({ owner: false });
    }
  }));

  it("passes for a collaborator who uses a gadget, for that gadget and no chat",
      () => withWorkspace(async ws => {
    expect(await answer(ws, VIEWER)).toStrictEqual({ owner: false });
    expect(await answer(ws, VIEWER, { gadgetId: SHARED_GADGET })).toStrictEqual({ owner: false });
    expect(await answer(ws, VIEWER, { gadgetId: OTHER_GADGET })).toBe("refused");
    expect(await answer(ws, VIEWER, { chatId: CHAT_ID })).toBe("refused");
    expect(await answer(ws, VIEWER, { chatId: CHAT_ID, gadgetId: SHARED_GADGET }))
        .toBe("refused");
  }));

  it("is refused someone it is not shared with, and an account that does not exist",
      () => withWorkspace(async ws => {
    expect(await answer(ws, STRANGER)).toBe("refused");
    expect(await answer(ws, { type: "user", id: "nobody@example.test", name: "Nobody" }))
        .toBe("refused");
  }));

  it("is refused for a chat or a gadget that does not exist", () => withWorkspace(async ws => {
    for (let user of [OWNER, BUILDER]) {
      expect(await answer(ws, user, { chatId: 999_999 })).toBe("refused");
      expect(await answer(ws, user, { gadgetId: 999_999 })).toBe("refused");
      expect(await answer(ws, user, { chatId: CHAT_ID, gadgetId: 999_999 })).toBe("refused");
      // A workpiece that is not a gadget is not one a report can name.
      expect(await answer(ws, user, { gadgetId: WORKTREE })).toBe("refused");
    }
  }));

  it("is refused once deleted, and when it was never initialised", async () => {
    await withWorkspace(async ws => {
      ws.impl.beginDeletion(new Set<string>());
      expect(await answer(ws, OWNER)).toBe("refused");
      expect(await answer(ws, BUILDER)).toBe("refused");
    });
    let stub = env.TEST_OVERSEER.getByName(`issue-report-context-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let refused = await instance.issueReportContext(userIdOf(OWNER.id), {}).catch(err => err);
      expect(getIssueReportErrorCode(refused)).toBe(ISSUE_REPORT_ERROR_CODES.contextNotFound);
    });
  });

  it("leaves the workspace's storage, presence, sessions and alarm as they were",
      () => withWorkspace(async ws => {
    let before = await memberVisibleState(ws);
    for (let user of [OWNER, BUILDER, VIEWER, STRANGER]) {
      await answer(ws, user);
      await answer(ws, user, { chatId: CHAT_ID, gadgetId: SHARED_GADGET });
      await answer(ws, user, { chatId: 999_999 });
    }
    expect(await memberVisibleState(ws)).toStrictEqual(before);
  }));
});
