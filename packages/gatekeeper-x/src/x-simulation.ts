// Simulation: every read replays the actions still waiting for a decision over what X returned, so
// an agent sees its own posts, likes and follows at once and never has to know approvals exist.
// Pending actions live only in the journal; nothing here writes, and caches are never edited.
//
// Two things are not simulated, because no read could contradict them: engagement counts in
// `metrics` (they lag real actions on X too), and hidden replies (X reports no hidden state).

import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { XListInfo, XPostInfo, XUserInfo, XUserSummary } from "./types";
import type { StoredDraft, XAction } from "./x-actions";
import type { StoredIdentity } from "./x-credentials";
import { comparableText, extractMentions, extractUrls } from "./x-text";

/** The journal's pending entries, in submission order. */
export type Pending = readonly JournalEntry<XAction>[];

/** Maps a temporary ID to the ID X assigned, or returns it unchanged while unassigned. */
export type Resolve = (id: string) => string;

const isProvisional = (id: string): boolean => id.startsWith("~");

/** The connected account as an embedded user. */
export function meSummary(me: StoredIdentity): XUserSummary {
  return {
    id: me.id,
    username: me.username,
    name: me.name,
    verified: me.verified,
    protected: me.protected,
    ...(me.profileImageUrl ? { profileImageUrl: me.profileImageUrl } : {}),
  };
}

/** A pending post as reads show it until X assigns its ID. */
function synthesize(draft: StoredDraft, ref: string, me: StoredIdentity, submittedAt: number,
                    conversationId: string, replyTo?: { postId: string; userId: string }): XPostInfo {
  const created = new Date(submittedAt);
  return {
    id: ref,
    text: draft.text,
    author: meSummary(me),
    createdAt: created,
    conversationId,
    ...(replyTo ? { replyTo } : {}),
    mentions: extractMentions(draft.text),
    hashtags: [...draft.text.matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)].map(match => match[1]),
    links: extractUrls(draft.text).map(url => ({ url })),
    media: (draft.images ?? []).map(image => ({
      type: "photo" as const, ...(image.altText ? { altText: image.altText } : {}),
    })),
    ...(draft.poll
      ? {
        poll: {
          options: draft.poll.options.map(label => ({ label, votes: 0 })),
          endsAt: new Date(submittedAt + draft.poll.durationMinutes * 60_000),
          open: true,
        },
      }
      : {}),
    metrics: { likes: 0, reposts: 0, replies: 0, quotes: 0, bookmarks: 0, impressions: 0 },
    replySettings: draft.replySettings ?? "everyone",
    possiblySensitive: false,
  };
}

/** Every post pending actions will publish that X has not yet assigned an ID, newest first. */
export function pendingPosts(pending: Pending, me: StoredIdentity, resolve: Resolve): XPostInfo[] {
  const posts: XPostInfo[] = [];
  for (const { action } of pending) {
    if (action.kind === "createPost") {
      const { refs, drafts, submittedAt } = action.payload;
      const root = resolve(refs[0]);
      drafts.forEach((draft, index) => {
        if (!isProvisional(resolve(refs[index]))) return;
        const replyTo = index > 0 ? { postId: resolve(refs[index - 1]), userId: me.id } : undefined;
        posts.push(synthesize(draft, refs[index], me, submittedAt + index, root, replyTo));
      });
    } else if (action.kind === "reply") {
      const { ref, draft, parent, conversationId, submittedAt } = action.payload;
      if (!isProvisional(resolve(ref))) continue;
      posts.push(synthesize(draft, ref, me, submittedAt, resolve(conversationId),
        { postId: resolve(parent.id), userId: parent.info.author.id }));
    }
  }
  return posts.toReversed();
}

/** The pending post with temporary ID `id`, if it is still waiting to publish. */
export function pendingPost(id: string, pending: Pending, me: StoredIdentity, resolve: Resolve): XPostInfo | undefined {
  return pendingPosts(pending, me, resolve).find(post => post.id === id);
}

/** Posts pending deletions remove, by the ID X assigned. */
function deleted(pending: Pending, resolve: Resolve): Set<string> {
  const ids = new Set<string>();
  for (const { action } of pending) {
    if (action.kind === "deletePost") ids.add(resolve(action.payload.post.id));
  }
  return ids;
}

/** The last pending state of a toggle per target, in submission order. */
function toggles<T>(pending: Pending, pick: (action: XAction) => { key: string; on: boolean; value: T } | undefined):
    Map<string, { on: boolean; value: T }> {
  const states = new Map<string, { on: boolean; value: T }>();
  for (const { action } of pending) {
    const toggle = pick(action);
    if (toggle) states.set(toggle.key, { on: toggle.on, value: toggle.value });
  }
  return states;
}

/** How a listing's posts relate to pending actions. */
export type PostOverlay =
  /** Others' posts: only deletions can touch them. */
  | { kind: "others" }
  /** The connected account's own timeline. */
  | { kind: "mine"; excludeReplies?: boolean }
  /** Direct replies to one post. */
  | { kind: "replies"; parentId: string }
  /** One conversation. */
  | { kind: "conversation"; conversationId: string }
  | { kind: "bookmarks" }
  | { kind: "liked" };

/**
 * A page of posts with pending actions replayed: deleted posts dropped, and on the newest page
 * the posts pending actions add, prepended without trimming the page, so no real row is lost.
 */
export function overlayPosts(items: readonly XPostInfo[], pending: Pending, overlay: PostOverlay,
                             context: { me: StoredIdentity; resolve: Resolve; newestPage: boolean }): XPostInfo[] {
  const { me, resolve, newestPage } = context;
  const gone = deleted(pending, resolve);
  let result = items.filter(post => !gone.has(post.id));
  let added: XPostInfo[] = [];

  switch (overlay.kind) {
    case "others":
      break;
    case "mine": {
      const undone = toggles(pending, action => action.kind === "repost"
        ? { key: resolve(action.payload.post.id), on: action.payload.on, value: null } : undefined);
      result = result.filter(post => !(post.repostOf && undone.get(post.repostOf.id)?.on === false));
      if (newestPage) {
        added = pendingPosts(pending, me, resolve)
          .filter(post => !(overlay.excludeReplies && post.replyTo));
      }
      break;
    }
    case "replies": {
      const parent = resolve(overlay.parentId);
      if (newestPage) added = pendingPosts(pending, me, resolve).filter(post => post.replyTo?.postId === parent);
      break;
    }
    case "conversation": {
      const conversation = resolve(overlay.conversationId);
      if (newestPage) {
        added = pendingPosts(pending, me, resolve).filter(post => post.conversationId === conversation);
      }
      break;
    }
    case "bookmarks":
    case "liked": {
      const kind = overlay.kind === "bookmarks" ? "bookmark" : "like";
      const states = toggles<XPostInfo>(pending, action => action.kind === kind
        ? { key: resolve(action.payload.post.id), on: action.payload.on, value: action.payload.post.info }
        : undefined);
      result = result.filter(post => states.get(post.id)?.on !== false);
      if (newestPage) {
        const present = new Set(result.map(post => post.id));
        added = [...states].filter(([id, state]) => state.on && !present.has(id) && !gone.has(id))
          .map(([, state]) => state.value).toReversed();
      }
      break;
    }
  }
  const present = new Set(result.map(post => post.id));
  return [...added.filter(post => !present.has(post.id)), ...result];
}

/** A post with pending actions replayed: `null` once a pending deletion removes it. */
export function overlayPost(info: XPostInfo, pending: Pending, resolve: Resolve): XPostInfo | null {
  return deleted(pending, resolve).has(info.id) ? null : info;
}

/** A profile with pending follows and unfollows replayed onto its relationship. */
export function overlayUser(info: XUserInfo, pending: Pending): XUserInfo {
  if (!info.relationship) return info;
  const state = toggles(pending, action => action.kind === "follow" && action.payload.user.id === info.id
    ? { key: info.id, on: action.payload.on, value: null } : undefined).get(info.id);
  // A follow request to a protected account is not a follow until accepted.
  if (state === undefined || (state.on && info.protected)) return info;
  return { ...info, relationship: { ...info.relationship, following: state.on } };
}

/** Whether the account mutes a user, with pending mutes replayed. */
export function overlayMuted(muted: boolean, pending: Pending, userId: string): boolean {
  const state = toggles(pending, action => action.kind === "mute" && action.payload.user.id === userId
    ? { key: userId, on: action.payload.on, value: null } : undefined).get(userId);
  return state?.on ?? muted;
}

/** The accounts the connected account follows, with pending follows and unfollows replayed. */
export function overlayFollowing(users: readonly XUserInfo[], pending: Pending, newestPage: boolean): XUserInfo[] {
  const states = toggles<XUserInfo>(pending, action => action.kind === "follow"
    ? { key: action.payload.user.id, on: action.payload.on, value: action.payload.user } : undefined);
  const result = users.filter(user => states.get(user.id)?.on !== false);
  if (!newestPage) return result;
  const present = new Set(result.map(user => user.id));
  const added = [...states].filter(([id, state]) => state.on && !state.value.protected && !present.has(id))
    .map(([, state]) => state.value).toReversed();
  return [...added, ...result];
}

/** A List's members, with pending additions and removals replayed. */
export function overlayMembers(users: readonly XUserInfo[], pending: Pending, listId: string,
                               resolve: Resolve, newestPage: boolean): XUserInfo[] {
  const list = resolve(listId);
  const states = toggles<XUserInfo>(pending, action => action.kind === "listMember" && resolve(action.payload.list.id) === list
    ? { key: action.payload.user.id, on: action.payload.add, value: action.payload.user } : undefined);
  const result = users.filter(user => states.get(user.id)?.on !== false);
  if (!newestPage) return result;
  const present = new Set(result.map(user => user.id));
  return [...[...states].filter(([id, state]) => state.on && !present.has(id)).map(([, state]) => state.value),
    ...result];
}

/** Lists pending creations add, until X assigns their IDs, newest first. */
function pendingLists(pending: Pending, resolve: Resolve): XListInfo[] {
  const lists: XListInfo[] = [];
  for (const { action } of pending) {
    if (action.kind !== "createList" || !isProvisional(resolve(action.payload.ref))) continue;
    const { ref, name, description, owner, submittedAt } = action.payload;
    lists.push({
      id: ref,
      name,
      description: description ?? "",
      private: action.payload.private === true,
      owner,
      memberCount: 0,
      followerCount: 0,
      createdAt: new Date(submittedAt),
    });
  }
  return lists.toReversed();
}

/** A List with pending changes replayed: `null` once a pending deletion removes it. */
export function overlayList(info: XListInfo, pending: Pending, resolve: Resolve): XListInfo | null {
  const id = resolve(info.id);
  let result: XListInfo = info;
  for (const { action } of pending) {
    if (action.kind === "deleteList" && resolve(action.payload.list.id) === id) return null;
    if (action.kind === "updateList" && resolve(action.payload.list.id) === id) {
      result = { ...result, ...action.payload.changes };
    }
  }
  return result;
}

/** The pending List with temporary ID `id`, if it is still waiting to be created. */
export function pendingList(id: string, pending: Pending, resolve: Resolve): XListInfo | undefined {
  const found = pendingLists(pending, resolve).find(list => list.id === id);
  return found && (overlayList(found, pending, resolve) ?? undefined);
}

/** The account's owned Lists, with pending creations, changes and deletions replayed. */
export function overlayOwnedLists(lists: readonly XListInfo[], pending: Pending, resolve: Resolve,
                                  newestPage: boolean): XListInfo[] {
  const result = lists.flatMap(list => overlayList(list, pending, resolve) ?? []);
  if (!newestPage) return result;
  const added = pendingLists(pending, resolve).flatMap(list => overlayList(list, pending, resolve) ?? []);
  return [...added, ...result];
}

/** The texts of posts waiting to publish, as `validateDraft` compares them. */
export function pendingTexts(pending: Pending): Set<string> {
  const texts = new Set<string>();
  for (const { action } of pending) {
    const drafts = action.kind === "createPost" ? action.payload.drafts
      : action.kind === "reply" ? [action.payload.draft] : [];
    for (const draft of drafts) if (draft.text.trim()) texts.add(comparableText(draft.text));
  }
  return texts;
}
