// The capabilities resource configurator frames talk to. Only the List picker asks X anything: the
// account confirmation, and the post and profile forms, parse what the user types in the frame
// itself, since a preview would cost a read.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { XAccountConfiguratorRpc } from "./configurator/x-account-configurator-types";
import type { XConfiguratorOption, XListConfiguratorRpc } from "./configurator/x-list-configurator-types";
import type { XPostConfiguratorRpc } from "./configurator/x-post-configurator-types";
import type { XProfileConfiguratorRpc } from "./configurator/x-profile-configurator-types";
import type { XListInfo } from "./types";
import { LIST_FIELDS, XApi, requireData, type XEnvelope } from "./x-api";
import { accountSource, withinReadLimit } from "./x-credentials";
import { indexIncludes, toListInfo, type WireList } from "./x-normalize";
import { SNOWFLAKE, parseXUrl } from "./x-urls";

/**
 * How long the picker reuses the owned Lists it read. X allows 15 such reads per 15 minutes, and
 * the frame asks again on every focus and keystroke.
 */
const OWNED_LISTS_TTL_MS = 5 * 60 * 1000;
/** The most Lists `owned_lists` returns in one page, which is as many as the picker shows. */
const MAX_OWNED_LISTS = 100;

/** The capability of a configurator that asks nothing of X. */
@validateRpc()
export class XPlaceholderConfiguratorUI extends RpcTarget
  implements XAccountConfiguratorRpc, XPostConfiguratorRpc, XProfileConfiguratorRpc {}

function listOption(list: XListInfo): XConfiguratorOption {
  return {
    value: list.id,
    title: list.name,
    subtitle: `@${list.owner.username} · ${list.memberCount.toLocaleString("en-US")} ` +
      `member${list.memberCount === 1 ? "" : "s"}`,
    ...(list.private ? { meta: "Private" } : {}),
  };
}

/** The List picker: the account's own Lists, or whichever List a pasted link names. */
@validateRpc()
export class XListConfiguratorUI extends RpcTarget implements XListConfiguratorRpc {
  readonly #exports: Cloudflare.Exports;
  readonly #userObjectId: string;
  #owned?: { at: number; options: Promise<XConfiguratorOption[]> };

  constructor(exports: Cloudflare.Exports, userObjectId: string) {
    super();
    this.#exports = exports;
    this.#userObjectId = userObjectId;
  }

  async listLists(query: string): Promise<XConfiguratorOption[]> {
    const trimmed = query.trim();
    const parsed = parseXUrl(trimmed);
    const pasted = SNOWFLAKE.test(trimmed) ? trimmed : parsed?.kind === "list" ? parsed.listId : undefined;
    if (pasted !== undefined) {
      const envelope = await this.#read<WireList>(api => api.get<WireList>(`/2/lists/${pasted}`, LIST_FIELDS));
      return [listOption(toListInfo(requireData(envelope, "List"), indexIncludes(envelope.includes)))];
    }
    const needle = trimmed.toLowerCase();
    const owned = await this.#ownedLists();
    return needle ? owned.filter(option => option.title.toLowerCase().includes(needle)) : owned;
  }

  #ownedLists(): Promise<XConfiguratorOption[]> {
    const now = Date.now();
    if (this.#owned === undefined || now - this.#owned.at >= OWNED_LISTS_TTL_MS) {
      const options = this.#account().getIdentity()
        .then(me => this.#read<WireList[]>(api => api.get<WireList[]>(`/2/users/${me.id}/owned_lists`, {
          ...LIST_FIELDS, max_results: MAX_OWNED_LISTS,
        }), MAX_OWNED_LISTS))
        .then(envelope => {
          const includes = indexIncludes(envelope.includes);
          return (envelope.data ?? []).map(list => listOption(toListInfo(list, includes)));
        });
      const entry = { at: now, options };
      // A failure isn't kept, so the next keystroke asks again.
      options.catch(() => {
        if (this.#owned === entry) this.#owned = undefined;
      });
      this.#owned = entry;
    }
    return this.#owned.options;
  }

  #account() {
    return this.#exports.UserAccount.get(this.#exports.UserAccount.idFromString(this.#userObjectId));
  }

  /** One read as the account, within its daily read limit. */
  async #read<T>(op: (api: XApi) => Promise<XEnvelope<T>>, reserve = 1): Promise<XEnvelope<T>> {
    const source = accountSource(this.#exports, this.#userObjectId);
    return await withinReadLimit(this.#account(), reserve,
      () => source.run(creds => op(new XApi(creds.accessToken)), { replayable: true }));
  }
}
