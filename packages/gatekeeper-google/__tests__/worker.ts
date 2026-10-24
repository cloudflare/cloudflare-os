import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ActionField, ActionKind, ApprovalQueue, Gatekeeper, GitCache, HookController,
  HookDescription, ObservationDescription, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { TestGitCache } from "./test-git-cache";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { GoogleAccessToken } from "../src/google-api";
import { COMMENT_ATTEMPT_PREFIX, type CommentAttempt } from "../src/drive-comments";
import type { DriveBindingScope } from "../src/drive-session";
import type {
  DriveComment, DriveCommentReply, GoogleDriveFolderSession, GoogleDriveSession,
} from "../src/drive-types";
import type { GoogleDocSession, GoogleDocTab } from "../src/docs-types";
import type { MarkerEntry } from "../src/sheets-actions";
import type { SpreadsheetInfo, SpreadsheetRange } from "../src/sheets-read-types";
import type { GoogleSpreadsheetSession } from "../src/sheets-types";
import type { PresentationInfo, Slide } from "../src/slides-read-types";
import type { GooglePresentationSession } from "../src/slides-types";
import GoogleWorker, {
  GatekeeperVendor, GoogleDocGatekeeperImpl, GoogleDriveGatekeeperImpl, GoogleSheetsGatekeeperImpl,
  GoogleSlidesGatekeeperImpl, GoogleVerifier,
} from "../src/google";

export {
  GatekeeperVendor, GoogleDocGatekeeperImpl, GoogleDriveGatekeeperImpl, GoogleSheetsGatekeeperImpl,
  GoogleSlidesGatekeeperImpl, GoogleVerifier,
};
export default GoogleWorker;

export class UserAccount extends DurableObject<Env> {
  /** Names the account in its token, so a provider fake can tell which account a request was made as. */
  async getAccessToken(): Promise<GoogleAccessToken> {
    return { token: `test-access-token:${this.ctx.id}`, expires: new Date(8640000000000000) };
  }

  /** The grants {@link setGrantedResourceUrlPatterns} last recorded; none until then. */
  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    return this.ctx.storage.kv.get<string[]>("test:grants") ?? [];
  }

  async setGrantedResourceUrlPatterns(patterns: string[]): Promise<void> {
    this.ctx.storage.kv.put("test:grants", patterns);
  }
}

type GatekeeperProps = { userObjectId: string; documentId: string };

type StorageOperation = { kind: "put"; key: string; value: unknown };
type TestGoogleDocGatekeeper = GoogleDocGatekeeperImpl & {
  applyTestStorage(operations: StorageOperation[]): void;
  testStoredValueJsonLength(key: string): number | undefined;
};

/** What one Slides session call returned or threw, and what it queued and observed. */
type SlidesCall = {
  value?: string | PresentationInfo | Slide[] | Record<string, string>;
  error?: string;
  actionId?: number;
  action?: ActionDescription;
  observations: string[];
};

/** What one Sheets session call returned or threw, and what it queued and observed. */
type SheetsCall = {
  value?: SpreadsheetInfo | SpreadsheetRange | SpreadsheetRange[];
  error?: string;
  actionId?: number;
  action?: ActionDescription;
  observations: string[];
};

/** What one Drive session call returned or threw, and what it queued and observed. */
type DriveCall = {
  /** A write's pending item, or every page a comment listing yielded. */
  value?: DriveComment | DriveCommentReply | DriveComment[][];
  error?: string;
  actionId?: number;
  action?: ActionDescription;
  observations: string[];
};

/** Every page a comment cursor yields, until it is exhausted. */
async function drainComments(cursor: { next(): Promise<DriveComment[] | null> } & Disposable)
    : Promise<DriveComment[][]> {
  using owned = cursor;
  let pages: DriveComment[][] = [];
  for (let page = await owned.next(); page !== null; page = await owned.next()) pages.push(page);
  return pages;
}

/** An error's message, so a test can assert on a failure that crossed the RPC boundary. */
function failure(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}
class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  actionId?: number;
  action?: ActionDescription;
  actionDescription?: string;
  actionFields: ActionField[] = [];
  readonly observations: string[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description.description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    this.actionId = actionId;
    this.action = description;
    this.actionDescription = description.description;
    this.actionFields = description.fields ?? [];
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

export class TestHooks extends DurableObject<Env> {
  #lastActionDescription = "";
  #lastActionFields: ActionField[] = [];
  #lastObservations: string[] = [];
  /** The class each facet runs, where it is not the default bound Google Doc. */
  #classes = new Map<string, DurableObjectClass<Gatekeeper<any>>>();
  /** The class each facet's applyCreation() returned, until adoptCreated() switches to it. */
  #created = new Map<string, DurableObjectClass<Gatekeeper<any>>>();
  #drives = new Map<string, GoogleDriveGatekeeperImpl>();

  /** The approval description of the edit most recently submitted through these hooks. */
  get lastActionDescription(): string {
    return this.#lastActionDescription;
  }

  /** The structured fields of that approval description. */
  get lastActionFields(): ActionField[] {
    return this.#lastActionFields;
  }

  /** Observation descriptions authorized by the most recent session, successful or not. */
  get lastObservations(): string[] {
    return this.#lastObservations;
  }

  #gatekeeper(facetName: string) {
    let userObjectId = this.ctx.exports.UserAccount.idFromName("test-user").toString();
    return this.ctx.facets.get<GoogleDocGatekeeperImpl>(facetName, () => ({
      class: this.#classes.get(facetName) ?? this.ctx.exports.GoogleDocGatekeeperImpl({
        props: { userObjectId, documentId: "doc-1" } satisfies GatekeeperProps,
      }),
    }));
  }

  /** Mint a simulated file as createExternalResource does, and run `facetName` on it. */
  async createResource(facetName: string, resourceUrlPattern: string, title: string)
      : Promise<{ action: ActionDescription } | { error: string }> {
    try {
      let created = await this.ctx.exports.GatekeeperVendor.createResource(resourceUrlPattern, title);
      this.#classes.set(facetName, created.class);
      return { action: created.action };
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Approve the creation into `userName`'s account. The returned class is only kept: the overseer
   * restarts the facet on it afterwards, which adoptCreated() does.
   */
  async applyCreation(facetName: string, userName = "test-user")
      : Promise<{ resourceUrl: string } | { error: string }> {
    let userObjectId = this.ctx.exports.UserAccount.idFromName(userName).toString();
    try {
      let created = await (this.#gatekeeper(facetName) as unknown as Gatekeeper<any>)
        .applyCreation!(this.ctx.exports.GoogleVerifier({ props: { userObjectId } }), null);
      this.#created.set(facetName, created.class);
      return { resourceUrl: created.resourceUrl };
    } catch (error) {
      return failure(error);
    }
  }

  /** What the overseer does once a creation applies: restart the facet on the real class. */
  async adoptCreated(facetName: string): Promise<void> {
    let created = this.#created.get(facetName);
    if (!created) throw new Error(`No creation applied on ${facetName}`);
    this.ctx.facets.abort(facetName, new Error("Connection restarted because its resource was created."));
    this.#classes.set(facetName, created);
  }

  async describe(facetName: string): Promise<ResourceDescription> {
    return this.#gatekeeper(facetName).describe();
  }

  async #withReadSession<Session, T>(
    facetName: string, body: (session: Session) => Promise<T>,
  ): Promise<T | { error: string }> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    using session = await (this.#gatekeeper(facetName) as unknown as Gatekeeper<Session>)
      .startSession(approvalQueue) as Session & Disposable;
    try {
      return await body(session);
    } catch (error) {
      return failure(error);
    } finally {
      this.#lastObservations = queue.observations;
    }
  }

  async readSpreadsheet(facetName: string): Promise<SpreadsheetInfo | { error: string }> {
    return this.#withReadSession<GoogleSpreadsheetSession, SpreadsheetInfo>(
      facetName, session => session.getSpreadsheet());
  }

  async readRange(facetName: string, range: string): Promise<SpreadsheetRange | { error: string }> {
    return this.#withReadSession<GoogleSpreadsheetSession, SpreadsheetRange>(
      facetName, session => session.readRange(range));
  }

  async #withSession<T>(
    facetName: string,
    body: (session: GoogleDocSession, queue: TestApprovalQueue) => Promise<T>,
  ): Promise<T> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    using session = await this.#gatekeeper(facetName).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as GoogleDocSession & Disposable;
    try {
      // Awaited inside the scope: `return body(...)` would dispose both stubs mid-call.
      return await body(session, queue);
    } finally {
      this.#lastActionDescription = queue.actionDescription ?? "";
      this.#lastActionFields = queue.actionFields;
      this.#lastObservations = queue.observations;
    }
  }

  /** Run one edit and return the action ID it queued. */
  async #submit(
    facetName: string,
    edit: (session: GoogleDocSession) => Promise<void>,
  ): Promise<number> {
    return this.#withSession(facetName, async (session, queue) => {
      await edit(session);
      if (queue.actionId === undefined) throw new Error("Action was not submitted");
      return queue.actionId;
    });
  }

  async submitAppend(facetName: string, markdown: string, tabId?: string): Promise<number> {
    return this.#submit(facetName, session => session.appendText(markdown, tabId));
  }

  async submitReplace(
    facetName: string, oldMarkdown: string, newMarkdown: string, tabId?: string,
  ): Promise<number> {
    return this.#submit(
      facetName, session => session.replaceText(oldMarkdown, newMarkdown, tabId));
  }

  /** The `lastModified` a metadata read reports, as epoch milliseconds. */
  async readMetadata(facetName: string): Promise<number> {
    return this.#withSession(
      facetName, async session => (await session.getMetadata()).lastModified.valueOf());
  }

  /** The simulated content of one tab. */
  async readContent(facetName: string, tabId?: string): Promise<string> {
    return this.#withSession(facetName, session => session.getContent(tabId));
  }

  async listTabs(facetName: string): Promise<GoogleDocTab[]> {
    return this.#withSession(facetName, session => session.listTabs());
  }

  async applyStorage(facetName: string, operations: StorageOperation[]): Promise<void> {
    await (this.#gatekeeper(facetName) as unknown as TestGoogleDocGatekeeper)
      .applyTestStorage(operations);
  }

  async storedValueJsonLength(facetName: string, key: string): Promise<number | undefined> {
    return (this.#gatekeeper(facetName) as unknown as TestGoogleDocGatekeeper)
      .testStoredValueJsonLength(key);
  }

  async applyAction(facetName: string, actionId: number): Promise<string | null> {
    try {
      // The overseer always passes an action-scoped git cache with the apply call, and the
      // validator (sharpened by the `Gatekeeper` interface) requires it, so the test passes a
      // stand-in the same way.
      await this.#gatekeeper(facetName).applyAction(actionId, new RpcStub(new TestGitCache()));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async rejectAction(facetName: string, actionId: number): Promise<void> {
    await this.#gatekeeper(facetName).rejectAction(actionId);
  }

  #slides(facetName: string) {
    let userObjectId = this.ctx.exports.UserAccount.idFromName("test-user").toString();
    return this.ctx.facets.get<GoogleSlidesGatekeeperImpl>(facetName, () => ({
      class: this.#classes.get(facetName) ?? this.ctx.exports.GoogleSlidesGatekeeperImpl({
        props: { userObjectId, presentationId: "deck-1" },
      }),
    }));
  }

  /**
   * Calls one method of a fresh Slides session, reporting what it queued and observed. `entered`
   * is called once the method has run up to its first wait, before it settles.
   */
  async callSlides(
    facetName: string, method: keyof GooglePresentationSession, args: unknown[],
    entered?: () => void,
  ): Promise<SlidesCall> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    using session = await this.#slides(facetName).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as GooglePresentationSession & Disposable;
    let outcome: { value?: SlidesCall["value"]; error?: string };
    try {
      let call = session[method] as (...args: unknown[]) => Promise<SlidesCall["value"]>;
      // Handled below, once `entered` has run; this only keeps it from reporting as unhandled.
      let calling = Promise.resolve(call(...args));
      calling.catch(() => {});
      if (entered) {
        // Calls on one stub are delivered in order, and this one waits on nothing.
        await session.getSlides([]).catch(() => {});
        await entered();
      }
      outcome = { value: await calling };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    return { ...outcome, actionId: queue.actionId, action: queue.action, observations: queue.observations };
  }

  /** Applies a Slides change. `entered` is called once the apply has run up to its first wait. */
  async applySlides(
    facetName: string, actionId: number, entered?: () => void,
  ): Promise<string | null> {
    let gatekeeper = this.#slides(facetName);
    let applying = Promise.resolve(gatekeeper.applyAction(actionId, new RpcStub(new TestGitCache())));
    // Handled below, once `entered` has run; this only keeps it from reporting as unhandled.
    applying.catch(() => {});
    if (entered) {
      // Calls on one stub are delivered in order, and this one waits on nothing.
      await gatekeeper.getAutoApprovableActions();
      await entered();
    }
    try {
      await applying;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async rejectSlides(facetName: string, actionId: number): Promise<{ restart?: boolean } | null> {
    return await this.#slides(facetName).rejectAction(actionId) ?? null;
  }

  async slidesAutoApprovable(facetName: string): Promise<ActionKind[]> {
    return this.#slides(facetName).getAutoApprovableActions();
  }

  /** Leaves a Slides change claimed, as an activation that died while applying it would. */
  async orphanSlidesClaim(facetName: string, actionId: number): Promise<void> {
    await (this.#slides(facetName) as unknown as TestGoogleSlidesGatekeeper).claimTestAction(actionId);
  }

  /**
   * The Drive gatekeeper `facetName` names, built over this object's own state and storage: the
   * pool registers no Drive gatekeeper class a facet could run, so each test addresses a TestHooks
   * object of its own instead. Dropped by {@link restartDrive}, as another activation would be.
   */
  #drive(facetName: string, scope: DriveBindingScope): GoogleDriveGatekeeperImpl {
    let gatekeeper = this.#drives.get(facetName);
    if (!gatekeeper) {
      let userObjectId = this.ctx.exports.UserAccount.idFromName("test-user").toString();
      // The props a facet would carry. The state itself must be the runtime's, which the base class
      // checks, so they are set on it.
      Object.defineProperty(this.ctx, "props", {
        value: { userObjectId, scope }, configurable: true,
      });
      gatekeeper = new GoogleDriveGatekeeperImpl(
        this.ctx as unknown as DurableObjectState<{ userObjectId: string; scope: DriveBindingScope }>,
        this.env as unknown as ConstructorParameters<typeof GoogleDriveGatekeeperImpl>[1]);
      this.#drives.set(facetName, gatekeeper);
    }
    return gatekeeper;
  }

  /** Forgets the Drive gatekeeper `facetName` names, keeping its storage. */
  async restartDrive(facetName: string): Promise<void> {
    this.#drives.delete(facetName);
  }

  /** Records the grants the test user's Google account holds. */
  async setDriveGrants(patterns: string[]): Promise<void> {
    let account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromName("test-user"));
    await (account as unknown as UserAccount).setGrantedResourceUrlPatterns(patterns);
  }

  /**
   * Calls one method of a fresh Drive session, after opening each folder of `path` in turn,
   * reporting what it queued and observed. A comment cursor is drained into its pages.
   */
  async callDrive(
    facetName: string, scope: DriveBindingScope, method: string, args: unknown[],
    path: string[] = [],
  ): Promise<DriveCall> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    // Through a stub, so the session is reached over RPC as a binding reaches it.
    let started = await this.#drive(facetName, scope).startSession(approvalQueue);
    using session = new RpcStub(started as unknown as RpcTarget) as
      unknown as GoogleDriveSession & Disposable;
    let outcome: { value?: DriveCall["value"]; error?: string };
    let opened: Disposable[] = [];
    try {
      let target: GoogleDriveSession | GoogleDriveFolderSession = session;
      for (let folderId of path) {
        let folder = await (target as GoogleDriveFolderSession).openFolder(folderId) as
          GoogleDriveFolderSession & Disposable;
        opened.push(folder);
        target = folder;
      }
      let value = await (target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method](...args);
      outcome = {
        value: method === "listComments"
          ? await drainComments(value as Parameters<typeof drainComments>[0])
          : value as DriveComment | DriveCommentReply,
      };
    } catch (error) {
      outcome = failure(error);
    } finally {
      for (let folder of opened.toReversed()) folder[Symbol.dispose]();
    }
    return { ...outcome, actionId: queue.actionId, action: queue.action, observations: queue.observations };
  }

  /** Applies a Drive comment write, returning the error message it failed with, if any. */
  async applyDrive(facetName: string, scope: DriveBindingScope, actionId: number)
      : Promise<string | null> {
    try {
      await this.#drive(facetName, scope).applyAction(actionId, new RpcStub(new TestGitCache()));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Rejects a Drive comment write, returning the error message it was refused with, if any. */
  async rejectDrive(facetName: string, scope: DriveBindingScope, actionId: number)
      : Promise<string | null> {
    try {
      await this.#drive(facetName, scope).rejectAction(actionId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async driveAutoApprovable(facetName: string, scope: DriveBindingScope): Promise<ActionKind[]> {
    return this.#drive(facetName, scope).getAutoApprovableActions();
  }

  /** Leaves a Drive comment write claimed, as an activation that died while applying it would. */
  async orphanDriveClaim(facetName: string, scope: DriveBindingScope, actionId: number)
      : Promise<void> {
    await (this.#drive(facetName, scope) as unknown as TestGoogleDriveGatekeeper)
      .claimTestAction(actionId);
  }

  /** Leaves a Drive comment write failed, as a resolution another activation finished would. */
  async failDriveAction(facetName: string, scope: DriveBindingScope, actionId: number)
      : Promise<void> {
    await (this.#drive(facetName, scope) as unknown as TestGoogleDriveGatekeeper)
      .failTestAction(actionId);
  }

  /** The attempt markers a Drive binding holds, by action ID. */
  async driveAttempts(facetName: string, scope: DriveBindingScope)
      : Promise<Record<number, CommentAttempt>> {
    return (this.#drive(facetName, scope) as unknown as TestGoogleDriveGatekeeper).testAttempts();
  }

  /** Moves a Drive comment write's attempt marker `ms` into the past. */
  async ageDriveAttempt(facetName: string, scope: DriveBindingScope, actionId: number, ms: number)
      : Promise<void> {
    await (this.#drive(facetName, scope) as unknown as TestGoogleDriveGatekeeper)
      .ageTestAttempt(actionId, ms);
  }

  #sheets(facetName: string) {
    let userObjectId = this.ctx.exports.UserAccount.idFromName("test-user").toString();
    return this.ctx.facets.get<GoogleSheetsGatekeeperImpl>(facetName, () => ({
      class: this.ctx.exports.GoogleSheetsGatekeeperImpl({
        props: { userObjectId, spreadsheetId: "sheet-1" },
      }),
    }));
  }

  /**
   * Calls one method of a fresh Sheets session, reporting what it queued and observed. `entered`
   * is called once the method has run up to its first wait, before it settles.
   */
  async callSheets(
    facetName: string, method: keyof GoogleSpreadsheetSession, args: unknown[],
    entered?: () => void,
  ): Promise<SheetsCall> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    using session = await this.#sheets(facetName).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as GoogleSpreadsheetSession & Disposable;
    let outcome: { value?: SheetsCall["value"]; error?: string };
    try {
      let call = session[method] as (...args: unknown[]) => Promise<SheetsCall["value"]>;
      // Handled below, once `entered` has run; this only keeps it from reporting as unhandled.
      let calling = Promise.resolve(call(...args));
      calling.catch(() => {});
      if (entered) {
        // Calls on one stub are delivered in order, and this one waits on nothing.
        await session.updateSpreadsheet([]).catch(() => {});
        await entered();
      }
      outcome = { value: await calling };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    return { ...outcome, actionId: queue.actionId, action: queue.action, observations: queue.observations };
  }

  /** Applies a Sheets change. `entered` is called once the apply has run up to its first wait. */
  async applySheets(
    facetName: string, actionId: number, entered?: () => void,
  ): Promise<string | null> {
    let gatekeeper = this.#sheets(facetName);
    let applying = Promise.resolve(gatekeeper.applyAction(actionId, new RpcStub(new TestGitCache())));
    // Handled below, once `entered` has run; this only keeps it from reporting as unhandled.
    applying.catch(() => {});
    if (entered) {
      // Calls on one stub are delivered in order, and this one waits on nothing.
      await gatekeeper.getAutoApprovableActions();
      await entered();
    }
    try {
      await applying;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async rejectSheets(facetName: string, actionId: number): Promise<{ restart?: boolean } | null> {
    return await this.#sheets(facetName).rejectAction(actionId) ?? null;
  }

  async sheetsAutoApprovable(facetName: string): Promise<ActionKind[]> {
    return this.#sheets(facetName).getAutoApprovableActions();
  }

  /** Leaves a Sheets change claimed, as an activation that died while applying it would. */
  async orphanSheetsClaim(facetName: string, actionId: number): Promise<void> {
    await (this.#sheets(facetName) as unknown as TestGoogleSheetsGatekeeper).claimTestAction(actionId);
  }

  /** Stores the markers earlier batches left, as entries or bare IDs. */
  async seedSheetsMarkers(facetName: string, entries: (MarkerEntry | number)[]): Promise<void> {
    await (this.#sheets(facetName) as unknown as TestGoogleSheetsGatekeeper).seedTestMarkers(entries);
  }

  /** The markers earlier batches left, as stored. */
  async sheetsMarkers(facetName: string): Promise<(MarkerEntry | number)[]> {
    return (this.#sheets(facetName) as unknown as TestGoogleSheetsGatekeeper).testMarkers();
  }
}

type TestDurableObjectState = { ctx: { storage: DurableObjectStorage } };

(GoogleDocGatekeeperImpl.prototype as TestGoogleDocGatekeeper).applyTestStorage = function(
  operations: StorageOperation[],
): void {
  let storage = (this as unknown as TestDurableObjectState).ctx.storage;
  for (let operation of operations) storage.kv.put(operation.key, operation.value);
};

(GoogleDocGatekeeperImpl.prototype as TestGoogleDocGatekeeper).testStoredValueJsonLength = function(
  key: string,
): number | undefined {
  let value = (this as unknown as TestDurableObjectState).ctx.storage.kv.get(key);
  return value === undefined ? undefined : JSON.stringify(value).length;
};

type TestGoogleSlidesGatekeeper = GoogleSlidesGatekeeperImpl & { claimTestAction(id: number): void };

(GoogleSlidesGatekeeperImpl.prototype as TestGoogleSlidesGatekeeper).claimTestAction = function(
  id: number,
): void {
  // A second journal over the same storage claims it, so the live one never knew of the apply.
  let storage = (this as unknown as TestDurableObjectState).ctx.storage;
  new ActionJournal(storage.kv, { namespace: "slides" }).markClaimed(id);
};

type TestGoogleDriveGatekeeper = GoogleDriveGatekeeperImpl & {
  claimTestAction(id: number): void;
  failTestAction(id: number): void;
  testAttempts(): Record<number, CommentAttempt>;
  ageTestAttempt(id: number, ms: number): void;
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).claimTestAction = function(
  id: number,
): void {
  // A second journal over the same storage claims it, so the live one never knew of the apply.
  let storage = (this as unknown as TestDurableObjectState).ctx.storage;
  new ActionJournal(storage.kv, { namespace: "drive" }).markClaimed(id);
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).failTestAction = function(
  id: number,
): void {
  let storage = (this as unknown as TestDurableObjectState).ctx.storage;
  new ActionJournal(storage.kv, { namespace: "drive" }).markFailed(id, "Failed elsewhere.");
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).testAttempts = function(
): Record<number, CommentAttempt> {
  let storage = (this as unknown as TestDurableObjectState).ctx.storage;
  return Object.fromEntries([...storage.kv.list<CommentAttempt>({ prefix: COMMENT_ATTEMPT_PREFIX })]
    .map(([key, attempt]) => [Number(key.slice(COMMENT_ATTEMPT_PREFIX.length)), attempt]));
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).ageTestAttempt = function(
  id: number, ms: number,
): void {
  let kv = (this as unknown as TestDurableObjectState).ctx.storage.kv;
  let key = `${COMMENT_ATTEMPT_PREFIX}${id}`;
  let attempt = kv.get<CommentAttempt>(key);
  if (!attempt) throw new Error(`No attempt marker for action ${id}`);
  kv.put(key, { at: attempt.at - ms });
};

type TestGoogleSheetsGatekeeper = GoogleSheetsGatekeeperImpl & {
  claimTestAction(id: number): void;
  seedTestMarkers(entries: (MarkerEntry | number)[]): void;
  testMarkers(): (MarkerEntry | number)[];
};

// The key `GoogleSheetsGatekeeperImpl` keeps its markers under.
const SHEETS_MARKERS_KEY = "sheets:staleMarkers";

(GoogleSheetsGatekeeperImpl.prototype as TestGoogleSheetsGatekeeper).claimTestAction = function(
  id: number,
): void {
  // A second journal over the same storage claims it, so the live one never knew of the apply.
  let storage = (this as unknown as TestDurableObjectState).ctx.storage;
  new ActionJournal(storage.kv, { namespace: "sheets" }).markClaimed(id);
};

(GoogleSheetsGatekeeperImpl.prototype as TestGoogleSheetsGatekeeper).seedTestMarkers = function(
  entries: (MarkerEntry | number)[],
): void {
  (this as unknown as TestDurableObjectState).ctx.storage.kv.put(SHEETS_MARKERS_KEY, entries);
};

(GoogleSheetsGatekeeperImpl.prototype as TestGoogleSheetsGatekeeper).testMarkers = function(
): (MarkerEntry | number)[] {
  return (this as unknown as TestDurableObjectState).ctx.storage.kv.get(SHEETS_MARKERS_KEY) ?? [];
};
