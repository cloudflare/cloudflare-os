// Every side effect this gatekeeper has, as the kit's action set: what each action stores, how the
// approver sees it, and how it is applied and reverted. Nothing here runs before approval; the
// sessions stage actions, and the facet applies them when the user approves.
//
// Policy, from X's developer guidelines (plans/x-gatekeeper.md, Goal): likes, follows, reposts,
// replies and posts are never auto-approvable, because X requires them to be directly initiated by
// the user. Only bookmarks, mutes and hiding replies -- private or reversible moderation -- may be.

import {
  ActionApplyError,
  ActionOutcomeUnknownError,
  defineActions,
  type ActionContext,
  type ActionPresentation,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import {
  buildDescription,
  plainInline,
  sanitizeTitle,
  type ActionDescriptionBuilder,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import type { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import type { XListInfo, XPostDraft, XPostInfo, XReplySettings, XUserInfo, XUserSummary } from "./types";
import {
  XApi, XApiError, XCreditsError, XRateLimitError, isOutcomeUnknown, requireCreated, requireData, requireResult,
  xTime, LIST_FIELDS, type XEnvelope,
} from "./x-api";
import type { StoredIdentity } from "./x-credentials";
import { VENDOR_ID } from "./x-env";
import { sentContent, type SentContent, type WireList, type WirePost, type WireUser } from "./x-normalize";
import {
  TEXT_LIMIT, TEXT_LIMIT_PREMIUM, comparableText, comparableUrl, duplicateKey, extractCashtags, extractMentions, extractUrls,
  weightedLength, withoutLeadingMentions,
} from "./x-text";

/** Most posts one thread may hold. */
export const MAX_THREAD_POSTS = 25;
/** Most images one post may carry. */
export const MAX_IMAGES_PER_POST = 4;
/** Cashtags X takes in a post a self-serve app makes. */
export const MAX_CASHTAGS = 1;
/** Largest image X accepts for a post. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Longest alt text X accepts. */
export const MAX_ALT_TEXT = 1000;

/** An image a pending post will upload, captured when the post was submitted. */
export type StoredImage = { file: ActionFileReference; mediaType: string; altText?: string };

/** A draft as an action stores it: the images captured, the rest as given. */
export type StoredDraft = {
  text: string;
  images?: StoredImage[];
  poll?: { options: string[]; durationMinutes: number };
  replySettings?: XReplySettings;
  madeWithAi?: boolean;
};

/** The post an action targets: its ID (possibly temporary), and what was read of it when staged. */
export type PostTarget = { id: string; info: XPostInfo };

/** The List an action targets. */
export type ListTarget = { id: string; info: XListInfo };

/**
 * What a send recorded just before it went to X: when; for a post, the media it attached; for a
 * List, the Lists like it that were there before its first send, which can't be what it made.
 */
export type SendAttempt = { at: number; mediaIds?: string[]; existing?: string[] };

/** A List's details, as an update changes and a revert restores them. */
export type ListDetails = {
  /** Absent when X left it out beside errors: a field it failed to hydrate isn't known to be empty. */
  name?: string;
  /** Likewise; with no errors, a description X leaves out is an empty one. */
  description?: string;
  private: boolean;
};

/** What each kind of action stores. */
export type XActions = {
  /** A post, or a thread of posts each replying to the one before. */
  createPost: {
    refs: string[];
    drafts: StoredDraft[];
    submittedAt: number;
    /** The posts X created, recorded when applied: what a revert deletes. */
    createdIds?: string[];
    appliedAt?: number;
  };
  /** A reply to another post. */
  reply: {
    ref: string;
    draft: StoredDraft;
    parent: PostTarget;
    /** The conversation the reply joins: the parent's. */
    conversationId: string;
    submittedAt: number;
    createdId?: string;
    appliedAt?: number;
  };
  deletePost: { post: PostTarget; appliedAt?: number };
  like: { post: PostTarget; on: boolean; appliedAt?: number };
  repost: {
    post: PostTarget;
    on: boolean;
    /** When it was staged: what a pending repost's row is dated by. */
    submittedAt?: number;
    appliedAt?: number;
  };
  bookmark: { post: PostTarget; on: boolean; appliedAt?: number };
  hide: { post: PostTarget; hidden: boolean; appliedAt?: number };
  follow: {
    user: XUserInfo;
    on: boolean;
    /** Whether the account already followed them, read just before it applied: what a revert restores. */
    before?: boolean;
    appliedAt?: number;
  };
  mute: {
    user: XUserInfo;
    on: boolean;
    /** Whether the account already muted them, read just before it applied: what a revert restores. */
    before?: boolean;
    appliedAt?: number;
  };
  createList: {
    ref: string;
    name: string;
    description?: string;
    private?: boolean;
    owner: XUserSummary;
    submittedAt: number;
    createdId?: string;
    appliedAt?: number;
  };
  updateList: {
    list: ListTarget;
    changes: { name?: string; description?: string; private?: boolean };
    /** The List as it was just before the change, recorded when applied: what a revert restores. */
    previous?: ListDetails;
    appliedAt?: number;
  };
  deleteList: { list: ListTarget; appliedAt?: number };
  listMember: { list: ListTarget; user: XUserInfo; add: boolean; appliedAt?: number };
};

/** A journal entry of this action set. */
export type XAction = TaggedAction<XActions>;

/** What apply handlers may do. Deliberately not the Durable Object, whose stub others hold. */
export type XActionHost = {
  readonly refs: ProvisionalIds<string>;
  /** The X user the connection is pinned to. */
  me(): Promise<StoredIdentity>;
  /** Runs a write as the connection. `replayable` only for a write that is idempotent at X. */
  write<T>(op: (api: XApi, me: StoredIdentity) => Promise<T>, options?: { replayable?: boolean }): Promise<T>;
  /** Runs a read the action needs for itself, within the daily read limit. */
  read<T>(reserve: number, op: (api: XApi, me: StoredIdentity) => Promise<XEnvelope<T>>): Promise<XEnvelope<T>>;
  readImage(file: ActionFileReference): Promise<Uint8Array>;
  /** Releases a finished or abandoned post's captured images. */
  releaseImages(drafts: readonly StoredDraft[]): void;
  /** Posts a thread has published so far, so a retry resumes rather than reposting. */
  progress: { get(id: number): string[]; put(id: number, ids: string[]): void; delete(id: number): void };
  /**
   * What an action changes, from just before it first went to X -- a List's details, or whether a
   * follow or mute was already on -- so a retry after X applied it but lost the answer still records
   * what to restore.
   */
  previous: {
    get(id: number): ListDetails | boolean | "unknown" | undefined;
    put(id: number, before: ListDetails | boolean | "unknown"): void;
    delete(id: number): void;
  };
  /** A send whose outcome X never reported, keyed by action and post index (0 for a List). */
  attempts: {
    get(key: string): SendAttempt | undefined; put(key: string, attempt: SendAttempt): void; delete(key: string): void;
  };
  /** Drops cached reads once an action changed what they show. */
  invalidate(): Promise<void>;
};

const isProvisional = (id: string): boolean => id.startsWith("~");

/** The temporary IDs an action creates. */
export function providedRefs(action: XAction): string[] {
  switch (action.kind) {
    case "createPost": return action.payload.refs;
    case "reply": return [action.payload.ref];
    case "createList": return [action.payload.ref];
    default: return [];
  }
}

/** The temporary IDs an action needs X to have assigned before it can apply. */
export function dependedRefs(action: XAction): string[] {
  const target = (() => {
    switch (action.kind) {
      case "reply": return action.payload.parent.id;
      case "deletePost": case "like": case "repost": case "bookmark": case "hide":
        return action.payload.post.id;
      case "updateList": case "deleteList": case "listMember":
        return action.payload.list.id;
      default: return undefined;
    }
  })();
  return target !== undefined && isProvisional(target) ? [target] : [];
}

/** The image handles an action holds, so orphan pruning spares them. */
export function imageHandles(action: XAction): string[] {
  const drafts = action.kind === "createPost" ? action.payload.drafts
    : action.kind === "reply" ? [action.payload.draft] : [];
  return drafts.flatMap(draft => draft.images?.map(image => image.file.handle) ?? []);
}

// ---------------------------------------------------------------------------
// Drafts: validation at submit, so the queue never holds what X would refuse.

/** Whether the account may post long text. X Premium's tiers all allow it. */
function textLimitFor(me: StoredIdentity): number {
  const tier = me.subscriptionType?.toLowerCase();
  return tier && tier !== "none" ? TEXT_LIMIT_PREMIUM : TEXT_LIMIT;
}

/** Each accepted image type's magic number, so declared and actual types must agree. */
const IMAGE_SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  "image/jpeg": bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": bytes => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  "image/webp": bytes => String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP",
};

/**
 * Refuses a draft X would refuse, with a message the agent can act on.
 * @param pendingTexts Texts of posts already waiting to publish, as `duplicateKey` keys them, since X
 * refuses a duplicate.
 */
/**
 * Refuses a reply X would refuse: a self-serve app may reply only to a post that summons the account,
 * by being its own or by mentioning it or quoting one of its posts. A reply to the account mentions
 * it, so its own conversations stay open.
 */
export function validateReplyParent(parent: XPostInfo, me: StoredIdentity): void {
  const summoned = parent.author.id === me.id
    || parent.mentions.some(handle => handle.toLowerCase() === me.username.toLowerCase())
    || parent.quoteOf?.author.id === me.id;
  if (!summoned) {
    throw new Error(`X takes a reply made through the API only to a post by @${me.username}, or one that ` +
      `mentions @${me.username} or quotes one of its posts, and this post does none of those.`);
  }
}

export function validateDraft(draft: XPostDraft, me: StoredIdentity, pendingTexts: ReadonlySet<string>): void {
  const images = draft.images ?? [];
  const text = draft.text ?? "";
  if (text.trim() === "" && images.length === 0) throw new Error("A post needs text or at least one image.");
  const limit = textLimitFor(me);
  const length = weightedLength(text);
  if (length > limit) {
    throw new Error(`This post is ${length} characters as X counts them (each link counts as 23), ` +
      `over the ${limit.toLocaleString("en-US")}-character limit for @${me.username}.`);
  }
  if (extractCashtags(text).length > MAX_CASHTAGS) {
    throw new Error("X takes at most one cashtag (such as $TICKER) in a post made through the API.");
  }
  if (images.length > MAX_IMAGES_PER_POST) throw new Error(`A post can carry at most ${MAX_IMAGES_PER_POST} images.`);
  if (draft.poll && images.length > 0) throw new Error("A post can't have both a poll and images.");
  for (const [index, image] of images.entries()) {
    const label = `Image ${index + 1}`;
    if (!(image.data instanceof Uint8Array) || image.data.byteLength === 0) throw new Error(`${label} is empty.`);
    if (image.data.byteLength > MAX_IMAGE_BYTES) throw new Error(`${label} is larger than X's 5 MB limit.`);
    const matches = IMAGE_SIGNATURES[image.mediaType];
    if (!matches) throw new Error(`${label} must be a JPEG, PNG, or WEBP image.`);
    if (!matches(image.data)) throw new Error(`${label}'s bytes don't match its mediaType, ${image.mediaType}.`);
    if ((image.altText?.length ?? 0) > MAX_ALT_TEXT) throw new Error(`${label}'s alt text is over ${MAX_ALT_TEXT} characters.`);
  }
  if (draft.poll) {
    const { options, durationMinutes } = draft.poll;
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
      throw new Error("A poll needs 2 to 4 options.");
    }
    if (options.some(option => typeof option !== "string" || option.trim().length < 1 || option.length > 25)) {
      throw new Error("Each poll option must be 1 to 25 characters.");
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 10080) {
      throw new Error("A poll must stay open for 5 to 10,080 minutes (7 days).");
    }
  }
  if (text.trim() !== "" && pendingTexts.has(duplicateKey(text))) {
    throw new Error("A post with this text is already waiting to publish, and X refuses duplicate posts.");
  }
}

// ---------------------------------------------------------------------------
// Descriptions. Prose is the gatekeeper's own; every value the action sends is in a field.

function handle(username: string): string {
  return `@${plainInline(username || "unknown")}`;
}

function addDraftFields(builder: ActionDescriptionBuilder, draft: StoredDraft, label: string): void {
  if (draft.text) builder.verbatim(label, draft.text);
  const mentions = extractMentions(draft.text);
  if (mentions.length) builder.list(`${label}: mentions`, mentions.map(name => `@${name}`));
  const links = extractUrls(draft.text);
  if (links.length) builder.list(`${label}: links`, links);
  for (const [index, image] of (draft.images ?? []).entries()) {
    const extension = image.mediaType.split("/")[1] ?? "img";
    builder.file(`${label}: image ${index + 1}`, {
      name: `image-${index + 1}.${extension}`,
      mediaType: image.mediaType,
      size: image.file.size,
      sha256: image.file.digest,
      origin: "agent",
    });
    if (image.altText) builder.verbatim(`${label}: image ${index + 1} alt text`, image.altText);
  }
  if (draft.poll) {
    builder.list(`${label}: poll options`, draft.poll.options);
    builder.inline(`${label}: poll open for`, `${draft.poll.durationMinutes} minutes`);
  }
  if (draft.replySettings && draft.replySettings !== "everyone") {
    builder.inline(`${label}: who can reply`, draft.replySettings);
  }
  if (draft.madeWithAi) builder.inline(`${label}: labelled as made with AI`, "yes");
}

function linkNote(drafts: readonly StoredDraft[]): string {
  return drafts.some(draft => extractUrls(draft.text).length > 0)
    ? " It contains links; X bills posts with links at a much higher rate than other posts."
    : "";
}

function targetFields(builder: ActionDescriptionBuilder, post: PostTarget): ActionDescriptionBuilder {
  builder.inline("Post", post.info.url ?? `your pending post ${post.id}`);
  if (post.info.text) builder.verbatim("Post text", post.info.text);
  return builder;
}

const post = (target: PostTarget) => handle(target.info.author.username);

// ---------------------------------------------------------------------------
// Apply.

/**
 * Classifies a failed write: rate limits and exhausted credits are retryable once they lift, X's
 * refusals are terminal, and anything else (a 5xx, a dropped connection) is retryable.
 */
function refuse(error: unknown, what: string): never {
  if (error instanceof XRateLimitError || error instanceof XCreditsError) throw new Error(error.message);
  if (error instanceof XApiError && error.status >= 400 && error.status < 500 && !error.isAuthError) {
    throw new ActionApplyError(`X refused to ${what}. ${error.message}`);
  }
  throw error;
}

/**
 * Whether the account already followed or muted `userId`, so a revert restores that rather than
 * undoing a change that made none: read from X once, before the action's first effect, and kept for
 * its retries, which would otherwise read that effect back. A follow request already sent counts as
 * a follow. X can return the user without `connection_status` (a partial error), which says
 * nothing: that is kept as unknown too, and the action then can't be reverted.
 */
async function stateBefore(host: XActionHost, actionId: number, userId: string,
                           relationship: "following" | "muting"): Promise<boolean | undefined> {
  const recorded = host.previous.get(actionId);
  if (typeof recorded === "boolean") return recorded;
  if (recorded === "unknown") return undefined;
  const user = requireData(await host.read<WireUser>(1, api => api.get<WireUser>(`/2/users/${userId}`, {
    "user.fields": "connection_status",
  })), "user");
  const status = user.connection_status;
  const before = Array.isArray(status)
    ? status.includes(relationship) || (relationship === "following" && status.includes("follow_request_sent"))
    : "unknown";
  host.previous.put(actionId, before);
  return before === "unknown" ? undefined : before;
}

/**
 * Runs a write X makes idempotent -- liking a liked post or following a followed account answers
 * with the resulting state, not an error -- so a replay under refreshed credentials is safe.
 */
async function toggle(host: XActionHost, op: (api: XApi, me: StoredIdentity) => Promise<XEnvelope<unknown>>,
                      what: string): Promise<void> {
  try {
    await confirmedWrite(host, op);
  } catch (error) {
    refuse(error, what);
  }
}

/** Runs a replayable write, refusing an answer with an error in place of its result (`requireResult`). */
async function confirmedWrite(host: XActionHost, op: (api: XApi, me: StoredIdentity) => Promise<XEnvelope<unknown>>):
    Promise<void> {
  requireResult(await host.write(op, { replayable: true }));
}

/** How far X's clock may run behind ours. */
const CLOCK_SKEW_MS = 10_000;
/** How long after its attempt began X may date what a send created: well past our timeout. */
const RECONCILE_WINDOW_MS = 5 * 60 * 1000;

/** Rows a reconciliation read asks X for, and so reserves against the read limit: X's largest page. */
const RECONCILE_PAGE = 100;

/** Most pages of owned Lists a reconciliation reads: X lets an account own at most 1,000 Lists. */
const MAX_OWNED_LIST_PAGES = 10;

/** X's epoch for snowflake IDs, in Unix milliseconds. */
const SNOWFLAKE_EPOCH_MS = 1288834974657n;

/**
 * When X made the post a snowflake ID names, to the millisecond and by X's clock: finer than
 * `created_at`, which X reports to the second.
 */
export function snowflakeTime(id: string): number {
  return /^\d+$/.test(id) ? Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH_MS) : Number.NaN;
}

/**
 * The end of a reconciliation no candidate can be attributed by: binding the wrong one would have
 * a revert delete it, and sending again could make a second.
 */
function unresolved(things: "posts" | "Lists"): ActionOutcomeUnknownError {
  return new ActionOutcomeUnknownError(`The account's ${things} from around when this was sent leave ` +
    "it unknown whether this action made one, and which, so it won't be sent again. Check the " +
    `account's ${things} on X, then reject this action to clear it.`);
}

/**
 * Whether a send's window has closed: X has dated, and shown, anything the send made by then, so a
 * look that finds nothing proves it made nothing. Until then X may still be about to show it.
 */
function windowClosed(attempt: SendAttempt): boolean {
  return attempt.at + RECONCILE_WINDOW_MS < Date.now() - CLOCK_SKEW_MS;
}

/**
 * The end of a look that found nothing while X may yet show what the send made: X can take minutes
 * to show a new post. It fails the apply, keeping the attempt, so an approval after `conclusive`
 * looks again rather than sending a second.
 */
function notShownYet(conclusive: number, what: "post" | "List"): Error {
  const after = new Date(Math.ceil(conclusive / 60_000) * 60_000).toISOString().slice(11, 16);
  return new Error(`X doesn't show this ${what} yet, and one it made can take a few minutes to appear, so it ` +
    `wasn't ${what === "post" ? "sent" : "created"} again. Approve it again after ${after} UTC to look once more.`);
}

/**
 * The rows of a reconciliation read. X can answer 200 with errors in place of rows, and a row it
 * left out could be what the send made, so such an answer settles nothing: it fails the apply,
 * leaving the attempt for the next approval to look again, rather than letting it send twice.
 */
function completeRows<T>(envelope: XEnvelope<T[]>, things: "posts" | "Lists"): T[] {
  if (envelope.errors?.length) {
    throw new Error(`X couldn't list the account's ${things} to check whether this was already sent, ` +
      "so it wasn't sent again. Approving it again looks once more.");
  }
  return envelope.data ?? [];
}

/** One key per distinct content, however X rewrote its links and in whatever order it lists them. */
function contentKey(content: SentContent): string {
  return JSON.stringify([
    content.replyTo ?? null,
    comparableText(content.replyTo ? withoutLeadingMentions(content.text) : content.text),
    content.links.map(comparableUrl).toSorted(),
    content.mediaIds.toSorted(),
    content.poll,
  ]);
}

/**
 * Finds the post a send whose outcome X never reported made, so a retry binds it instead of
 * posting twice: among the account's posts dated around the attempt, the one with the draft's
 * reply parent, text, link destinations and poll, carrying the media the attempt uploaded.
 * @returns The post's ID, or `undefined` when none matches: proof the send made none only once its
 * window has closed (`windowClosed`).
 * @throws ActionOutcomeUnknownError when more than one could match, or one from before the send
 * (`unresolved`).
 */
async function findPublished(host: XActionHost, draft: StoredDraft, replyTo: string | undefined,
                             attempt: SendAttempt): Promise<string | undefined> {
  const envelope = await host.read<WirePost[]>(RECONCILE_PAGE, (api, me) => api.get<WirePost[]>(`/2/users/${me.id}/tweets`, {
    max_results: RECONCILE_PAGE,
    start_time: xTime(new Date(attempt.at - CLOCK_SKEW_MS)),
    // Until the window has closed it runs to the present.
    ...(windowClosed(attempt) ? { end_time: xTime(new Date(attempt.at + RECONCILE_WINDOW_MS)) } : {}),
    "tweet.fields": "created_at,referenced_tweets,note_tweet,entities,attachments",
  }));
  const wanted = contentKey({
    text: draft.text, replyTo, links: extractUrls(draft.text), mediaIds: attempt.mediaIds ?? [],
    poll: draft.poll !== undefined,
  });
  const matches = completeRows(envelope, "posts").filter(candidate => contentKey(sentContent(candidate)) === wanted);
  // X dates what the send made after `at`. A match from before then may be a post that was already
  // there, so it can neither be bound nor ruled out; nor can a match on a further page.
  const earlier = matches.some(candidate => !(snowflakeTime(candidate.id) >= attempt.at));
  if (matches.length > 1 || earlier || envelope.meta?.next_token !== undefined) throw unresolved("posts");
  return matches[0]?.id;
}

/**
 * The account's owned Lists with the name, description and privacy `payload` asks for. X can't
 * filter owned Lists, so every page is read.
 */
async function matchingLists(host: XActionHost, payload: XActions["createList"]): Promise<WireList[]> {
  const matches: WireList[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_OWNED_LIST_PAGES; page++) {
    const envelope = await host.read<WireList[]>(RECONCILE_PAGE, (api, me) => api.get<WireList[]>(`/2/users/${me.id}/owned_lists`, {
      "list.fields": "created_at,description,private",
      max_results: RECONCILE_PAGE,
      pagination_token: token,
    }));
    matches.push(...completeRows(envelope, "Lists").filter(list => list.name === payload.name
      && (list.description ?? "") === (payload.description ?? "")
      && (list.private === true) === (payload.private === true)));
    token = envelope.meta?.next_token;
    if (token === undefined) return matches;
  }
  throw new Error("X listed more owned Lists than an account can have.");
}

/**
 * Finds the List a create whose outcome X never reported made, so a retry binds it instead of
 * creating a second: the one matching List created around the attempt that wasn't there before
 * the first send.
 * @returns The List's ID, or `undefined` when none matches and the create may go again.
 * @throws ActionOutcomeUnknownError when more than one could match (`unresolved`).
 */
async function findCreatedList(host: XActionHost, payload: XActions["createList"], attempt: SendAttempt):
    Promise<string | undefined> {
  const existing = new Set(attempt.existing);
  const matches = (await matchingLists(host, payload)).filter(list => {
    const created = Date.parse(list.created_at ?? "");
    return !existing.has(list.id)
      && created >= attempt.at - CLOCK_SKEW_MS && created <= attempt.at + RECONCILE_WINDOW_MS;
  });
  if (matches.length > 1) throw unresolved("Lists");
  return matches[0]?.id;
}

/** Publishes one draft, replying to `replyTo` when given. */
async function publishOne(host: XActionHost, draft: StoredDraft, replyTo: string | undefined,
                          attemptKey: string): Promise<string> {
  const prior = host.attempts.get(attemptKey);
  if (prior) {
    // Judged before the look: one run while the window was open proves nothing by finding nothing.
    const conclusive = windowClosed(prior);
    const landed = await findPublished(host, draft, replyTo, prior);
    if (landed) {
      host.attempts.delete(attemptKey);
      return landed;
    }
    if (!conclusive) throw notShownYet(prior.at + RECONCILE_WINDOW_MS + CLOCK_SKEW_MS, "post");
  }

  const mediaIds: string[] = [];
  for (const image of draft.images ?? []) {
    const bytes = await host.readImage(image.file);
    try {
      const id = await host.write(api => api.uploadImage(bytes, image.mediaType));
      if (image.altText) {
        await confirmedWrite(host, api => api.post("/2/media/metadata", {
          id, metadata: { alt_text: { text: image.altText } },
        }));
      }
      mediaIds.push(id);
    } catch (error) {
      refuse(error, "upload an image");
    }
  }

  const body: Record<string, unknown> = { text: draft.text };
  if (mediaIds.length) body.media = { media_ids: mediaIds };
  if (draft.poll) body.poll = { options: draft.poll.options, duration_minutes: draft.poll.durationMinutes };
  if (draft.replySettings && draft.replySettings !== "everyone") body.reply_settings = draft.replySettings;
  if (draft.madeWithAi) body.made_with_ai = true;
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };

  const attempt: SendAttempt = { at: Date.now(), mediaIds };
  host.attempts.put(attemptKey, attempt);
  try {
    const created = await host.write(api => api.post<{ id: string }>("/2/tweets", body));
    const id = requireCreated(created, "post");
    host.attempts.delete(attemptKey);
    return id;
  } catch (error) {
    const duplicate = error instanceof XApiError && error.isDuplicate;
    // A lost answer may hide the post this send made. A duplicate refusal says it made none, but
    // an earlier send X never confirmed may have made the post X compared it with.
    const unconfirmed = isOutcomeUnknown(error) ? attempt : duplicate ? prior : undefined;
    const landed = unconfirmed && await findPublished(host, draft, replyTo, unconfirmed);
    if (landed) {
      host.attempts.delete(attemptKey);
      return landed;
    }
    if (isOutcomeUnknown(error)) {
      throw new Error("X did not confirm whether this post was published. Approving it again first " +
        "checks the account's recent posts, so it is not posted twice.", { cause: error });
    }
    host.attempts.delete(attemptKey);
    if (duplicate) throw new ActionApplyError("X refused this post as a duplicate of one posted recently.");
    refuse(error, "publish this post");
  }
}

/**
 * Publishes drafts in order, each replying to the one before (the first to `firstReplyTo`),
 * recording progress so a retry after a failure part-way through resumes where it stopped.
 */
async function publishAll(host: XActionHost, ctx: ActionContext, drafts: readonly StoredDraft[],
                          refs: readonly string[], firstReplyTo: string | undefined): Promise<string[]> {
  const published = [...host.progress.get(ctx.id)];
  try {
    for (let index = published.length; index < drafts.length; index++) {
      const replyTo = index === 0 ? firstReplyTo : published[index - 1];
      const id = await publishOne(host, drafts[index], replyTo, `${ctx.id}:${index}`);
      published.push(id);
      host.refs.bind(refs[index], id);
      host.progress.put(ctx.id, published);
    }
  } catch (error) {
    if (error instanceof ActionApplyError || error instanceof ActionOutcomeUnknownError) {
      // Terminal, so no retry will need the progress or the images.
      host.progress.delete(ctx.id);
      host.releaseImages(drafts);
      if (published.length > 0) {
        const message = `${error.message} ${published.length === 1
          ? "The thread's first post was published and is still on X."
          : `The thread's first ${published.length} posts were published and are still on X.`}`;
        throw error instanceof ActionApplyError ? new ActionApplyError(message) : new ActionOutcomeUnknownError(message);
      }
    }
    throw error;
  }
  host.progress.delete(ctx.id);
  host.releaseImages(drafts);
  return published;
}

/**
 * Forgets a rejected publish's thread progress and send attempts. Rejecting withdraws the action
 * without asking X, so any post X already published stays on the account.
 */
function forgetAttempts(host: XActionHost, id: number, posts: number): void {
  host.progress.delete(id);
  for (let index = 0; index < posts; index++) host.attempts.delete(`${id}:${index}`);
}

/** Deletes posts, newest first; one already gone counts as deleted. */
async function deletePosts(host: XActionHost, ids: readonly string[]): Promise<void> {
  for (const id of ids.toReversed()) {
    try {
      await confirmedWrite(host, api => api.delete(`/2/tweets/${id}`));
    } catch (error) {
      if (error instanceof XApiError && error.status === 404) continue;
      throw error;
    }
  }
}

const listId = (host: XActionHost, target: ListTarget) => host.refs.requireResolved(target.id);
const postId = (host: XActionHost, target: PostTarget) => host.refs.requireResolved(target.id);

/** The declared action set. */
export const actions = defineActions<XActionHost, XActions>({
  createPost: {
    kind: { tag: "x.post.create", label: "Publish X posts" },
    delivery: "continue-with-simulation",
    // Non-idempotent at X: a lost activation must not replay a post.
    claimBeforeApply: true,
    describe: async (payload, host) => {
      const me = await host.me();
      const thread = payload.drafts.length > 1;
      const builder = buildDescription(thread
        ? `Publish a thread of ${payload.drafts.length} posts on X as ${handle(me.username)}, each ` +
          `replying to the one before.${linkNote(payload.drafts)}`
        : `Publish a post on X as ${handle(me.username)}, visible to everyone who can see the ` +
          `account.${linkNote(payload.drafts)}`);
      for (const [index, draft] of payload.drafts.entries()) {
        addDraftFields(builder, draft, thread ? `Post ${index + 1}` : "Post");
      }
      return {
        title: sanitizeTitle(thread
          ? `Post a ${payload.drafts.length}-post thread on X as @${me.username}`
          : `Post on X as @${me.username}`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    provides: payload => payload.refs,
    apply: async (payload, host, ctx) => {
      const createdIds = await publishAll(host, ctx, payload.drafts, payload.refs, undefined);
      return { action: { ...payload, createdIds, appliedAt: Date.now() } };
    },
    reject: async (payload, host, ctx) => {
      forgetAttempts(host, ctx.id, payload.drafts.length);
      host.releaseImages(payload.drafts);
    },
  },

  reply: {
    kind: { tag: "x.post.reply", label: "Reply to X posts" },
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: async (payload, host) => {
      const me = await host.me();
      const builder = buildDescription(`Reply on X as ${handle(me.username)} to a post by ` +
        `${post(payload.parent)}.${linkNote([payload.draft])}`);
      builder.inline("Replying to", payload.parent.info.url ?? `your pending post ${payload.parent.id}`);
      if (payload.parent.info.text) builder.verbatim("Their post", payload.parent.info.text);
      addDraftFields(builder, payload.draft, "Reply");
      return {
        title: sanitizeTitle(`Reply on X to @${payload.parent.info.author.username} as @${me.username}`),
        ...builder.finish(),
        implementsRevert: true,
      };
    },
    provides: payload => [payload.ref],
    dependsOn: payload => isProvisional(payload.parent.id) ? [payload.parent.id] : [],
    apply: async (payload, host, ctx) => {
      const [createdId] = await publishAll(host, ctx, [payload.draft], [payload.ref], postId(host, payload.parent));
      return { action: { ...payload, createdId, appliedAt: Date.now() } };
    },
    reject: async (payload, host, ctx) => {
      forgetAttempts(host, ctx.id, 1);
      host.releaseImages([payload.draft]);
    },
  },

  deletePost: {
    kind: { tag: "x.post.delete", label: "Delete X posts" },
    delivery: "continue-with-simulation",
    describe: async (payload, host) => {
      const me = await host.me();
      return {
        title: sanitizeTitle(`Delete a post from X as @${me.username}`),
        ...targetFields(buildDescription(
          `Permanently delete this post from ${handle(me.username)}'s X account. A deleted post can't be restored.`),
          payload.post).finish(),
        implementsRevert: false,
      };
    },
    dependsOn: payload => isProvisional(payload.post.id) ? [payload.post.id] : [],
    apply: async (payload, host) => {
      await deletePosts(host, [postId(host, payload.post)]);
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  like: {
    kind: { tag: "x.post.like", label: "Like X posts" },
    delivery: "continue-with-simulation",
    describe: async (payload, host) => {
      const me = await host.me();
      return {
        title: sanitizeTitle(payload.on
          ? `Like a post by @${payload.post.info.author.username} on X`
          : `Remove a like from a post by @${payload.post.info.author.username}`),
        ...targetFields(buildDescription(payload.on
          ? `Like this post by ${post(payload.post)} as ${handle(me.username)}.`
          : `Remove ${handle(me.username)}'s like from this post by ${post(payload.post)}.`), payload.post).finish(),
        implementsRevert: false,
      };
    },
    dependsOn: payload => isProvisional(payload.post.id) ? [payload.post.id] : [],
    apply: async (payload, host) => {
      const id = postId(host, payload.post);
      await toggle(host, (api, me) => payload.on
        ? api.post(`/2/users/${me.id}/likes`, { tweet_id: id })
        : api.delete(`/2/users/${me.id}/likes/${id}`), payload.on ? "like this post" : "remove this like");
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  repost: {
    kind: { tag: "x.post.repost", label: "Repost X posts" },
    delivery: "continue-with-simulation",
    describe: async (payload, host) => {
      const me = await host.me();
      return {
        title: sanitizeTitle(payload.on
          ? `Repost a post by @${payload.post.info.author.username} on X`
          : `Undo a repost of a post by @${payload.post.info.author.username}`),
        ...targetFields(buildDescription(payload.on
          ? `Repost this post by ${post(payload.post)} to ${handle(me.username)}'s followers.`
          : `Undo ${handle(me.username)}'s repost of this post by ${post(payload.post)}.`), payload.post).finish(),
        implementsRevert: false,
      };
    },
    dependsOn: payload => isProvisional(payload.post.id) ? [payload.post.id] : [],
    apply: async (payload, host) => {
      const id = postId(host, payload.post);
      await toggle(host, (api, me) => payload.on
        ? api.post(`/2/users/${me.id}/retweets`, { tweet_id: id })
        : api.delete(`/2/users/${me.id}/retweets/${id}`), payload.on ? "repost this post" : "undo this repost");
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  bookmark: {
    kind: { tag: "x.post.bookmark", label: "Bookmark X posts" },
    // Private to the account, reversible, and explicitly fine to automate under X's guidelines.
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: async (payload, host) => {
      const me = await host.me();
      return {
        title: sanitizeTitle(payload.on
          ? `Bookmark a post by @${payload.post.info.author.username} on X`
          : `Remove a bookmark of a post by @${payload.post.info.author.username}`),
        ...targetFields(buildDescription(payload.on
          ? `Bookmark this post by ${post(payload.post)} in ${handle(me.username)}'s private bookmarks.`
          : `Remove this post by ${post(payload.post)} from ${handle(me.username)}'s bookmarks.`), payload.post).finish(),
        implementsRevert: false,
      };
    },
    dependsOn: payload => isProvisional(payload.post.id) ? [payload.post.id] : [],
    apply: async (payload, host) => {
      const id = postId(host, payload.post);
      await toggle(host, (api, me) => payload.on
        ? api.post(`/2/users/${me.id}/bookmarks`, { tweet_id: id })
        : api.delete(`/2/users/${me.id}/bookmarks/${id}`), payload.on ? "bookmark this post" : "remove this bookmark");
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  hide: {
    kind: { tag: "x.post.hide", label: "Hide replies on X" },
    // Reversible moderation of the account's own conversations.
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: async payload => ({
      title: sanitizeTitle(payload.hidden
        ? `Hide a reply by @${payload.post.info.author.username} on X`
        : `Unhide a reply by @${payload.post.info.author.username} on X`),
      ...targetFields(buildDescription(payload.hidden
        ? `Hide this reply by ${post(payload.post)} from the conversation. It stays reachable behind X's "hidden replies" link.`
        : `Show this reply by ${post(payload.post)} in the conversation again.`), payload.post).finish(),
        implementsRevert: false,
    }),
    dependsOn: payload => isProvisional(payload.post.id) ? [payload.post.id] : [],
    apply: async (payload, host) => {
      const id = postId(host, payload.post);
      await toggle(host, api => api.put(`/2/tweets/${id}/hidden`, { hidden: payload.hidden }),
        payload.hidden ? "hide this reply" : "unhide this reply");
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  follow: {
    kind: { tag: "x.user.follow", label: "Follow X accounts" },
    delivery: "continue-with-simulation",
    describe: async (payload, host) => {
      const me = await host.me();
      const builder = buildDescription(payload.on
        ? `Follow ${handle(payload.user.username)} as ${handle(me.username)}.` +
          (payload.user.protected ? " Their account is protected, so X sends them a follow request." : "")
        : `Stop following ${handle(payload.user.username)} as ${handle(me.username)}.`);
      builder.inline("Account", payload.user.url);
      return {
        title: sanitizeTitle(payload.on ? `Follow @${payload.user.username} on X` : `Unfollow @${payload.user.username} on X`),
        ...builder.finish(),
        implementsRevert: true,
      };
    },
    apply: async (payload, host, ctx) => {
      const before = await stateBefore(host, ctx.id, payload.user.id, "following");
      await toggle(host, (api, me) => payload.on
        ? api.post(`/2/users/${me.id}/following`, { target_user_id: payload.user.id })
        : api.delete(`/2/users/${me.id}/following/${payload.user.id}`),
      payload.on ? "follow this account" : "unfollow this account");
      host.previous.delete(ctx.id);
      return { action: { ...payload, before, appliedAt: Date.now() } };
    },
  },

  mute: {
    kind: { tag: "x.user.mute", label: "Mute X accounts" },
    // Private to the account and reversible.
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: async (payload, host) => {
      const me = await host.me();
      const builder = buildDescription(payload.on
        ? `Mute ${handle(payload.user.username)} for ${handle(me.username)}. Mutes are private.`
        : `Unmute ${handle(payload.user.username)} for ${handle(me.username)}.`);
      builder.inline("Account", payload.user.url);
      return {
        title: sanitizeTitle(payload.on ? `Mute @${payload.user.username} on X` : `Unmute @${payload.user.username} on X`),
        ...builder.finish(),
        implementsRevert: true,
      };
    },
    apply: async (payload, host, ctx) => {
      const before = await stateBefore(host, ctx.id, payload.user.id, "muting");
      await toggle(host, (api, me) => payload.on
        ? api.post(`/2/users/${me.id}/muting`, { target_user_id: payload.user.id })
        : api.delete(`/2/users/${me.id}/muting/${payload.user.id}`),
      payload.on ? "mute this account" : "unmute this account");
      host.previous.delete(ctx.id);
      return { action: { ...payload, before, appliedAt: Date.now() } };
    },
  },

  createList: {
    kind: { tag: "x.list.manage", label: "Manage X Lists" },
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: async (payload, host) => {
      const me = await host.me();
      const builder = buildDescription(`Create a ${payload.private ? "private" : "public"} List owned by ` +
        `${handle(me.username)}.`);
      builder.inline("Name", payload.name);
      if (payload.description) builder.verbatim("Description", payload.description);
      return { title: sanitizeTitle(`Create the X List "${payload.name}"`), ...builder.finish(), implementsRevert: true };
    },
    provides: payload => [payload.ref],
    // Reconciled as a post is: `POST /2/lists` has no idempotency key either.
    apply: async (payload, host, ctx) => {
      const attemptKey = `${ctx.id}:0`;
      const prior = host.attempts.get(attemptKey);
      // Judged before the look, as for a post: X can take minutes to list a new List.
      const conclusive = prior !== undefined && windowClosed(prior);
      let createdId = prior && await findCreatedList(host, payload, prior);
      if (createdId === undefined && prior !== undefined && !conclusive) {
        throw notShownYet(prior.at + RECONCILE_WINDOW_MS + CLOCK_SKEW_MS, "List");
      }
      if (createdId === undefined) {
        // Lists can share every detail, so those already there are noted before the first send.
        const existing = prior?.existing ?? (await matchingLists(host, payload)).map(list => list.id);
        const attempt: SendAttempt = { at: Date.now(), existing };
        host.attempts.put(attemptKey, attempt);
        try {
          const created = await host.write(api => api.post<{ id: string }>("/2/lists", {
            name: payload.name,
            ...(payload.description ? { description: payload.description } : {}),
            ...(payload.private ? { private: true } : {}),
          }));
          createdId = requireCreated(created, "List");
        } catch (error) {
          if (!isOutcomeUnknown(error)) {
            host.attempts.delete(attemptKey);
            refuse(error, "create this List");
          }
          createdId = await findCreatedList(host, payload, attempt);
          if (createdId === undefined) {
            throw new Error("X did not confirm whether this List was created. Approving it again first " +
              "checks the account's Lists, so it is not created twice.", { cause: error });
          }
        }
      }
      host.attempts.delete(attemptKey);
      host.refs.bind(payload.ref, createdId);
      return { action: { ...payload, createdId, appliedAt: Date.now() } };
    },
    // A List X already created stays on the account.
    reject: async (_payload, host, ctx) => host.attempts.delete(`${ctx.id}:0`),
  },

  updateList: {
    kind: { tag: "x.list.manage", label: "Manage X Lists" },
    delivery: "continue-with-simulation",
    describe: async payload => {
      const builder = buildDescription("Change this List's details.");
      builder.inline("List", payload.list.info.url ?? `your pending List ${payload.list.id}`);
      if (payload.changes.name !== undefined) builder.inline("New name", payload.changes.name);
      if (payload.changes.description !== undefined) builder.verbatim("New description", payload.changes.description);
      if (payload.changes.private !== undefined) builder.inline("Private", payload.changes.private ? "yes" : "no");
      return { title: sanitizeTitle(`Change the X List "${payload.list.info.name}"`), ...builder.finish(), implementsRevert: true };
    },
    dependsOn: payload => isProvisional(payload.list.id) ? [payload.list.id] : [],
    apply: async (payload, host, ctx) => {
      const id = listId(host, payload.list);
      const recorded = host.previous.get(ctx.id);
      let previous = typeof recorded === "object" ? recorded : undefined;
      if (previous === undefined) {
        const read = await host.read<WireList>(1, api => api.get<WireList>(`/2/lists/${id}`, LIST_FIELDS));
        const before = requireData(read, "List");
        // A field left out beside errors may have failed to hydrate. Privacy X didn't report is restored
        // as private, the safe way to be wrong.
        const complete = !read.errors?.length;
        previous = {
          ...(before.name !== undefined ? { name: before.name } : {}),
          ...(before.description !== undefined || complete ? { description: before.description ?? "" } : {}),
          private: before.private !== false,
        };
        host.previous.put(ctx.id, previous);
      }
      await toggle(host, api => api.put(`/2/lists/${id}`, payload.changes), "change this List");
      host.previous.delete(ctx.id);
      return { action: { ...payload, previous, appliedAt: Date.now() } };
    },
  },

  deleteList: {
    kind: { tag: "x.list.manage", label: "Manage X Lists" },
    delivery: "continue-with-simulation",
    describe: async payload => ({
      title: sanitizeTitle(`Delete the X List "${payload.list.info.name}"`),
      ...buildDescription("Permanently delete this List. A deleted List can't be restored.")
        .inline("List", payload.list.info.url ?? `your pending List ${payload.list.id}`).finish(),
      implementsRevert: false,
    }),
    dependsOn: payload => isProvisional(payload.list.id) ? [payload.list.id] : [],
    apply: async (payload, host) => {
      const id = listId(host, payload.list);
      try {
        await confirmedWrite(host, api => api.delete(`/2/lists/${id}`));
      } catch (error) {
        if (!(error instanceof XApiError && error.status === 404)) refuse(error, "delete this List");
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  listMember: {
    kind: { tag: "x.list.members", label: "Manage X List members" },
    delivery: "continue-with-simulation",
    describe: async payload => {
      const builder = buildDescription(payload.add
        ? `Add ${handle(payload.user.username)} to this List.` +
          (payload.list.info.private ? "" : " The List is public, and X may tell them they were added.")
        : `Remove ${handle(payload.user.username)} from this List.`);
      builder.inline("List", payload.list.info.url ?? `your pending List ${payload.list.id}`);
      builder.inline("Account", payload.user.url);
      return {
        title: sanitizeTitle(payload.add
          ? `Add @${payload.user.username} to the X List "${payload.list.info.name}"`
          : `Remove @${payload.user.username} from the X List "${payload.list.info.name}"`),
        ...builder.finish(),
        implementsRevert: false,
      };
    },
    dependsOn: payload => isProvisional(payload.list.id) ? [payload.list.id] : [],
    apply: async (payload, host) => {
      const id = listId(host, payload.list);
      await toggle(host, api => payload.add
        ? api.post(`/2/lists/${id}/members`, { user_id: payload.user.id })
        : api.delete(`/2/lists/${id}/members/${payload.user.id}`), payload.add ? "add this member" : "remove this member");
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },
}, {
  // Every kind acts as one X account, so none means anything under another. Fenced on the pinned X
  // user ID rather than the connection generation, so a scope-widening reconnect of the same user
  // does not strand pending actions (USAGE.md's stable-account fence).
  fence: "authority",
  retainApplied: true,
  isResolvedReference: (host, ref) => host.refs.isResolved(ref),
  afterResolve: host => host.invalidate(),
  vendorId: VENDOR_ID,
});

/** The outcome `revertAction` reports. */
export type RevertOutcome = void | { message?: string; canRetry?: boolean; restart?: boolean };

/** A revert refused because X can't say how things stood before the action. */
const PRIOR_UNKNOWN: RevertOutcome = {
  message: "X can't say how this stood before the action, so undoing it could remove what was there " +
    "already. Change it on X if it shouldn't stay.",
  canRetry: false,
};

/**
 * Undoes an applied action. Posts are deleted, a List's old details restored, and a follow or mute
 * returned to how it stood before; a deletion cannot be undone, nor a like, repost, bookmark, hide or
 * List membership, since X can't say whether it was already so (`PRIOR_UNKNOWN`).
 */
export async function revert(action: XAction, host: XActionHost): Promise<RevertOutcome> {
  switch (action.kind) {
    case "createPost":
      await deletePosts(host, action.payload.createdIds ?? []);
      return;
    case "reply":
      if (action.payload.createdId) await deletePosts(host, [action.payload.createdId]);
      return;
    case "deletePost":
      return { message: "A deleted post can't be restored.", canRetry: false };
    case "deleteList":
      return { message: "A deleted List can't be restored.", canRetry: false };
    case "like":
      return PRIOR_UNKNOWN;
    case "repost":
      return PRIOR_UNKNOWN;
    case "bookmark":
      return PRIOR_UNKNOWN;
    case "hide":
      return PRIOR_UNKNOWN;
    case "follow": {
      const { before, on } = action.payload;
      if (before === undefined) return PRIOR_UNKNOWN;
      // A follow that changed nothing leaves nothing to undo.
      if (before === on) return;
      const target = action.payload.user.id;
      await confirmedWrite(host, (api, me) => action.payload.on
        ? api.delete(`/2/users/${me.id}/following/${target}`)
        : api.post(`/2/users/${me.id}/following`, { target_user_id: target }));
      return;
    }
    case "mute": {
      const { before, on } = action.payload;
      if (before === undefined) return PRIOR_UNKNOWN;
      if (before === on) return;
      const target = action.payload.user.id;
      await confirmedWrite(host, (api, me) => action.payload.on
        ? api.delete(`/2/users/${me.id}/muting/${target}`)
        : api.post(`/2/users/${me.id}/muting`, { target_user_id: target }));
      return;
    }
    case "createList":
      if (action.payload.createdId) {
        const id = action.payload.createdId;
        await confirmedWrite(host, api => api.delete(`/2/lists/${id}`));
      }
      return;
    case "updateList": {
      const previous = action.payload.previous;
      if (!previous) return { message: "This List's earlier details were not recorded.", canRetry: false };
      const { changes } = action.payload;
      if ((changes.name !== undefined && previous.name === undefined)
        || (changes.description !== undefined && previous.description === undefined)) return PRIOR_UNKNOWN;
      const id = listId(host, action.payload.list);
      // Only what this update changed, so undoing it doesn't undo a later change to another field.
      const restored = {
        ...(changes.name !== undefined ? { name: previous.name } : {}),
        ...(changes.description !== undefined ? { description: previous.description } : {}),
        ...(changes.private !== undefined ? { private: previous.private } : {}),
      };
      await confirmedWrite(host, api => api.put(`/2/lists/${id}`, restored));
      return;
    }
    case "listMember":
      return PRIOR_UNKNOWN;
  }
}
