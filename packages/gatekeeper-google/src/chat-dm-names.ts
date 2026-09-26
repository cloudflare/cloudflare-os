import { fetchWithAuthRetry, type AccessTokenProvider } from "./auth-retry";
import { ChatApi } from "./chat-api";
import type { ChatSpaceInfo, ChatUser } from "./chat-types";
import { readGoogleJson } from "./google-response";
import { obsContext } from "./observability";

/** A People-sourced name whose visibility must be verified separately from the Chat space. */
export type ChatProfileName = { id: string; name: string };

/** Space metadata plus any additional profile data used to name it. */
export type NamedChatSpace = { info: ChatSpaceInfo; profile?: ChatProfileName };

const USER_ID = /^users\/(\d{1,32})$/;
const logger = obsContext.createLogger({ component: "gatekeeper.google.chat.names", vendorId: "google" });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fresh, identity-matched profile names, also used with an observer's own credentials. */
export async function readChatProfileNames(
  ids: readonly string[], getToken: AccessTokenProvider, signal?: AbortSignal,
): Promise<Map<string, string>> {
  const resources = [...new Set(ids.filter(id => USER_ID.test(id)))]
    .map(id => `people/${id.slice("users/".length)}`);
  const names = new Map<string, string>();
  for (let offset = 0; offset < resources.length; offset += 100) {
    signal?.throwIfAborted();
    const batch = new Set(resources.slice(offset, offset + 100));
    const params = new URLSearchParams({ personFields: "names", sources: "READ_SOURCE_TYPE_PROFILE" });
    for (const resource of batch) params.append("resourceNames", resource);
    const response = await fetchWithAuthRetry(
      `https://people.googleapis.com/v1/people:batchGet?${params}`, { signal }, getToken,
      { retries: 1, timeoutMs: 1500 });
    if ([401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      logger.debug("Chat profile names unavailable", {
        event: "chat.names.unavailable", httpStatus: response.status,
      });
      continue;
    }
    const body = await readGoogleJson<unknown>(response, {
      provider: "Google People", operation: "people.batchGet", maxBytes: 1024 * 1024,
    });
    if (!record(body) || !Array.isArray(body.responses)) {
      throw new Error("Google People returned an invalid batch response.");
    }
    for (const item of body.responses) {
      if (!record(item) || typeof item.requestedResourceName !== "string" ||
          !batch.delete(item.requestedResourceName)) {
        throw new Error("Google People returned an unexpected profile identity.");
      }
      const status = record(item.status) ? item.status.code : undefined;
      if ((status !== undefined && status !== 0) ||
          (item.httpStatusCode !== undefined && item.httpStatusCode !== 200)) {
        if ([5, 7, 16].includes(Number(status)) || [401, 403, 404].includes(Number(item.httpStatusCode))) continue;
        throw new Error("Google People could not retrieve a requested profile.");
      }
      if (!record(item.person) || item.person.resourceName !== item.requestedResourceName) {
        throw new Error("Google People returned a mismatched profile identity.");
      }
      const fields = Array.isArray(item.person.names) ? item.person.names.filter(record).filter(field => {
        const source = record(field.metadata) && record(field.metadata.source) ? field.metadata.source.type : undefined;
        return source === undefined || source === "PROFILE" || source === "DOMAIN_PROFILE" || source === "ACCOUNT";
      }) : [];
      const field = fields.find(value => record(value.metadata) && value.metadata.primary === true)
        ?? (fields.length === 1 ? fields[0] : undefined);
      const name = typeof field?.displayName === "string" ? field.displayName.trim() : "";
      // Names become durable observer keys; don't admit unbounded or multiline labels.
      // oxlint-disable-next-line no-control-regex
      if (name && name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name)) {
        names.set(`users/${item.requestedResourceName.slice("people/".length)}`, name);
      }
    }
    if (batch.size > 0) throw new Error("Google People returned an incomplete batch response.");
  }
  return names;
}

/** Account-local, bounded DM labels. Ordinary named spaces and message senders need no lookup. */
export class ChatDmNames {
  #cache = new Map<string, { name?: string; profile?: ChatProfileName; expires: number }>();
  #tail: Promise<void> = Promise.resolve();

  constructor(private api: ChatApi, private getToken: AccessTokenProvider) {}

  async #peer(space: string, selfId: string, signal: AbortSignal): Promise<ChatUser | undefined> {
    const peers = new Map<string, ChatUser>();
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    // A DM has only two participants. Bound unexpected pagination rather than scanning a directory.
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      signal.throwIfAborted();
      const page = await this.api.listMembers(space, { pageToken, signal });
      for (const membership of page.items) {
        if (membership.id.startsWith(`${space}/members/`) && membership.state === "joined" &&
            membership.member && membership.member.id !== selfId) {
          peers.set(membership.member.id, membership.member);
        }
      }
      if (!page.nextPageToken) return peers.size === 1 ? [...peers.values()][0] : undefined;
      if (tokens.has(page.nextPageToken)) break;
      tokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    }
    return undefined;
  }

  /** Name only unnamed DMs; fetch People names in a batch only for peers Chat left unnamed. */
  resolve(
    spaces: readonly ChatSpaceInfo[], getSelfId: () => Promise<string>, deadline = Date.now() + 3000,
  ): Promise<NamedChatSpace[]> {
    // Overlapping metadata reads share the work instead of multiplying membership requests.
    // Their budget starts at invocation, so a queued call can use the cache without another scan.
    const result = this.#tail.then(() => this.#resolve(spaces, getSelfId, deadline));
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #resolve(
    spaces: readonly ChatSpaceInfo[], getSelfId: () => Promise<string>, deadline: number,
  ): Promise<NamedChatSpace[]> {
    const missing = [...new Set(spaces.filter(space => !space.name && space.type === "directMessage" &&
      (this.#cache.get(space.id)?.expires ?? 0) <= Date.now()).map(space => space.id))];
    if (missing.length > 0 && Date.now() < deadline - 1000) {
      const peers = new Map<string, ChatUser | undefined>();
      try {
        const selfId = await getSelfId();
        const memberDeadline = deadline - 1000; // Reserve time for the People batch.
        const signal = AbortSignal.timeout(Math.max(0, memberDeadline - Date.now()));
        // Keep membership fan-out small even for an account with hundreds of DMs.
        for (let offset = 0; offset < missing.length; offset += 4) {
          if (Date.now() >= memberDeadline) break;
          await Promise.all(missing.slice(offset, offset + 4).map(async space => {
            try {
              peers.set(space, await this.#peer(space, selfId, signal));
            } catch (error) {
              // A lookup our own deadline cut short is skipped work, not a missing name.
              if (signal.aborted) return;
              peers.set(space, undefined);
              logger.warn("Chat DM participant lookup unavailable", { event: "chat.dm.members.failed", error });
            }
          }));
        }
      } catch (error) {
        logger.warn("Chat DM identity unavailable", { event: "chat.dm.identity.failed", error });
      }
      let names = new Map<string, string>();
      try {
        names = await readChatProfileNames([...peers.values()].flatMap(peer =>
          peer?.type === "human" && !peer.name ? [peer.id] : []), this.getToken,
          AbortSignal.timeout(Math.max(0, deadline - Date.now())));
      } catch (error) {
        logger.warn("Chat DM profile lookup unavailable", { event: "chat.dm.profiles.failed", error });
      }
      // Unattempted DMs remain eligible on the next call; don't negative-cache skipped work.
      for (const [space, peer] of peers) {
        const name = peer?.name || (peer && names.get(peer.id));
        const profile = peer && !peer.name && name ? { id: peer.id, name } : undefined;
        this.#cache.delete(space);
        this.#cache.set(space, { name, profile, expires: Date.now() + (name ? 300_000 : 30_000) });
        while (this.#cache.size > 1000) this.#cache.delete(this.#cache.keys().next().value!);
      }
    }
    return spaces.map(info => {
      const cached = !info.name && info.type === "directMessage" ? this.#cache.get(info.id) : undefined;
      return cached?.name ? { info: { ...info, name: cached.name }, profile: cached.profile } : { info };
    });
  }
}
