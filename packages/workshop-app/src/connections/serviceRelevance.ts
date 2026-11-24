// By a service's id: those most people work in every day first (mail and documents, chat, code,
// tickets), then wikis and notes, then what fewer people use, so that the few anyone is likely to
// connect are at the top of a long list.
const SERVICES_FIRST = [
  'google', 'microsoft', 'slack', 'github', 'gitlab', 'jira', 'confluence', 'cf_wiki', 'notion', 'linear',
  'cloudflare', 'email', 'backstage', 'salesforce', 'workday', 'pagerduty', 'sentry',
]

/** An order that puts those `first` names, by their ids, in that order, then the rest by name. */
export const byRelevance = (first: readonly string[]) => {
  const rank = (vendorId: string) => {
    const at = first.indexOf(vendorId)
    return at === -1 ? first.length : at
  }
  return (a: { vendorId: string; name: string }, b: { vendorId: string; name: string }) =>
    rank(a.vendorId) - rank(b.vendorId) || a.name.localeCompare(b.name)
}

/** The services most people use first, then the rest by name. */
export const byServiceRelevance = byRelevance(SERVICES_FIRST)
