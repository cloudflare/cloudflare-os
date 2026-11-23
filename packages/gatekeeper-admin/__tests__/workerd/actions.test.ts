// The two action kinds: what queues each, what its card says, that no rule may approve them, and
// what applying one does and fails as. Actions are queued through sessions the facet opened and
// applied through the facet, over RPC, on the Admin API the account's grant opens: so a refusal's
// code crosses a hop as it does from the Workshop.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { ActionJournal, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ERROR_CODES, MAX_ADMIN_ACCESS_REASON_LENGTH,
  createAdminAccessError, createAdminGrantError,
} from "@gadgets/workshop-shared/api";
import type { ActionDescription, ActionField } from "@gadgets/workshop-shared/gatekeeper";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_ACTIONS, type ActionAdminApi, type AdminActions, TERMINAL_REFUSALS,
} from "../../src/actions.js";
import type { AdminGatekeeperImpl } from "../../src/admin.js";
import {
  Queue, accountOf, connectAccount, openSession, rejection, withFacet, type Session,
} from "./harness.js";
import { NOT_ADMIN, ROOT, recordingTarget, workshop } from "./worker.js";

const WORKSPACE = "workspace-9";
const OUTCOME_UNKNOWN = "The Admin API did not say whether this was done. Check the audit log " +
  "before rejecting this action.";
const NOT_CONNECTED = "This deployment admin account is no longer connected.";

type Kind = keyof AdminActions;

type Case = {
  kind: Kind;
  tag: string;
  label: string;
  /** Queues the action through `binding`, a session of the whole binding. */
  queue(binding: Session): Promise<unknown>;
  /** The stored payload, as the action set takes it. */
  payload: AdminActions[Kind];
  /** The one call its apply makes. */
  call: { name: string; args: unknown[] };
  title: string;
  description: string;
  fields: ActionField[];
};

const writeFields = (action: string, args: unknown, reason: string): ActionField[] => [
  { label: "Workspace", kind: "inline", value: WORKSPACE },
  { label: "Action", kind: "inline", value: action },
  { label: "Arguments", kind: "json", value: JSON.stringify(args, null, 2) },
  { label: "Reason", kind: "text", value: reason },
];

const contentFields = (reason: string): ActionField[] => [
  { label: "Workspace", kind: "inline", value: WORKSPACE },
  { label: "Reason", kind: "text", value: reason },
];

const CASES: Case[] = [
  {
    kind: "workspaceWriteRequest",
    tag: "workspace-write-request",
    label: "Write to a workspace as a deployment admin",
    queue: (binding) =>
      binding.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: 3 }, "It loops.\nStop it."),
    payload: { workspaceId: WORKSPACE, action: "stopAgent", args: { chatId: 3 }, reason: "It loops.\nStop it." },
    call: { name: "writeWorkspace", args: [WORKSPACE, "stopAgent", { chatId: 3 }, "It loops.\nStop it."] },
    title: `Write to workspace ${WORKSPACE}: stopAgent`,
    description: "Runs the write as the deployment admin who connected this account, as soon as " +
      "this is approved. Its reason goes to the deployment's admin audit log, not to that " +
      "workspace, whose members see only what the write does.",
    fields: writeFields("stopAgent", { chatId: 3 }, "It loops.\nStop it."),
  },
  {
    kind: "contentAccessRequest",
    tag: "content-access-request",
    label: "Ask the admins for access to a workspace's content",
    queue: (binding) => binding.requestContentAccess!(WORKSPACE, "Need the chat."),
    payload: { workspaceId: WORKSPACE, reason: "Need the chat." },
    call: { name: "requestContentAccess", args: [WORKSPACE, "Need the chat."] },
    title: `Ask the admins for access to the content of workspace ${WORKSPACE}`,
    description: "Files a request, as the deployment admin who connected this account, that " +
      "another deployment admin approves from the admin panel's pending approvals: once " +
      "approved, admins can read that workspace's chats and files for a time. The admin the " +
      "request is filed as cannot approve it.",
    fields: contentFields("Need the chat."),
  },
];

const caseOf = (kind: Kind) => CASES.find((candidate) => candidate.kind === kind)!;

type Facet = DurableObjectStub<AdminGatekeeperImpl>;

/** Applies `action` as the Workshop does once it is approved. */
async function apply(facet: Facet, action: number): Promise<void> {
  // The git cache the Workshop passes, which this gatekeeper never uses.
  using cache = new RpcStub(new (class extends RpcTarget {})());
  await facet.applyAction(action, cache as never);
}

/** Every call the Admin APIs the grant opened have received, oldest first. */
const calls = () => workshop.apis.flatMap((api) => api.calls);

/**
 * Runs `body` with `candidate`'s action queued on a facet of its own, whose connection was made
 * from ada's account `userObjectId`.
 */
async function withQueued<T>(candidate: Case, body: (queued: {
  facet: Facet; id: number; queue: Queue; userObjectId: string;
}) => Promise<T>): Promise<T> {
  const userObjectId = await connectAccount("ada");
  workshop.log.length = 0;
  return withFacet(userObjectId, async (facet) => {
    const queue = new Queue();
    {
      using session = await openSession(facet, queue);
      await candidate.queue(session);
    }
    return await body({ facet, id: queue.submitted[0]!.action, queue, userObjectId });
  });
}

/** Runs `body` with a session of a connection made from ada's account, and its queue. */
async function withSession<T>(body: (session: Session, queue: Queue) => Promise<T>): Promise<T> {
  const userObjectId = await connectAccount("ada");
  workshop.log.length = 0;
  return withFacet(userObjectId, async (facet) => {
    const queue = new Queue();
    using session = await openSession(facet, queue);
    return await body(session, queue);
  });
}

/** The refusal the Admin API makes with `code`. */
function refusal(code: string): Error {
  const among = (codes: Record<string, string>) => Object.values(codes).includes(code);
  if (among(ADMIN_GRANT_ERROR_CODES)) return createAdminGrantError(code as never);
  return createAdminAccessError(code as never);
}

beforeEach(() => workshop.reset());

describe("each action kind", () => {
  it("has a tag no other kind has", () => {
    expect(CASES.map((candidate) => candidate.kind).toSorted())
        .toEqual(["contentAccessRequest", "workspaceWriteRequest"]);
    expect(new Set(CASES.map((candidate) => candidate.tag)).size).toBe(CASES.length);
  });

  for (const candidate of CASES) {
    const { kind, call } = candidate;

    it(`${kind}: queues one action with its card and reads nothing through the binding`, async () => {
      await withQueued(candidate, async ({ queue }) => {
        const description: ActionDescription = {
          title: candidate.title,
          description: candidate.description,
          fields: candidate.fields,
          descriptionIsComplete: true,
          implementsRevert: false,
          autoApprovable: false,
          actionKind: { tag: candidate.tag, label: candidate.label },
          awaitDecision: true,
        };
        expect(queue.submitted).toEqual([{ action: expect.any(Number), description }]);
        expect(workshop.log).toEqual([`submit ${candidate.tag}`]);
        expect(queue.observations).toEqual([]);
        // Nothing was written or filed: the Admin API was not even opened.
        expect(workshop.apis).toEqual([]);
      });
    });

    it(`${kind}: applies as exactly the stored call, once, on an Admin API opened for it`, async () => {
      await withQueued(candidate, async ({ facet, id }) => {
        await apply(facet, id);
        expect(workshop.log).toEqual([`submit ${candidate.tag}`, "open ada", `${ROOT}.${call.name}`]);
        expect(calls()).toEqual([call]);

        // An applied action is not run again.
        await apply(facet, id);
        expect(calls()).toEqual([call]);
      });
    });
  }
});

describe("the verdicts", () => {
  it("let a rule approve neither a write nor a content request", async () => {
    const offered = await withFacet(
        await connectAccount("ada"), (facet) => facet.getAutoApprovableActions());
    expect(offered).toEqual([]);
  });

  it("queue a write and a content request as kinds of their own, each waiting for a person", async () => {
    await withSession(async (session, queue) => {
      await session.requestContentAccess!(WORKSPACE, "the same reason");
      await session.writeWorkspace!(WORKSPACE, "restartWorkspace", {}, "the same reason");
      await session.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: 7 }, "x");

      const [content, restart, stop] = queue.submitted.map((entry) => entry.description);
      expect([content!.actionKind?.tag, restart!.actionKind?.tag, stop!.actionKind?.tag]).toEqual(
          ["content-access-request", "workspace-write-request", "workspace-write-request"]);
      expect([content!.autoApprovable, restart!.autoApprovable, stop!.autoApprovable])
          .toEqual([false, false, false]);
      // A write's card shows the workspace, the action, its arguments and the whole reason; a
      // content request's the workspace and the reason.
      expect(restart!.fields).toEqual(writeFields("restartWorkspace", {}, "the same reason"));
      expect(content!.fields).toEqual(contentFields("the same reason"));
      // Only the content request's card says who may not approve the request it files.
      expect(content!.description).toContain("cannot approve it");
      expect(restart!.description).not.toContain("cannot approve it");
    });
  });
});

describe("what is refused before anything is queued", () => {
  it("a blank and an over-long reason, for a write and for a content request", async () => {
    await withSession(async (session, queue) => {
      const long = "x".repeat(MAX_ADMIN_ACCESS_REASON_LENGTH + 1);
      const refused = `A reason is required, and must be at most ${MAX_ADMIN_ACCESS_REASON_LENGTH} characters.`;

      for (const reason of ["", " \n\t ", long]) {
        expect((await rejection(session.writeWorkspace!(WORKSPACE, "restartWorkspace", {}, reason)))
            .message).toBe(refused);
        expect((await rejection(session.requestContentAccess!(WORKSPACE, reason))).message)
            .toBe(refused);
      }
      expect(workshop.log).toEqual([]);

      // The longest reason there is, once trimmed, is queued, and trimmed is how it is stored.
      await session.writeWorkspace!(WORKSPACE, "restartWorkspace", {}, ` ${long.slice(1)}\n`);
      await session.requestContentAccess!(WORKSPACE, `${long.slice(1)} `);
      expect(queue.submitted.map((entry) => entry.description.fields)).toEqual(
          [writeFields("restartWorkspace", {}, long.slice(1)), contentFields(long.slice(1))]);
    });
  });

  it("anything at all once the account's admin is demoted or the account is removed", async () => {
    const userObjectId = await connectAccount("ada");
    await withFacet(userObjectId, async (facet) => {
      const queue = new Queue();
      using session = await openSession(facet, queue);
      const refusals = async () => [
        (await rejection(session.writeWorkspace!(WORKSPACE, "restartWorkspace", {}, "reason"))).message,
        (await rejection(session.requestContentAccess!(WORKSPACE, "reason"))).message,
      ];

      workshop.admins.delete("ada");
      const notAdmin = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin).message;
      expect(await refusals()).toEqual([notAdmin, notAdmin]);
      await accountOf(userObjectId).revoke();
      expect(await refusals()).toEqual([NOT_CONNECTED, NOT_CONNECTED]);
      expect(queue.submitted).toEqual([]);
    });
  });

  it("arguments a write's action does not take, lacks or cannot hold", async () => {
    await withSession(async (session, queue) => {
      const request = (action: string, args: object) =>
        rejection(session.writeWorkspace!(WORKSPACE, action, args, "reason"));

      // Each fits the schema, which knows the arguments only as an optional number.
      expect((await request("stopAgent", {})).message).toBe('"stopAgent" needs `chatId`.');
      expect((await request("restartWorkspace", { chatId: 7 })).message)
          .toBe('"restartWorkspace" takes no `chatId`.');
      for (const chatId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect((await request("stopAgent", { chatId })).message)
            .toBe("`chatId` must be a non-negative whole number.");
      }
      expect(workshop.log).toEqual([]);
      expect(queue.submitted).toEqual([]);

      // What the action takes is queued, an id of zero included.
      await session.writeWorkspace!(WORKSPACE, "restartWorkspace", {}, "reason");
      await session.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: 0 }, "reason");
      expect(queue.submitted.map((entry) => entry.description.fields)).toEqual([
        writeFields("restartWorkspace", {}, "reason"),
        writeFields("stopAgent", { chatId: 0 }, "reason"),
      ]);
    });
  });

  it("an unknown action and arguments that are not a write's or a request's", async () => {
    await withSession(async (session, queue) => {
      for (const call of [
        () => session.writeWorkspace!(WORKSPACE, "deleteWorkspace", {}, "reason"),
        () => session.writeWorkspace!(WORKSPACE, "grantContentAccess", {}, "reason"),
        () => session.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: "three" }, "reason"),
        () => session.writeWorkspace!(WORKSPACE, "stopAgent", { chatId: 3 }),
        () => session.requestContentAccess!(WORKSPACE),
        () => session.requestContentAccess!(WORKSPACE, "reason", {}),
      ]) {
        expect((await rejection(call())).message).toMatch(/^Invalid arguments for AdminApi\./);
      }
      expect(workshop.log).toEqual([]);
      expect(queue.submitted).toEqual([]);
    });
  });
});

describe("an action that fails to apply", () => {
  for (const candidate of CASES) {
    const { kind, call } = candidate;

    for (const code of TERMINAL_REFUSALS) {
      it(`${kind}: a refusal coded ${code} is final, and is not tried again`, async () => {
        await withQueued(candidate, async ({ facet, id }) => {
          workshop.failures.set(call.name, refusal(code));
          expect((await rejection(apply(facet, id))).message).toBe(refusal(code).message);
          expect(calls()).toEqual([call]);

          // The kit answers a failed action with its failure, and runs nothing.
          workshop.failures.clear();
          expect((await rejection(apply(facet, id))).message).toBe(refusal(code).message);
          expect(calls()).toEqual([call]);
        });
      });
    }

    it(`${kind}: a call refused because its admin is one no longer leaves it pending`, async () => {
      await withQueued(candidate, async ({ facet, id }) => {
        const refused = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin);
        workshop.failures.set(call.name, refused);
        expect((await rejection(apply(facet, id))).message).toBe(refused.message);
        expect(calls()).toEqual([call]);

        workshop.failures.clear();
        await apply(facet, id);
        expect(calls()).toEqual([call, call]);
      });
    });

    it(`${kind}: an Admin API that does not open makes no call and leaves it pending`, async () => {
      await withQueued(candidate, async ({ facet, id }) => {
        // The account's admin was demoted: the grant opens nothing.
        workshop.admins.delete("ada");
        expect((await rejection(apply(facet, id))).message).toBe(NOT_ADMIN);
        expect(calls()).toEqual([]);

        workshop.admins.add("ada");
        await apply(facet, id);
        expect(calls()).toEqual([call]);
      });
    });

    it(`${kind}: a removed account's action makes no call, and stays pending`, async () => {
      await withQueued(candidate, async ({ facet, id, userObjectId }) => {
        await accountOf(userObjectId).revoke();
        expect((await rejection(apply(facet, id))).message).toBe(NOT_CONNECTED);
        expect((await rejection(apply(facet, id))).message).toBe(NOT_CONNECTED);
        expect(workshop.apis).toEqual([]);
        // A person rejects it: then it is gone.
        await facet.rejectAction(id);
        expect((await rejection(apply(facet, id))).message).toBe(`Unknown pending action: ${id}`);
      });
    });
  }

  const UNKNOWN: [string, unknown][] = [
    ["an error with no code", new Error("Network connection lost.")],
    ["a code this gatekeeper does not know", Object.assign(new Error("Refused."), { code: "SOMETHING_NEW" })],
    ["a refusal of another call", createAdminGrantError(ADMIN_GRANT_ERROR_CODES.requestNotPending)],
  ];

  // Every kind: run again, it would be a second write or a second request.
  for (const candidate of CASES) {
    const { kind, call } = candidate;

    for (const [what, error] of UNKNOWN) {
      it(`${kind}: ${what} after the call leaves the outcome unknown, and it never runs again`, async () => {
        await withQueued(candidate, async ({ facet, id }) => {
          workshop.failures.set(call.name, error as Error);
          expect((await rejection(apply(facet, id))).message).toBe(OUTCOME_UNKNOWN);
          expect(calls()).toEqual([call]);

          workshop.failures.clear();
          expect((await rejection(apply(facet, id))).message).toBe(OUTCOME_UNKNOWN);
          expect(calls()).toEqual([call]);

          // A person rejects it, having looked: then it is gone.
          await facet.rejectAction(id);
          expect((await rejection(apply(facet, id))).message).toBe(`Unknown pending action: ${id}`);
          expect(calls()).toEqual([call]);
        });
      });
    }
  }
});

/** Durable Object KV, in memory: cloned values and scans in key order. */
function memoryKv() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => void values.set(key, structuredClone(value)),
    delete: (key: string) => void values.delete(key),
    list: <T>({ prefix, startAfter, end, limit }:
        { prefix: string; startAfter?: string; end?: string; limit?: number }) =>
      [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) &&
              (startAfter === undefined || key > startAfter) && (end === undefined || key < end))
          .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .slice(0, limit)
          .map(([key, value]) => [key, structuredClone(value)] as [string, T]),
  };
}

describe("an action whose call is under way", () => {
  // What a facet that dies here leaves behind: a claimed action is never run again, so nothing
  // is written or filed twice. The action set is bound here, to a journal the test can read.
  for (const candidate of CASES) {
    const { kind, call } = candidate;

    it(`${kind}: is claimed in the journal until the Admin API answers`, async () => {
      const called = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<void>();
      const api = recordingTarget(ROOT, [call.name], () => {
        called.resolve();
        return answer.promise;
      });
      const journal = new ActionJournal<TaggedAction<AdminActions>>(memoryKv(), { namespace: "test" });
      const actions = ADMIN_ACTIONS.bind(
          journal, { openAdminApi: async () => api as unknown as ActionAdminApi });
      const id = await actions.submit(
          { submitAction: async () => {} } as never, candidate.kind, candidate.payload as never);
      expect(journal.get(id)?.state).toBe("pending");

      const applying = actions.apply(id);
      await called.promise;
      expect(api.calls).toEqual([call]);
      expect(journal.get(id)?.state).toBe("claimed");

      answer.resolve();
      await applying;
      expect(journal.get(id)).toBeUndefined();
      // The Admin API opened for the action was let go.
      expect(api.disposed).toBe(1);
    });
  }
});

describe("the facet's other entry points", () => {
  it("reject a pending action, which then cannot be applied", async () => {
    await withQueued(caseOf("contentAccessRequest"), async ({ facet, id }) => {
      await facet.rejectAction(id);
      expect((await rejection(apply(facet, id))).message).toBe(`Unknown pending action: ${id}`);
      expect(workshop.apis).toEqual([]);
    });
  });

  it("refuse to revert, and leave the action as it was", async () => {
    await withQueued(caseOf("contentAccessRequest"), async ({ facet, id }) => {
      expect((await rejection(facet.revertAction(id))).message)
          .toBe("The admin gatekeeper's actions cannot be reverted.");
      await apply(facet, id);
      expect(calls()).toEqual([caseOf("contentAccessRequest").call]);
    });
  });
});
