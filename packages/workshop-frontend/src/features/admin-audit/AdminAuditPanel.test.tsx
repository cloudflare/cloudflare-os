// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { MAX_ADMIN_AUDIT_RETENTION_DAYS } from '@gadgets/workshop-shared/api'
import type {
  AdminAccessRecord,
  AdminApi,
  AdminAuditPage,
  AdminAuditRecord,
  AdminAuditStats,
  AdminSettingRecord,
  AdminUserAccessRecord,
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
import { AUDIT_COLUMN_WIDTHS_KEY } from './AuditLog'

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
  access?: Partial<AuditSettings['adminWorkspaceAccess']>
  retention?: Partial<AuditSettings['adminAuditRetentionDays']>
} = {}): AuditSettings => ({
  adminWorkspaceAccess: { effective: 'metadata', chosen: 'metadata', max: 'full', ...patch.access },
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
  topAdmins: [{ admin: 'admin', count: 4, contentReads: 2 }, { admin: 'second-admin', count: 1, contentReads: 0 }],
  contentReads: 2,
  ...patch,
})

const SETTING_AT = new Date('2026-10-21T08:00:00Z')
const ACCESS_AT = new Date('2026-10-21T09:15:00Z')
const USER_AT = new Date('2026-10-21T10:30:00Z')

const accessRecord = (patch: Partial<AdminAccessRecord> = {}): AdminAccessRecord => ({
  kind: 'workspace',
  at: ACCESS_AT,
  admin: 'admin',
  sessionId: 'session-1',
  via: 'cli',
  workspaceId: 'ws-titled',
  workspaceOwner: 'owner@example.test',
  workspaceTitle: 'Quarterly report',
  method: 'getChat',
  args: { chatId: 3 },
  reason: 'Ticket 42: agent stuck',
  requested: 'full',
  access: 'metadata',
  exposed: 'metadata',
  refused: 'ADMIN_CONTENT_WITHHELD',
  ...patch,
})

const userRecord = (patch: Partial<AdminUserAccessRecord> = {}): AdminUserAccessRecord => ({
  kind: 'user',
  at: USER_AT,
  admin: 'admin',
  sessionId: 'session-3',
  via: 'cli',
  userId: 'user@example.test',
  method: 'listConnectedAccounts',
  args: {},
  reason: 'Cannot sign in',
  requested: 'full',
  access: 'metadata',
  exposed: 'metadata',
  ...patch,
})

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

const testPage = (records: AdminAuditRecord[] = [settingRecord()], nextCursor?: string): AdminAuditPage =>
  nextCursor === undefined ? { records } : { records, nextCursor }

const fakeAdmin = () => ({
  getAdminAuditStats: vi.fn<AdminApi['getAdminAuditStats']>(async () => testStats()),
  listAdminAudit: vi.fn<AdminApi['listAdminAudit']>(async () => testPage()),
  setAdminWorkspaceAccess: vi.fn<AdminApi['setAdminWorkspaceAccess']>(async () => {}),
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

/** The options of the list `select` opens, which is left open. */
const openOptions = async (select: HTMLElement) => {
  if (select.getAttribute('aria-expanded') !== 'true') await click(select)
  const list = document.getElementById(select.getAttribute('aria-controls') ?? '')
  return [...list?.querySelectorAll<HTMLElement>('[role="option"]') ?? []]
}

const enabledOptions = async (select: HTMLElement) => (await openOptions(select))
  .filter((option) => option.getAttribute('aria-disabled') !== 'true' && !option.hasAttribute('data-disabled'))
  .map((option) => option.textContent)

// By keyboard. The option turns Enter into a click it builds as a PointerEvent, which jsdom
// lacks, so the window has a stand-in for as long as the choice takes.
const choose = async (select: HTMLElement, label: string) => {
  const option = (await openOptions(select)).find((element) => element.textContent === label)
  if (!option) throw new Error(`no option ${label}`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  const previous = view.PointerEvent
  view.PointerEvent = MouseEvent
  try {
    await act(async () => { option.focus() })
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  } finally {
    view.PointerEvent = previous
  }
}

// The column widths the log has stored, and its resize handles and the events that move them.
const stored = () => JSON.parse(localStorage.getItem(AUDIT_COLUMN_WIDTHS_KEY) ?? 'null') as unknown
const handle = (column: string) => button(`Resize the ${column} column`)
const pointer = (eventType: string, target: HTMLElement, clientX: number) => act(async () => {
  target.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true, clientX }))
})
const key = (target: HTMLElement, init: KeyboardEventInit) => act(async () => {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
})

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

  // The select a card holds, by its label.
  const selectIn = (title: string) => {
    const element = card(title).querySelector<HTMLElement>('[role="combobox"]')
    if (!element) throw new Error(`no select in ${title}`)
    return element
  }
  const accessSelect = () => selectIn('Inspection access')
  // The log's one select; its other comboboxes are text fields.
  const sensitivitySelect = () => {
    const element = [...card('Activity log').querySelectorAll<HTMLElement>('[role="combobox"]')]
      .find((combobox) => !(combobox instanceof HTMLInputElement))
    if (!element) throw new Error('no sensitivity select')
    return element
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
    localStorage.clear()
    vi.restoreAllMocks()
  })

  // The log's <col> widths: toggle, Time, Admin, Action (none: it takes what is left), Sensitivity,
  // Target user.
  const widths = () => [...card('Activity log').querySelectorAll('col')].map((col) => col.style.width)

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

      expect([...card('Most active admins').querySelectorAll('tbody tr')]
        .map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent)))
        .toEqual([['admin', '4', '2'], ['second-admin', '1', '0']])
      await click(within(card('Most active admins'), 'Show only second-admin’s activity'))

      expect(onFilterChange).toHaveBeenCalledExactlyOnceWith({ admin: 'second-admin' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ admin: 'second-admin' }))
    })

    it('counts the week’s content reads, in all and for each top admin, setting apart those with some', async () => {
      await render()

      expect(card('Admin actions, last 7 days').textContent).toContain('2 content reads')
      const rows = [...card('Most active admins').querySelectorAll('tbody tr')]
      const [some, none] = rows.map((row) => row.lastElementChild!)
      expect(some.className).toContain('text-kumo-danger')
      expect(none.className).not.toContain('text-kumo-danger')
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
        formatFullTimestamp(SETTING_AT), 'second-admin', 'setSiteName', 'Setting change', '—Deployment-wide',
      ])
      expect(logRows()[0].querySelector('time')?.getAttribute('dateTime')).toBe(SETTING_AT.toISOString())
    })

    it('stripes every other record, its details row aside', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage(['a', 'b', 'c', 'd'].map((name) => settingRecord({ admin: name }))))
      await render(settingsWith(), admin)

      expect(logRows().map((row) => row.classList.contains('bg-kumo-elevated'))).toEqual([false, true, false, true])
      // Opening a record adds no row, so the stripes stay put.
      await expand(0)
      expect(logRows().map((row) => row.classList.contains('bg-kumo-elevated'))).toEqual([false, true, false, true])
    })

    it('shows how a setting change came, and its action whole however long, from its row', async () => {
      await render()

      const action = logRows()[0].querySelectorAll('td')[3].querySelector('span')!
      expect(action.getAttribute('title')).toBe('setSiteName')
      expect(action.className).toContain('truncate')
      expect((await expand()).textContent).toContain('ViaAPI')
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

    it('clears text typed and not applied in the admin and owner fields with every filter', async () => {
      await render(settingsWith(), fakeAdmin(), { method: 'getChat' })
      const [admin, , owner] = card('Activity log').querySelectorAll<HTMLInputElement>('input[role="combobox"]')
      await type(admin, 'alice')
      await type(owner, 'bob')

      await click(button('Clear filters'))

      expect(admin.value).toBe('')
      expect(owner.value).toBe('')
    })

    it('gives focus to the field showing a name chosen in a row, whose button the filtered page replaces', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord(), settingRecord()]))
      await render(settingsWith(), admin)
      const [adminField, , ownerField] = card('Activity log').querySelectorAll<HTMLInputElement>('input[role="combobox"]')

      await click(within(logRows()[1], 'Show only second-admin’s activity'))
      expect(document.activeElement).toBe(adminField)
      expect(adminField.value).toBe('second-admin')

      await click(within(logRows()[0], 'Show only calls targeting owner@example.test'))
      expect(document.activeElement).toBe(ownerField)
      expect(ownerField.value).toBe('owner@example.test')
    })

    it('abandons what was typed on Escape, showing the admin filter still applied', async () => {
      const { onFilterChange } = await render(settingsWith(), fakeAdmin(), { admin: 'admin' })
      const field = card('Activity log').querySelector<HTMLInputElement>('input[role="combobox"]')!
      await type(field, 'half-typed')

      await key(field, { key: 'Escape' })
      await key(field, { key: 'Escape' })

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
      await key(field, { key: 'ArrowDown' })
      expect(field.getAttribute('aria-activedescendant')).toBeTruthy()
      await key(field, { key: 'Enter' })
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

    it('shows a call into a workspace: its sensitivity and refusal, its workspace, and in its details the owner, reason, access and arguments', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord()]))
      await render(settingsWith(), admin)

      const cells = [...logRows()[0].querySelectorAll('td')].map((cell) => cell.textContent)
      expect(cells.slice(1)).toEqual([
        formatFullTimestamp(ACCESS_AT), 'admin', 'getChat', 'Workspace metadataRefused', 'owner@example.test',
      ])
      const details = await expand()
      expect(details.textContent).toContain('Quarterly report')
      expect(details.textContent).toContain('ws-titled')
      expect(details.textContent).toContain('ViaCLI')
      expect(details.textContent).toContain('Ticket 42: agent stuck')
      expect(details.textContent).toContain('Metadata only (Full requested) · refused: Content withheld')
      expect(details.textContent).toContain('chatId: 3')
    })

    it('marks a content read as one, and names an untitled workspace in its details', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        accessRecord({ exposed: 'content', access: 'full', refused: undefined, workspaceId: 'ws-untitled', workspaceTitle: '' }),
      ]))
      await render(settingsWith(), admin)

      const cells = [...logRows()[0].querySelectorAll('td')].map((cell) => cell.textContent)
      expect(cells.slice(4)).toEqual(['Content read', 'owner@example.test'])
      const details = await expand()
      expect(details.textContent).toContain('Untitled')
      expect(details.textContent).toContain('ws-untitled')
    })

    it('shows a call into a user’s account: its sensitivity and its user, and in its details the account, reason, access and arguments, with no workspace', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        userRecord({ method: 'inspectUser', args: { expiresAt: '2026-10-21T11:30:00.000Z' } }),
      ]))
      await render(settingsWith(), admin)

      const cells = [...logRows()[0].querySelectorAll('td')].map((cell) => cell.textContent)
      expect(cells.slice(1)).toEqual([
        formatFullTimestamp(USER_AT), 'admin', 'inspectUser', 'User metadata', 'user@example.test',
      ])
      const details = await expand()
      expect([...details.querySelectorAll('dt')].map((term) => term.textContent))
        .toEqual(['Account', 'Reason', 'Access', 'Arguments', 'Via'])
      expect([...details.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([
        'user@example.test', 'Cannot sign in', 'Metadata only (Full requested)',
        'expiresAt: 2026-10-21T11:30:00.000Z', 'CLI',
      ])
      // Only a workspace's details filter by it.
      expect(details.querySelector('button')).toBeNull()
    })

    it('marks a content read of a user’s account as one, and a refused call into one as refused', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        userRecord({ exposed: 'content', access: 'full' }),
        userRecord({ method: 'describe', access: 'off', refused: 'ADMIN_WORKSPACE_ACCESS_OFF' }),
      ]))
      await render(settingsWith(), admin)

      const sensitivities = logRows().map((row) => row.querySelectorAll('td')[4].textContent)
      expect(sensitivities).toEqual(['Content read', 'User metadataRefused'])
      expect((await expand(1)).textContent).toContain('Off (Full requested) · refused: Access off')
    })

    it('filters by sensitivity: a content read by what it exposed, a setting change by its kind', async () => {
      const { listAdminAudit, onFilterChange } = await render()

      await choose(sensitivitySelect(), 'Content read')
      expect(onFilterChange).toHaveBeenLastCalledWith({ sensitivity: 'content' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ exposed: 'content' }))

      await choose(sensitivitySelect(), 'Setting change')
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ kind: 'setting' }))
    })

    it('filters metadata by the kind it is of: a workspace’s, or a user account’s', async () => {
      const { listAdminAudit, onFilterChange } = await render()

      await choose(sensitivitySelect(), 'Workspace metadata')
      expect(onFilterChange).toHaveBeenLastCalledWith({ sensitivity: 'metadata' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ kind: 'workspace', exposed: 'metadata' }))

      await choose(sensitivitySelect(), 'User metadata')
      expect(onFilterChange).toHaveBeenLastCalledWith({ sensitivity: 'userMetadata' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ kind: 'user', exposed: 'metadata' }))
    })

    it('filters by a workspace chosen in a record’s details, named in a chip that removes it', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord()]))
      const { listAdminAudit, onFilterChange } = await render(settingsWith(), admin)

      await click(within(await expand(), 'Show only calls into Quarterly report'))
      expect(onFilterChange).toHaveBeenLastCalledWith({ workspace: 'ws-titled' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ workspace: 'ws-titled' }))

      const chip = button('Show every workspace, not only Quarterly report')
      expect(chip.textContent).toBe('Workspace: Quarterly report')
      await click(chip)
      expect(onFilterChange).toHaveBeenLastCalledWith({ workspace: undefined })
      // The chip removed itself, so focus goes to the admin field rather than the page.
      expect(document.activeElement).toBe(card('Activity log').querySelector('input[role="combobox"]'))
    })

    it('filters by the target user a row names, offering the page’s target users in the filter', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        accessRecord({ workspaceOwner: 'grace' }), accessRecord({ workspaceOwner: 'linus' }),
        accessRecord({ workspaceOwner: 'grace' }), settingRecord(),
      ]))
      const { listAdminAudit, onFilterChange } = await render(settingsWith(), admin)

      await click(within(logRows()[1], 'Show only calls targeting linus'))
      expect(onFilterChange).toHaveBeenLastCalledWith({ owner: 'linus' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ owner: 'linus' }))

      const target = [...card('Activity log').querySelectorAll<HTMLInputElement>('input[role="combobox"]')]
        .find((input) => input.placeholder.startsWith('Any user'))!
      await type(target, '')
      await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
      expect([...document.body.querySelectorAll('[role="option"]')].map((option) => option.textContent))
        .toEqual(expect.arrayContaining(['grace', 'linus']))
    })

    it('filters by the user whose account a row names, offering inspected users beside workspace owners', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        userRecord({ userId: 'ada' }), accessRecord({ workspaceOwner: 'grace' }), settingRecord(),
      ]))
      const { listAdminAudit, onFilterChange } = await render(settingsWith(), admin)

      await click(within(logRows()[0], 'Show only calls targeting ada'))
      expect(onFilterChange).toHaveBeenLastCalledWith({ owner: 'ada' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ owner: 'ada' }))

      const target = [...card('Activity log').querySelectorAll<HTMLInputElement>('input[role="combobox"]')]
        .find((input) => input.placeholder.startsWith('Any user'))!
      expect(document.activeElement).toBe(target)
      expect(target.value).toBe('ada')
      await type(target, '')
      await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
      expect([...document.body.querySelectorAll('[role="option"]')].map((option) => option.textContent))
        .toEqual(expect.arrayContaining(['ada', 'grace']))
    })

    it('filters by the owner and the workspace a record’s details name, and by the owner typed', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord()]))
      const { listAdminAudit, onFilterChange } = await render(settingsWith(), admin)
      await click(within(logRows()[0], 'Show only calls targeting owner@example.test'))
      expect(onFilterChange).toHaveBeenLastCalledWith({ owner: 'owner@example.test' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ owner: 'owner@example.test' }))

      const owner = [...card('Activity log').querySelectorAll<HTMLInputElement>('input[role="combobox"]')]
        .find((input) => input.placeholder.startsWith('Any user'))!
      expect(owner.value).toBe('owner@example.test')
      await type(owner, 'grace')
      await act(async () => {
        owner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(onFilterChange).toHaveBeenLastCalledWith({ owner: 'grace' })
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

  describe('inspection access', () => {
    it('shows the level enforced', async () => {
      await render(settingsWith({ access: { effective: 'metadata', chosen: 'full', max: 'metadata' } }))

      expect(accessSelect().textContent).toContain('Metadata only')
      expect(card('Inspection access').textContent)
        .toContain('The level set here is Full, which that maximum limits to Metadata only. Choose ' +
          'Metadata only to set it here, so that a higher maximum does not raise it.')
    })

    it('says what Metadata only withholds and what it still shows', async () => {
      await render()

      expect(card('Inspection access').textContent).toContain(
        'Metadata only withholds chat messages, attachments, file contents, commit messages, and the ' +
          'descriptions of actions, observations and hooks; titles, repository file names, commit ' +
          'authors, and the names and hashes of attachments stay, and titles and names can echo ' +
          'content.')
    })

    it('disables the levels above the deployment’s maximum, naming it', async () => {
      await render(settingsWith({ access: { max: 'metadata' } }))

      expect(await enabledOptions(accessSelect())).toEqual(['Off', 'Metadata only'])
      expect(card('Inspection access').textContent).toContain('This deployment allows at most Metadata only')
    })

    it('leaves only Off when the deployment allows no inspection', async () => {
      await render(settingsWith({ access: { effective: 'off', chosen: 'metadata', max: 'off' } }))

      expect(await enabledOptions(accessSelect())).toEqual(['Off'])
      expect(card('Inspection access').textContent).toContain('ADMIN_WORKSPACE_ACCESS_MAX allows no inspection')
    })

    it('sets the level chosen, then re-reads the settings and the log', async () => {
      const { setAdminWorkspaceAccess, onSettingsChanged, listAdminAudit } = await render()

      await choose(accessSelect(), 'Full')

      expect(setAdminWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('full')
      expect(onSettingsChanged).toHaveBeenCalledOnce()
      expect(listAdminAudit).toHaveBeenCalledTimes(2)
    })

    it('stores the level shown as the admins’ choice while the maximum holds a higher one down, and sends nothing for the choice itself', async () => {
      const held = await render(settingsWith({ access: { effective: 'metadata', chosen: 'full', max: 'metadata' } }))
      await choose(accessSelect(), 'Metadata only')
      expect(held.setAdminWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('metadata')

      act(() => root.unmount())
      root = createRoot(container)
      const own = await render()
      await choose(accessSelect(), 'Metadata only')
      expect(own.setAdminWorkspaceAccess).not.toHaveBeenCalled()
    })

    it('is disabled while its change is in flight', async () => {
      const admin = fakeAdmin()
      const call = deferred()
      admin.setAdminWorkspaceAccess.mockReturnValueOnce(call.promise)
      await render(settingsWith(), admin)

      await choose(accessSelect(), 'Full')
      expect(accessSelect().hasAttribute('data-disabled') || accessSelect().hasAttribute('disabled')).toBe(true)

      await act(async () => call.resolve())
      expect(accessSelect().hasAttribute('data-disabled') || accessSelect().hasAttribute('disabled')).toBe(false)
    })

    // Chosen by keyboard, from an option of the popup, which is gone once the save settles.
    it('gives focus back to its trigger once a delayed change settles', async () => {
      const admin = fakeAdmin()
      const call = deferred()
      admin.setAdminWorkspaceAccess.mockReturnValueOnce(call.promise)
      await render(settingsWith(), admin)

      await choose(accessSelect(), 'Full')
      ;(document.activeElement as HTMLElement | null)?.blur()
      await act(async () => call.resolve())

      expect(document.activeElement).toBe(accessSelect())
    })

    it('reports a failed change and keeps the server’s level', async () => {
      const admin = fakeAdmin()
      admin.setAdminWorkspaceAccess.mockRejectedValueOnce(new Error('ADMIN_WORKSPACE_ACCESS_MAX allows at most "metadata"'))
      const { onSettingsChanged } = await render(settingsWith(), admin)

      await choose(accessSelect(), 'Full')

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: 'Couldn’t update “Inspection access”',
        description: 'ADMIN_WORKSPACE_ACCESS_MAX allows at most "metadata"',
        variant: 'error',
      })
      expect(onSettingsChanged).not.toHaveBeenCalled()
      expect(accessSelect().textContent).toContain('Metadata only')
    })
  })

  describe('the log’s column widths', () => {
    it('starts from the defaults, the Action column taking what is left', async () => {
      await render()

      expect(widths()).toEqual(['48px', '170px', '140px', '', '240px', '140px'])
      expect(stored()).toBeNull()
    })

    it('resizes a column by keyboard, more with Shift, storing each width', async () => {
      await render()
      handle('Time').focus()

      await key(handle('Time'), { key: 'ArrowRight' })
      expect(widths()[1]).toBe('186px')
      await key(handle('Time'), { key: 'ArrowLeft', shiftKey: true })
      expect(widths()[1]).toBe('122px')

      expect(stored()).toEqual({ time: 122, admin: 140, sensitivity: 240, target: 140 })
    })

    it('resizes a column by dragging its edge, storing the width once the drag ends', async () => {
      await render()

      await pointer('pointerdown', handle('Admin'), 500)
      await pointer('pointermove', handle('Admin'), 560)
      expect(widths()[2]).toBe('200px')
      expect(stored()).toBeNull()
      await pointer('pointerup', handle('Admin'), 580)

      expect(widths()[2]).toBe('220px')
      expect(stored()).toEqual({ time: 170, admin: 220, sensitivity: 240, target: 140 })
    })

    it('puts back the width a drag began from when the drag is cancelled, storing nothing', async () => {
      await render()
      await pointer('pointerdown', handle('Admin'), 500)
      await pointer('pointermove', handle('Admin'), 600)
      expect(widths()[2]).toBe('240px')

      // A cancel may report any position: 0 here, which would narrow the column to its least.
      await pointer('pointercancel', handle('Admin'), 0)

      expect(widths()[2]).toBe('140px')
      expect(stored()).toBeNull()
    })

    it('keeps a column within its bounds', async () => {
      await render()

      await pointer('pointerdown', handle('Target user'), 500)
      await pointer('pointerup', handle('Target user'), 0)
      expect(widths()[5]).toBe('64px')
      await pointer('pointerdown', handle('Admin'), 0)
      await pointer('pointerup', handle('Admin'), 5000)
      expect(widths()[2]).toBe('800px')
    })

    it('resets a column on double click', async () => {
      await render()
      await key(handle('Admin'), { key: 'ArrowRight' })

      await act(async () => { handle('Admin').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })

      expect(widths()[2]).toBe('140px')
      expect(stored()).toEqual({ time: 170, admin: 140, sensitivity: 240, target: 140 })
    })

    it('starts from the widths stored, bounded, and the defaults for any missing or malformed', async () => {
      localStorage.setItem(AUDIT_COLUMN_WIDTHS_KEY, JSON.stringify({ admin: 333, time: 5, target: 'wide' }))

      await render()

      expect(widths()).toEqual(['48px', '64px', '333px', '', '240px', '140px'])
    })

    it('ignores stored widths that are not JSON', async () => {
      localStorage.setItem(AUDIT_COLUMN_WIDTHS_KEY, '{not json')

      await render()

      expect(widths()).toEqual(['48px', '170px', '140px', '', '240px', '140px'])
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
