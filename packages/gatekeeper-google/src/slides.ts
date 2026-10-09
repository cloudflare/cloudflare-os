import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import { unguardedNativeRead, type NativeRead } from "./drive-session";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { batchKind, SLIDES_ACTIONS } from "./slides-actions";
import { GoogleSlidesApi, type ThumbnailSize } from "./slides-api";
import { layoutNames, presentationInfo, slideIds, slideOf, titleOf } from "./slides-model";
import type {
  PresentationInfo, Slide, SlideThumbnail, SlideThumbnailSize,
} from "./slides-read-types";
import { designDeck, type DesignStep } from "./slides-design";
import { prepareChanges } from "./slides-design-input";
import {
  batchSlides, conflictReason, mintObjectId, movedOrder, replayChanges, slidesToFetch,
  type Deck, type QueuedChange, type SlideLabel, type SlidesAction, type SlidesActions,
} from "./slides-simulation";
import { elementIdsOf } from "./slides-target";
import { ChangeConflict } from "./slides-text";
import type { GooglePresentationReadSession } from "./slides-read-types";
import type { GooglePresentationSession, SlideChange } from "./slides-types";
import { SLIDES_TYPES_MODULE_PREFIX, stripTypeModulePrefix } from "./type-bundle";
import SLIDES_READ_TYPES_CODE from "./slides-read-types.txt";
import SLIDES_TYPES_CODE from "./slides-types.txt";

const MAX_SLIDES_PER_READ = 20;
// Each slide's page is capped, but 20 of them could still outgrow Workers' 32 MiB RPC limit. This
// counts UTF-16 units of the result's JSON, so even at three UTF-8 bytes a unit it stays under.
const MAX_SLIDES_READ_LENGTH = 8 * 1024 * 1024;
const THUMBNAIL_SIZES = {
  small: "SMALL", medium: "MEDIUM", large: "LARGE",
} as const satisfies Record<SlideThumbnailSize, ThumbnailSize>;
const MAX_SLIDES_PER_MOVE = 100;
// A queued change is one Durable Object KV value, which may not exceed 128 KiB serialized.
const MAX_CHANGE_BYTES = 100 * 1024;

type Env = Cloudflare.Env;

let slidesTypesCode: string | undefined;

/** The agent declarations for a directly bound presentation. */
export function getGoogleSlidesTypesCode(): string {
  return slidesTypesCode ??= [
    SLIDES_READ_TYPES_CODE,
    stripTypeModulePrefix(SLIDES_TYPES_CODE, SLIDES_TYPES_MODULE_PREFIX),
  ].join("\n");
}

export type GoogleSlidesGatekeeperImplProps = {
  userObjectId: string;
  presentationId: string;
};

/** What a session needs of its gatekeeper to show and queue changes. */
export type SlidesChangeQueue = {
  /**
   * Runs `read` with the changes awaiting a decision, oldest first, while none is being applied
   * or rejected. A change Google commits mid-read would otherwise show twice: once in what Google
   * returns, and again replayed on top. Nor is a claimed change, which cannot be mid-apply here: an
   * activation died applying it, so whether Google has it is unknown.
   */
  snapshot<T>(read: (pending: readonly QueuedChange[]) => Promise<T>): Promise<T>;
  /**
   * Runs `prepare` while no other change is being prepared, then queues the change it returns for
   * approval. A change is checked against the simulation it extends, so two at once could each
   * pass against a state the other invalidates.
   */
  queue<K extends keyof SlidesActions, T>(
    kind: K, prepare: () => Promise<{ payload: SlidesActions[K]; result: T }>,
  ): Promise<T>;
};

/** Lets reads overlap each other, but not a change being applied or rejected. */
class ReadGate {
  #reads = new Set<Promise<unknown>>();
  #resolving: Promise<unknown> = Promise.resolve();

  async read<T>(body: () => Promise<T>): Promise<T> {
    // Waits out resolutions queued while it waited, too, so none starts under the read.
    let resolving;
    do await (resolving = this.#resolving); while (resolving !== this.#resolving);
    let reading = body();
    this.#reads.add(reading);
    try {
      return await reading;
    } finally {
      this.#reads.delete(reading);
    }
  }

  /** Runs `body` once earlier resolutions and every read in progress have settled. */
  resolve<T>(body: () => Promise<T>): Promise<T> {
    let resolving = Promise.allSettled([this.#resolving, ...this.#reads]).then(body);
    this.#resolving = resolving.catch(() => {});
    return resolving;
  }
}

@validateRpc()
export class GoogleSlidesGatekeeperImpl
    extends DurableObject<Env, GoogleSlidesGatekeeperImplProps>
    implements Gatekeeper<GooglePresentationSession> {
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId),
    );
    return account.getAccessToken(opts);
  });

  #api = new GoogleSlidesApi((opts?: AccessTokenRequest) => this.#tokens.get(opts));
  #journal = new ActionJournal<SlidesAction>(this.ctx.storage.kv, { namespace: "slides" });
  #actions = SLIDES_ACTIONS.bind(
    this.#journal, { api: this.#api, presentationId: this.ctx.props.presentationId });
  #reads = new ReadGate();
  #preparing = new SerialTaskQueue();
  #inPreparation = 0;

  async describe(): Promise<ResourceDescription> {
    let title = await this.#api.getPresentationTitle(this.ctx.props.presentationId) ??
      "Untitled presentation";
    return {
      url: `https://docs.google.com/presentation/d/${this.ctx.props.presentationId}/edit`,
      title,
      snippet: `Google Slides presentation: ${title}`,
      suggestedBindingName: "GOOGLE_SLIDES",
      tsType: "GooglePresentationSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleSlidesTypesCode();
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions.autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GooglePresentationSession> {
    let queue = approvalQueue.dup();
    // A presentation binding's scope is the one presentation, so there is nothing to revalidate.
    return new GooglePresentationSessionImpl(
      this.#api, this.ctx.props.presentationId, queue,
      unguardedNativeRead(description => queue.authorizeObservation(description)),
      {
        snapshot: read => this.#reads.read(() => read(this.#journal.listUndecided())),
        queue: (kind, prepare) => this.#prepareExclusively(async () => {
          let { payload, result } = await prepare();
          // Storage serializes a string holding any non-Latin-1 character at two bytes a unit.
          let bytes = JSON.stringify(payload).length * 2;
          if (bytes > MAX_CHANGE_BYTES) {
            throw new Error(`This change is too large to queue (${bytes} bytes, limit ` +
              `${MAX_CHANGE_BYTES}). Split it up.`);
          }
          await this.#actions.submit(queue, kind, payload);
          return result;
        }),
      },
    );
  }

  #prepareExclusively<T>(body: () => Promise<T>): Promise<T> {
    this.#inPreparation++;
    return this.#preparing.run(body).finally(() => this.#inPreparation--);
  }

  applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.#reads.resolve(async () => {
      // Each change was checked against those queued before it, so they apply in that order. A
      // decided or failed change is left to the action set, which answers it without a write.
      let state = this.#journal.get(actionId)?.state;
      let earlier = (state === "staged" || state === "pending") &&
        this.#journal.listPending().find(({ id }) => id < actionId);
      if (earlier) {
        throw new Error(
          `Google Slides changes apply in the order they were queued. Approve or reject change ` +
          `${earlier.id} first.`);
      }
      await this.#actions.apply(actionId);
    });
  }

  rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    return this.#reads.resolve(async () => {
      let pending = this.#journal.listPending();
      let shown = pending.some(({ id }) => id === actionId);
      // Changes queued or being prepared after it were checked against it, and the gadget has
      // read them on top of it.
      let builtOn = pending.at(-1)?.id !== actionId || this.#inPreparation > 0;
      await this.#actions.reject(actionId);
      if (shown && builtOn) return { restart: true };
    });
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("Google Slides changes cannot be reverted automatically.");
  }

  /**
   * Observer tracking — strategy B (ACL check, single unit). Google applies sharing permissions at
   * presentation granularity, so an observer must be able to open this presentation with their
   * own account. The overseer re-runs this check on every open, catching revoked access.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasPresentationAccess(this.ctx.props.presentationId))) {
      throw new Error(
        "This collaborator does not have access to the bound Google Slides presentation, so they " +
        "cannot observe data this workspace read from it.",
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

/** A read with queued changes applied, and the first that no longer applies. */
function replayed(base: Deck, changes: readonly QueuedChange[]): { deck: Deck; conflict?: string } {
  let result = replayChanges(base, changes);
  return result.kind === "complete"
    ? { deck: result.value }
    : { deck: result.partial, conflict: conflictReason(result.unsupported, result.reason) };
}

function asError(error: unknown): never {
  if (error instanceof ChangeConflict) {
    throw new Error(`${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.`);
  }
  throw error;
}

/** One slide's place and title, for the approver. */
function labelOf(deck: Deck, id: string): SlideLabel {
  let slide = deck.slides.get(id);
  let title = slide && titleOf(slide);
  return { number: deck.order.indexOf(id) + 1, ...(title ? { title } : {}) };
}

@validateRpc()
export class GooglePresentationSessionImpl extends RpcTarget implements GooglePresentationSession {
  #api: GoogleSlidesApi;
  #presentationId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #read: NativeRead;
  #changes: SlidesChangeQueue;

  constructor(
    api: GoogleSlidesApi,
    presentationId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    read: NativeRead,
    changes: SlidesChangeQueue,
  ) {
    super();
    this.#api = api;
    this.#presentationId = presentationId;
    this.#approvalQueue = approvalQueue;
    this.#read = read;
    this.#changes = changes;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  /**
   * The slide order and the content of `ids`, with queued changes applied. A slide that no longer
   * exists, or never did, is absent from `deck.order`.
   */
  async #simulated(ids: readonly string[]) {
    return this.#changes.snapshot(async changes => {
      let outline = await this.#api.getOutline(this.#presentationId);
      let order = slideIds(outline);
      return {
        title: outline.title ?? "Untitled presentation",
        // Google reports the revision only to an account that can edit the presentation.
        editable: outline.revisionId !== undefined,
        layouts: layoutNames(outline),
        ...replayed({
          order, slides: await this.#api.getSlides(this.#presentationId, slidesToFetch(ids, changes), order),
        }, changes),
      };
    });
  }

  /**
   * Reads `ids` to prepare a change, refusing one that is absent, that a conflict blocks, or that
   * the account may not make.
   */
  async #prepare(ids: readonly string[], purpose: string) {
    let simulated = await this.#read(
      () => this.#simulated(ids),
      ({ title }) => ({
        title: "Read Google Slides slides to change them",
        description: `Read ${ids.length} slide(s) in "${title}" to ${purpose}.`,
      }));
    // Reported after authorization, since it reveals which slides exist.
    let missing = ids.find(id => !simulated.deck.order.includes(id));
    if (missing !== undefined) throw noSlide(missing, simulated.title);
    if (!simulated.editable) {
      throw new Error(
        `The connected Google account can view "${simulated.title}" but not edit it, so no change ` +
        "to it can be queued.");
    }
    if (simulated.conflict) {
      throw new Error(`${simulated.conflict} No more changes can be queued until it is rejected.`);
    }
    return simulated;
  }

  async getPresentation(): Promise<PresentationInfo> {
    return this.#read(
      () => this.#changes.snapshot(async changes => {
        let rest = await this.#api.getPresentation(this.#presentationId);
        let order = slideIds(rest);
        // A summary holds no tables or grouped shapes, so slides queued edits address are read in
        // full, and every edit is checked as it would be when approved.
        let edited = changes.flatMap(({ action }) => batchSlides(action));
        let slides = new Map([
          ...(rest.slides ?? []).map(slide => [slide.objectId!, slide] as const),
          ...await this.#api.getSlides(this.#presentationId, slidesToFetch(edited, changes), order),
        ]);
        let { deck, conflict } = replayed({ order, slides }, changes);
        return {
          ...presentationInfo({ ...rest, slides: deck.order.map(id => deck.slides.get(id)!) }),
          ...(conflict ? { queuedChangeConflict: conflict } : {}),
        };
      }),
      info => ({
        title: "Read Google Slides presentation outline",
        description:
          `Read the outline of "${info.title}": its ${info.slides.length} slide(s), their ` +
          "layouts, and their titles.",
      }));
  }

  async getSlides(ids: string[]): Promise<Slide[]> {
    if (ids.length === 0 || ids.length > MAX_SLIDES_PER_READ) {
      throw new Error(`Request between 1 and ${MAX_SLIDES_PER_READ} slides at a time.`);
    }
    // Each slide is fetched on its own, so a read costs what it returns, not the whole deck. An
    // unknown ID is reported only after authorization, since that reveals which slides exist.
    let read = await this.#read(
      async () => {
        let { title, layouts, deck, conflict } = await this.#simulated(ids);
        let missing = ids.find(id => !deck.order.includes(id) || !deck.slides.has(id));
        let slides = missing !== undefined ? [] : ids.map(id => ({
          ...slideOf(deck.slides.get(id)!, deck.order.indexOf(id), layouts),
          ...(conflict ? { queuedChangeConflict: conflict } : {}),
        }));
        if (JSON.stringify(slides).length > MAX_SLIDES_READ_LENGTH) {
          throw new Error(`These ${ids.length} slides are too large to read at once. Request fewer.`);
        }
        return { title, missing, slides };
      },
      ({ title }) => ({
        title: ids.length === 1
          ? "Read one Google Slides slide"
          : `Read ${ids.length} Google Slides slides`,
        description: `Read the text and speaker notes of ${ids.length} slide(s) in "${title}".`,
      }));
    if (read.missing !== undefined) throw noSlide(read.missing, read.title);
    return read.slides;
  }

  async getSlideThumbnail(
    slideId: string, size: SlideThumbnailSize = "medium",
  ): Promise<SlideThumbnail> {
    // The render happens inside the read, so a scope check bracketing it covers the image too.
    let { title, thumbnail } = await this.#read(
      async () => {
        let outline = await this.#api.getOutline(this.#presentationId);
        let index = slideIds(outline).indexOf(slideId);
        let thumbnail = index < 0 ? undefined : await this.#api.getThumbnail(
          this.#presentationId, slideId, THUMBNAIL_SIZES[size]);
        return { title: outline.title ?? "Untitled presentation", index, thumbnail };
      },
      ({ title, index }) => ({
        title: "Render a Google Slides slide",
        description:
          `Render an image of ${index < 0 ? "a slide" : `slide ${index + 1}`} in "${title}".`,
      }));
    if (thumbnail) return { mimeType: "image/png", ...thumbnail };
    let queuedCopy = await this.#changes.snapshot(async changes => changes.some(({ action }) =>
      action.kind === "duplicateSlide" && action.payload.newSlideId === slideId));
    if (queuedCopy) {
      throw new Error(
        `Slide "${slideId}" is a copy awaiting approval, so it cannot be rendered until it exists.`);
    }
    throw noSlide(slideId, title);
  }

  async updateSlides(changes: SlideChange[]): Promise<Record<string, string>> {
    let { changes: prepared, refs } = prepareChanges(changes);
    let ids = [...new Set(changes.map(change => change.slideId))];
    return this.#changes.queue(batchKind(prepared), async () => {
      let { deck } = await this.#prepare(ids, "queue changes to them");
      let existing = new Set(ids.flatMap(id => elementIdsOf(deck.slides.get(id)?.pageElements)));
      let shadowing = Object.keys(refs).find(ref => existing.has(ref));
      if (shadowing !== undefined) {
        throw new Error(`The ref "${shadowing}" is also an element's ID. Name the new element otherwise.`);
      }
      let steps: (DesignStep | null)[];
      try {
        steps = designDeck(deck, prepared).steps;
      } catch (error) {
        asError(error);
      }
      let queued = prepared.map((change, i) => {
        let { previous, text } = steps[i]!;
        if (change.op === "editText" && text === previous) {
          throw new Error(`Change ${i + 1} (editText) leaves the text as it is.`);
        }
        // Text addressed by offsets, or replaced whole, guards on what it was, so an edit made
        // since is not overwritten or misaddressed.
        let guarded = "range" in change && change.range !== undefined ||
          change.op === "editText" && change.find === undefined;
        return guarded ? { ...change, before: previous } : change;
      });
      return {
        payload: {
          changes: queued,
          slides: Object.fromEntries(ids.map(id => [id, labelOf(deck, id)])),
        },
        result: refs,
      };
    });
  }

  async duplicateSlide(slideId: string): Promise<string> {
    return this.#changes.queue("duplicateSlide", async () => {
      let { deck } = await this.#prepare([slideId], "queue copying one");
      let source = deck.slides.get(slideId)!;
      let newSlideId = mintObjectId();
      // Minted here rather than by Google, so changes queued to the copy can name its elements.
      let objectIds = Object.fromEntries(
        elementIdsOf(source.pageElements).map(id => [id, mintObjectId()]));
      return {
        payload: { slideId, newSlideId, objectIds, slide: labelOf(deck, slideId) },
        result: newSlideId,
      };
    });
  }

  async deleteSlide(slideId: string): Promise<void> {
    await this.#changes.queue("deleteSlide", async () => {
      let { deck } = await this.#prepare([slideId], "queue deleting one");
      return { payload: { slideId, slide: labelOf(deck, slideId) }, result: undefined };
    });
  }

  async moveSlides(slideIds: string[], after: string | null): Promise<void> {
    if (slideIds.length === 0 || slideIds.length > MAX_SLIDES_PER_MOVE) {
      throw new Error(`Move between 1 and ${MAX_SLIDES_PER_MOVE} slides at a time.`);
    }
    if (new Set(slideIds).size !== slideIds.length) throw new Error("A slide is listed twice.");
    await this.#changes.queue("moveSlides", async () => {
      let ids = after === null ? slideIds : [...slideIds, after];
      let { deck } = await this.#prepare(ids, "queue moving them");
      let moved: string[];
      try {
        moved = movedOrder(deck.order, slideIds, after);
      } catch (error) {
        asError(error);
      }
      if (moved.every((id, i) => deck.order[i] === id)) {
        throw new Error("Those slides are already in that position.");
      }
      let moving = new Set(slideIds);
      return {
        payload: {
          slideIds,
          after,
          slides: deck.order.filter(id => moving.has(id)).map(id => labelOf(deck, id)),
          ...(after === null ? {} : { afterSlide: labelOf(deck, after) }),
        },
        result: undefined,
      };
    });
  }
}

/** What a read-only presentation reads through: nothing is ever queued against it. */
const NO_CHANGES: SlidesChangeQueue = {
  snapshot: read => read([]),
  queue: () => Promise.reject(new Error("This Google Slides presentation is open read-only.")),
};

/**
 * A presentation opened read-only, as Drive opens one. It holds the read/write session rather than
 * extending it, so its RPC surface has no write method to call: the reads are the same code, run
 * against no queued changes.
 */
@validateRpc()
export class GooglePresentationReadSessionImpl extends RpcTarget
    implements GooglePresentationReadSession {
  #session: GooglePresentationSessionImpl;

  constructor(
    api: GoogleSlidesApi,
    presentationId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    read: NativeRead,
  ) {
    super();
    this.#session = new GooglePresentationSessionImpl(
      api, presentationId, approvalQueue, read, NO_CHANGES);
  }

  [Symbol.dispose](): void {
    this.#session[Symbol.dispose]();
  }

  getPresentation(): Promise<PresentationInfo> {
    return this.#session.getPresentation();
  }

  getSlides(slideIds: string[]): Promise<Slide[]> {
    return this.#session.getSlides(slideIds);
  }

  getSlideThumbnail(slideId: string, size?: SlideThumbnailSize): Promise<SlideThumbnail> {
    return this.#session.getSlideThumbnail(slideId, size);
  }
}

function noSlide(id: string, title: string): Error {
  return new Error(`No slide with ID "${id}" in "${title}". Call getPresentation() for slide IDs.`);
}
