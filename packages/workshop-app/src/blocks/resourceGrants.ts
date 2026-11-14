// What a service's connect and manage dialogs (`ConnectionDialog`) do with its switches: one for
// each resource type it grants on its own (`grantable`). Plain, so it is tested apart.

/** Whether `urlPattern` is granted, where `granted` says what is; an account that does not say has everything. */
export const isGranted = (granted: readonly string[] | undefined, urlPattern: string) =>
  granted === undefined || granted.includes(urlPattern)

/**
 * What connecting asks for, with `selected` of `grantable` switched on: nothing, so everything,
 * when all are (as connecting without a choice would), or else just those, in the service's order.
 */
export const patternsToConnect = (grantable: readonly string[], selected: ReadonlySet<string>): string[] | undefined =>
  grantable.every((pattern) => selected.has(pattern)) ? undefined : grantable.filter((pattern) => selected.has(pattern))

/** Of `selected`, those an account still has to be granted, in the service's order. */
export const patternsToGrant = (grantable: readonly string[], selected: ReadonlySet<string>, granted: readonly string[] | undefined) =>
  grantable.filter((pattern) => selected.has(pattern) && !isGranted(granted, pattern))
