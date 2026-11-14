import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { SlackApi } from "./slack-api";
import type { SlackConversationInfo } from "./types";
import type {
  ConversationConfiguratorRpc, ConfiguratorOption,
} from "./configurator/conversation-configurator-types";
import type { WorkspaceConfiguratorRpc } from "./configurator/workspace-configurator-types";
import type { ThreadConfiguratorRpc } from "./configurator/thread-configurator-types";

// Bound remote reads because picker filtering happens locally.
const PICKER_MAX_PAGES = 5;
const PICKER_PAGE_SIZE = 200;
const PICKER_MAX_OPTIONS = 100;

// Keep the SlackApi (and thus the token getter) off the public RpcTarget surface.
const apiByTarget = new WeakMap<object, SlackApi>();

function apiFor(target: object): SlackApi {
  let api = apiByTarget.get(target);
  if (!api) throw new Error("Slack configurator is not initialized.");
  return api;
}

function optionMatches(parts: (string | undefined)[], query: string): boolean {
  let lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return true;
  let corpus = parts.filter(Boolean).join(" ").toLowerCase();
  return lowerQuery.split(/\s+/).every(term => corpus.includes(term));
}

@validateRpc()
export class WorkspaceConfiguratorUI extends RpcTarget implements WorkspaceConfiguratorRpc {
  constructor(api: SlackApi) {
    super();
    apiByTarget.set(this, api);
  }

  async listWorkspaces(query: string): Promise<ConfiguratorOption[]> {
    return (await apiFor(this).listWorkspaces())
        .filter(team => optionMatches([team.id, team.name], query))
        .map(team => ({ value: team.id, title: team.name, subtitle: team.id }));
  }
}

@validateRpc()
export class ThreadConfiguratorUI extends RpcTarget implements ThreadConfiguratorRpc {
  async ping(): Promise<void> {}
}

@validateRpc()
export class ConversationConfiguratorUI extends RpcTarget implements ConversationConfiguratorRpc {
  constructor(api: SlackApi) {
    super();
    apiByTarget.set(this, api);
  }

  async listWorkspaces(query: string): Promise<ConfiguratorOption[]> {
    return (await apiFor(this).listWorkspaces())
        .filter(team => optionMatches([team.id, team.name], query))
        .map(team => ({ value: team.id, title: team.name, subtitle: team.id }));
  }

  async listConversations(teamId: string, query: string): Promise<ConfiguratorOption[]> {
    let api = apiFor(this).forWorkspace(teamId);
    let items: SlackConversationInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PICKER_MAX_PAGES; page++) {
      let result = await api.listUserConversations(
          ["public_channel", "private_channel", "im", "mpim"], cursor, PICKER_PAGE_SIZE);
      items.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor || items.length >= PICKER_MAX_OPTIONS * 3) break;
    }

    return items
        .map(info => this.#toOption(info))
        .filter(option => optionMatches([option.title, option.subtitle], query))
        .slice(0, PICKER_MAX_OPTIONS);
  }

  #toOption(info: SlackConversationInfo): ConfiguratorOption {
    switch (info.kind) {
      case "public_channel":
        return { value: info.id, title: `#${info.name ?? info.id}`, subtitle: "Public channel" };
      case "private_channel":
        return { value: info.id, title: `#${info.name ?? info.id}`, subtitle: "Private channel" };
      case "mpim":
        return { value: info.id, title: info.name ?? "Group DM", subtitle: "Group direct message" };
      case "im": {
        let name = info.peer ? (info.peer.displayName || info.peer.username) : info.id;
        return { value: info.id, title: `@${name}`, subtitle: "Direct message" };
      }
    }
  }
}
