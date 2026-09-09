import { describe, expect, it } from 'vitest'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { compositeSourceApps, isFirstPartyWorkItemsShell, navigableGatekeeperApps } from './useGatekeeperApps'

describe('navigableGatekeeperApps', () => {
  it('hides embedded composite sources but preserves shells and ordinary apps', () => {
    const apps: GatekeeperAppInfo[] = [
      {id: 'shell', vendorId: 'work_items', title: 'Work Items', composition: {kind: 'work-items'}},
      {id: 'jira', vendorId: 'jira', title: 'Jira', composition: {
        kind: 'work-items', role: 'jira', embeddedOnly: true,
      }},
      {id: 'context', vendorId: 'context', title: 'Context'},
    ]

    expect(navigableGatekeeperApps(apps).map((app) => app.id)).toEqual(['shell', 'context'])
  })
})

describe('compositeSourceApps', () => {
  const shell: GatekeeperAppInfo = {
    id: 'shell', vendorId: 'work_items', title: 'Work Items', composition: {kind: 'work-items'},
  }

  it('recognizes the deployed binding vendor ID, not the presentation kind', () => {
    expect(isFirstPartyWorkItemsShell(shell)).toBe(true)
    expect(isFirstPartyWorkItemsShell({...shell, vendorId: 'work-items'})).toBe(false)
    expect(isFirstPartyWorkItemsShell({...shell, composition: {kind: 'work_items'}})).toBe(false)
  })

  it('returns only explicit embedded sources with the shell kind', () => {
    const matching: GatekeeperAppInfo = {
      id: 'jira', vendorId: 'jira', title: 'Jira', composition: {
        kind: 'work-items', role: 'jira', embeddedOnly: true,
      },
    }
    const visibleRole: GatekeeperAppInfo = {
      id: 'visible', vendorId: 'visible', title: 'Visible', composition: {
        kind: 'work-items', role: 'visible',
      },
    }
    const otherKind: GatekeeperAppInfo = {
      id: 'other', vendorId: 'other', title: 'Other', composition: {
        kind: 'other', role: 'other', embeddedOnly: true,
      },
    }

    expect(compositeSourceApps(shell, [shell, matching, visibleRole, otherKind])).toEqual([matching])
  })

  it('does not expose Work Items sources to an impostor shell from another vendor', () => {
    const impostorShell: GatekeeperAppInfo = {
      id: 'impostor', vendorId: 'context', title: 'Impostor', composition: {kind: 'work-items'},
    }
    const jira: GatekeeperAppInfo = {
      id: 'jira-app', vendorId: 'jira', title: 'Jira', composition: {
        kind: 'work-items', role: 'jira', embeddedOnly: true,
      },
    }

    expect(isFirstPartyWorkItemsShell(impostorShell)).toBe(false)
    expect(compositeSourceApps(impostorShell, [impostorShell, jira])).toEqual([])
  })

  it('pins Work Items source roles to matching vendor ids before exposing capabilities', () => {
    const jira: GatekeeperAppInfo = {
      id: 'jira-app', vendorId: 'jira', title: 'Jira', composition: {
        kind: 'work-items', role: 'jira', embeddedOnly: true,
      },
    }
    const spoofedJira: GatekeeperAppInfo = {
      id: 'spoofed-jira', vendorId: 'zendesk', title: 'Bad Jira', composition: {
        kind: 'work-items', role: 'jira', embeddedOnly: true,
      },
    }
    const spoofedZendesk: GatekeeperAppInfo = {
      id: 'spoofed-zendesk', vendorId: 'jira', title: 'Bad Zendesk', composition: {
        kind: 'work-items', role: 'zendesk', embeddedOnly: true,
      },
    }

    expect(compositeSourceApps(shell, [spoofedJira, jira, spoofedZendesk])).toEqual([jira])
  })

  it('does not match malformed metadata with missing kinds or roles', () => {
    const malformedShell = {
      id: 'plain', vendorId: 'plain', title: 'Plain', composition: {role: undefined},
    } as GatekeeperAppInfo
    const malformedSource = {
      id: 'source', vendorId: 'source', title: 'Source',
      composition: {role: 'source', embeddedOnly: true},
    } as GatekeeperAppInfo

    expect(compositeSourceApps(malformedShell, [malformedSource])).toEqual([])
    expect(compositeSourceApps(shell, [{...malformedSource, composition: {
      kind: 'work-items', embeddedOnly: true,
    }} as GatekeeperAppInfo])).toEqual([])
  })
})
