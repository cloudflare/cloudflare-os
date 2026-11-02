/**
 * A workspace's address within a space: the key of a space that lists it and the slug its entry
 * there has (`SpaceWorkspaceInfo.slug`), which together are the URL /spaces/<spaceKey>/<slug>.
 */
export type WorkspaceAddress = { spaceKey: string; slug: string }

/** The path of an address, as it is shown to the user. */
export const workspaceAddressPath = ({ spaceKey, slug }: WorkspaceAddress): string =>
  `/spaces/${spaceKey}/${slug}`

/**
 * Whether `pathname` has the shape of a workspace's address, /spaces/<key>/<slug>, which is the
 * route that renders the workspace editor. A space's own page, /spaces/<key>, is not one.
 */
export const isWorkspaceAddressPath = (pathname: string): boolean =>
  /^\/spaces\/[^/]+\/[^/]+\/?$/.test(pathname)

/**
 * What the row of a workspace gains from the entry a space lists it under: where the row links
 * to and, for a user who may change that address, the way to.
 */
export type WorkspaceRowListing = {
  /** The entry's address, once it has a slug. The row links there in place of /workspace/<id>. */
  address: WorkspaceAddress | undefined
  /** Offers 'Change address' on the row. */
  onAddressChange: (() => void) | undefined
}
