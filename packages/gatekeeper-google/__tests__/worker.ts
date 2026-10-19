import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ActionField, ActionKind, ApprovalQueue, Gatekeeper, GitCache, HookController,
  HookDescription, ObservationDescription, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { TestGitCache } from "./test-git-cache";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { GoogleAccessToken } from "../src/google-api";
import type { GoogleDocSession, GoogleDocTab } from "../src/docs-types";
import type { MarkerEntry } from "../src/sheets-actions";
import type { SpreadsheetInfo, SpreadsheetRange } from "../src/sheets-read-types";
import type { GoogleSpreadsheetSession } from "../src/sheets-types";
import type { PresentationInfo, Slide } from "../src/slides-read-types";
import type { GooglePresentationSession } from "../src/slides-types";
import type { GoogleGroup, GoogleGroupInfo, GoogleGroupsSession } from "../src/groups-types";
import GoogleWorker, {
  GatekeeperVendor, GoogleDocGatekeeperImpl, GoogleGroupsGatekeeperImpl, GoogleSheetsGatekeeperImpl,
  GoogleSlidesGatekeeperImpl, GoogleVerifier,
} from "../src/google";

export {
  GatekeeperVendor, GoogleDocGatekeeperImpl, GoogleGroupsGatekeeperImpl, GoogleSheetsGatekeeperImpl,
  GoogleSlidesGatekeeperImpl, GoogleVerifier,
};
export default GoogleWorker;

export class UserAccount extends DurableObject<Env> {
  /** Names the account in its token, so a provider fake can tell which account a request was made as. */
  async getAccessToken(): Promise<GoogleAccessToken> {
    return { token: `test-access-token:${this.ctx.id}`, expires: new Date(8640000000000000) };
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

/** An error's message, so a test can assert on a failure that crossed the RPC boundary. */
function failure(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

function disposeRpc(value: unknown): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  (value as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
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

  #groups(facetName: string, groupEmail?: string) {
    let userObjectId = this.ctx.exports.UserAccount.idFromName("test-user").toString();
    return this.ctx.facets.get<GoogleGroupsGatekeeperImpl>(facetName, () => ({
      class: this.ctx.exports.GoogleGroupsGatekeeperImpl({
        props: { userObjectId, ...(groupEmail !== undefined ? { groupEmail } : {}) },
      }),
    }));
  }

  async groupsDescribe(facetName: string, groupEmail?: string)
      : Promise<ResourceDescription | { error: string }> {
    try {
      return await this.#groups(facetName, groupEmail).describe();
    } catch (error) {
      return failure(error);
    }
  }

  /** The bound group's metadata and members, read through a fresh session of a single-group binding. */
  async groupsRead(facetName: string, groupEmail: string)
      : Promise<{ info?: GoogleGroupInfo; members?: string[]; error?: string; observations: string[] }> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    try {
      using group = await this.#groups(facetName, groupEmail).startSession(
        approvalQueue as unknown as ApprovalQueue) as GoogleGroup & Disposable;
      let info = await group.getInfo();
      using cursor = await group.listMembers() as Awaited<ReturnType<GoogleGroup["listMembers"]>> & Disposable;
      let members: string[] = [];
      for (let page = await cursor.next(); page !== null; page = await cursor.next()) {
        members.push(...page.map(member => member.email));
      }
      return { info, members, observations: queue.observations };
    } catch (error) {
      return { ...failure(error), observations: queue.observations };
    }
  }

  /** What calling each account-wide method on a single-group binding's session does. */
  async groupsAccountMethodsOnGroup(facetName: string, groupEmail: string): Promise<string[]> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    using group = await this.#groups(facetName, groupEmail).startSession(
      approvalQueue as unknown as ApprovalQueue) as unknown as
        Record<string, (argument: string) => Promise<unknown>> & Disposable;
    let outcomes: string[] = [];
    for (let [method, argument] of [
      ["searchGroups", "team"], ["listGroupsOf", "ada@example.com"], ["getGroup", "other@example.com"],
    ]) {
      try {
        let result = await group[method](argument);
        disposeRpc(result);
        outcomes.push(`${method}: returned`);
      } catch (error) {
        outcomes.push(`${method}: ${failure(error).error}`);
      }
    }
    return outcomes;
  }

  /** Searches through a fresh session of a whole-account binding, draining the cursor. */
  async groupsSearch(facetName: string, query: string)
      : Promise<{ emails?: string[]; error?: string; observations: string[] }> {
    let queue = new TestApprovalQueue();
    using approvalQueue = new RpcStub<ApprovalQueue>(queue);
    try {
      using session = await this.#groups(facetName).startSession(
        approvalQueue as unknown as ApprovalQueue) as GoogleGroupsSession & Disposable;
      using cursor = await session.searchGroups(query) as Awaited<ReturnType<GoogleGroupsSession["searchGroups"]>> & Disposable;
      let emails: string[] = [];
      for (let page = await cursor.next(); page !== null; page = await cursor.next()) {
        for (let entry of page) {
          emails.push(entry.info.email);
          (entry.group as unknown as Disposable)[Symbol.dispose]();
        }
      }
      return { emails, observations: queue.observations };
    } catch (error) {
      return { ...failure(error), observations: queue.observations };
    }
  }

  /** Why the Groups binding refuses `observer`'s own account as a collaborator, or null if it admits it. */
  async groupsAddObserver(facetName: string, groupEmail: string | undefined, observer: string)
      : Promise<string | null> {
    let userObjectId = this.ctx.exports.UserAccount.idFromName(observer).toString();
    try {
      await this.#groups(facetName, groupEmail).addObserver(
        "observer-1", this.ctx.exports.GoogleVerifier({ props: { userObjectId } }));
      return null;
    } catch (error) {
      return failure(error).error;
    }
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
