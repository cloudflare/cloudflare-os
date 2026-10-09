import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ActionField, ActionKind, ApprovalQueue, GitCache, HookController,
  HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { TestGitCache } from "./test-git-cache";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { GoogleAccessToken } from "../src/google-api";
import type { GoogleDocSession, GoogleDocTab } from "../src/docs-types";
import type { PresentationInfo, Slide } from "../src/slides-read-types";
import type { GooglePresentationSession } from "../src/slides-types";
import GoogleWorker, { GoogleDocGatekeeperImpl, GoogleSlidesGatekeeperImpl } from "../src/google";

export { GoogleDocGatekeeperImpl, GoogleSlidesGatekeeperImpl };
export default GoogleWorker;

export class UserAccount extends DurableObject<Env> {
  async getAccessToken(): Promise<GoogleAccessToken> {
    return { token: "test-access-token", expires: new Date(8640000000000000) };
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
      class: this.ctx.exports.GoogleDocGatekeeperImpl({
        props: { userObjectId, documentId: "doc-1" } satisfies GatekeeperProps,
      }),
    }));
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
      class: this.ctx.exports.GoogleSlidesGatekeeperImpl({
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
