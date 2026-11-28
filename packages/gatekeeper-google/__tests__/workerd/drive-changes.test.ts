import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveBindingScope } from "../../src/drive-session";
import type { DriveAccess, DriveEntry, GoogleDriveFolderSession } from "../../src/drive-types";
import type { DriveFileReadOptions } from "../../src/drive-read-types";
import {
  DRIVE_WRITES_GRANT, GOOGLE_DRIVE_RESOURCE, type DriveAccessLevel,
} from "../../src/resources";
import { DRIVE_DOCS_KINDS, DRIVE_SHEETS_KINDS, DRIVE_SLIDES_KINDS } from "../drive-edit-kinds";
import { presentation, shape, slide, text } from "../slides-fixture";
import { SlidesProvider } from "../slides-provider";

// Sharing changes and moves through the Drive gatekeeper itself: queued by a session, then applied,
// rejected or reverted by the gatekeeper, against a Drive that answers as Google was seen to.

const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const SLIDES_MIME = "application/vnd.google-apps.presentation";

const ROOT = "folder-root";
const MY_ROOT = "my-root";
const GRANTED = [GOOGLE_DRIVE_RESOURCE.urlPattern, DRIVE_WRITES_GRANT];
const FOLDER_URL = "https://drive.google.com/drive/folders/folder-root";
const FILE_URL = "https://drive.google.com/file/d/doc-1/view";

/** The token a reconnect as the second Google account stores. */
const OTHER_TOKEN = "other-google-account-token";

/** The two Google accounts the provider knows, by the token a request carries. */
const ACCOUNT_A = { permissionId: "perm-A", emailAddress: "me@example.com" };
const ACCOUNT_B = { permissionId: "perm-B", emailAddress: "other@partner.example" };

const BOB = { type: "user", emailAddress: "bob@example.com" } as const;
const CAROL = { type: "user", emailAddress: "carol@example.com" } as const;
const DANA = { type: "user", emailAddress: "dana@example.com" } as const;
const ERIN = { type: "user", emailAddress: "erin@example.com" } as const;
const TEAM = { type: "group", emailAddress: "team@example.com" } as const;
const ANYONE = { type: "anyone" } as const;

const READ_ONLY = (url: string) =>
  "This Google Drive connection is read-only, so it cannot make changes. Changes take a " +
  "connection with read and write access, which the user chooses when connecting. Request one " +
  `with this resource URL: ${url}`;
const READ_ONLY_ACCOUNT =
  "This Google Drive connection is read-only, so it cannot make changes. Changes take a " +
  "connection with read and write access, which the user chooses when connecting. To change " +
  "one file, or the files of one folder, request the narrower " +
  "https://drive.google.com/file/d/<fileId>/view?access=write or " +
  "https://drive.google.com/drive/folders/<folderId>?access=write instead. For all of Drive, " +
  "request this resource URL: https://drive.google.com/drive/my-drive?access=write";
const GRANT_MISSING =
  "Changes need a permission this Google account hasn't granted, or no longer grants. In " +
  "Workshop, start adding a Google Drive connection for this account, choose all of Drive or a " +
  "folder, then \"Read and write\", and select \"Allow changes\". The permission covers every " +
  "read and write Drive connection on the account, so the dialog can then be closed.";
const DEPLOYMENT_READ_ONLY =
  "This deployment keeps Google Drive read-only, so no Google Drive connection can make " +
  "changes, and none can be connected with read and write access. Only the deployment's " +
  "administrator can change that.";
const LISTING_TAKES_WRITES = "Seeing who a file is shared with takes what changing it takes.";
const MOVE_NEEDS_A_FOLDER =
  "Moving takes a folder or all-of-Drive connection: the single-file connection named below " +
  "cannot move a file.";
const MOVE_SINGLE_FILE =
  "A single-file Drive binding cannot move its file. Moving takes a folder binding that holds " +
  "both the folder the file is in and the folder it goes to, or an all-of-Drive binding, with " +
  "read and write access.";
const OUTSIDE = "The requested file is outside this Drive binding.";
const THROUGH_SHORTCUT =
  "This folder was opened through a shortcut, so its files can be read here but not changed, " +
  "commented on, shared, listed for who they are shared with, or moved.";
const ACCESS_NAME =
  "That does not name access. Pass the id of an entry listAccess() returned, or a grantee: " +
  "{ type: \"user\", emailAddress }, { type: \"group\", emailAddress }, " +
  "{ type: \"domain\", domain } or { type: \"anyone\" }.";
const SHARED_DRIVE_ROOT =
  "A shared drive's own sharing is its membership, which is neither listed nor changed here. " +
  "Its members are listed as inherited access on any file or folder in the drive.";
const MY_DRIVE_ROOT_SHARING =
  "The top level of My Drive itself is neither listed nor shared here. Share a file or a folder " +
  "in it instead.";
const CANNOT_SHARE = (fileId: string) =>
  `The connected account cannot change who has access to Drive file ${fileId}, so its sharing ` +
  "cannot be read or changed here.";
const SHARE_PENDING = "That grantee already has access to this file waiting for approval.";
const CHANGE_PENDING = "That access already has a change waiting for approval.";
const SHARE_BEHIND_CHANGE =
  "That grantee's access has a change waiting for approval. Once it is decided, share again " +
  "if the access was removed, or change its role with updateAccess().";
const ACCESS_WAITING_CHANGE =
  "That access is waiting for approval and has not been given yet. Change its role once it is " +
  "given, or have the user reject it and share again with the role wanted.";
const ACCESS_WAITING_REMOVE =
  "That access is waiting for approval and has not been given yet. To withdraw it, have the " +
  "user reject it.";
const PENDING_SPENT =
  "That pending ID names no access waiting for approval. If it was given, list the file's " +
  "access again and use its Drive ID.";
const OWNER_OR_MANAGER =
  "An owner's, manager's or content manager's access cannot be changed here.";
const OWN_ACCESS = "The connected account's own access cannot be changed here.";
const INHERITED_ONLY =
  "That access comes from a parent folder or the shared drive, not from this file, so it " +
  "cannot be changed here. share() can give a higher role on this file; the access itself is " +
  "changed where it comes from.";
const UNCONFIRMED =
  "Google Drive did not confirm whether this change was made, and it may have been. Approving " +
  "it again first checks the file, so it is not made twice; rejecting it leaves anything " +
  "already changed as it is.";
const UNCONFIRMED_MOVE =
  "Google Drive did not confirm whether this was moved, and it may have been. Approving it " +
  "again first checks where the file is, so it is not moved twice; rejecting it leaves the file " +
  "wherever it is.";
const CHANGED_AGAIN =
  "This was changed again on Google Drive after it was first sent, so it was left as it is. " +
  "Check the file, then reject this to clear it.";
const ACCESS_CHANGED = "That access changed after this was queued, so nothing was changed.";
const NO_LONGER_IN_SCOPE = "That file is no longer in this connection's scope.";
const FENCE_REPLACED =
  "This action was approved under a connection that has since been replaced. Reject it and " +
  "submit it again.";
const SEND_IN_DOUBT_OTHER_ACCOUNT =
  "An earlier attempt at this may already have changed the file, and it was made as another " +
  "Google account than the one connected now, so it can't be checked or finished as this one. " +
  "Reconnect as the account that queued it and approve it again, which first checks the file. " +
  "Or check the file on Google Drive, then reject this to clear it.";
const CREDENTIALS_NOT_ACCEPTED =
  "Google did not accept this connection's credentials for this change. Approve it again, " +
  "which first checks the file; if it is refused the same way, reconnect the Google account.";
const SHARE_OUT_REFUSED =
  "Your organization does not allow sharing this outside the organization. " +
  "[http=403 reason=shareOutNotPermitted]";
const MOVE_PENDING =
  "That file already has a move waiting for approval. To move it somewhere else instead, have " +
  "the user reject that move first.";
const MOVE_WAITING =
  "That file, or a folder it is in, has a move waiting for approval, which takes it out of " +
  "where this binding reaches it now. Queue this once the move is decided, from the folder the " +
  "file is then in.";
const MOVE_DESTINATION_WAITING =
  "That destination folder has a move waiting for approval. Queue this once that move is decided.";
const MOVE_FOLDER_DESTINATION =
  "That is not a folder this binding can move into: the destination is a direct child folder of " +
  "the positioned folder, or getScope().parentFolderId. A folder further away inside the " +
  "connected folder is reached one level per move, each from the session of the folder the file " +
  "is then in; one outside it takes a binding to a folder that holds both ends, or to all of " +
  "Drive.";
const MOVE_ACCESS =
  "It takes the sharing of the folder it goes into: everyone with access to that folder gains " +
  "access to it, and access it had only through the folder it leaves is lost. Access given on it " +
  "directly that the new folder also gives is merged into the folder's, and does not come back if " +
  "it is moved out again.";
const NO_REVERT = "Google Drive changes cannot be reverted automatically.";
const COPIES = { tag: "driveCopies", label: "Drive copies" };
const COPY_WAITING =
  "That file is a copy or an upload still waiting to be made, so this cannot be done with it " +
  "yet. It is made once it is approved, which an auto-approval rule may do in moments: call " +
  "getEntry() with this ID later to see whether it has been made.";
const NAMES_NO_COPY =
  "That pending ID names no copy or upload that was made: it was rejected or failed, or the ID " +
  "is not a copy's or an upload's.";
const COPY_SINGLE_FILE =
  "A single-file Drive binding cannot copy its file. Copying takes a folder binding or an " +
  "all-of-Drive binding, with read and write access.";
const COPY_FOLDER_DESTINATION =
  "That is not a folder this binding can copy into: the destination is the positioned folder, a " +
  "direct child folder of it, or getScope().parentFolderId. A folder further away inside the " +
  "connected folder is reached from a session opened at it or next to it; one outside it takes a " +
  "binding to a folder that holds both, or to all of Drive.";
const COPY_FOLDER = "A folder cannot be copied. Copy the files in it one at a time.";
const UNCONFIRMED_COPY =
  "Google Drive did not confirm whether this copy was made, and it may have been. Approving it " +
  "again first checks for it, so it is not made twice; rejecting it leaves any copy that was made.";
const UNCONFIRMED_NATIVE_COPY =
  "Google Drive did not confirm whether this copy was made, and it may have been: Google Drive " +
  "can take a while to show a new file. It won't be sent again. Approving it again looks for the " +
  "copy once more; rejecting it leaves any copy that was made.";
const COPY_SHARING =
  "The copy takes the sharing of the folder it goes into: everyone with access to that folder " +
  "can open it.";

type Role = "reader" | "commenter" | "writer" | "fileOrganizer" | "organizer" | "owner";
const RANK: Record<Role, number> = {
  reader: 0, commenter: 1, writer: 2, fileOrganizer: 3, organizer: 4, owner: 5,
};

type FakeFile = {
  name: string; mimeType: string; modifiedTime: string; parents: string[]; driveId?: string;
  trashed: boolean; canListChildren: boolean; canComment: boolean; canShare: boolean;
  canAddChildren: boolean; canMoveItemWithinDrive: boolean; canCopy: boolean;
  canEdit: boolean; canModifyContent: boolean; canDownload: boolean;
  /** Set on a shortcut: the file or folder it points to. */
  shortcutTargetId?: string;
  /** A file's bytes, as text: what a download answers, and its size. */
  content?: string;
  /** The revision of its content Drive holds now, and the content's SHA-256: a binary file's. */
  headRevisionId?: string;
  sha256Checksum?: string;
  /** Its app properties, which a copy keeps unless the request sets or clears them. */
  appProperties?: Record<string, string>;
};

/** Access given on one file itself. Anyone's carries no ID of its own: its form decides it. */
type Grant = {
  type: "user" | "group" | "domain" | "anyone"; role: Role;
  emailAddress?: string; displayName?: string; domain?: string; allowFileDiscovery?: boolean;
  /**
   * The ID it is listed under, in place of its grantee's own: what makes a second permission of
   * one address, a list Drive is not known to send.
   */
  id?: string;
  /** The account behind it was deleted: Drive goes on listing the permission, flagged. */
  deleted?: true;
};

type Detail = { permissionType: "file"; role: Role; inherited: boolean };
type WirePermission = Omit<Grant, "role" | "deleted"> & {
  id: string; role: Role; deleted: boolean; permissionDetails: Detail[];
};

type Answer = { status: number; reason?: string };

function driveError({ status, reason }: Answer): Response {
  let message = `Request failed: ${status}.`;
  return Response.json({
    error: { code: status, message, errors: reason ? [{ message, domain: "global", reason }] : [] },
  }, { status });
}

function file(mimeType: string, parents: string[], overrides: Partial<FakeFile> = {}): FakeFile {
  let folder = mimeType === FOLDER_MIME;
  return {
    name: "", mimeType, modifiedTime: "2026-10-20T09:00:00Z", parents, trashed: false,
    canListChildren: folder, canComment: !folder, canShare: true, canAddChildren: folder,
    canMoveItemWithinDrive: true, canCopy: !folder, canEdit: true, canModifyContent: true,
    canDownload: true, ...overrides,
  };
}

/** Google Drive's files, parents, capabilities and permissions as far as these tests need them. */
class DriveProvider {
  readonly files = new Map<string, FakeFile>([
    [MY_ROOT, file(FOLDER_MIME, [], { name: "My Drive" })],
    ["loose-doc", file(DOC_MIME, [MY_ROOT])],
    ["elsewhere", file(FOLDER_MIME, [MY_ROOT])],
    [ROOT, file(FOLDER_MIME, ["above"])],
    ["inner", file(FOLDER_MIME, [ROOT])],
    ["archive", file(FOLDER_MIME, [ROOT])],
    ["nested-doc", file(DOC_MIME, ["inner"])],
    ["doc-1", file(DOC_MIME, [ROOT])],
    ["sheet-1", file(SHEET_MIME, [ROOT])],
    ["view-only", file(DOC_MIME, [ROOT], { canShare: false })],
    ["team", file(FOLDER_MIME, [], { driveId: "team" })],
  ]);
  /** What is given on each file itself. */
  readonly grants = new Map<string, Grant[]>();
  /** The comments posted to each file. */
  readonly comments = new Map<string, string[]>();
  /** The files whose permission list never ends: every page of it names another. */
  readonly endless = new Set<string>();
  /** Every request, as `METHOD path`, with the bearer token it came under. */
  readonly requests: { call: string; token: string }[] = [];
  /** Every write, with its query and body. */
  readonly writes: {
    call: string; query: Record<string, string>; body: Record<string, unknown>; token: string;
  }[] = [];
  /**
   * How the next write answers: a status, and a reason when one is given, having changed nothing;
   * or `lost`, which makes the change and then answers 503.
   */
  nextWrite?: Answer | "lost";
  /** How `about` answers: with a failure, or with the permission ID alone. */
  readonly about: { fail?: Answer; omitAddress?: boolean } = {};
  /** The largest file, in bytes, Drive converts into each native type. */
  readonly maxImportSizes: Record<string, string> = { [DOC_MIME]: "10485760" };
  /** Whether a search by app property finds nothing yet, as Drive's lagging index may. */
  searchLags = false;
  /** How many IDs `generateIds` has given, and how many copies Drive gave IDs of its own. */
  #generated = 0;
  #native = 0;
  /** Every upload Drive finished: the file it made or replaced, and the bytes it took, as text. */
  readonly uploads: {
    fileId: string; metadata: Record<string, unknown>; contentType: string; content: string;
  }[] = [];
  /**
   * How the next upload's last chunk answers: `lost` finishes the upload, then answers as a
   * session Drive has ended, which leaves the gatekeeper not knowing whether it was made.
   */
  nextUpload?: "lost";
  /** The revisions kept for good, as `<fileId>@<revisionId>`. */
  readonly kept: string[] = [];
  /** How the next request to keep a revision for good answers, having kept nothing. */
  nextKeep?: Answer;
  /** Every revision of a file's content Drive made, as `<fileId>@<revisionId>`. */
  readonly #revisions = new Set<string>();
  /** IDs files were made under, which Drive never gives a new file again. */
  readonly #used = new Set<string>();
  /** The open upload sessions, by their ID. */
  readonly #sessions = new Map<string, {
    replace?: string; metadata: Record<string, unknown>; contentType: string; received: Uint8Array[];
  }>();
  /** How many upload sessions were opened, and how many revisions uploads made. */
  #opened = 0;
  #made = 0;
  /** Tokens Google no longer accepts, though their recorded expiry has not come: every request answers 401. */
  readonly rejected = new Set<string>();
  /** What a person does in Drive as the next permission list is read, before it is answered. */
  duringPermissionRead?: () => void;
  /** How many files a folder listing answers on a page, when a test sets it: by default all. */
  listingPageSize?: number;
  /** The request held before it answers, once, and whether it was reached and released. */
  #stall?: { request: "listing" | "download"; reached: boolean; released: boolean };
  #people = new Map<string, string>([
    ["me@example.com", "perm-A"], ["other@partner.example", "perm-B"],
    ["bob@example.com", "perm-bob"], ["carol@example.com", "perm-carol"],
    ["team@example.com", "perm-team"],
  ]);
  /** Every comment posted, in the wire shape, by its file's ID and its own. */
  #posted = new Map<string, { id: string }>();

  constructor() {
    // The connected account owns everything but the file shared with it view-only.
    for (let id of this.files.keys()) {
      if (id !== "view-only") this.give(id, { ...this.#person("me@example.com"), role: "owner" });
    }
  }

  install(): this {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      this.#handle(new Request(input, init))));
    return this;
  }

  /**
   * Holds the next `request` before it answers until the test releases it: a folder listing once
   * it has read the folder's files, or a download before it reads the file. Flags rather than
   * promises: workerd refuses to resume a promise another Durable Object resolved.
   */
  stallNext(request: "listing" | "download"): { reached: boolean; released: boolean } {
    let stall = { request, reached: false, released: false };
    this.#stall = stall;
    return stall;
  }

  async #stalled(request: "listing" | "download"): Promise<void> {
    let stall = this.#stall;
    if (stall?.request !== request) return;
    this.#stall = undefined;
    stall.reached = true;
    await vi.waitFor(() => expect(stall.released).toBe(true), { timeout: 10_000 });
  }

  /** Forgets the requests and writes seen so far. */
  forget(): void {
    this.requests.length = 0;
    this.writes.length = 0;
  }

  /** Every request so far, as `METHOD path`. */
  calls(): string[] {
    return this.requests.map(({ call }) => call);
  }

  /** Gives access on `fileId` itself, as a person does in Drive. */
  give(fileId: string, grant: Grant): void {
    let known = grant.emailAddress === undefined ? {} : this.#person(grant.emailAddress);
    this.#direct(fileId).push({ ...known, ...grant });
  }

  /** Posts a comment on `fileId`, as a person does in Drive, and answers it in the wire shape. */
  post(fileId: string, content: string): { id: string } {
    let now = new Date().toISOString();
    let comment = {
      id: `doco.${String(this.#posted.size + 1).padStart(22, "A")}`, content, htmlContent: content,
      author: { displayName: "Test User", me: true }, createdTime: now, modifiedTime: now,
      deleted: false, replies: [],
    };
    this.comments.set(fileId, [...this.comments.get(fileId) ?? [], content]);
    this.#posted.set(`${fileId}/${comment.id}`, comment);
    return comment;
  }

  /** What is given on `fileId` itself, as `[ID, role]`. */
  direct(fileId: string): [string, Role][] {
    return this.#direct(fileId).map(grant => [this.#id(grant), grant.role]);
  }

  /** `fileId`'s permissions as Drive lists them. */
  access(fileId: string): WirePermission[] {
    let direct = new Map(this.#direct(fileId).map(grant => [this.#key(grant), grant]));
    let inherited = this.#inherited(fileId);
    return [...new Set([...inherited.keys(), ...direct.keys()])].flatMap(key => {
      let above = inherited.get(key);
      let own = direct.get(key);
      let shown = own ?? above?.grant;
      if (!shown) return [];
      let details: Detail[] = [
        ...(above ? [{ permissionType: "file" as const, role: above.role, inherited: true }] : []),
        ...(own ? [{ permissionType: "file" as const, role: own.role, inherited: false }] : []),
      ];
      let { role: _role, deleted, ...grantee } = shown;
      return [{
        ...grantee, id: this.#id(shown), deleted: deleted === true, permissionDetails: details,
        role: details.map(detail => detail.role).reduce((top, role) =>
          RANK[role] > RANK[top] ? role : top),
      }];
    });
  }

  /** Changes whether a link on `fileId` can be found by searching, and with it the ID it is listed under. */
  setLinkForm(fileId: string, discoverable: boolean): void {
    let link = this.#direct(fileId).find(grant => grant.type === "anyone");
    if (!link) throw new Error(`No link on ${fileId}`);
    link.allowFileDiscovery = discoverable;
  }

  #direct(fileId: string): Grant[] {
    let list = this.grants.get(fileId);
    if (!list) this.grants.set(fileId, list = []);
    return list;
  }

  /** A person's or a group's name and address, whose ID is the same on every file. */
  #person(emailAddress: string): Pick<Grant, "type" | "emailAddress" | "displayName"> {
    if (!this.#people.has(emailAddress)) {
      this.#people.set(emailAddress, `perm-${this.#people.size + 1}`);
    }
    let name = emailAddress.split("@")[0];
    return {
      type: emailAddress === TEAM.emailAddress ? "group" : "user", emailAddress,
      displayName: emailAddress === ACCOUNT_A.emailAddress ? "Test User"
        : name.charAt(0).toUpperCase() + name.slice(1),
    };
  }

  /** What tells one grantee from another on a file. */
  #key(grant: Grant): string {
    return grant.type === "anyone" ? "anyone" : this.#id(grant);
  }

  #id(grant: Grant): string {
    if (grant.id !== undefined) return grant.id;
    if (grant.type === "anyone") return grant.allowFileDiscovery ? "anyone" : "anyoneWithLink";
    if (grant.type === "domain") return `domain-${(grant.domain ?? "").replace(/\W/g, "-")}`;
    return this.#people.get(grant.emailAddress ?? "") ?? "perm-unknown";
  }

  /** The highest role each grantee has from the folders above `fileId`. An owner's reads as writer. */
  #inherited(fileId: string): Map<string, { grant: Grant; role: Role }> {
    let found = new Map<string, { grant: Grant; role: Role }>();
    let seen = new Set<string>();
    for (let above = this.files.get(fileId)?.parents[0]; above !== undefined && !seen.has(above);
        above = this.files.get(above)?.parents[0]) {
      seen.add(above);
      if (!this.files.has(above)) break;
      for (let grant of this.#direct(above)) {
        let role: Role = grant.role === "owner" ? "writer" : grant.role;
        let held = found.get(this.#key(grant));
        if (!held || RANK[role] > RANK[held.role]) found.set(this.#key(grant), { grant, role });
      }
    }
    return found;
  }

  /**
   * `held` as Drive answers a request whose field mask is `fields`. Drive answers only what a mask
   * names, so `canDownload`, which reads and exports are refused without, is left out unless asked.
   */
  #fileJson(id: string, held: FakeFile, fields: string | null = null) {
    return {
      id, name: held.name || id, mimeType: held.mimeType, modifiedTime: held.modifiedTime,
      ...(held.parents.length ? { parents: held.parents } : {}),
      ...(held.driveId ? { driveId: held.driveId } : {}),
      ...(held.shortcutTargetId ? { shortcutDetails: { targetId: held.shortcutTargetId } } : {}),
      ...(held.content === undefined ? {} : { size: String(held.content.length) }),
      ...(held.appProperties ? { appProperties: held.appProperties } : {}),
      ...(held.headRevisionId ? { headRevisionId: held.headRevisionId } : {}),
      ...(held.sha256Checksum ? { sha256Checksum: held.sha256Checksum } : {}),
      trashed: held.trashed,
      capabilities: {
        canListChildren: held.canListChildren, canComment: held.canComment,
        canShare: held.canShare, canAddChildren: held.canAddChildren,
        canMoveItemWithinDrive: held.canMoveItemWithinDrive, canCopy: held.canCopy,
        canEdit: held.canEdit, canModifyContent: held.canModifyContent,
        ...(fields === null || fields.includes("canDownload") ? { canDownload: held.canDownload } : {}),
      },
    };
  }

  #batch(body: string): Response {
    let boundary = "changes_batch";
    let asked = [...body.matchAll(/GET \/drive\/v3\/files\/([^?]+)\?(\S*)/g)]
      .map(match => ({
        id: decodeURIComponent(match[1]), fields: new URLSearchParams(match[2]).get("fields"),
      }));
    let parts = asked.map(({ id, fields }, index) => {
      let held = this.files.get(id);
      return [
        `--${boundary}`, "Content-Type: application/http", `Content-ID: <response-item-${index}>`,
        "", held ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found", "Content-Type: application/json",
        "", held ? JSON.stringify(this.#fileJson(id, held, fields)) : "{}",
      ].join("\r\n");
    });
    return new Response(`${parts.join("\r\n")}\r\n--${boundary}--\r\n`, {
      headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
    });
  }

  async #handle(request: Request): Promise<Response> {
    let url = new URL(request.url);
    let token = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    let call = `${request.method} ${url.pathname}`;
    let fields = url.searchParams.get("fields");
    this.requests.push({ call, token });
    if (this.rejected.has(token)) return driveError({ status: 401, reason: "authError" });
    if (url.pathname === "/batch/drive/v3") {
      return this.#batch(new TextDecoder().decode(await request.arrayBuffer()));
    }
    if (url.pathname === "/drive/v3/about") {
      if (this.about.fail) return driveError(this.about.fail);
      if (url.searchParams.get("fields") === "maxImportSizes") {
        return Response.json({ maxImportSizes: this.maxImportSizes });
      }
      let { permissionId, emailAddress } = token === OTHER_TOKEN ? ACCOUNT_B : ACCOUNT_A;
      return Response.json({
        user: { permissionId, ...(this.about.omitAddress ? {} : { emailAddress }) },
      });
    }
    if (call === "GET /drive/v3/files/generateIds") {
      return Response.json({ ids: [`copy-${++this.#generated}`] });
    }
    if (url.pathname.startsWith("/upload/drive/v3/files")) return this.#upload(request, url);
    // A folder binding's lookup of a shortcut to a file that is not its child: the folder's
    // untrashed shortcuts.
    let query = url.searchParams.get("q") ?? "";
    if (call === "GET /drive/v3/files" && query.includes(SHORTCUT_MIME)) {
      let parent = /'([^']+)' in parents/.exec(query)?.[1];
      let files = [...this.files].filter(([, held]) => held.mimeType === SHORTCUT_MIME &&
        !held.trashed && parent !== undefined && held.parents.includes(parent));
      return Response.json({ files: files.map(([id, held]) => this.#fileJson(id, held, fields)) });
    }
    // A file looked for by the token it carries, in the shared drive a drive corpus names, or a
    // folder's live children, those of one name when the query names it. Files in the trash match
    // only a query that does not leave them out.
    let byToken =
      /appProperties has \{ key='(gadgetsCopyToken|gadgetsUploadToken)' and value='([^']+)' \}/.exec(query);
    let parent = /'([^']+)' in parents/.exec(query)?.[1];
    let named = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1].replace(/\\(.)/g, "$1");
    let live = query.includes("trashed = false");
    let inDrive = url.searchParams.get("corpora") === "drive" ? url.searchParams.get("driveId") : undefined;
    if (call === "GET /drive/v3/files" && (byToken !== null || parent !== undefined)) {
      let files = [...this.files].filter(([id, held]) => !(live && held.trashed) && (byToken === null
        ? held.parents.includes(parent ?? "") && (named === undefined || (held.name || id) === named)
        : !this.searchLags && held.appProperties?.[byToken[1]] === byToken[2] &&
          (inDrive === undefined || held.driveId === inDrive)));
      if (byToken !== null) {
        // Drive promises no order without `orderBy`: this one answers a search by token newest first.
        return Response.json({ files: files.toReversed().map(([id, held]) => this.#fileJson(id, held, fields)) });
      }
      await this.#stalled("listing");
      let start = Number(url.searchParams.get("pageToken") ?? 0);
      let end = start + (this.listingPageSize ?? files.length);
      return Response.json({
        files: files.slice(start, end).map(([id, held]) => this.#fileJson(id, held, fields)),
        ...(end < files.length ? { nextPageToken: String(end) } : {}),
      });
    }
    let match =
      /^\/drive\/v3\/files\/([^/]+)(?:\/(permissions|comments|copy|revisions|export)(?:\/([^/]+))?)?$/
        .exec(url.pathname);
    if (!match) throw new Error(`Unexpected provider request: ${call}`);
    let [, rawFileId, collection, rawItemId] = match;
    let asked = decodeURIComponent(rawFileId);
    // Drive answers its alias for the account's own root under that folder's ID.
    let fileId = asked === "root" ? MY_ROOT : asked;
    let held = this.files.get(fileId);
    if (!held) return driveError({ status: 404, reason: "notFound" });

    if (collection === undefined) {
      if (request.method === "GET" && url.searchParams.get("alt") === "media") {
        await this.#stalled("download");
        return this.#download(held, request.headers.get("Range"));
      }
      if (request.method === "GET") return Response.json(this.#fileJson(fileId, held, fields));
      if (request.method !== "PATCH") throw new Error(`Unexpected provider request: ${call}`);
      let add = url.searchParams.get("addParents");
      let remove = url.searchParams.get("removeParents");
      return this.#write(call, url, token, {}, () => {
        // A parent already swapped is left as it is.
        if (add !== null && !held.parents.includes(add)) {
          held.parents = [...held.parents.filter(parent => parent !== remove), add];
        }
        return Response.json({ id: fileId, parents: held.parents });
      });
    }

    if (collection === "copy") {
      let body = await request.json() as Record<string, unknown>;
      return this.#write(call, url, token, body, () => this.#copy(held, body));
    }

    if (collection === "export") {
      return new Response(`${held.name || fileId} exported as ${url.searchParams.get("mimeType")}`);
    }

    if (collection === "revisions") {
      let revision = decodeURIComponent(rawItemId ?? "");
      let body = await request.json() as Record<string, unknown>;
      let refused = this.nextKeep;
      this.nextKeep = undefined;
      if (refused) return driveError(refused);
      if (revision !== held.headRevisionId && !this.#revisions.has(`${fileId}@${revision}`)) {
        return driveError({ status: 404, reason: "notFound" });
      }
      if (body.keepForever === true) this.kept.push(`${fileId}@${revision}`);
      return Response.json({ id: revision });
    }

    if (collection === "comments") {
      if (request.method === "GET" && rawItemId !== undefined) {
        let posted = this.#posted.get(`${fileId}/${decodeURIComponent(rawItemId)}`);
        return posted ? Response.json(posted) : driveError({ status: 404, reason: "notFound" });
      }
      if (request.method === "GET") return Response.json({ comments: [] });
      let body = await request.json() as Record<string, unknown>;
      return this.#write(call, url, token, body, () =>
        Response.json(this.post(fileId, String(body.content ?? ""))));
    }

    // Google refuses a file's permissions, read or written, to an account that cannot share it.
    let cannotShare = () => driveError({ status: 403, reason: "insufficientFilePermissions" });
    if (rawItemId === undefined) {
      if (request.method === "GET") {
        if (!held.canShare) return cannotShare();
        this.duringPermissionRead?.();
        this.duringPermissionRead = undefined;
        return Response.json({
          permissions: this.access(fileId),
          ...(this.endless.has(fileId) ? { nextPageToken: `page-${this.requests.length}` } : {}),
        });
      }
      let body = await request.json() as Record<string, unknown>;
      return this.#write(call, url, token, body, () =>
        held.canShare ? this.#create(fileId, body) : cannotShare());
    }
    let permissionId = decodeURIComponent(rawItemId);
    if (request.method === "PATCH") {
      let body = await request.json() as Record<string, unknown>;
      return this.#write(call, url, token, body, () =>
        this.#update(fileId, permissionId, body.role as Role));
    }
    if (request.method === "DELETE") {
      return this.#write(call, url, token, {}, () => this.#delete(fileId, permissionId));
    }
    throw new Error(`Unexpected provider request: ${call}`);
  }

  async #write(
    call: string, url: URL, token: string, body: Record<string, unknown>, make: () => Response,
  ): Promise<Response> {
    this.writes.push({ call, query: Object.fromEntries(url.searchParams), body, token });
    let outcome = this.nextWrite;
    this.nextWrite = undefined;
    if (outcome !== undefined && outcome !== "lost") return driveError(outcome);
    let made = make();
    return outcome === "lost" ? driveError({ status: 503, reason: "backendError" }) : made;
  }

  /**
   * What Drive makes of a copy: a file of its own, under the ID asked for or one it gives. The
   * request patches the source's metadata: an app property it leaves out is kept, and one it sets
   * to null is cleared.
   */
  #copy(source: FakeFile, body: Record<string, unknown>): Response {
    let asked = typeof body.id === "string" ? body.id : undefined;
    // Drive answers a copy under an ID already used with 409, and makes nothing.
    if (asked !== undefined && this.files.has(asked)) return driveError({ status: 409 });
    let id = asked ?? `native-${++this.#native}`;
    let mimeType = typeof body.mimeType === "string" ? body.mimeType : source.mimeType;
    let { appProperties: kept, driveId: _driveId, ...copied } = source;
    let patch = (body.appProperties ?? {}) as Record<string, string | null>;
    let appProperties = Object.fromEntries(Object.entries({ ...kept, ...patch })
      .filter((entry): entry is [string, string] => entry[1] !== null));
    let parents = body.parents as string[];
    // The copy is in the drive of the folder it goes into.
    let driveId = this.files.get(parents[0] ?? "")?.driveId;
    this.files.set(id, {
      ...copied, name: String(body.name), mimeType, parents,
      modifiedTime: new Date().toISOString(),
      ...(driveId ? { driveId } : {}),
      ...(Object.keys(appProperties).length ? { appProperties } : {}),
    });
    this.give(id, { ...this.#person("me@example.com"), role: "owner" });
    return Response.json({ id, mimeType });
  }

  /**
   * Drive's resumable uploads: a `POST` opens a session for a new file, a `PATCH` one for new
   * content of a file, and each `PUT` to the session gives it bytes. Nothing is made or changed
   * until the last byte arrives. A new file asked for under an ID already used is refused with 409
   * and makes nothing. One Drive converts into a native type holds no bytes of its own.
   */
  async #upload(request: Request, url: URL): Promise<Response> {
    let sessionId = url.searchParams.get("upload_id");
    if (sessionId === null) {
      let path = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
      if (!path) throw new Error(`Unexpected provider request: ${request.method} ${url.pathname}`);
      let replace = path[1] === undefined ? undefined : decodeURIComponent(path[1]);
      let metadata = await request.json() as Record<string, unknown>;
      if (replace !== undefined && !this.files.has(replace)) {
        return driveError({ status: 404, reason: "notFound" });
      }
      let id = metadata.id;
      if (typeof id === "string" && (this.files.has(id) || this.#used.has(id))) {
        return driveError({ status: 409 });
      }
      let opened = String(++this.#opened);
      this.#sessions.set(opened, {
        ...(replace === undefined ? {} : { replace }), metadata,
        contentType: request.headers.get("X-Upload-Content-Type") ?? "", received: [],
      });
      return new Response(null, { headers: {
        Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${opened}`,
      } });
    }
    let session = this.#sessions.get(sessionId);
    if (request.method === "DELETE") {
      this.#sessions.delete(sessionId);
      return new Response(null, { status: 204 });
    }
    if (!session) return new Response(null, { status: 404 });
    let range = /^bytes (?:\*|\d+-\d+)\/(\*|\d+)$/.exec(request.headers.get("Content-Range") ?? "");
    if (request.method !== "PUT" || !range) throw new Error(`Unexpected upload request: ${request.method}`);
    session.received.push(new Uint8Array(await request.arrayBuffer()));
    let bytes = new Uint8Array(await new Blob(session.received).arrayBuffer());
    if (range[1] === "*" || bytes.length < Number(range[1])) {
      return new Response(null, {
        status: 308, headers: bytes.length ? { Range: `bytes=0-${bytes.length - 1}` } : {},
      });
    }
    this.#sessions.delete(sessionId);
    let { replace, metadata, contentType } = session;
    let asked = typeof metadata.id === "string" ? metadata.id : undefined;
    if (asked !== undefined && (this.files.has(asked) || this.#used.has(asked))) {
      return driveError({ status: 409 });
    }
    let content = new TextDecoder().decode(bytes);
    let revision = `rev-${++this.#made}`;
    let binary = {
      content, headRevisionId: revision,
      sha256Checksum: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map(byte => byte.toString(16).padStart(2, "0")).join(""),
    };
    let fileId = replace ?? asked ?? `upload-${this.#made}`;
    let made = this.files.get(fileId);
    if (made) {
      Object.assign(made, binary, { modifiedTime: new Date().toISOString() });
    } else {
      let mimeType = typeof metadata.mimeType === "string" ? metadata.mimeType : contentType;
      let converted = mimeType.startsWith("application/vnd.google-apps.");
      let parents = metadata.parents as string[];
      // The file is in the drive of the folder it goes into, as a copy is.
      let driveId = this.files.get(parents[0] ?? "")?.driveId;
      this.files.set(fileId, file(mimeType, parents, {
        name: String(metadata.name), modifiedTime: new Date().toISOString(),
        ...(driveId ? { driveId } : {}),
        ...(converted ? {} : binary),
        ...(metadata.appProperties
          ? { appProperties: metadata.appProperties as Record<string, string> } : {}),
      }));
      this.give(fileId, { ...this.#person("me@example.com"), role: "owner" });
    }
    this.#used.add(fileId);
    this.#revisions.add(`${fileId}@${revision}`);
    this.uploads.push({ fileId, metadata, contentType, content });
    let lost = this.nextUpload === "lost";
    this.nextUpload = undefined;
    if (lost) return new Response(null, { status: 404 });
    return Response.json({ id: fileId, mimeType: this.files.get(fileId)?.mimeType });
  }

  /** A download of `held`, whole or of the byte range asked for. */
  #download(held: FakeFile, range: string | null): Response {
    let content = held.content ?? "";
    let asked = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (!asked) return new Response(content);
    let start = Number(asked[1]);
    let end = Math.min(Number(asked[2]), content.length - 1);
    return new Response(content.slice(start, end + 1), {
      status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${content.length}` },
    });
  }

  /** The permission of `fileId` Drive lists under `permissionId`, anyone's under either of its IDs. */
  #listed(fileId: string, permissionId: string): WirePermission | undefined {
    let link = permissionId === "anyone" || permissionId === "anyoneWithLink";
    return this.access(fileId).find(permission =>
      link ? permission.type === "anyone" : permission.id === permissionId);
  }

  #given(fileId: string, permission: WirePermission): Grant | undefined {
    return this.#direct(fileId).find(grant => this.#id(grant) === permission.id);
  }

  /** An upsert that only raises: a role, and whether a link can be found by searching. */
  #create(fileId: string, body: Record<string, unknown>): Response {
    let type = body.type as Grant["type"];
    let role = body.role as Role;
    let asked: Grant = type === "anyone"
      ? { type, role, allowFileDiscovery: body.allowFileDiscovery === true }
      : type === "domain"
        ? { type, role, domain: String(body.domain), allowFileDiscovery: body.allowFileDiscovery === true }
        : { ...this.#person(String(body.emailAddress)), type, role };
    let given = this.#direct(fileId).find(grant => this.#key(grant) === this.#key(asked));
    let above = this.#inherited(fileId).get(this.#key(asked));
    if (given) {
      if (RANK[role] > RANK[given.role]) given.role = role;
      if (asked.allowFileDiscovery) given.allowFileDiscovery = true;
    } else if (!above || RANK[role] > RANK[above.role]) {
      this.#direct(fileId).push(given = asked);
    }
    return Response.json(this.#listed(fileId, this.#id(given ?? above?.grant ?? asked)));
  }

  #update(fileId: string, permissionId: string, role: Role): Response {
    let listed = this.#listed(fileId, permissionId);
    let given = listed && this.#given(fileId, listed);
    if (!listed) return driveError({ status: 404, reason: "notFound" });
    let above = listed.permissionDetails.find(detail => detail.inherited)?.role;
    if (above !== undefined && RANK[role] < RANK[above]) {
      return driveError({ status: 403, reason: "cannotModifyInheritedPermission" });
    }
    if (above === role) {
      // Set to exactly what a parent gives, the part given on the file is gone.
      let grants = this.#direct(fileId);
      if (given) grants.splice(grants.indexOf(given), 1);
    } else if (given) {
      given.role = role;
    }
    return Response.json(this.#listed(fileId, permissionId));
  }

  #delete(fileId: string, permissionId: string): Response {
    let listed = this.#listed(fileId, permissionId);
    let given = listed && this.#given(fileId, listed);
    if (!listed) return driveError({ status: 404, reason: "notFound" });
    // Google removes nothing of a permission a parent also gives.
    if (!given || listed.permissionDetails.some(detail => detail.inherited)) {
      return driveError({ status: 403, reason: "cannotDeletePermission" });
    }
    let grants = this.#direct(fileId);
    grants.splice(grants.indexOf(given), 1);
    return new Response(null, { status: 204 });
  }
}

/** A method of a Drive session, whichever scope it has. */
type DriveMethod = keyof GoogleDriveFolderSession;

const ACCOUNT = { kind: "account" } as const;
const FOLDER = { kind: "folder", folderId: ROOT } as const;
const DOC_FILE = { kind: "file", fileId: "doc-1" } as const;

/** The object the hooks that reach the test user's Google account are called on. */
const account = () => env.TEST_HOOKS.getByName("grants");

/** Records the grants the test user's Google account holds. */
function setGrants(patterns: string[]): Promise<void> {
  return account().setDriveGrants(patterns);
}

/** Stores the second Google account's token, as a reconnect as that account does. */
function switchAccount(): Promise<void> {
  return account().setDriveToken(OTHER_TOKEN);
}

let facets = 0;

/**
 * A Drive binding of `scope`, on a TestHooks object of its own: read and write, unless `access`
 * is `null`, which makes one with no access level. `facet` names an earlier binding's facet, to
 * make a binding over its storage. `deployment` runs its gatekeeper as a deployment that keeps
 * Google Drive read-only does.
 */
function binding(
  scope: DriveBindingScope = ACCOUNT,
  access: DriveAccessLevel | null = "write",
  facet = `drive-changes-${++facets}`,
  deployment?: "read",
) {
  let hooks = env.TEST_HOOKS.getByName(facet);
  let props = { scope, ...(access ? { access } : {}), ...(deployment ? { deployment } : {}) };
  let callIn = (path: string[], method: DriveMethod, ...args: unknown[]) =>
    hooks.callDrive(facet, props, method, args, path);
  let call = (method: DriveMethod, ...args: unknown[]) => callIn([], method, ...args);
  /** The outcome of a call through the folders of `path` that queued a write. */
  let queuedIn = async (path: string[], method: DriveMethod, ...args: unknown[]) => {
    let outcome = await callIn(path, method, ...args);
    if (outcome.error !== undefined) throw new Error(outcome.error);
    let { actionId, action } = outcome;
    if (actionId === undefined || action === undefined) throw new Error(`${method} queued nothing`);
    return { ...outcome, actionId, action };
  };
  return {
    facet,
    call,
    callIn,
    queued: (method: DriveMethod, ...args: unknown[]) => queuedIn([], method, ...args),
    queuedIn,
    access: async (fileId: string) => {
      let outcome = await call("listAccess", fileId);
      if (outcome.error !== undefined) throw new Error(outcome.error);
      return outcome.value as DriveAccess[];
    },
    apply: (actionId: number) => hooks.applyDrive(facet, props, actionId),
    reject: (actionId: number) => hooks.rejectDrive(facet, props, actionId),
    /** Reads `fileId` whole, running `between` once the first of its bytes have arrived. */
    readAcross: (fileId: string, between: () => Promise<void>) =>
      hooks.readDriveAcross(facet, props, fileId, between),
    /**
     * Reads `fileId` with `options`, whole by default, running `between` where the read first
     * authorizes what it reads.
     */
    readHeld: (fileId: string, between: () => Promise<void>, options: DriveFileReadOptions = {}) =>
      hooks.readDriveHeld(facet, props, fileId, between, options),
    revert: (actionId: number) => hooks.revertDrive(facet, props, actionId),
    /** The IDs of the writes still to be applied. */
    waiting: () => hooks.driveQueued(facet, props),
    autoApprovable: () => hooks.driveAutoApprovable(facet, props),
    types: () => hooks.driveTypes(facet, props),
    describe: () => hooks.describeDrive(facet, props),
    orphan: (actionId: number) => hooks.orphanDriveClaim(facet, props, actionId),
    restart: () => hooks.restartDrive(facet),
    attempts: () => hooks.driveAttempts(facet, props),
    /** The keys the binding stores under `prefix`, in key order. */
    storedKeys: (prefix: string) => hooks.driveStoredKeys(facet, props, prefix),
    /** What the binding stores under `key`, as JSON, or `null`. */
    stored: (key: string) => hooks.driveStored(facet, props, key),
    /** Stores `json` under `key`, as a write behind the binding's back does. */
    store: (key: string, json: string) => hooks.writeDriveStored(facet, props, key, json),
  };
}

let provider: DriveProvider;
beforeEach(async () => {
  provider = new DriveProvider().install();
  await setGrants(GRANTED);
});
afterEach(async () => {
  await account().setDriveToken(undefined);
  vi.unstubAllGlobals();
});

/** The requests that read or changed a file's permissions. */
const permissionCalls = () => provider.calls().filter(call => call.includes("/permissions"));
/** The writes sent as `call`. */
const sent = (call: string) => provider.writes.filter(write => write.call === call);
const CREATE_ON_DOC = "POST /drive/v3/files/doc-1/permissions";
const COMMENT_ON_DOC = "POST /drive/v3/files/doc-1/comments";

/** What a sharing call's scope proof reports. */
const SHARING_OF = (...subresources: string[]) =>
  ({ title: "Open Google Drive sharing", subresources });
/** What a move's scope proof reports. */
const MOVE_OF = (...subresources: string[]) =>
  ({ title: "Check Google Drive move", subresources });
/** The moves sent for `fileId`, by the parents each asked for. */
const movesOf = (fileId: string) => sent(`PATCH /drive/v3/files/${fileId}`)
  .map(({ query }) => [query.addParents, query.removeParents]);
/** Puts `fileId` in the trash, or changes anything else of it, as a person does in Drive. */
function change(fileId: string, changes: Partial<FakeFile>): void {
  let held = provider.files.get(fileId);
  if (!held) throw new Error(`No file ${fileId}`);
  Object.assign(held, changes);
}
const parentsOf = (fileId: string) => provider.files.get(fileId)?.parents;

/** A queued action's field `label`, as its approval shows it. */
function field(action: { fields?: { label: string }[] }, label: string): unknown {
  let found = action.fields?.find(candidate => candidate.label === label);
  return found && "value" in found ? found.value : undefined;
}

describe("access level", () => {
  const SHARING: [DriveMethod, ...unknown[]][] = [
    ["share", "doc-1", BOB, "reader"],
    ["updateAccess", "doc-1", "perm-bob", "writer"],
    ["unshare", "doc-1", "perm-bob"],
  ];

  it("refuses all five on a read-only binding, asking Google nothing", async () => {
    let bindings: [DriveBindingScope, string, string][] = [
      [ACCOUNT, READ_ONLY_ACCOUNT, `${MOVE_NEEDS_A_FOLDER} ${READ_ONLY_ACCOUNT}`],
      [FOLDER, READ_ONLY(`${FOLDER_URL}?access=write`), READ_ONLY(`${FOLDER_URL}?access=write`)],
      // The URL the read-only refusal would name could not move either.
      [DOC_FILE, READ_ONLY(`${FILE_URL}?access=write`), MOVE_SINGLE_FILE],
    ];

    for (let [scope, message, moving] of bindings) {
      let drive = binding(scope, null);
      for (let [method, ...args] of SHARING) {
        let refused = await drive.call(method, ...args);

        expect(refused.error, `${scope.kind} ${method}`).toBe(message);
        expect(refused.actionId).toBeUndefined();
        expect(refused.observations).toEqual([]);
      }
      let listing = await drive.call("listAccess", "doc-1");
      expect(listing.error, scope.kind).toBe(`${LISTING_TAKES_WRITES} ${message}`);
      expect(listing.error?.endsWith("?access=write"), scope.kind).toBe(true);
      expect(listing.observations).toEqual([]);

      let move = await drive.call("move", "doc-1", "inner");
      expect(move.error, scope.kind).toBe(moving);
      expect(move.actionId).toBeUndefined();
      expect(move.observations).toEqual([]);
    }
    expect(`${MOVE_NEEDS_A_FOLDER} ${READ_ONLY_ACCOUNT}`
      .endsWith("https://drive.google.com/drive/my-drive?access=write")).toBe(true);
    expect(provider.requests).toEqual([]);
  });

  it("asks for the grant before anything else", async () => {
    await setGrants([GOOGLE_DRIVE_RESOURCE.urlPattern]);
    let drive = binding();

    for (let [method, ...args] of [...SHARING, ["move", "doc-1", "elsewhere"] as const]) {
      let refused = await drive.call(method, ...args);

      // Nothing is put before it, on an all-of-Drive binding's move either.
      expect(refused.error, method).toBe(GRANT_MISSING);
      expect(refused.actionId).toBeUndefined();
      expect(refused.observations).toEqual([]);
    }
    expect((await drive.call("listAccess", "doc-1")).error)
      .toBe(`${LISTING_TAKES_WRITES} ${GRANT_MISSING}`);
    expect(provider.requests).toEqual([]);
  });

  it("gives a read and write binding the sharing types and a read-only one none", async () => {
    let readWrite = binding();
    let readOnly = binding(ACCOUNT, null);

    for (let name of ["interface DriveSharing", "move(", "copyFile("]) {
      expect(await readWrite.types(), name).toContain(name);
      expect(await readOnly.types(), name).not.toContain(name);
    }
    // Neither sharing nor moves is offered for auto-approval; copies, exports and uploads are.
    expect(await readWrite.autoApprovable()).toEqual([
      { tag: "driveComments", label: "Drive comments" }, COPIES,
      { tag: "driveExportCopies", label: "Drive exported copies" },
      { tag: "driveUploads", label: "Drive uploads" }, ...DRIVE_SLIDES_KINDS,
      ...DRIVE_SHEETS_KINDS, ...DRIVE_DOCS_KINDS,
    ]);
    expect(await readOnly.autoApprovable()).toEqual([]);
  });

  it("refuses what the types do not offer, for a caller that has no types", async () => {
    let drive = binding();

    let invalid = [
      await drive.call("share", "doc-1", BOB, "owner"),
      await drive.call("updateAccess", "doc-1", "1", "organizer"),
      await drive.call("share", "doc-1", { type: "user", id: "1" }, "reader"),
      // The address under a key the types do not have.
      await drive.call("share", "doc-1", { type: "user", email: "bob@example.com" }, "reader"),
      await drive.call("unshare", "doc-1", 7),
    ];
    let expiring = await drive.call(
      "share", "doc-1", ANYONE, "reader", { expirationTime: "2027-01-01" });
    let addressed = await drive.call(
      "share", "doc-1", { type: "anyone", emailAddress: "x@y.z" }, "reader");

    // The RPC validator answers these in its own words.
    for (let refused of invalid) expect(refused.error).toEqual(expect.any(String));
    expect(expiring.error).toBe(
      "share() has no option expirationTime. Its options are notify, message and discoverable: " +
      "access given here does not expire, and ownership is not transferred.");
    expect(addressed.error).toBe("A grantee of type anyone has no emailAddress.");
    for (let refused of [...invalid, expiring, addressed]) {
      expect(refused.actionId).toBeUndefined();
    }
    expect(provider.requests).toEqual([]);
  });

  it("says what names access when handed an entry or an address", async () => {
    provider.give("doc-1", { ...BOB, role: "reader" });
    let drive = binding();
    let entry = (await drive.access("doc-1")).find(listed => listed.emailAddress === BOB.emailAddress);
    if (!entry) throw new Error("Bob's access was not listed");
    provider.forget();

    let refused = [
      await drive.call("unshare", "doc-1", entry),
      await drive.call("updateAccess", "doc-1", entry, "reader"),
      await drive.call("unshare", "doc-1", "bob@example.com"),
    ];
    // As Drive lists a grantee whose address it withholds: a grantee of no shape the types have.
    let { emailAddress: _withheld, ...hidden } = entry;
    let unaddressed = await drive.call("unshare", "doc-1", hidden);

    for (let outcome of refused) {
      expect(outcome.error).toBe(ACCESS_NAME);
      expect(outcome.actionId).toBeUndefined();
    }
    expect(unaddressed.error).toEqual(expect.any(String));
    expect(unaddressed.error).not.toBe(ACCESS_NAME);
    expect(unaddressed.actionId).toBeUndefined();
    expect(provider.requests).toEqual([]);
  });
});

describe("sharing", () => {
  const ME = {
    id: "perm-A", type: "user", emailAddress: "me@example.com", displayName: "Test User", me: true,
  };
  const FOLDER_SHARED =
    "This is a folder: everything in it is shared too. Access they already have to something " +
    "in it, at this role or a lower one, is merged into the folder's, and is gone if the " +
    "folder's access is later removed.";

  it("lists who has access, reporting the file and nothing about sharing", async () => {
    provider.give("doc-1", { ...BOB, role: "reader" });

    let listed = await binding().call("listAccess", "doc-1");

    // The check that the account can share observes nothing when it passes.
    expect(listed.reports).toEqual([
      SHARING_OF("drive/file/doc-1"),
      { title: "Read Google Drive sharing", subresources: ["drive/file/doc-1"] },
    ]);
    // One entry per detail: the account's own from the folder, then what is given on the file.
    expect(listed.value).toEqual([
      { ...ME, role: "writer", inherited: true },
      { ...ME, role: "owner" },
      {
        id: "perm-bob", type: "user", role: "reader", emailAddress: "bob@example.com",
        displayName: "Bob",
      },
    ]);
    expect(listed.value).toHaveLength(
      provider.access("doc-1").flatMap(permission => permission.permissionDetails).length);

    let folder = binding(FOLDER);
    let child = await folder.call("listAccess", "doc-1");
    let positioned = await folder.call("listAccess", ROOT);

    let units = ["drive/folder/folder-root", "drive/file/doc-1"];
    expect(child.reports).toEqual([
      SHARING_OF(...units), { title: "Read Google Drive sharing", subresources: units },
    ]);
    expect(positioned.reports[0])
      .toEqual(SHARING_OF("drive/folder/folder-root", "drive/file/folder-root"));
    expect(positioned.value).toEqual([{ ...ME, role: "owner" }]);
  });

  it("discloses nothing of sharing read while the file moved out of a folder binding", async () => {
    // A folder outside the binding, shared with someone the bound folder is not shared with.
    provider.give("elsewhere", { ...CAROL, role: "reader" });
    provider.give("doc-1", { ...BOB, role: "reader" });
    let drive = binding(FOLDER);
    let units = ["drive/folder/folder-root", "drive/file/doc-1"];
    let calls: [DriveMethod, ...unknown[]][] = [
      ["listAccess", "doc-1"],
      // Each would otherwise answer from the folder the file went to: Carol's access there.
      ["share", "doc-1", CAROL, "reader"],
      ["updateAccess", "doc-1", CAROL, "writer"],
      ["updateAccess", "doc-1", BOB, "writer"],
      ["unshare", "doc-1", CAROL],
    ];

    for (let [method, ...args] of calls) {
      change("doc-1", { parents: [ROOT] });
      provider.duringPermissionRead = () => change("doc-1", { parents: ["elsewhere"] });
      provider.forget();

      let refused = await drive.call(method, ...args);

      expect(refused.error, method).toBe(OUTSIDE);
      expect(refused.value, method).toBeUndefined();
      expect(refused.actionId, method).toBeUndefined();
      // The proof made before the read is all that was reported: no sharing was.
      expect(refused.reports, method).toEqual([SHARING_OF(...units)]);
      // The file's place is asked of Drive again once its permissions are read.
      let asked = provider.calls();
      expect(asked.slice(asked.indexOf("GET /drive/v3/files/doc-1/permissions") + 1), method)
        .toEqual(["POST /batch/drive/v3", "GET /drive/v3/files/doc-1"]);
    }
    expect(await drive.waiting()).toEqual([]);

    // The positioned folder itself, moved out from under the bound root during the read.
    provider.duringPermissionRead = () => change("inner", { parents: ["elsewhere"] });
    let positioned = await drive.callIn(["inner"], "listAccess", "inner");
    expect(positioned.error).toBe(OUTSIDE);
    expect(positioned.value).toBeUndefined();
    expect(positioned.reports.map(report => report.title)).not.toContain("Read Google Drive sharing");

    // An account binding reaches a file wherever it is, and asks nothing more.
    change("doc-1", { parents: [ROOT] });
    provider.duringPermissionRead = () => change("doc-1", { parents: ["elsewhere"] });
    provider.forget();
    let anywhere = await binding().call("listAccess", "doc-1");
    expect(anywhere.error).toBeUndefined();
    expect(provider.calls().at(-1)).toBe("GET /drive/v3/files/doc-1/permissions");
  });

  it("refuses a file the account cannot share, reporting nothing", async () => {
    let drive = binding();
    let calls: [DriveMethod, ...unknown[]][] = [
      ["listAccess", "view-only"],
      ["share", "view-only", BOB, "reader"],
      ["updateAccess", "view-only", "perm-bob", "writer"],
      ["unshare", "view-only", "perm-bob"],
    ];

    for (let [method, ...args] of calls) {
      let refused = await drive.call(method, ...args);

      expect(refused.error, method).toBe(CANNOT_SHARE("view-only"));
      expect(refused.actionId).toBeUndefined();
      expect(refused.reports).toEqual([
        SHARING_OF("drive/file/view-only"),
        { title: "Check Google Drive file access", subresources: [] },
      ]);
    }
    expect(permissionCalls()).toEqual([]);
  });

  it("refuses a shared drive's root, a nested file, another file of a file binding, and the alias root", async () => {
    let drive = binding();
    for (let [method, ...args] of [["listAccess", "team"], ["share", "team", ANYONE, "reader"]] as const) {
      let refused = await drive.call(method, ...args);

      expect(refused.error, method).toBe(SHARED_DRIVE_ROOT);
      // That it is a shared drive is the file's own metadata, reported before it is said.
      expect(refused.reports).toEqual([SHARING_OF("drive/file/team")]);
      expect(refused.actionId).toBeUndefined();
    }

    let outside: [ReturnType<typeof binding>, string][] = [
      // Visible, and one level too deep.
      [binding(FOLDER), "nested-doc"],
      [binding(DOC_FILE), "sheet-1"],
      // Drive answers the alias under the root's own ID.
      [drive, "root"],
    ];
    for (let [bound, fileId] of outside) {
      for (let [method, ...args] of [["listAccess"], ["share", ANYONE, "reader"]] as const) {
        provider.forget();
        let [grantee, role] = args;
        let refused = await bound.call(method, fileId, ...(grantee ? [grantee, role] : []));

        expect(refused.error, `${fileId} ${method}`).toBe(OUTSIDE);
        expect(refused.reports).toEqual([]);
        expect(refused.actionId).toBeUndefined();
        // A file binding refuses another ID before it asks Drive about a file.
        if (fileId === "sheet-1") expect(provider.calls()).toEqual(["GET /drive/v3/about"]);
      }
    }
    expect(permissionCalls()).toEqual([]);
  });

  it("refuses the top level of My Drive as a sharing target, reporting nothing", async () => {
    let drive = binding();

    for (let [method, ...args] of [["listAccess", MY_ROOT], ["share", MY_ROOT, ANYONE, "reader"]] as const) {
      let refused = await drive.call(method, ...args);

      expect(refused.error, method).toBe(MY_DRIVE_ROOT_SHARING);
      // No other account can see that folder, so its unit would be a requirement nobody passes.
      expect(refused.reports).toEqual([SHARING_OF()]);
      expect(refused.actionId).toBeUndefined();
    }
    expect(permissionCalls()).toEqual([]);
  });

  it("queues a share and shows it pending", async () => {
    let drive = binding();

    let queued = await drive.queued(
      "share", "doc-1", BOB, "writer", { message: "For your review." });

    let pending = {
      id: `pending:${queued.actionId}`, type: "user", role: "writer",
      emailAddress: "bob@example.com", pending: true,
    };
    expect(queued.value).toEqual(pending);
    expect(queued.action).toMatchObject({
      title: "Share a Google Drive file with a person",
      description: "Give editor access to Google Drive file `doc-1` as the connected account." +
        "\n\nGoogle emails them about it.",
      actionKind: { tag: "driveSharing", label: "Drive sharing" },
      autoApprovable: false,
      implementsRevert: false,
      descriptionIsComplete: true,
      fields: [
        { label: "File", kind: "inline", value: "doc-1" },
        { label: "File name", kind: "inline", value: "doc-1" },
        { label: "Share with", kind: "inline", value: "bob@example.com" },
        { label: "Role", kind: "inline", value: "writer" },
        { label: "Message", kind: "text", value: "For your review." },
      ],
    });
    expect(queued.action.awaitDecision).toBeUndefined();
    // A share reports the file, and leaves no requirement of its own on whoever queued it.
    expect(queued.reports).toEqual([SHARING_OF("drive/file/doc-1")]);
    expect((await drive.access("doc-1")).at(-1)).toEqual(pending);
    expect(provider.writes).toEqual([]);

    expect(await drive.apply(queued.actionId)).toBeNull();

    expect(provider.writes).toEqual([{
      call: CREATE_ON_DOC,
      query: {
        sendNotificationEmail: "true", emailMessage: "For your review.", supportsAllDrives: "true",
        fields: expect.any(String),
      },
      body: { type: "user", role: "writer", emailAddress: "bob@example.com" },
      token: expect.any(String),
    }]);
    expect((await drive.access("doc-1")).at(-1)).toEqual({
      id: "perm-bob", type: "user", role: "writer", emailAddress: "bob@example.com",
      displayName: "Bob",
    });
    expect(await drive.waiting()).toEqual([]);

    let inFolder = await binding(FOLDER).queued("share", "sheet-1", BOB, "reader");
    expect(inFolder.reports)
      .toEqual([SHARING_OF("drive/folder/folder-root", "drive/file/sheet-1")]);
  });

  it("says that a shared folder shares what it holds", async () => {
    let drive = binding(FOLDER);

    let child = await drive.queued("share", "inner", ANYONE, "reader");
    let positioned = await drive.queuedIn(
      ["inner"], "share", "inner", { type: "domain", domain: "example.com" }, "reader");
    let doc = await drive.queued("share", "doc-1", ANYONE, "reader");

    expect(child.action.title).toBe("Public link: share a Google Drive folder with anyone");
    expect(child.action.description).toMatch(
      /^\*\*Public: anyone who has the link gets viewer access to this folder\.\*\* /);
    expect(positioned.reports.at(-1))
      .toEqual(SHARING_OF("drive/folder/inner", "drive/file/inner"));
    expect(positioned.action.title).toBe("Whole domain: share a Google Drive folder with a domain");
    for (let { action } of [child, positioned]) {
      expect(action.description.split("\n\n")).toContain(FOLDER_SHARED);
    }
    expect(doc.action.title).toBe("Public link: share a Google Drive file with anyone");
    expect(doc.action.description).not.toContain("folder");
    // A waiting share with a domain or with anyone says whether it can be found by searching.
    expect(child.value).toEqual({
      id: `pending:${child.actionId}`, type: "anyone", role: "reader", discoverable: false,
      pending: true,
    });
    expect(positioned.value).toEqual({
      id: `pending:${positioned.actionId}`, type: "domain", role: "reader", domain: "example.com",
      discoverable: false, pending: true,
    });

    expect(await drive.apply(child.actionId)).toBeNull();
    expect((await drive.access("inner")).find(entry => entry.type === "anyone"))
      .toEqual({ id: "anyoneWithLink", type: "anyone", role: "reader", discoverable: false });
  });

  it("says a public share, a searchable one, an outside domain and an outside address first", async () => {
    provider.give("loose-doc", { type: "anyone", role: "reader", allowFileDiscovery: false });
    let drive = binding();
    let opening = "**Public: anyone who has the link gets editor access to this file.**";

    let link = await drive.queued("share", "doc-1", ANYONE, "writer");
    let searchable = await drive.queued("share", "sheet-1", ANYONE, "writer", { discoverable: true });
    let domain = await drive.queued(
      "share", "doc-1", { type: "domain", domain: "partner.example" }, "reader");
    let address = await drive.queued(
      "share", "doc-1", { type: "user", emailAddress: "bob@partner.example" }, "writer");
    let raised = await drive.queued("updateAccess", "loose-doc", ANYONE, "writer");

    expect(link.action.title).toBe("Public link: share a Google Drive file with anyone");
    expect(link.action.description.startsWith(opening)).toBe(true);
    expect(searchable.action.title)
      .toBe("Public, searchable: share a Google Drive file with anyone");
    expect(searchable.action.description.startsWith(
      "**Public: anyone can find this file by searching and gets editor access.**")).toBe(true);
    expect(domain.action.title).toBe("Outside domain: share a Google Drive file with a domain");
    expect(address.action.title).toBe("Outside address: share a Google Drive file with a person");
    let [first] = address.action.description.split("\n\n");
    expect(first.startsWith(
      "**This address is outside `example.com`, the connected account's own domain.**")).toBe(true);
    expect(first.endsWith(
      "Give editor access to Google Drive file `doc-1` as the connected account.")).toBe(true);
    expect(raised.action.title).toBe("Public link: raise access to a Google Drive file");
    expect(raised.action.description.startsWith(opening)).toBe(true);
  });

  it("goes on by the permission ID when Drive gives the account no address", async () => {
    provider.about.omitAddress = true;
    let drive = binding();
    let folder = binding(FOLDER);

    let share = await drive.queued(
      "share", "doc-1", { type: "user", emailAddress: "bob@partner.example" }, "reader");
    let listed = await drive.access("doc-1");
    let move = await folder.queued("move", "sheet-1", "inner");

    expect(share.action.title).toBe("Unchecked address: share a Google Drive file with a person");
    expect(share.action.description.startsWith(
      "**Drive did not give the connected account's own address, so whether this address is " +
      "outside its domain is not known.**")).toBe(true);
    expect(listed.filter(entry => entry.id === "perm-A").map(entry => entry.me)).toEqual([true, true]);
    // Each was staged under the permission ID, and is applied as the account that has it.
    expect(await drive.apply(share.actionId)).toBeNull();
    expect(await folder.apply(move.actionId)).toBeNull();
    expect(provider.files.get("sheet-1")?.parents).toEqual(["inner"]);
  });

  it("queues a role change and a removal, by ID and by grantee, each shown as if made", async () => {
    for (let fileId of ["doc-1", "sheet-1"]) {
      provider.give(fileId, { ...BOB, role: "reader" });
      provider.give(fileId, { ...TEAM, role: "commenter" });
    }
    let drive = binding();

    let raised = await drive.queued("updateAccess", "doc-1", "perm-bob", "writer");
    let removal = await drive.queued("unshare", "doc-1", "perm-team");

    expect(raised.value).toEqual({
      id: "perm-bob", type: "user", role: "writer", emailAddress: "bob@example.com",
      displayName: "Bob", pending: true,
    });
    expect(raised.action).toMatchObject({
      title: "Raise access to a Google Drive file",
      description: "Change the role of access given to a person from `reader` to `writer` on " +
        "Google Drive file `doc-1`, as the connected account.",
      actionKind: { tag: "driveSharing", label: "Drive sharing" },
      autoApprovable: false,
      implementsRevert: false,
      fields: [
        { label: "File", kind: "inline", value: "doc-1" },
        { label: "File name", kind: "inline", value: "doc-1" },
        { label: "Access ID", kind: "inline", value: "perm-bob" },
        { label: "Shared with", kind: "inline", value: "bob@example.com" },
        { label: "Name", kind: "inline", value: "Bob" },
        { label: "From role", kind: "inline", value: "reader" },
        { label: "To role", kind: "inline", value: "writer" },
      ],
    });
    expect(removal.value).toBeUndefined();
    expect(removal.action).toMatchObject({
      title: "Remove access to a Google Drive file",
      description: "Remove access given to a group on Google Drive file `doc-1`, as the " +
        "connected account.",
      autoApprovable: false,
      implementsRevert: false,
      fields: [
        { label: "File", kind: "inline", value: "doc-1" },
        { label: "File name", kind: "inline", value: "doc-1" },
        { label: "Access ID", kind: "inline", value: "perm-team" },
        { label: "Shared with", kind: "inline", value: "team@example.com" },
        { label: "Name", kind: "inline", value: "Team" },
        { label: "Role", kind: "inline", value: "commenter" },
      ],
    });
    for (let { reports } of [raised, removal]) {
      expect(reports).toEqual([SHARING_OF("drive/file/doc-1")]);
    }
    // The role shows as changed, and the access being removed is left out.
    expect((await drive.access("doc-1")).filter(entry => !entry.me)).toEqual([raised.value]);

    // A grantee names what its ID names, an address whichever kind it is given as.
    let byGrantee = await drive.queued("updateAccess", "sheet-1", BOB, "writer");
    let removedByGrantee = await drive.queued(
      "unshare", "sheet-1", { type: "user", emailAddress: "team@example.com" });
    expect(byGrantee.action.title).toBe(raised.action.title);
    expect(field(byGrantee.action, "Access ID")).toBe("perm-bob");
    expect(byGrantee.value).toEqual(raised.value);
    expect(removedByGrantee.action.title).toBe(removal.action.title);
    expect(field(removedByGrantee.action, "Access ID")).toBe("perm-team");
    expect(byGrantee.reports).toEqual([SHARING_OF("drive/file/sheet-1")]);

    for (let { actionId } of [raised, removal, byGrantee, removedByGrantee]) {
      expect(await drive.apply(actionId)).toBeNull();
    }
    for (let fileId of ["doc-1", "sheet-1"]) {
      expect(provider.direct(fileId)).toEqual([["perm-A", "owner"], ["perm-bob", "writer"]]);
    }
  });

  it("says what a folder's role change and removal do to what it holds", async () => {
    provider.give("inner", { ...BOB, role: "reader" });
    provider.give("inner", { ...TEAM, role: "reader" });
    let drive = binding(FOLDER);

    let raised = await drive.queued("updateAccess", "inner", BOB, "writer");
    let removed = await drive.queued("unshare", "inner", TEAM);

    expect(raised.action.title).toBe("Raise access to a Google Drive folder");
    expect(raised.action.description.split("\n\n")).toContain(
      "This is a folder: the change reaches everything in it. Access they already have to " +
      "something in it, at the new role or a lower one, is merged into the folder's, and is " +
      "gone if the folder's access is later removed.");
    expect(removed.action.title).toBe("Remove access to a Google Drive folder");
    expect(removed.action.description.split("\n\n")).toContain(
      "This is a folder: everything in it loses the access it had through this folder. Access " +
      "they had to something in it that was merged into the folder's goes with it.");
  });

  it("names a link by either of Drive's IDs, and never takes one that changed form for gone", async () => {
    for (let fileId of ["sheet-1", "loose-doc"]) {
      provider.give(fileId, { type: "anyone", role: "reader", allowFileDiscovery: false });
    }
    let drive = binding();

    // Listed as `anyoneWithLink`, and named by the other ID.
    let removal = await drive.queued("unshare", "sheet-1", "anyone");
    expect(field(removal.action, "Access ID")).toBe("anyoneWithLink");
    provider.setLinkForm("sheet-1", true);

    expect(await drive.apply(removal.actionId)).toBe(ACCESS_CHANGED);
    expect(provider.writes).toEqual([]);
    expect(provider.direct("sheet-1")).toContainEqual(["anyone", "reader"]);

    let second = await drive.queued("unshare", "loose-doc", "anyone");
    provider.nextWrite = { status: 503 };
    expect(await drive.apply(second.actionId)).toBe(UNCONFIRMED);
    provider.setLinkForm("loose-doc", true);

    // Looked up by the ID it had, the link would read as removed while the file is public.
    expect(await drive.apply(second.actionId)).toBe(CHANGED_AGAIN);
    expect(provider.writes).toHaveLength(1);
    expect(provider.direct("loose-doc")).toContainEqual(["anyone", "reader"]);
  });

  it("refuses what a queued change already covers", async () => {
    provider.give("sheet-1", { ...BOB, role: "reader" });
    provider.give("sheet-1", { ...TEAM, role: "commenter" });
    let drive = binding();
    let share = await drive.queued("share", "doc-1", BOB, "reader");
    await drive.queued("updateAccess", "sheet-1", "perm-bob", "writer");
    await drive.queued("unshare", "sheet-1", "perm-team");

    let refusals: [string, DriveMethod, ...unknown[]][] = [
      [SHARE_PENDING, "share", "doc-1", BOB, "writer"],
      [CHANGE_PENDING, "updateAccess", "sheet-1", "perm-bob", "commenter"],
      [CHANGE_PENDING, "unshare", "sheet-1", BOB],
      // A grantee whose role change waits, and one whose removal waits.
      [SHARE_BEHIND_CHANGE, "share", "sheet-1", BOB, "writer"],
      [SHARE_BEHIND_CHANGE, "share", "sheet-1", TEAM, "reader"],
    ];
    for (let [message, method, ...args] of refusals) {
      let refused = await drive.call(method, ...args);

      expect(refused.error, `${method} ${JSON.stringify(args)}`).toBe(message);
      expect(refused.actionId).toBeUndefined();
    }

    expect(await drive.reject(share.actionId)).toBeNull();
    expect((await drive.call("unshare", "doc-1", `pending:${share.actionId}`)).error)
      .toBe(PENDING_SPENT);
  });

  it("refuses what a change an interrupted approval left claimed already covers", async () => {
    provider.give("sheet-1", { ...BOB, role: "reader" });
    let drive = binding();
    let share = await drive.queued("share", "doc-1", BOB, "reader");
    let raise = await drive.queued("updateAccess", "sheet-1", "perm-bob", "writer");
    // Each approval ended before it settled its change: the Workshop still holds both actions.
    await drive.orphan(share.actionId);
    await drive.orphan(raise.actionId);
    await drive.restart();

    expect((await drive.call("share", "doc-1", BOB, "writer")).error).toBe(SHARE_PENDING);
    expect((await drive.call("unshare", "sheet-1", BOB)).error).toBe(CHANGE_PENDING);
    expect(await drive.waiting()).toEqual([share.actionId, raise.actionId]);

    // The next approval takes each up.
    expect(await drive.apply(share.actionId)).toBeNull();
    expect(await drive.apply(raise.actionId)).toBeNull();
    expect(provider.direct("doc-1")).toContainEqual(["perm-bob", "reader"]);
    expect(provider.direct("sheet-1")).toContainEqual(["perm-bob", "writer"]);
  });

  it("says how access that still waits is withdrawn", async () => {
    let drive = binding();
    let share = await drive.queued("share", "doc-1", ANYONE, "reader");
    let pendingId = `pending:${share.actionId}`;
    provider.forget();

    expect((await drive.call("unshare", "doc-1", pendingId)).error).toBe(ACCESS_WAITING_REMOVE);
    expect((await drive.call("updateAccess", "doc-1", pendingId, "writer")).error)
      .toBe(ACCESS_WAITING_CHANGE);
    // Asked of a file its share is not for, the ID names nothing.
    expect((await drive.call("unshare", "sheet-1", pendingId)).error).toBe(PENDING_SPENT);
    expect(provider.requests).toEqual([]);

    let byGrantee = [
      await drive.call("unshare", "doc-1", ANYONE),
      await drive.call("updateAccess", "doc-1", ANYONE, "writer"),
    ];
    expect(byGrantee.map(refused => refused.error))
      .toEqual([ACCESS_WAITING_REMOVE, ACCESS_WAITING_CHANGE]);
    for (let refused of byGrantee) expect(refused.actionId).toBeUndefined();
    expect(await drive.waiting()).toEqual([share.actionId]);

    expect(await drive.reject(share.actionId)).toBeNull();
    expect((await drive.access("doc-1")).some(entry => entry.pending)).toBe(false);
    expect(provider.direct("doc-1")).toEqual([["perm-A", "owner"]]);
  });

  it("refuses to change an owner's, an inherited or its own access", async () => {
    // Someone else's file, on which the connected account is an editor.
    provider.files.set("shared-doc", file(DOC_MIME, ["elsewhere"]));
    provider.give("shared-doc", { ...CAROL, role: "owner" });
    provider.give("shared-doc", { type: "user", emailAddress: "me@example.com", role: "writer" });
    // Bob views everything in the folder, and edits one file of it.
    provider.give(ROOT, { ...BOB, role: "reader" });
    provider.give("sheet-1", { ...BOB, role: "writer" });
    provider.give("sheet-1", { ...TEAM, role: "commenter" });
    provider.give("sheet-1", { type: "anyone", role: "reader", allowFileDiscovery: false });
    // Erin edits everything in the folder, which is as much as can be given on a file of it.
    provider.give(ROOT, { ...ERIN, role: "writer" });
    // One address under two permissions, a person's and a group's.
    provider.give("sheet-1", { ...DANA, role: "reader" });
    provider.give("sheet-1", { ...DANA, type: "group", role: "reader", id: "perm-dana-group" });
    let severalMatch =
      "More than one access on this file matches that grantee; name it by the ID listAccess() " +
      "returns.";
    let drive = binding();

    let refusals: [string, DriveMethod, ...unknown[]][] = [
      [OWNER_OR_MANAGER, "updateAccess", "shared-doc", "perm-carol", "reader"],
      [OWNER_OR_MANAGER, "unshare", "shared-doc", CAROL],
      [OWNER_OR_MANAGER, "share", "shared-doc", CAROL, "reader"],
      [OWN_ACCESS, "updateAccess", "shared-doc", "perm-A", "reader"],
      [OWN_ACCESS, "unshare", "shared-doc", "perm-A"],
      [OWN_ACCESS, "share", "doc-1", { type: "user", emailAddress: "Me@Example.com" }, "reader"],
      [INHERITED_ONLY, "updateAccess", "doc-1", "perm-bob", "writer"],
      [INHERITED_ONLY, "unshare", "doc-1", BOB],
      ["That grantee already has reader access to this file through a parent, which this would " +
        "not change. Give a higher role, or change the sharing of the folder it comes from.",
        "share", "doc-1", BOB, "reader"],
      ["That grantee already has writer access to this file through a parent, which this would " +
        "not change. No higher role can be given here; the access itself is changed where it " +
        "comes from.", "share", "doc-1", ERIN, "writer"],
      ["That grantee already has commenter access given on this file itself. Change it with " +
        "updateAccess(), which takes the same grantee.", "share", "sheet-1", TEAM, "writer"],
      ["That grantee already has reader access given on this file itself. updateAccess(), which " +
        "takes the same grantee, changes its role. Whether it can be found by searching is set " +
        "when access is given: to change that, unshare() it and, once that is approved, share() " +
        "again.", "share", "sheet-1", ANYONE, "writer"],
      ["That access already has that role.", "updateAccess", "sheet-1", "perm-team", "commenter"],
      ["A parent already gives that grantee reader access to this file, and access given on the " +
        "file cannot be lower. To leave only the parent's access, use unshare().",
        "updateAccess", "sheet-1", "perm-bob", "reader"],
      ["That access was not found on this file.", "updateAccess", "doc-1", "perm-nobody", "reader"],
      ["That grantee has no access given on this file itself.", "unshare", "doc-1", CAROL],
      [severalMatch, "updateAccess", "sheet-1", DANA, "writer"],
      [severalMatch, "unshare", "sheet-1", DANA],
      ["Not a Google Drive access ID.", "unshare", "doc-1", "not an ID"],
      ["Not an email address.", "share", "doc-1", { type: "user", emailAddress: "bob" }, "reader"],
      ["Not a domain name.", "share", "doc-1", { type: "domain", domain: "example" }, "reader"],
      ["notify applies only to a user or a group.", "share", "doc-1", ANYONE, "reader",
        { notify: false }],
      ["message applies only to a user or a group that is emailed.", "share", "doc-1", BOB,
        "writer", { notify: false, message: "Hi" }],
      ["The message is empty.", "share", "doc-1", BOB, "writer", { message: "  " }],
      ["The message is 1001 characters; at most 1000 are sent.", "share", "doc-1", BOB, "writer",
        { message: "x".repeat(1001) }],
      ["discoverable applies only to a domain or to anyone.", "share", "doc-1", BOB, "writer",
        { discoverable: true }],
    ];
    for (let [message, method, ...args] of refusals) {
      let refused = await drive.call(method, ...args);

      expect(refused.error, `${method} ${JSON.stringify(args)}`).toBe(message);
      expect(refused.actionId).toBeUndefined();
    }
    expect(await drive.waiting()).toEqual([]);
    expect(provider.writes).toEqual([]);
  });

  // Drive goes on listing the permission of an account that was deleted. It is nobody's access: a
  // listing leaves it out, and its ID names nothing to change or remove.
  it("neither lists nor changes the permission of a deleted account", async () => {
    provider.give("doc-1", { type: "user", role: "reader", id: "perm-gone", deleted: true });
    let drive = binding();

    expect(provider.access("doc-1").map(({ id, deleted }) => [id, deleted]))
      .toEqual([["perm-A", false], ["perm-gone", true]]);
    expect((await drive.access("doc-1")).map(entry => entry.id)).toEqual(["perm-A", "perm-A"]);
    let calls: [DriveMethod, ...unknown[]][] = [
      ["updateAccess", "doc-1", "perm-gone", "writer"], ["unshare", "doc-1", "perm-gone"],
    ];
    for (let [method, ...args] of calls) {
      let refused = await drive.call(method, ...args);

      expect(refused.error, method).toBe("That access was not found on this file.");
      expect(refused.actionId).toBeUndefined();
    }
    expect(await drive.waiting()).toEqual([]);
    expect(provider.writes).toEqual([]);
  });

  it("refuses a file shared with more people than one read lists", async () => {
    provider.endless.add("doc-1");
    let drive = binding();
    let calls: [DriveMethod, ...unknown[]][] = [
      ["listAccess", "doc-1"],
      ["share", "doc-1", BOB, "reader"],
      ["updateAccess", "doc-1", BOB, "writer"],
      ["unshare", "doc-1", "perm-bob"],
    ];

    for (let [method, ...args] of calls) {
      provider.forget();
      let refused = await drive.call(method, ...args);

      expect(refused.error, method)
        .toBe("This file is shared with more people than can be listed here.");
      expect(refused.actionId).toBeUndefined();
      // The file itself was reported, and nothing of a list that was not read to its end.
      expect(refused.reports).toEqual([SHARING_OF("drive/file/doc-1")]);
      // Ten pages are read, and no more.
      expect(permissionCalls(), method).toHaveLength(10);
    }
    expect(await drive.waiting()).toEqual([]);
  });

  it("fails an approved share on a read-only binding, and keeps it pending without the grant", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    await drive.restart();
    let readOnly = binding(ACCOUNT, null, drive.facet);

    expect(await readOnly.apply(actionId)).toBe(READ_ONLY_ACCOUNT);
    expect(await readOnly.apply(actionId)).toBe(READ_ONLY_ACCOUNT);
    expect(provider.writes).toEqual([]);

    let waiting = binding();
    let kept = await waiting.queued("share", "doc-1", BOB, "reader");
    await setGrants([GOOGLE_DRIVE_RESOURCE.urlPattern]);

    // The write waits rather than failing for good: a later approval asks the account again.
    expect(await waiting.apply(kept.actionId)).toBe(GRANT_MISSING);
    expect(await waiting.apply(kept.actionId)).toBe(GRANT_MISSING);
    expect(await waiting.waiting()).toEqual([kept.actionId]);
    expect(provider.writes).toEqual([]);

    await setGrants(GRANTED);
    expect(await waiting.apply(kept.actionId)).toBeNull();
    expect(provider.direct("doc-1")).toContainEqual(["perm-bob", "reader"]);
  });

  it("fails an approved move on a read-only binding, and keeps it pending without the grant", async () => {
    let drive = binding(FOLDER);
    let { actionId } = await drive.queued("move", "doc-1", "inner");
    await drive.restart();
    let readOnly = binding(FOLDER, null, drive.facet);

    expect(await readOnly.apply(actionId)).toBe(READ_ONLY(`${FOLDER_URL}?access=write`));
    expect(await readOnly.apply(actionId)).toBe(READ_ONLY(`${FOLDER_URL}?access=write`));

    let waiting = binding(FOLDER);
    let kept = await waiting.queued("move", "sheet-1", "inner");
    await setGrants([GOOGLE_DRIVE_RESOURCE.urlPattern]);

    expect(await waiting.apply(kept.actionId)).toBe(GRANT_MISSING);
    expect(await waiting.apply(kept.actionId)).toBe(GRANT_MISSING);
    expect(await waiting.waiting()).toEqual([kept.actionId]);
    expect(provider.writes).toEqual([]);

    await setGrants(GRANTED);
    expect(await waiting.apply(kept.actionId)).toBeNull();
    expect(provider.files.get("sheet-1")?.parents).toEqual(["inner"]);
    expect(provider.files.get("doc-1")?.parents).toEqual([ROOT]);
  });

  it("re-proves a share when it is approved", async () => {
    let drive = binding(FOLDER);
    let moved = await drive.queued("share", "doc-1", BOB, "reader");
    let unshareable = await drive.queued("share", "sheet-1", BOB, "reader");
    change("doc-1", { parents: ["elsewhere"] });
    change("sheet-1", { canShare: false });

    for (let _attempt of [1, 2]) {
      expect(await drive.apply(moved.actionId)).toBe(NO_LONGER_IN_SCOPE);
      expect(await drive.apply(unshareable.actionId))
        .toBe("The connected account can no longer change who has access to that file.");
    }
    expect(provider.writes).toEqual([]);
  });

  it("fails a change approved after the connection became another Google account's", async () => {
    let drive = binding();
    let untouched = binding();
    let first = await drive.queued("share", "doc-1", BOB, "reader");
    let only = await untouched.queued("share", "sheet-1", BOB, "reader");
    // No restart: each gatekeeper still holds the first account's token, which Google accepts.
    await switchAccount();
    provider.forget();

    // With nothing asked since the switch, the approval's own load of the stored token decides.
    expect(await untouched.apply(only.actionId)).toBe(FENCE_REPLACED);
    expect(provider.requests).toEqual([{ call: "GET /drive/v3/about", token: OTHER_TOKEN }]);
    provider.forget();

    let second = await drive.queued("share", "doc-1", CAROL, "reader");

    // The identity is read first, under the stored token, and so is everything after it.
    expect(provider.requests[0]).toEqual({ call: "GET /drive/v3/about", token: OTHER_TOKEN });
    expect(provider.calls()).toContain("GET /drive/v3/files/doc-1");
    expect(provider.requests.filter(({ token }) => token !== OTHER_TOKEN)).toEqual([]);

    provider.forget();
    expect(await drive.apply(first.actionId)).toBe(FENCE_REPLACED);
    expect(provider.requests).toEqual([{ call: "GET /drive/v3/about", token: OTHER_TOKEN }]);
    expect(await drive.apply(first.actionId)).toBe(FENCE_REPLACED);
    expect(provider.writes).toEqual([]);

    // The second was staged as the account connected now, and is made as it.
    expect(await drive.apply(second.actionId)).toBeNull();
    expect(sent(CREATE_ON_DOC).map(({ token }) => token)).toEqual([OTHER_TOKEN]);
    expect(provider.direct("doc-1")).toEqual([["perm-A", "owner"], ["perm-carol", "reader"]]);
  });

  it("never sends a refused change again under credentials installed during its approval", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    // A reconnect as the second account that lands inside the approval: its one load of the
    // stored token is still the first account's, and any later load would be the second's.
    await account().setDriveToken(OTHER_TOKEN, 1);
    provider.nextWrite = { status: 403, reason: "shareOutNotPermitted" };
    provider.forget();

    expect(await drive.apply(actionId)).toBe(SHARE_OUT_REFUSED);

    expect(provider.calls()).toEqual(expect.arrayContaining([
      "GET /drive/v3/about", "POST /batch/drive/v3", "GET /drive/v3/files/doc-1/permissions",
      CREATE_ON_DOC,
    ]));
    expect(provider.requests.filter(({ token }) => token === OTHER_TOKEN)).toEqual([]);
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
    expect(provider.direct("doc-1")).toEqual([["perm-A", "owner"]]);

    provider.forget();
    expect(await drive.apply(actionId)).toBe(SHARE_OUT_REFUSED);
    expect(provider.requests).toEqual([]);
  });

  it("keeps a change pending when Google stops accepting the approval's token", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    provider.nextWrite = { status: 401 };

    expect(await drive.apply(actionId)).toBe(CREDENTIALS_NOT_ACCEPTED);
    // Nothing refreshes the approval's token, so the send is not made a second time.
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
    expect(await drive.waiting()).toEqual([actionId]);
    expect(Object.keys(await drive.attempts())).toEqual([String(actionId)]);

    provider.forget();
    expect(await drive.apply(actionId)).toBeNull();
    // The next approval looks before it sends.
    let calls = provider.calls();
    expect(calls.indexOf("GET /drive/v3/files/doc-1/permissions")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("GET /drive/v3/files/doc-1/permissions"))
      .toBeLessThan(calls.indexOf(CREATE_ON_DOC));
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
    expect(provider.direct("doc-1")).toContainEqual(["perm-bob", "reader"]);
  });

  // Max: a stored token Google rejects before its expiry must be refreshed by the identity read,
  // or every approval reloads it and fails until it expires.
  it("refreshes a stored token Google stopped accepting during the identity read, and makes the change under the new one", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    // The account's stored token is rejected; a refresh, the next load after the approval's own,
    // answers a new one for the same Google account.
    await account().setDriveToken("stale-token");
    await account().setDriveToken("fresh-token", 1);
    provider.rejected.add("stale-token");
    provider.forget();

    expect(await drive.apply(actionId)).toBeNull();
    expect(provider.requests.slice(0, 2)).toEqual([
      { call: "GET /drive/v3/about", token: "stale-token" },
      { call: "GET /drive/v3/about", token: "fresh-token" },
    ]);
    // After the identity read, everything goes out under the token it was answered under.
    expect(provider.requests.slice(2).filter(({ token }) => token !== "fresh-token")).toEqual([]);
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
    expect(provider.direct("doc-1")).toContainEqual(["perm-bob", "reader"]);
  });

  it("holds no later approval to the token of a sharing approval that failed", async () => {
    let drive = binding();
    let comment = await drive.queued("comment", "doc-1", "Hi");
    let share = await drive.queued("share", "doc-1", BOB, "reader");
    provider.nextWrite = { status: 403, reason: "shareOutNotPermitted" };
    expect(await drive.apply(share.actionId)).toBe(SHARE_OUT_REFUSED);
    await switchAccount();
    provider.nextWrite = { status: 403, reason: "insufficientPermissions" };

    // A comment is applied as whichever account is connected: refused for the scope, it is sent
    // again under the credentials stored since, which the failed approval's token would prevent.
    expect(await drive.apply(comment.actionId)).toBeNull();
    expect(sent(COMMENT_ON_DOC).map(({ token }) => token === OTHER_TOKEN)).toEqual([false, true]);
    expect(provider.comments.get("doc-1")).toEqual(["Hi"]);
  });

  it("leaves a write whose send is in doubt as it is while another account is connected, and finishes it once the first is back", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    provider.nextWrite = "lost";
    expect(await drive.apply(actionId)).toBe(UNCONFIRMED);
    let marker = await drive.attempts();
    expect(Object.keys(marker)).toEqual([String(actionId)]);
    await switchAccount();

    // Not the kit's message, which says to submit again what may already be on the file.
    expect(await drive.apply(actionId)).toBe(SEND_IN_DOUBT_OTHER_ACCOUNT);
    expect(await drive.apply(actionId)).toBe(SEND_IN_DOUBT_OTHER_ACCOUNT);
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
    expect(await drive.waiting()).toEqual([actionId]);
    expect(await drive.attempts()).toEqual(marker);

    await account().setDriveToken(undefined);
    expect(await drive.apply(actionId)).toBeNull();
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
    expect(await drive.waiting()).toEqual([]);
    expect(await drive.attempts()).toEqual({});
  });

  it("neither adopts nor fails a claim whose send is in doubt while another account is connected", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    provider.nextWrite = "lost";
    expect(await drive.apply(actionId)).toBe(UNCONFIRMED);
    await drive.orphan(actionId);
    await drive.restart();
    await switchAccount();

    expect(await drive.apply(actionId)).toBe(SEND_IN_DOUBT_OTHER_ACCOUNT);
    expect(await drive.apply(actionId)).toBe(SEND_IN_DOUBT_OTHER_ACCOUNT);
    expect(await drive.waiting()).toEqual([actionId]);

    await account().setDriveToken(undefined);
    expect(await drive.apply(actionId)).toBeNull();
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
  });

  it("withdraws a write whose send is in doubt while another account is connected", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    provider.nextWrite = "lost";
    expect(await drive.apply(actionId)).toBe(UNCONFIRMED);
    await switchAccount();

    expect(await drive.reject(actionId)).toBeNull();

    expect(await drive.attempts()).toEqual({});
    expect(await drive.waiting()).toEqual([]);
    expect(provider.direct("doc-1")).toContainEqual(["perm-bob", "reader"]);
  });

  it("keeps a change pending when the identity read is refused for the scope", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    provider.nextWrite = "lost";
    expect(await drive.apply(actionId)).toBe(UNCONFIRMED);
    let marker = await drive.attempts();
    provider.about.fail = { status: 403, reason: "insufficientPermissions" };

    // The missing grant, said as it, and not as a failed request.
    expect(await drive.apply(actionId)).toBe(GRANT_MISSING);
    expect(await drive.waiting()).toEqual([actionId]);
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
    expect(await drive.attempts()).toEqual(marker);

    let refused = await drive.call("share", "doc-1", CAROL, "reader");
    expect(refused.error).toBe(GRANT_MISSING);
    expect(refused.actionId).toBeUndefined();

    provider.about.fail = undefined;
    expect(await drive.apply(actionId)).toBeNull();
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
  });

  it("answers an applied change again without asking who is connected", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    expect(await drive.apply(actionId)).toBeNull();
    provider.about.fail = { status: 503 };
    provider.forget();

    expect(await drive.apply(actionId)).toBeNull();
    expect(provider.requests).toEqual([]);
  });

  it("reports Google's refusal with its reason code", async () => {
    let drive = binding();
    let known = await drive.queued("share", "doc-1", BOB, "reader");
    let unknown = await drive.queued("share", "sheet-1", BOB, "reader");
    provider.nextWrite = { status: 403, reason: "shareOutNotPermitted" };
    expect(await drive.apply(known.actionId)).toBe(SHARE_OUT_REFUSED);
    provider.nextWrite = { status: 403, reason: "someNewRule" };
    let fallback = "Google Drive refused this sharing change. [http=403 reason=someNewRule]";
    expect(await drive.apply(unknown.actionId)).toBe(fallback);

    // Nothing changed, no marker is left, and each later approval is answered the same.
    expect(provider.direct("doc-1")).toEqual([["perm-A", "owner"]]);
    expect(provider.direct("sheet-1")).toEqual([["perm-A", "owner"]]);
    expect(await drive.attempts()).toEqual({});
    expect(await drive.apply(known.actionId)).toBe(SHARE_OUT_REFUSED);
    expect(await drive.apply(unknown.actionId)).toBe(fallback);
    expect(provider.writes).toHaveLength(2);
  });

  it("finds a share an unconfirmed send made, without sending again", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    provider.nextWrite = "lost";

    expect(await drive.apply(actionId)).toBe(UNCONFIRMED);
    expect(Object.keys(await drive.attempts())).toEqual([String(actionId)]);

    expect(await drive.apply(actionId)).toBeNull();
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
    expect(await drive.attempts()).toEqual({});
  });

  it("withdraws a change whose send may have gone", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    provider.nextWrite = "lost";
    expect(await drive.apply(actionId)).toBe(UNCONFIRMED);

    expect(await drive.reject(actionId)).toBeNull();

    expect(provider.direct("doc-1")).toContainEqual(["perm-bob", "reader"]);
    expect(await drive.attempts()).toEqual({});
  });
});

describe("moves", () => {
  it("moves a child into a child folder and back up, within a folder binding", async () => {
    let drive = binding(FOLDER);

    let down = await drive.queued("move", "doc-1", "inner");

    expect(down.value).toBeUndefined();
    expect(down.action).toMatchObject({
      title: "Move a Google Drive file",
      description: "**Moving changes who has access.** Move Google Drive file `doc-1` from " +
        `folder \`folder-root\` into folder \`inner\`, as the connected account.\n\n${MOVE_ACCESS}`,
      actionKind: { tag: "driveMoves", label: "Drive moves" },
      awaitDecision: true,
      autoApprovable: false,
      implementsRevert: false,
      descriptionIsComplete: true,
      fields: [
        { label: "File", kind: "inline", value: "doc-1" },
        { label: "File name", kind: "inline", value: "doc-1" },
        { label: "From folder", kind: "inline", value: "folder-root" },
        { label: "From folder name", kind: "inline", value: "folder-root" },
        { label: "To folder", kind: "inline", value: "inner" },
        { label: "To folder name", kind: "inline", value: "inner" },
      ],
    });
    expect(down.reports)
      .toEqual([MOVE_OF("drive/folder/folder-root", "drive/file/doc-1", "drive/file/inner")]);
    // A move is not simulated: the file is where it is until it has moved.
    expect((await drive.call("getEntry", "doc-1")).error).toBeUndefined();
    expect((await drive.callIn(["inner"], "getEntry", "doc-1")).error).toBe(OUTSIDE);
    expect(provider.writes).toEqual([]);

    expect(await drive.apply(down.actionId)).toBeNull();
    expect(parentsOf("doc-1")).toEqual(["inner"]);
    expect(movesOf("doc-1")).toEqual([["inner", ROOT]]);

    expect((await drive.callIn(["inner"], "getScope")).value)
      .toMatchObject({ folderId: "inner", parentFolderId: ROOT });
    let up = await drive.queuedIn(["inner"], "move", "doc-1", ROOT);
    expect(await drive.apply(up.actionId)).toBeNull();
    expect(parentsOf("doc-1")).toEqual([ROOT]);
  });

  it("never moves above or outside the bound folder", async () => {
    provider.files.set("outside-doc", file(DOC_MIME, ["elsewhere"]));
    let drive = binding(FOLDER);

    let refused = [
      [await drive.call("move", "doc-1", "above"), MOVE_FOLDER_DESTINATION],
      [await drive.call("move", "doc-1", "elsewhere"), MOVE_FOLDER_DESTINATION],
      [await drive.callIn(["inner"], "move", "nested-doc", "elsewhere"), MOVE_FOLDER_DESTINATION],
      // The root session was opened from nothing, so it names no folder above it.
      [await drive.call("move", "doc-1", ROOT), MOVE_FOLDER_DESTINATION],
      [await drive.call("move", "outside-doc", "inner"), OUTSIDE],
    ] as const;

    for (let [outcome, message] of refused) {
      expect(outcome.error).toBe(message);
      expect(outcome.actionId).toBeUndefined();
    }
    expect(await drive.waiting()).toEqual([]);
    expect(provider.writes).toEqual([]);
  });

  it("reads through a folder's shortcuts, writes nothing through them, and stops at a trashed one", async () => {
    provider.files.set("far-doc", file(DOC_MIME, ["elsewhere"]));
    provider.files.set("far-folder", file(FOLDER_MIME, ["elsewhere"]));
    provider.files.set("deep-doc", file(DOC_MIME, ["far-folder"]));
    provider.files.set("to-doc", file(SHORTCUT_MIME, [ROOT], { shortcutTargetId: "far-doc" }));
    provider.files.set("to-folder", file(SHORTCUT_MIME, [ROOT], { shortcutTargetId: "far-folder" }));
    let drive = binding(FOLDER);

    expect((await drive.call("getEntry", "far-doc")).value).toMatchObject({ id: "far-doc" });
    expect((await drive.callIn(["far-folder"], "getEntry", "deep-doc")).value)
      .toMatchObject({ id: "deep-doc" });
    // Writes refuse there, so it says it is read-only, although the binding is not.
    expect((await drive.call("getScope")).value).toMatchObject({ access: "write" });
    expect((await drive.callIn(["far-folder"], "getScope")).value)
      .toMatchObject({ folderId: "far-folder", access: "read" });

    let refused = [
      [await drive.call("comment", "far-doc", "Hi"), OUTSIDE],
      [await drive.call("listAccess", "far-doc"), OUTSIDE],
      [await drive.call("move", "far-doc", "inner"), OUTSIDE],
      [await drive.callIn(["far-folder"], "comment", "deep-doc", "Hi"), THROUGH_SHORTCUT],
      [await drive.callIn(["far-folder"], "listAccess", "far-folder"), THROUGH_SHORTCUT],
      [await drive.callIn(["far-folder"], "listAccess", "deep-doc"), THROUGH_SHORTCUT],
      [await drive.callIn(["far-folder"], "move", "deep-doc", "far-folder"), THROUGH_SHORTCUT],
    ] as const;
    for (let [outcome, message] of refused) {
      expect(outcome.error).toBe(message);
      expect(outcome.actionId).toBeUndefined();
    }
    // Said in place of asking for write access, which would not make the folder writable.
    let readOnly = binding(FOLDER, null);
    for (let [method, ...args] of [
      ["comment", "deep-doc", "Hi"], ["listAccess", "deep-doc"], ["move", "deep-doc", "far-folder"],
    ] as const) {
      expect((await readOnly.callIn(["far-folder"], method, ...args)).error).toBe(THROUGH_SHORTCUT);
    }

    provider.files.get("to-doc")!.trashed = true;
    provider.files.get("to-folder")!.trashed = true;
    expect((await drive.call("getEntry", "far-doc")).error).toBe(OUTSIDE);
    expect((await drive.callIn(["far-folder"], "getEntry", "deep-doc")).error).toBe(OUTSIDE);
    expect(await drive.waiting()).toEqual([]);
    expect(provider.writes).toEqual([]);
  });

  it("moves any file to any folder of its drive on an account binding, and to no other drive", async () => {
    let drive = binding();

    let queued = await drive.queued("move", "doc-1", "elsewhere");

    // The folder the file leaves is not reported, and its name is not on the card.
    expect(queued.reports).toEqual([MOVE_OF("drive/file/doc-1", "drive/file/elsewhere")]);
    expect(queued.action.fields?.map(({ label }) => label))
      .toEqual(["File", "File name", "From folder", "To folder", "To folder name"]);
    expect(await drive.apply(queued.actionId)).toBeNull();
    expect(parentsOf("doc-1")).toEqual(["elsewhere"]);

    let refusals: [string, string, string][] = [
      ["Moving between drives is not supported: the file and the folder must be in the same " +
        "shared drive, or both outside shared drives.", "doc-1", "team"],
      ["The destination is not a folder.", "sheet-1", "doc-1"],
      ["That file is already in that folder.", "sheet-1", ROOT],
    ];
    for (let [message, fileId, folderId] of refusals) {
      let refused = await drive.call("move", fileId, folderId);

      expect(refused.error, `${fileId} to ${folderId}`).toBe(message);
      expect(refused.actionId).toBeUndefined();
    }

    // Refused before the identity is read, whatever that read would answer.
    provider.about.fail = { status: 403, reason: "insufficientPermissions" };
    provider.forget();
    expect((await drive.call("move", "inner", "inner")).error)
      .toBe("A folder cannot be moved into itself.");
    expect(provider.requests).toEqual([]);
  });

  it("refuses a move of a file in the trash, and a move into a folder that is", async () => {
    let drive = binding();
    change("sheet-1", { trashed: true });
    change("archive", { trashed: true });

    let trashed = await drive.call("move", "sheet-1", "elsewhere");
    let intoTrash = await drive.call("move", "loose-doc", "archive");

    expect(trashed.error).toBe("That file is in the trash, so it cannot be moved.");
    expect(trashed.reports).toEqual([MOVE_OF("drive/file/sheet-1")]);
    expect(intoTrash.error).toBe("That folder is in the trash, so nothing can be moved into it.");
    expect(intoTrash.reports).toEqual([MOVE_OF("drive/file/loose-doc", "drive/file/archive")]);

    // Put in the trash after its move was queued, each fails when it is approved.
    let trashedFile = await drive.queued("move", "nested-doc", "elsewhere");
    let destination = await drive.queued("move", "loose-doc", "inner");
    change("nested-doc", { trashed: true });
    change("inner", { trashed: true });

    expect(await drive.apply(trashedFile.actionId))
      .toBe("That file is in the trash, so it was not moved.");
    expect(await drive.apply(destination.actionId))
      .toBe("That folder is in the trash, so nothing was moved into it.");
    expect(provider.writes).toEqual([]);
  });

  it("moves a file out of and into the top level of My Drive without requiring that folder of anyone", async () => {
    let drive = binding();
    let folder = binding(FOLDER);

    let out = await drive.queued("move", "loose-doc", "elsewhere");
    let into = await drive.queued("move", "doc-1", "root");
    let byId = await drive.queued("move", "sheet-1", MY_ROOT);

    expect(out.reports).toEqual([MOVE_OF("drive/file/loose-doc", "drive/file/elsewhere")]);
    expect(field(out.action, "From folder")).toBe(MY_ROOT);
    expect(field(out.action, "From folder name")).toBeUndefined();
    expect(out.action.description.split("\n\n")).toContain(
      "The folder it leaves is the top level of the connected account's My Drive.");
    expect(into.reports).toEqual([MOVE_OF("drive/file/doc-1")]);
    for (let { action } of [into, byId]) {
      expect(field(action, "To folder")).toBe(MY_ROOT);
      expect(field(action, "To folder name")).toBeUndefined();
      expect(action.description.split("\n\n")).toContain(
        "The folder it goes into is the top level of the connected account's My Drive.");
    }
    expect(byId.reports).toEqual([MOVE_OF("drive/file/sheet-1")]);

    // The alias names nothing on a folder binding, and no file anywhere.
    expect((await folder.call("move", "sheet-1", "root")).error).toBe(MOVE_FOLDER_DESTINATION);
    expect((await folder.call("getEntry", "root")).error).toBe(OUTSIDE);
    expect((await drive.call("getEntry", "root")).error).toBe(OUTSIDE);

    expect(await drive.apply(into.actionId)).toBeNull();
    // Sent to the folder's own ID, never to the alias.
    expect(movesOf("doc-1")).toEqual([[MY_ROOT, ROOT]]);
    expect(parentsOf("doc-1")).toEqual([MY_ROOT]);

    // A folder binding connected to that folder by its ID has it above its first child folders.
    // A move up into it requires the folder the file leaves and the file, and nothing of the root.
    provider.files.set("filed-doc", file(DOC_MIME, ["elsewhere"]));
    let top = binding({ kind: "folder", folderId: MY_ROOT });
    let up = await top.queuedIn(["elsewhere"], "move", "filed-doc", MY_ROOT);

    expect(up.reports.at(-1))
      .toEqual(MOVE_OF("drive/folder/elsewhere", "drive/file/filed-doc"));
    expect(field(up.action, "From folder name")).toBe("elsewhere");
    expect(field(up.action, "To folder")).toBe(MY_ROOT);
    expect(field(up.action, "To folder name")).toBeUndefined();
    expect(up.action.description.split("\n\n")).toContain(
      "The folder it goes into is the top level of the connected account's My Drive.");
    expect(await top.apply(up.actionId)).toBeNull();
    expect(parentsOf("filed-doc")).toEqual([MY_ROOT]);
  });

  it("refuses a move from a single-file binding and a second move of one file", async () => {
    let single = await binding(DOC_FILE).call("move", "doc-1", "inner");

    expect(single.error).toBe(MOVE_SINGLE_FILE);
    expect(single.actionId).toBeUndefined();
    expect(provider.requests).toEqual([]);

    let drive = binding();
    let first = await drive.queued("move", "doc-1", "elsewhere");
    let second = await drive.call("move", "doc-1", "archive");

    expect(second.error).toBe(MOVE_PENDING);
    expect(second.actionId).toBeUndefined();
    expect(await drive.waiting()).toEqual([first.actionId]);
  });

  it("refuses, on a folder binding, a write behind a waiting move of its file or of a folder its file is in", async () => {
    let drive = binding(FOLDER);
    let move = await drive.queued("move", "doc-1", "inner");

    let behind: [DriveMethod, ...unknown[]][] = [
      ["comment", "doc-1", "Hi"],
      ["reply", "doc-1", "doco.x", "Hi"],
      ["resolve", "doc-1", "doco.x"],
      ["share", "doc-1", BOB, "reader"],
      ["updateAccess", "doc-1", "perm-bob", "writer"],
      ["unshare", "doc-1", "perm-bob"],
    ];
    for (let [method, ...args] of behind) {
      let refused = await drive.call(method, ...args);

      expect(refused.error, method).toBe(MOVE_WAITING);
      expect(refused.actionId).toBeUndefined();
    }
    // Reads still answer, and so does a write on another file.
    expect((await drive.call("listAccess", "doc-1")).error).toBeUndefined();
    expect((await drive.call("listComments", "doc-1")).error).toBeUndefined();
    await drive.queued("comment", "sheet-1", "Hi");
    expect(await drive.reject(move.actionId)).toBeNull();
    await drive.queued("comment", "doc-1", "Hi");

    // A folder's move holds back what is in it, the folder itself and a move into it.
    let folderMove = await drive.queued("move", "inner", "archive");
    expect(folderMove.action.title).toBe("Move a Google Drive folder");
    expect(folderMove.action.description.split("\n\n")).toContain("Everything in it moves with it.");
    let refusals: [string, string[], DriveMethod, ...unknown[]][] = [
      [MOVE_WAITING, ["inner"], "comment", "nested-doc", "Hi"],
      [MOVE_WAITING, ["inner"], "share", "nested-doc", BOB, "reader"],
      [MOVE_WAITING, ["inner"], "share", "inner", BOB, "reader"],
      [MOVE_WAITING, ["inner"], "move", "nested-doc", ROOT],
      [MOVE_WAITING, [], "share", "inner", BOB, "reader"],
      [MOVE_PENDING, [], "move", "inner", "archive"],
      [MOVE_DESTINATION_WAITING, [], "move", "doc-1", "inner"],
    ];
    for (let [message, path, method, ...args] of refusals) {
      let refused = await drive.callIn(path, method, ...args);

      expect(refused.error, `${path.join("/")} ${method} ${String(args[0])}`).toBe(message);
      expect(refused.actionId).toBeUndefined();
    }
    await drive.queued("move", "doc-1", "archive");

    expect(await drive.apply(folderMove.actionId)).toBeNull();
    expect(parentsOf("inner")).toEqual(["archive"]);
    // A session opened at the folder where it was no longer reaches it.
    expect((await drive.callIn(["inner"], "getScope")).error).toBe(OUTSIDE);
    let moved = await drive.queuedIn(["archive", "inner"], "comment", "nested-doc", "Hi");
    expect(await drive.apply(moved.actionId)).toBeNull();
    expect(provider.comments.get("nested-doc")).toEqual(["Hi"]);
  });

  it("refuses what waits behind a move an interrupted approval left claimed", async () => {
    // An approval that ended before it settled the move: the Workshop still holds the action,
    // and the next approval makes the move.
    let drive = binding();
    let first = await drive.queued("move", "doc-1", "elsewhere");
    await drive.orphan(first.actionId);
    await drive.restart();

    let second = await drive.call("move", "doc-1", "archive");

    expect(second.error).toBe(MOVE_PENDING);
    expect(second.actionId).toBeUndefined();
    expect(await drive.waiting()).toEqual([first.actionId]);
    expect(await drive.apply(first.actionId)).toBeNull();
    expect(parentsOf("doc-1")).toEqual(["elsewhere"]);

    let folder = binding(FOLDER);
    let move = await folder.queued("move", "inner", "archive");
    await folder.orphan(move.actionId);
    await folder.restart();
    let refusals: [string, string[], DriveMethod, ...unknown[]][] = [
      [MOVE_WAITING, ["inner"], "comment", "nested-doc", "Hi"],
      [MOVE_WAITING, ["inner"], "share", "nested-doc", BOB, "reader"],
      [MOVE_WAITING, ["inner"], "move", "nested-doc", ROOT],
      [MOVE_WAITING, [], "share", "inner", BOB, "reader"],
      [MOVE_PENDING, [], "move", "inner", "archive"],
      [MOVE_DESTINATION_WAITING, [], "move", "sheet-1", "inner"],
    ];
    for (let [message, path, method, ...args] of refusals) {
      let refused = await folder.callIn(path, method, ...args);

      expect(refused.error, `${path.join("/")} ${method} ${String(args[0])}`).toBe(message);
      expect(refused.actionId).toBeUndefined();
    }
    expect(await folder.waiting()).toEqual([move.actionId]);

    // A send in doubt under another Google account leaves the claim where it is, however often
    // it is approved.
    let doubted = binding();
    let lost = await doubted.queued("move", "sheet-1", "elsewhere");
    provider.nextWrite = "lost";
    expect(await doubted.apply(lost.actionId)).toBe(UNCONFIRMED_MOVE);
    await doubted.orphan(lost.actionId);
    await doubted.restart();
    await switchAccount();
    expect(await doubted.apply(lost.actionId)).toBe(SEND_IN_DOUBT_OTHER_ACCOUNT);
    expect((await doubted.call("move", "sheet-1", "archive")).error).toBe(MOVE_PENDING);
    expect(await doubted.waiting()).toEqual([lost.actionId]);
  });

  it("queues a write behind a waiting move on an account binding", async () => {
    provider.give("doc-1", { ...BOB, role: "reader" });
    provider.give("doc-1", { ...TEAM, role: "commenter" });
    let { id: commentId } = provider.post("doc-1", "First");
    let drive = binding();
    let move = await drive.queued("move", "doc-1", "elsewhere");

    // An account binding proves no path, so nothing a move changes is what a write rests on.
    let behind: [DriveMethod, ...unknown[]][] = [
      ["comment", "doc-1", "Hi"],
      ["reply", "doc-1", commentId, "Hi"],
      ["resolve", "doc-1", commentId],
      ["share", "doc-1", CAROL, "reader"],
      ["updateAccess", "doc-1", "perm-bob", "writer"],
      ["unshare", "doc-1", "perm-team"],
    ];
    let queued: number[] = [];
    for (let [method, ...args] of behind) {
      let outcome = await drive.call(method, ...args);

      expect(outcome.error, method).toBeUndefined();
      if (outcome.actionId !== undefined) queued.push(outcome.actionId);
    }

    expect(queued).toHaveLength(behind.length);
    expect(await drive.waiting()).toEqual([move.actionId, ...queued]);
  });

  it("re-proves a move when it is approved", async () => {
    let drive = binding(FOLDER);
    let gone = await drive.queued("move", "doc-1", "inner");
    let made = await drive.queued("move", "sheet-1", "archive");
    change("inner", { parents: ["elsewhere"] });
    change("sheet-1", { parents: ["archive"] });

    expect(await drive.apply(gone.actionId)).toBe(NO_LONGER_IN_SCOPE);
    // With no send of this move on record, it is someone else's doing.
    expect(await drive.apply(made.actionId))
      .toBe("That file was already moved there after this was queued, so nothing was changed.");
    expect(provider.writes).toEqual([]);
  });

  it("finds a move an unconfirmed send made", async () => {
    let drive = binding(FOLDER);
    let { actionId } = await drive.queued("move", "doc-1", "inner");
    provider.nextWrite = "lost";

    expect(await drive.apply(actionId)).toBe(UNCONFIRMED_MOVE);
    expect(Object.keys(await drive.attempts())).toEqual([String(actionId)]);

    expect(await drive.apply(actionId)).toBeNull();
    expect(movesOf("doc-1")).toHaveLength(1);
    expect(parentsOf("doc-1")).toEqual(["inner"]);
    expect(await drive.attempts()).toEqual({});
  });
});

describe("copies", () => {
  const COPY_OF = (...subresources: string[]) => ({ title: "Check Google Drive copy", subresources });
  const READ = (...subresources: string[]) => ({ title: "Read Google Drive metadata", subresources });
  /** The entries of every page a listing yielded. */
  const listed = (value: unknown) => (value as DriveEntry[][]).flat().map(entry => entry.id);
  const report = () => file("application/pdf", [ROOT], { name: "Report.pdf", content: "hello copy" });

  it("shows an ordinary copy in the folder it goes into while it waits, then makes it once", async () => {
    provider.files.set("report", report());
    let drive = binding(FOLDER);

    let queued = await drive.queued("copyFile", "report", { folderId: "inner" });

    let pending = {
      id: "copy-1", name: "Copy of Report.pdf", mimeType: "application/pdf", isFolder: false,
      modifiedTime: expect.any(Date), size: 10, parentId: "inner", pending: true,
    };
    expect(queued.value).toEqual(pending);
    expect(queued.action).toMatchObject({
      title: "Copy a Google Drive file",
      description: "Copy Google Drive file `report` into folder `inner`, as the connected " +
        `account.\n\n${COPY_SHARING}`,
      actionKind: COPIES, autoApprovable: true, implementsRevert: false,
      descriptionIsComplete: true,
    });
    expect(queued.action).not.toHaveProperty("awaitDecision");
    expect(field(queued.action, "Copy name")).toBe("Copy of Report.pdf");
    expect(queued.reports)
      .toEqual([COPY_OF("drive/folder/folder-root", "drive/file/report", "drive/folder/inner")]);

    // Shown in the session of its folder, reporting the file it is a copy of.
    let shown = await drive.callIn(["inner"], "getEntry", "copy-1");
    expect(shown.value).toEqual(pending);
    expect(shown.reports.at(-1)).toEqual(READ("drive/folder/inner", "drive/file/report"));
    let listing = await drive.callIn(["inner"], "list");
    expect(listed(listing.value)).toEqual(["nested-doc", "copy-1"]);
    expect(listing.reports.at(-1)?.subresources)
      .toEqual(["drive/folder/inner", "drive/file/nested-doc", "drive/file/report"]);
    // Nowhere else, and no other call takes it yet.
    expect((await drive.call("getEntry", "copy-1")).error).toBe(OUTSIDE);
    expect(listed((await drive.call("list")).value)).not.toContain("copy-1");
    expect((await drive.callIn(["inner"], "share", "copy-1", BOB, "reader")).error)
      .toBe(COPY_WAITING);
    expect((await drive.callIn(["inner"], "listComments", "copy-1")).error).toBe(COPY_WAITING);
    expect(provider.writes).toEqual([]);

    expect(await drive.apply(queued.actionId)).toBeNull();
    expect(sent("POST /drive/v3/files/report/copy").map(({ body }) => body))
      .toEqual([{ id: "copy-1", name: "Copy of Report.pdf", parents: ["inner"] }]);
    let made = await drive.callIn(["inner"], "getEntry", "copy-1");
    expect(made.value).toMatchObject({ id: "copy-1", parentId: "inner" });
    expect(made.value).not.toHaveProperty("pending");
    expect(listed((await drive.callIn(["inner"], "list")).value)).toEqual(["nested-doc", "copy-1"]);
  });

  it("reads a waiting copy as the file it is a copy of", async () => {
    provider.files.set("report", report());
    let drive = binding(FOLDER);

    let queued = await drive.queued("copyFile", "report", { name: "Report (2).pdf" });

    expect(queued.value).toMatchObject({ id: "copy-1", name: "Report (2).pdf", parentId: ROOT });
    // Into the positioned folder, which the folder's report already covers.
    expect(queued.reports).toEqual([COPY_OF("drive/folder/folder-root", "drive/file/report")]);
    let read = await drive.call("readFile", "copy-1");
    expect(read.value).toMatchObject({ mimeType: "application/pdf", size: 10, text: "hello copy" });
    expect(read.reports.flatMap(({ subresources }) => subresources ?? []))
      .toContain("drive/file/report");
  });

  it("shows a native copy as pending:<n>, which names the copy once it is made", async () => {
    let drive = binding();

    let queued = await drive.queued("copyFile", "doc-1", { folderId: "elsewhere" });

    let id = `pending:${queued.actionId}`;
    expect(queued.value).toEqual({
      id, name: "Copy of doc-1", mimeType: DOC_MIME, isFolder: false,
      modifiedTime: expect.any(Date), parentId: "elsewhere", pending: true,
    });
    expect(queued.action).toMatchObject({ actionKind: COPIES, autoApprovable: true, awaitDecision: true });
    expect(queued.reports).toEqual([COPY_OF("drive/file/doc-1", "drive/folder/elsewhere")]);
    expect((await drive.call("getEntry", id)).value).toEqual(queued.value);
    expect((await drive.call("listComments", id)).error).toBe(COPY_WAITING);
    expect((await drive.call("readFile", id)).error).toBe(COPY_WAITING);

    expect(await drive.apply(queued.actionId)).toBeNull();
    expect(sent("POST /drive/v3/files/doc-1/copy").map(({ body }) => body)).toEqual([{
      name: "Copy of doc-1", parents: ["elsewhere"],
      appProperties: {
        gadgetsCopyToken: expect.stringMatching(/^[0-9a-f]{32}$/),
        gadgetsConvertedFrom: null, gadgetsSourceModified: null, gadgetsUploadToken: null,
        gadgetsSaved: null,
      },
    }]);
    expect(parentsOf("native-1")).toEqual(["elsewhere"]);

    // The made copy is recorded where a later activation reads it.
    await drive.restart();
    let again = binding(ACCOUNT, "write", drive.facet);
    let made = await again.call("getEntry", id);
    expect(made.value).toMatchObject({ id: "native-1", mimeType: DOC_MIME, parentId: "elsewhere" });
    expect(made.value).not.toHaveProperty("pending");

    // A copy the user rejects before it is sent is never made, and its ID names nothing.
    let rejected = await again.queued("copyFile", "doc-1");
    expect(await again.reject(rejected.actionId)).toBeNull();
    expect((await again.call("getEntry", `pending:${rejected.actionId}`)).error).toBe(NAMES_NO_COPY);
    expect((await again.call("getEntry", "pending:999")).error).toBe(NAMES_NO_COPY);
  });

  it("names no waiting native copy once the binding cannot write, and still the copy one made", async () => {
    let drive = binding();
    let made = await drive.queued("copyFile", "doc-1", { folderId: "elsewhere" });
    expect(await drive.apply(made.actionId)).toBeNull();
    let waiting = await drive.queued("copyFile", "doc-1", { folderId: "elsewhere" });

    // A deployment that keeps Drive read-only shows nothing queued as if made.
    await drive.restart();
    let capped = binding(ACCOUNT, "write", drive.facet, "read");
    let refused = await capped.call("getEntry", `pending:${waiting.actionId}`);
    expect(refused.error).toBe(NAMES_NO_COPY);
    expect(refused.reports).toEqual([]);
    expect((await capped.call("getEntry", `pending:${made.actionId}`)).value)
      .toMatchObject({ id: "native-1", parentId: "elsewhere" });
  });

  it("finds a lost ordinary copy by its ID at the next approval, and never sends a native one twice", async () => {
    provider.files.set("report", report());
    let drive = binding();

    // An approval sends a copy once; the next one finds it made under the reserved ID.
    let ordinary = await drive.queued("copyFile", "report", { folderId: "elsewhere" });
    provider.nextWrite = "lost";
    expect(await drive.apply(ordinary.actionId)).toBe(UNCONFIRMED_COPY);
    expect(await drive.apply(ordinary.actionId)).toBeNull();
    expect(sent("POST /drive/v3/files/report/copy").map(({ body }) => body.id)).toEqual(["copy-1"]);
    expect([...provider.files.keys()].filter(id => id.startsWith("copy-"))).toEqual(["copy-1"]);

    let native = await drive.queued("copyFile", "doc-1", { folderId: "elsewhere" });
    provider.nextWrite = "lost";
    provider.searchLags = true;
    expect(await drive.apply(native.actionId)).toBe(UNCONFIRMED_NATIVE_COPY);
    expect(await drive.apply(native.actionId)).toBe(UNCONFIRMED_NATIVE_COPY);
    provider.searchLags = false;
    expect(await drive.apply(native.actionId)).toBeNull();
    expect(sent("POST /drive/v3/files/doc-1/copy")).toHaveLength(1);
    expect((await drive.call("getEntry", `pending:${native.actionId}`)).value)
      .toMatchObject({ id: "native-1" });
    expect(await drive.waiting()).toEqual([]);
  });

  it("reports the folder a waiting copy goes into, with the file it copies, before showing it", async () => {
    provider.files.set("report", report());
    let drive = binding();

    await drive.queued("copyFile", "report", { folderId: "elsewhere" });
    let native = await drive.queued("copyFile", "doc-1", { folderId: "elsewhere" });
    let intoRoot = await drive.queued("copyFile", "report", { folderId: "root" });

    let shown = await drive.call("getEntry", "copy-1");
    expect(shown.value).toMatchObject({ id: "copy-1", parentId: "elsewhere", pending: true });
    expect(shown.reports).toEqual([READ("drive/file/report", "drive/folder/elsewhere")]);
    expect((await drive.call("getEntry", `pending:${native.actionId}`)).reports)
      .toEqual([READ("drive/file/doc-1", "drive/folder/elsewhere")]);
    // A listing that shows the copy reports that folder on the page that shows it.
    let listing = await drive.call("list", { directParentId: "elsewhere" });
    expect(listed(listing.value)).toContain("copy-1");
    expect(listing.reports.at(-1)?.subresources).toContain("drive/folder/elsewhere");
    // As a listing of that folder reports it: a read of the account's own My Drive root is no
    // exception, and neither is the copy's own call.
    expect((await drive.call("getEntry", "copy-2")).reports)
      .toEqual([READ("drive/file/report", "drive/folder/my-root")]);
    expect(intoRoot.reports).toEqual([COPY_OF("drive/file/report", "drive/folder/my-root")]);

    // Its content too: the folder is reported before anything of the file is read.
    let read = await drive.call("readFile", "copy-1");
    expect(read.value).toMatchObject({ text: "hello copy" });
    expect(read.reports[0]).toEqual(READ("drive/file/report", "drive/folder/elsewhere"));
  });

  /**
   * Runs `during` once `stall` holds its request, and releases it once `during` has settled:
   * failing if `during` cannot settle while Drive has not answered.
   */
  async function settlesWhile<T>(stall: { reached: boolean; released: boolean }, during: () => Promise<T>) {
    await vi.waitFor(() => expect(stall.reached).toBe(true));
    let settled = false;
    let running = during();
    running.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
    } finally {
      stall.released = true;
    }
    return running;
  }

  it("approves a change while a listing of a folder no copy goes into waits on Drive", async () => {
    provider.files.set("report", report());
    let drive = binding();
    let queued = await drive.queued("copyFile", "report", { folderId: "root" });
    let stall = provider.stallNext("listing");

    let listing = drive.call("list", { directParentId: "elsewhere" });

    expect(await settlesWhile(stall, () => drive.apply(queued.actionId))).toBeNull();
    expect(listed((await listing).value)).toEqual([]);
  });

  it("shows a copy approved while its folder's page is fetched once, as made", async () => {
    provider.files.set("report", report());
    let drive = binding();
    let queued = await drive.queued("copyFile", "report", { folderId: "elsewhere" });
    let stall = provider.stallNext("listing");

    // Drive has read the folder's files, so the page it answers holds no copy.
    let listing = drive.call("list", { directParentId: "elsewhere" });

    expect(await settlesWhile(stall, () => drive.apply(queued.actionId))).toBeNull();
    let shown = (await listing).value;
    expect(listed(shown)).toEqual(["copy-1"]);
    expect(shown).toEqual([[expect.not.objectContaining({ pending: true })]]);
  });

  it("lists a copy Drive made under its reserved ID while the action waits once, as Drive's", async () => {
    provider.files.set("report", report());
    let drive = binding();
    let queued = await drive.queued("copyFile", "report", { folderId: "elsewhere" });
    // Drive makes the copy and loses the answer, so the action still waits.
    provider.nextWrite = "lost";
    expect(await drive.apply(queued.actionId)).toBe(UNCONFIRMED_COPY);
    provider.files.set("later", file(DOC_MIME, ["elsewhere"]));
    // The copy is on the first page, and the copies that wait show on the last.
    provider.listingPageSize = 1;

    let listing = await drive.call("list", { directParentId: "elsewhere" });

    expect(listed(listing.value)).toEqual(["copy-1", "later"]);
    expect(listing.value).toEqual([[expect.not.objectContaining({ pending: true })], expect.anything()]);
    expect(await drive.waiting()).toEqual([queued.actionId]);
  });

  // Changed or shortened once copied, the file no longer holds what the copy holds: a shortened
  // one fails its own read, which says nothing of the copy.
  it.each([["changed", "edited rpt"], ["shortened", "short"]])(
    "reads a copy approved while the file it copies opens, then %s, from the copy made",
    async (_, content) => {
      provider.files.set("report", report());
      let drive = binding();
      let queued = await drive.queued("copyFile", "report", { folderId: "elsewhere" });
      let stall = provider.stallNext("download");

      let reading = drive.call("readFile", "copy-1");

      expect(await settlesWhile(stall, async () => {
        let outcome = await drive.apply(queued.actionId);
        provider.files.get("report")!.content = content;
        return outcome;
      })).toBeNull();
      expect((await reading).value).toMatchObject({ text: "hello copy" });
    });

  it("stops showing a waiting copy on a folder binding once the file it copies leaves", async () => {
    provider.files.set("report", report());
    let drive = binding(FOLDER);
    // One crosses into a child folder, one stays beside the file.
    await drive.queued("copyFile", "report", { folderId: "inner" });
    await drive.queued("copyFile", "report");
    let source = provider.files.get("report");
    if (!source) throw new Error("no report");

    source.parents = ["elsewhere"];
    expect((await drive.callIn(["inner"], "getEntry", "copy-1")).error).toBe(OUTSIDE);
    expect((await drive.call("getEntry", "copy-2")).error).toBe(OUTSIDE);
    expect(listed((await drive.callIn(["inner"], "list")).value)).toEqual(["nested-doc"]);
    expect(listed((await drive.call("list")).value)).not.toContain("copy-2");

    // Back where it was queued from, it is shown again.
    source.parents = [ROOT];
    expect((await drive.callIn(["inner"], "getEntry", "copy-1")).value)
      .toMatchObject({ id: "copy-1", pending: true });
    expect(listed((await drive.call("list")).value)).toContain("copy-2");
  });

  // The binding can no longer make the copy in a folder that left its tree, which a shortcut in it
  // still reaches: that session is read-only, and shows the folder as Drive does.
  it("shows no waiting copy in a folder reached through a shortcut, and reads its ID from Drive", async () => {
    provider.files.set("report", report());
    let drive = binding(FOLDER);
    let queued = await drive.queued("copyFile", "report", { folderId: "inner" });
    let inner = provider.files.get("inner")!;
    provider.files.set("to-inner", file(SHORTCUT_MIME, [ROOT], { shortcutTargetId: "inner" }));
    inner.parents = ["elsewhere"];

    expect((await drive.callIn(["inner"], "getScope")).value)
      .toMatchObject({ folderId: "inner", access: "read" });
    expect(listed((await drive.callIn(["inner"], "list")).value)).toEqual(["nested-doc"]);
    expect((await drive.callIn(["inner"], "getEntry", "copy-1")).error).toBe(OUTSIDE);

    // Drive makes the copy while the folder is in the tree, and loses the answer.
    inner.parents = [ROOT];
    provider.nextWrite = "lost";
    expect(await drive.apply(queued.actionId)).toBe(UNCONFIRMED_COPY);
    inner.parents = ["elsewhere"];
    let made = await drive.callIn(["inner"], "getEntry", "copy-1");
    expect(made.value).toMatchObject({ id: "copy-1", parentId: "inner" });
    expect(made.value).not.toHaveProperty("pending");
    expect(await drive.waiting()).toEqual([queued.actionId]);
  });

  it("makes a native copy without the markers and tokens this app set on the file", async () => {
    let doc = provider.files.get("doc-1");
    if (!doc) throw new Error("no doc-1");
    doc.appProperties = {
      gadgetsConvertedFrom: "office", gadgetsSourceModified: "2024-01-01T00:00:00.000Z",
      gadgetsUploadToken: "0123456789abcdef0123456789abcdef", gadgetsSaved: "1", kept: "yes",
    };
    let drive = binding();

    let queued = await drive.queued("copyFile", "doc-1", { folderId: "elsewhere" });
    expect(await drive.apply(queued.actionId)).toBeNull();

    expect(provider.files.get("native-1")?.appProperties).toEqual({
      kept: "yes", gadgetsCopyToken: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("settles a native copy whose answer was lost by its token, even once it is in the trash", async () => {
    let drive = binding();

    let queued = await drive.queued("copyFile", "doc-1", { folderId: "elsewhere" });
    provider.nextWrite = "lost";
    expect(await drive.apply(queued.actionId)).toBe(UNCONFIRMED_NATIVE_COPY);
    let made = provider.files.get("native-1");
    if (!made) throw new Error("no copy");
    made.trashed = true;

    expect(await drive.apply(queued.actionId)).toBeNull();
    expect(sent("POST /drive/v3/files/doc-1/copy")).toHaveLength(1);
    expect(await drive.waiting()).toEqual([]);
    // Its pending ID names that file, which reads then take as any file in the trash.
    expect((await drive.call("getEntry", `pending:${queued.actionId}`)).value)
      .toEqual((await drive.call("getEntry", "native-1")).value);
  });

  it("finds a native copy whose answer was lost in the shared drive its folder moved to", async () => {
    provider.files.set("shared", file(FOLDER_MIME, ["drive-a"], { driveId: "drive-a" }));
    let drive = binding();
    let queued = await drive.queued("copyFile", "doc-1", { folderId: "shared" });
    expect(queued.value).toMatchObject({ parentId: "shared", driveId: "drive-a" });

    // A manager moves the folder to another shared drive before the copy is approved.
    let folder = provider.files.get("shared");
    if (!folder) throw new Error("no folder");
    folder.driveId = "drive-b";
    provider.nextWrite = "lost";
    expect(await drive.apply(queued.actionId)).toBe(UNCONFIRMED_NATIVE_COPY);
    expect(provider.files.get("native-1")?.driveId).toBe("drive-b");

    expect(await drive.apply(queued.actionId)).toBeNull();
    expect(sent("POST /drive/v3/files/doc-1/copy")).toHaveLength(1);
    expect((await drive.call("getEntry", `pending:${queued.actionId}`)).value)
      .toMatchObject({ id: "native-1", parentId: "shared" });
  });

  it("refuses a copy this binding cannot make, queueing nothing", async () => {
    provider.files.set("locked", file("application/pdf", [ROOT], { canCopy: false }));
    let folder = binding(FOLDER);

    let refused = [
      [await folder.call("copyFile", "doc-1", { folderId: "elsewhere" }), COPY_FOLDER_DESTINATION],
      [await folder.call("copyFile", "inner"), COPY_FOLDER],
      [await folder.call("copyFile", "locked"), "The connected account cannot copy Drive file locked."],
      [await folder.call("copyFile", "doc-1", { convertTo: "spreadsheet" }),
        "Only an .xlsx, .xls, .xlsm or .ods file converts to a Google Sheet."],
      [await binding(DOC_FILE).call("copyFile", "doc-1"), COPY_SINGLE_FILE],
      [await binding(ACCOUNT, null).call("copyFile", "doc-1"), READ_ONLY_ACCOUNT],
    ] as const;

    for (let [outcome, message] of refused) {
      expect(outcome.error).toBe(message);
      expect(outcome.actionId).toBeUndefined();
    }
    expect(await folder.waiting()).toEqual([]);
    expect(provider.writes).toEqual([]);
  });

  it("waits for a move of the file or of the destination in a folder binding", async () => {
    let drive = binding(FOLDER);
    await drive.queued("move", "doc-1", "inner");
    expect((await drive.call("copyFile", "doc-1")).error).toBe(MOVE_WAITING);
    await drive.queued("move", "archive", "inner");
    expect((await drive.call("copyFile", "sheet-1", { folderId: "archive" })).error)
      .toBe(MOVE_DESTINATION_WAITING);
    expect((await drive.call("copyFile", "sheet-1")).error).toBeUndefined();
  });

  it("offers a single-file binding no copies for auto-approval", async () => {
    expect(await binding(DOC_FILE).autoApprovable()).not.toContainEqual(COPIES);
    expect(await binding(FOLDER).autoApprovable()).toContainEqual(COPIES);
  });
});

describe("uploads", () => {
  const UPLOADS = { tag: "driveUploads", label: "Drive uploads" };
  const EXPORT_COPIES = { tag: "driveExportCopies", label: "Drive exported copies" };
  const UPLOAD_OF = (...subresources: string[]) =>
    ({ title: "Check Google Drive upload", subresources });
  const READ = (...subresources: string[]) => ({ title: "Read Google Drive metadata", subresources });
  const READ_FILE = (...subresources: string[]) => ({ title: "Read file from Google Drive", subresources });
  const UPLOAD_SHARING =
    "The file takes the sharing of the folder it goes into: everyone with access to that folder " +
    "can open it.";
  const NAME_TAKEN =
    "A file of that name is already in that folder. Choose another name, or pass overwrite: true " +
    "to replace that file's content.";
  const NAME_WAITING =
    "A copy or an upload of that name is already waiting for approval to go into that folder, " +
    "and overwrite replaces only a file that is there. Choose another name, or upload it once " +
    "that one is decided.";
  const NAME_TAKEN_SINCE =
    "A file of that name has since appeared in that folder, so nothing was uploaded. Upload it " +
    "again under another name, or with overwrite: true to replace that file.";
  const UNCONFIRMED_UPLOAD =
    "Google Drive did not confirm whether this file was uploaded, and it may have been. " +
    "Approving it again first checks for it, so it is not uploaded twice; rejecting it leaves " +
    "any file that was made.";
  const UNCONFIRMED_CONVERTED =
    "Google Drive did not confirm whether this file was uploaded, and it may have been: Google " +
    "Drive can take a while to show a new file. It won't be sent again. Approving it again looks " +
    "for the file once more; rejecting it leaves any file that was made.";
  const UNCONFIRMED_REPLACE =
    "Google Drive did not confirm whether the file's content was replaced, and it may have " +
    "been. Approving it again first reads the file's content checksum, so it is not replaced " +
    "twice.";
  const CHANGED_SINCE_QUEUED =
    "That file changed since this was queued, so it was not replaced: approving it would have " +
    "discarded that change from the file's current content. Upload it again to replace the file " +
    "as it is now.";
  const PIN_REFUSED =
    "Google Drive refused to keep the file's current version for good, so it was not replaced. " +
    "Drive keeps at most 200 versions of a file for good: in the file's version history, stop " +
    "keeping one, then upload it again.";
  const NO_CHECKSUM =
    "Google Drive reports no content checksum for the file of that name in that folder, so its " +
    "content cannot be replaced here. Upload it under another name.";
  const FILE_WAITING =
    "That file is a copy or an upload still waiting to be made, so this cannot be done with it " +
    "yet. It is made once it is approved, which an auto-approval rule may do in moments: call " +
    "getEntry() with this ID later to see whether it has been made.";
  const EMPTY_CONVERSION =
    "An empty file cannot be converted. Leave out convertTo, or upload content.";
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const ALLOCATIONS = "driveUploads:allocation:";
  const TOTAL = `${ALLOCATIONS}totalBytes`;
  /** The entries of every page a listing yielded. */
  const listed = (value: unknown) => (value as DriveEntry[][]).flat().map(entry => entry.id);
  /** The uploads Drive finished into a file, as the bytes it took. */
  const uploadedTo = (fileId: string) =>
    provider.uploads.filter(upload => upload.fileId === fileId).map(({ content }) => content);
  /** The upload sessions the gatekeeper opened. */
  const sessions = () => provider.calls().filter(call => call.startsWith("POST /upload/") ||
    call.startsWith("PATCH /upload/"));

  async function sha256(text: string): Promise<string> {
    let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  /** A stream giving `pieces`, one at a time. */
  function streamOf(...pieces: string[]): ReadableStream<Uint8Array> {
    let encoder = new TextEncoder();
    return new ReadableStream({
      pull(controller) {
        let piece = pieces.shift();
        if (piece === undefined) controller.close();
        else controller.enqueue(encoder.encode(piece));
      },
    });
  }

  /** What a test reads and writes of a binding's storage. */
  type Storage = {
    storedKeys(prefix: string): Promise<string[]>;
    stored(key: string): Promise<string | null>;
    store(key: string, json: string): Promise<void>;
  };

  /** The handles of the uploads' bytes `drive` holds, in key order. */
  async function heldBytes(drive: Storage): Promise<string[]> {
    return (await drive.storedKeys(ALLOCATIONS)).filter(key => key !== TOTAL)
      .map(key => key.slice(ALLOCATIONS.length));
  }

  /** Dates the allocation of the bytes under `handle` to the epoch, long past any grace. */
  async function age(drive: Storage, handle: string): Promise<void> {
    let key = `${ALLOCATIONS}${handle}`;
    let stored = await drive.stored(key);
    if (stored === null) throw new Error(`no allocation ${handle}`);
    await drive.store(key, JSON.stringify({ ...JSON.parse(stored), createdAt: 0 }));
  }

  /** Stores an allocation old enough for a sweep that no upload holds, as a failed capture leaves. */
  async function orphan(drive: Storage): Promise<void> {
    await drive.store(`${ALLOCATIONS}${crypto.randomUUID()}`,
      JSON.stringify({ version: 1, size: 0, chunks: 0, createdAt: 0 }));
  }

  /** A binary file of `content` in folder `elsewhere`, at revision `rev-old`. */
  async function binary(name: string, content: string, overrides: Partial<FakeFile> = {}) {
    return file("text/plain", ["elsewhere"], {
      name, content, headRevisionId: "rev-old", sha256Checksum: await sha256(content), ...overrides,
    });
  }

  it("uploads a file under the ID it reserved once approved, from the bytes it kept, then lets them go", async () => {
    let drive = binding();

    let queued = await drive.queued("uploadFile", "notes.txt", "hello upload", { folderId: "elsewhere" });

    let pending = {
      id: "copy-1", name: "notes.txt", mimeType: "text/plain", isFolder: false,
      modifiedTime: expect.any(Date), size: 12, parentId: "elsewhere", pending: true,
    };
    expect(queued.value).toEqual(pending);
    expect(queued.action).toMatchObject({
      title: "Upload a file to Google Drive",
      description: "Upload a file into Google Drive folder `elsewhere`, as the connected " +
        `account.\n\n${UPLOAD_SHARING}`,
      actionKind: UPLOADS, autoApprovable: true, implementsRevert: false,
    });
    expect(queued.action).not.toHaveProperty("awaitDecision");
    // The bytes are the workspace's own, which the approver sees only as the file.
    expect(queued.action).not.toHaveProperty("descriptionIsComplete");
    expect(queued.action.fields).toContainEqual({
      label: "File", kind: "file", name: "notes.txt", mediaType: "text/plain", size: 12,
      sha256: await sha256("hello upload"), origin: "agent",
    });
    expect(queued.reports).toEqual([UPLOAD_OF("drive/file/elsewhere", "drive/folder/elsewhere")]);
    // Shown where it goes, while Google has nothing of it.
    expect((await drive.call("getEntry", "copy-1")).value).toEqual(pending);
    expect(listed((await drive.call("list", { directParentId: "elsewhere" })).value))
      .toContain("copy-1");
    expect((await drive.call("listComments", "copy-1")).error).toBe(FILE_WAITING);
    expect(provider.uploads).toEqual([]);
    expect(await heldBytes(drive)).toHaveLength(1);

    expect(await drive.apply(queued.actionId)).toBeNull();
    expect(provider.uploads).toEqual([{
      fileId: "copy-1", metadata: { id: "copy-1", name: "notes.txt", parents: ["elsewhere"] },
      contentType: "text/plain", content: "hello upload",
    }]);
    expect(await heldBytes(drive)).toEqual([]);
    expect(await drive.storedKeys("driveUploads:file:")).toEqual([]);
    expect(await drive.stored(TOTAL)).toBe("0");
    let made = await drive.call("getEntry", "copy-1");
    expect(made.value).toMatchObject({ id: "copy-1", parentId: "elsewhere", size: 12 });
    expect(made.value).not.toHaveProperty("pending");
  });

  it("keeps a stream's and a Uint8Array's bytes as given, and reads a range of them while the upload waits", async () => {
    let drive = binding();

    let streamed = await drive.queued("uploadFile", "log.md", streamOf("# Log\n", "line one\n", "line two\n"),
      { folderId: "elsewhere" });
    expect(streamed.value).toMatchObject({ id: "copy-1", mimeType: "text/markdown", size: 24 });
    let bytes = await drive.queued("uploadFile", "blob", new TextEncoder().encode("0123456789abcdef"),
      { folderId: "root" });
    expect(bytes.value).toMatchObject(
      { id: "copy-2", mimeType: "application/octet-stream", size: 16, parentId: MY_ROOT });

    let read = await drive.call("readFile", "copy-1", { offset: 6, length: 8 });
    expect(read.value).toEqual({
      mimeType: "text/markdown", size: 24, modifiedTime: expect.any(Date), offset: 6, length: 8,
      text: "line one",
    });
    // The bytes are the workspace's own: only the folder the view places them in is reported.
    expect(read.reports).toEqual([READ_FILE("drive/folder/elsewhere")]);
    expect((await drive.call("readFile", "copy-2", { offset: 10 })).value)
      .toMatchObject({ offset: 10, length: 6, text: "abcdef" });
    expect((await drive.call("readFile", "copy-2", { offset: 10 })).reports)
      .toEqual([READ_FILE("drive/folder/my-root")]);
    expect((await drive.call("readFile", "copy-2", { offset: 17 })).error)
      .toBe("offset 17 is past the end of the Drive file, which is 16 bytes long.");

    expect(await drive.apply(streamed.actionId)).toBeNull();
    expect(await drive.apply(bytes.actionId)).toBeNull();
    expect(uploadedTo("copy-1")).toEqual(["# Log\nline one\nline two\n"]);
    expect(uploadedTo("copy-2")).toEqual(["0123456789abcdef"]);
    expect(parentsOf("copy-2")).toEqual([MY_ROOT]);
  });

  it("shows an upload on a folder binding only in the session of the folder it goes into", async () => {
    let drive = binding(FOLDER);

    let here = await drive.queued("uploadFile", "here.txt", "in the folder");
    expect(here.value).toMatchObject({ id: "copy-1", parentId: ROOT, pending: true });
    expect(here.reports).toEqual([UPLOAD_OF("drive/folder/folder-root")]);
    let inner = await drive.queued("uploadFile", "inner.txt", "in a child", { folderId: "inner" });
    expect(inner.reports).toEqual(
      [UPLOAD_OF("drive/folder/folder-root", "drive/file/inner", "drive/folder/inner")]);

    let read = await drive.call("readFile", "copy-1");
    expect(read.value).toMatchObject({ text: "in the folder" });
    expect(read.reports).toEqual([READ_FILE("drive/folder/folder-root")]);
    expect(listed((await drive.call("list")).value)).toContain("copy-1");
    expect((await drive.call("getEntry", "copy-2")).error).toBe(OUTSIDE);
    // Nor does a range past its end, whose refusal would tell its size.
    expect((await drive.call("readFile", "copy-2", { offset: 999 })).error).toBe(OUTSIDE);
    let shown = await drive.callIn(["inner"], "getEntry", "copy-2");
    expect(shown.value).toMatchObject({ id: "copy-2", parentId: "inner", pending: true });
    expect(shown.reports.at(-1)).toEqual(READ("drive/folder/inner"));
    expect(listed((await drive.callIn(["inner"], "list")).value)).toEqual(["nested-doc", "copy-2"]);
  });

  it("refuses a name a file in the folder or a waiting upload has, and checks again when approved", async () => {
    provider.files.set("taken", await binary("taken.txt", "already here"));
    provider.files.set("binned", await binary("binned.txt", "in the trash", { trashed: true }));
    let drive = binding();

    let taken = await drive.call("uploadFile", "taken.txt", "new", { folderId: "elsewhere" });
    expect(taken.error).toBe(NAME_TAKEN);
    expect(taken.actionId).toBeUndefined();
    // A file in the trash takes no name.
    expect((await drive.call("uploadFile", "binned.txt", "new", { folderId: "elsewhere" })).error)
      .toBeUndefined();
    let first = await drive.queued("uploadFile", "late.txt", "mine", { folderId: "elsewhere" });
    for (let overwrite of [false, true]) {
      expect((await drive.call("uploadFile", "late.txt", "again", { folderId: "elsewhere", overwrite }))
        .error).toBe(NAME_WAITING);
    }
    // Another folder takes the same name.
    expect((await drive.call("uploadFile", "late.txt", "again", { folderId: "root" })).error)
      .toBeUndefined();

    // Someone makes a file of that name before the upload is approved.
    provider.files.set("someone", await binary("late.txt", "theirs"));
    expect(await drive.apply(first.actionId)).toBe(NAME_TAKEN_SINCE);
    expect(uploadedTo("copy-2")).toEqual([]);
    expect(await drive.waiting()).not.toContain(first.actionId);
    expect(await heldBytes(drive)).toHaveLength(2);
  });

  it("refuses a name a call queued while this one's stream was being read", async () => {
    let drive = binding();
    let pulled = Promise.withResolvers<void>();
    let release = Promise.withResolvers<void>();
    let content = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulled.resolve();
        await release.promise;
        controller.enqueue(new TextEncoder().encode("first"));
        controller.close();
      },
    }, { highWaterMark: 0 });

    let first = drive.call("uploadFile", "same.txt", content, { folderId: "elsewhere" });
    await pulled.promise;
    let second = await drive.queued("uploadFile", "same.txt", "second", { folderId: "elsewhere" });
    release.resolve();

    expect((await first).error).toBe(NAME_WAITING);
    expect(await drive.waiting()).toEqual([second.actionId]);
    expect(await heldBytes(drive)).toHaveLength(1);
  });

  it("queues one of two calls that upload the same name at once", async () => {
    let drive = binding();
    let answered = globalThis.fetch;
    let bothReserving = Promise.withResolvers<void>();
    let reservations = 0;
    // Each call reserves its ID before it is queued; the first waits until the second reserves.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url.endsWith("/drive/v3/files/generateIds")) {
        if (++reservations === 1) await bothReserving.promise;
        else bothReserving.resolve();
      }
      return answered(input, init);
    });

    let calls = await Promise.all([1, 2].map(n =>
      drive.call("uploadFile", "same.txt", `upload ${n}`, { folderId: "elsewhere" })));

    expect(calls.map(({ error }) => error ?? "queued").toSorted()).toEqual([NAME_WAITING, "queued"]);
    expect(await drive.waiting()).toHaveLength(1);
    expect(await heldBytes(drive)).toHaveLength(1);
  });

  it("keeps nothing of an upload refused after its bytes were kept", async () => {
    provider.maxImportSizes[DOC_MIME] = "4";
    let drive = binding();

    let large = await drive.call("uploadFile", "plan.docx", "more than four bytes",
      { folderId: "elsewhere", convertTo: "document" });
    expect(large.error).toBe(
      "That file is 1 MB, larger than the 1 MB Google Drive converts into this format.");
    let empty = await drive.call("uploadFile", "plan.docx", streamOf(),
      { folderId: "elsewhere", convertTo: "document" });
    expect(empty.error).toBe(EMPTY_CONVERSION);

    expect([large.actionId, empty.actionId]).toEqual([undefined, undefined]);
    expect(await heldBytes(drive)).toEqual([]);
    expect(await drive.storedKeys("driveUploads:file:")).toEqual([]);
    expect(await drive.stored(TOTAL)).toBe("0");
  });

  it("lets a rejected upload's bytes go, and a sweep then keeps those of uploads still waiting", async () => {
    let drive = binding();
    let rejected = await drive.queued("uploadFile", "a.txt", "first", { folderId: "elsewhere" });
    let [first] = await heldBytes(drive);
    let waiting = await drive.queued("uploadFile", "b.txt", "second", { folderId: "elsewhere" });
    let [second] = (await heldBytes(drive)).filter(handle => handle !== first);
    await orphan(drive);
    // All of them old enough for a sweep.
    for (let handle of [first, second]) await age(drive, handle);

    expect(await drive.reject(rejected.actionId)).toBeNull();

    expect(await heldBytes(drive)).toEqual([second]);
    expect(await drive.apply(waiting.actionId)).toBeNull();
    expect(uploadedTo("copy-2")).toEqual(["second"]);
    expect(uploadedTo("copy-1")).toEqual([]);
    expect(await heldBytes(drive)).toEqual([]);
  });

  it("sweeps, as a session starts, bytes no waiting upload holds", async () => {
    let drive = binding();
    await drive.queued("uploadFile", "a.txt", "kept", { folderId: "elsewhere" });
    let [held] = await heldBytes(drive);
    await age(drive, held);
    await orphan(drive);

    await drive.call("getScope");

    expect(await heldBytes(drive)).toEqual([held]);
    expect((await drive.call("readFile", "copy-1")).value).toMatchObject({ text: "kept" });
  });

  it("reads an upload an approval made after a read picked it, before the read opened its bytes, as Drive has it", async () => {
    let drive = binding();
    let queued = await drive.queued("uploadFile", "notes.txt", "kept", { folderId: "elsewhere" });
    let applied: string | null | undefined;

    let read = await drive.readHeld("copy-1", async () => {
      applied = await drive.apply(queued.actionId);
    });

    expect(applied).toBeNull();
    expect(await drive.storedKeys("driveUploads:file:")).toEqual([]);
    expect(read).toEqual({ text: "kept" });
  });

  // A read of no bytes opens none, and must still find the upload gone.
  it.each([
    ["an upload", "kept", {}],
    ["an empty upload", "", {}],
    ["an upload at its end", "kept", { offset: 4 }],
  ])("refuses a read of %s a rejection dropped after the read picked it, as for any file Drive does not have", async (_, text, options) => {
    let drive = binding();
    let queued = await drive.queued("uploadFile", "notes.txt", text, { folderId: "elsewhere" });

    let read = await drive.readHeld("copy-1", async () => {
      await drive.reject(queued.actionId);
    }, options);

    let unknown = await drive.call("readFile", "copy-1", options);
    expect(unknown.error).toBeDefined();
    expect(read).toEqual({ error: unknown.error });
  });

  it("keeps the bytes a read of a waiting upload has begun until the read ends, though the upload is approved meanwhile", async () => {
    let drive = binding();
    // Four of the 1 MB chunks the bytes are kept in, and a fifth, read one at a time.
    let content = "0123456789abcdef".repeat(1 << 18) + "end";
    let queued = await drive.queued("uploadFile", "big.txt", content, { folderId: "elsewhere" });
    let applied: string | null | undefined;

    let read = await drive.readAcross("copy-1", async () => {
      applied = await drive.apply(queued.actionId);
    });

    expect(applied).toBeNull();
    expect(read.before).toBeGreaterThan(0);
    expect(read.before).toBeLessThan(content.length);
    expect(read.error).toBeUndefined();
    expect(read.text === content).toBe(true);
    expect(uploadedTo("copy-1").map(text => text === content)).toEqual([true]);
    expect(await heldBytes(drive)).toEqual([]);
    expect(await drive.storedKeys("driveUploads:file:")).toEqual([]);
  });

  it("finds a file a lost reply made under its reserved ID, and never uploads it twice", async () => {
    let drive = binding();

    let queued = await drive.queued("uploadFile", "notes.txt", "hello", { folderId: "elsewhere" });
    provider.nextUpload = "lost";
    expect(await drive.apply(queued.actionId)).toBe(UNCONFIRMED_UPLOAD);
    expect(await drive.waiting()).toEqual([queued.actionId]);
    // Still held, so that the next approval can send them should the look find nothing.
    expect(await heldBytes(drive)).toHaveLength(1);
    expect(await drive.apply(queued.actionId)).toBeNull();
    expect(sessions()).toHaveLength(1);
    expect(uploadedTo("copy-1")).toEqual(["hello"]);
    expect(await heldBytes(drive)).toEqual([]);

    // Deleted for good once made, the file is gone; Drive still refuses its ID to a new one.
    let again = await drive.queued("uploadFile", "gone.txt", "briefly", { folderId: "elsewhere" });
    provider.nextUpload = "lost";
    expect(await drive.apply(again.actionId)).toBe(UNCONFIRMED_UPLOAD);
    provider.files.delete("copy-2");
    expect(await drive.apply(again.actionId)).toBeNull();
    expect(uploadedTo("copy-2")).toEqual(["briefly"]);
    expect(provider.files.has("copy-2")).toBe(false);
    expect(await drive.waiting()).toEqual([]);
  });

  it("lists a file an upload made under its reserved ID while the action waits once, as Drive's", async () => {
    let drive = binding();
    let queued = await drive.queued("uploadFile", "notes.txt", "hello", { folderId: "elsewhere" });
    // Drive makes the file and loses the answer, so the action still waits.
    provider.nextUpload = "lost";
    expect(await drive.apply(queued.actionId)).toBe(UNCONFIRMED_UPLOAD);
    provider.files.set("later", file(DOC_MIME, ["elsewhere"]));
    // The file is on the first page, and the uploads that wait show on the last.
    provider.listingPageSize = 1;

    let listing = await drive.call("list", { directParentId: "elsewhere" });

    expect(listed(listing.value)).toEqual(["copy-1", "later"]);
    expect(listing.value).toEqual([[expect.not.objectContaining({ pending: true })], expect.anything()]);
    expect(await drive.waiting()).toEqual([queued.actionId]);
  });

  it("replaces a file's content once approved, having kept its current version for good", async () => {
    provider.files.set("report", await binary("report.txt", "old"));
    let drive = binding();

    let queued = await drive.queued("uploadFile", "report.txt", "new content",
      { folderId: "elsewhere", overwrite: true });

    expect(queued.value).toEqual({
      id: "report", name: "report.txt", mimeType: "text/plain", isFolder: false,
      modifiedTime: expect.any(Date), size: 11, parentId: "elsewhere", pending: true,
    });
    expect(queued.action).toMatchObject({
      title: "Replace a Google Drive file's content", actionKind: UPLOADS, autoApprovable: false,
      awaitDecision: true,
    });
    expect(field(queued.action, "Replaces")).toBe("report");
    expect(queued.reports).toEqual(
      [UPLOAD_OF("drive/file/elsewhere", "drive/folder/elsewhere", "drive/file/report")]);
    // Until it is approved, the file reads as it is.
    let before = await drive.call("readFile", "report");
    expect(before.value).toMatchObject({ size: 3, text: "old" });
    expect((await drive.call("getEntry", "report")).value).not.toHaveProperty("pending");

    expect(await drive.apply(queued.actionId)).toBeNull();
    let calls = provider.calls();
    let pinned = calls.indexOf("PATCH /drive/v3/files/report/revisions/rev-old");
    expect(pinned).toBeGreaterThan(-1);
    expect(pinned).toBeLessThan(calls.indexOf("PATCH /upload/drive/v3/files/report"));
    expect(provider.kept).toEqual(["report@rev-old"]);
    expect(uploadedTo("report")).toEqual(["new content"]);
    expect(provider.files.get("report")).toMatchObject(
      { name: "report.txt", parents: ["elsewhere"], content: "new content" });
    expect(await heldBytes(drive)).toEqual([]);
  });

  it("refuses a replacement of a file that changed since, or whose version Drive will not keep", async () => {
    provider.files.set("report", await binary("report.txt", "old"));
    let drive = binding();
    let replace = () => drive.queued("uploadFile", "report.txt", "new",
      { folderId: "elsewhere", overwrite: true });

    let changed = await replace();
    change("report", { content: "edited", headRevisionId: "rev-edited", sha256Checksum: await sha256("edited") });
    expect(await drive.apply(changed.actionId)).toBe(CHANGED_SINCE_QUEUED);

    let refused = await replace();
    provider.nextKeep = { status: 403, reason: "keepForeverLimitReached" };
    expect(await drive.apply(refused.actionId))
      .toBe(`${PIN_REFUSED} [http=403 reason=keepForeverLimitReached]`);

    expect(provider.kept).toEqual([]);
    expect(provider.uploads).toEqual([]);
    expect(provider.files.get("report")?.content).toBe("edited");
    expect(await drive.waiting()).toEqual([]);

    // Drive gives no checksum for a file it cannot tell the content of.
    change("report", { sha256Checksum: undefined });
    expect((await drive.call("uploadFile", "report.txt", "new", { folderId: "elsewhere", overwrite: true }))
      .error).toBe(NO_CHECKSUM);
  });

  it("tells by the content's checksum whether a replacement whose reply was lost was made", async () => {
    provider.files.set("report", await binary("report.txt", "old"));
    let drive = binding();

    let queued = await drive.queued("uploadFile", "report.txt", "new",
      { folderId: "elsewhere", overwrite: true });
    provider.nextUpload = "lost";
    expect(await drive.apply(queued.actionId)).toBe(UNCONFIRMED_REPLACE);
    expect(await drive.apply(queued.actionId)).toBeNull();

    expect(uploadedTo("report")).toEqual(["new"]);
    expect(sessions()).toEqual(["PATCH /upload/drive/v3/files/report"]);
  });

  it("returns a converted upload as pending:<n>, which names the file once it is made", async () => {
    let drive = binding();

    let queued = await drive.queued("uploadFile", "plan.docx", "docx bytes",
      { folderId: "elsewhere", convertTo: "document" });

    let id = `pending:${queued.actionId}`;
    expect(queued.value).toEqual({
      id, name: "plan", mimeType: DOC_MIME, isFolder: false, modifiedTime: expect.any(Date),
      parentId: "elsewhere", pending: true,
    });
    expect(queued.action).toMatchObject({ actionKind: UPLOADS, autoApprovable: true, awaitDecision: true });
    let shown = await drive.call("getEntry", id);
    expect(shown.value).toEqual(queued.value);
    expect(shown.reports).toEqual([READ("drive/folder/elsewhere")]);
    expect((await drive.call("readFile", id)).error).toBe(FILE_WAITING);

    expect(await drive.apply(queued.actionId)).toBeNull();
    expect(provider.uploads).toEqual([{
      fileId: "upload-1", contentType: DOCX, content: "docx bytes",
      metadata: {
        name: "plan", parents: ["elsewhere"], mimeType: DOC_MIME,
        appProperties: { gadgetsUploadToken: expect.stringMatching(/^[0-9a-f]{32}$/) },
      },
    }]);

    await drive.restart();
    let again = binding(ACCOUNT, "write", drive.facet);
    let made = await again.call("getEntry", id);
    expect(made.value).toMatchObject({ id: "upload-1", mimeType: DOC_MIME, parentId: "elsewhere" });
    expect(made.value).not.toHaveProperty("pending");
  });

  it("sends a converted upload again when the gatekeeper restarted before its last chunk went", async () => {
    let drive = binding();
    let upload = await drive.queued("uploadFile", "plan.docx", "docx bytes",
      { folderId: "elsewhere", convertTo: "document" });
    let answered = globalThis.fetch;
    let opening = false;
    // Drive opens no session: the approval waits there until the gatekeeper restarts.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = new Request(input, init);
      if (request.method !== "POST" || !new URL(request.url).pathname.startsWith("/upload/")) {
        return answered(input, init);
      }
      opening = true;
      return new Promise<Response>(() => {});
    });
    let applying = drive.apply(upload.actionId);
    // Polled from the test's own context: a promise the gatekeeper resolved would carry the test
    // into the gatekeeper's context, which the restart ends.
    await vi.waitFor(() => expect(opening).toBe(true));
    expect(await drive.attempts()).toEqual({});
    await drive.restart();
    expect(await applying).not.toBeNull();

    vi.stubGlobal("fetch", answered);
    expect(await drive.apply(upload.actionId)).toBeNull();
    expect(provider.uploads.map(({ fileId }) => fileId)).toEqual(["upload-1"]);
    expect((await drive.call("getEntry", `pending:${upload.actionId}`)).value)
      .toMatchObject({ id: "upload-1" });
  });

  it("finds a converted upload whose reply was lost in the shared drive its folder moved to", async () => {
    provider.files.set("shared", file(FOLDER_MIME, ["drive-a"], { driveId: "drive-a" }));
    let drive = binding();
    let upload = await drive.queued("uploadFile", "plan.docx", "docx bytes",
      { folderId: "shared", convertTo: "document" });

    // A manager moves the folder to another shared drive before the upload is approved.
    let folder = provider.files.get("shared");
    if (!folder) throw new Error("no folder");
    folder.driveId = "drive-b";
    provider.nextUpload = "lost";
    expect(await drive.apply(upload.actionId)).toBe(UNCONFIRMED_CONVERTED);
    expect(provider.files.get("upload-1")?.driveId).toBe("drive-b");

    // Not in the drive the folder was in when it was queued, but among the account's own files.
    expect(await drive.apply(upload.actionId)).toBeNull();
    expect(sessions()).toHaveLength(1);
    expect((await drive.call("getEntry", `pending:${upload.actionId}`)).value)
      .toMatchObject({ id: "upload-1", parentId: "shared" });
  });

  it("settles a converted upload whose reply was lost by its token, not by a copy of the file that carries it", async () => {
    let drive = binding();
    let upload = await drive.queued("uploadFile", "plan.docx", "docx bytes",
      { folderId: "elsewhere", convertTo: "document" });
    provider.nextUpload = "lost";
    expect(await drive.apply(upload.actionId)).toBe(UNCONFIRMED_CONVERTED);

    // The made file is in Drive, where the agent finds it and copies it.
    let copy = await drive.queued("copyFile", "upload-1", { folderId: "elsewhere" });
    expect(await drive.apply(copy.actionId)).toBeNull();

    expect(await drive.apply(upload.actionId)).toBeNull();
    expect(sessions()).toHaveLength(1);
    expect((await drive.call("getEntry", `pending:${upload.actionId}`)).value)
      .toMatchObject({ id: "upload-1" });
    expect((await drive.call("getEntry", `pending:${copy.actionId}`)).value)
      .toMatchObject({ id: "native-1" });
  });

  it("uploads an exported copy's export under the ID it reserved, and reads none of it while it waits", async () => {
    let drive = binding();

    let queued = await drive.queued("copyFile", "doc-1", { folderId: "elsewhere", convertTo: "pdf" });

    expect(queued.value).toEqual({
      id: "copy-1", name: "doc-1.pdf", mimeType: "application/pdf", isFolder: false,
      modifiedTime: expect.any(Date), parentId: "elsewhere", pending: true,
    });
    expect(queued.action).toMatchObject(
      { actionKind: EXPORT_COPIES, autoApprovable: true, descriptionIsComplete: true });
    expect(queued.action).not.toHaveProperty("awaitDecision");
    expect((await drive.call("getEntry", "copy-1")).reports)
      .toEqual([READ("drive/file/doc-1", "drive/folder/elsewhere")]);
    // The refusal names the file it exports, so it is said only once the read is reported.
    let refused = await drive.call("readFile", "copy-1");
    expect(refused.error).toBe(
      "That file is an exported copy still waiting for approval: Google exports the file only " +
      'when the copy is approved. Read the export of the file as it is now with exportFile("doc-1", "pdf").');
    expect(refused.reports).toEqual([READ("drive/file/doc-1", "drive/folder/elsewhere")]);
    expect(provider.calls()).not.toContain("GET /drive/v3/files/doc-1/export");

    expect(await drive.apply(queued.actionId)).toBeNull();
    expect(provider.uploads).toEqual([{
      fileId: "copy-1", metadata: { id: "copy-1", name: "doc-1.pdf", parents: ["elsewhere"] },
      contentType: "application/pdf", content: "doc-1 exported as application/pdf",
    }]);
    expect((await drive.call("readFile", "copy-1")).value)
      .toMatchObject({ text: "doc-1 exported as application/pdf" });
  });

  // The edit is queued before the copy, so Google's export at approval would leave it out.
  it("refuses an exported copy of a file an edit was queued to while the copy reserved its ID", async () => {
    let drive = binding();
    provider.files.set("deck-1", file(SLIDES_MIME, [ROOT], { name: "Deck" }));
    let slides = new SlidesProvider(presentation([
      slide("s1", [shape("t1", text(["Q3 review"]), { placeholder: "TITLE" })]),
    ]), "deck-1");
    let answered = globalThis.fetch;
    let reserving = Promise.withResolvers<void>();
    let reserved = Promise.withResolvers<void>();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = new Request(input, init);
      if (new URL(request.url).pathname === "/drive/v3/files/generateIds") {
        reserving.resolve();
        await reserved.promise;
      }
      return await slides.handle(request) ?? answered(input, init);
    });

    let copying = drive.call("copyFile", "deck-1", { convertTo: "pdf" });
    await reserving.promise;
    let edit = await env.TEST_HOOKS.getByName(drive.facet).callDriveNative(
      drive.facet, { scope: ACCOUNT, access: "write" }, "openGoogleSlides", "deck-1",
      "setSlidesSkipped", [["s1"], true]);
    reserved.resolve();

    expect((await copying).error).toBe(
      "That file has changes waiting for approval, which a copy would leave out: Google Drive " +
      "copies the file as it is on Drive. Copy it once they are decided.");
    // Through stubs of its own: the test runs on in the gatekeeper's context, which answered the
    // reservation, and a stub made before it cannot be used from there.
    expect(await binding(ACCOUNT, "write", drive.facet).waiting()).toEqual([edit.actionId]);
  });

  it("offers a single-file binding neither uploads nor exported copies for auto-approval", async () => {
    let kinds = await binding(DOC_FILE).autoApprovable();
    expect(kinds).not.toContainEqual(UPLOADS);
    expect(kinds).not.toContainEqual(EXPORT_COPIES);
    expect(await binding(FOLDER).autoApprovable()).toEqual(expect.arrayContaining([UPLOADS, EXPORT_COPIES]));
  });
});

describe("no revert", () => {
  it("refuses to revert any kind, and asks Google nothing", async () => {
    provider.give("sheet-1", { ...BOB, role: "reader" });
    provider.give("sheet-1", { ...TEAM, role: "commenter" });
    let drive = binding();
    let applied = [
      await drive.queued("comment", "doc-1", "Hi"),
      await drive.queued("share", "doc-1", BOB, "reader"),
      await drive.queued("updateAccess", "sheet-1", "perm-bob", "writer"),
      await drive.queued("unshare", "sheet-1", "perm-team"),
      await drive.queued("move", "loose-doc", "elsewhere"),
    ].map(({ actionId }) => actionId);
    for (let actionId of applied) expect(await drive.apply(actionId)).toBeNull();
    let state = () => [
      provider.comments.get("doc-1"), provider.direct("doc-1"), provider.direct("sheet-1"),
      provider.files.get("loose-doc")?.parents,
    ];
    let left = state();
    expect(left).toEqual([
      ["Hi"], [["perm-A", "owner"], ["perm-bob", "reader"]],
      [["perm-A", "owner"], ["perm-bob", "writer"]], ["elsewhere"],
    ]);
    provider.forget();

    // An ID that was never queued is answered the same.
    for (let actionId of [...applied, 999]) expect(await drive.revert(actionId)).toBe(NO_REVERT);
    expect(provider.requests).toEqual([]);
    expect(state()).toEqual(left);

    // Nothing of an applied action is kept to act on, and its ID is remembered as applied.
    for (let actionId of applied) expect(await drive.apply(actionId)).toBeNull();
    expect(provider.requests).toEqual([]);
    expect(await drive.waiting()).toEqual([]);
  });
});

describe("a deployment that keeps Drive read-only", () => {
  it("makes a read and write binding read-only in every respect, asking Google nothing", async () => {
    let { id: commentId } = provider.post("doc-1", "First");
    provider.give("doc-1", { ...BOB, role: "reader" });
    let reads = "read native Google Docs, Sheets and Slides and export them with exportFile(), " +
      "read PDFs' text with readPdf() and " +
      "any other file's bytes with readFile()";
    let bindings: [DriveBindingScope, Record<string, string>][] = [
      [ACCOUNT, {
        url: "https://drive.google.com/drive/my-drive",
        title: "Google Drive Account",
        snippet: `Read-only: find files anywhere this Google account can read in Drive, ${reads}, ` +
          "and read comments",
        suggestedBindingName: "GOOGLE_DRIVE",
        tsType: "GoogleDriveReadSession",
      }],
      [FOLDER, {
        url: FOLDER_URL,
        title: "folder-root",
        snippet: "Read-only: list and search direct children, navigate child folders, follow shortcuts " +
          `among them to files and folders elsewhere in Drive for reading, ${reads}, ` +
          "and read comments on direct children in Drive folder \"folder-root\"",
        suggestedBindingName: "GOOGLE_DRIVE_FOLDER",
        tsType: "GoogleDriveFolderReadSession",
      }],
      [DOC_FILE, {
        url: FILE_URL,
        title: "doc-1",
        snippet: "Read-only: read metadata and, when native, Google Doc, Sheet or Slides " +
          "content or with exportFile() an export of it, with readPdf() a PDF's text, or with " +
          "readFile() the bytes of any other " +
          "file, and comments, from Drive file \"doc-1\"",
        suggestedBindingName: "GOOGLE_DRIVE_FILE",
        tsType: "GoogleDriveReadSession",
      }],
    ];
    let writes: [DriveMethod, ...unknown[]][] = [
      ["comment", "doc-1", "Hi"],
      ["suggestEdit", "doc-1", "old", "new"],
      ["reply", "doc-1", commentId, "Hi"],
      ["resolve", "doc-1", commentId],
      ["share", "doc-1", CAROL, "reader"],
      ["updateAccess", "doc-1", "perm-bob", "writer"],
      ["unshare", "doc-1", "perm-bob"],
    ];

    for (let [scope, readOnlyRow] of bindings) {
      // The connection was made read and write, and its account holds the grant.
      let drive = binding(scope, "write", undefined, "read");
      provider.forget();
      for (let [method, ...args] of writes) {
        let refused = await drive.call(method, ...args);

        expect(refused.error, `${scope.kind} ${method}`).toBe(DEPLOYMENT_READ_ONLY);
        expect(refused.actionId).toBeUndefined();
        expect(refused.observations).toEqual([]);
      }
      let listing = await drive.call("listAccess", "doc-1");
      expect(listing.error, scope.kind).toBe(`${LISTING_TAKES_WRITES} ${DEPLOYMENT_READ_ONLY}`);
      expect(listing.observations).toEqual([]);

      // Nothing is put before it on an all-of-Drive binding; a file binding could not move anyway.
      let move = await drive.call("move", "doc-1", "inner");
      expect(move.error, scope.kind)
        .toBe(scope.kind === "file" ? MOVE_SINGLE_FILE : DEPLOYMENT_READ_ONLY);
      expect(move.actionId).toBeUndefined();
      expect(move.observations).toEqual([]);
      expect(provider.requests, scope.kind).toEqual([]);
      expect(await drive.waiting()).toEqual([]);

      expect((await drive.call("getScope")).value, scope.kind).toMatchObject({ access: "read" });
      expect(await drive.autoApprovable(), scope.kind).toEqual([]);
      let types = await drive.types();
      for (let name of ["interface DriveSharing", "DriveCommentWrites"]) {
        expect(types, `${scope.kind} ${name}`).not.toContain(name);
      }
      expect(await drive.describe(), scope.kind).toEqual(readOnlyRow);

      // Reads are untouched: the comment listing still asks Drive, and answers.
      let listed = await drive.call("listComments", "doc-1");
      expect(listed.error, scope.kind).toBeUndefined();
      expect(listed.value, scope.kind).toEqual([]);
      expect(provider.calls(), scope.kind).toContain("GET /drive/v3/files/doc-1/comments");
    }
    expect(provider.writes).toEqual([]);
    expect(provider.comments.get("doc-1")).toEqual(["First"]);
    expect(provider.direct("doc-1")).toEqual([["perm-A", "owner"], ["perm-bob", "reader"]]);
  });

  it("tells a read-only binding of the deployment, not of a URL to request", async () => {
    let capped = binding(ACCOUNT, null, undefined, "read");

    let refused = await capped.call("comment", "doc-1", "Hi");
    // The URL a read-only refusal ends with would be refused there when a connection is made.
    expect(refused.error).toBe(DEPLOYMENT_READ_ONLY);
    expect(refused.error).not.toContain("https:");
    expect(refused.actionId).toBeUndefined();

    // The same connection once the setting is lifted: nothing of it was kept.
    await capped.restart();
    let lifted = binding(ACCOUNT, null, capped.facet);
    expect((await lifted.call("comment", "doc-1", "Hi")).error).toBe(READ_ONLY_ACCOUNT);
    expect(provider.requests).toEqual([]);
  });

  it("leaves a write queued before the setting pending under it, and applies it once it is lifted", async () => {
    let drive = binding(FOLDER);
    let comment = await drive.queued("comment", "doc-1", "Hi");
    let share = await drive.queued("share", "doc-1", BOB, "reader");
    let move = await drive.queued("move", "sheet-1", "inner");
    let queued = [comment.actionId, share.actionId, move.actionId];
    provider.forget();

    await drive.restart();
    let capped = binding(FOLDER, "write", drive.facet, "read");
    // Not failed for good: a second approval asks again, and is told the same.
    for (let round of [1, 2]) {
      for (let actionId of queued) {
        expect(await capped.apply(actionId), `${actionId}, approval ${round}`)
          .toBe(DEPLOYMENT_READ_ONLY);
      }
    }
    expect(provider.writes).toEqual([]);
    expect(await capped.waiting()).toEqual(queued);
    // A write can always be withdrawn.
    expect(await capped.reject(move.actionId)).toBeNull();
    expect(await capped.waiting()).toEqual([comment.actionId, share.actionId]);

    await capped.restart();
    let lifted = binding(FOLDER, "write", drive.facet);
    expect(await lifted.apply(comment.actionId)).toBeNull();
    expect(await lifted.apply(share.actionId)).toBeNull();
    expect(provider.comments.get("doc-1")).toEqual(["Hi"]);
    expect(provider.direct("doc-1")).toContainEqual(["perm-bob", "reader"]);
    expect(parentsOf("sheet-1")).toEqual([ROOT]);
    expect(await lifted.waiting()).toEqual([]);
  });

  it("still finds what an earlier send made", async () => {
    let drive = binding();
    let { actionId } = await drive.queued("share", "doc-1", BOB, "reader");
    provider.nextWrite = "lost";
    expect(await drive.apply(actionId)).toBe(UNCONFIRMED);

    await drive.restart();
    let capped = binding(ACCOUNT, "write", drive.facet, "read");
    // The look writes nothing, and found the change: nothing was sent under the setting.
    expect(await capped.apply(actionId)).toBeNull();
    expect(sent(CREATE_ON_DOC)).toHaveLength(1);
    expect(provider.writes).toHaveLength(1);
    expect(await capped.waiting()).toEqual([]);
  });
});
