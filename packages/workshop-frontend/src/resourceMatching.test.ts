import { describe, expect, it } from 'vitest'
import { classifyMatch, completeUrl, getPlaceholderRanges } from './resourceMatching'

const CHAT_SPACE = 'https://chat.google.com/:kind(room|dm)/:spaceId'
const CHAT_THREAD = 'https://chat.google.com/:kind(room|dm)/:spaceId/:threadId{/:messageId}?'
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
    expect(classifyMatch('https://acme.app.netsuite.com/app/common/entity/custjob.nl?other=42', NETSUITE_CUSTOMER))
      .toEqual({ type: 'none' })
  })

  it.each([
    ['h', 'ttps://acme.app.netsuite.com/app/common/entity/custjob.nl?id='],
    ['https://acme.app.netsuite.com/', 'app/common/entity/custjob.nl?id='],
    ['https://acme.app.netsuite.com/app/common/entity/custjob.nl', '?id='],
  ])("completes %s through the pattern's query, leaving its value to type", (typed, suffix) => {
    expect(classifyMatch(typed, NETSUITE_CUSTOMER)).toEqual({ type: 'prefix', suffix })
    expect(classifyMatch(completeUrl(typed, suffix) + '42', NETSUITE_CUSTOMER)).toEqual({ type: 'full' })
  })

  it.each([
    ['https://linear.app/acme/issue/', 'https://linear.app/:workspace/issue/:issueId{/:rest}*', ':issueId', 'ENG-1'],
    ['https://acme.atlassian.net/wiki/spaces/ENG/pages/', 'https://*.atlassian.net/wiki/spaces/:spaceKey/pages/:pageId/*?', ':pageId', '123'],
    ['https://x.com/jack/status/', 'https://x.com/*/status/:postId{/*}?', ':postId', '1'],
    ['https://x.com/', 'https://x.com/:username([A-Za-z0-9_]{1,15})', ':username', 'jack'],
  ])('completes %s through its required segments only, in plain placeholders', (typed, pattern, suffix, value) => {
    expect(classifyMatch(typed, pattern)).toEqual({ type: 'prefix', suffix })
    expect(classifyMatch(typed + value, pattern)).toEqual({ type: 'full' })
  })

  it.each([
    ['https://chat.google.com/', 'room/:spaceId'],
    ['https://chat.google.com/ro', 'om/:spaceId'],
    ['https://chat.google.com/d', 'm/:spaceId'],
    ['https://chat.google.com/dm/', ':spaceId'],
  ])('completes %s with whichever word of a choice it has begun, else the first', (typed, suffix) => {
    expect(classifyMatch(typed, CHAT_SPACE)).toEqual({ type: 'prefix', suffix })
  })

  it('accepts every word of a choice', () => {
    expect(classifyMatch('https://chat.google.com/dm/nAs4SyAAAAE', CHAT_THREAD)).toEqual({ type: 'prefix', suffix: '/:threadId' })
    expect(classifyMatch('https://chat.google.com/dm/nAs4SyAAAAE/HyxlRqVDmjs/HyxlRqVDmjs?cls=10', CHAT_THREAD))
      .toEqual({ type: 'full' })
  })

  it.each([
    ['h', CHAT_THREAD, 'ttps://chat.google.com/room/:spaceId/:threadId'],
    ['https://', 'https://x.com/:username([A-Za-z0-9_]{1,15})', 'x.com/:username'],
  ])('completes the scheme %s in plain placeholders', (typed, pattern, suffix) => {
    expect(classifyMatch(typed, pattern)).toEqual({ type: 'prefix', suffix })
  })

  it('completes a host in any case, and a path only in its own', () => {
    expect(classifyMatch('https://Chat.Google.com/ro', CHAT_SPACE)).toEqual({ type: 'prefix', suffix: 'om/:spaceId' })
    expect(classifyMatch('https://chat.google.com/RO', CHAT_SPACE)).toEqual({ type: 'none' })
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

  it("keeps the link's own query when completing its path", () => {
    const link = 'https://acme.app.netsuite.com/app?id=42'
    const match = classifyMatch(link, NETSUITE_CUSTOMER)
    expect(match.type).toBe('prefix')
    expect(completeUrl(link, match.type === 'prefix' ? match.suffix : ''))
      .toBe('https://acme.app.netsuite.com/app/common/entity/custjob.nl?id=42')
  })
})

describe('getPlaceholderRanges', () => {
  it('leaves a query value that starts with a colon alone', () => {
    expect(getPlaceholderRanges('https://github.com/o/r/issues?q=:open')).toEqual([])
  })
})
