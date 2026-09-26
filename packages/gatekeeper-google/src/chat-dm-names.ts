import type { ChatApi } from "./chat-api";
import type { ChatSpaceInfo } from "./chat-types";

/**
 * Label an unnamed direct message with its other participant's Chat display name.
 *
 * Chat itself names the members of a DM the account is in, so no further lookup is involved: when
 * Chat omits the name, the DM simply stays unnamed. Named spaces and group chats return unchanged.
 */
export async function nameDirectMessage(
  api: ChatApi, info: ChatSpaceInfo, selfId: string,
): Promise<ChatSpaceInfo> {
  if (info.name || info.type !== "directMessage") return info;
  const peers = new Map<string, string | undefined>();
  let pageToken: string | undefined;
  // A DM has two participants; bound unexpected pagination rather than scanning a directory.
  for (let page = 0; page < 3; page++) {
    const result = await api.listMembers(info.id, pageToken ? { pageToken } : {});
    for (const membership of result.items) {
      if (membership.state === "joined" && membership.member && membership.member.id !== selfId) {
        peers.set(membership.member.id, membership.member.name);
      }
    }
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  const name = peers.size === 1 ? [...peers.values()][0] : undefined;
  return name ? { ...info, name } : info;
}
