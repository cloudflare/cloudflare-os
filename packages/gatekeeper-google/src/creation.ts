// What the Doc, Sheets and Slides gatekeepers share to simulate a file GatekeeperVendor
// createResource() was asked for, and to create it once a user approves.
//
// Imports neither google.ts nor slides.ts, both of which import this.

import type {
  ActionDescription, GatekeeperUserVerifier, SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { AccessTokenCache, type AccessTokenProvider } from "./auth-retry";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { obsContext } from "./observability";
import { nativeFileUrl, type CreatableKind } from "./resources";

const logger = obsContext.createLogger({ component: "gatekeeper.google.creation", vendorId: "google" });

/**
 * Props GatekeeperVendor.createResource() mints a simulated Doc, Sheet or Presentation with: no
 * account, only what to create.
 */
export type SimulatedFileProps = { creation: { title: string } };

/** Whether a gatekeeper's props describe a file not yet created. */
export function isSimulated<P extends object>(props: P | SimulatedFileProps): props is SimulatedFileProps {
  return "creation" in props;
}

/** The file ID a simulated file's reads report (Sheets/Slides `id`): it has none until created. */
export const UNCREATED_FILE_ID = "";

const FILE_NOUNS: Record<CreatableKind, string> = {
  doc: "Google Doc", sheets: "Google spreadsheet", slides: "Google Slides presentation",
};

/** A created file's props: the account and file its gatekeeper reaches. Throws for a simulated one. */
export function boundProps<P extends object>(props: P | SimulatedFileProps, kind: CreatableKind): P {
  if (isSimulated(props)) {
    throw new Error(
      `This ${FILE_NOUNS[kind]} doesn't exist yet: it is created when a user approves its creation.`);
  }
  return props;
}

const MAX_NEW_FILE_TITLE_LENGTH = 256;

/**
 * The title to create a file with: `title`, trimmed. Refuses one the agent should fix: blank, longer
 * than MAX_NEW_FILE_TITLE_LENGTH, or holding a control character such as a newline.
 */
export function newFileTitle(title: string): string {
  let trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NEW_FILE_TITLE_LENGTH || /\p{Cc}/u.test(trimmed)) {
    throw new Error(
      `A new Google file needs a one-line title of 1 to ${MAX_NEW_FILE_TITLE_LENGTH} characters.`);
  }
  return trimmed;
}

/** The creation card createResource() returns for `resource`. */
export function creationAction(resource: SupportedResource, title: string): ActionDescription {
  return {
    title: sanitizeTitle(`Create ${resource.title}: ${title}`),
    ...buildDescription(
      `Create a new, empty ${resource.title} in the My Drive of the Google account you choose.`)
      .inline("Title", title).finish(),
    // No actionKind: the kernel never auto-applies a creation.
    implementsRevert: false,
  };
}

/** The receipt of a file created for a pending creation, kept so a retry binds the same file. */
type CreatedFile = { userObjectId: string; fileId: string };

const CREATED_FILE_KEY = "createdFile";

/**
 * Creates the file a simulated facet stands for in the approver's account, recording a receipt so
 * a retried applyCreation() binds the same file instead of making another. The receipt is read
 * before the verifier: a retry after a lost success binds the first approver's account even if the
 * retrying approver chose another, which is what the first approval completing would have done.
 *
 * Google's create calls take no idempotency key, so a file can still be orphaned: a create POST
 * that times out or fails 5xx after Google acted (the retry creates again), a crash between the
 * reply and the receipt write, or a creation rejected after a lost success (the facet's storage,
 * and so the receipt, is deleted). Each created file is logged so an orphan can be found.
 *
 * Callers serialize calls with a Mutex.
 */
export async function createFileOnce(
  ctx: DurableObjectState<object>,
  creator: Fetcher<GatekeeperUserVerifier>,
  kind: CreatableKind,
  create: (title: string, getAccessToken: AccessTokenProvider) => Promise<string>,
): Promise<CreatedFile & { resourceUrl: string; getAccessToken: AccessTokenProvider }> {
  let props = ctx.props;
  if (!isSimulated(props)) throw new Error(`This ${FILE_NOUNS[kind]} already exists.`);
  let receipt = ctx.storage.kv.get<CreatedFile>(CREATED_FILE_KEY);
  let userObjectId = receipt?.userObjectId ??
    await (creator as unknown as Fetcher<GoogleVerifierApi>).getUserObjectId();
  let cache = new AccessTokenCache(opts => ctx.exports.UserAccount.get(
    ctx.exports.UserAccount.idFromString(userObjectId)).getAccessToken(opts));
  let getAccessToken: AccessTokenProvider = opts => cache.get(opts);

  let fileId = receipt?.fileId;
  if (fileId === undefined) {
    fileId = await create(props.creation.title, getAccessToken);
    ctx.storage.kv.put(CREATED_FILE_KEY, { userObjectId, fileId } satisfies CreatedFile);
    logger.info("created file for a pending creation", {
      event: "google.creation.file.created", userObjectId, fileId,
    });
  }
  return { userObjectId, fileId, resourceUrl: nativeFileUrl(kind, fileId), getAccessToken };
}
