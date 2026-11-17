import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
  UiFile,
} from "@gadgets/workshop-shared/gatekeeper";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import {
  boundProps, createFileOnce, isSimulated, UNCREATED_FILE_ID, type SimulatedFileProps,
} from "./creation";
import { DriveApi } from "./drive-api";
import { unguardedNativeRead, type NativeRead } from "./drive-session";
import { requireFileSubresources } from "./file-subresources";
import { verifyGoogleSubresourceAccess, type GoogleVerifierApi } from "./google-verifier-types";
import { Mutex } from "./mutex";
import { explainUnopenedFile } from "./office-conversion";
import { QueuedChanges } from "./queued-changes";
import SLIDES_PREVIEW_CLIENT from "./previews/slides/client.txt";
import SLIDES_PREVIEW_SHAPES from "./previews/slides/shapes.txt";
import SLIDES_PREVIEW_SLIDE from "./previews/slides/slide.txt";
import { SHARED_PREVIEW_FILES } from "./previews/shared-files";
import { nativeFileUrl } from "./resources";
import { batchKind, SLIDES_ACTIONS } from "./slides-actions";
import {
  BlankPresentation, GoogleSlidesApi, type PresentationReader, type RestPresentation,
  type ThumbnailSize,
} from "./slides-api";
import { drawSlide, fontsOf, type DrawnPage, type ElementChanges } from "./slides-drawing";
import {
  exportFor, logLoss, needsExport, releaseExport, resolveGeometry, type ShapeGeometry,
} from "./slides-export";
import { DRAWN_SLIDE_FIELDS } from "./slides-fields";
import { emu, points } from "./slides-geometry";
import { downloadFont, downloadPicture, isFontRequest, picturePixels } from "./slides-media";
import {
  layoutNames, mastersOf, presentationInfo, slideIds, slideOf, themePagesOf, titleOf,
} from "./slides-model";
import type {
  PresentationInfo, Slide, SlideThumbnail, SlideThumbnailSize,
} from "./slides-read-types";
import { designDeck, pageOf, slideIdOf, type DesignChange, type DesignStep } from "./slides-design";
import { prepareChanges } from "./slides-design-input";
import {
  batchSlides, conflictReason, instantiatedPlaceholders, isDesignBatch, mintObjectId, movedOrder,
  newSlidePlace, replayChanges, slidesToFetch, type Deck, type QueuedChange, type SlideLabel,
  type SlidesAction, type SlidesActions, type ThemeLabel,
} from "./slides-simulation";
import { elementIdsOf } from "./slides-target";
import { ChangeConflict } from "./slides-text";
import type { GooglePresentationReadSession } from "./slides-read-types";
import type {
  DrawnElement, DrawnSlide, GooglePresentationRenderingReads, SlideDrawing, SlideDrawings, SlideFont,
  SlidePictureBytes,
} from "./slides-rendering-types";
import type {
  GooglePresentationSession, PresentationPendingChange, PresentationPendingChanges, SlideChange,
} from "./slides-types";
import {
  SLIDES_RENDERING_TYPES_MODULE_PREFIX, SLIDES_TYPES_MODULE_PREFIX, stripTypeModulePrefix,
} from "./type-bundle";
import SLIDES_READ_TYPES_CODE from "./slides-read-types.txt";
import SLIDES_RENDERING_TYPES_CODE from "./slides-rendering-types.txt";
import SLIDES_TYPES_CODE from "./slides-types.txt";

const MAX_SLIDES_PER_READ = 20;
// Each slide's page is capped, but 20 of them could still outgrow Workers' 32 MiB RPC limit. This
// counts UTF-16 units of the result's JSON, so even at three UTF-8 bytes a unit it stays under.
const MAX_SLIDES_READ_LENGTH = 8 * 1024 * 1024;
const THUMBNAIL_SIZES = {
  small: "SMALL", medium: "MEDIUM", large: "LARGE",
} as const satisfies Record<SlideThumbnailSize, ThumbnailSize>;
// A move or skip names each of its slides to the approver.
const MAX_SLIDES_PER_CHANGE = 100;
// As many as a preview asks for at once, which keeps an answer well inside what one call returns.
// Each is fetched on its own, like the slides of any other read.
const MAX_DRAWINGS_PER_READ = 10;

type Env = Cloudflare.Env;

let slidesTypesCode: string | undefined;

/** The agent declarations for a directly bound presentation. */
export function getGoogleSlidesTypesCode(): string {
  return slidesTypesCode ??= [
    SLIDES_READ_TYPES_CODE,
    stripTypeModulePrefix(SLIDES_TYPES_CODE, SLIDES_TYPES_MODULE_PREFIX),
  ].join("\n");
}

export type GoogleSlidesGatekeeperImplProps =
  { userObjectId: string; presentationId: string } | SimulatedFileProps;

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

@validateRpc()
export class GoogleSlidesGatekeeperImpl
    extends DurableObject<Env, GoogleSlidesGatekeeperImplProps>
    implements Gatekeeper<GooglePresentationSession> {
  #creating = new Mutex();
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.#bound.userObjectId),
    );
    return account.getAccessToken(opts);
  });

  #api = new GoogleSlidesApi((opts?: AccessTokenRequest) => this.#tokens.get(opts));
  #drive = new DriveApi((opts?: AccessTokenRequest) => this.#tokens.get(opts));
  #presentationId = isSimulated(this.ctx.props) ? UNCREATED_FILE_ID : this.ctx.props.presentationId;
  #journal = new ActionJournal<SlidesAction>(this.ctx.storage.kv, { namespace: "slides" });
  #actions = SLIDES_ACTIONS.bind(this.#journal, { api: this.#api, presentationId: this.#presentationId });
  #changes = new QueuedChanges<SlidesAction>({
    journal: this.#journal,
    select: action => action,
    outOfOrder: earlier => "Google Slides changes apply in the order they were queued. Approve or " +
      `reject change ${earlier} first.`,
  });

  /** The account and presentation this binding reaches, which one not yet created has not. */
  get #bound(): { userObjectId: string; presentationId: string } {
    return boundProps(this.ctx.props, "slides");
  }

  async describe(): Promise<ResourceDescription> {
    let props = this.ctx.props;
    if (isSimulated(props)) {
      let { title } = props.creation;
      return {
        url: nativeFileUrl("slides"),
        title,
        snippet: `Google Slides presentation: ${title} (not created yet)`,
        suggestedBindingName: "GOOGLE_SLIDES",
        tsType: "GooglePresentationSession",
        hasPreview: true,
      };
    }
    let title = await this.#api.getPresentationTitle(props.presentationId)
      .catch(async (error: unknown) => {
        throw await explainUnopenedFile(
          "slides", error, async () => (await this.#drive.getFile(props.presentationId)).mimeType);
      }) ?? "Untitled presentation";
    return {
      url: nativeFileUrl("slides", props.presentationId),
      title,
      snippet: `Google Slides presentation: ${title}`,
      suggestedBindingName: "GOOGLE_SLIDES",
      tsType: "GooglePresentationSession",
      hasPreview: true,
    };
  }

  /** The files of the presentation preview: gadget-format client code that reads through a session. */
  async getPreviewUi(): Promise<UiFile[]> {
    return [
      { path: "client.js", code: SLIDES_PREVIEW_CLIENT },
      { path: "slide.js", code: SLIDES_PREVIEW_SLIDE },
      { path: "shapes.js", code: SLIDES_PREVIEW_SHAPES },
      ...SHARED_PREVIEW_FILES,
    ];
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleSlidesTypesCode();
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions.autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GooglePresentationSession> {
    let props = this.ctx.props;
    let queue = approvalQueue.dup();
    // A presentation binding's scope is the one presentation, so there is nothing to revalidate.
    // Every read reports it, except one not created yet, which holds only what the caller wrote.
    return new GooglePresentationSessionImpl(
      isSimulated(props) ? new BlankPresentation(props.creation.title) : this.#api,
      this.#presentationId,
      queue,
      unguardedNativeRead(description => queue.authorizeObservation(description),
        isSimulated(props) ? [] : [{ kind: "presentation", fileId: props.presentationId }]),
      {
        snapshot: read => this.#changes.snapshot(read),
        queue: (kind, prepare) =>
          this.#changes.queue(prepare, payload => this.#actions.submit(queue, kind, payload)),
      },
    );
  }

  async applyCreation(creator: Fetcher<GatekeeperUserVerifier>, configuration: string | null)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    return this.#creating.run(async () => {
      let { userObjectId, fileId, resourceUrl } = await createFileOnce(
          this.ctx, creator, "slides", configuration,
          (title, tokens) => new GoogleSlidesApi(tokens).createPresentation(title));
      return {
        class: this.ctx.exports.GoogleSlidesGatekeeperImpl({props: {userObjectId, presentationId: fileId}}),
        resourceUrl,
      };
    });
  }

  applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.#changes.apply(actionId, () => this.#actions.apply(actionId));
  }

  rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    return this.#changes.reject(actionId, () => this.#actions.reject(actionId));
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("Google Slides changes cannot be reverted automatically.");
  }

  /**
   * Observer tracking — strategy B (ACL check, single unit). Google applies sharing permissions at
   * presentation granularity, so an observer must be able to open this presentation with their
   * own account. The overseer re-runs this check on every open, catching revoked access.
   *
   * Reads now also report the presentation as a `slides/presentation/<presentationId>`
   * subresource, which verifyObserverAccess checks; this check stays for the reads made before
   * they did.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasPresentationAccess(this.#bound.presentationId))) {
      throw new Error(
        "This collaborator does not have access to the bound Google Slides presentation, so they " +
        "cannot observe data this workspace read from it.",
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  /**
   * Checks the presentation subresource every read reports, failing the whole call for any other
   * ID. Each observer's UserAccount answers whether the Slides API opens the presentation for their
   * own account, reusing recent answers (see UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    requireFileSubresources(subresources, ["presentation"]);
    return verifyGoogleSubresourceAccess(observers, subresources);
  }
}

/**
 * A read with queued changes applied, and the first that no longer applies. `stale` are that one
 * and those queued after it, which the read leaves out.
 */
function replayed(
  base: Deck, changes: readonly QueuedChange[],
): { deck: Deck; conflict?: string; stale: readonly QueuedChange[] } {
  let result = replayChanges(base, changes);
  return result.kind === "complete" ? { deck: result.value, stale: [] } : {
    deck: result.partial,
    conflict: conflictReason(result.unsupported, result.reason),
    stale: changes.slice(changes.indexOf(result.unsupported)),
  };
}

/** A queued change as `getPendingChanges()` lists it, over `deck`, the read with them applied. */
function pendingChange(
  { id, action }: QueuedChange, stale: boolean, deck: Deck,
): PresentationPendingChange {
  let base = { id, ...(stale ? { stale: true as const } : {}) };
  switch (action.kind) {
    case "duplicateSlide": {
      let { slideId, newSlideId } = action.payload;
      return { ...base, type: action.kind, slideIds: [newSlideId], slideId, newSlideId };
    }
    case "deleteSlide":
      return { ...base, type: action.kind, slideIds: [action.payload.slideId], slideId: action.payload.slideId };
    case "moveSlides":
      return { ...base, type: action.kind, slideIds: action.payload.slideIds, after: action.payload.after };
    case "createSlide": {
      let { layoutId, after, newSlideId } = action.payload;
      return {
        ...base, type: action.kind, slideIds: [newSlideId], layoutId,
        ...(after === undefined ? {} : { after }), newSlideId,
      };
    }
    case "skipSlides":
      return { ...base, type: "setSlidesSkipped", slideIds: action.payload.slideIds, skipped: action.payload.skipped };
    default: {
      // A layout's or master's change shows on every slide made from it.
      let made = (page: string) => deck.order.filter(slide => deck.masters.get(slide) === page ||
        deck.slides.get(slide)?.slideProperties?.layoutObjectId === page);
      let touched = action.payload.changes.flatMap(change => {
        let { pageType, id: page } = pageOf(change);
        return pageType === "SLIDE" ? [page] : made(page);
      });
      return {
        ...base, type: "updateSlides", slideIds: [...new Set(touched)],
        changes: action.payload.changes.map(({ before: _, ...change }) => change),
      };
    }
  }
}

/** Which of `changes` touched an element, by its ID or the ID of a group holding it. */
function elementChanges(changes: readonly QueuedChange[]): ElementChanges {
  let touched = new Map<string, { id: number; op: string }[]>();
  for (let { id, action } of changes) {
    if (!isDesignBatch(action)) continue;
    for (let change of action.payload.changes) {
      let element = "elementId" in change ? change.elementId : "id" in change ? change.id : undefined;
      if (element === undefined) continue;
      let list = touched.get(element) ?? [];
      if (!list.some(made => made.id === id && made.op === change.op)) list.push({ id, op: change.op });
      touched.set(element, list);
    }
  }
  return ids => ids.flatMap(id => touched.get(id) ?? []);
}

/** A picture a drawing named: where Google serves it, and how long to fetch its longer side. */
type NamedPicture = { contentUrl: string; pixels: number };

// How long a viewer's session keeps the masters and layouts, having no revision to tell a change by.
const THEME_KEPT_MS = 60_000;

/** A drawn slide without what marks its elements as changed, to compare it with the saved one. */
const unmarked = (slide: DrawnSlide) =>
  JSON.stringify(slide, (key, value) => key === "changes" ? undefined : value);

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

/** One master's or layout's name, and a layout's master's, for the approver. */
function themeLabelOf(deck: Deck, id: string): ThemeLabel {
  let page = deck.themePages.get(id);
  let name = page?.masterProperties?.displayName ?? page?.layoutProperties?.displayName;
  let masterId = page?.layoutProperties?.masterObjectId;
  let master = masterId && deck.themePages.get(masterId)?.masterProperties?.displayName;
  return { ...(name ? { name } : {}), ...(master ? { master } : {}) };
}

@validateRpc()
export class GooglePresentationSessionImpl extends RpcTarget
    implements GooglePresentationSession, GooglePresentationRenderingReads {
  #api: PresentationReader;
  #presentationId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #read: NativeRead;
  #changes: SlidesChangeQueue;
  /** The masters and layouts whole, as last read, and when and at which revision they were. */
  #theme?: { revisionId?: string; at: number; theme: RestPresentation };
  /**
   * The pictures drawings have named, by picture ID, which is one element's or page's across the
   * presentation: a master's logo is one picture however many slides show it.
   */
  #pictures = new Map<string, NamedPicture>();
  /** The slides a read of whose pictures has been reported. */
  #pictured = new Set<string>();
  /** The font families `listFonts()` last returned. */
  #fonts?: Set<string>;

  constructor(
    api: PresentationReader,
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
    releaseExport(this);
    this.#approvalQueue[Symbol.dispose]();
  }

  /**
   * The slide order, every master and layout, and the content of the slides among `pages`, with
   * queued changes applied. A slide that no longer exists, or never did, is absent from
   * `deck.order`.
   */
  async #simulated(pages: readonly string[]) {
    return this.#changes.snapshot(async changes => {
      let outline = await this.#api.getOutline(this.#presentationId);
      let order = slideIds(outline);
      return {
        title: outline.title ?? "Untitled presentation",
        // Google reports the revision only to an account that can edit the presentation.
        editable: outline.revisionId !== undefined,
        layouts: layoutNames(outline),
        ...replayed({
          order,
          slides: await this.#api.getSlides(this.#presentationId, slidesToFetch(pages, changes), order),
          ...mastersOf(outline),
          themePages: themePagesOf(outline),
        }, changes),
      };
    });
  }

  /**
   * Reads `ids`, and the masters and layouts `themePages` names, to prepare a change, refusing one
   * that is absent, that a conflict blocks, or that the account may not make.
   */
  async #prepare(ids: readonly string[], purpose: string, themePages: readonly string[] = []) {
    return preparable(ids, await this.#read(
      () => this.#simulated([...ids, ...themePages]),
      ({ title }) => ids.length === 0 && themePages.length > 0 ? {
        title: "Read Google Slides masters and layouts to change them",
        description: `Read the masters and layouts of "${title}" to ${purpose}.`,
      } : {
        title: "Read Google Slides slides to change them",
        description: ids.length === 0
          ? `Read the slide order of "${title}" to ${purpose}.`
          : `Read ${ids.length} slide(s) in "${title}" to ${purpose}.`,
      }));
  }

  /** The presentation's summary as saved, and with `changes` applied. */
  async #summarized(changes: readonly QueuedChange[]) {
    let rest = await this.#api.getPresentation(this.#presentationId);
    let order = slideIds(rest);
    // A summary holds no tables or grouped shapes, so slides queued edits address are read in
    // full, and every edit is checked as it would be when approved.
    let edited = changes.flatMap(({ action }) => batchSlides(action));
    let slides = new Map([
      ...(rest.slides ?? []).map(slide => [slide.objectId!, slide] as const),
      ...await this.#api.getSlides(this.#presentationId, slidesToFetch(edited, changes), order),
    ]);
    let { deck, conflict, stale } = replayed(
      { order, slides, ...mastersOf(rest), themePages: themePagesOf(rest) }, changes);
    return {
      rest, deck, stale,
      info: {
        // Less any master, and its layouts, a queued deletion leaves with no slide, as Google
        // removes them.
        ...presentationInfo(
          { ...rest, slides: deck.order.map(id => deck.slides.get(id)!) }, deck.themePages),
        ...(conflict ? { queuedChangeConflict: conflict } : {}),
      },
    };
  }

  async getPresentation(): Promise<PresentationInfo> {
    return this.#read(
      () => this.#changes.snapshot(async changes => (await this.#summarized(changes)).info),
      info => ({
        title: "Read Google Slides presentation outline",
        description:
          `Read the outline of "${info.title}": its masters and layouts, and its ` +
          `${info.slides.length} slide(s), their layouts, and their titles.`,
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
    let queued = await this.#changes.snapshot(async changes => changes.find(({ action }) =>
      (action.kind === "duplicateSlide" || action.kind === "createSlide") &&
      action.payload.newSlideId === slideId)?.action.kind);
    if (queued) {
      throw new Error(`Slide "${slideId}" is ${queued === "createSlide" ? "a new slide" : "a copy"} ` +
        "awaiting approval, so it cannot be rendered until it exists.");
    }
    throw noSlide(slideId, title);
  }

  async getPendingChanges(): Promise<PresentationPendingChanges> {
    return this.#read(
      () => this.#changes.snapshot(async changes => {
        let { rest, deck, stale, info } = await this.#summarized(changes);
        return {
          changes: changes.map(change => pendingChange(change, stale.includes(change), deck)),
          savedPresentation: presentationInfo(rest),
          presentation: info,
        };
      }),
      ({ presentation }) => ({
        title: "Read Google Slides pending changes",
        description:
          `Read the outline of "${presentation.title}" as saved and with its pending changes, ` +
          "and those changes.",
      }));
  }

  /**
   * Every master and layout whole. They are some hundreds of KiB and change rarely, so they are
   * kept until the presentation's revision moves. Google reports that only to an editor, so for a
   * viewer they are kept a minute: the reads that draw one deck share them.
   */
  async #themeAt(revisionId: string | undefined): Promise<RestPresentation> {
    let kept = this.#theme;
    let current = kept && (revisionId === undefined
      ? Date.now() - kept.at < THEME_KEPT_MS : kept.revisionId === revisionId);
    if (kept && current) return kept.theme;
    let theme = await this.#api.getTheme(this.#presentationId);
    this.#theme = { revisionId, at: Date.now(), theme };
    return theme;
  }

  /**
   * The outlines Google's export holds for the shapes `saved` and `pending` draw: `saved`'s slides,
   * and the layouts and masters under the slides of either. A shape that `changes` copy takes its
   * source's. None when no shape is drawn from the export, which is then not asked for, or when
   * there is none; `waiting` are the pages whose shapes' outlines are still being fetched.
   */
  async #geometry(
    outline: RestPresentation, saved: Deck, pending: Deck, changes: readonly QueuedChange[],
  ): Promise<{ geometry: ReadonlyMap<string, ShapeGeometry>; waiting: ReadonlySet<string | undefined> }> {
    let under = new Set([saved, pending].flatMap(deck => [...deck.slides.values()].flatMap(slide =>
      [slide.slideProperties?.layoutObjectId, deck.masters.get(slide.objectId ?? "")])));
    let pages = [...under].flatMap(id => saved.themePages.get(id ?? "") ?? []);
    let wanting = [...saved.slides.values(), ...pages].filter(page => needsExport(page.pageElements));
    let none = { geometry: new Map<string, ShapeGeometry>(), waiting: new Set<string | undefined>() };
    if (wanting.length === 0) return none;
    let deck = await exportFor(this, outline.revisionId, () => this.#api.exportPptx(this.#presentationId));
    if (deck === "pending") return { ...none, waiting: new Set(wanting.map(page => page.objectId)) };
    let geometry = deck && resolveGeometry(deck, (outline.slides ?? []).map(slide => ({
      id: slide.objectId ?? "", layout: slide.slideProperties?.layoutObjectId,
      master: slide.slideProperties?.masterObjectId, skipped: slide.slideProperties?.isSkipped,
    })), saved.slides.values(), pages);
    if (deck && !geometry) logLoss(this, "slide-count");
    if (!geometry) return none;
    for (let { action } of changes) {
      if (action.kind !== "duplicateSlide") continue;
      for (let [source, copy] of Object.entries(action.payload.objectIds)) {
        let copied = geometry.get(source);
        if (copied) geometry.set(copy, copied);
      }
    }
    return { ...none, geometry };
  }

  /**
   * `ids` as they are drawn, saved and with queued changes applied: undefined in a copy that does
   * not hold the slide. Also the pictures those drawings name, for `readPicture()`.
   */
  async #drawn(ids: readonly string[]) {
    return this.#changes.snapshot(async changes => {
      let outline = await this.#api.getOutline(this.#presentationId);
      let theme = await this.#themeAt(outline.revisionId);
      let whole = new Map([...theme.masters ?? [], ...theme.layouts ?? []].map(page => [page.objectId, page]));
      let order = slideIds(outline);
      // With every slide a queued edit addresses, as the listing reads them, so that a change it
      // calls stale is left out of these drawings too.
      let edited = changes.flatMap(({ action }) => batchSlides(action));
      let base: Deck = {
        order,
        slides: await this.#api.getSlides(
          this.#presentationId, slidesToFetch([...ids, ...edited], changes), order, DRAWN_SLIDE_FIELDS),
        ...mastersOf(outline),
        // The outline's pages, which replay changes, with their elements and picture backgrounds.
        themePages: new Map([...themePagesOf(outline)].map(([id, page]) => [id, {
          ...page, ...whole.get(id), pageProperties: { ...page.pageProperties, ...whole.get(id)?.pageProperties },
        }])),
      };
      let { deck, stale } = replayed(base, changes);
      let touched = elementChanges(changes.filter(change => !stale.includes(change)));
      let { geometry, waiting } = await this.#geometry(outline, base, deck, changes);
      // A slide waits for what it shows of those: its own shapes, its layout's and its master's.
      let waits = (id: string) => [base, deck].some(from => {
        let slide = from.slides.get(id);
        return slide && [id, slide.slideProperties?.layoutObjectId, from.masters.get(id)].some(page => waiting.has(page));
      });
      let slideWidth = points(emu(theme.pageSize?.width));
      let pictures = new Map<string, NamedPicture>();
      let draw = (from: Deck, id: string, changesOf?: ElementChanges) => {
        let page = from.order.includes(id) ? drawSlide(from, id, changesOf, geometry) : undefined;
        for (let [picture, { contentUrl, side }] of page?.pictures ?? []) {
          // As large as the largest it is drawn.
          let pixels = Math.max(picturePixels(side, slideWidth), pictures.get(picture)?.pixels ?? 0);
          pictures.set(picture, { contentUrl, pixels });
        }
        return page;
      };
      return {
        title: outline.title ?? "Untitled presentation",
        drawings: ids.map(id => ({ id, saved: draw(base, id), pending: draw(deck, id, touched), waits: waits(id) })),
        pictures,
      };
    });
  }

  /** Keeps the pictures a reported read of `ids` named. */
  #name(ids: readonly string[], pictures: Map<string, NamedPicture>): void {
    for (let id of ids) this.#pictured.add(id);
    for (let [id, picture] of pictures) this.#pictures.set(id, picture);
  }

  async getRenderingTypes(): Promise<string> {
    // The same text for every presentation, saying nothing of this one, so no read of it is reported.
    return stripTypeModulePrefix(SLIDES_RENDERING_TYPES_CODE, SLIDES_RENDERING_TYPES_MODULE_PREFIX);
  }

  async readSlideDrawings(ids: string[]): Promise<SlideDrawings> {
    if (ids.length === 0 || ids.length > MAX_DRAWINGS_PER_READ) {
      throw new Error(`Request between 1 and ${MAX_DRAWINGS_PER_READ} slides at a time.`);
    }
    // As for getSlides(), an unknown ID is reported only after authorization.
    let { title, drawings, pictures } = await this.#read(() => this.#drawn(ids), ({ title }) => ({
      title: ids.length === 1 ? "Read one Google Slides slide as drawn" : `Read ${ids.length} Google Slides slides as drawn`,
      description: `Read how ${ids.length} slide(s) in "${title}" are drawn, with their layouts and masters.`,
    }));
    let missing = drawings.find(({ saved, pending }) => !saved && !pending);
    if (missing) throw noSlide(missing.id, title);
    this.#name(ids, pictures);
    // What a master or a layout puts behind its slides is returned once, however many show it.
    let shared: DrawnElement[][] = [];
    let places = new Map<string, number>();
    let whole = (page: DrawnPage | undefined): DrawnSlide | undefined => page && {
      ...page.slide,
      ...(page.behind.length > 0 ? { behind: page.behind.map(elements => {
        let key = JSON.stringify(elements);
        if (!places.has(key)) places.set(key, shared.push(elements) - 1);
        return places.get(key)!;
      }) } : {}),
    };
    let read: SlideDrawings = {
      slides: drawings.map(({ id, saved: savedPage, pending: pendingPage, waits }): SlideDrawing => {
        let [saved, pending] = [whole(savedPage), whole(pendingPage)];
        return {
          slideId: id,
          drawing: pending ?? null,
          ...(saved && pending && JSON.stringify(saved) === unmarked(pending) ? {} : { saved: saved ?? null }),
          ...(waits ? { outlinesPending: true as const } : {}),
        };
      }),
      shared,
    };
    if (JSON.stringify(read).length > MAX_SLIDES_READ_LENGTH) {
      throw new Error(`These ${ids.length} slides are too large to read at once. Request fewer.`);
    }
    return read;
  }

  /** Reads the pictures `slideId` shows from Google, and reports it as a read of them. */
  async #picturesOn(slideId: string): Promise<void> {
    let { title, drawings, pictures } = await this.#read(() => this.#drawn([slideId]), ({ title }) => ({
      title: "Read Google Slides pictures",
      description: `Read the pictures on one slide in "${title}".`,
    }));
    if (!drawings[0].saved && !drawings[0].pending) throw noSlide(slideId, title);
    this.#name([slideId], pictures);
  }

  async readPicture(pictureId: string, slideId: string): Promise<SlidePictureBytes> {
    // A drawing told of the picture, not its bytes: each read of them is authorized as its own,
    // without asking Google for a slide already drawn. One never drawn is read here, and so is
    // one whose address has lapsed, for a current one.
    for (let reread of this.#pictured.has(slideId) ? [false, true] : [true]) {
      if (reread) await this.#picturesOn(slideId);
      else {
        await this.#read(async () => undefined, () => ({
          title: "Read Google Slides pictures", description: "Read a picture on one slide of the presentation.",
        }));
      }
      let named = this.#pictures.get(pictureId);
      if (!named) {
        throw new Error(`readPicture: no drawing of slide "${slideId}" names a picture "${pictureId}". ` +
          "Pass the `pictureId` of an element readSlideDrawings() returned for the slide.");
      }
      let picture = await downloadPicture(named.contentUrl, named.pixels);
      if (picture) return picture;
    }
    throw new Error("readPicture: Google Slides no longer serves this picture.");
  }

  async listFonts(): Promise<SlideFont[]> {
    // Only what is saved: a font a queued change sets is its author's choice, and readFont()
    // fetches what is listed here without a report of its own.
    let { fonts } = await this.#read(
      async () => {
        let deck = await this.#api.getFonts(this.#presentationId);
        return { title: deck.title ?? "Untitled presentation", fonts: fontsOf(deck) };
      },
      ({ title }) => ({
        title: "Read Google Slides fonts",
        description: `Read which fonts the text of "${title}" is set in.`,
      }));
    this.#fonts = new Set(fonts.map(font => font.family));
    return fonts;
  }

  async readFont(family: string, weight: number, italic: boolean): Promise<Uint8Array> {
    // A font is public, and says nothing of the presentation but that it names the family, which
    // the listing reports. Only a family it names is fetched, so nothing else reaches Google Fonts.
    let listed = this.#fonts ?? new Set((await this.listFonts()).map(font => font.family));
    if (!listed.has(family) || !isFontRequest(family, weight)) {
      throw new Error(`readFont: the presentation names no font "${family}" that Google Fonts ` +
        "could serve at that weight. Call listFonts() to see its fonts.");
    }
    return downloadFont(family, weight, italic);
  }

  async updateSlides(changes: SlideChange[]): Promise<Record<string, string>> {
    let { changes: prepared, refs } = prepareChanges(changes);
    let ids = [...new Set(prepared.flatMap(change => slideIdOf(change) ?? []))];
    let themePages = [...new Set(prepared.flatMap(change => {
      let { pageType, id } = pageOf(change);
      return pageType === "SLIDE" ? [] : [id];
    }))];
    return this.#changes.queue(batchKind(prepared), async () => {
      let { deck } = await this.#prepare(ids, "queue changes to them", themePages);
      // Google names a new slide's notes shape itself, as it creates the slide, so until then an
      // edit has nothing to address. Every slide Google has, and a queued copy of one, has notes.
      let unborn = prepared.find((change): change is Extract<DesignChange, { op: "editText" }> =>
        change.op === "editText" && change.elementId === undefined &&
        !deck.slides.get(change.slideId)?.slideProperties?.notesPage);
      if (unborn) {
        throw new Error(`Slide "${unborn.slideId}" is awaiting approval to be added, and Google gives it ` +
          "speaker notes only then. Edit its notes once it is approved.");
      }
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
          ...(themePages.length > 0
            ? { themes: Object.fromEntries(themePages.map(id => [id, themeLabelOf(deck, id)])) }
            : {}),
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
    if (slideIds.length === 0 || slideIds.length > MAX_SLIDES_PER_CHANGE) {
      throw new Error(`Move between 1 and ${MAX_SLIDES_PER_CHANGE} slides at a time.`);
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

  async createSlide(layoutId: string, after?: string | null): Promise<string> {
    return this.#changes.queue("createSlide", async () => {
      let ids = typeof after === "string" ? [after] : [];
      // The layout's page is fetched under the same approval as the slides, since it is only
      // read to copy its placeholders into the change.
      let { page, ...simulated } = await this.#read(
        async () => {
          let read = await this.#simulated(ids);
          return {
            ...read,
            page: read.layouts.has(layoutId)
              ? await this.#api.getLayout(this.#presentationId, layoutId)
              : undefined,
          };
        },
        ({ title, layouts }) => {
          // An agent's ID that names no layout is not shown to the user.
          let layout = layouts.get(layoutId);
          return {
            title: "Read Google Slides slides to change them",
            description: `Read the slide order of "${title}" and the placeholders of ` +
              `${layout === undefined ? "a layout" : `its layout "${layout}"`} to queue adding a slide.`,
          };
        });
      let { title, layouts, deck } = preparable(ids, simulated);
      let layout = layouts.get(layoutId);
      if (page === undefined || layout === undefined) {
        throw new Error(`No layout with ID "${layoutId}" in "${title}". Call getPresentation() for layout IDs.`);
      }
      // Minted here rather than by Google, so changes queued to the slide can name it and them.
      let newSlideId = mintObjectId();
      let payload = {
        newSlideId,
        layoutId,
        layout,
        ...(after === undefined ? {} : { after }),
        placeholders: instantiatedPlaceholders(page),
        ...(typeof after === "string" ? { afterSlide: labelOf(deck, after) } : {}),
      };
      try {
        newSlidePlace(deck, payload);
      } catch (error) {
        asError(error);
      }
      return { payload, result: newSlideId };
    });
  }

  async setSlidesSkipped(slideIds: string[], skipped: boolean): Promise<void> {
    if (slideIds.length === 0 || slideIds.length > MAX_SLIDES_PER_CHANGE) {
      throw new Error(`Skip or unskip between 1 and ${MAX_SLIDES_PER_CHANGE} slides at a time.`);
    }
    if (new Set(slideIds).size !== slideIds.length) throw new Error("A slide is listed twice.");
    await this.#changes.queue("skipSlides", async () => {
      let { deck } = await this.#prepare(slideIds, skipped ? "queue skipping them" : "queue unskipping them");
      if (slideIds.every(id => (deck.slides.get(id)?.slideProperties?.isSkipped === true) === skipped)) {
        throw new Error(skipped ? "Those slides are already skipped." : "None of those slides is skipped.");
      }
      let listed = new Set(slideIds);
      return {
        payload: {
          slideIds,
          skipped,
          slides: deck.order.filter(id => listed.has(id)).map(id => labelOf(deck, id)),
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

/**
 * `simulated`, if a change to `ids` may be queued over it: refuses a slide that is absent, a
 * conflict blocking the queue, or an account that may not edit. Called only after authorization,
 * since its errors reveal which slides exist.
 */
function preparable<T extends { title: string; editable: boolean; deck: Deck; conflict?: string }>(
  ids: readonly string[], simulated: T,
): T {
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

function noSlide(id: string, title: string): Error {
  return new Error(`No slide with ID "${id}" in "${title}". Call getPresentation() for slide IDs.`);
}
