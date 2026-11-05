// The subresources Notion reads report, and the checks that read them back (see
// ObservationDescription.subresources and Gatekeeper.verifyObserverAccess).
//
// Two kinds, both named within the Notion workspace the binding owner's connection belongs to:
//   - `workspace/<workspaceId>`: membership of that workspace, which every read of a workspace
//     binding depends on (the workspace name and member directory are visible to any member).
//   - `workspace/<workspaceId>/item/<itemId>`: a page or database, by its id with the dashes removed
//     and lowercased (normalizeId), the spelling the legacy observer tracker stores. An item is
//     checked by whether the observer's own connection can retrieve it; the workspace prefix is the
//     item's identity only and adds no membership check.
// Notion is one product, so the IDs carry no namespace (see formatSubresourceId).

import type { RpcStub } from "cloudflare:workers";
import type { CacheKv, KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { NotionStore } from "./notion-actions";
import { NotionApiError, type NotionApi } from "./notion-api";

const WORKSPACE_FRAGMENT = "workspace";
const ITEM_FRAGMENT = "item";

/** A normalized Notion object id: a UUID's 32 hex digits, lowercase, without dashes. */
const ITEM_ID = /^[0-9a-f]{32}$/;

/**
 * Thrown in place of a subresource when the binding owner's connection has no stored workspace id
 * (it was connected before workspace ids were persisted): without it no read can name what it
 * depends on, so it fails closed until the owner reconnects.
 */
export const MISSING_WORKSPACE_ID_MESSAGE =
  "This Notion connection predates workspace-id tracking; please disconnect and reconnect " +
  "the owning Notion account before sharing this workspace.";

/**
 * How long an account reuses an answer about its access to a page or database, counted from when it
 * started asking Notion. Notion doesn't say when sharing changes: a revoked share is noticed only once
 * the answer that allowed it expires, while a denial is kept briefly so that a new share is noticed
 * soon.
 */
export const ITEM_ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
/** How long an account reuses a denial of access to a page or database; see ITEM_ACCESS_ALLOWED_TTL_MS. */
export const ITEM_ACCESS_DENIED_TTL_MS = 15_000;

/**
 * The spelling of a Notion object id that observer bookkeeping keys on: dashes removed, lowercase.
 * @param id A Notion page or database id, dashed or not.
 * @returns The normalized id.
 */
export function normalizeId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

/**
 * The subresource ID of membership of the Notion workspace `workspaceId`: `workspace/<workspaceId>`.
 * @throws Error when `workspaceId` is empty.
 */
export function workspaceSubresourceId(workspaceId: string): string {
  return formatSubresourceId({ fragments: [{ name: WORKSPACE_FRAGMENT, id: workspaceId }] });
}

/**
 * The subresource ID of the page or database `itemId` in the Notion workspace `workspaceId`:
 * `workspace/<workspaceId>/item/<normalized itemId>`.
 * @throws Error when `workspaceId` is empty or `itemId` is not a Notion object id (a provisional
 * id of a page not yet created included).
 */
export function itemSubresourceId(workspaceId: string, itemId: string): string {
  const id = normalizeId(itemId);
  if (!ITEM_ID.test(id)) throw new Error(`${itemId} is not a Notion page or database id.`);
  return formatSubresourceId({
    fragments: [{ name: WORKSPACE_FRAGMENT, id: workspaceId }, { name: ITEM_FRAGMENT, id }],
  });
}

/** A decoded Notion subresource ID (see parseNotionSubresource). */
export type NotionSubresource =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "item"; workspaceId: string; itemId: string };

/**
 * Decodes an ID {@link workspaceSubresourceId} or {@link itemSubresourceId} produced.
 * @throws Error for any other ID, including one spelling an item id another way.
 */
export function parseNotionSubresource(subresource: string): NotionSubresource {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const [workspace, item] = fragments;
  if (namespace === undefined && workspace.name === WORKSPACE_FRAGMENT) {
    if (fragments.length === 1) return { kind: "workspace", workspaceId: workspace.id };
    if (fragments.length === 2 && item.name === ITEM_FRAGMENT && ITEM_ID.test(item.id)) {
      return { kind: "item", workspaceId: workspace.id, itemId: item.id };
    }
  }
  throw new Error("Not a Notion subresource.");
}

/**
 * What a Notion binding gives access to: the whole workspace the connection reaches, or one page or
 * database (its subtree or rows included).
 */
export type NotionBinding = { kind: "workspace" } | { kind: "item"; itemId: string };

/** An observation that names its subresources, so leaving them out is a type error. */
export type NotionObservation = ObservationDescription & { subresources: string[] };

/** An observation's text, which a NotionObservationScope completes with its subresources. */
export type NotionObservationInput = Omit<ObservationDescription, "subresources" | "excludeObservers">;

/**
 * Authorizes an observation with the subresources it reports. Every Notion read authorizes through
 * here (by way of NotionObservationScope), so none can omit them.
 */
export async function authorizeNotionObservation(
  queue: RpcStub<ApprovalQueue>, observation: NotionObservation,
): Promise<void> {
  await queue.authorizeObservation(observation);
}

/**
 * Names what each read of one binding depends on. A session and every session, cursor and
 * sub-session it opens share one scope.
 *
 * An item binding reports its bound page or database on every read: that is what its admission
 * checked, and a page's subtree and a database's rows inherit its sharing, so nothing narrower is
 * reported. A workspace binding reports workspace membership on every read, plus each page or
 * database whose data the read reveals.
 */
export class NotionObservationScope {
  readonly #binding: NotionBinding;
  readonly #loadWorkspaceId: () => Promise<string | undefined>;
  #workspaceId: string | undefined;

  /**
   * @param binding The binding whose reads this scope names.
   * @param loadWorkspaceId Reads the binding owner's stored workspace id, once it is first needed.
   * A missing id fails each read that needs it, and is asked again by the next.
   */
  constructor(binding: NotionBinding, loadWorkspaceId: () => Promise<string | undefined>) {
    this.#binding = binding;
    this.#loadWorkspaceId = loadWorkspaceId;
  }

  /**
   * The subresources a read revealing data from `itemIds` depends on. Provisional ids (pages
   * created in this session and not yet applied) are skipped, since what a read shows of them is
   * the gadget's own staged content, not a Notion item an observer could be checked against.
   * @throws Error when the owner's connection has no workspace id, or an id is not a Notion id.
   */
  async subresources(itemIds: readonly string[]): Promise<string[]> {
    const workspaceId = await this.#ownerWorkspaceId();
    if (this.#binding.kind === "item") return [itemSubresourceId(workspaceId, this.#binding.itemId)];
    const ids = new Set([workspaceSubresourceId(workspaceId)]);
    for (const itemId of itemIds) {
      if (!NotionStore.isProvisional(itemId)) ids.add(itemSubresourceId(workspaceId, itemId));
    }
    return [...ids];
  }

  /**
   * Authorizes a read revealing data from `itemIds`, reporting its subresources (see
   * {@link subresources}).
   */
  async authorize(
    queue: RpcStub<ApprovalQueue>, itemIds: readonly string[], observation: NotionObservationInput,
  ): Promise<void> {
    await authorizeNotionObservation(
      queue, { ...observation, subresources: await this.subresources(itemIds) });
  }

  async #ownerWorkspaceId(): Promise<string> {
    if (this.#workspaceId !== undefined) return this.#workspaceId;
    const workspaceId = await this.#loadWorkspaceId();
    if (!workspaceId) throw new Error(MISSING_WORKSPACE_ID_MESSAGE);
    return this.#workspaceId = workspaceId;
  }
}

/**
 * Checks that every one of `subresources` is one this binding's reads report (see
 * NotionObservationScope), for verifyObserverAccess, which must refuse any other.
 * @param binding The binding asked about.
 * @param ownerWorkspaceId The binding owner's stored workspace id.
 * @param subresources IDs the Workshop asks about.
 * @throws Error when the owner's workspace id is unknown, or an ID is not a Notion subresource,
 * names another workspace, or (for an item binding) names anything but the bound item.
 */
export function assertBindingSubresources(
  binding: NotionBinding, ownerWorkspaceId: string | undefined, subresources: readonly string[],
): void {
  if (!ownerWorkspaceId) throw new Error(MISSING_WORKSPACE_ID_MESSAGE);
  const boundItemId = binding.kind === "item" ? normalizeId(binding.itemId) : undefined;
  for (const subresource of subresources) {
    const resource = parseNotionSubresource(subresource);
    if (resource.workspaceId !== ownerWorkspaceId) {
      throw new Error("A subresource names a Notion workspace other than this binding's.");
    }
    if (boundItemId !== undefined && (resource.kind !== "item" || resource.itemId !== boundItemId)) {
      throw new Error("A subresource names something other than this binding's page or database.");
    }
  }
}

/**
 * Names the credentials an account installs now: called on every install (a first connect, a
 * reconnect's commit), never on a token refresh, which keeps the same grant. Partitions the
 * account's access cache (see credentialsId).
 */
export function nameNewCredentials(kv: CacheKv): void {
  kv.put<string>("credentialsId", crypto.randomUUID());
}

/**
 * The name of the credentials an account holds now, or `undefined` while it holds none, which makes
 * the access cache bypass. Credentials installed before names existed are named on first use.
 * Every install names its credentials afresh (nameNewCredentials) and revoking deletes the name with
 * everything else, so no answer learned under earlier credentials is served under later ones.
 */
export function credentialsId(kv: CacheKv): string | undefined {
  if (!kv.get<string>("accessToken")) return undefined;
  let id = kv.get<string>("credentialsId");
  if (id === undefined) {
    id = crypto.randomUUID();
    kv.put<string>("credentialsId", id);
  }
  return id;
}

/**
 * Whether the account an access check runs as can read each of `subresources`, in order. All IDs are
 * parsed before anything is asked. Workspace membership compares the account's own stored workspace
 * id, asking nothing of Notion (an account with none is not a member). An item is retrieved with the
 * account's own token, one at a time, and the answer cached under the full subresource ID: an allowed
 * answer for ITEM_ACCESS_ALLOWED_TTL_MS, a denial for ITEM_ACCESS_DENIED_TTL_MS.
 * @param account The account's access cache, stored workspace id, and Notion API.
 * @param subresources IDs to check.
 * @returns One answer per ID.
 * @throws Error for an ID that is not a Notion subresource, or when access can't be determined (see
 * hasItemAccess), which is never cached.
 */
export async function checkNotionSubresourceAccess(
  account: {
    access: KvTtlCache;
    workspaceId: string | undefined;
    api: Pick<NotionApi, "detectKind">;
  },
  subresources: readonly string[],
): Promise<boolean[]> {
  const resources = subresources.map(parseNotionSubresource);
  const answers: boolean[] = [];
  for (const [index, resource] of resources.entries()) {
    if (resource.kind === "workspace") {
      answers.push(!!account.workspaceId && account.workspaceId === resource.workspaceId);
    } else {
      answers.push(await account.access.cached(subresources[index],
        allowed => allowed ? ITEM_ACCESS_ALLOWED_TTL_MS : ITEM_ACCESS_DENIED_TTL_MS,
        () => hasItemAccess(account.api, resource.itemId)));
    }
  }
  return answers;
}

/**
 * Whether `api`'s connection can retrieve the page or database `itemId`. Notion answers 404
 * (object_not_found), 403 or `restricted_resource` for an item a connection cannot see, and a
 * `validation_error` 400 for an id it does not recognise as one; those are a definite no. Anything
 * else — a token rejected even after the API's own refresh, missing credentials, a rate limit, an
 * outage — says nothing about access, so it is rethrown.
 */
export async function hasItemAccess(api: Pick<NotionApi, "detectKind">, itemId: string): Promise<boolean> {
  try {
    await api.detectKind(itemId);
    return true;
  } catch (error) {
    if (error instanceof NotionApiError && (
      error.status === 404 || error.status === 403 || error.code === "restricted_resource" ||
      (error.status === 400 && error.code === "validation_error"))) {
      return false;
    }
    throw error;
  }
}
