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
  XApi, XApiError, XCreditsError, XRateLimitError, isOutcomeUnknown, requireData, xTime,
  LIST_FIELDS, type XEnvelope,
} from "./x-api";
import type { StoredIdentity } from "./x-credentials";
import { VENDOR_ID } from "./x-env";
import { sentContent, type SentContent, type WireList, type WirePost } from "./x-normalize";
import {
  TEXT_LIMIT, TEXT_LIMIT_PREMIUM, comparableText, comparableUrl, extractMentions, extractUrls, weightedLength,
} from "./x-text";

/** Most posts one thread may hold. */
export const MAX_THREAD_POSTS = 25;
/** Most images one post may carry. */
export const MAX_IMAGES_PER_POST = 4;
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

/** What a send recorded just before it went to X: when, and for a post the media it attached. */
export type SendAttempt = { at: number; mediaIds?: string[] };

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
  repost: { post: PostTarget; on: boolean; appliedAt?: number };
  bookmark: { post: PostTarget; on: boolean; appliedAt?: number };
  hide: { post: PostTarget; hidden: boolean; appliedAt?: number };
  follow: { user: XUserInfo; on: boolean; appliedAt?: number };
  mute: { user: XUserInfo; on: boolean; appliedAt?: number };
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
    previous?: { name: string; description: string; private: boolean };
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
 * @param pendingTexts Texts of posts already waiting to publish, since X refuses a duplicate.
 */
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
  if (text.trim() !== "" && pendingTexts.has(comparableText(text))) {
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
 * Runs a write X makes idempotent -- liking a liked post or following a followed account answers
 * with the resulting state, not an error -- so a replay under refreshed credentials is safe.
 */
async function toggle(host: XActionHost, op: (api: XApi, me: StoredIdentity) => Promise<unknown>,
                      what: string): Promise<void> {
  try {
    await host.write(op, { replayable: true });
  } catch (error) {
    refuse(error, what);
  }
}

/** How far X's clock may run behind ours. */
const CLOCK_SKEW_MS = 10_000;
/** How long after its attempt began X may date what a send created: well past our timeout. */
const RECONCILE_WINDOW_MS = 5 * 60 * 1000;

/** Most pages of owned Lists a reconciliation reads: X lets an account own at most 1,000 Lists. */
const MAX_OWNED_LIST_PAGES = 10;

/**
 * The end of a reconciliation that more than one candidate could satisfy: binding the wrong one
 * would have a revert delete it, and sending again could make a second.
 */
function unresolved(things: "posts" | "Lists"): ActionOutcomeUnknownError {
  return new ActionOutcomeUnknownError(`More than one of the account's ${things} from when this was ` +
    "sent could be this one, so which, if any, this action made is unknown, and it won't be sent " +
    `again. Check the account's ${things} on X, then reject this action to clear it.`);
}

/** One key per distinct content, however X rewrote its links and in whatever order it lists them. */
function contentKey(content: SentContent): string {
  return JSON.stringify([
    content.replyTo ?? null,
    comparableText(content.text),
    content.links.map(comparableUrl).toSorted(),
    content.mediaIds.toSorted(),
    content.poll,
  ]);
}

/**
 * Finds the post a send whose outcome X never reported made, so a retry binds it instead of
 * posting twice: among the account's posts dated around the attempt, the one with the draft's
 * reply parent, text, link destinations and poll, carrying the media the attempt uploaded.
 * @returns The post's ID, or `undefined` when none matches and the send may go again.
 * @throws ActionOutcomeUnknownError when more than one could match (`unresolved`).
 */
async function findPublished(host: XActionHost, draft: StoredDraft, replyTo: string | undefined,
                             attempt: SendAttempt): Promise<string | undefined> {
  const windowEnd = attempt.at + RECONCILE_WINDOW_MS;
  const envelope = await host.read<WirePost[]>(5, (api, me) => api.get<WirePost[]>(`/2/users/${me.id}/tweets`, {
    max_results: 100,
    start_time: xTime(new Date(attempt.at - CLOCK_SKEW_MS)),
    // Until the window has closed it runs to the present.
    ...(windowEnd < Date.now() - CLOCK_SKEW_MS ? { end_time: xTime(new Date(windowEnd)) } : {}),
    "tweet.fields": "created_at,referenced_tweets,note_tweet,entities,attachments",
  }));
  const wanted = contentKey({
    text: draft.text, replyTo, links: extractUrls(draft.text), mediaIds: attempt.mediaIds ?? [],
    poll: draft.poll !== undefined,
  });
  const matches = (envelope.data ?? []).filter(candidate => contentKey(sentContent(candidate)) === wanted);
  // A further page could hold another match, so it leaves the answer as open as two matches do.
  if (matches.length > 1 || envelope.meta?.next_token !== undefined) throw unresolved("posts");
  return matches[0]?.id;
}

/**
 * Finds the List a create whose outcome X never reported made, so a retry binds it instead of
 * creating a second: the one owned List created around the attempt with the requested name,
 * description and privacy. X cannot filter owned Lists by date, so every page is read.
 * @returns The List's ID, or `undefined` when none matches and the create may go again.
 * @throws ActionOutcomeUnknownError when more than one could match (`unresolved`).
 */
async function findCreatedList(host: XActionHost, payload: XActions["createList"], attempt: SendAttempt):
    Promise<string | undefined> {
  const matches: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_OWNED_LIST_PAGES; page++) {
    const envelope = await host.read<WireList[]>(5, (api, me) => api.get<WireList[]>(`/2/users/${me.id}/owned_lists`, {
      "list.fields": "created_at,description,private",
      max_results: 100,
      pagination_token: token,
    }));
    for (const list of envelope.data ?? []) {
      const created = Date.parse(list.created_at ?? "");
      if (list.name === payload.name && (list.description ?? "") === (payload.description ?? "")
          && (list.private === true) === (payload.private === true)
          && created >= attempt.at - CLOCK_SKEW_MS && created <= attempt.at + RECONCILE_WINDOW_MS) {
        matches.push(list.id);
      }
    }
    token = envelope.meta?.next_token;
    if (token === undefined) break;
  }
  if (matches.length > 1 || token !== undefined) throw unresolved("Lists");
  return matches[0];
}

/** Publishes one draft, replying to `replyTo` when given. */
async function publishOne(host: XActionHost, draft: StoredDraft, replyTo: string | undefined,
                          attemptKey: string): Promise<string> {
  const prior = host.attempts.get(attemptKey);
  if (prior) {
    const landed = await findPublished(host, draft, replyTo, prior);
    if (landed) {
      host.attempts.delete(attemptKey);
      return landed;
    }
  }

  const mediaIds: string[] = [];
  for (const image of draft.images ?? []) {
    const bytes = await host.readImage(image.file);
    try {
      const id = await host.write(api => api.uploadImage(bytes, image.mediaType));
      if (image.altText) {
        await host.write(api => api.post("/2/media/metadata", {
          id, metadata: { alt_text: { text: image.altText } },
        }), { replayable: true });
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
    const id = requireData(created, "post").id;
    host.attempts.delete(attemptKey);
    return id;
  } catch (error) {
    if (isOutcomeUnknown(error) || (error instanceof XApiError && error.isDuplicate)) {
      const landed = await findPublished(host, draft, replyTo, attempt);
      if (landed) {
        host.attempts.delete(attemptKey);
        return landed;
      }
      if (error instanceof XApiError && error.isDuplicate) {
        host.attempts.delete(attemptKey);
        throw new ActionApplyError("X refused this post as a duplicate of one posted recently.");
      }
      throw new Error("X did not confirm whether this post was published. Approving it again first " +
        "checks the account's recent posts, so it is not posted twice.", { cause: error });
    }
    host.attempts.delete(attemptKey);
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
 * Refuses to reject a publish that may already be on X: part of its thread went out, or X never
 * reported a send's outcome. Approving it again checks the account's recent posts before sending,
 * so nothing posts twice, and the result can then be reverted.
 */
function refuseIfSent(host: XActionHost, id: number, posts: number): void {
  const published = host.progress.get(id).length;
  const unconfirmed = Array.from({ length: posts }, (_, index) => host.attempts.get(`${id}:${index}`))
    .some(attempt => attempt !== undefined);
  if (published > 0) {
    throw new Error(`${published} of this thread's ${posts} posts are already on X, so it can't be ` +
      "rejected. Approve it again to finish the thread, then revert it to delete every post.");
  }
  if (unconfirmed) {
    throw new Error("X never confirmed whether this post was published, so it may already be on X " +
      "and can't be rejected. Approve it again -- that checks the account's recent posts first, so " +
      "it is never posted twice -- then revert it if it shouldn't stay.");
  }
}

/** Deletes posts, newest first; one already gone counts as deleted. */
async function deletePosts(host: XActionHost, ids: readonly string[]): Promise<void> {
  for (const id of ids.toReversed()) {
    try {
      await host.write(api => api.delete(`/2/tweets/${id}`), { replayable: true });
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
      refuseIfSent(host, ctx.id, payload.drafts.length);
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
      refuseIfSent(host, ctx.id, 1);
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
        implementsRevert: true,
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
        implementsRevert: true,
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
        implementsRevert: true,
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
      implementsRevert: true,
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
    apply: async (payload, host) => {
      await toggle(host, (api, me) => payload.on
        ? api.post(`/2/users/${me.id}/following`, { target_user_id: payload.user.id })
        : api.delete(`/2/users/${me.id}/following/${payload.user.id}`),
      payload.on ? "follow this account" : "unfollow this account");
      return { action: { ...payload, appliedAt: Date.now() } };
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
    apply: async (payload, host) => {
      await toggle(host, (api, me) => payload.on
        ? api.post(`/2/users/${me.id}/muting`, { target_user_id: payload.user.id })
        : api.delete(`/2/users/${me.id}/muting/${payload.user.id}`),
      payload.on ? "mute this account" : "unmute this account");
      return { action: { ...payload, appliedAt: Date.now() } };
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
      let createdId = prior && await findCreatedList(host, payload, prior);
      if (createdId === undefined) {
        const attempt: SendAttempt = { at: Date.now() };
        host.attempts.put(attemptKey, attempt);
        try {
          const created = await host.write(api => api.post<{ id: string }>("/2/lists", {
            name: payload.name,
            ...(payload.description ? { description: payload.description } : {}),
            ...(payload.private ? { private: true } : {}),
          }));
          createdId = requireData(created, "List").id;
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
    reject: async (_payload, host, ctx) => {
      if (host.attempts.get(`${ctx.id}:0`)) {
        throw new Error("X never confirmed whether this List was created, so it may already exist and " +
          "can't be rejected. Approve it again -- that checks the account's Lists first, so it is never " +
          "created twice -- then revert it if it shouldn't stay.");
      }
    },
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
    apply: async (payload, host) => {
      const id = listId(host, payload.list);
      const before = requireData(await host.read<WireList>(1, api => api.get<WireList>(`/2/lists/${id}`, LIST_FIELDS)), "List");
      await toggle(host, api => api.put(`/2/lists/${id}`, payload.changes), "change this List");
      return {
        action: {
          ...payload,
          previous: { name: before.name ?? "", description: before.description ?? "", private: before.private === true },
          appliedAt: Date.now(),
        },
      };
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
        await host.write(api => api.delete(`/2/lists/${id}`), { replayable: true });
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
        implementsRevert: true,
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

/**
 * Undoes an applied action with the inverse call. Posts are deleted, toggles flipped back, a List's
 * old details restored; a deletion cannot be undone.
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
    case "like": {
      const id = postId(host, action.payload.post);
      await host.write((api, me) => action.payload.on
        ? api.delete(`/2/users/${me.id}/likes/${id}`)
        : api.post(`/2/users/${me.id}/likes`, { tweet_id: id }), { replayable: true });
      return;
    }
    case "repost": {
      const id = postId(host, action.payload.post);
      await host.write((api, me) => action.payload.on
        ? api.delete(`/2/users/${me.id}/retweets/${id}`)
        : api.post(`/2/users/${me.id}/retweets`, { tweet_id: id }), { replayable: true });
      return;
    }
    case "bookmark": {
      const id = postId(host, action.payload.post);
      await host.write((api, me) => action.payload.on
        ? api.delete(`/2/users/${me.id}/bookmarks/${id}`)
        : api.post(`/2/users/${me.id}/bookmarks`, { tweet_id: id }), { replayable: true });
      return;
    }
    case "hide": {
      const id = postId(host, action.payload.post);
      await host.write(api => api.put(`/2/tweets/${id}/hidden`, { hidden: !action.payload.hidden }), { replayable: true });
      return;
    }
    case "follow": {
      const target = action.payload.user.id;
      await host.write((api, me) => action.payload.on
        ? api.delete(`/2/users/${me.id}/following/${target}`)
        : api.post(`/2/users/${me.id}/following`, { target_user_id: target }), { replayable: true });
      return;
    }
    case "mute": {
      const target = action.payload.user.id;
      await host.write((api, me) => action.payload.on
        ? api.delete(`/2/users/${me.id}/muting/${target}`)
        : api.post(`/2/users/${me.id}/muting`, { target_user_id: target }), { replayable: true });
      return;
    }
    case "createList":
      if (action.payload.createdId) {
        const id = action.payload.createdId;
        await host.write(api => api.delete(`/2/lists/${id}`), { replayable: true });
      }
      return;
    case "updateList": {
      const previous = action.payload.previous;
      if (!previous) return { message: "This List's earlier details were not recorded.", canRetry: false };
      const id = listId(host, action.payload.list);
      await host.write(api => api.put(`/2/lists/${id}`, previous), { replayable: true });
      return;
    }
    case "listMember": {
      const id = listId(host, action.payload.list);
      const user = action.payload.user.id;
      await host.write(api => action.payload.add
        ? api.delete(`/2/lists/${id}/members/${user}`)
        : api.post(`/2/lists/${id}/members`, { user_id: user }), { replayable: true });
      return;
    }
  }
}
