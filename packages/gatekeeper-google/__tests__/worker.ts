import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ActionField, ActionKind, ApprovalQueue, Gatekeeper, GitCache, HookController,
  HookDescription, ObservationDescription, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { TestGitCache } from "./test-git-cache";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { GoogleAccessToken } from "../src/google-api";
import type { DriveBindingScope } from "../src/drive-session";
import type {
  Cursor, DocSuggestion, DriveAccess, DriveComment, DriveCommentReply, DriveEntry, DriveScope,
  GoogleDriveFolderSession, GoogleDriveSession,
} from "../src/drive-types";
import { WRITE_ATTEMPT_PREFIX, type WriteAttempt } from "../src/drive-writes";
import type { DriveAccessLevel } from "../src/resources";
import type { DocMetadata, GoogleDocSession, GoogleDocTab } from "../src/docs-types";
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
export { CalendarTestHooks, GoogleCalendarGatekeeperImpl } from "./calendar-hooks";

/** The Drive gatekeeper as a deployment that keeps Google Drive read-only runs it. */
export class ReadOnlyDriveGatekeeper extends GoogleDriveGatekeeperImpl {
  constructor(...[ctx, env]: ConstructorParameters<typeof GoogleDriveGatekeeperImpl>) {
    super(ctx, { ...env, GOOGLE_DRIVE_ACCESS: "read" });
  }
}

/** Credentials a test installed on the account, and how many calls still answer the ones before. */
type InstalledToken = {
  token: string;
  /** How many more calls answer `before`. */
  after: number;
  /** What the account answered when `token` was installed. */
  before: string;
};

const INSTALLED_TOKEN_KEY = "test:token";

export class UserAccount extends DurableObject<Env> {
  /**
   * Names the account in its token, so a provider fake can tell which account a request was made
   * as, unless {@link setAccessToken} installed another, which then answers once its count has run.
   */
  async getAccessToken(): Promise<GoogleAccessToken> {
    return { token: this.#nextToken(true), expires: new Date(8640000000000000) };
  }

  /**
   * Installs other credentials, as a reconnect does: `token` answers once `after` more calls have
   * been answered with what the account answers now. `undefined` restores the default at once.
   */
  async setAccessToken(token: string | undefined, after = 0): Promise<void> {
    let { kv } = this.ctx.storage;
    if (token === undefined) {
      kv.delete(INSTALLED_TOKEN_KEY);
      return;
    }
    let installed: InstalledToken = { token, after, before: this.#nextToken(false) };
    kv.put(INSTALLED_TOKEN_KEY, installed);
  }

  /** The token the next call is answered with. `count` says whether this is such a call. */
  #nextToken(count: boolean): string {
    let { kv } = this.ctx.storage;
    let installed = kv.get<InstalledToken>(INSTALLED_TOKEN_KEY);
    if (!installed) return `test-access-token:${this.ctx.id}`;
    if (installed.after <= 0) return installed.token;
    if (count) kv.put(INSTALLED_TOKEN_KEY, { ...installed, after: installed.after - 1 });
    return installed.before;
  }

  /** The grants {@link setGranted} last recorded; none until then. */
  async getGrantedResourceUrlPatterns(): Promise<string[]> {
    return this.ctx.storage.kv.get<string[]>("granted") ?? [];
  }

  /** Records the grants the account holds, as a test names them. */
  setGranted(patterns: string[]): void {
    this.ctx.storage.kv.put("granted", patterns);
  }
}

type GatekeeperProps = { userObjectId: string; documentId: string };

type StorageOperation = { kind: "put"; key: string; value: unknown };
type TestGoogleDocGatekeeper = GoogleDocGatekeeperImpl & {
  applyTestStorage(operations: StorageOperation[]): void;
  testStoredValueJsonLength(key: string): number | undefined;
};

/** An action the queue received: its ID and its card's title. */
type SubmittedAction = { actionId: number; title: string };

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

/** What one bound Google Doc session call returned or threw, and what it queued and observed. */
type DocCall = {
  /** A write's pending item, a metadata read, or the provisional ID of a tab queued with `addTab()`. */
  value?: DriveComment | DriveCommentReply | DriveComment[] | DocSuggestion | DocMetadata | string;
  error?: string;
  actionId?: number;
  action?: ActionDescription;
  observations: string[];
  /** What each observation reported, in order. */
  reports: { title: string; subresources?: string[] }[];
};

/**
 * A Drive binding as a test names it: its scope and, for read and write, its access level.
 * `deployment` is not part of the binding: it says that the deployment the gatekeeper runs on keeps
 * Google Drive read-only.
 */
type DriveBinding = { scope: DriveBindingScope; access?: DriveAccessLevel; deployment?: "read" };

/** The read and write Drive file binding a facet named `drive:<name>` reaches doc-1 through. */
const DRIVE_DOC: DriveBinding = { scope: { kind: "file", fileId: "doc-1" }, access: "write" };

/**
 * Whether the Doc hooks reach doc-1 through a read and write Drive file binding in this facet,
 * rather than through a directly bound Doc: so a Doc suite runs a second time through Drive.
 */
function throughDrive(facetName: string): boolean {
  return facetName.startsWith("drive:");
}

/** A Drive session method that opens a native file. */
type NativeOpener = "openGoogleSlides" | "openGoogleSheet" | "openGoogleDoc";

/** What one call on a native session a Drive binding opened returned or threw, and what it queued. */
type NativeCall = {
  value?: SlidesCall["value"] | SheetsCall["value"] | DocMetadata | GoogleDocTab[] | number;
  error?: string;
  actionId?: number;
  action?: ActionDescription;
  observations: string[];
  /** What each observation reported, in order. */
  reports: { title: string; subresources?: string[] }[];
};

/** Nothing once `call` resolves, or the message it was refused with. */
function settle(call: unknown): Promise<{ error?: string }> {
  return Promise.resolve(call).then(() => ({}), failure);
}

/** Calls method `method` of `target`, which a test names at run time, with `args`. */
function callOn(target: object, method: string, args: unknown[]): unknown {
  let call = (target as Record<string, (...args: unknown[]) => unknown>)[method];
  return Reflect.apply(call, target, args);
}

/** What one Drive session call returned or threw, and what it queued and observed. */
type DriveCall = {
  /**
   * A write's pending item, every page a comment listing yielded, a file's access or one way of
   * it, an entry, or the binding's scope. A write that returns nothing leaves it `undefined`.
   */
  value?: DriveComment | DriveCommentReply | DriveComment[][] | DriveScope | DriveAccess |
    DriveAccess[] | DriveEntry;
  error?: string;
  actionId?: number;
  action?: ActionDescription;
  observations: string[];
  /** What each observation reported, in order. */
  reports: { title: string; subresources?: string[] }[];
};

/** Every page a comment cursor yields, until it is exhausted. */
async function drainComments(cursor: Cursor<DriveComment> & Disposable): Promise<DriveComment[][]> {
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
  /** What each observation reported, in order. */
  readonly reports: { title: string; subresources?: string[] }[] = [];
  /** Every action submitted, in the order the calls arrived. */
  readonly submitted: SubmittedAction[] = [];
  /** Holds the next submission open until `released`, calling `reach` once it has arrived. */
  holdSubmission?: { reach(): void; released: Promise<void> };

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description.description);
    this.reports.push({
      title: description.title,
      ...(description.subresources ? { subresources: description.subresources } : {}),
    });
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(actionId: number, description: ActionDescription): Promise<void> {
    let held = this.holdSubmission;
    if (held) {
      this.holdSubmission = undefined;
      held.reach();
      await held.released;
    }
    this.submitted.push({ actionId, title: description.title });
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

  // The session never ends in this test.
  async requireLive(): Promise<void> {}

  async watchSession(): Promise<RpcStub<RpcTarget>> {
    return new RpcStub(new (class extends RpcTarget {})());
  }

  async getExecutionId(): Promise<string | undefined> {
    return undefined;
  }
}

export class TestHooks extends DurableObject<Env> {
  #lastActionDescription = "";
  #lastActionFields: ActionField[] = [];
  #lastActionVerdict: { actionKind?: ActionKind; autoApprovable?: boolean } = {};
  #lastObservations: string[] = [];
  /** The class each facet runs, where it is not the default bound Google Doc. */
  #classes = new Map<string, DurableObjectClass<Gatekeeper<any>>>();
  /** The class each facet's applyCreation() returned, until adoptCreated() switches to it. */
  #created = new Map<string, DurableObjectClass<Gatekeeper<any>>>();

  /** The approval description of the edit most recently submitted through these hooks. */
  get lastActionDescription(): string {
    return this.#lastActionDescription;
  }

  /** The structured fields of that approval description. */
  get lastActionFields(): ActionField[] {
    return this.#lastActionFields;
  }

  /** That edit's action kind and auto-approval verdict. */
  get lastActionVerdict(): { actionKind?: ActionKind; autoApprovable?: boolean } {
    return this.#lastActionVerdict;
  }

  /** The kinds the bound Google Doc reports as auto-approvable. */
  async docAutoApprovable(facetName: string): Promise<ActionKind[]> {
    return throughDrive(facetName)
      ? this.#drive(facetName, DRIVE_DOC).getAutoApprovableActions()
      : this.#gatekeeper(facetName).getAutoApprovableActions();
  }

  /** A session of doc-1, of the bound Doc or as a Drive binding opens it (see throughDrive()). */
  async #openDoc(
    facetName: string, approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<{ session: GoogleDocSession } & Disposable> {
    if (!throughDrive(facetName)) {
      let session = await this.#gatekeeper(facetName).startSession(
        approvalQueue as unknown as ApprovalQueue) as GoogleDocSession & Disposable;
      return { session, [Symbol.dispose]: () => session[Symbol.dispose]() };
    }
    let drive = await this.#drive(facetName, DRIVE_DOC).startSession(
      approvalQueue as unknown as ApprovalQueue) as unknown as GoogleDriveSession & Disposable;
    try {
      let doc = await drive.openGoogleDoc("doc-1") as unknown as GoogleDocSession & Disposable;
      return {
        session: doc,
        [Symbol.dispose]: () => {
          doc[Symbol.dispose]();
          drive[Symbol.dispose]();
        },
      };
    } catch (error) {
      drive[Symbol.dispose]();
      throw error;
    }
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

  /** Give `userName`'s account the grants `patterns`, as consenting to them would. */
  async grant(userName: string, patterns: string[]): Promise<void> {
    let account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromName(userName));
    await (account as unknown as DurableObjectStub<UserAccount>).setGranted(patterns);
  }

  /**
   * Approve the creation into `userName`'s account, configured as `configuration`. The returned
   * class is only kept: the overseer restarts the facet on it afterwards, which adoptCreated() does.
   */
  async applyCreation(facetName: string, userName = "test-user", configuration: string | null = null)
      : Promise<{ resourceUrl: string } | { error: string }> {
    let userObjectId = this.ctx.exports.UserAccount.idFromName(userName).toString();
    try {
      let created = await (this.#gatekeeper(facetName) as unknown as Gatekeeper<any>)
        .applyCreation!(this.ctx.exports.GoogleVerifier({ props: { userObjectId } }), configuration);
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
    return throughDrive(facetName)
      ? this.#drive(facetName, DRIVE_DOC).describe()
      : this.#gatekeeper(facetName).describe();
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

  /** A Drive folder binding's scope and the first batch its listing returns. */
  async readDriveFolder(facetName: string)
      : Promise<{ scope: DriveScope; entries: DriveEntry[] | null } | { error: string }> {
    return this.#withReadSession<GoogleDriveFolderSession, { scope: DriveScope; entries: DriveEntry[] | null }>(
      facetName, async session => {
        using cursor = await session.list() as Cursor<DriveEntry> & Disposable;
        return { scope: await session.getScope(), entries: await cursor.next() };
      });
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
    using opened = await this.#openDoc(facetName, approvalQueue);
    let { session } = opened;
    try {
      // Awaited inside the scope: `return body(...)` would dispose both stubs mid-call.
      return await body(session, queue);
    } finally {
      this.#lastActionDescription = queue.actionDescription ?? "";
      this.#lastActionFields = queue.actionFields;
      this.#lastActionVerdict = {
        actionKind: queue.action?.actionKind, autoApprovable: queue.action?.autoApprovable,
      };
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
      let gatekeeper = throughDrive(facetName)
        ? this.#drive(facetName, DRIVE_DOC) : this.#gatekeeper(facetName);
      await gatekeeper.applyAction(actionId, new RpcStub(new TestGitCache()));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async rejectAction(facetName: string, actionId: number): Promise<void | { restart?: boolean }> {
    if (throughDrive(facetName)) {
      return await this.#drive(facetName, DRIVE_DOC).rejectAction(actionId) ?? undefined;
    }
    return this.#gatekeeper(facetName).rejectAction(actionId);
  }

  /** Calls one method of a fresh bound Doc session, reporting what it queued and observed. */
  async callDoc(facetName: string, method: keyof GoogleDocSession, args: unknown[]): Promise<DocCall> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    using opened = await this.#openDoc(facetName, approvalQueue);
    let { session } = opened;
    let outcome: { value?: DocCall["value"]; error?: string };
    try {
      let call = session[method] as (...args: unknown[]) => Promise<DocCall["value"]>;
      outcome = { value: await call(...args) };
    } catch (error) {
      outcome = failure(error);
    }
    return {
      ...outcome, actionId: queue.actionId, action: queue.action,
      observations: queue.observations, reports: queue.reports,
    };
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

  #drive(facetName: string, { deployment, ...binding }: DriveBinding) {
    let userObjectId = this.ctx.exports.UserAccount.idFromName("test-user").toString();
    // `ctx.exports` is typed from the deployed module, which does not export this worker's class.
    let exports = this.ctx.exports as Cloudflare.Exports & {
      ReadOnlyDriveGatekeeper: Cloudflare.Exports["GoogleDriveGatekeeperImpl"];
    };
    // The setting is the Worker's environment, never a prop a connection could set for itself.
    let gatekeeper = deployment === "read"
      ? exports.ReadOnlyDriveGatekeeper : exports.GoogleDriveGatekeeperImpl;
    return this.ctx.facets.get<GoogleDriveGatekeeperImpl>(facetName, () => ({
      class: gatekeeper({ props: { userObjectId, ...binding } }),
    }));
  }

  /**
   * Ends the Drive gatekeeper `facetName` names: the next call starts another activation over the
   * same storage, with whatever binding that call names.
   */
  async restartDrive(facetName: string): Promise<void> {
    this.ctx.facets.abort(facetName, new Error("Restarted by the test."));
  }

  /** Records the grants the test user's Google account holds. */
  async setDriveGrants(patterns: string[]): Promise<void> {
    let account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromName("test-user"));
    await (account as unknown as DurableObjectStub<UserAccount>).setGranted(patterns);
  }

  /**
   * Calls one method of a fresh Drive session, after opening each folder of `path` in turn,
   * reporting what it returned, queued and observed. A comment cursor is drained into its pages.
   */
  async callDrive(
    facetName: string, binding: DriveBinding, method: keyof GoogleDriveFolderSession,
    args: unknown[], path: string[] = [],
  ): Promise<DriveCall> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    using session = await this.#drive(facetName, binding).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as GoogleDriveSession & Disposable;
    let outcome: { value?: DriveCall["value"]; error?: string };
    let opened: Disposable[] = [];
    try {
      // One class serves every scope and the gatekeeper declares the account's shape, so a folder
      // binding's session has the folder's methods although its type does not say so.
      let target: GoogleDriveFolderSession = session as GoogleDriveFolderSession & Disposable;
      for (let folderId of path) {
        let folder = await target.openFolder(folderId) as GoogleDriveFolderSession & Disposable;
        opened.push(folder);
        target = folder;
      }
      let call = target[method] as (...args: unknown[]) => Promise<unknown>;
      let value = await call(...args);
      outcome = {
        value: method === "listComments"
          ? await drainComments(value as Parameters<typeof drainComments>[0])
          : value as DriveCall["value"],
      };
    } catch (error) {
      outcome = failure(error);
    } finally {
      for (let folder of opened.toReversed()) folder[Symbol.dispose]();
    }
    return {
      ...outcome, actionId: queue.actionId, action: queue.action, observations: queue.observations,
      reports: queue.reports,
    };
  }

  /**
   * Installs other credentials on the test user's Google account, as a reconnect does: the account
   * answers `token` once it has answered `after` more calls with what it answers now, and
   * `undefined` restores its default at once. A gatekeeper already holding a token keeps it.
   */
  async setDriveToken(token: string | undefined, after = 0): Promise<void> {
    let account = this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromName("test-user"));
    await (account as unknown as UserAccount).setAccessToken(token, after);
  }

  /**
   * Applies a Drive write, returning the error message it failed with, if any. `entered` is called
   * once the apply has run up to its first wait.
   */
  async applyDrive(
    facetName: string, binding: DriveBinding, actionId: number, entered?: () => void,
  ): Promise<string | null> {
    let gatekeeper = this.#drive(facetName, binding);
    using cache = new RpcStub(new TestGitCache());
    let applying = Promise.resolve(gatekeeper.applyAction(actionId, cache));
    // Handled below, once `entered` has run; this only keeps it from reporting as unhandled.
    applying.catch(() => {});
    if (entered) {
      // Calls on one stub are delivered in order, and this one waits on nothing.
      await gatekeeper.getTypeScriptTypes();
      await entered();
    }
    try {
      await applying;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Rejects an edit made through a Drive binding, answering what the binding answers. */
  async rejectDriveEdit(
    facetName: string, binding: DriveBinding, actionId: number,
  ): Promise<{ restart?: boolean } | null> {
    return await this.#drive(facetName, binding).rejectAction(actionId) ?? null;
  }

  /**
   * Opens native file `fileId` with `opener` from a fresh Drive session, after opening each folder
   * of `path` in turn, and calls one of its methods, reporting what it returned, queued and
   * observed. `entered` is called once the method has run up to its first wait: `probe`, a call
   * that waits on nothing the method holds, is delivered after it and has returned.
   */
  async callDriveNative(
    facetName: string, binding: DriveBinding, opener: NativeOpener, fileId: string,
    method: string, args: unknown[], path: string[] = [], entered?: () => void,
    probe?: [string, ...unknown[]],
  ): Promise<NativeCall> {
    return this.#onDriveNative(facetName, binding, opener, fileId, path, async (native, queue) => {
      let outcome: { value?: NativeCall["value"]; error?: string };
      try {
        let calling = Promise.resolve(callOn(native, method, args));
        // Handled below, once `entered` has run; this only keeps it from reporting as unhandled.
        calling.catch(() => {});
        if (entered) {
          let [probeMethod, ...probeArgs] = probe ?? ["getSlides", []];
          await Promise.resolve(callOn(native, probeMethod, probeArgs)).catch(() => {});
          await entered();
        }
        outcome = { value: await calling as NativeCall["value"] };
      } catch (error) {
        outcome = failure(error);
      }
      return outcome;
    });
  }

  /**
   * Calls `method` of a native session opened as {@link callDriveNative} opens one, once `before`
   * has run between the open and the call.
   */
  async callDriveNativeAfter(
    facetName: string, binding: DriveBinding, opener: NativeOpener, fileId: string,
    method: string, args: unknown[], path: string[], before: () => Promise<void>,
  ): Promise<NativeCall> {
    return this.#onDriveNative(facetName, binding, opener, fileId, path, async native => {
      await before();
      try {
        return { value: await callOn(native, method, args) as NativeCall["value"] };
      } catch (error) {
        return failure(error);
      }
    });
  }

  /**
   * Makes two calls on one native session opened as {@link callDriveNative} opens one, the second
   * sent right after the first, before it has settled. Reports each outcome, and the actions in the
   * order the queue received them.
   */
  async callDriveNativeTwice(
    facetName: string, binding: DriveBinding, opener: NativeOpener, fileId: string,
    first: [string, ...unknown[]], second: [string, ...unknown[]],
  ): Promise<{ outcomes: { error?: string }[]; submitted: SubmittedAction[] }> {
    let submitted: SubmittedAction[] = [];
    let outcomes: { error?: string }[] = [];
    await this.#onDriveNative(facetName, binding, opener, fileId, [], async (native, queue) => {
      let [firstMethod, ...firstArgs] = first;
      let [secondMethod, ...secondArgs] = second;
      let one = settle(callOn(native, firstMethod, firstArgs));
      let two = settle(callOn(native, secondMethod, secondArgs));
      outcomes = await Promise.all([one, two]);
      submitted = queue.submitted;
      return {};
    });
    return { outcomes, submitted };
  }

  /** Releases the submission {@link holdDriveSubmission} holds, once it has settled. */
  #heldSubmission?: () => Promise<{ error?: string }>;

  /**
   * Calls `method` of a native session opened as {@link callDriveNative} opens one, and returns
   * once the call has reached its submission, which stays unanswered, and what the call allocated
   * staged, until {@link releaseDriveSubmission}.
   */
  async holdDriveSubmission(
    facetName: string, binding: DriveBinding, opener: NativeOpener, fileId: string,
    method: string, args: unknown[],
  ): Promise<void> {
    let queue = new TestApprovalQueue();
    let reached = Promise.withResolvers<void>();
    let released = Promise.withResolvers<void>();
    queue.holdSubmission = { reach: reached.resolve, released: released.promise };
    let approvalQueue = new RpcStub<ApprovalQueue>(queue);
    let session = await this.#drive(facetName, binding).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as unknown as GoogleDriveFolderSession & Disposable;
    let native = await callOn(session, opener, [fileId]) as Disposable;
    let calling = settle(callOn(native, method, args));
    await reached.promise;
    this.#heldSubmission = async () => {
      released.resolve();
      let outcome = await calling;
      native[Symbol.dispose]();
      session[Symbol.dispose]();
      approvalQueue[Symbol.dispose]();
      return outcome;
    };
  }

  /** Answers the submission {@link holdDriveSubmission} holds, reporting how its call ended. */
  async releaseDriveSubmission(): Promise<{ error?: string }> {
    let release = this.#heldSubmission;
    this.#heldSubmission = undefined;
    if (!release) throw new Error("No submission is held.");
    return release();
  }

  /** What a Drive binding stores under `key`, as JSON, or `null` for nothing. */
  async driveStored(facetName: string, binding: DriveBinding, key: string): Promise<string | null> {
    return (this.#drive(facetName, binding) as unknown as TestGoogleDriveGatekeeper).testStored(key);
  }

  /** Stores `json` under `key` of a Drive binding's storage, or deletes the key for `null`. */
  async writeDriveStored(
    facetName: string, binding: DriveBinding, key: string, json: string | null,
  ): Promise<void> {
    await (this.#drive(facetName, binding) as unknown as TestGoogleDriveGatekeeper)
      .writeTestStored(key, json);
  }

  /**
   * Retires `count` writes in a Drive binding's journal, as approvals of writes no session here
   * queued would: each fills the journal's memory of applied numbers.
   */
  async retireDriveActions(facetName: string, binding: DriveBinding, count: number): Promise<void> {
    await (this.#drive(facetName, binding) as unknown as TestGoogleDriveGatekeeper)
      .retireTestActions(count);
  }

  /** The keys a Drive binding stores under `prefix`, in key order. */
  async driveStoredKeys(facetName: string, binding: DriveBinding, prefix: string): Promise<string[]> {
    return (this.#drive(facetName, binding) as unknown as TestGoogleDriveGatekeeper)
      .testStoredKeys(prefix);
  }

  /** Runs `use` on native file `fileId`, opened as {@link callDriveNative} opens it. */
  async #onDriveNative(
    facetName: string, binding: DriveBinding, opener: NativeOpener, fileId: string, path: string[],
    use: (native: Disposable, queue: TestApprovalQueue) =>
      Promise<{ value?: NativeCall["value"]; error?: string }>,
  ): Promise<NativeCall> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    using session = await this.#drive(facetName, binding).startSession(
      approvalQueue as unknown as ApprovalQueue,
    ) as unknown as GoogleDriveFolderSession & Disposable;
    let opened: Disposable[] = [];
    let outcome: { value?: NativeCall["value"]; error?: string };
    try {
      let target: GoogleDriveFolderSession = session;
      for (let folderId of path) {
        let folder = await target.openFolder(folderId) as GoogleDriveFolderSession & Disposable;
        opened.push(folder);
        target = folder;
      }
      let native = await callOn(target, opener, [fileId]) as Disposable;
      opened.push(native);
      outcome = await use(native, queue);
    } catch (error) {
      outcome = failure(error);
    } finally {
      for (let capability of opened.toReversed()) capability[Symbol.dispose]();
    }
    return {
      ...outcome, actionId: queue.actionId, action: queue.action, observations: queue.observations,
      reports: queue.reports,
    };
  }

  /** Rejects a Drive write, returning the error message it was refused with, if any. */
  async rejectDrive(facetName: string, binding: DriveBinding, actionId: number)
      : Promise<string | null> {
    try {
      await this.#drive(facetName, binding).rejectAction(actionId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Reverts a Drive write, returning the error message it was refused with, if any. */
  async revertDrive(facetName: string, binding: DriveBinding, actionId: number)
      : Promise<string | null> {
    try {
      await this.#drive(facetName, binding).revertAction(actionId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The action kinds a Drive binding declares auto-approvable. */
  async driveAutoApprovable(facetName: string, binding: DriveBinding): Promise<ActionKind[]> {
    return this.#drive(facetName, binding).getAutoApprovableActions();
  }

  /** How a Drive binding describes its resource. */
  async describeDrive(facetName: string, binding: DriveBinding): Promise<ResourceDescription> {
    return this.#drive(facetName, binding).describe();
  }

  /** The type bundle a Drive binding hands the agent. */
  async driveTypes(facetName: string, binding: DriveBinding): Promise<string> {
    return this.#drive(facetName, binding).getTypeScriptTypes();
  }

  /** Leaves a Drive write claimed, as an activation that died while applying it would. */
  async orphanDriveClaim(facetName: string, binding: DriveBinding, actionId: number)
      : Promise<void> {
    await (this.#drive(facetName, binding) as unknown as TestGoogleDriveGatekeeper)
      .claimTestAction(actionId);
  }

  /** Leaves a Drive write failed, as a resolution another activation finished would. */
  async failDriveAction(facetName: string, binding: DriveBinding, actionId: number)
      : Promise<void> {
    await (this.#drive(facetName, binding) as unknown as TestGoogleDriveGatekeeper)
      .failTestAction(actionId);
  }

  /** The IDs of the writes a Drive binding still holds to be applied: undecided or claimed. */
  async driveQueued(facetName: string, binding: DriveBinding): Promise<number[]> {
    return (this.#drive(facetName, binding) as unknown as TestGoogleDriveGatekeeper).testQueued();
  }

  /** The attempt markers a Drive binding holds, by action ID. */
  async driveAttempts(facetName: string, binding: DriveBinding)
      : Promise<Record<number, WriteAttempt>> {
    return (this.#drive(facetName, binding) as unknown as TestGoogleDriveGatekeeper).testAttempts();
  }

  /** Moves a Drive write's attempt marker `ms` into the past. */
  async ageDriveAttempt(facetName: string, binding: DriveBinding, actionId: number, ms: number)
      : Promise<void> {
    await (this.#drive(facetName, binding) as unknown as TestGoogleDriveGatekeeper)
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

  /** The facet a standalone file gatekeeper of `kind` runs as under `facetName`. */
  #stored(facetName: string, kind: StoredGatekeeper): StoredLayoutHooks {
    let facet = kind === "doc" ? this.#gatekeeper(facetName)
      : kind === "sheets" ? this.#sheets(facetName) : this.#slides(facetName);
    return facet as unknown as StoredLayoutHooks;
  }

  /** Every key the facet's storage holds, in key order. */
  async storedKeys(facetName: string, kind: StoredGatekeeper): Promise<string[]> {
    return this.#stored(facetName, kind).testStoredKeys();
  }

  /** The value under `key`, read through the synchronous KV and through the asynchronous API. */
  async storedValue(facetName: string, kind: StoredGatekeeper, key: string): Promise<StoredValue> {
    return this.#stored(facetName, kind).testStoredValue(key);
  }

  /** Writes `operations` to the facet's storage through the synchronous KV or the asynchronous API. */
  async writeStored(
    facetName: string, kind: StoredGatekeeper, operations: StorageOperation[], api: "kv" | "async",
  ): Promise<void> {
    await this.#stored(facetName, kind).testWriteStored(operations, api);
  }

  /**
   * Ends the facet `facetName` names, whatever it runs: the next call constructs the class again
   * over the same storage, so what was written since is what that construction finds.
   */
  async restartFacet(facetName: string): Promise<void> {
    this.ctx.facets.abort(facetName, new Error("Restarted by the test."));
  }
}

type TestDurableObjectState = { ctx: { storage: DurableObjectStorage } };

/** The standalone file gatekeepers whose stored layout the tests pin. */
type StoredGatekeeper = "doc" | "sheets" | "slides";

/**
 * A value as the synchronous KV and the asynchronous storage API each read it, as JSON text so that
 * any value crosses RPC; absent where nothing is stored.
 */
type StoredValue = { kv?: string; async?: string };

/** Hooks on each standalone file gatekeeper that read and write its storage directly. */
type StoredLayoutHooks = {
  testStoredKeys(): string[];
  testStoredValue(key: string): Promise<StoredValue>;
  testWriteStored(operations: StorageOperation[], api: "kv" | "async"): Promise<void>;
};

const storedLayoutHooks: StoredLayoutHooks & ThisType<TestDurableObjectState> = {
  testStoredKeys() {
    return [...this.ctx.storage.kv.list()].map(([key]) => key);
  },
  async testStoredValue(key) {
    let kv = this.ctx.storage.kv.get(key);
    let read = await this.ctx.storage.get(key);
    return {
      ...kv === undefined ? {} : { kv: JSON.stringify(kv) },
      ...read === undefined ? {} : { async: JSON.stringify(read) },
    };
  },
  async testWriteStored(operations, api) {
    for (let { key, value } of operations) {
      if (api === "kv") this.ctx.storage.kv.put(key, value);
      else await this.ctx.storage.put(key, value);
    }
  },
};
for (let gatekeeper of [GoogleDocGatekeeperImpl, GoogleSheetsGatekeeperImpl, GoogleSlidesGatekeeperImpl]) {
  Object.assign(gatekeeper.prototype, storedLayoutHooks);
}

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
  testQueued(): number[];
  testAttempts(): Record<number, WriteAttempt>;
  ageTestAttempt(id: number, ms: number): void;
  testStored(key: string): string | null;
  writeTestStored(key: string, json: string | null): void;
  testStoredKeys(prefix: string): string[];
  retireTestActions(count: number): void;
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).retireTestActions = function(
  count: number,
): void {
  // A second journal over the same storage, which the live one reads afresh on every call.
  let journal = new ActionJournal((this as unknown as TestDurableObjectState).ctx.storage.kv,
    { namespace: "drive" });
  for (let i = 0; i < count; i++) {
    let id = journal.allocate({ kind: "createComment", payload: {} });
    journal.markSubmitted(id);
    journal.retire(id);
  }
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).testStored = function(
  key: string,
): string | null {
  let value = (this as unknown as TestDurableObjectState).ctx.storage.kv.get(key);
  return value === undefined ? null : JSON.stringify(value);
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).writeTestStored = function(
  key: string, json: string | null,
): void {
  let { kv } = (this as unknown as TestDurableObjectState).ctx.storage;
  if (json === null) kv.delete(key);
  else kv.put(key, JSON.parse(json));
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).testStoredKeys = function(
  prefix: string,
): string[] {
  let { kv } = (this as unknown as TestDurableObjectState).ctx.storage;
  return [...kv.list({ prefix })].map(([key]) => key);
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

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).testQueued = function(
): number[] {
  let storage = (this as unknown as TestDurableObjectState).ctx.storage;
  return new ActionJournal(storage.kv, { namespace: "drive" }).listPending().map(({ id }) => id);
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).testAttempts = function(
): Record<number, WriteAttempt> {
  let storage = (this as unknown as TestDurableObjectState).ctx.storage;
  return Object.fromEntries([...storage.kv.list<WriteAttempt>({ prefix: WRITE_ATTEMPT_PREFIX })]
    .map(([key, attempt]) => [Number(key.slice(WRITE_ATTEMPT_PREFIX.length)), attempt]));
};

(GoogleDriveGatekeeperImpl.prototype as TestGoogleDriveGatekeeper).ageTestAttempt = function(
  id: number, ms: number,
): void {
  let kv = (this as unknown as TestDurableObjectState).ctx.storage.kv;
  let key = `${WRITE_ATTEMPT_PREFIX}${id}`;
  let attempt = kv.get<WriteAttempt>(key);
  if (!attempt) throw new Error(`No attempt marker for action ${id}`);
  kv.put(key, { ...attempt, at: attempt.at - ms });
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
