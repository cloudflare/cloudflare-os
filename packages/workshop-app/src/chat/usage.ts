const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const dollars = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * What the AI has used, in a few words: the tokens, rounded as people say them, then what they
 * cost once that comes to a cent or more.
 */
export const formatUsage = ({ tokens, cost }: { tokens: number; cost?: number }) => {
  const used = `${compact.format(tokens)} ${tokens === 1 ? 'token' : 'tokens'}`
  return cost !== undefined && cost >= 0.005 ? `${used} · ${dollars.format(cost)}` : used
}
