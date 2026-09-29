import type { ChatApi } from "./chat-api";
import type { ChatSpaceInfo, ChatUser } from "./chat-types";

/** How many participants an unnamed group chat's label names. */
const LABELLED_PARTICIPANTS = 3;
/** Membership pages read per conversation; a DM needs one, and a group chat's label only a few names. */
const MEMBER_PAGES = 3;
/** Conversations whose members are read at once. */
const MEMBER_CONCURRENCY = 8;
/** Users one People API lookup accepts. */
const PROFILE_BATCH = 200;

const LIST_FORMAT = new Intl.ListFormat("en");

/** Whether `describeConversations` has anything to add: a DM or an unnamed group chat. */
export const needsDescription = (info: ChatSpaceInfo): boolean =>
  info.type === "directMessage" || (info.type === "groupChat" && !info.name);

type Participants = { count: number; shown: ChatUser[] };

/**
 * Name direct messages and unnamed group chats after their other participants, and identify each
 * DM's `peer`. Spaces and named group chats return unchanged, as does anything whose lookup fails.
 *
 * Chat may omit members' display names, so nameless people are looked up in the People API, in
 * one batch across every conversation. Those names need no observer check: anyone who can open a
 * conversation is a participant.
 */
export async function describeConversations(
  api: ChatApi, infos: readonly ChatSpaceInfo[], selfId: string,
): Promise<ChatSpaceInfo[]> {
  const participants = await mapPooled(infos, MEMBER_CONCURRENCY, async (info): Promise<Participants | undefined> => {
    if (!needsDescription(info)) return undefined;
    const others = await otherParticipants(api, info.id, selfId).catch(() => undefined);
    if (!others || (info.type === "directMessage" && others.length !== 1)) return undefined;
    return { count: others.length, shown: others.slice(0, LABELLED_PARTICIPANTS) };
  });
  const profiles = await profileNames(api, participants.flatMap(found => found?.shown ?? []));
  return infos.map((info, i) => {
    const found = participants[i];
    return found ? nameAfter(info, found, profiles) : info;
  });
}

/** `describeConversations` for one conversation. */
export const describeConversation = async (
  api: ChatApi, info: ChatSpaceInfo, selfId: string,
): Promise<ChatSpaceInfo> => (await describeConversations(api, [info], selfId))[0];

function nameAfter(info: ChatSpaceInfo, { count, shown }: Participants, profiles: Map<string, string>): ChatSpaceInfo {
  const named = shown.map(user => {
    const name = user.name ?? profiles.get(user.id);
    return name ? { ...user, name } : user;
  });
  if (info.type === "directMessage") {
    const [peer] = named;
    return { ...info, peer, ...(peer.name ? { name: peer.name } : {}) };
  }
  const names = named.flatMap(user => user.name ?? []);
  if (names.length === 0) return info;
  // memberCount includes the connected user but not apps, and the listing may be cut short.
  const rest = Math.max(count, (info.memberCount ?? 0) - 1) - names.length;
  return { ...info, name: LIST_FORMAT.format(rest > 0 ? [...names, `${rest} more`] : names) };
}

/** People API names for the nameless people among `users`; absent wherever a lookup fails. */
async function profileNames(api: ChatApi, users: readonly ChatUser[]): Promise<Map<string, string>> {
  const ids = [...new Set(users.filter(user => !user.name && user.type === "human").map(user => user.id))];
  const batches = await Promise.all(
    Array.from({ length: Math.ceil(ids.length / PROFILE_BATCH) }, (_, i) =>
      api.profileNames(ids.slice(i * PROFILE_BATCH, (i + 1) * PROFILE_BATCH))
        .catch(() => new Map<string, string>())));
  return new Map(batches.flatMap(batch => [...batch]));
}

/** The conversation's joined people and apps other than the connected user, in Chat's order. */
async function otherParticipants(api: ChatApi, spaceName: string, selfId: string): Promise<ChatUser[]> {
  const others = new Map<string, ChatUser>();
  let pageToken: string | undefined;
  for (let page = 0; page < MEMBER_PAGES; page++) {
    const result = await api.listMembers(spaceName, pageToken ? { pageToken } : {});
    for (const membership of result.items) {
      if (membership.kind === "user" && membership.state === "joined" && membership.user.id !== selfId) {
        others.set(membership.user.id, membership.user);
      }
    }
    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }
  return [...others.values()];
}

/** `items.map(map)` with at most `limit` calls in flight. */
async function mapPooled<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await map(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
