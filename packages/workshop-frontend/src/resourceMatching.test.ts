import { describe, expect, it } from 'vitest'
import { classifyMatch, completeUrl, getPlaceholderRanges } from './resourceMatching'

const CHAT_SPACE = 'https://chat.google.com/room/:spaceId'
const CHAT_THREAD = 'https://chat.google.com/room/:spaceId/:threadId'
const NETSUITE_CUSTOMER = 'https://acme.app.netsuite.com/app/common/entity/custjob.nl?id=:customerId'

describe('classifyMatch', () => {
  it('matches a link whose query string names no part of the path', () => {
    const link = 'https://chat.google.com/room/AAQANZZTsQ8?cls=7'
    expect(classifyMatch(link, CHAT_SPACE)).toEqual({ type: 'full' })
    expect(classifyMatch(link, CHAT_THREAD)).toEqual({ type: 'prefix', suffix: '/:threadId' })
  })

  it('matches a trailing slash followed by a query string', () => {
    expect(classifyMatch('https://github.com/o/r/?tab=readme', 'https://github.com/:owner/:repo'))
      .toEqual({ type: 'full' })
  })

  it('completes a parameter after a typed trailing slash without doubling it', () => {
    expect(classifyMatch('github.com/', 'https://github.com/:owner/:repo'))
      .toEqual({ type: 'prefix', suffix: ':owner/:repo' })
  })

  it("holds a link to the pattern's own query", () => {
    expect(classifyMatch('https://acme.app.netsuite.com/app/common/entity/custjob.nl?id=42', NETSUITE_CUSTOMER))
      .toEqual({ type: 'full' })
    expect(classifyMatch('https://acme.app.netsuite.com/app/common/entity/custjob.nl', NETSUITE_CUSTOMER))
      .toEqual({ type: 'prefix', suffix: '?id=:customerId' })
    expect(classifyMatch('https://acme.app.netsuite.com/app/common/entity/custjob.nl?other=42', NETSUITE_CUSTOMER))
      .toEqual({ type: 'none' })
  })

  it("holds a link to the pattern's parameter constraints", () => {
    const profile = 'https://x.com/:username([A-Za-z0-9_]{1,15})'
    expect(classifyMatch('https://x.com/jack', profile)).toEqual({ type: 'full' })
    expect(classifyMatch('https://x.com/not-a-valid-handle', profile)).toEqual({ type: 'none' })
  })

  it('matches a wildcard host only once the host is complete', () => {
    const thread = 'https://*.slack.com/archives/:conversationId/:messageId'
    expect(classifyMatch('https://acme.slack.com/arch', thread))
      .toEqual({ type: 'prefix', suffix: 'ives/:conversationId/:messageId' })
    expect(classifyMatch('https://acme.slack.com/archives/C1/p1', thread)).toEqual({ type: 'full' })
    expect(classifyMatch('https://slack', thread)).toEqual({ type: 'none' })
  })
})

describe('completeUrl', () => {
  it("inserts the completion into the path, keeping the link's query", () => {
    expect(completeUrl('https://chat.google.com/room/AAQANZZTsQ8?cls=7', '/:threadId'))
      .toBe('https://chat.google.com/room/AAQANZZTsQ8/:threadId?cls=7')
  })

  it('drops a trailing wildcard, which stands for everything below the path', () => {
    expect(completeUrl('jira.cfdata.org', '/browse/*')).toBe('jira.cfdata.org/browse/')
  })

  it("keeps the link's own query rather than adding the pattern's", () => {
    const link = 'https://acme.app.netsuite.com/app?id=42'
    const match = classifyMatch(link, NETSUITE_CUSTOMER)
    expect(match.type).toBe('prefix')
    expect(completeUrl(link, match.type === 'prefix' ? match.suffix : ''))
      .toBe('https://acme.app.netsuite.com/app/common/entity/custjob.nl?id=42')
  })
})

describe('getPlaceholderRanges', () => {
  it('finds a placeholder in a query value', () => {
    const url = 'https://acme.app.netsuite.com/app/common/entity/custjob.nl?id=:customerId'
    const [range] = getPlaceholderRanges(url)
    expect(url.slice(range.start, range.end)).toBe(':customerId')
  })
})
