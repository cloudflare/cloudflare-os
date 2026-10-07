import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import { unguardedNativeRead, type NativeRead } from "./drive-session";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { GoogleSlidesApi } from "./slides-api";
import { normalizePresentation, type NormalizedPresentation } from "./slides-model";
import type { PresentationInfo, Slide } from "./slides-read-types";
import type { GooglePresentationSession } from "./slides-types";
import { SLIDES_TYPES_MODULE_PREFIX, stripTypeModulePrefix } from "./type-bundle";
import SLIDES_READ_TYPES_CODE from "./slides-read-types.txt";
import SLIDES_TYPES_CODE from "./slides-types.txt";

const MAX_SLIDES_PER_READ = 20;

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

  async #fetch(): Promise<NormalizedPresentation> {
    return normalizePresentation(await this.#api.getPresentation(this.#presentationId));
  }

  async getPresentation(): Promise<PresentationInfo> {
    let { info } = await this.#read(
      () => this.#fetch(),
      ({ info }) => ({
        title: "Read Google Slides presentation outline",
        description:
          `Read the outline of "${info.title}": its ${info.slides.length} slide(s), their ` +
          "layouts, and their titles.",
      }));
    return info;
  }

  async getSlides(slideIds: string[]): Promise<Slide[]> {
    if (slideIds.length === 0 || slideIds.length > MAX_SLIDES_PER_READ) {
      throw new Error(`Request between 1 and ${MAX_SLIDES_PER_READ} slides at a time.`);
    }
    // Authorized before an unknown ID is reported, since that reveals which slides exist.
    let { info, slides } = await this.#read(
      () => this.#fetch(),
      ({ info }) => ({
        title: slideIds.length === 1
          ? "Read one Google Slides slide"
          : `Read ${slideIds.length} Google Slides slides`,
        description:
          `Read the text and speaker notes of ${slideIds.length} slide(s) in "${info.title}".`,
      }));
    let byId = new Map(slides.map(slide => [slide.id, slide]));
    return slideIds.map(id => {
      let slide = byId.get(id);
      if (!slide) {
        throw new Error(
          `No slide with ID "${id}" in "${info.title}". Call getPresentation() for slide IDs.`);
      }
      return slide;
    });
  }
}
