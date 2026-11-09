/** One source the viewer's account could not open. */
export type MissingSource = {
  /** The account that was refused, as the person knows it (usually their email). */
  account: string
  /** Names the account when known; `account` falls back to it until the account list loads. */
  accountId?: number
  /** Names the vendor when known; `vendorName` falls back to it until then. */
  vendorId?: string
  vendorName: string
  /** The table, dataset or other resource, as the connection titles it. */
  resource: string
}

/**
 * A paste-ready access request for the viewer's data team: who, which table, which app, in one
 * sentence. The app's owner can't grant it; whoever manages the source can.
 */
export const accessRequestText = (missing: MissingSource[], appName: string): string => {
  const first = missing[0]
  if (!first) return ''
  const resources = missing.map(source => source.resource)
  const list = resources.length === 1
    ? resources[0]
    : `${resources.slice(0, -1).join(', ')} and ${resources.at(-1)}`
  const noun = resources.length === 1 ? 'table' : 'tables'
  return `Please give ${first.account} read access to the ${first.vendorName} ${noun} ${list}, ` +
    `which the ${appName} app uses.`
}

/** "bob@cloudflare.com can't open finance.accounts." */
export const missingSourceLine = (missing: MissingSource[]): string => {
  const first = missing[0]
  if (!first) return ''
  const resources = missing.map(source => source.resource).join(', ')
  return `${first.account} can't open ${resources}.`
}
