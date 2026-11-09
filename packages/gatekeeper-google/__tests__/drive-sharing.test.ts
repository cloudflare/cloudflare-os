import { ActionJournal, defineActions } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  DriveApiDisabledError, DriveApiRequestError, type DriveApi, type DrivePermissionGrant,
  type DrivePermissionRecord, type DriveScopeNode,
} from "../src/drive-api";
import type { DriveBindingScope } from "../src/drive-session";
import {
  ACCESS_NAME, ACCESS_WAITING_CHANGE, ACCESS_WAITING_REMOVE, accessOf, audienceOf,
  CHANGE_PENDING, checkAccessName, checkGrantee, checkShare, DRIVE_SHARING,
  DRIVE_SHARING_DEFINITIONS, hasPendingChange, hasPendingShare, loudOpening, matchGrantee,
  overlayPendingAccess, pendingAccess, pendingAccessRefusal, PermissionListTooLong, planShare,
  planUnshare, planUpdate, readPermissions, ROLE_RANK, sameAccessId, SHARE_BEHIND_CHANGE,
  SHARE_PENDING, toAccessEntries, type DriveSharingAction, type DriveSharingActions,
} from "../src/drive-sharing";
import type { DriveAccess, DriveGrantee, DriveShareOptions, DriveShareRole } from "../src/drive-types";
import {
  CREDENTIALS_NOT_ACCEPTED, WRITES_GRANT_MISSING, type DriveActor, type DriveWritesHost,
  type QueuedWrite, type WriteAttempt,
} from "../src/drive-writes";
import { FakeKv } from "./fake-kv";

const FILE = "doc-1";
const TARGET = { fileId: FILE, fileName: "Plan.pdf" };
const KIND = { tag: "driveSharing", label: "Drive sharing" };

const OWNER_ID = "11111111111111111111";
const BOB_ID = "22222222222222222222";
const CAROL_ID = "33333333333333333333";
const DANA_ID = "44444444444444444444";
const ERIN_ID = "55555555555555555555";
const DOMAIN_ID = "66666666666666666666";
const TEAM_ID = "77777777777777777777";

/** The connected account: the file's owner, at `example.com`. */
const ME: DriveActor = { permissionId: OWNER_ID, emailAddress: "me@example.com" };
/** The same account as Drive would give it with no address. */
const NAMELESS: DriveActor = { permissionId: OWNER_ID };
const MESSAGE = "For your review.";

const OWN_ACCESS = "The connected account's own access cannot be changed here.";
const OWNER_OR_MANAGER =
  "An owner's, manager's or content manager's access cannot be changed here.";
const INHERITED_ONLY =
  "That access comes from a parent folder or the shared drive, not from this file, so it cannot " +
  "be changed here. share() can give a higher role on this file; the access itself is changed " +
  "where it comes from.";
const SPENT =
  "That pending ID names no access waiting for approval. If it was given, list the file's " +
  "access again and use its Drive ID.";
const OUT_OF_SCOPE = "That file is no longer in this connection's scope.";
const CANNOT_SHARE = "The connected account can no longer change who has access to that file.";
const GRANTEE_CHANGED =
  "That grantee's access to this file changed after this was queued, so nothing was changed.";
const ACCESS_GONE = "That access is no longer on this file.";
const ACCESS_CHANGED = "That access changed after this was queued, so nothing was changed.";
const CHANGED_AGAIN =
  "This was changed again on Google Drive after it was first sent, so it was left as it is. " +
  "Check the file, then reject this to clear it.";
const NOT_SHOWN =
  "Google Drive no longer shows this file's sharing to the connected account, so whether this " +
  "change was made can't be checked, and it won't be sent again. Reject it to clear it.";
const UNCONFIRMED =
  "Google Drive did not confirm whether this change was made, and it may have been. Approving " +
  "it again first checks the file, so it is not made twice; rejecting it leaves anything " +
  "already changed as it is.";
const RATE_LIMITED =
  "Google Drive is limiting requests from this account. Approve it again in a minute.";
const TOO_LONG = "This file is shared with more people than can be listed here.";
const CANNOT_DELETE =
  "Google does not let the connected account remove that access. Access that comes from a " +
  "parent folder is removed on that folder. [http=403 reason=cannotDeletePermission]";

type Role = DrivePermissionRecord["role"];
type Detail = DrivePermissionRecord["details"][number];

const given = (role: Role): Detail => ({ role, inherited: false });
const inherited = (role: Role, inheritedFrom?: string): Detail =>
  ({ role, inherited: true, ...(inheritedFrom ? { inheritedFrom } : {}) });

/** A person's permission, as Drive lists one: its role is the highest of its details. */
function person(
  id: string, name: string, details: Detail[], overrides: Partial<DrivePermissionRecord> = {},
): DrivePermissionRecord {
  let role = details.reduce((top, detail) =>
    ROLE_ORDER.indexOf(detail.role) > ROLE_ORDER.indexOf(top) ? detail.role : top, details[0].role);
  return {
    id, type: "user", role, emailAddress: `${name.toLowerCase()}@example.com`,
    displayName: `${name} Example`, deleted: false, details, ...overrides,
  };
}

const ROLE_ORDER: readonly Role[] =
  ["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"];

// Shaped as Drive lists them: the owner of a file inside their own folder, a direct grant,
// an inherited one, and one permission with both.
const owner = () => person(OWNER_ID, "Me", [inherited("writer"), given("owner")]);
const bob = (...details: Detail[]) =>
  person(BOB_ID, "Bob", details.length ? details : [given("reader")]);
const carol = () => person(CAROL_ID, "Carol", [inherited("commenter")]);
const dana = () => person(DANA_ID, "Dana", [inherited("commenter"), given("writer")]);
/** A link as Drive lists it: `anyoneWithLink`, or `anyone` once it can be found by searching. */
function link(role: Role = "reader", searchable = false): DrivePermissionRecord {
  return {
    id: searchable ? "anyone" : "anyoneWithLink", type: "anyone", role,
    allowFileDiscovery: searchable, deleted: false, details: [given(role)],
  };
}
/** A shared drive's member who also has a folder's access: two inherited details. */
const erin = () =>
  person(ERIN_ID, "Erin", [inherited("reader", "drive-1"), inherited("writer", "folder-1")]);
/** A domain's permission, given on the file. */
function wholeDomain(
  domain = "example.com", searchable = false, id = DOMAIN_ID,
): DrivePermissionRecord {
  return {
    id, type: "domain", role: "reader", domain, displayName: "Example Org",
    allowFileDiscovery: searchable, deleted: false, details: [given("reader")],
  };
}
/** A group's permission, given on the file. */
function team(): DrivePermissionRecord {
  return {
    id: TEAM_ID, type: "group", role: "reader", emailAddress: "team@example.com",
    displayName: "Team Example", deleted: false, details: [given("reader")],
  };
}

const fixtures = () => [owner(), bob(), carol(), dana(), link(), erin()];

/** One undecided write, as the binding's queue hands it out. */
function queued<K extends keyof DriveSharingActions>(
  id: number, kind: K, payload: DriveSharingActions[K],
): QueuedWrite {
  return { id, action: { kind, payload } };
}

/** A share as the session queues it: the checked call and what the plan adds. */
function shareOf(
  grantee: DriveGrantee, role: DriveShareRole, options?: DriveShareOptions,
  permissions: DrivePermissionRecord[] = fixtures(), actor: DriveActor = ME,
): DriveSharingActions["createPermission"] {
  return {
    ...TARGET, ...checkShare(grantee, options), role,
    ...planShare(FILE, permissions, actor, grantee, role, []),
  };
}

/** A role change as the session queues it. */
function roleChangeOf(
  permissions: DrivePermissionRecord[], access: string | DriveGrantee, role: DriveShareRole,
  actor: DriveActor = ME,
): DriveSharingActions["updatePermission"] {
  return { ...TARGET, ...planUpdate(permissions, actor, access, role) };
}

/** A removal as the session queues it. */
function removalOf(
  permissions: DrivePermissionRecord[], access: string | DriveGrantee, actor: DriveActor = ME,
): DriveSharingActions["deletePermission"] {
  return { ...TARGET, ...planUnshare(permissions, actor, access) };
}

const ZOE: DriveGrantee = { type: "user", emailAddress: "zoe@example.com" };

/** What a thrown error says, or `undefined` when nothing was thrown. */
function thrownBy(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

/** Drive's answer to a send whose outcome it leaves open. */
const unconfirmed = () => new DriveApiRequestError(503, "backendError");

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected call");
};

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Drive's permissions of each file, answering a write as Google answers one: a
 * create only raises and only widens, a role set to exactly what a parent gives leaves nothing
 * on the file, and access a parent also gives is neither lowered below it nor deleted.
 */
class FakeDrive {
  #files = new Map<string, DrivePermissionRecord[]>();
  #nextId = 90000000000000000000n;

  /** Replaces what Drive holds for `fileId`. */
  set(fileId: string, permissions: DrivePermissionRecord[]): void {
    this.#files.set(fileId, structuredClone(permissions));
  }

  /** What Drive holds for `fileId`, as a list read returns it. */
  get(fileId: string): DrivePermissionRecord[] {
    return structuredClone(this.#list(fileId));
  }

  #list(fileId: string): DrivePermissionRecord[] {
    let list = this.#files.get(fileId);
    if (!list) throw new DriveApiRequestError(404, "notFound");
    return list;
  }

  #find(fileId: string, permissionId: string): DrivePermissionRecord {
    let anyone = ["anyone", "anyoneWithLink"];
    let held = this.#list(fileId).find(listed => listed.id === permissionId ||
      (anyone.includes(listed.id) && anyone.includes(permissionId)));
    if (!held) throw new DriveApiRequestError(404, "notFound");
    return held;
  }

  static #setGiven(permission: DrivePermissionRecord, role: Role | undefined): void {
    let details = permission.details.filter(detail => detail.inherited);
    if (role !== undefined) details.push(given(role));
    permission.details = details;
    permission.role = details.reduce((top, detail) =>
      ROLE_ORDER.indexOf(detail.role) > ROLE_ORDER.indexOf(top) ? detail.role : top,
    details[0].role);
  }

  create(fileId: string, grant: DrivePermissionGrant): DrivePermissionRecord {
    let list = this.#list(fileId);
    let held = list.find(listed => grant.type === "anyone" ? listed.type === "anyone"
      : grant.type === "domain" ? listed.type === "domain" && listed.domain === grant.domain
      : (listed.type === "user" || listed.type === "group") &&
        listed.emailAddress?.toLowerCase() === grant.emailAddress?.toLowerCase());
    if (!held) {
      let reach = grant.type === "domain" || grant.type === "anyone";
      let id = grant.type !== "anyone" ? String(this.#nextId++)
        : grant.allowFileDiscovery ? "anyone" : "anyoneWithLink";
      held = {
        id, type: grant.type, role: grant.role,
        ...(grant.emailAddress ? { emailAddress: grant.emailAddress } : {}),
        ...(grant.domain ? { domain: grant.domain } : {}),
        ...(reach ? { allowFileDiscovery: grant.allowFileDiscovery === true } : {}),
        deleted: false, details: [given(grant.role)],
      };
      list.push(held);
      return structuredClone(held);
    }
    if (grant.allowFileDiscovery && held.allowFileDiscovery === false) {
      held.allowFileDiscovery = true;
      if (held.type === "anyone") held.id = "anyone";
    }
    if (ROLE_ORDER.indexOf(grant.role) > ROLE_ORDER.indexOf(held.role)) {
      FakeDrive.#setGiven(held, grant.role);
    }
    return structuredClone(held);
  }

  update(fileId: string, permissionId: string, role: Role): DrivePermissionRecord {
    let held = this.#find(fileId, permissionId);
    let above = held.details.filter(detail => detail.inherited)
      .map(detail => ROLE_ORDER.indexOf(detail.role));
    let parent = above.length ? Math.max(...above) : -1;
    if (ROLE_ORDER.indexOf(role) < parent) {
      throw new DriveApiRequestError(403, "cannotModifyInheritedPermission");
    }
    FakeDrive.#setGiven(held, ROLE_ORDER.indexOf(role) === parent ? undefined : role);
    return structuredClone(held);
  }

  delete(fileId: string, permissionId: string): void {
    let held = this.#find(fileId, permissionId);
    if (held.details.some(detail => detail.inherited)) {
      throw new DriveApiRequestError(403, "cannotDeletePermission");
    }
    let list = this.#list(fileId);
    list.splice(list.indexOf(held), 1);
  }
}

/** The sharing definitions as a set of their own; the gatekeeper binds them among the others. */
const SHARING_ACTIONS = defineActions<DriveWritesHost, DriveSharingActions>(
  DRIVE_SHARING_DEFINITIONS, { fence: "none", vendorId: "google" });

/** The sharing set bound over an in-memory journal, with a host and a Drive a test can steer. */
/** The Docs API, through which no sharing change or move is sent. */
const NO_DOCS: DriveWritesHost["docs"] = {
  getDocumentWithSuggestions: async () => { throw new Error("Unexpected call"); },
  getRevisionId: async () => { throw new Error("Unexpected call"); },
  insertComment: async () => { throw new Error("Unexpected call"); },
  suggest: async () => { throw new Error("Unexpected call"); },
  replyToSuggestion: async () => { throw new Error("Unexpected call"); },
};

function harness(permissions: DrivePermissionRecord[] = fixtures()) {
  let drive = new FakeDrive();
  drive.set(FILE, permissions);
  let attempts = new Map<number, WriteAttempt>();
  let refused: string | undefined;
  let scope: DriveBindingScope = { kind: "account" };
  let described: ActionDescription | undefined;
  let api = {
    getScopeNodes: vi.fn<DriveApi["getScopeNodes"]>(
      async ids => ids.map((id): DriveScopeNode => ({ id, canShare: true }))),
    listPermissions: vi.fn<DriveApi["listPermissions"]>(
      async fileId => ({ permissions: drive.get(fileId) })),
    createPermission: vi.fn<DriveApi["createPermission"]>(
      async (fileId, grant) => drive.create(fileId, grant)),
    updatePermission: vi.fn<DriveApi["updatePermission"]>(
      async (fileId, permissionId, role) => drive.update(fileId, permissionId, role)),
    deletePermission: vi.fn<DriveApi["deletePermission"]>(
      async (fileId, permissionId) => { drive.delete(fileId, permissionId); }),
    getComment: vi.fn<DriveApi["getComment"]>(unexpected),
    listComments: vi.fn<DriveApi["listComments"]>(unexpected),
    listReplies: vi.fn<DriveApi["listReplies"]>(unexpected),
    createComment: vi.fn<DriveApi["createComment"]>(unexpected),
    createReply: vi.fn<DriveApi["createReply"]>(unexpected),
    swapParent: vi.fn<DriveApi["swapParent"]>(unexpected),
  };
  let host: DriveWritesHost = {
    api,
    docs: NO_DOCS,
    scope: () => scope,
    writeRefusal: async () => refused,
    attempts: {
      get: id => attempts.get(id),
      put: (id, attempt) => { attempts.set(id, attempt); },
      delete: id => { attempts.delete(id); },
    },
  };
  let journal = new ActionJournal<DriveSharingAction>(new FakeKv(), { namespace: "drive" });
  let actions = SHARING_ACTIONS.bind(journal, host);
  let queue = {
    submitAction: async (_id: number, description: ActionDescription) => { described = description; },
  };
  let submit = <K extends keyof DriveSharingActions>(kind: K, payload: DriveSharingActions[K]) =>
    actions.submit(queue, kind, payload);
  return {
    api, host, drive, journal, actions, attempts, submit,
    /** Submits one change and returns what its approval shows. */
    async card<K extends keyof DriveSharingActions>(
      kind: K, payload: DriveSharingActions[K],
    ): Promise<ActionDescription> {
      await submit(kind, payload);
      if (!described) throw new Error("nothing was described");
      return described;
    },
    /** Applies an action, answering `null` when it applied and the failure's message otherwise. */
    apply: (id: number): Promise<string | null> =>
      actions.apply(id).then(() => null, (error: Error) => error.message),
    /** Sets what the binding's write refusal answers from here on. */
    refuse(message: string | undefined): void { refused = message; },
    /** Sets the binding's scope from here on. */
    bind(next: DriveBindingScope): void { scope = next; },
    /** How many requests that change something were made. */
    sends: () => api.createPermission.mock.calls.length + api.updatePermission.mock.calls.length +
      api.deletePermission.mock.calls.length,
    /** Makes the next create change Drive and then reject with `error`, as a lost reply does. */
    loseCreate(error: Error = unconfirmed()): void {
      api.createPermission.mockImplementationOnce(async (fileId, grant) => {
        drive.create(fileId, grant);
        throw error;
      });
    },
    /** The same for the next role update. */
    loseUpdate(error: Error = unconfirmed()): void {
      api.updatePermission.mockImplementationOnce(async (fileId, permissionId, role) => {
        drive.update(fileId, permissionId, role);
        throw error;
      });
    },
    /** The same for the next delete. */
    loseDelete(error: Error = unconfirmed()): void {
      api.deletePermission.mockImplementationOnce(async (fileId, permissionId) => {
        drive.delete(fileId, permissionId);
        throw error;
      });
    },
  };
}

/** Whether the record failed for good, and how: `undefined` while it can still be applied. */
function failure(journal: ActionJournal<DriveSharingAction>, id: number) {
  let record = journal.get(id);
  return record?.state === "failed" ? { error: record.error, outcome: record.outcome } : undefined;
}

/** A permission list of `count` pages, one permission a page. */
function pagedList(count: number) {
  return vi.fn<DriveApi["listPermissions"]>(async (_fileId, options) => {
    let page = Number(options?.pageToken ?? 0);
    return {
      permissions: [person(String(page), `P${page}`, [given("reader")])],
      ...(page + 1 < count ? { nextPageToken: String(page + 1) } : {}),
    };
  });
}

// Cast past the types, as untyped gadget code would send it.
const loose = (value: object) => value as DriveGrantee;
const looseOptions = (value: object) => value as DriveShareOptions;

const noOption = (key: string) => `share() has no option ${key}. Its options are notify, ` +
  "message and discoverable: access given here does not expire, and ownership is not " +
  "transferred.";

/** The refusal a share meets when it is planned, or `undefined` when it is planned. */
const shareRefusal = (
  grantee: DriveGrantee, role: DriveShareRole, permissions = fixtures(),
  pending: QueuedWrite[] = [], actor = ME,
) => thrownBy(() => planShare(FILE, permissions, actor, grantee, role, pending));

const noHigherRole = (role: string) =>
  `That grantee already has ${role} access to this file through a parent, which this would not ` +
  "change. No higher role can be given here; the access itself is changed where it comes from.";

const CHANGE = (whom: string, from: string, to: string, noun = "file") =>
  `Change the role of access given to ${whom} from \`${from}\` to \`${to}\` on Google Drive ` +
  `${noun} \`doc-1\`, as the connected account.`;
const REMOVE = (whom: string, noun = "file") =>
  `Remove access given to ${whom} on Google Drive ${noun} \`doc-1\`, as the connected account.`;

/** Zoe's permission, as Drive lists it once she has access. */
const zoe = (...details: Detail[]) => person("12121212121212121212", "Zoe", details);
const shareZoe = (): DriveSharingAction =>
  ({ kind: "createPermission", payload: shareOf(ZOE, "writer") });
/** A raise to `writer` of the access `id` names, queued over the permissions handed in. */
const raiseOf = (id: string) => (permissions: DrivePermissionRecord[]): DriveSharingAction =>
  ({ kind: "updatePermission", payload: roleChangeOf(permissions, id, "writer") });
/** A removal of the access `id` names, queued over the permissions handed in. */
const removeOf = (id: string) => (permissions: DrivePermissionRecord[]): DriveSharingAction =>
  ({ kind: "deletePermission", payload: removalOf(permissions, id) });
const raiseBob = raiseOf(BOB_ID);
const removeBob = removeOf(BOB_ID);

/** Google's answer to a token it no longer accepts. */
const expiredToken = () => new DriveApiRequestError(401, "authError");

/**
 * Sends `action` once with nothing changed, sets Drive to `since`, approves again, and expects
 * the outcome to be left unknown with nothing sent a second time.
 */
async function approveAgain(
  listed: DrivePermissionRecord[], action: DriveSharingAction, since: DrivePermissionRecord[],
): Promise<void> {
  let run = harness(listed);
  let send = action.kind === "createPermission" ? run.api.createPermission
    : action.kind === "updatePermission" ? run.api.updatePermission : run.api.deletePermission;
  send.mockRejectedValueOnce(unconfirmed());
  let id = await run.submit(action.kind, action.payload);
  expect(await run.apply(id)).toBe(UNCONFIRMED);
  run.drive.set(FILE, since);
  expect(await run.apply(id)).toBe(CHANGED_AGAIN);
  expect(failure(run.journal, id)).toEqual({ error: CHANGED_AGAIN, outcome: "unknown" });
  // Never sent again, and the marker of an unknown outcome is left where it is.
  expect(run.sends()).toBe(1);
  expect(run.attempts.has(id)).toBe(true);
  expect(run.drive.get(FILE)).toEqual(since);
  // A second approval is answered from what the record stored.
  expect(await run.apply(id)).toBe(CHANGED_AGAIN);
  expect(run.sends()).toBe(1);
}

describe("Drive access entries", () => {
  it("lists one entry per way of access, and marks the account's own", () => {
    let gone = person("88888888888888888888", "Gone", [given("reader")], { deleted: true });
    let me = { id: OWNER_ID, type: "user", emailAddress: "me@example.com", displayName: "Me Example" };
    let danaEntry = {
      id: DANA_ID, type: "user", emailAddress: "dana@example.com", displayName: "Dana Example",
    };
    let erinEntry = {
      id: ERIN_ID, type: "user", emailAddress: "erin@example.com", displayName: "Erin Example",
    };
    let entries = toAccessEntries([...fixtures(), gone], OWNER_ID);
    // Strict, so an `undefined` key or a `me` key on anyone else's entry fails.
    expect(entries).toStrictEqual([
      { ...me, role: "writer", me: true, inherited: true },
      { ...me, role: "owner", me: true },
      {
        id: BOB_ID, type: "user", role: "reader", emailAddress: "bob@example.com",
        displayName: "Bob Example",
      },
      {
        id: CAROL_ID, type: "user", role: "commenter", emailAddress: "carol@example.com",
        displayName: "Carol Example", inherited: true,
      },
      { ...danaEntry, role: "commenter", inherited: true },
      { ...danaEntry, role: "writer" },
      { id: "anyoneWithLink", type: "anyone", role: "reader", discoverable: false },
      // Both inherited, in Drive's order, each with its own source.
      { ...erinEntry, role: "reader", inherited: true, inheritedFrom: "drive-1" },
      { ...erinEntry, role: "writer", inherited: true, inheritedFrom: "folder-1" },
    ]);
    for (let entry of entries) {
      expect(entry).not.toHaveProperty("email");
      expect(entry).not.toHaveProperty("name");
    }

    // The rules that compare roles ask for the higher of her two inherited ones.
    expect(accessOf(erin())).toEqual({ inherited: "writer" });
    expect(accessOf(dana())).toEqual({ direct: "writer", inherited: "commenter" });
    expect(accessOf(bob())).toEqual({ direct: "reader" });

    // With a role also given on the file, a third entry follows the inherited two.
    let both = person(ERIN_ID, "Erin", [
      inherited("reader", "drive-1"), given("writer"), inherited("writer", "folder-1"),
    ]);
    expect(toAccessEntries([both], OWNER_ID)).toStrictEqual([
      { ...erinEntry, role: "reader", inherited: true, inheritedFrom: "drive-1" },
      { ...erinEntry, role: "writer", inherited: true, inheritedFrom: "folder-1" },
      { ...erinEntry, role: "writer" },
    ]);

    // Only a user's permission is the account's own, whatever ID another kind carries.
    expect(toAccessEntries([{ ...team(), id: OWNER_ID }], OWNER_ID)[0]).not.toHaveProperty("me");
    // A domain's entry carries its domain and whether it is found by searching.
    expect(toAccessEntries([wholeDomain("example.com", true)], OWNER_ID)).toStrictEqual([{
      id: DOMAIN_ID, type: "domain", role: "reader", domain: "example.com",
      displayName: "Example Org", discoverable: true,
    }]);
  });

  it("ranks roles lowest first", () => {
    expect(Object.entries(ROLE_RANK).toSorted(([, a], [, b]) => a - b).map(([role]) => role))
      .toEqual(ROLE_ORDER);
  });

  it("reads every page, and gives up past ten or on a token handed back twice", async () => {
    let ten = pagedList(10);
    let read = await readPermissions({ listPermissions: ten }, FILE);
    expect(read.map(permission => permission.id)).toEqual(
      Array.from({ length: 10 }, (_, page) => String(page)));
    expect(ten.mock.calls).toEqual([
      [FILE, {}], ...Array.from({ length: 9 }, (_, page) => [FILE, { pageToken: String(page + 1) }]),
    ]);

    let eleven = pagedList(11);
    let tooLong = await readPermissions({ listPermissions: eleven }, FILE).catch(error => error);
    expect(tooLong).toBeInstanceOf(PermissionListTooLong);
    expect(tooLong.message).toBe(TOO_LONG);
    expect(eleven).toHaveBeenCalledTimes(10);

    let looping = vi.fn<DriveApi["listPermissions"]>(
      async () => ({ permissions: [], nextPageToken: "again" }));
    await expect(readPermissions({ listPermissions: looping }, FILE)).rejects.toThrow(TOO_LONG);
    expect(looping).toHaveBeenCalledTimes(2);
  });
});

describe("Drive sharing arguments", () => {
  it("checks a grantee and its options, and refuses a key it does not know", () => {
    expect(checkGrantee({ type: "user", emailAddress: "  Bob@Example.com " }))
      .toStrictEqual({ type: "user", emailAddress: "Bob@Example.com" });
    expect(checkGrantee({ type: "domain", domain: " Example.COM " }))
      .toStrictEqual({ type: "domain", domain: "example.com" });
    expect(checkGrantee({ type: "anyone" })).toStrictEqual({ type: "anyone" });
    for (let emailAddress of [
      "bob", "bob@", "@example.com", "a@b@c", "bob smith@example.com", `${"x".repeat(250)}@y.zz`,
    ]) {
      expect(thrownBy(() => checkGrantee({ type: "user", emailAddress })), emailAddress)
        .toBe("Not an email address.");
      expect(thrownBy(() => checkGrantee({ type: "group", emailAddress })), emailAddress)
        .toBe("Not an email address.");
    }
    expect(checkGrantee({ type: "user", emailAddress: `${"x".repeat(249)}@y.zz` }).type).toBe("user");
    for (let domain of ["example", "exa mple.com", "example..com", ".com", "exa_mple.com", ""]) {
      expect(thrownBy(() => checkGrantee({ type: "domain", domain })), domain)
        .toBe("Not a domain name.");
    }

    let bobAsUser: DriveGrantee = { type: "user", emailAddress: "x@y.z" };
    expect(thrownBy(() => checkShare({ type: "anyone" }, { notify: false })))
      .toBe("notify applies only to a user or a group.");
    expect(thrownBy(() => checkShare({ type: "domain", domain: "example.com" }, { notify: true })))
      .toBe("notify applies only to a user or a group.");
    expect(thrownBy(() => checkShare({ type: "anyone" }, { message: "Hi" })))
      .toBe("message applies only to a user or a group that is emailed.");
    expect(thrownBy(() => checkShare(bobAsUser, { notify: false, message: "Hi" })))
      .toBe("message applies only to a user or a group that is emailed.");
    expect(thrownBy(() => checkShare(bobAsUser, { message: " \n " }))).toBe("The message is empty.");
    expect(thrownBy(() => checkShare(bobAsUser, { message: "x".repeat(1001) })))
      .toBe("The message is 1001 characters; at most 1000 are sent.");
    expect(thrownBy(() => checkShare(bobAsUser, { discoverable: true })))
      .toBe("discoverable applies only to a domain or to anyone.");
    expect(thrownBy(() => checkShare({ type: "user", emailAddress: "nope" }, { expires: 1 } as object)))
      .toBe("Not an email address.");

    expect(checkShare(bobAsUser, { notify: true, message: "x".repeat(1000) }))
      .toStrictEqual({ grantee: bobAsUser, message: "x".repeat(1000) });
    // The limit counts characters, not UTF-16 units: an emoji is two units and one character.
    let emoji = "\u{1F600}";
    expect(emoji).toHaveLength(2);
    expect(checkShare(bobAsUser, { message: emoji.repeat(1000) }))
      .toStrictEqual({ grantee: bobAsUser, message: emoji.repeat(1000) });
    expect(thrownBy(() => checkShare(bobAsUser, { message: emoji.repeat(1001) })))
      .toBe("The message is 1001 characters; at most 1000 are sent.");
    expect(checkShare(bobAsUser, { notify: false })).toStrictEqual({ grantee: bobAsUser, notify: false });
    expect(checkShare({ type: "anyone" }, { discoverable: true }))
      .toStrictEqual({ grantee: { type: "anyone" }, discoverable: true });
    expect(checkShare({ type: "domain", domain: "Example.com" }, { discoverable: false }))
      .toStrictEqual({ grantee: { type: "domain", domain: "example.com" } });
    expect(checkShare(bobAsUser, undefined)).toStrictEqual({ grantee: bobAsUser });

    expect(thrownBy(() => checkShare({ type: "anyone" }, looseOptions({ expirationTime: "2027-01-01" }))))
      .toBe(noOption("expirationTime"));
    expect(thrownBy(() => checkShare(bobAsUser, looseOptions({ transferOwnership: true }))))
      .toBe(noOption("transferOwnership"));
    // No message carries an arbitrary string.
    expect(thrownBy(() => checkShare(bobAsUser, looseOptions({ ["k".repeat(40)]: 1 }))))
      .toBe(noOption("that key"));
    expect(thrownBy(() => checkShare(bobAsUser, looseOptions({ "a b": 1 }))))
      .toBe(noOption("that key"));

    expect(thrownBy(() => checkGrantee(loose({ type: "anyone", emailAddress: "x@y.z" }))))
      .toBe("A grantee of type anyone has no emailAddress.");
    expect(thrownBy(() => checkGrantee(loose({ type: "user", emailAddress: "x@y.z", id: "1" }))))
      .toBe("A grantee of type user has no id.");
    expect(thrownBy(() => checkGrantee(loose({ type: "user", emailAddress: "x@y.z", email: "x@y.z" }))))
      .toBe("A grantee of type user has no email.");
    expect(thrownBy(() => checkGrantee(loose({ type: "domain", domain: "y.z", emailAddress: "x@y.z" }))))
      .toBe("A grantee of type domain has no emailAddress.");
    expect(thrownBy(() => checkGrantee(loose({ type: "group", emailAddress: "x@y.z", "a b": 1 }))))
      .toBe("A grantee of type group has no that key.");

    // A key whose value is `undefined` is none: the RPC carries one for a copied field.
    expect(checkGrantee(loose({ type: "user", emailAddress: "x@y.z", domain: undefined })))
      .toStrictEqual({ type: "user", emailAddress: "x@y.z" });
    expect(checkShare(bobAsUser, { message: undefined, discoverable: undefined }))
      .toStrictEqual({ grantee: bobAsUser });
    expect(checkShare({ type: "anyone" }, looseOptions({ notify: undefined, expirationTime: undefined })))
      .toStrictEqual({ grantee: { type: "anyone" } });
    expect(checkAccessName(loose({ id: undefined, type: "anyone" }))).toStrictEqual({ type: "anyone" });
  });

  it("says what names access when handed an entry or an address", () => {
    expect(ACCESS_NAME).toBe(
      "That does not name access. Pass the id of an entry listAccess() returned, or a grantee: " +
      "{ type: \"user\", emailAddress }, { type: \"group\", emailAddress }, " +
      "{ type: \"domain\", domain } or { type: \"anyone\" }.");
    let entry: DriveAccess = { id: "1", type: "user", role: "reader", emailAddress: "bob@example.com" };
    for (let named of [
      thrownBy(() => checkAccessName("bob@example.com")),
      thrownBy(() => checkAccessName(loose(entry))),
    ]) {
      expect(named).toBe(ACCESS_NAME);
    }
    // The message echoes nothing the caller passed.
    expect(ACCESS_NAME).not.toContain("bob@example.com");
    expect(ACCESS_NAME).not.toContain("\"1\"");

    expect(thrownBy(() => checkAccessName("a/b"))).toBe("Not a Google Drive access ID.");
    expect(thrownBy(() => checkAccessName("pending:4"))).toBe("Not a Google Drive access ID.");
    expect(checkAccessName("anyoneWithLink")).toBe("anyoneWithLink");
    expect(checkAccessName("12345")).toBe("12345");
    expect(checkAccessName({ type: "group", emailAddress: " Team@Example.com " }))
      .toStrictEqual(checkGrantee({ type: "group", emailAddress: " Team@Example.com " }));
    expect(thrownBy(() => checkAccessName({ type: "user", emailAddress: "nope" })))
      .toBe("Not an email address.");
  });

  it("matches a grantee whichever of person and group was said", () => {
    let permissions = [owner(), team(), link(), wholeDomain()];
    expect(matchGrantee(permissions, { type: "user", emailAddress: "Team@Example.com" }))
      .toEqual([team()]);
    expect(matchGrantee(permissions, { type: "group", emailAddress: "team@example.com" }))
      .toEqual([team()]);
    expect(matchGrantee(permissions, { type: "group", emailAddress: "ME@example.com" }))
      .toEqual([owner()]);
    expect(matchGrantee(permissions, { type: "domain", domain: "EXAMPLE.com" }))
      .toEqual([wholeDomain()]);
    expect(matchGrantee(permissions, { type: "domain", domain: "partner.example" })).toEqual([]);

    // A permission Drive lists without an address matches no address.
    let { emailAddress: _hidden, ...hidden } = bob();
    expect(matchGrantee([hidden], { type: "user", emailAddress: "bob@example.com" })).toEqual([]);
    expect(matchGrantee([hidden], { type: "user" })).toEqual([]);
    // Nor does one whose account was deleted.
    expect(matchGrantee([{ ...bob(), deleted: true }], { type: "user", emailAddress: "bob@example.com" }))
      .toEqual([]);

    // A file's one `anyone` permission, under whichever ID its form gives.
    expect(matchGrantee(permissions, { type: "anyone" })).toEqual([link()]);
    expect(matchGrantee([owner(), link("reader", true)], { type: "anyone" }))
      .toEqual([link("reader", true)]);
  });

  it("takes Drive's two IDs for anyone's access as one", () => {
    expect(sameAccessId("anyone", "anyoneWithLink")).toBe(true);
    expect(sameAccessId("anyoneWithLink", "anyone")).toBe(true);
    for (let id of ["anyone", "anyoneWithLink", BOB_ID]) expect(sameAccessId(id, id)).toBe(true);
    expect(sameAccessId("anyone", "12345")).toBe(false);
    expect(sameAccessId(BOB_ID, CAROL_ID)).toBe(false);
  });
});

describe("Drive sharing plans", () => {
  const BOB: DriveGrantee = { type: "user", emailAddress: "bob@example.com" };
  const CAROL: DriveGrantee = { type: "user", emailAddress: "carol@example.com" };
  const DANA: DriveGrantee = { type: "user", emailAddress: "dana@example.com" };
  const DOMAIN_UPDATE =
    " updateAccess(), which takes the same grantee, changes its role. Whether it can be found " +
    "by searching is set when access is given: to change that, unshare() it and, once that is " +
    "approved, share() again.";
  it("plans a share against who already has access", () => {
    let direct = "That grantee already has reader access given on this file itself. Change it " +
      "with updateAccess(), which takes the same grantee.";
    expect(shareRefusal(BOB, "writer")).toBe(direct);
    expect(direct).not.toContain("searching");

    // A listing leaves out access whose removal waits, so the refusal does not name it as there.
    expect(SHARE_BEHIND_CHANGE).toBe(
      "That grantee's access has a change waiting for approval. Once it is decided, share again " +
      "if the access was removed, or change its role with updateAccess().");
    for (let waiting of [
      queued(3, "deletePermission", removalOf(fixtures(), BOB_ID)),
      queued(3, "updatePermission", roleChangeOf(fixtures(), BOB_ID, "commenter")),
    ]) {
      expect(shareRefusal(BOB, "writer", fixtures(), [waiting])).toBe(SHARE_BEHIND_CHANGE);
    }
    // One that waits for another file says nothing of this one.
    let elsewhere = queued(3, "deletePermission", { ...removalOf(fixtures(), BOB_ID), fileId: "doc-2" });
    expect(shareRefusal(BOB, "writer", fixtures(), [elsewhere])).toBe(direct);

    let parent = "That grantee already has commenter access to this file through a parent, which " +
      "this would not change. Give a higher role, or change the sharing of the folder it comes " +
      "from.";
    expect(shareRefusal(CAROL, "reader")).toBe(parent);
    expect(shareRefusal(CAROL, "commenter")).toBe(parent);
    expect(planShare(FILE, fixtures(), ME, CAROL, "writer", []))
      .toStrictEqual({ inheritedRole: "commenter" });
    expect(planShare(FILE, fixtures(), ME, ZOE, "reader", [])).toStrictEqual({});

    // Dana has access on the file and from a parent: what is on the file is said first, and so
    // is a change of it that waits, also at the roles the parent's access alone would refuse.
    let both = "That grantee already has writer access given on this file itself. Change it " +
      "with updateAccess(), which takes the same grantee.";
    for (let role of ["reader", "commenter", "writer"] as const) {
      expect(shareRefusal(DANA, role), role).toBe(both);
      expect(shareRefusal(DANA, role, fixtures(), [
        queued(3, "deletePermission", removalOf(fixtures(), DANA_ID)),
      ]), role).toBe(SHARE_BEHIND_CHANGE);
    }

    // A domain's and anyone's refusal also says what updateAccess() does not change.
    expect(shareRefusal({ type: "anyone" }, "writer"))
      .toBe(`That grantee already has reader access given on this file itself.${DOMAIN_UPDATE}`);
    expect(shareRefusal({ type: "domain", domain: "example.com" }, "writer", [owner(), wholeDomain()]))
      .toBe(`That grantee already has reader access given on this file itself.${DOMAIN_UPDATE}`);

    expect(shareRefusal({ type: "user", emailAddress: "ME@Example.com" }, "reader")).toBe(OWN_ACCESS);
    expect(shareRefusal({ type: "group", emailAddress: "me@example.com" }, "reader")).toBe(OWN_ACCESS);
    // An address a group's permission holds, asked for as a person's.
    expect(shareRefusal({ type: "user", emailAddress: "team@example.com" }, "writer", [owner(), team()]))
      .toBe(direct);

    // Erin's two inherited roles: the higher one counts, and nothing here tops it.
    let erinRefusal = shareRefusal({ type: "user", emailAddress: "erin@example.com" }, "writer");
    expect(erinRefusal).toBe(noHigherRole("writer"));
    expect(erinRefusal).not.toContain("Give a higher role");
    let manager = person("99999999999999999999", "Max", [inherited("organizer", "drive-1")]);
    expect(shareRefusal({ type: "user", emailAddress: "max@example.com" }, "reader", [owner(), manager]))
      .toBe(noHigherRole("organizer"));
  });

  it("tells a share to an owner or a manager that their access cannot be changed", () => {
    let asBob: DriveActor = { permissionId: BOB_ID, emailAddress: "bob@example.com" };
    let contentManager = person("99999999999999999999", "Max", [given("fileOrganizer")]);
    let permissions = [owner(), bob(given("writer")), contentManager];
    expect(shareRefusal({ type: "user", emailAddress: "me@example.com" }, "reader", permissions, [], asBob))
      .toBe(OWNER_OR_MANAGER);
    expect(shareRefusal({ type: "user", emailAddress: "max@example.com" }, "reader", permissions, [], asBob))
      .toBe(OWNER_OR_MANAGER);
    // Nothing is compared with an address the account does not have.
    expect(shareRefusal({ type: "user", emailAddress: "me@example.com" }, "reader", fixtures(), [], NAMELESS))
      .toBe(OWNER_OR_MANAGER);
  });

  it("flags what is outside the account's domain, and nothing for a personal account", () => {
    let outside: DriveGrantee = { type: "user", emailAddress: "Zed@Partner.Example" };
    expect(audienceOf(ME, outside, undefined)).toStrictEqual({ outsideDomain: "example.com" });
    expect(audienceOf(ME, { type: "group", emailAddress: "all@partner.example" }, undefined))
      .toStrictEqual({ outsideDomain: "example.com" });
    expect(audienceOf(ME, { type: "user", emailAddress: "zoe@EXAMPLE.com" }, undefined))
      .toStrictEqual({});
    expect(audienceOf(ME, { type: "domain", domain: "partner.example" }, undefined))
      .toStrictEqual({ outsideDomain: "example.com" });
    expect(audienceOf(ME, { type: "domain", domain: "example.com" }, undefined)).toStrictEqual({});
    expect(audienceOf(ME, { type: "anyone" }, undefined)).toStrictEqual({});

    // A personal account has no organization for an address to be outside of.
    for (let emailAddress of ["someone@gmail.com", "someone@googlemail.com"]) {
      let personal: DriveActor = { permissionId: OWNER_ID, emailAddress };
      expect(audienceOf(personal, outside, undefined)).toStrictEqual({});
      expect(audienceOf(personal, { type: "user", emailAddress: "other@gmail.com" }, undefined))
        .toStrictEqual({});
      expect(audienceOf(personal, { type: "domain", domain: "partner.example" }, undefined))
        .toStrictEqual({});
    }
    // Any other account is compared by its mail domain, whatever kind of account it is.
    let elsewhere: DriveActor = { permissionId: OWNER_ID, emailAddress: "someone@outlook.com" };
    expect(audienceOf(elsewhere, { type: "user", emailAddress: "zoe@example.com" }, undefined))
      .toStrictEqual({ outsideDomain: "outlook.com" });
    expect(audienceOf(elsewhere, { type: "user", emailAddress: "other@outlook.com" }, undefined))
      .toStrictEqual({});

    expect(audienceOf(ME, { type: "domain", domain: "example.com" }, true))
      .toStrictEqual({ discoverable: true });
    expect(audienceOf(ME, { type: "domain", domain: "partner.example" }, true))
      .toStrictEqual({ discoverable: true, outsideDomain: "example.com" });
    expect(audienceOf(ME, { type: "anyone" }, true)).toStrictEqual({ discoverable: true });
    expect(audienceOf(ME, { type: "anyone" }, false)).toStrictEqual({});
    expect(audienceOf(ME, outside, true)).toStrictEqual({ outsideDomain: "example.com" });
    expect(audienceOf(ME, { type: "group", emailAddress: "team@example.com" }, true))
      .toStrictEqual({});
  });

  it("never passes a grantee whose address Drive withholds as inside", () => {
    let personal: DriveActor = { permissionId: OWNER_ID, emailAddress: "someone@gmail.com" };
    for (let type of ["user", "group"] as const) {
      expect(audienceOf(ME, { type }, undefined))
        .toStrictEqual({ addressHidden: true, outsideDomain: "example.com" });
      expect(audienceOf(personal, { type }, undefined)).toStrictEqual({ addressHidden: true });
    }
  });

  it("says that nothing was compared when Drive gave the account no address", () => {
    for (let type of ["user", "group"] as const) {
      expect(audienceOf(NAMELESS, { type, emailAddress: "zoe@example.com" }, undefined))
        .toStrictEqual({ accountAddressUnknown: true });
      expect(audienceOf(NAMELESS, { type, emailAddress: "zed@partner.example" }, undefined))
        .toStrictEqual({ accountAddressUnknown: true });
      expect(audienceOf(NAMELESS, { type }, undefined)).toStrictEqual({ addressHidden: true });
    }
    expect(audienceOf(NAMELESS, { type: "domain", domain: "example.com" }, undefined))
      .toStrictEqual({});
    expect(audienceOf(NAMELESS, { type: "domain", domain: "example.com" }, true))
      .toStrictEqual({ discoverable: true });
    expect(audienceOf(NAMELESS, { type: "anyone" }, undefined)).toStrictEqual({});
    expect(planShare(FILE, [owner()], NAMELESS, ZOE, "reader", []))
      .toStrictEqual({ accountAddressUnknown: true });
    expect(planShare(FILE, [owner()], ME, { type: "user", emailAddress: "zed@partner.example" },
      "reader", [])).toStrictEqual({ outsideDomain: "example.com" });
  });

  it("plans a role change and a removal, by ID and by grantee", () => {
    let update = (access: string | DriveGrantee, role: DriveShareRole, permissions = fixtures(),
      actor = ME) => thrownBy(() => planUpdate(permissions, actor, access, role));
    let unshare = (access: string | DriveGrantee, permissions = fixtures(), actor = ME) =>
      thrownBy(() => planUnshare(permissions, actor, access));
    let bobSnapshot = { type: "user", emailAddress: "bob@example.com", displayName: "Bob Example" };

    expect(planUpdate(fixtures(), ME, BOB_ID, "writer")).toStrictEqual({
      permissionId: BOB_ID, grantee: bobSnapshot, fromRole: "reader", toRole: "writer",
    });
    expect(planUpdate(fixtures(), ME, { type: "user", emailAddress: "BOB@example.com" }, "writer"))
      .toStrictEqual(planUpdate(fixtures(), ME, BOB_ID, "writer"));
    expect(planUnshare(fixtures(), ME, { type: "group", emailAddress: "bob@example.com" }))
      .toStrictEqual(planUnshare(fixtures(), ME, BOB_ID));
    expect(planUnshare(fixtures(), ME, BOB_ID))
      .toStrictEqual({ permissionId: BOB_ID, grantee: bobSnapshot, role: "reader" });
    expect(planUnshare(fixtures(), ME, DANA_ID)).toStrictEqual({
      permissionId: DANA_ID, role: "writer", inheritedRole: "commenter",
      grantee: { type: "user", emailAddress: "dana@example.com", displayName: "Dana Example" },
    });

    for (let refused of [update("12345", "reader"), unshare("12345")]) {
      expect(refused).toBe("That access was not found on this file.");
    }
    for (let refused of [update(ZOE, "reader"), unshare(ZOE)]) {
      expect(refused).toBe("That grantee has no access given on this file itself.");
    }
    // A deleted account's permission is nobody's access, as in a listing, whichever way it is named.
    let gone = [owner(), { ...bob(), deleted: true }];
    for (let refused of [update(BOB_ID, "writer", gone), unshare(BOB_ID, gone)]) {
      expect(refused).toBe("That access was not found on this file.");
    }
    for (let refused of [update(BOB, "writer", gone), unshare(BOB, gone)]) {
      expect(refused).toBe("That grantee has no access given on this file itself.");
    }
    // Two permissions for one address: a list Drive is not known to send.
    let twice = [owner(), bob(), { ...team(), emailAddress: "bob@example.com" }];
    for (let refused of [update(BOB, "writer", twice), unshare(BOB, twice)]) {
      expect(refused).toBe("More than one access on this file matches that grantee; name it by " +
        "the ID listAccess() returns.");
    }
    for (let refused of [
      update(CAROL_ID, "writer"), unshare(CAROL_ID), update(CAROL, "writer"), unshare(CAROL),
      update(ERIN_ID, "reader"), unshare(ERIN_ID),
    ]) {
      expect(refused).toBe(INHERITED_ONLY);
    }
    let contentManager = person("99999999999999999999", "Max", [given("fileOrganizer")]);
    let asBob: DriveActor = { permissionId: BOB_ID, emailAddress: "bob@example.com" };
    for (let refused of [
      update(OWNER_ID, "writer"), unshare(OWNER_ID), unshare(OWNER_ID, fixtures(), asBob),
      update("99999999999999999999", "writer", [owner(), contentManager]),
      unshare({ type: "user", emailAddress: "max@example.com" }, [owner(), contentManager]),
    ]) {
      expect(refused).toBe(OWNER_OR_MANAGER);
    }
    // The account's own access as a user, when it is not the owner's.
    for (let refused of [
      update(BOB_ID, "writer", fixtures(), asBob), unshare(BOB_ID, fixtures(), asBob),
      unshare(BOB, fixtures(), { permissionId: BOB_ID }),
    ]) {
      expect(refused).toBe(OWN_ACCESS);
    }
    // A group's permission is never the account's own, whatever ID it carries.
    expect(unshare(TEAM_ID, [owner(), team()], { permissionId: TEAM_ID })).toBeUndefined();

    expect(update(BOB_ID, "reader")).toBe("That access already has that role.");
    let lower = "A parent already gives that grantee commenter access to this file, and access " +
      "given on the file cannot be lower. To leave only the parent's access, use unshare().";
    expect(update(DANA_ID, "reader")).toBe(lower);
    expect(update(DANA_ID, "commenter")).toBe(lower);
    expect(thrownBy(() => planUpdate(fixtures(), ME, { type: "user", emailAddress: "nope" }, "reader")))
      .toBe("Not an email address.");

    // The link is one permission to every plan, under whichever ID its form gives.
    for (let [searchable, id] of [[false, "anyoneWithLink"], [true, "anyone"]] as const) {
      let permissions = [owner(), link("reader", searchable)];
      let reach = searchable ? { discoverable: true } : {};
      for (let named of ["anyone", "anyoneWithLink", { type: "anyone" } as const]) {
        expect(planUnshare(permissions, ME, named)).toStrictEqual({
          permissionId: id, grantee: { type: "anyone" }, role: "reader", ...reach,
        });
        expect(planUpdate(permissions, ME, named, "writer")).toStrictEqual({
          permissionId: id, grantee: { type: "anyone" }, fromRole: "reader", toRole: "writer",
          ...reach,
        });
      }
    }
  });

  it("records of the audience only what the card and the apply read", () => {
    let outsider = person(BOB_ID, "Bob", [given("commenter")], { emailAddress: "bob@partner.example" });
    let { emailAddress: _hidden, ...hidden } = bob(given("commenter"));
    let searchable = link("commenter", true);
    let permissions = [owner(), outsider, searchable];

    expect(planUpdate(permissions, ME, BOB_ID, "writer")).toMatchObject({ outsideDomain: "example.com" });
    expect(planUpdate([owner(), hidden], ME, BOB_ID, "writer")).toStrictEqual({
      permissionId: BOB_ID, grantee: { type: "user", displayName: "Bob Example" },
      fromRole: "commenter", toRole: "writer", addressHidden: true, outsideDomain: "example.com",
    });
    expect(planUpdate(permissions, ME, "anyone", "writer")).toMatchObject({ discoverable: true });
    expect(planUpdate(permissions, NAMELESS, BOB_ID, "writer"))
      .toMatchObject({ accountAddressUnknown: true });

    // A lowering and a removal are not loud: they record whether the access is found by searching.
    for (let actor of [ME, NAMELESS]) {
      for (let plan of [
        planUpdate(permissions, actor, BOB_ID, "reader"), planUnshare(permissions, actor, BOB_ID),
        planUpdate([owner(), hidden], actor, BOB_ID, "reader"),
        planUnshare([owner(), hidden], actor, BOB_ID),
        planUpdate(permissions, actor, "anyone", "reader"), planUnshare(permissions, actor, "anyone"),
      ]) {
        for (let key of ["outsideDomain", "addressHidden", "accountAddressUnknown"]) {
          expect(plan).not.toHaveProperty(key);
        }
      }
      expect(planUpdate(permissions, actor, "anyone", "reader")).toMatchObject({ discoverable: true });
      expect(planUnshare(permissions, actor, "anyone")).toMatchObject({ discoverable: true });
      expect(planUnshare(permissions, actor, BOB_ID)).not.toHaveProperty("discoverable");
    }
    let domain = wholeDomain("partner.example", true);
    expect(planUnshare([owner(), domain], ME, DOMAIN_ID)).toStrictEqual({
      permissionId: DOMAIN_ID, role: "reader", discoverable: true,
      grantee: { type: "domain", domain: "partner.example", displayName: "Example Org" },
    });
    expect(planUpdate([owner(), domain], ME, { type: "domain", domain: "Partner.Example" }, "writer"))
      .toMatchObject({ permissionId: DOMAIN_ID, discoverable: true, outsideDomain: "example.com" });
  });
});

describe("Drive sharing changes awaiting approval", () => {
  /** A comment and a move, as the same queue holds them: no sharing question reads either. */
  const others: QueuedWrite[] = [
    { id: 20, action: { kind: "createComment", payload: { fileId: FILE, content: "Hi" } } },
    { id: 21, action: { kind: "moveFile", payload: { fileId: FILE, permissionId: BOB_ID } } },
  ];

  it("answers a pending access ID by whether it still waits, for which file, and by which call asked", () => {
    expect(ACCESS_WAITING_CHANGE).toBe(
      "That access is waiting for approval and has not been given yet. Change its role once it " +
      "is given, or have the user reject it and share again with the role wanted.");
    expect(ACCESS_WAITING_REMOVE).toBe(
      "That access is waiting for approval and has not been given yet. To withdraw it, have the " +
      "user reject it.");
    expect(SHARE_PENDING).toBe("That grantee already has access to this file waiting for approval.");
    expect(CHANGE_PENDING).toBe("That access already has a change waiting for approval.");

    let pending = [
      queued(4, "createPermission", shareOf(ZOE, "reader")),
      queued(6, "updatePermission", roleChangeOf(fixtures(), BOB_ID, "writer")),
      ...others,
    ];
    expect(pendingAccessRefusal(FILE, "pending:4", pending, "change")).toBe(ACCESS_WAITING_CHANGE);
    expect(pendingAccessRefusal(FILE, "pending:4", pending, "remove")).toBe(ACCESS_WAITING_REMOVE);
    for (let call of ["change", "remove"] as const) {
      // A share that waits for another file, an ID nothing waits under, and a role change's ID.
      expect(pendingAccessRefusal("doc-2", "pending:4", pending, call)).toBe(SPENT);
      expect(pendingAccessRefusal(FILE, "pending:5", pending, call)).toBe(SPENT);
      expect(pendingAccessRefusal(FILE, "pending:6", pending, call)).toBe(SPENT);
      expect(pendingAccessRefusal(FILE, "pending:20", pending, call)).toBe(SPENT);
      expect(pendingAccessRefusal(FILE, "pending:4", others, call)).toBe(SPENT);
    }
  });

  it("finds a queued change of the same access and a queued share to the same grantee", () => {
    let permissions = [...fixtures(), team()];
    let pending = [
      queued(4, "updatePermission", roleChangeOf(permissions, BOB_ID, "writer")),
      queued(5, "deletePermission", removalOf(permissions, DANA_ID)),
      queued(6, "deletePermission", removalOf(permissions, "anyoneWithLink")),
      queued(7, "createPermission", shareOf({ type: "group", emailAddress: "Zoe@example.com" }, "reader")),
      queued(8, "createPermission", shareOf({ type: "domain", domain: "example.com" }, "reader")),
      ...others,
    ];
    expect(hasPendingChange(FILE, BOB_ID, pending)).toBe(true);
    expect(hasPendingChange(FILE, DANA_ID, pending)).toBe(true);
    // Either of Drive's two IDs names the link whose removal waits.
    expect(hasPendingChange(FILE, "anyone", pending)).toBe(true);
    expect(hasPendingChange(FILE, "anyoneWithLink", pending)).toBe(true);
    expect(hasPendingChange(FILE, TEAM_ID, pending)).toBe(false);
    expect(hasPendingChange("doc-2", BOB_ID, pending)).toBe(false);
    expect(hasPendingChange(FILE, BOB_ID, [pending[3], ...others])).toBe(false);

    expect(hasPendingShare(FILE, { type: "group", emailAddress: "zoe@example.com" }, pending)).toBe(true);
    expect(hasPendingShare(FILE, ZOE, pending)).toBe(true);
    expect(hasPendingShare(FILE, { type: "domain", domain: "example.com" }, pending)).toBe(true);
    expect(hasPendingShare(FILE, { type: "user", emailAddress: "bob@example.com" }, pending)).toBe(false);
    expect(hasPendingShare(FILE, { type: "anyone" }, pending)).toBe(false);
    expect(hasPendingShare("doc-2", ZOE, pending)).toBe(false);
    expect(hasPendingShare(FILE, ZOE, others)).toBe(false);
  });

  it("shows queued changes as if made", () => {
    let listed = toAccessEntries(fixtures(), OWNER_ID);
    let before = structuredClone(listed);
    let pending = [
      queued(4, "createPermission", shareOf(ZOE, "writer")),
      queued(5, "updatePermission", roleChangeOf(fixtures(), BOB_ID, "commenter")),
      queued(6, "deletePermission", removalOf(fixtures(), "anyoneWithLink")),
      queued(7, "createPermission", { ...shareOf(ZOE, "reader"), fileId: "doc-2" }),
      queued(8, "updatePermission", { ...roleChangeOf(fixtures(), BOB_ID, "writer"), permissionId: "12345" }),
      ...others,
    ];
    let shown = overlayPendingAccess(FILE, listed, pending);
    expect(shown).toStrictEqual([
      ...before.slice(0, 2),
      // Bob's role as it will be, the link left out, and the share after Drive's own entries.
      { ...before[2], role: "commenter", pending: true },
      ...before.slice(3, 6),
      ...before.slice(7),
      { id: "pending:4", type: "user", role: "writer", emailAddress: "zoe@example.com", pending: true },
    ]);
    // The listing handed in is left as it was.
    expect(listed).toStrictEqual(before);

    // A role change touches what is given on the file, not the inherited entry beside it.
    let danaChange = overlayPendingAccess(FILE, listed, [
      queued(4, "updatePermission", { ...roleChangeOf([owner(), bob()], BOB_ID, "writer"), permissionId: DANA_ID }),
    ]).filter(entry => entry.id === DANA_ID);
    expect(danaChange).toStrictEqual([
      { ...before[4] },
      { ...before[5], role: "writer", pending: true },
    ]);
    expect(danaChange[0]).not.toHaveProperty("pending");
    // A removal leaves the inherited entry where it is.
    expect(overlayPendingAccess(FILE, listed, [
      queued(4, "deletePermission", removalOf(fixtures(), DANA_ID)),
    ]).filter(entry => entry.id === DANA_ID)).toStrictEqual([before[4]]);

    // A queued removal of `anyoneWithLink` leaves out a link the list shows as `anyone`.
    let searchable = toAccessEntries([owner(), link("reader", true)], OWNER_ID);
    expect(overlayPendingAccess(FILE, searchable, [
      queued(4, "deletePermission", removalOf(fixtures(), "anyoneWithLink")),
    ])).toStrictEqual(searchable.slice(0, 2));
    expect(overlayPendingAccess(FILE, listed, [])).toStrictEqual(before);
  });

  it("shows a waiting share with a domain or anyone as Drive will list it", () => {
    let domain: DriveGrantee = { type: "domain", domain: "partner.example" };
    expect(pendingAccess(4, shareOf({ type: "anyone" }, "reader", undefined, [owner()])))
      .toStrictEqual({ id: "pending:4", type: "anyone", role: "reader", discoverable: false, pending: true });
    expect(pendingAccess(4, shareOf(domain, "commenter"))).toStrictEqual({
      id: "pending:4", type: "domain", role: "commenter", domain: "partner.example",
      discoverable: false, pending: true,
    });
    expect(pendingAccess(4, shareOf({ type: "anyone" }, "reader", { discoverable: true }, [owner()])))
      .toMatchObject({ discoverable: true });
    expect(pendingAccess(4, shareOf(domain, "reader", { discoverable: true })))
      .toMatchObject({ discoverable: true });
    for (let type of ["user", "group"] as const) {
      expect(pendingAccess(9, shareOf({ type, emailAddress: "zoe@example.com" }, "reader", { notify: false })))
        .toStrictEqual({ id: "pending:9", type, role: "reader", emailAddress: "zoe@example.com", pending: true });
    }
  });

  it("applies whatever is queued, in ID order", () => {
    let listed = toAccessEntries([owner(), bob()], OWNER_ID);
    let toWriter = roleChangeOf([owner(), bob()], BOB_ID, "writer");
    let toCommenter = roleChangeOf([owner(), bob()], BOB_ID, "commenter");
    let remove = removalOf([owner(), bob()], BOB_ID);
    let bobShown = (pending: QueuedWrite[]) =>
      overlayPendingAccess(FILE, listed, pending).filter(entry => entry.id === BOB_ID);

    // Of two queued updates of one access the later one's role shows, however they are handed out.
    for (let pending of [
      [queued(4, "updatePermission", toWriter), queued(5, "updatePermission", toCommenter)],
      [queued(5, "updatePermission", toCommenter), queued(4, "updatePermission", toWriter)],
    ]) {
      expect(bobShown(pending)).toStrictEqual([{ ...listed[2], role: "commenter", pending: true }]);
    }
    // An update queued after a removal of the same access changes nothing.
    expect(bobShown([queued(4, "deletePermission", remove), queued(5, "updatePermission", toWriter)]))
      .toStrictEqual([]);
    // Two queued shares to one grantee are two pending entries.
    let twice = overlayPendingAccess(FILE, listed, [
      queued(7, "createPermission", shareOf(ZOE, "writer")),
      queued(6, "createPermission", shareOf(ZOE, "reader")),
    ]).slice(3);
    expect(twice.map(entry => [entry.id, entry.role, entry.pending]))
      .toEqual([["pending:6", "reader", true], ["pending:7", "writer", true]]);
  });
});

const AS = { reader: "viewer", commenter: "commenter", writer: "editor" } as const;
const GIVE = (role: DriveShareRole, noun = "file") =>
  `Give ${AS[role]} access to Google Drive ${noun} \`doc-1\` as the connected account.`;
const SEARCHING = " **They can also find it by searching.**";
const NOT_OWN = " **That domain is not `example.com`, the connected account's own.**";
const OUTSIDE_ADDRESS =
  "**This address is outside `example.com`, the connected account's own domain.**";
const UNCHECKED =
  "**Drive did not give the connected account's own address, so whether this address is " +
  "outside its domain is not known.**";
const everyone = (role: DriveShareRole, noun = "file") =>
  `**Everyone in the domain below gets ${AS[role]} access to this ${noun}.**`;
const publicLink = (role: DriveShareRole, noun = "file") =>
  `**Public: anyone who has the link gets ${AS[role]} access to this ${noun}.**`;
const publicSearch = (role: DriveShareRole, noun = "file") =>
  `**Public: anyone can find this ${noun} by searching and gets ${AS[role]} access.**`;

/** One way a share or a raise is loud: who it reaches, and how its card begins. */
type Loud = {
  name: string;
  grantee: DriveGrantee;
  options?: DriveShareOptions;
  /** The access as Drive lists it once given as a viewer's, for a raise. */
  listed: DrivePermissionRecord;
  audience: string;
  prefix: string;
  bold(role: DriveShareRole, noun?: string): string;
};

const PARTNER: DriveGrantee = { type: "domain", domain: "partner.example" };
const OWN_DOMAIN: DriveGrantee = { type: "domain", domain: "example.com" };
const LOUD: Loud[] = [
  {
    name: "anyone", grantee: { type: "anyone" }, listed: link(), audience: "anyone",
    prefix: "Public link: ", bold: publicLink,
  },
  {
    name: "anyone, discoverable", grantee: { type: "anyone" }, options: { discoverable: true },
    listed: link("reader", true), audience: "anyone", prefix: "Public, searchable: ",
    bold: publicSearch,
  },
  {
    name: "a domain", grantee: OWN_DOMAIN, listed: wholeDomain(), audience: "a domain",
    prefix: "Whole domain: ", bold: everyone,
  },
  {
    name: "a domain, discoverable", grantee: OWN_DOMAIN, options: { discoverable: true },
    listed: wholeDomain("example.com", true), audience: "a domain",
    prefix: "Whole domain, searchable: ", bold: (role, noun) => everyone(role, noun) + SEARCHING,
  },
  {
    name: "a domain outside the account's", grantee: PARTNER, listed: wholeDomain("partner.example"),
    audience: "a domain", prefix: "Outside domain: ",
    bold: (role, noun) => everyone(role, noun) + NOT_OWN,
  },
  {
    name: "a domain outside the account's, discoverable", grantee: PARTNER,
    options: { discoverable: true }, listed: wholeDomain("partner.example", true),
    audience: "a domain", prefix: "Outside domain, searchable: ",
    // The sentence naming the account's own domain comes before the one about searching.
    bold: (role, noun) => everyone(role, noun) + NOT_OWN + SEARCHING,
  },
  {
    name: "a person outside the account's domain",
    grantee: { type: "user", emailAddress: "bob@partner.example" },
    listed: person(BOB_ID, "Bob", [given("reader")], { emailAddress: "bob@partner.example" }),
    audience: "a person", prefix: "Outside address: ", bold: () => OUTSIDE_ADDRESS,
  },
  {
    name: "a group outside the account's domain",
    grantee: { type: "group", emailAddress: "team@partner.example" },
    listed: { ...team(), emailAddress: "team@partner.example" },
    audience: "a group", prefix: "Outside address: ", bold: () => OUTSIDE_ADDRESS,
  },
];

const firstParagraph = (card: ActionDescription) => card.description.split("\n\n")[0];
const paragraphs = (card: ActionDescription) => card.description.split("\n\n");

describe("Drive sharing verdicts and approval cards", () => {
  it("declares one kind, never auto-approvable, that says it cannot be reverted", async () => {
    let { actions, card } = harness();
    let { emailAddress: _hidden, ...hidden } = bob();
    expect(DRIVE_SHARING).toEqual(KIND);
    expect(actions.autoApprovableKinds()).toEqual([]);
    for (let description of [
      await card("createPermission", shareOf(ZOE, "reader")),
      await card("updatePermission", roleChangeOf(fixtures(), BOB_ID, "writer")),
      await card("deletePermission", removalOf(fixtures(), BOB_ID)),
      await card("deletePermission", removalOf([owner(), hidden], BOB_ID)),
    ]) {
      expect(description).toMatchObject({
        autoApprovable: false, actionKind: KIND, implementsRevert: false,
        descriptionIsComplete: true,
      });
      // A sharing change is simulated: nothing waits on its decision.
      expect(description).not.toHaveProperty("awaitDecision");
    }
    for (let definition of Object.values(DRIVE_SHARING_DEFINITIONS)) {
      expect(definition).toMatchObject({
        kind: KIND, autoApprovable: false, delivery: "continue-with-simulation",
        claimBeforeApply: true,
      });
      expect(definition).not.toHaveProperty("reject");
    }
  });

  it("shows a share with a person", async () => {
    let description = await harness().card(
      "createPermission", shareOf(ZOE, "writer", { message: MESSAGE }));
    expect(description.title).toBe("Share a Google Drive file with a person");
    expect(paragraphs(description)).toEqual([GIVE("writer"), "Google emails them about it."]);
    expect(description.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "File name", kind: "inline", value: "Plan.pdf" },
      { label: "Share with", kind: "inline", value: "zoe@example.com" },
      { label: "Role", kind: "inline", value: "writer" },
      { label: "Message", kind: "text", value: MESSAGE },
    ]);
    expect(description.descriptionIsComplete).toBe(true);

    let silent = await harness().card("createPermission", shareOf(ZOE, "writer", { notify: false }));
    expect(paragraphs(silent)).toEqual([GIVE("writer"), "No email is sent."]);
    expect(silent.fields?.map(field => field.label)).toEqual(["File", "File name", "Share with", "Role"]);

    // What a parent already gives is said, with the role in the gatekeeper's own fixed word.
    let above = await harness().card("createPermission",
      shareOf({ type: "user", emailAddress: "carol@example.com" }, "writer"));
    expect(paragraphs(above)).toEqual([
      GIVE("writer"), "Google emails them about it.",
      "They already have `commenter` access through a parent folder; this gives a higher role " +
      "on the file itself.",
    ]);

    // A group is named as the caller named it; a domain and anyone are emailed nothing.
    let group = await harness().card("createPermission",
      shareOf({ type: "group", emailAddress: "all@example.com" }, "commenter"));
    expect(group.title).toBe("Share a Google Drive file with a group");
    expect(paragraphs(group)).toEqual([GIVE("commenter"), "Google emails them about it."]);
    let domain = await harness().card("createPermission", shareOf(OWN_DOMAIN, "reader"));
    expect(domain.description).not.toContain("email");
    expect(domain.fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "File name", kind: "inline", value: "Plan.pdf" },
      { label: "Domain", kind: "inline", value: "example.com" },
      { label: "Role", kind: "inline", value: "reader" },
    ]);
    let { fileName: _name, ...unnamed } = shareOf({ type: "anyone" }, "reader", undefined, [owner()]);
    expect((await harness().card("createPermission", unnamed)).fields).toEqual([
      { label: "File", kind: "inline", value: "doc-1" },
      { label: "Role", kind: "inline", value: "reader" },
    ]);
  });

  it("says that sharing a folder shares what it holds", async () => {
    let merged = "This is a folder: everything in it is shared too. Access they already have to " +
      "something in it, at this role or a lower one, is merged into the folder's, and is gone " +
      "if the folder's access is later removed.";
    let folder = await harness().card("createPermission", { ...shareOf(ZOE, "writer"), isFolder: true });
    expect(folder.title).toBe("Share a Google Drive folder with a person");
    expect(paragraphs(folder)).toEqual([
      GIVE("writer", "folder"), merged, "Google emails them about it.",
    ]);
    let file = await harness().card("createPermission", shareOf(ZOE, "writer"));
    expect(file.description).not.toContain("This is a folder");
    expect(file.description).not.toContain("merged");
  });

  let shares = LOUD.flatMap(loud => (loud.name === "anyone"
    ? ["reader", "commenter", "writer"] as const : ["reader"] as const)
    .map(role => ({ ...loud, role })));

  it.each(shares)("says a public, domain or outside-domain share first, in the title and the " +
    "first paragraph: $name as $role", async ({ grantee, options, role, audience, prefix, bold }) => {
    let payload = shareOf(grantee, role, options, [owner()]);
    let description = await harness().card("createPermission", payload);
    expect(description.title).toBe(`${prefix}share a Google Drive file with ${audience}`);
    expect(firstParagraph(description)).toBe(`${bold(role)} ${GIVE(role)}`);
    expect(description.description).not.toContain("without signing in");
    if (grantee.type === "domain") {
      expect(description.title.includes("searchable")).toBe(options?.discoverable === true);
    }
    if (grantee.type === "anyone" && options?.discoverable) {
      expect(description.title).not.toContain("link");
      expect(firstParagraph(description)).not.toContain("has the link");
    }
    // The same words as the card's are what loudOpening answers for the payload.
    expect(loudOpening(grantee, role, payload, "file")).toEqual({ title: prefix, prose: bold(role) });

    let folder = await harness().card("createPermission", { ...payload, isFolder: true });
    expect(folder.title).toBe(`${prefix}share a Google Drive folder with ${audience}`);
    expect(firstParagraph(folder)).toBe(`${bold(role, "folder")} ${GIVE(role, "folder")}`);
  });

  it("says a loud share's role where a collapsed row shows it, and nothing loud for a person inside", async () => {
    let outsider: DriveGrantee = { type: "user", emailAddress: "bob@partner.example" };
    let asWriter = await harness().card("createPermission", shareOf(outsider, "writer", undefined, [owner()]));
    let asReader = await harness().card("createPermission", shareOf(outsider, "reader", undefined, [owner()]));
    expect(firstParagraph(asWriter)).not.toBe(firstParagraph(asReader));
    expect(asWriter.title).toBe("Outside address: share a Google Drive file with a person");

    let inside = await harness().card("createPermission", shareOf(ZOE, "reader"));
    expect(inside.title.startsWith("Share")).toBe(true);
    expect(firstParagraph(inside).startsWith("Give viewer access")).toBe(true);
    expect(loudOpening(ZOE, "reader", {}, "file")).toEqual({ title: "", prose: "" });

    let anyone = await harness().card("createPermission",
      { ...shareOf({ type: "anyone" }, "reader", undefined, [owner()]), isFolder: true });
    expect(anyone.title).toBe("Public link: share a Google Drive folder with anyone");
    expect(firstParagraph(anyone).startsWith(
      "**Public: anyone who has the link gets viewer access to this folder.**")).toBe(true);
    let domain = await harness().card("createPermission", { ...shareOf(OWN_DOMAIN, "reader"), isFolder: true });
    expect(domain.title).toBe("Whole domain: share a Google Drive folder with a domain");
    expect(firstParagraph(domain).startsWith(
      "**Everyone in the domain below gets viewer access to this folder.**")).toBe(true);
    let fileCard = await harness().card("createPermission", shareOf(OWN_DOMAIN, "reader"));
    expect(firstParagraph(fileCard).startsWith(
      "**Everyone in the domain below gets viewer access to this file.**")).toBe(true);
  });

  it("says first that an address could not be checked", async () => {
    let unchecked = await harness().card("createPermission",
      shareOf(ZOE, "reader", undefined, [owner()], NAMELESS));
    expect(unchecked.title).toBe("Unchecked address: share a Google Drive file with a person");
    expect(firstParagraph(unchecked)).toBe(`${UNCHECKED} ${GIVE("reader")}`);
    // A domain's card is loud whichever domain it names, so it reads as for an account inside it.
    let domain = await harness().card("createPermission",
      shareOf(PARTNER, "reader", undefined, [owner()], NAMELESS));
    expect(domain.title).toBe("Whole domain: share a Google Drive file with a domain");
    expect(firstParagraph(domain)).toBe(`${everyone("reader")} ${GIVE("reader")}`);
  });

  it("keeps names, addresses and messages out of the card's own words", async () => {
    let fileName = "Plan\n# Approved";
    let displayName = "Ada. Approved by your administrator";
    let message = "Look: ![x](https://evil.example/a.png)";
    let listed = person(BOB_ID, "Bob", [given("reader")], { emailAddress: "x@y.z", displayName });
    let x: DriveGrantee = { type: "user", emailAddress: "x@y.z" };
    let cards = [
      await harness().card("createPermission",
        { ...shareOf(x, "writer", { message }, [owner()]), fileName }),
      await harness().card("updatePermission",
        { ...roleChangeOf([owner(), listed], BOB_ID, "writer"), fileName }),
      await harness().card("deletePermission", { ...removalOf([owner(), listed], x), fileName }),
    ];
    for (let card of cards) {
      for (let untrusted of [fileName, "# Approved", "x@y.z", displayName, message, "evil.example"]) {
        expect(card.description).not.toContain(untrusted);
        expect(card.title).not.toContain(untrusted);
      }
      let values = Object.fromEntries((card.fields ?? []).map(field =>
        [field.label, "value" in field ? field.value : undefined]));
      expect(values["File name"]).toBe(fileName);
      expect(values[card === cards[0] ? "Share with" : "Shared with"]).toBe("x@y.z");
      expect(card.descriptionIsComplete).toBe(true);
    }
    expect(cards[0].fields).toContainEqual({ label: "Message", kind: "text", value: message });
    expect(cards[1].fields).toContainEqual({ label: "Name", kind: "inline", value: displayName });
    expect(cards[2].fields).toContainEqual({ label: "Name", kind: "inline", value: displayName });
  });
});

describe("Drive role change and removal cards", () => {
  const TARGET_FIELDS = [
    { label: "File", kind: "inline", value: "doc-1" },
    { label: "File name", kind: "inline", value: "Plan.pdf" },
  ];

  it("shows a role change and a removal with who and from what", async () => {
    let permissions = [owner(), bob(), dana(), team(), link(), wholeDomain()];
    // Access named by a person's address that a group's permission holds: the card says a group.
    let named: DriveGrantee = { type: "user", emailAddress: "team@example.com" };
    let raise = await harness().card("updatePermission", roleChangeOf(permissions, named, "writer"));
    expect(raise.title).toBe("Raise access to a Google Drive file");
    expect(paragraphs(raise)).toEqual([CHANGE("a group", "reader", "writer")]);
    expect(raise.fields).toEqual([
      ...TARGET_FIELDS,
      { label: "Access ID", kind: "inline", value: TEAM_ID },
      { label: "Shared with", kind: "inline", value: "team@example.com" },
      { label: "Name", kind: "inline", value: "Team Example" },
      { label: "From role", kind: "inline", value: "reader" },
      { label: "To role", kind: "inline", value: "writer" },
    ]);
    expect(raise.descriptionIsComplete).toBe(true);

    let removal = await harness().card("deletePermission", removalOf(permissions, named));
    expect(removal.title).toBe("Remove access to a Google Drive file");
    expect(paragraphs(removal)).toEqual([REMOVE("a group")]);
    expect(removal.fields).toEqual([
      ...TARGET_FIELDS,
      { label: "Access ID", kind: "inline", value: TEAM_ID },
      { label: "Shared with", kind: "inline", value: "team@example.com" },
      { label: "Name", kind: "inline", value: "Team Example" },
      { label: "Role", kind: "inline", value: "reader" },
    ]);
    expect(removal.descriptionIsComplete).toBe(true);

    // The kind Drive lists, in the first sentence, and the grantee in fields.
    let whom: [string, string, object[]][] = [
      [BOB_ID, "a person", [
        { label: "Shared with", kind: "inline", value: "bob@example.com" },
        { label: "Name", kind: "inline", value: "Bob Example" },
      ]],
      [DOMAIN_ID, "a domain", [{ label: "Domain", kind: "inline", value: "example.com" }]],
      ["anyoneWithLink", "anyone who has the link", [
        { label: "Shared with", kind: "inline", value: "anyone who has the link" },
      ]],
    ];
    for (let [id, words, fields] of whom) {
      let lowered = await harness().card("updatePermission",
        roleChangeOf(permissions.map(listed => listed.id === id
          ? { ...listed, role: "writer" as const, details: [given("writer")] } : listed),
        id, "commenter"));
      expect(paragraphs(lowered)).toEqual([CHANGE(words, "writer", "commenter")]);
      expect(lowered.fields).toEqual([
        ...TARGET_FIELDS, { label: "Access ID", kind: "inline", value: id }, ...fields,
        { label: "From role", kind: "inline", value: "writer" },
        { label: "To role", kind: "inline", value: "commenter" },
      ]);
      let removed = await harness().card("deletePermission", removalOf(permissions, id));
      expect(paragraphs(removed)).toEqual([REMOVE(words)]);
      expect(removed.description).not.toContain("undone");
    }

    // What a parent also gives is said, and stays.
    let dropped = await harness().card("deletePermission", removalOf(permissions, DANA_ID));
    expect(paragraphs(dropped)).toEqual([
      REMOVE("a person"),
      "They keep `commenter` access through a parent folder, which this does not change.",
    ]);
    let danaReader = [owner(), person(DANA_ID, "Dana", [inherited("reader"), given("commenter")])];
    let changed = await harness().card("updatePermission", roleChangeOf(danaReader, DANA_ID, "writer"));
    expect(paragraphs(changed)).toEqual([
      CHANGE("a person", "commenter", "writer"),
      "A parent folder already gives them `reader` access, which this does not change.",
    ]);
  });

  let raises = [
    ...LOUD,
    {
      name: "a person, where Drive gave the account no address", listed: bob(), actor: NAMELESS,
      prefix: "Unchecked address: ", bold: () => UNCHECKED,
    },
  ];

  it.each(raises)("says a raise first as a share is said: $name", async loud => {
    let permissions = [owner(), loud.listed];
    let actor = "actor" in loud ? loud.actor : ME;
    let payload = roleChangeOf(permissions, loud.listed.id, "writer", actor);
    let raise = await harness().card("updatePermission", payload);
    expect(raise.title).toBe(`${loud.prefix}raise access to a Google Drive file`);
    let sentence = CHANGE(
      loud.listed.type === "anyone" ? "anyone who has the link"
      : loud.listed.type === "domain" ? "a domain"
      : loud.listed.type === "group" ? "a group" : "a person", "reader", "writer");
    // The loud sentence carries the role the access rises to.
    expect(firstParagraph(raise)).toBe(`${loud.bold("writer")} ${sentence}`);

    // A lowering is not loud, whoever it is for, and neither is a removal.
    let high = { ...loud.listed, role: "writer" as const, details: [given("writer")] };
    let lowering = await harness().card("updatePermission",
      roleChangeOf([owner(), high], high.id, "reader", actor));
    expect(lowering.title).toBe("Lower access to a Google Drive file");
    expect(lowering.description).not.toContain("**");
    let removal = await harness().card("deletePermission", removalOf(permissions, loud.listed.id, actor));
    expect(removal.title).toBe("Remove access to a Google Drive file");
    expect(removal.description).not.toContain("**");
  });

  it("titles a raise for a person inside the domain plainly", async () => {
    let raise = await harness().card("updatePermission", roleChangeOf(fixtures(), BOB_ID, "commenter"));
    expect(raise.title).toBe("Raise access to a Google Drive file");
    expect(raise.description).toBe(CHANGE("a person", "reader", "commenter"));
  });

  it("says what a change to a folder's sharing does to what it holds", async () => {
    let high = [owner(), bob(given("writer"))];
    let raise = await harness().card("updatePermission",
      { ...roleChangeOf(fixtures(), BOB_ID, "writer"), isFolder: true });
    expect(raise.title).toBe("Raise access to a Google Drive folder");
    expect(paragraphs(raise)).toEqual([
      CHANGE("a person", "reader", "writer", "folder"),
      "This is a folder: the change reaches everything in it. Access they already have to " +
      "something in it, at the new role or a lower one, is merged into the folder's, and is " +
      "gone if the folder's access is later removed.",
    ]);
    let lowering = await harness().card("updatePermission",
      { ...roleChangeOf(high, BOB_ID, "reader"), isFolder: true });
    expect(lowering.title).toBe("Lower access to a Google Drive folder");
    expect(paragraphs(lowering)).toEqual([
      CHANGE("a person", "writer", "reader", "folder"),
      "This is a folder: the change reaches everything in it.",
    ]);
    let removal = await harness().card("deletePermission",
      { ...removalOf(fixtures(), BOB_ID), isFolder: true });
    expect(removal.title).toBe("Remove access to a Google Drive folder");
    expect(paragraphs(removal)).toEqual([
      REMOVE("a person", "folder"),
      "This is a folder: everything in it loses the access it had through this folder. Access " +
      "they had to something in it that was merged into the folder's goes with it.",
    ]);
    expect(removal.description).not.toContain("undone");

    // A file's cards say none of it.
    for (let card of [
      await harness().card("updatePermission", roleChangeOf(fixtures(), BOB_ID, "writer")),
      await harness().card("updatePermission", roleChangeOf(high, BOB_ID, "reader")),
      await harness().card("deletePermission", removalOf(fixtures(), BOB_ID)),
    ]) {
      expect(card.description).not.toContain("folder");
      expect(card.description).not.toContain("merged");
    }
  });

  it("says first that an address is not shown", async () => {
    let { emailAddress: _hidden, ...hidden } = bob();
    let raise = await harness().card("updatePermission", roleChangeOf([owner(), hidden], BOB_ID, "writer"));
    expect(raise.title).toBe("Unknown address: raise access to a Google Drive file");
    expect(firstParagraph(raise)).toBe(
      "**Drive does not show this grantee's address, so it may be outside `example.com`, the " +
      `connected account's own domain.** ${CHANGE("a person", "reader", "writer")}`);
    expect(raise.fields).toEqual([
      ...TARGET_FIELDS,
      { label: "Access ID", kind: "inline", value: BOB_ID },
      { label: "Name", kind: "inline", value: "Bob Example" },
      { label: "From role", kind: "inline", value: "reader" },
      { label: "To role", kind: "inline", value: "writer" },
    ]);

    let personal: DriveActor = { permissionId: OWNER_ID, emailAddress: "me@gmail.com" };
    let plain = await harness().card("updatePermission",
      roleChangeOf([owner(), hidden], BOB_ID, "writer", personal));
    expect(plain.title).toBe("Unknown address: raise access to a Google Drive file");
    expect(firstParagraph(plain)).toBe(
      `**Drive does not show this grantee's address.** ${CHANGE("a person", "reader", "writer")}`);
    // With no address for the account either, the card says the address is not shown.
    let nameless = await harness().card("updatePermission",
      roleChangeOf([owner(), hidden], BOB_ID, "writer", NAMELESS));
    expect(firstParagraph(nameless).startsWith("**Drive does not show this grantee's address.**"))
      .toBe(true);
  });
});

/** What no log line may hold: who a file is shared with, at which role, and under which ID. */
const NEVER_LOGGED = [
  /example/i, /Plan\.pdf/, new RegExp(MESSAGE.replace(".", "\\.")), /anyoneWithLink/, /\banyone\b/,
  ...[OWNER_ID, BOB_ID, CAROL_ID, DANA_ID, ERIN_ID, DOMAIN_ID, TEAM_ID].map(id => new RegExp(id)),
];
const ROLE_WORDS = /\b(reader|commenter|writer|fileOrganizer|organizer|owner|viewer|editor)\b/;

describe("Drive sharing changes at approval", () => {
  let info: MockInstance<typeof console.info>;
  let warn: MockInstance<typeof console.warn>;
  let error: MockInstance<typeof console.error>;

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /** Every line logged by the test so far, in the order of its level. */
  const logged = (): Record<string, unknown>[] =>
    [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls].map(([line]) => line);

  // Every case here logs IDs and outcomes only: each line names its action and file, and none
  // holds an address, a domain, a name, a message, a role or a permission ID.
  afterEach(() => {
    for (let line of logged()) {
      expect(line).toMatchObject({
        component: "gatekeeper.google.drive.sharing", vendorId: "google", fileId: FILE,
        actionId: expect.any(Number),
        actionKind: expect.stringMatching(/^(create|update|delete)Permission$/),
        event: expect.stringMatching(/^drive\.sharing\.(applied|reconciled|send\.failed)$/),
      });
      let text = JSON.stringify(line);
      for (let pattern of NEVER_LOGGED) expect(text).not.toMatch(pattern);
      // A stack names code and paths, which are not the grantee's; the rest is checked for roles.
      let { errorStack: _stack, ...fields } = line;
      expect(JSON.stringify(fields)).not.toMatch(ROLE_WORDS);
    }
  });

  it("gives access exactly as approved, and keeps nothing of it", async () => {
    let cases: [DriveGrantee, DriveShareOptions | undefined, DrivePermissionGrant, object][] = [
      [ZOE, { message: MESSAGE }, { type: "user", role: "writer", emailAddress: "zoe@example.com" },
        { notify: true, message: MESSAGE }],
      [ZOE, { notify: false }, { type: "user", role: "writer", emailAddress: "zoe@example.com" },
        { notify: false }],
      [{ type: "group", emailAddress: "all@example.com" }, undefined,
        { type: "group", role: "writer", emailAddress: "all@example.com" }, { notify: true }],
      [OWN_DOMAIN, undefined,
        { type: "domain", role: "writer", domain: "example.com", allowFileDiscovery: false },
        { notify: false }],
      [PARTNER, { discoverable: true },
        { type: "domain", role: "writer", domain: "partner.example", allowFileDiscovery: true },
        { notify: false }],
      [{ type: "anyone" }, undefined, { type: "anyone", role: "writer", allowFileDiscovery: false },
        { notify: false }],
      [{ type: "anyone" }, { discoverable: true },
        { type: "anyone", role: "writer", allowFileDiscovery: true }, { notify: false }],
    ];
    for (let [grantee, options, grant, sent] of cases) {
      let { api, drive, journal, attempts, submit, apply } = harness([owner()]);
      let id = await submit("createPermission", shareOf(grantee, "writer", options, [owner()]));
      expect(await apply(id)).toBeNull();
      expect(api.createPermission.mock.calls).toEqual([[FILE, grant, sent]]);
      expect(api.updatePermission).not.toHaveBeenCalled();
      expect(api.deletePermission).not.toHaveBeenCalled();
      // Applied: the record is retired, and the marker is the gatekeeper's to drop.
      expect(journal.get(id)).toBeUndefined();
      expect(attempts.get(id)).toStrictEqual({ at: expect.any(Number) });
      expect(matchGrantee(drive.get(FILE), grantee).map(accessOf)).toEqual([{ direct: "writer" }]);
    }

    // No payload is returned to keep, by any of the three.
    let { host, drive } = harness();
    let definitions = DRIVE_SHARING_DEFINITIONS;
    await expect(definitions.createPermission.apply(shareOf(ZOE, "reader"), host, { id: 1 }))
      .resolves.toBeUndefined();
    await expect(definitions.updatePermission.apply(
      roleChangeOf(fixtures(), BOB_ID, "writer"), host, { id: 2 })).resolves.toBeUndefined();
    await expect(definitions.deletePermission.apply(removalOf(drive.get(FILE), BOB_ID), host, { id: 3 }))
      .resolves.toBeUndefined();
    expect(drive.get(FILE).map(listed => listed.id)).not.toContain(BOB_ID);
  });

  it("changes a role and removes access under the ID the card showed", async () => {
    let { api, drive, journal, submit, apply } = harness();
    let change = await submit("updatePermission", roleChangeOf(fixtures(), BOB_ID, "writer"));
    expect(await apply(change)).toBeNull();
    expect(api.updatePermission.mock.calls).toEqual([[FILE, BOB_ID, "writer"]]);
    expect(accessOf(drive.get(FILE)[1])).toEqual({ direct: "writer" });
    expect(journal.get(change)).toBeUndefined();

    let removal = await submit("deletePermission", removalOf(drive.get(FILE), "anyone"));
    expect(await apply(removal)).toBeNull();
    expect(api.deletePermission.mock.calls).toEqual([[FILE, "anyoneWithLink"]]);
    expect(matchGrantee(drive.get(FILE), { type: "anyone" })).toEqual([]);
    expect(journal.get(removal)).toBeUndefined();
  });

  it("takes a role a parent now gives for the role it set", async () => {
    // A parent came to give exactly the new role after the change was queued.
    let since = [owner(), bob(inherited("writer"), given("reader"))];
    let first = harness();
    let id = await first.submit("updatePermission", roleChangeOf(fixtures(), BOB_ID, "writer"));
    first.drive.set(FILE, since);
    expect(await first.apply(id)).toBeNull();
    expect(accessOf(first.drive.get(FILE)[1])).toEqual({ inherited: "writer" });
    expect(first.journal.get(id)).toBeUndefined();

    // The same, found by a look after the reply was lost.
    let lost = harness();
    id = await lost.submit("updatePermission", roleChangeOf(fixtures(), BOB_ID, "writer"));
    lost.drive.set(FILE, since);
    lost.loseUpdate();
    expect(await lost.apply(id)).toBe(UNCONFIRMED);
    expect(await lost.apply(id)).toBeNull();
    expect(lost.api.updatePermission).toHaveBeenCalledTimes(1);
    expect(lost.journal.get(id)).toBeUndefined();
  });

  type Moved = {
    name: string;
    queue(permissions: DrivePermissionRecord[]): DriveSharingAction;
    /** The file's permissions when the change is approved. */
    since: DrivePermissionRecord[];
    message: string;
  };
  let moved: Moved[] = [
    {
      name: "a share whose grantee was since given a lower role on the file", queue: shareZoe,
      since: [owner(), zoe(given("reader"))], message: GRANTEE_CHANGED,
    },
    {
      name: "a share whose grantee a parent since gives as much", queue: shareZoe,
      since: [owner(), zoe(inherited("writer"))], message: GRANTEE_CHANGED,
    },
    {
      name: "a share someone else already made", queue: shareZoe,
      since: [owner(), zoe(given("writer"))], message: GRANTEE_CHANGED,
    },
    { name: "a role change of access that is gone", queue: raiseBob, since: [owner()], message: ACCESS_GONE },
    {
      name: "a role change of access no longer given on the file", queue: raiseBob,
      since: [owner(), bob(inherited("commenter"))], message: ACCESS_GONE,
    },
    {
      name: "a role change of access a parent since gives at the new role", queue: raiseBob,
      since: [owner(), bob(inherited("writer"))], message: ACCESS_GONE,
    },
    {
      name: "a role change of access at another role", queue: raiseBob,
      since: [owner(), bob(given("commenter"))], message: ACCESS_CHANGED,
    },
    {
      name: "a role change someone else already made", queue: raiseBob,
      since: [owner(), bob(given("writer"))], message: ACCESS_CHANGED,
    },
    { name: "a removal someone else already made", queue: removeBob, since: [owner()], message: ACCESS_GONE },
    {
      name: "a removal of access no longer given on the file", queue: removeBob,
      since: [owner(), bob(inherited("reader"))], message: ACCESS_GONE,
    },
    {
      name: "a removal of access at another role", queue: removeBob,
      since: [owner(), bob(given("writer"))], message: ACCESS_CHANGED,
    },
  ];

  it.each(moved)("fails a change whose grantee's access moved on since it was queued: $name",
    async ({ queue, since, message }) => {
      let { drive, journal, attempts, submit, apply, sends } = harness();
      let action = queue(fixtures());
      let id = await submit(action.kind, action.payload);
      drive.set(FILE, since);
      expect(await apply(id)).toBe(message);
      expect(sends()).toBe(0);
      expect(failure(journal, id)).toEqual({ error: message });
      expect(attempts.has(id)).toBe(false);
      // A failed record answers a later approval from what it stored.
      expect(await apply(id)).toBe(message);
      expect(drive.get(FILE)).toEqual(since);
    });

  it("fails a change of a file whose permissions cannot all be read", async () => {
    let { api, journal, submit, apply, sends } = harness();
    let id = await submit("createPermission", shareOf(ZOE, "writer"));
    let page = 0;
    api.listPermissions.mockImplementation(
      async () => ({ permissions: [], nextPageToken: String(page++) }));
    expect(await apply(id)).toBe(TOO_LONG);
    expect(sends()).toBe(0);
    expect(failure(journal, id)).toEqual({ error: TOO_LONG });
  });

  it("holds whether access is found by searching to what the card said", async () => {
    /** Queues `queue` over `queuedAs`, approves it with Drive holding `since`, and answers. */
    let approve = async (
      queuedAs: DrivePermissionRecord[], since: DrivePermissionRecord[],
      queue: (permissions: DrivePermissionRecord[]) => DriveSharingAction,
    ) => {
      let run = harness(queuedAs);
      let action = queue(queuedAs);
      let id = await run.submit(action.kind, action.payload);
      run.drive.set(FILE, since);
      return { ...run, id, answer: await run.apply(id) };
    };
    let failed = (run: Awaited<ReturnType<typeof approve>>) => {
      expect(run.answer).toBe(ACCESS_CHANGED);
      expect(run.sends()).toBe(0);
      expect(failure(run.journal, run.id)).toEqual({ error: ACCESS_CHANGED });
    };

    // A domain's access made searchable since, under the same ID and role.
    let plain = [owner(), wholeDomain()];
    let searchable = [owner(), wholeDomain("example.com", true)];
    failed(await approve(plain, searchable, raiseOf(DOMAIN_ID)));
    let sent = await approve(plain, plain, raiseOf(DOMAIN_ID));
    expect(sent.answer).toBeNull();
    expect(sent.api.updatePermission.mock.calls).toEqual([[FILE, DOMAIN_ID, "writer"]]);

    // The link is one permission whose ID follows its form. Looked up by the ID it had, it would
    // read as gone while it still opens the file.
    let linkOnly = [owner(), link()];
    let found = [owner(), link("reader", true)];
    failed(await approve(found, linkOnly, removeOf("anyone")));
    failed(await approve(found, linkOnly, raiseOf("anyone")));
    failed(await approve(linkOnly, found, removeOf("anyoneWithLink")));
    failed(await approve(linkOnly, found, raiseOf("anyoneWithLink")));
    let removed = await approve(found, found, removeOf("anyone"));
    expect(removed.answer).toBeNull();
    expect(removed.api.deletePermission.mock.calls).toEqual([[FILE, "anyone"]]);
    expect(removed.drive.get(FILE)).toEqual([owner()]);

    // A domain's access listed in the other form under another ID than the card's.
    failed(await approve(plain, [owner(), wholeDomain("example.com", true, "67676767676767676767")],
      raiseOf(DOMAIN_ID)));
    failed(await approve(plain, [owner(), wholeDomain("example.com", true, "67676767676767676767")],
      removeOf(DOMAIN_ID)));
    // Two permissions for the card's domain, a list Drive is not known to send: the one under
    // the card's ID is judged.
    let two = await approve(plain,
      [owner(), wholeDomain("example.com", true, "67676767676767676767"), wholeDomain()],
      raiseOf(DOMAIN_ID));
    expect(two.answer).toBeNull();
    expect(two.api.updatePermission.mock.calls).toEqual([[FILE, DOMAIN_ID, "writer"]]);
    // A domain's access that is gone is gone, whatever else the file lists.
    let gone = await approve(plain, [owner(), wholeDomain("partner.example")], removeOf(DOMAIN_ID));
    expect(gone.answer).toBe(ACCESS_GONE);
    expect(gone.sends()).toBe(0);
  });

  it("fails a change whose file left the connection's scope, or that the account can no longer share", async () => {
    let actions: DriveSharingAction[] = [
      { kind: "createPermission", payload: shareOf(ZOE, "writer") },
      { kind: "updatePermission", payload: roleChangeOf(fixtures(), BOB_ID, "writer") },
      { kind: "deletePermission", payload: removalOf(fixtures(), BOB_ID) },
    ];
    let refusals: [(DriveScopeNode | undefined)[], string][] = [
      [[undefined], OUT_OF_SCOPE],
      [[{ id: FILE, canShare: false }], CANNOT_SHARE],
      // A capability Drive does not report reads as "cannot".
      [[{ id: FILE }], CANNOT_SHARE],
    ];
    for (let action of actions) {
      for (let [nodes, message] of refusals) {
        let { api, journal, submit, apply, sends } = harness();
        let id = await submit(action.kind, action.payload);
        api.getScopeNodes.mockResolvedValueOnce(nodes);
        expect(await apply(id), action.kind).toBe(message);
        expect(api.getScopeNodes.mock.calls).toEqual([[[FILE]]]);
        expect(api.listPermissions).not.toHaveBeenCalled();
        expect(sends()).toBe(0);
        expect(failure(journal, id)).toEqual({ error: message });
      }
    }

    // Another file than a single-file binding's own is out of its scope, with nothing asked.
    let other = harness();
    other.bind({ kind: "file", fileId: "doc-2" });
    let id = await other.submit("createPermission", shareOf(ZOE, "writer"));
    expect(await other.apply(id)).toBe(OUT_OF_SCOPE);
    expect(other.api.getScopeNodes).not.toHaveBeenCalled();

    // A folder binding proves the saved path, and the positioned folder as its own target.
    let folderMime = "application/vnd.google-apps.folder";
    let inFolder = harness();
    inFolder.bind({ kind: "folder", folderId: "R" });
    inFolder.api.getScopeNodes.mockImplementation(async ids => ids.map((nodeId): DriveScopeNode =>
      nodeId === "R"
        ? { id: "R", mimeType: folderMime, parents: ["above"], trashed: false, canListChildren: true }
        : { id: nodeId, parents: ["R"], trashed: false, canShare: true }));
    id = await inFolder.submit("createPermission", { ...shareOf(ZOE, "writer"), folderIds: ["R"] });
    expect(await inFolder.apply(id)).toBeNull();
    expect(inFolder.api.getScopeNodes.mock.calls).toEqual([[["R", FILE]]]);
    id = await inFolder.submit("createPermission",
      { ...shareOf(ZOE, "reader"), fileId: "R", folderIds: ["R"], self: true, isFolder: true });
    // The folder itself was not made shareable by the fake above.
    expect(await inFolder.apply(id)).toBe(CANNOT_SHARE);
    id = await inFolder.submit("createPermission", { ...shareOf(ZOE, "writer"), folderIds: ["S"] });
    expect(await inFolder.apply(id)).toBe(OUT_OF_SCOPE);
  });

  it("checks that the binding may still make changes before anything else", async () => {
    let { api, journal, attempts, submit, apply, refuse } = harness();
    let id = await submit("createPermission", shareOf(ZOE, "writer"));
    // The grant can be given again, so the change waits.
    refuse(WRITES_GRANT_MISSING);
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(journal.get(id)?.state).toBe("pending");
    expect(api.getScopeNodes).not.toHaveBeenCalled();
    // A binding's own level never changes, so that refusal is for good.
    refuse("This Google Drive connection is read-only.");
    expect(await apply(id)).toBe("This Google Drive connection is read-only.");
    expect(failure(journal, id)).toEqual({ error: "This Google Drive connection is read-only." });
    expect(api.getScopeNodes).not.toHaveBeenCalled();
    expect(attempts.has(id)).toBe(false);
  });

  it("removes access that sits on a parent's by lowering it to the parent's", async () => {
    let danaRun = harness();
    let id = await danaRun.submit("deletePermission", removalOf(fixtures(), DANA_ID));
    expect(await danaRun.apply(id)).toBeNull();
    expect(danaRun.api.updatePermission.mock.calls).toEqual([[FILE, DANA_ID, "commenter"]]);
    expect(danaRun.api.deletePermission).not.toHaveBeenCalled();
    expect(accessOf(danaRun.drive.get(FILE)[3])).toEqual({ inherited: "commenter" });

    let bobRun = harness();
    id = await bobRun.submit("deletePermission", removalOf(fixtures(), BOB_ID));
    expect(await bobRun.apply(id)).toBeNull();
    expect(bobRun.api.deletePermission.mock.calls).toEqual([[FILE, BOB_ID]]);
    expect(bobRun.api.updatePermission).not.toHaveBeenCalled();

    // What a parent gives is read when the removal is applied: a folder shared since is followed.
    let since = harness();
    id = await since.submit("deletePermission", removalOf([owner(), bob(given("writer"))], BOB_ID));
    since.drive.set(FILE, [owner(), bob(inherited("reader"), given("writer"))]);
    expect(await since.apply(id)).toBeNull();
    expect(since.api.updatePermission.mock.calls).toEqual([[FILE, BOB_ID, "reader"]]);
    expect(since.api.deletePermission).not.toHaveBeenCalled();

    // A parent's role above any that can be given is never sent: the delete is, and Google answers.
    let member = person(BOB_ID, "Bob", [inherited("organizer", "drive-1"), given("writer")]);
    let memberRun = harness([owner(), member]);
    id = await memberRun.submit("deletePermission", removalOf([owner(), member], BOB_ID));
    memberRun.api.deletePermission.mockResolvedValueOnce(undefined);
    expect(await memberRun.apply(id)).toBeNull();
    expect(memberRun.api.deletePermission.mock.calls).toEqual([[FILE, BOB_ID]]);
    expect(memberRun.api.updatePermission).not.toHaveBeenCalled();
  });

  it("never sends an update that could raise what it is removing", async () => {
    for (let parent of ["writer", "commenter"] as const) {
      let listed = [owner(), bob(inherited(parent), given("commenter"))];
      let { api, drive, journal, attempts, submit, apply } = harness(listed);
      let id = await submit("deletePermission", removalOf(listed, BOB_ID));
      // Drive does not delete access a parent also gives.
      expect(await apply(id)).toBe(CANNOT_DELETE);
      expect(api.deletePermission.mock.calls).toEqual([[FILE, BOB_ID]]);
      expect(api.updatePermission).not.toHaveBeenCalled();
      expect(failure(journal, id)).toEqual({ error: CANNOT_DELETE });
      expect(attempts.has(id)).toBe(false);
      expect(drive.get(FILE)).toEqual(listed);
    }
  });

  // Denying always withdraws: no state a sharing change can be left in refuses it.
  it("withdraws a change from every state approving can leave it in", async () => {
    type Run = ReturnType<typeof harness>;
    let states: [string, (run: Run) => Promise<number>][] = [
      ["never approved", run => run.submit("createPermission", shareOf(ZOE, "reader"))],
      ["a send Google did not confirm", async run => {
        run.api.createPermission.mockRejectedValueOnce(unconfirmed());
        let id = await run.submit("createPermission", shareOf(ZOE, "reader"));
        expect(await run.apply(id)).toBe(UNCONFIRMED);
        return id;
      }],
      ["an outcome that cannot be told", async run => {
        let id = await run.submit("deletePermission", removalOf(fixtures(), DANA_ID));
        run.api.updatePermission.mockImplementationOnce(async (fileId, permissionId, role) => {
          let lowered = person(DANA_ID, "Dana", [given(role)]);
          run.drive.set(fileId, run.drive.get(fileId).map(
            listed => listed.id === permissionId ? lowered : listed));
          return lowered;
        });
        run.api.deletePermission.mockRejectedValueOnce(
          new DriveApiRequestError(403, "cannotDeletePermission"));
        expect(await run.apply(id)).toBe(UNCONFIRMED);
        expect(await run.apply(id)).toBe(CHANGED_AGAIN);
        return id;
      }],
      ["failed for good at a check", async run => {
        let id = await run.submit("createPermission", shareOf(ZOE, "reader"));
        run.refuse("This Google Drive connection is read-only.");
        expect(await run.apply(id)).toBe("This Google Drive connection is read-only.");
        return id;
      }],
      ["an approval interrupted after its claim", async run => {
        let id = await run.submit("createPermission", shareOf(ZOE, "reader"));
        run.journal.markClaimed(id);
        return id;
      }],
    ];
    for (let [name, reach] of states) {
      let run = harness();
      let id = await reach(run);
      let sends = run.sends();
      await expect(run.actions.reject(id), name).resolves.toBeUndefined();
      expect(run.journal.get(id), name).toBeUndefined();
      expect(run.journal.listPending(), name).toEqual([]);
      expect(run.sends(), name).toBe(sends);
    }
  });

  it("deletes what an update to a parent's role left on the file", async () => {
    /** Dana as the file lists her, and an update that finds the parent's grant already gone. */
    let stale = () => {
      let run = harness();
      run.api.updatePermission.mockImplementationOnce(async (fileId, permissionId, role) => {
        let lowered = person(DANA_ID, "Dana", [given(role)]);
        run.drive.set(fileId, run.drive.get(fileId).map(
          listed => listed.id === permissionId ? lowered : listed));
        return lowered;
      });
      return run;
    };

    let run = stale();
    let id = await run.submit("deletePermission", removalOf(fixtures(), DANA_ID));
    expect(await run.apply(id)).toBeNull();
    expect(run.api.updatePermission.mock.calls).toEqual([[FILE, DANA_ID, "commenter"]]);
    expect(run.api.deletePermission.mock.calls).toEqual([[FILE, DANA_ID]]);
    expect(run.drive.get(FILE).map(listed => listed.id)).not.toContain(DANA_ID);
    expect(run.journal.get(id)).toBeUndefined();

    // The update changed the role, so a refusal of the delete does not mean nothing changed.
    let refused = stale();
    id = await refused.submit("deletePermission", removalOf(fixtures(), DANA_ID));
    refused.api.deletePermission.mockRejectedValueOnce(
      new DriveApiRequestError(403, "cannotDeletePermission"));
    expect(await refused.apply(id)).toBe(UNCONFIRMED);
    expect(refused.journal.get(id)?.state).toBe("pending");
    expect(refused.attempts.get(id)).toStrictEqual({ at: expect.any(Number) });
    expect(warn.mock.calls.map(([line]) => line)).toEqual([expect.objectContaining({
      event: "drive.sharing.send.failed", outcome: "unknown", actionId: id,
      actionKind: "deletePermission",
    })]);
    // The next approval reads her at the lowered role on the file: neither the card's nor none.
    expect(await refused.apply(id)).toBe(CHANGED_AGAIN);
    expect(failure(refused.journal, id)).toEqual({ error: CHANGED_AGAIN, outcome: "unknown" });
    expect(refused.api.updatePermission).toHaveBeenCalledTimes(1);
    expect(refused.api.deletePermission).toHaveBeenCalledTimes(1);

    // A failure of the first request is Google's answer to the removal, as it came.
    let first = harness();
    id = await first.submit("deletePermission", removalOf(fixtures(), DANA_ID));
    first.api.updatePermission.mockRejectedValueOnce(
      new DriveApiRequestError(403, "cannotModifyInheritedPermission"));
    expect(await first.apply(id)).toBe("That access comes from a parent folder, and access " +
      "given on the file cannot be set below it. [http=403 reason=cannotModifyInheritedPermission]");
    expect(first.api.deletePermission).not.toHaveBeenCalled();
  });

  type Refused = {
    status: number;
    reason?: string;
    /** Which send Google refuses: a share with this grantee, a role change, or a removal. */
    of: DriveGrantee | "role change" | "removal";
    options?: DriveShareOptions;
    message: string;
  };
  const SHARED: Omit<Refused, "status" | "reason" | "message"> = { of: ZOE };
  let refusals: Refused[] = [
    {
      status: 400, reason: "invalid", of: ZOE,
      message: "Google does not accept that address as a person's. If it is a group's address, " +
        "share with it as one.",
    },
    {
      status: 400, reason: "invalid", of: { type: "group", emailAddress: "all@example.com" },
      message: "Google does not accept that address.",
    },
    {
      status: 400, reason: "invalid", of: OWN_DOMAIN,
      message: "Google does not accept that domain: only a Google Workspace organization's " +
        "domain can be shared with.",
    },
    { status: 400, reason: "invalid", of: { type: "anyone" }, message: "Google Drive refused this sharing change." },
    { status: 400, reason: "invalid", of: "role change", message: "Google Drive refused this sharing change." },
    {
      status: 400, reason: "invalidSharingRequest", of: ZOE, options: { notify: false },
      message: "Google refused to share with that address without emailing it, which it " +
        "requires for an address that has no Google account. Share again with notify left on.",
    },
    { status: 400, reason: "invalidSharingRequest", ...SHARED, message: "Google refused this sharing request." },
    {
      status: 403, reason: "cannotModifyInheritedPermission", of: "role change",
      message: "That access comes from a parent folder, and access given on the file cannot be " +
        "set below it.",
    },
    {
      status: 403, reason: "cannotDeletePermission", of: "removal",
      message: "Google does not let the connected account remove that access. Access that comes " +
        "from a parent folder is removed on that folder.",
    },
    { status: 403, reason: "cannotRemoveOwner", of: "role change", message: "The owner's access cannot be changed." },
    {
      status: 404, reason: "notFound", of: "removal",
      message: "Google Drive no longer shows that file or that access to the connected account.",
    },
    { status: 404, reason: "notFound", ...SHARED, message: "Google Drive no longer shows that file or that access to the connected account." },
    { status: 403, reason: "insufficientFilePermissions", ...SHARED, message: CANNOT_SHARE },
    {
      status: 403, reason: "shareOutNotPermitted", ...SHARED,
      message: "Your organization does not allow sharing this outside the organization.",
    },
    {
      status: 403, reason: "shareInNotPermitted", ...SHARED,
      message: "The recipient's organization does not accept files shared from outside it.",
    },
    {
      status: 403, reason: "publishOutNotPermitted", of: { type: "anyone" },
      message: "Your organization does not allow sharing this with anyone who has the link.",
    },
    {
      status: 403, reason: "teamDriveDomainUsersOnlyRestriction", ...SHARED,
      message: "This shared drive allows sharing only inside its organization.",
    },
    {
      status: 403, reason: "teamDriveTeamMembersOnlyRestriction", ...SHARED,
      message: "This shared drive allows sharing only with its members.",
    },
    {
      status: 403, reason: "cannotShareTeamDriveWithNonGoogleAccounts", ...SHARED,
      message: "This shared drive cannot be shared with an address that has no Google account.",
    },
    {
      status: 403, reason: "abusiveContentRestriction", ...SHARED,
      message: "Google does not allow this file to be shared.",
    },
    {
      status: 403, reason: "cannotSetExpiration", of: "role change",
      message: "Google does not allow an expiry date on this access.",
    },
    {
      status: 403, reason: "domainPolicy", ...SHARED,
      message: "Your organization's administrator does not allow this app to use Google Drive.",
    },
    { status: 403, reason: "somethingNew", ...SHARED, message: "Google Drive refused this sharing change." },
    { status: 403, ...SHARED, message: "Google Drive refused this sharing change." },
    // A row's status is part of it: the same reason under another status is not that row.
    { status: 400, reason: "cannotDeletePermission", of: "removal", message: "Google Drive refused this sharing change." },
  ];

  it.each(refusals)("turns Google's refusal into words and keeps its code: $status $reason",
    async ({ status, reason, of, options, message }) => {
      let { api, drive, journal, attempts, submit, apply, sends } = harness([owner(), bob()]);
      let refusal = new DriveApiRequestError(status, reason);
      let id: number;
      if (of === "role change") {
        api.updatePermission.mockRejectedValueOnce(refusal);
        id = await submit("updatePermission", roleChangeOf([owner(), bob()], BOB_ID, "writer"));
      } else if (of === "removal") {
        api.deletePermission.mockRejectedValueOnce(refusal);
        id = await submit("deletePermission", removalOf([owner(), bob()], BOB_ID));
      } else {
        api.createPermission.mockRejectedValueOnce(refusal);
        id = await submit("createPermission", shareOf(of, "reader", options, [owner(), bob()]));
      }
      let code = reason === undefined ? `[http=${status}]` : `[http=${status} reason=${reason}]`;
      expect(await apply(id)).toBe(`${message} ${code}`);
      // Refused, so nothing changed: the record fails for good and no marker is left.
      expect(sends()).toBe(1);
      expect(failure(journal, id)).toEqual({ error: `${message} ${code}` });
      expect(attempts.has(id)).toBe(false);
      expect(drive.get(FILE)).toEqual([owner(), bob()]);
      expect(warn.mock.calls.map(([line]) => line)).toEqual([expect.objectContaining({
        event: "drive.sharing.send.failed", outcome: "absent", httpStatus: status, actionId: id,
        ...(reason === undefined ? {} : { providerReasons: [reason] }),
      })]);
    });

  it("says when the Drive API is not enabled for the deployment", async () => {
    let { api, journal, submit, apply } = harness();
    api.createPermission.mockRejectedValueOnce(new DriveApiDisabledError("disabled"));
    let id = await submit("createPermission", shareOf(ZOE, "reader"));
    let message = "The Google Drive API is not enabled for this deployment's Google project. " +
      "[http=403 reason=accessNotConfigured]";
    expect(await apply(id)).toBe(message);
    expect(failure(journal, id)).toEqual({ error: message });
  });

  it("keeps a change pending on a rate limit and on a missing scope", async () => {
    let answers: [DriveApiRequestError, string][] = [
      [new DriveApiRequestError(429, "rateLimitExceeded"), RATE_LIMITED],
      [new DriveApiRequestError(403, "sharingRateLimitExceeded"), RATE_LIMITED],
      [new DriveApiRequestError(403, "userRateLimitExceeded"), RATE_LIMITED],
      [new DriveApiRequestError(403, "insufficientPermissions"), WRITES_GRANT_MISSING],
    ];
    for (let [answer, message] of answers) {
      let { api, journal, attempts, submit, apply } = harness();
      api.createPermission.mockRejectedValueOnce(answer);
      let id = await submit("createPermission", shareOf(ZOE, "reader"));
      expect(await apply(id)).toBe(message);
      expect(journal.get(id)?.state).toBe("pending");
      // The marker stays, so the next approval looks before it sends.
      expect(attempts.get(id)).toStrictEqual({ at: expect.any(Number) });
      expect(await apply(id)).toBeNull();
      expect(api.listPermissions).toHaveBeenCalledTimes(3);
      expect(api.createPermission).toHaveBeenCalledTimes(2);
    }
  });

  it("keeps a change pending when Google stops accepting the approval's token", async () => {
    let { api, drive, journal, attempts, submit, apply } = harness();
    api.createPermission.mockRejectedValueOnce(expiredToken());
    let id = await submit("createPermission", shareOf(ZOE, "reader"));
    expect(await apply(id)).toBe(CREDENTIALS_NOT_ACCEPTED);
    expect(journal.get(id)?.state).toBe("pending");
    let marker = attempts.get(id);
    expect(marker).toStrictEqual({ at: expect.any(Number) });

    // A look answered 401 decides nothing: the error is passed on, and the marker is as it was.
    api.listPermissions.mockRejectedValueOnce(expiredToken());
    expect(await apply(id)).toBe("Google Drive API request failed: 401 (authError)");
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.get(id)).toBe(marker);
    expect(api.createPermission).toHaveBeenCalledTimes(1);

    // The next approval looks, finds nothing made, and sends again.
    api.listPermissions.mockClear();
    expect(await apply(id)).toBeNull();
    expect(api.listPermissions).toHaveBeenCalledTimes(2);
    expect(api.createPermission).toHaveBeenCalledTimes(2);
    expect(matchGrantee(drive.get(FILE), ZOE)).toHaveLength(1);

    // So does a check: with no send made yet there is no marker to keep.
    let checked = harness();
    id = await checked.submit("createPermission", shareOf(ZOE, "reader"));
    for (let read of [checked.api.getScopeNodes, checked.api.listPermissions]) {
      read.mockRejectedValueOnce(expiredToken());
      expect(await checked.apply(id)).toBe("Google Drive API request failed: 401 (authError)");
      expect(checked.journal.get(id)?.state).toBe("pending");
      expect(checked.attempts.has(id)).toBe(false);
    }
    expect(checked.sends()).toBe(0);
  });

  it("takes a change an unconfirmed send made for applied, without sending again", async () => {
    let share = harness();
    let id = await share.submit("createPermission", shareOf(ZOE, "reader"));
    share.loseCreate();
    expect(await share.apply(id)).toBe(UNCONFIRMED);
    expect(share.journal.get(id)?.state).toBe("pending");
    expect(share.attempts.get(id)).toStrictEqual({ at: expect.any(Number) });
    expect(await share.apply(id)).toBeNull();
    expect(share.api.createPermission).toHaveBeenCalledTimes(1);
    expect(share.journal.get(id)).toBeUndefined();
    // What the look found is logged as found, not as made.
    expect(info.mock.calls.map(([line]) => line)).toEqual([expect.objectContaining({
      event: "drive.sharing.reconciled", outcome: "found", actionId: id,
      actionKind: "createPermission",
    })]);

    let change = harness();
    id = await change.submit("updatePermission", roleChangeOf(fixtures(), BOB_ID, "writer"));
    change.loseUpdate();
    expect(await change.apply(id)).toBe(UNCONFIRMED);
    expect(await change.apply(id)).toBeNull();
    expect(change.api.updatePermission).toHaveBeenCalledTimes(1);

    let removal = harness();
    id = await removal.submit("deletePermission", removalOf(fixtures(), BOB_ID));
    removal.loseDelete();
    expect(await removal.apply(id)).toBe(UNCONFIRMED);
    expect(await removal.apply(id)).toBeNull();
    expect(removal.api.deletePermission).toHaveBeenCalledTimes(1);

    // An earlier send's change is found whatever the binding may do by then.
    let refusedSince = harness();
    id = await refusedSince.submit("createPermission", shareOf(ZOE, "reader"));
    refusedSince.loseCreate();
    expect(await refusedSince.apply(id)).toBe(UNCONFIRMED);
    refusedSince.refuse(WRITES_GRANT_MISSING);
    expect(await refusedSince.apply(id)).toBeNull();
  });

  it("sends again when the earlier send changed nothing, however often", async () => {
    let { api, journal, attempts, submit, apply } = harness();
    api.createPermission.mockRejectedValue(unconfirmed());
    let id = await submit("createPermission", shareOf(ZOE, "reader"));
    for (let approval = 1; approval <= 4; approval++) {
      expect(await apply(id)).toBe(UNCONFIRMED);
      expect(api.createPermission).toHaveBeenCalledTimes(approval);
      // One read for the checks, and from the second approval on one for the look before them.
      expect(api.listPermissions).toHaveBeenCalledTimes(2 * approval - 1);
      expect(journal.get(id)?.state).toBe("pending");
      // The marker notes nothing of the file's permissions.
      expect(attempts.get(id)).toStrictEqual({ at: expect.any(Number) });
    }
  });

  it("gives up as unknown when the access changed again", async () => {
    let share: DriveSharingAction = { kind: "createPermission", payload: shareOf(ZOE, "writer", undefined, [owner()]) };
    // A lower role given on the file, and a parent that gives as much: neither is what the card
    // described, nor what a send of it makes.
    await approveAgain([owner()], share, [owner(), zoe(given("reader"))]);
    await approveAgain([owner()], share, [owner(), zoe(inherited("writer"))]);

    // A share with anyone approved as link-only, whose look finds the link found by searching.
    let linkShare: DriveSharingAction =
      { kind: "createPermission", payload: shareOf({ type: "anyone" }, "reader", undefined, [owner()]) };
    await approveAgain([owner()], linkShare, [owner(), link("reader", true)]);

    // A removal and a role change of the link queued as `anyoneWithLink`, with the link made
    // searchable since: a look by the stored ID would find nothing, and take the removal for made.
    let linkOnly = [owner(), link()];
    await approveAgain(linkOnly, { kind: "deletePermission", payload: removalOf(linkOnly, "anyoneWithLink") },
      [owner(), link("reader", true)]);
    await approveAgain(linkOnly, { kind: "updatePermission", payload: roleChangeOf(linkOnly, "anyoneWithLink", "writer") },
      [owner(), link("reader", true)]);
    await approveAgain(linkOnly, { kind: "updatePermission", payload: roleChangeOf(linkOnly, "anyoneWithLink", "writer") },
      [owner(), link("writer", true)]);

    // A role that is neither the card's nor the one it set, and access that went altogether.
    let withBob = [owner(), bob()];
    let raise: DriveSharingAction =
      { kind: "updatePermission", payload: roleChangeOf(withBob, BOB_ID, "writer") };
    await approveAgain(withBob, raise, [owner(), bob(given("commenter"))]);
    await approveAgain(withBob, raise, [owner()]);
    await approveAgain(withBob, raise, [owner(), bob(inherited("commenter"))]);
    await approveAgain(withBob, { kind: "deletePermission", payload: removalOf(withBob, BOB_ID) },
      [owner(), bob(given("writer"))]);
  });

  it("keeps a write pending when Google answers 400 invalidParameter, and finds what it made", async () => {
    let { api, journal, attempts, submit, apply, loseCreate } = harness();
    let id = await submit("createPermission", shareOf(ZOE, "reader"));
    // Google answers a response mask it does not accept after it has made the write.
    loseCreate(new DriveApiRequestError(400, "invalidParameter"));
    expect(await apply(id)).toBe(UNCONFIRMED);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.has(id)).toBe(true);
    expect(await apply(id)).toBeNull();
    expect(api.createPermission).toHaveBeenCalledTimes(1);

    // Any other 400 is a refusal: read as unknown it would never reach the approver as one.
    let refused = harness();
    refused.api.createPermission.mockRejectedValueOnce(
      new DriveApiRequestError(400, "invalidSharingRequest"));
    id = await refused.submit("createPermission", shareOf(ZOE, "reader"));
    let message = "Google refused this sharing request. [http=400 reason=invalidSharingRequest]";
    expect(await refused.apply(id)).toBe(message);
    expect(failure(refused.journal, id)).toEqual({ error: message });
    expect(refused.attempts.has(id)).toBe(false);
  });

  it("gives up as unknown when the sharing can no longer be read", async () => {
    let page = 0;
    let unreadable: (() => Promise<never> | Promise<{ permissions: []; nextPageToken: string }>)[] = [
      // What Google answers the list of a file the account can no longer share, or see.
      async () => { throw new DriveApiRequestError(403, "insufficientFilePermissions"); },
      async () => { throw new DriveApiRequestError(404, "notFound"); },
      async () => ({ permissions: [], nextPageToken: String(page++) }),
    ];
    for (let read of unreadable) {
      let { api, journal, attempts, submit, apply, sends } = harness();
      api.createPermission.mockRejectedValueOnce(unconfirmed());
      let id = await submit("createPermission", shareOf(ZOE, "reader"));
      expect(await apply(id)).toBe(UNCONFIRMED);
      api.listPermissions.mockImplementation(read);
      expect(await apply(id)).toBe(NOT_SHOWN);
      expect(failure(journal, id)).toEqual({ error: NOT_SHOWN, outcome: "unknown" });
      expect(sends()).toBe(1);
      expect(attempts.has(id)).toBe(true);
    }

    // A refusal that is about the account, not the file, decides nothing.
    let limited = harness();
    limited.api.createPermission.mockRejectedValueOnce(unconfirmed());
    let id = await limited.submit("createPermission", shareOf(ZOE, "reader"));
    expect(await limited.apply(id)).toBe(UNCONFIRMED);
    limited.api.listPermissions.mockRejectedValueOnce(
      new DriveApiRequestError(403, "rateLimitExceeded"));
    expect(await limited.apply(id)).toBe("Google Drive API request failed: 403 (rateLimitExceeded)");
    expect(limited.journal.get(id)?.state).toBe("pending");
    expect(limited.attempts.has(id)).toBe(true);
  });

  it("keeps a write pending, with its marker, when the look is refused for a missing scope", async () => {
    let { api, journal, attempts, submit, apply, sends } = harness();
    api.createPermission.mockRejectedValueOnce(unconfirmed());
    let id = await submit("createPermission", shareOf(ZOE, "reader"));
    expect(await apply(id)).toBe(UNCONFIRMED);
    let marker = attempts.get(id);
    // The token lost the scope: that says nothing of the file, and is not read as invisible.
    api.listPermissions.mockRejectedValueOnce(
      new DriveApiRequestError(403, "insufficientPermissions"));
    expect(await apply(id)).toBe(WRITES_GRANT_MISSING);
    expect(journal.get(id)?.state).toBe("pending");
    expect(attempts.get(id)).toBe(marker);
    expect(sends()).toBe(1);
  });

  it("takes a person where the card said a group, and ends as unknown when Google records more than the card named", async () => {
    let asGroup: DriveGrantee = { type: "group", emailAddress: "zoe@example.com" };
    /** Makes the next create record the grantee as `type`, whatever kind was sent. */
    let recordAs = (run: ReturnType<typeof harness>, type: "user" | "group", lose = false) => {
      run.api.createPermission.mockImplementationOnce(async (fileId, grant) => {
        let made = run.drive.create(fileId, { ...grant, type });
        if (lose) throw unconfirmed();
        return made;
      });
    };

    // Google records a person's address shared as a group's as that person's.
    let taken = harness();
    recordAs(taken, "user");
    let id = await taken.submit("createPermission", shareOf(asGroup, "reader"));
    expect(await taken.apply(id)).toBeNull();
    expect(taken.journal.get(id)).toBeUndefined();
    expect(toAccessEntries(taken.drive.get(FILE), OWNER_ID)).toContainEqual(
      expect.objectContaining({ type: "user", role: "reader", emailAddress: "zoe@example.com" }));

    let found = harness();
    recordAs(found, "user", true);
    id = await found.submit("createPermission", shareOf(asGroup, "reader"));
    expect(await found.apply(id)).toBe(UNCONFIRMED);
    expect(await found.apply(id)).toBeNull();
    expect(found.api.createPermission).toHaveBeenCalledTimes(1);

    // A group is more people than an approval that said a person named.
    let wider = "Google gave this access to a group, where the approval said a person. Check who " +
      "has access to the file on Google Drive, then reject this to clear it.";
    for (let lose of [false, true]) {
      let more = harness();
      recordAs(more, "group", lose);
      id = await more.submit("createPermission", shareOf(ZOE, "reader"));
      if (lose) expect(await more.apply(id)).toBe(UNCONFIRMED);
      expect(await more.apply(id)).toBe(wider);
      expect(failure(more.journal, id)).toEqual({ error: wider, outcome: "unknown" });
      expect(more.attempts.has(id)).toBe(true);
      expect(await more.apply(id)).toBe(wider);
      expect(more.api.createPermission).toHaveBeenCalledTimes(1);
    }
  });

  it("ends as unknown when Google gives access in another form than the card said", async () => {
    // A create over a link made searchable since the check answers with the searchable link.
    let widened = harness([owner()]);
    widened.api.createPermission.mockImplementationOnce(
      async (fileId, grant) => widened.drive.create(fileId, { ...grant, allowFileDiscovery: true }));
    let id = await widened.submit("createPermission",
      shareOf({ type: "anyone" }, "reader", undefined, [owner()]));
    let can = "Google gave this access so that it can be found by searching, where the approval " +
      "said it could not. Check who has access to the file on Google Drive, then reject this to " +
      "clear it.";
    expect(await widened.apply(id)).toBe(can);
    expect(failure(widened.journal, id)).toEqual({ error: can, outcome: "unknown" });
    expect(widened.attempts.has(id)).toBe(true);

    let narrowed = harness([owner()]);
    narrowed.api.createPermission.mockImplementationOnce(
      async (fileId, grant) => ({ ...narrowed.drive.create(fileId, grant), allowFileDiscovery: false }));
    id = await narrowed.submit("createPermission",
      shareOf(PARTNER, "reader", { discoverable: true }, [owner()]));
    let cannot = can.replace("can be found", "cannot be found").replace("could not", "could");
    expect(cannot).toBe("Google gave this access so that it cannot be found by searching, where " +
      "the approval said it could. Check who has access to the file on Google Drive, then " +
      "reject this to clear it.");
    expect(await narrowed.apply(id)).toBe(cannot);
    expect(failure(narrowed.journal, id)).toEqual({ error: cannot, outcome: "unknown" });
    expect(narrowed.attempts.has(id)).toBe(true);
  });

  it("logs IDs and outcomes only", async () => {
    let bound = { component: "gatekeeper.google.drive.sharing", vendorId: "google", fileId: FILE };
    let { api, submit, apply, loseUpdate } = harness();
    let share = await submit("createPermission", shareOf(ZOE, "writer", { message: MESSAGE }));
    expect(await apply(share)).toBeNull();
    let change = await submit("updatePermission", roleChangeOf(fixtures(), BOB_ID, "writer"));
    loseUpdate();
    expect(await apply(change)).toBe(UNCONFIRMED);
    expect(await apply(change)).toBeNull();
    let removal = await submit("deletePermission", removalOf(fixtures(), "anyoneWithLink"));
    api.deletePermission.mockRejectedValueOnce(new DriveApiRequestError(403, "cannotDeletePermission"));
    expect(await apply(removal)).toBe(CANNOT_DELETE);

    expect(info.mock.calls.map(([line]) => line)).toEqual([
      expect.objectContaining({
        ...bound, actionId: share, actionKind: "createPermission", event: "drive.sharing.applied",
        outcome: "applied",
      }),
      expect.objectContaining({
        ...bound, actionId: change, actionKind: "updatePermission",
        event: "drive.sharing.reconciled", outcome: "found",
      }),
    ]);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      expect.objectContaining({
        ...bound, actionId: change, actionKind: "updatePermission",
        event: "drive.sharing.send.failed", outcome: "unknown", httpStatus: 503,
        providerReasons: ["backendError"],
      }),
      expect.objectContaining({
        ...bound, actionId: removal, actionKind: "deletePermission",
        event: "drive.sharing.send.failed", outcome: "absent", httpStatus: 403,
        providerReasons: ["cannotDeletePermission"],
      }),
    ]);
    expect(error).not.toHaveBeenCalled();
    // The hook above holds every line of every case here to IDs, statuses and reasons.
    expect(logged()).toHaveLength(4);
  });
});
