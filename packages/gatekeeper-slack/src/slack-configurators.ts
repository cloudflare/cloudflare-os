import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { SlackApi, type SlackWorkspace } from "./slack-api";
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

// Each query filters locally, so a picker reads each list from Slack once rather than per
// keystroke, which would soon exhaust Slack's per-workspace rate limits. A failed read is
// forgotten so the next query retries it.
class PickerLists {
  #api: SlackApi;
  #workspaces = new Map<string, Promise<SlackWorkspace[]>>();
  #conversations = new Map<string, Promise<SlackConversationInfo[]>>();

  constructor(api: SlackApi) {
    this.#api = api;
  }

  workspaces(): Promise<SlackWorkspace[]> {
    return remember(this.#workspaces, "", () => this.#api.listWorkspaces());
  }

  conversations(teamId: string): Promise<SlackConversationInfo[]> {
    return remember(this.#conversations, teamId,
        () => readConversations(this.#api.forWorkspace(teamId)));
  }
}

function remember<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (pending) return pending;
  let started = read();
  cache.set(key, started);
  started.catch(() => { if (cache.get(key) === started) cache.delete(key); });
  return started;
}

async function readConversations(api: SlackApi): Promise<SlackConversationInfo[]> {
  let items: SlackConversationInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PICKER_MAX_PAGES; page++) {
    let result = await api.listUserConversations(
        ["public_channel", "private_channel", "im", "mpim"], cursor, PICKER_PAGE_SIZE);
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor || items.length >= PICKER_MAX_OPTIONS * 3) break;
  }
  return items;
}

// Keep the SlackApi (and thus the token getter) off the public RpcTarget surface.
const listsByTarget = new WeakMap<object, PickerLists>();

function listsFor(target: object): PickerLists {
  let lists = listsByTarget.get(target);
  if (!lists) throw new Error("Slack configurator is not initialized.");
  return lists;
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
    listsByTarget.set(this, new PickerLists(api));
  }

  async listWorkspaces(query: string): Promise<ConfiguratorOption[]> {
    return (await listsFor(this).workspaces())
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
    listsByTarget.set(this, new PickerLists(api));
  }

  async listWorkspaces(query: string): Promise<ConfiguratorOption[]> {
    return (await listsFor(this).workspaces())
        .filter(team => optionMatches([team.id, team.name], query))
        .map(team => ({ value: team.id, title: team.name, subtitle: team.id }));
  }

  async listConversations(teamId: string, query: string): Promise<ConfiguratorOption[]> {
    return (await listsFor(this).conversations(teamId))
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
