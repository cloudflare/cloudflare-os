// What a gadget can be connected to, and what reading it depends on: the resource types with
// their URL patterns, a binding's props, and the subresource IDs every read reports.

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { WEB_ORIGIN } from "./acme-env";
import { ITEM_ID } from "./acme-urls";

// STOP(resources): The connectable resource types. Choose each one's granularity and observer
// strategy first (see the write-gatekeeper skill). An `id` is stored with every binding of its
// type, so it can't change once shipped.
/** One item, by its page in the web app. */
export const ITEM_RESOURCE: SupportedResource = {
  id: "item",
  // The hyphen is escaped: a URL pattern's regular expressions are compiled in a mode that takes a
  // bare one in a class for a range.
  urlPattern: `${WEB_ORIGIN}/items/:itemId([A-Za-z0-9_\\-]+){/*}?`,
  title: "Acme Service Item",
  description: "One item: read it, and rename it once you approve.",
};

/** The resources in the order the picker lists them. */
export const ALL_RESOURCES: SupportedResource[] = [ITEM_RESOURCE];

/** Props baked into the gatekeeper Durable Object class for one binding. */
export type AcmeGatekeeperImplProps = {
  /** The `UserAccount` Durable Object holding the connection. */
  userObjectId: string;
  itemId: string;
};

// STOP(subresources): What a read depends on, as IDs an observer's own connection can be asked
// about. Qualify every ID with its tenant (organization, workspace, instance) unless the deployed
// Worker's configuration fixes one: `item/<id>` alone lets an observer in another tenant be
// allowed for a different item with the same ID. Refuse another tenant's IDs in
// `verifyObserverAccess()`. Report every dependency on every read: the tenant too, where
// membership in it is required besides the object's own permissions. `[]` means "nothing restricts this", never
// "the binding already checked".
/** The subresource ID of one item, `item/<id>`. */
export function itemSubresourceId(itemId: string): string {
  return formatSubresourceId({ fragments: [{ name: "item", id: itemId }] });
}

/**
 * The item an {@link itemSubresourceId} ID names.
 * @throws Error for any other ID, or a spelling other than the canonical one.
 */
export function parseSubresource(id: string): { itemId: string } {
  const { namespace, fragments: [item, ...rest] } = parseSubresourceId(id);
  if (namespace !== undefined || rest.length > 0 || item?.name !== "item" || !ITEM_ID.test(item.id)) {
    throw new Error("Not an Acme Service subresource ID.");
  }
  return { itemId: item.id };
}
