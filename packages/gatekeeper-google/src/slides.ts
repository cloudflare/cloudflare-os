import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import { unguardedNativeRead, type NativeRead } from "./drive-session";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { GoogleSlidesApi, type ThumbnailSize } from "./slides-api";
import { layoutNames, presentationInfo, slideIds, slideOf } from "./slides-model";
import type {
  PresentationInfo, Slide, SlideThumbnail, SlideThumbnailSize,
} from "./slides-read-types";
import type { GooglePresentationSession } from "./slides-types";
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

  async describe(): Promise<ResourceDescription> {
    let title = await this.#api.getPresentationTitle(this.ctx.props.presentationId) ??
      "Untitled presentation";
    return {
      url: `https://docs.google.com/presentation/d/${this.ctx.props.presentationId}/edit`,
      title,
      snippet: `Google Slides presentation: ${title} (read-only)`,
      suggestedBindingName: "GOOGLE_SLIDES",
      tsType: "GooglePresentationSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleSlidesTypesCode();
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GooglePresentationSession> {
    let queue = approvalQueue.dup();
    // A presentation binding's scope is the one presentation, so there is nothing to revalidate.
    return new GooglePresentationSessionImpl(
      this.#api, this.ctx.props.presentationId, queue,
      unguardedNativeRead(description => queue.authorizeObservation(description)),
    );
  }

  /** Read-only — no side-effecting actions. */
  async applyAction(_action: number): Promise<void> {
    throw new Error("Google Slides is read-only and implements no actions.");
  }
  async rejectAction(_action: number): Promise<void> {
    throw new Error("Google Slides is read-only and implements no actions.");
  }
  revertAction(_action: number): Promise<void> {
    throw new Error("Google Slides is read-only and implements no actions.");
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

@validateRpc()
export class GooglePresentationSessionImpl extends RpcTarget implements GooglePresentationSession {
  #api: GoogleSlidesApi;
  #presentationId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #read: NativeRead;

  constructor(
    api: GoogleSlidesApi,
    presentationId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    read: NativeRead,
  ) {
    super();
    this.#api = api;
    this.#presentationId = presentationId;
    this.#approvalQueue = approvalQueue;
    this.#read = read;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  /** The deck's title and slide order, and the first of `ids` that names no slide. */
  async #outline(ids: string[]) {
    let outline = await this.#api.getOutline(this.#presentationId);
    let order = slideIds(outline);
    return {
      title: outline.title ?? "Untitled presentation",
      order,
      layouts: layoutNames(outline),
      missing: ids.find(id => !order.includes(id)),
    };
  }

  async getPresentation(): Promise<PresentationInfo> {
    return this.#read(
      async () => presentationInfo(await this.#api.getPresentation(this.#presentationId)),
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
    let { title, missing, slides } = await this.#read(
      async () => {
        let { title, order, layouts, missing } = await this.#outline(ids);
        let slides = missing !== undefined ? [] : await Promise.all(ids.map(async id =>
          slideOf(await this.#api.getSlide(this.#presentationId, id), order.indexOf(id), layouts)));
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
    if (missing !== undefined) throw noSlide(missing, title);
    return slides;
  }

  async getSlideThumbnail(
    slideId: string, size: SlideThumbnailSize = "medium",
  ): Promise<SlideThumbnail> {
    // The render happens inside the read, so a scope check bracketing it covers the image too.
    let { title, thumbnail } = await this.#read(
      async () => {
        let { title, order, missing } = await this.#outline([slideId]);
        let thumbnail = missing !== undefined ? undefined : await this.#api.getThumbnail(
          this.#presentationId, slideId, THUMBNAIL_SIZES[size]);
        return { title, index: order.indexOf(slideId), thumbnail };
      },
      ({ title, index }) => ({
        title: "Render a Google Slides slide",
        description:
          `Render an image of ${index < 0 ? "a slide" : `slide ${index + 1}`} in "${title}".`,
      }));
    if (!thumbnail) throw noSlide(slideId, title);
    return { mimeType: "image/png", ...thumbnail };
  }
}

function noSlide(id: string, title: string): Error {
  return new Error(`No slide with ID "${id}" in "${title}". Call getPresentation() for slide IDs.`);
}
