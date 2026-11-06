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
import type { AuditFilter } from './auditFilter'
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

const testPage = (records = [settingRecord()], nextCursor?: string): AdminAuditPage =>
  nextCursor === undefined ? { records } : { records, nextCursor }

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

// The button named `name` inside `scope`.
const within = (scope: Element, name: string) => {
  const element = [...scope.querySelectorAll('button')]
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)
  if (!element) throw new Error(`no button ${name}`)
  return element
}

const button = (name: string) => {
  const element = [...document.body.querySelectorAll('button')]
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)
  if (!element) throw new Error(`no button ${name}`)
  return element
}

// The log's page controls.
const pages = () => document.body.querySelector('nav[aria-label="Audit log pages"]')!

// Each change in a record's details, as its name and its two sides.
const changesIn = (details: HTMLElement) => [...details.querySelectorAll('li')].map((li) => li.textContent)

// What listAdminAudit() is asked for when the panel loads a page.
const pageQuery = (query: Parameters<AdminApi['listAdminAudit']>[0] = {}) =>
  ({ admin: undefined, method: undefined, cursor: undefined, limit: 50, ...query })

describe('AdminAuditPanel', () => {
  let container: HTMLDivElement
  let root: Root

  // Renders the panel as the admin page does: a filter change is kept, as the URL keeps it, and
  // shown again.
  const render = async (settings: AuditSettings = settingsWith(), admin = fakeAdmin(), initialFilter: AuditFilter = {}) => {
    const onSettingsChanged = vi.fn<() => Promise<void>>(async () => {})
    let filter = initialFilter
    let reported = settings
    const draw = () => root.render(
      <AdminAuditPanel
        admin={admin as unknown as RpcStub<AdminApi>}
        settings={reported}
        onSettingsChanged={onSettingsChanged}
        filter={filter}
        onFilterChange={onFilterChange}
      />)
    const onFilterChange = vi.fn<(next: AuditFilter) => void>((next) => {
      filter = next
      draw()
    })
    // Shows what a re-read of the settings reported.
    const show = (next: AuditSettings) => act(async () => {
      reported = next
      draw()
    })
    await show(settings)
    return { ...admin, onSettingsChanged, onFilterChange, show }
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

  // The log's summary rows (its detail rows carry an id).
  const logRows = () => [...card('Activity log').querySelectorAll('tbody tr:not([id])')]

  // Shows the details of the log's row `index`, and returns them.
  const expand = async (index = 0) => {
    const toggle = logRows()[index].querySelector<HTMLButtonElement>('button[aria-expanded]')!
    await click(toggle)
    return document.getElementById(toggle.getAttribute('aria-controls')!)!
  }

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

  describe('the summary', () => {
    it('loads the last week’s counts', async () => {
      const { getAdminAuditStats } = await render()

      expect(getAdminAuditStats).toHaveBeenCalledExactlyOnceWith({ days: 7 })
    })

    it('shows the week’s total and each day’s count, oldest first, labelled with its date', async () => {
      await render()

      const week = card('Admin actions, last 7 days')
      expect(week.textContent).toContain('5 actions')
      const rows = [...week.querySelectorAll('tbody tr')]
      expect(rows.map((row) => row.querySelector('time')?.getAttribute('dateTime')))
        .toEqual(testStats().byDay.map(({ day }) => day))
      expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual(['0', '1', '0', '0', '2', '0', '2'])
    })

    it('shows the top admins, and filters the log by the one chosen', async () => {
      const { listAdminAudit, onFilterChange } = await render()

      expect([...card('Most active admins').querySelectorAll('tbody tr')].map((row) => row.textContent))
        .toEqual(['admin4', 'second-admin1'])
      await click(within(card('Most active admins'), 'Show only second-admin’s activity'))

      expect(onFilterChange).toHaveBeenCalledExactlyOnceWith({ admin: 'second-admin' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ admin: 'second-admin' }))
    })

    it('says when the window holds no activity', async () => {
      const admin = fakeAdmin()
      admin.getAdminAuditStats.mockResolvedValue(testStats({ totalEvents: 0, topAdmins: [] }))

      await render(settingsWith(), admin)

      expect(card('Most active admins').textContent).toContain('No admin activity in this window.')
    })

    it('keeps the log and the retention setting usable when the counts fail to load', async () => {
      const admin = fakeAdmin()
      admin.getAdminAuditStats.mockRejectedValueOnce(new Error('The audit log is unavailable'))

      await render(settingsWith(), admin)

      expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t load the admin audit statistics.')
      expect(logRows()[0].textContent).toContain('setSiteName')
      expect(retentionInput().value).toBe('90')
      await click(button('Retry'))
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(card('Admin actions, last 7 days')).toBeDefined()
    })
  })

  describe('the log', () => {
    it('loads the newest page of 50', async () => {
      const { listAdminAudit } = await render()

      expect(listAdminAudit).toHaveBeenCalledExactlyOnceWith(pageQuery())
    })

    it('loads the page the filters ask for', async () => {
      const { listAdminAudit } = await render(settingsWith(), fakeAdmin(), { admin: 'admin', method: 'setSiteName' })

      expect(listAdminAudit).toHaveBeenCalledExactlyOnceWith(pageQuery({ admin: 'admin', method: 'setSiteName' }))
    })

    it('shows a record as one row: when, who, what, the change and how', async () => {
      await render()

      const cells = [...logRows()[0].querySelectorAll('td')].map((cell) => cell.textContent)
      expect(cells.slice(1)).toEqual([
        formatFullTimestamp(SETTING_AT), 'second-admin', 'setSiteName', 'siteName', 'API',
      ])
      expect(logRows()[0].querySelector('time')?.getAttribute('dateTime')).toBe(SETTING_AT.toISOString())
    })

    it('summarizes several changes as the first and how many more', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([settingRecord({
        method: 'setBanner',
        changes: [
          { setting: 'banner', key: 'message', after: 'Maintenance tonight' },
          { setting: 'banner', key: 'color', before: 'blue', after: 'red' },
        ],
      })]))

      await render(settingsWith(), admin)

      expect(logRows()[0].textContent).toContain('banner · message + 1 more')
    })

    it('shows a record’s changes, before and after, from a toggle', async () => {
      await render()
      const toggle = logRows()[0].querySelector('button[aria-expanded]')!
      expect(toggle.getAttribute('aria-label')).toBe(`Show details of setSiteName at ${formatFullTimestamp(SETTING_AT)}`)
      expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.hidden).toBe(true)

      const details = await expand()

      expect(details.hidden).toBe(false)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(changesIn(details)).toEqual(['siteNameBeforeOld nameAfterNew name'])
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

      const details = await expand()

      expect(changesIn(details)).toEqual([
        'formats · bp-newBefore—noneAfter{\n  "agentHint": "x"\n}',
        'Order of formatsBefore[\n  "bp-a",\n  "bp-b"\n]After[\n  "bp-b",\n  "bp-a"\n]',
      ])
      const dash = [...details.querySelectorAll('span')].find((span) => span.textContent === '—')
      expect(dash?.getAttribute('aria-hidden')).toBe('true')
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

      const details = await expand()

      expect([...details.querySelectorAll('li > p:first-child')].map((name) => name.textContent))
        .toEqual(['Order of providers', 'Order of models · openai'])
    })

    it('names each long value’s toggle after its change and side', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([settingRecord({
        method: 'setInstanceInstructions',
        changes: [{ setting: 'instanceInstructions', before: 'a'.repeat(500), after: 'b'.repeat(500) }],
      })]))
      await render(settingsWith(), admin)
      await expand()

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

      expect((await expand()).textContent).toContain('Excerpt from character 7,901 · 8,000 → 8,020 characters')
    })

    it('filters by the admin whose name is chosen in a row', async () => {
      const { listAdminAudit, onFilterChange } = await render(settingsWith(), fakeAdmin(), { method: 'setSiteName' })

      await click(within(logRows()[0], 'Show only second-admin’s activity'))

      expect(onFilterChange).toHaveBeenCalledExactlyOnceWith({ method: 'setSiteName', admin: 'second-admin' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ admin: 'second-admin', method: 'setSiteName' }))
    })

    it('filters by the admin typed once Enter is pressed, and clears every filter', async () => {
      const { onFilterChange } = await render(settingsWith(), fakeAdmin(), { method: 'setSiteName' })
      const field = card('Activity log').querySelector<HTMLInputElement>('input[role="combobox"]')!

      await type(field, '  grace  ')
      expect(onFilterChange).not.toHaveBeenCalled()
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(onFilterChange).toHaveBeenLastCalledWith({ method: 'setSiteName', admin: 'grace' })
      expect(field.value).toBe('grace')

      await click(button('Clear filters'))
      expect(onFilterChange).toHaveBeenLastCalledWith({})
      expect(field.value).toBe('')
      expect(hasButton('Clear filters')).toBe(false)
      // The button removed itself, so focus goes to the field rather than the page.
      expect(document.activeElement).toBe(field)
    })

    it('searches the actions as one is typed, and filters by the one picked', async () => {
      const { listAdminAudit, onFilterChange } = await render()
      const [, field] = card('Activity log').querySelectorAll<HTMLInputElement>('input[role="combobox"]')

      await type(field, 'signup')
      const options = [...document.body.querySelectorAll('[role="option"]')]
      expect(options.map((option) => option.textContent)).toEqual(['setSignupsEnabled'])
      await act(async () => { options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })

      expect(onFilterChange).toHaveBeenLastCalledWith({ method: 'setSignupsEnabled' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ method: 'setSignupsEnabled' }))
    })

    it('gives focus to the admin field once an admin is chosen in a row, whose button the filtered page replaces', async () => {
      await render()

      await click(within(logRows()[0], 'Show only second-admin’s activity'))

      const field = card('Activity log').querySelector<HTMLInputElement>('input[role="combobox"]')!
      expect(document.activeElement).toBe(field)
      expect(field.value).toBe('second-admin')
    })

    it('abandons what was typed on Escape, showing the admin filter still applied', async () => {
      const { onFilterChange } = await render(settingsWith(), fakeAdmin(), { admin: 'admin' })
      const field = card('Activity log').querySelector<HTMLInputElement>('input[role="combobox"]')!
      await type(field, 'half-typed')

      await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })

      expect(field.value).toBe('admin')
      expect(onFilterChange).not.toHaveBeenCalled()
    })

    it('filters by an admin suggestion picked by pointer or by keyboard, not by what was typed', async () => {
      const { onFilterChange } = await render()
      const field = card('Activity log').querySelector<HTMLInputElement>('input[role="combobox"]')!

      await type(field, 'second')
      const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((element) => element.textContent === 'second-admin')!
      await act(async () => { option.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(onFilterChange).toHaveBeenLastCalledWith({ admin: 'second-admin' })

      await click(button('Clear filters'))
      await type(field, 'adm')
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      })
      expect(field.getAttribute('aria-activedescendant')).toBeTruthy()
      await act(async () => {
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(onFilterChange).toHaveBeenLastCalledWith({ admin: 'admin' })
      expect(onFilterChange).not.toHaveBeenCalledWith({ admin: 'adm' })
    })

    it('shows the admin filter set from elsewhere in the admin field', async () => {
      await render()
      const field = card('Activity log').querySelector<HTMLInputElement>('input[role="combobox"]')!
      await type(field, 'half-typed')

      await click(within(card('Most active admins'), 'Show only admin’s activity'))

      expect(field.value).toBe('admin')
    })

    it('drops what was typed over an admin filter once it changes, even back to that admin', async () => {
      await render(settingsWith(), fakeAdmin(), { admin: 'admin' })
      const field = card('Activity log').querySelector<HTMLInputElement>('input[role="combobox"]')!
      await type(field, 'half-typed')

      await click(within(card('Most active admins'), 'Show only second-admin’s activity'))
      await click(within(card('Most active admins'), 'Show only admin’s activity'))

      expect(field.value).toBe('admin')
    })

    it('says when there is nothing to show, and when nothing matches the filters', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([]))

      await render(settingsWith(), admin)
      expect(card('Activity log').textContent).toContain('No admin activity is recorded yet.')

      await click(within(card('Most active admins'), 'Show only admin’s activity'))
      expect(card('Activity log').textContent).toContain('No admin activity matches these filters.')
    })

    it('turns to older pages by cursor and back to newer ones', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockImplementation(async ({ cursor } = {}) => {
        if (cursor === undefined) return testPage([settingRecord({ admin: 'page-1' })], 'c1')
        if (cursor === 'c1') return testPage([settingRecord({ admin: 'page-2' })], 'c2')
        return testPage([settingRecord({ admin: 'page-3' })])
      })
      await render(settingsWith(), admin)
      expect(within(pages(), 'Newer').disabled).toBe(true)
      expect(pages().textContent).toContain('Page 1')

      await click(within(pages(), 'Older'))
      await click(within(pages(), 'Older'))

      expect(admin.listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ cursor: 'c2' }))
      expect(logRows()[0].textContent).toContain('page-3')
      expect(pages().textContent).toContain('Page 3')
      expect(within(pages(), 'Older').disabled).toBe(true)

      await click(within(pages(), 'Newer'))
      expect(logRows()[0].textContent).toContain('page-2')
      await click(within(pages(), 'Newer'))
      expect(logRows()[0].textContent).toContain('page-1')
      expect(admin.listAdminAudit).toHaveBeenLastCalledWith(pageQuery())
    })

    // A browser drops the focus of a button that becomes disabled.
    it('moves focus to the other page button once a turn disables the one pressed', async () => {
      const admin = fakeAdmin()
      const last = deferred<AdminAuditPage>()
      admin.listAdminAudit.mockResolvedValueOnce(testPage([settingRecord()], 'c1'))
      admin.listAdminAudit.mockReturnValueOnce(last.promise as ReturnType<AdminApi['listAdminAudit']>)
      await render(settingsWith(), admin)
      const older = within(pages(), 'Older')
      older.focus()

      await click(older)
      await act(async () => last.resolve(testPage([settingRecord({ admin: 'oldest-admin' })])))

      expect(within(pages(), 'Older').disabled).toBe(true)
      expect(document.activeElement).toBe(within(pages(), 'Newer'))
    })

    it('starts again from the newest page when the filters change', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockImplementation(async ({ cursor } = {}) =>
        testPage([settingRecord({ admin: cursor ?? 'admin' })], cursor === undefined ? 'c1' : undefined))
      await render(settingsWith(), admin)
      await click(within(card('Activity log').querySelector('nav')!, 'Older'))

      await click(within(card('Most active admins'), 'Show only admin’s activity'))

      expect(admin.listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ admin: 'admin' }))
      expect(card('Activity log').querySelector('nav')!.textContent).toContain('Page 1')
    })

    it('starts from the newest page when coming back to a filter left on a later page', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockImplementation(async ({ cursor } = {}) =>
        testPage([settingRecord({ admin: cursor ?? 'admin' })], cursor === undefined ? 'c1' : undefined))
      await render(settingsWith(), admin)
      await click(within(pages(), 'Older'))
      expect(admin.listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ cursor: 'c1' }))

      await click(within(card('Most active admins'), 'Show only admin’s activity'))
      await click(button('Clear filters'))

      expect(admin.listAdminAudit).toHaveBeenLastCalledWith(pageQuery())
      expect(pages().textContent).toContain('Page 1')
    })

    it('goes back to the newest page after a settings change, but stays on its page on Refresh', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockImplementation(async ({ cursor } = {}) =>
        testPage([settingRecord({ admin: cursor ?? 'admin' })], cursor === undefined ? 'c1' : undefined))
      await render(settingsWith(), admin)
      await click(within(pages(), 'Older'))

      await click(button('Refresh'))
      expect(admin.listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ cursor: 'c1' }))
      expect(pages().textContent).toContain('Page 2')

      await type(retentionInput(), '365')
      await click(button(`Save “${RETENTION_LABEL}”`))
      expect(admin.listAdminAudit).toHaveBeenLastCalledWith(pageQuery())
      expect(pages().textContent).toContain('Page 1')
    })

    it('says a later page holds nothing older, rather than that nothing is recorded', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockImplementation(async ({ cursor } = {}) =>
        cursor === undefined ? testPage([settingRecord()], 'c1') : testPage([]))
      await render(settingsWith(), admin)

      await click(within(pages(), 'Older'))

      expect(card('Activity log').textContent).toContain('No older admin activity.')
      expect(card('Activity log').textContent).not.toContain('No admin activity is recorded yet.')
    })

    it('hides the page controls when everything fits on one page', async () => {
      await render()

      expect(card('Activity log').querySelector('nav')).toBeNull()
    })

    it('loads the counts and the page again on Refresh, keeping the page shown until then', async () => {
      const { getAdminAuditStats, listAdminAudit } = await render()
      const reloaded = deferred<AdminAuditPage>()
      listAdminAudit.mockReturnValueOnce(reloaded.promise as ReturnType<AdminApi['listAdminAudit']>)

      await click(button('Refresh'))

      expect(getAdminAuditStats).toHaveBeenCalledTimes(2)
      expect(listAdminAudit).toHaveBeenCalledTimes(2)
      expect(card('Activity log').querySelector('[aria-busy="true"]')).not.toBeNull()
      expect(logRows()[0].textContent).toContain('second-admin')
      await act(async () => reloaded.resolve(testPage([settingRecord({ admin: 'newest-admin' })])))
      expect(logRows()[0].textContent).toContain('newest-admin')
      expect(card('Activity log').querySelector('[aria-busy="true"]')).toBeNull()
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

      expect(logRows()[0].textContent).toContain('later-admin')
      expect(container.textContent).not.toContain('earlier-admin')
    })

    it('offers Retry after a failed load, which recovers', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockRejectedValueOnce(new Error('The audit log is unavailable'))

      await render(settingsWith(), admin)

      expect(container.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t load the admin audit log.')
      expect(card('Most active admins')).toBeDefined()
      await click(button('Retry'))

      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(hasButton('Retry')).toBe(false)
      expect(logRows()[0].textContent).toContain('setSiteName')
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
