// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { MAX_ADMIN_AUDIT_RETENTION_DAYS } from '@gadgets/workshop-shared/api'
import type {
  AdminApi,
  AdminAuditPage,
  AdminAuditStats,
  AdminSettingRecord,
} from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import type { AuditSettings } from './auditSettings'

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; description?: string; variant: string }) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

import { AdminAuditPanel } from './AdminAuditPanel'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const RETENTION_LABEL = 'Keep audit records for (days)'

const settingsWith = (patch: {
  retention?: Partial<AuditSettings['adminAuditRetentionDays']>
} = {}): AuditSettings => ({
  adminAuditRetentionDays: { effective: 90, chosen: 90, min: 90, ...patch.retention },
})

const testStats = (patch: Partial<AdminAuditStats> = {}): AdminAuditStats => ({
  days: 7,
  totalEvents: 5,
  byDay: [
    { day: '2026-10-15', count: 0 },
    { day: '2026-10-16', count: 1 },
    { day: '2026-10-17', count: 0 },
    { day: '2026-10-18', count: 0 },
    { day: '2026-10-19', count: 2 },
    { day: '2026-10-20', count: 0 },
    { day: '2026-10-21', count: 2 },
  ],
  topAdmins: [{ admin: 'admin', count: 4 }, { admin: 'second-admin', count: 1 }],
  ...patch,
})

const SETTING_AT = new Date('2026-10-21T08:00:00Z')

const settingRecord = (patch: Partial<AdminSettingRecord> = {}): AdminSettingRecord => ({
  kind: 'setting',
  at: SETTING_AT,
  admin: 'second-admin',
  sessionId: 'session-2',
  via: 'api',
  method: 'setSiteName',
  changes: [{ setting: 'siteName', before: 'Old name', after: 'New name' }],
  ...patch,
})

const testPage = (records = [settingRecord()]): AdminAuditPage => ({ records })

const fakeAdmin = () => ({
  getAdminAuditStats: vi.fn<AdminApi['getAdminAuditStats']>(async () => testStats()),
  listAdminAudit: vi.fn<AdminApi['listAdminAudit']>(async () => testPage()),
  setAdminAuditRetentionDays: vi.fn<AdminApi['setAdminAuditRetentionDays']>(async () => {}),
})

const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

const click = (element: HTMLElement) => act(async () => { element.click() })

const button = (name: string) => {
  const element = [...document.body.querySelectorAll('button')]
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)
  if (!element) throw new Error(`no button ${name}`)
  return element
}

describe('AdminAuditPanel', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (settings: AuditSettings = settingsWith(), admin = fakeAdmin()) => {
    const onSettingsChanged = vi.fn<() => Promise<void>>(async () => {})
    // Shows what a re-read of the settings reported.
    const show = (reported: AuditSettings) => act(async () => root.render(
      <AdminAuditPanel
        admin={admin as unknown as RpcStub<AdminApi>}
        settings={reported}
        onSettingsChanged={onSettingsChanged}
      />))
    await show(settings)
    return { ...admin, onSettingsChanged, show }
  }

  const hasButton = (name: string) =>
    [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === name)

  // The card a heading titles.
  const card = (title: string) => {
    const heading = [...container.querySelectorAll('h2, h3')].find((h) => h.textContent === title)
    if (!heading?.parentElement) throw new Error(`no card ${title}`)
    return heading.parentElement
  }

  const retentionInput = () => {
    const labelElement = [...container.querySelectorAll('label')]
      .find((element) => element.textContent?.startsWith(RETENTION_LABEL))
    const element = labelElement && document.getElementById(labelElement.htmlFor)
    if (!(element instanceof HTMLInputElement)) throw new Error(`no input labeled ${RETENTION_LABEL}`)
    return element
  }

  const recentItems = () => [...card('Recent activity').querySelectorAll('li')]
    .filter((li) => li.parentElement?.parentElement === card('Recent activity'))

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    addToast.mockReset()
    vi.restoreAllMocks()
  })

  describe('the log', () => {
    it('loads the last week’s counts and the 20 newest records', async () => {
      const { getAdminAuditStats, listAdminAudit } = await render()

      expect(getAdminAuditStats).toHaveBeenCalledExactlyOnceWith({ days: 7 })
      expect(listAdminAudit).toHaveBeenCalledExactlyOnceWith({ limit: 20 })
    })

    it('shows the week’s total and each day’s count, oldest first, labelled with its date', async () => {
      await render()

      const week = card('Settings changes, last 7 days')
      expect(week.textContent).toContain('5 changes')
      const rows = [...week.querySelectorAll('tbody tr')]
      expect(rows.map((row) => row.querySelector('time')?.getAttribute('dateTime')))
        .toEqual(testStats().byDay.map(({ day }) => day))
      expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual(['0', '1', '0', '0', '2', '0', '2'])
    })

    it('shows the top admins', async () => {
      await render()

      expect([...card('Most active admins').querySelectorAll('li')].map((li) => li.textContent))
        .toEqual(['admin4', 'second-admin1'])
    })

    it('shows a setting record: its method, and each change as before → after', async () => {
      await render()

      const [setting] = recentItems()
      expect(setting.textContent).toContain(`${formatFullTimestamp(SETTING_AT)} · second-admin via API`)
      expect(setting.textContent).toContain('setSiteName')
      expect(setting.textContent).toContain('siteNameOld name→ changed to New name')
    })

    it('names an entry by its key, shows an absent side as — (announced as none), and labels a keyless formats change as the order', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([settingRecord({
        method: 'setFormatOrder',
        changes: [
          { setting: 'formats', key: 'bp-new', after: '{"agentHint":"x"}' },
          { setting: 'formats', before: '["bp-a","bp-b"]', after: '["bp-b","bp-a"]' },
        ],
      })]))

      await render(settingsWith(), admin)

      const changes = [...recentItems()[0].querySelectorAll('li')].map((li) => li.textContent)
      expect(changes).toEqual([
        'formats · bp-new—none→ changed to {"agentHint":"x"}',
        'Order of formats["bp-a","bp-b"]→ changed to ["bp-b","bp-a"]',
      ])
      // The glyphs are hidden from screen readers, which hear "changed to" and "none" instead.
      const glyphs = [...recentItems()[0].querySelectorAll('li span')]
        .filter((span) => span.textContent === '→' || span.textContent === '—')
      expect(glyphs).toHaveLength(3)
      for (const glyph of glyphs) expect(glyph.getAttribute('aria-hidden')).toBe('true')
    })

    it('names the provider order, and each provider’s model order, as orders', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([settingRecord({
        method: 'setGatewayModelOrder',
        changes: [
          { setting: 'providerOrder', before: '[]', after: '["openai"]' },
          { setting: 'modelOrder', key: 'openai', after: '["gpt-6-luna"]' },
        ],
      })]))

      await render(settingsWith(), admin)

      const changes = [...recentItems()[0].querySelectorAll('li')].map((li) => li.textContent)
      expect(changes).toEqual([
        'Order of providers[]→ changed to ["openai"]',
        'Order of models · openai—none→ changed to ["gpt-6-luna"]',
      ])
    })

    it('names each long value’s toggle after its change and side', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([settingRecord({
        method: 'setInstanceInstructions',
        changes: [{ setting: 'instanceInstructions', before: 'a'.repeat(500), after: 'b'.repeat(500) }],
      })]))

      await render(settingsWith(), admin)

      expect(button('Show all of instanceInstructions, before').textContent).toBe('Show all')
      await click(button('Show all of instanceInstructions, after'))
      expect(button('Show less of instanceInstructions, after').textContent).toBe('Show less')
      expect(button('Show all of instanceInstructions, before')).toBeDefined()
    })

    it('labels an excerpt with where it starts and the whole lengths', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([settingRecord({
        method: 'setInstanceInstructions',
        changes: [{
          setting: 'disabledResources', key: 'vendor',
          before: 'a'.repeat(100), after: 'b'.repeat(100),
          excerpt: { offset: 7900, beforeLength: 8000, afterLength: 8020 },
        }],
      })]))

      await render(settingsWith(), admin)

      expect(recentItems()[0].textContent)
        .toContain('Excerpt from character 7,901 · 8,000 → 8,020 characters')
    })

    it('says when there is nothing to show', async () => {
      const admin = fakeAdmin()
      admin.getAdminAuditStats.mockResolvedValue(testStats({ totalEvents: 0, topAdmins: [] }))
      admin.listAdminAudit.mockResolvedValue(testPage([]))

      await render(settingsWith(), admin)

      expect(card('Most active admins').textContent).toContain('No admin activity in this window.')
      expect(card('Recent activity').textContent).toContain('No admin activity is recorded yet.')
    })

    it('loads both again on Refresh', async () => {
      const { getAdminAuditStats, listAdminAudit } = await render()
      listAdminAudit.mockResolvedValueOnce(testPage([settingRecord({ admin: 'newest-admin' })]))

      await click(button('Refresh'))

      expect(getAdminAuditStats).toHaveBeenCalledTimes(2)
      expect(listAdminAudit).toHaveBeenCalledTimes(2)
      expect(recentItems()[0].textContent).toContain('newest-admin')
    })

    // A change reloads the log so that its own record shows, even while an earlier load is out.
    it('ignores a load that a later one superseded', async () => {
      const admin = fakeAdmin()
      const first = deferred<AdminAuditPage>()
      admin.listAdminAudit.mockReturnValueOnce(first.promise as ReturnType<AdminApi['listAdminAudit']>)
      await render(settingsWith(), admin)
      admin.listAdminAudit.mockResolvedValueOnce(testPage([settingRecord({ admin: 'later-admin' })]))

      await type(retentionInput(), '365')
      await click(button(`Save “${RETENTION_LABEL}”`))
      expect(admin.listAdminAudit).toHaveBeenCalledTimes(2)
      await act(async () => first.resolve(testPage([settingRecord({ admin: 'earlier-admin' })])))

      expect(recentItems()[0].textContent).toContain('later-admin')
      expect(container.textContent).not.toContain('earlier-admin')
    })

    it('offers Retry after a failed load, which recovers', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockRejectedValueOnce(new Error('The audit log is unavailable'))

      await render(settingsWith(), admin)

      expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t load the admin audit log.')
      await click(button('Retry'))

      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(hasButton('Retry')).toBe(false)
      expect(card('Recent activity').textContent).toContain('setSiteName')
    })

    it('keeps the retention setting usable when the log fails to load', async () => {
      const admin = fakeAdmin()
      admin.getAdminAuditStats.mockRejectedValue(new Error('The audit log is unavailable'))

      await render(settingsWith(), admin)

      expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t load the admin audit log.')
      expect(hasButton('Retry')).toBe(true)
      expect(card('Audit retention')).toBeDefined()
      expect(retentionInput().value).toBe('90')
    })
  })

  describe('audit retention', () => {
    it('saves the days typed, then re-reads the settings', async () => {
      const { setAdminAuditRetentionDays, onSettingsChanged } = await render()

      await type(retentionInput(), '365')
      await click(button(`Save “${RETENTION_LABEL}”`))

      expect(setAdminAuditRetentionDays).toHaveBeenCalledExactlyOnceWith(365)
      expect(onSettingsChanged).toHaveBeenCalledOnce()
    })

    it('refuses fewer days than the deployment’s minimum without a call', async () => {
      const { setAdminAuditRetentionDays } = await render(settingsWith({ retention: { effective: 120, chosen: 120, min: 120 } }))
      expect(card('Audit retention').textContent).toContain('at least 120 days')
      expect(card('Audit retention').textContent).toContain('ADMIN_AUDIT_RETENTION_MIN_DAYS')

      await type(retentionInput(), '119')
      await click(button(`Save “${RETENTION_LABEL}”`))

      expect(setAdminAuditRetentionDays).not.toHaveBeenCalled()
      expect(container.textContent)
        .toContain(`Enter a whole number of days from 120 to ${MAX_ADMIN_AUDIT_RETENTION_DAYS}`)
    })

    it('reports a failed save', async () => {
      const admin = fakeAdmin()
      admin.setAdminAuditRetentionDays.mockRejectedValueOnce(new Error('Retention must be a whole number'))
      await render(settingsWith(), admin)

      await type(retentionInput(), '365')
      await click(button(`Save “${RETENTION_LABEL}”`))

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: `Couldn’t update “${RETENTION_LABEL}”`,
        description: 'Retention must be a whole number',
        variant: 'error',
      })
      expect(retentionInput().value).toBe('365')
    })

    // 90 days is the default, which no admin has to have chosen.
    for (const [chosen, min] of [[30, 180], [90, 120]]) {
      it(`says when the deployment’s minimum holds up a retention of ${chosen} days`, async () => {
        await render(settingsWith({ retention: { effective: min, chosen, min } }))

        const text = card('Audit retention').textContent
        expect(text).toContain(`The retention set here is ${chosen} days`)
        expect(text).toContain(`minimum of ${min} days is what holds it up`)
        expect(text).toContain(`${chosen} days applies again`)
        expect(text).not.toContain('Admins chose')
        expect(retentionInput().value).toBe(String(min))
      })
    }

    it('says nothing of the minimum while the retention set is at or above it', async () => {
      await render(settingsWith({ retention: { effective: 365, chosen: 365, min: 90 } }))

      expect(card('Audit retention').textContent).not.toContain('holds it up')
    })
  })
})
