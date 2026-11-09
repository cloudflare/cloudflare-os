import { describe, expect, it } from 'vitest'
import { accessRequestText, missingSourceLine } from './accessRequest'

const missing = { account: 'bob@cloudflare.com', vendorName: 'BigQuery', resource: 'finance.accounts' }

describe('access request', () => {
  it('names the account and the table', () => {
    expect(missingSourceLine([missing])).toBe("bob@cloudflare.com can't open finance.accounts.")
  })

  it('is one paste-ready sentence: requester, table, app', () => {
    expect(accessRequestText([missing], 'Workers Paid billing')).toBe(
      'Please give bob@cloudflare.com read access to the BigQuery table finance.accounts, ' +
      'which the Workers Paid billing app uses.')
  })

  it('lists several tables', () => {
    expect(accessRequestText(
      [missing, { ...missing, resource: 'finance.invoices' }], 'Billing',
    )).toBe('Please give bob@cloudflare.com read access to the BigQuery tables finance.accounts ' +
      'and finance.invoices, which the Billing app uses.')
  })
})
