import type { ChatApi } from "./chat-api";
import type { ChatSpaceInfo, ChatUser } from "./chat-types";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.google.chat", vendorId: "google" });

/** How many participants an unnamed group chat's label names. */
const LABELLED_PARTICIPANTS = 3;
/** Membership pages read per conversation; a DM needs one, and a group chat's label only a few names. */
const MEMBER_PAGES = 3;

const LIST_FORMAT = new Intl.ListFormat("en");

/** Whether `describeConversation` has anything to add: a DM or an unnamed group chat. */
export const needsDescription = (info: ChatSpaceInfo): boolean =>
  info.type === "directMessage" || (info.type === "groupChat" && !info.name);

/**
 * Name a direct message or unnamed group chat after its other participants, and identify a DM's
 * `peer`. Spaces and named group chats return unchanged, as does anything whose lookup fails.
 *
 * Chat may omit members' display names, so nameless people are looked up in the People API.
 * Those names need no observer check: anyone who can open the conversation is a participant.
 */
export async function describeConversation(
  api: ChatApi, info: ChatSpaceInfo, selfId: string,
): Promise<ChatSpaceInfo> {
  if (!needsDescription(info)) return info;
  return nameAfterParticipants(api, info, selfId).catch((error: unknown) => {
    logger.warn("failed to name a Google Chat conversation", { event: "chat.describe.failed", error });
    return info;
  });
}

async function nameAfterParticipants(
  api: ChatApi, info: ChatSpaceInfo, selfId: string,
): Promise<ChatSpaceInfo> {
  const dm = info.type === "directMessage";
  const others = await otherParticipants(api, info.id, selfId);
  if (dm && others.length !== 1) return info;
  const shown = others.slice(0, LABELLED_PARTICIPANTS);
  const profiles = await api.profileNames(
    shown.filter(user => !user.name && user.type === "human").map(user => user.id));
  const named = shown.map(user => {
    const name = user.name ?? profiles.get(user.id);
    return name ? { ...user, name } : user;
  });
  if (dm) {
    const [peer] = named;
    return { ...info, peer, ...(peer.name ? { name: peer.name } : {}) };
  }
  const names = named.flatMap(user => user.name ?? []);
  if (names.length === 0) return info;
  // memberCount includes the connected user but not apps, and the listing may be cut short.
  const rest = Math.max(others.length, (info.memberCount ?? 0) - 1) - names.length;
  return { ...info, name: LIST_FORMAT.format(rest > 0 ? [...names, `${rest} more`] : names) };
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
