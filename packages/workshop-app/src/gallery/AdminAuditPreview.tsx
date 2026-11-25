import { useState } from 'react'
import { ADMIN_ACCESS_ERROR_CODES, type AdminAuditRecord, type AdminSettingsView } from '@gadgets/workshop-shared/api'
import { Button } from '@gadgets/ui'
import { AdminAuditSettings } from '@/settings/admin/AdminAuditSettings'
import { AdminCapabilityProvider } from '@/settings/admin/AdminContext'
import { never, PREVIEW_ADMIN_SETTINGS, previewAdmin, previewDelay } from './adminPreview'
import { Section } from './Section'

const at = (hoursAgo: number) => new Date(Date.UTC(2026, 10, 17, 12) - hoursAgo * 3_600_000)

const RECORDS: AdminAuditRecord[] = [
  {
    kind: 'setting', at: at(1), admin: 'ada', sessionId: 's1', via: 'api', method: 'setInstanceInstructions',
    changes: [{ setting: 'instanceInstructions', before: 'ACME Corp is a logistics company.', after: 'ACME Corp is a logistics company. Prefer metric units.\n'.repeat(9), excerpt: { offset: 0, beforeLength: 34, afterLength: 495 } }],
  },
  {
    kind: 'workspace', at: at(3), admin: 'grace', sessionId: 's2', via: 'cli', workspaceId: 'ws-quarterly', workspaceOwner: 'linus',
    workspaceTitle: 'Quarterly report', method: 'describe', args: { depth: 2 }, reason: 'Their agent stopped answering', access: 'metadata',
  },
  {
    kind: 'user', at: at(5), admin: 'grace', sessionId: 's2', via: 'cli', userId: 'margaret', method: 'inspectUser', args: {},
    reason: 'Can’t sign in', access: 'off', refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
  },
  {
    kind: 'setting', at: at(26), admin: 'ada', sessionId: 's3', via: 'api', method: 'setGatewayModelSettings',
    changes: [{ setting: 'gatewayModels', key: 'anthropic/claude-sonnet', before: '{"reasoning":"low"}', after: '{"reasoning":"high","contextWindow":200000}' }],
  },
  {
    kind: 'setting', at: at(50), admin: 'an-admin-with-a-name-long-enough-that-it-has-to-wrap@example.com', sessionId: 's4', via: 'api', method: 'setSiteName',
    changes: [{ setting: 'siteName', before: '', after: 'ACME Workshop' }],
  },
]

const STATES = {
  ready: 'With records',
  empty: 'With none',
  older: 'Older backend',
  limited: 'Held down by the maximum',
  loading: 'Loading',
  failed: 'Couldn’t load',
} as const
type State = keyof typeof STATES

const settingsOf = (state: State): AdminSettingsView => {
  if (state === 'older') {
    // As a backend older than the audit log sends it: neither of its settings.
    const { adminWorkspaceAccess: _access, adminAuditRetentionDays: _retention, ...older } = PREVIEW_ADMIN_SETTINGS
    return older as AdminSettingsView
  }
  if (state === 'limited') {
    return { ...PREVIEW_ADMIN_SETTINGS, adminWorkspaceAccess: { effective: 'off', chosen: 'metadata', max: 'off' }, adminAuditRetentionDays: { effective: 120, chosen: 30, min: 120 } }
  }
  return PREVIEW_ADMIN_SETTINGS
}

// A fake deployment for one state, which keeps what is changed in it, and narrows and pages its
// records as the server would, two to a page.
const fakeFor = (state: State) => {
  let settings = settingsOf(state)
  const records = state === 'empty' ? [] : RECORDS
  return previewAdmin({
    getSettings: async () => {
      if (state === 'loading') return never()
      await previewDelay()
      if (state === 'failed') throw new Error('The deployment didn’t answer.')
      return settings
    },
    getAdminAuditStats: async () => {
      await previewDelay()
      return {
        days: 7,
        totalEvents: records.length,
        writes: 0,
        byDay: ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'].map((day, index) => ({ day, count: state === 'empty' ? 0 : [0, 0, 0, 1, 1, 0, 3][index] })),
        topAdmins: state === 'empty' ? [] : [{ admin: 'ada', count: 3 }, { admin: 'grace', count: 2 }],
      }
    },
    listAdminAudit: async (query = {}) => {
      await previewDelay()
      const matching = records.filter((record) =>
        (!query.admin || record.admin === query.admin)
        && (!query.method || record.method === query.method)
        && (!query.kind || record.kind === query.kind)
        && (!query.workspace || (record.kind === 'workspace' && record.workspaceId === query.workspace))
        && (!query.owner || (record.kind === 'user' ? record.userId : record.kind === 'workspace' ? record.workspaceOwner : undefined) === query.owner))
      const from = Number(query.cursor ?? 0)
      return { records: matching.slice(from, from + 2), nextCursor: from + 2 < matching.length ? String(from + 2) : undefined }
    },
    setAdminWorkspaceAccess: async (level) => {
      await previewDelay()
      settings = { ...settings, adminWorkspaceAccess: { ...settings.adminWorkspaceAccess, chosen: level, effective: level } }
    },
    setAdminAuditRetentionDays: async (days) => {
      await previewDelay()
      settings = { ...settings, adminAuditRetentionDays: { ...settings.adminAuditRetentionDays, chosen: days, effective: Math.max(days, settings.adminAuditRetentionDays.min) } }
    },
  })
}

/** The deployment's Audit part, over a fake deployment, in each of its states. */
export const AdminAuditPreview = () => {
  const [state, setState] = useState<State>('ready')
  return (
    <Section title="AdminAuditSettings (an admin’s Audit part: what admins did this week, a most active admin narrowing the log to them; the log two to a page, narrowed by its filter menu or from a record’s details, each record opening to them: setting changes with a long value cut to six lines and JSON laid out, a call into a workspace, and a refused one into an account; inspection access and how long records are kept, 50 days refused; with no records; a backend older than the audit log; access held down by the deployment’s maximum and a retention under its minimum; while it loads; and when it could not be read)">
      <div className="flex w-full flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(STATES).map(([key, label]) => (
            <Button key={key} variant={key === state ? 'primary' : 'secondary'} onClick={() => setState(key as State)}>{label}</Button>
          ))}
        </div>
        <div className="flex w-full max-w-3xl flex-col gap-12 rounded-3xl bg-kumo-base py-6 ring-1 ring-kumo-line">
          {/* A deployment of its own for each state, as the part reads it once. */}
          <AdminCapabilityProvider key={state} admin={fakeFor(state)}>
            <AdminAuditSettings />
          </AdminCapabilityProvider>
        </div>
      </div>
    </Section>
  )
}
