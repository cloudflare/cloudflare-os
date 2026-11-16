// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { ADMIN_ACCESS_ERROR_CODES, MAX_ADMIN_AUDIT_RETENTION_DAYS } from '@gadgets/workshop-shared/api'
import type {
  AdminAccessRecord,
  AdminApi,
  AdminAuditPage,
  AdminAuditRecord,
  AdminAuditStats,
  AdminSettingRecord,
  AdminUserAccessRecord,
  AdminWriteRecord,
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
  adminWorkspaceAccess: { effective: 'metadata', chosen: 'metadata', max: 'metadata', ...patch.access },
  adminAuditRetentionDays: { effective: 90, chosen: 90, min: 90, ...patch.retention },
})

// The deployment allows no inspection, which holds the admins' choice of Metadata down to Off.
const heldDown = () => settingsWith({ access: { effective: 'off', chosen: 'metadata', max: 'off' } })

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
  writes: 0,
  contentReads: 0,
  ...patch,
})

const SETTING_AT = new Date('2026-10-21T08:00:00Z')
const ACCESS_AT = new Date('2026-10-21T09:15:00Z')
const USER_AT = new Date('2026-10-21T10:30:00Z')
const WRITE_AT = new Date('2026-10-21T11:45:00Z')

const accessRecord = (patch: Partial<AdminAccessRecord> = {}): AdminAccessRecord => ({
  kind: 'workspace',
  at: ACCESS_AT,
  admin: 'admin',
  sessionId: 'session-1',
  via: 'cli',
  workspaceId: 'ws-titled',
  workspaceOwner: 'owner@example.test',
  workspaceTitle: 'Quarterly report',
  method: 'getChatState',
  args: { chatId: 3 },
  reason: 'Ticket 42: agent stuck',
  requested: 'metadata',
  access: 'off',
  exposed: 'metadata',
  refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
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
  access: 'metadata',
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

const writeRecord = (patch: Partial<AdminWriteRecord> = {}): AdminWriteRecord => ({
  kind: 'write',
  at: WRITE_AT,
  admin: 'second-admin',
  sessionId: 'session-3',
  via: 'api',
  requestId: 'request-1',
  event: 'approved',
  workspaceId: 'ws-titled',
  workspaceOwner: 'owner@example.test',
  workspaceTitle: 'Quarterly report',
  method: 'stopAgent',
  args: { chatId: 3 },
  reason: 'Ticket 42: agent stuck',
  requestedBy: 'admin',
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

// What a record's details say under `term`, or null when they have no such entry.
const detail = (details: HTMLElement, term: string) =>
  [...details.querySelectorAll('dt')].find((dt) => dt.textContent === term)?.nextElementSibling?.textContent ?? null

// The links a record's details hold: to the approval page of its request, when it has one to
// offer, and to the admin's page for its workspace.
const approvalLink = (details: HTMLElement) => details.querySelector('a[href^="/admin/approve/"]')
const workspaceLink = (details: HTMLElement) => details.querySelector('a[href^="/admin/workspace/"]')

// What listAdminAudit() is asked for when the panel loads a page.
const pageQuery = (query: Parameters<AdminApi['listAdminAudit']>[0] = {}) =>
  ({ admin: undefined, method: undefined, cursor: undefined, limit: 50, ...query })

// A router that knows the pages a record's details link: the approval page of a write request
// and the admin's page for a workspace.
const linkRouter = async () => {
  const rootRoute = createRootRoute()
  const router = createRouter({
    routeTree: rootRoute.addChildren(['/', '/admin/approve/$requestId', '/admin/workspace/$workspaceId']
      .map((path) => createRoute({ getParentRoute: () => rootRoute, path }))),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return router
}

describe('AdminAuditPanel', () => {
  let container: HTMLDivElement
  let root: Root

  // Renders the panel as the admin page does: a filter change is kept, as the URL keeps it, and
  // shown again. The panel is given a router's context and is not a page of it, so that it can be
  // drawn again with other props.
  const render = async (settings: AuditSettings = settingsWith(), admin = fakeAdmin(), initialFilter: AuditFilter = {}) => {
    const onSettingsChanged = vi.fn<() => Promise<void>>(async () => {})
    const router = await linkRouter()
    let filter = initialFilter
    let reported = settings
    const draw = () => root.render(
      <RouterContextProvider router={router}>
        <AdminAuditPanel
          admin={admin as unknown as RpcStub<AdminApi>}
          settings={reported}
          onSettingsChanged={onSettingsChanged}
          filter={filter}
          onFilterChange={onFilterChange}
        />
      </RouterContextProvider>)
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
  // The log's selects, in the order shown: the kind, then what a call exposed. Its other
  // comboboxes are text fields.
  const logSelect = (index: number) => {
    const element = [...card('Activity log').querySelectorAll<HTMLElement>('[role="combobox"]')]
      .filter((combobox) => !(combobox instanceof HTMLInputElement))[index]
    if (!element) throw new Error(`no select ${index} in the log`)
    return element
  }
  const kindSelect = () => logSelect(0)
  const exposedSelect = () => logSelect(1)

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

  // The log's <col> widths: toggle, Time, Admin, Action (none: it takes what is left), Kind,
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
        .toEqual([['admin', '4'], ['second-admin', '1']])
      await click(within(card('Most active admins'), 'Show only second-admin’s activity'))

      expect(onFilterChange).toHaveBeenCalledExactlyOnceWith({ admin: 'second-admin' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ admin: 'second-admin' }))
    })

    it('counts each top admin’s actions and nothing else', async () => {
      await render()

      expect([...card('Most active admins').querySelectorAll('thead th')].map((head) => head.textContent))
        .toEqual(['Admin', 'Actions'])
      expect(card('Most active admins').textContent).not.toMatch(/content read/i)
    })

    it('counts the week’s content reads, one as a singular, and lists them in the log when the count is chosen', async () => {
      const admin = fakeAdmin()
      admin.getAdminAuditStats.mockResolvedValueOnce(testStats({ contentReads: 1 }))
      admin.getAdminAuditStats.mockResolvedValue(testStats({ contentReads: 1234 }))
      const { listAdminAudit, onFilterChange } = await render(settingsWith(), admin, { admin: 'admin' })

      expect(card('Admin actions, last 7 days').textContent).toMatch(/1 content read(?!s)/)
      await click(button('Refresh'))
      expect(card('Admin actions, last 7 days').textContent).toContain('1,234 content reads')
      await click(within(card('Admin actions, last 7 days'), '1,234 content reads: show only content reads'))

      expect(onFilterChange).toHaveBeenCalledExactlyOnceWith({ admin: 'admin', exposed: 'content' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ admin: 'admin', exposed: 'content' }))
      expect(exposedSelect().textContent).toBe('Content reads')
    })

    it('counts no content reads as none, rather than leaving the count out', async () => {
      await render()

      expect(card('Admin actions, last 7 days').textContent).toContain('0 content reads')
    })

    it('counts the week’s approved writes, one as a singular', async () => {
      const admin = fakeAdmin()
      admin.getAdminAuditStats.mockResolvedValueOnce(testStats({ writes: 1 }))
      admin.getAdminAuditStats.mockResolvedValue(testStats({ writes: 1234 }))
      await render(settingsWith(), admin)

      expect(card('Admin actions, last 7 days').textContent).toMatch(/1 approved write(?!s)/)
      await click(button('Refresh'))
      expect(card('Admin actions, last 7 days').textContent).toContain('1,234 approved writes')
    })

    it('says nothing of approved writes or content reads to a backend whose statistics lack the counts', async () => {
      const admin = fakeAdmin()
      // As a backend older than admin writes sends them.
      const { writes: _, contentReads: __, ...older } = testStats()
      admin.getAdminAuditStats.mockResolvedValue(older as AdminAuditStats)
      await render(settingsWith(), admin)

      const shown = card('Admin actions, last 7 days').textContent
      expect(shown).toMatch(/\d+ actions, by UTC day/)
      expect(shown).not.toContain('approved write')
      expect(shown).not.toContain('content read')
      expect(shown).not.toContain('NaN')
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
      await render(settingsWith(), fakeAdmin(), { method: 'getChatState' })
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

    it('shows a call into a workspace: its kind and refusal, its workspace, and in its details the owner, reason, access and arguments', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord()]))
      await render(settingsWith(), admin)

      const cells = [...logRows()[0].querySelectorAll('td')].map((cell) => cell.textContent)
      expect(cells.slice(1)).toEqual([
        formatFullTimestamp(ACCESS_AT), 'admin', 'getChatState', 'Workspace accessMetadataRefused', 'owner@example.test',
      ])
      expect(logRows()[0].querySelector('[title="Access off"]')?.textContent).toBe('Refused')
      const details = await expand()
      expect(details.textContent).toContain('Quarterly report')
      expect(details.textContent).toContain('ws-titled')
      expect(details.textContent).toContain('ViaCLI')
      expect(details.textContent).toContain('Ticket 42: agent stuck')
      expect(detail(details, 'Access')).toBe('Off · refused: Access off')
      expect(details.textContent).toContain('chatId: 3')
    })

    it('shows a call that was not refused with its kind alone, and in its details names an untitled workspace and links its admin page', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        accessRecord({ access: 'metadata', refused: undefined, workspaceId: 'ws-untitled', workspaceTitle: '' }),
      ]))
      await render(settingsWith(), admin)

      const cells = [...logRows()[0].querySelectorAll('td')].map((cell) => cell.textContent)
      expect(cells.slice(4)).toEqual(['Workspace accessMetadata', 'owner@example.test'])
      const details = await expand()
      expect(detail(details, 'Access')).toBe('Metadata')
      expect(details.textContent).toContain('Untitled')
      expect(details.textContent).toContain('ws-untitled')
      expect(workspaceLink(details)?.textContent).toBe('Open workspace admin view')
      expect(workspaceLink(details)?.getAttribute('href')).toBe('/admin/workspace/ws-untitled')
    })

    it('shows a call into a user’s account: its kind and its user, and in its details the account, reason, access and arguments, with no workspace', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        userRecord({ method: 'inspectUser', args: { expiresAt: '2026-10-21T11:30:00.000Z' } }),
      ]))
      await render(settingsWith(), admin)

      const cells = [...logRows()[0].querySelectorAll('td')].map((cell) => cell.textContent)
      expect(cells.slice(1)).toEqual([
        formatFullTimestamp(USER_AT), 'admin', 'inspectUser', 'User access', 'user@example.test',
      ])
      const details = await expand()
      expect([...details.querySelectorAll('dt')].map((term) => term.textContent))
        .toEqual(['Account', 'Reason', 'Access', 'Arguments', 'Via'])
      expect([...details.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([
        'user@example.test', 'Cannot sign in', 'Metadata', 'expiresAt: 2026-10-21T11:30:00.000Z', 'CLI',
      ])
      // Only a workspace's details filter by it.
      expect(details.querySelector('button')).toBeNull()
    })

    it('marks a refused call into a user’s account as refused', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        userRecord(),
        userRecord({ method: 'describe', access: 'off', refused: 'ADMIN_WORKSPACE_ACCESS_OFF' }),
      ]))
      await render(settingsWith(), admin)

      const kinds = logRows().map((row) => row.querySelectorAll('td')[4].textContent)
      expect(kinds).toEqual(['User access', 'User accessRefused'])
      expect(detail(await expand(1), 'Access')).toBe('Off · refused: Access off')
    })

    it('shows a write request: its kind and step, its workspace’s owner, and in its details the workspace with a link to its admin page, the reason, arguments, request and a link to its approval page', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([writeRecord({ event: 'requested', admin: 'admin' })]))
      await render(settingsWith(), admin)

      const cells = [...logRows()[0].querySelectorAll('td')].map((cell) => cell.textContent)
      expect(cells.slice(1)).toEqual([
        formatFullTimestamp(WRITE_AT), 'admin', 'stopAgent', 'Workspace writeRequested', 'owner@example.test',
      ])
      const details = await expand()
      expect(detail(details, 'Workspace')).toBe('Quarterly reportws-titledOpen workspace admin view')
      expect(workspaceLink(details)?.getAttribute('href')).toBe('/admin/workspace/ws-titled')
      expect(detail(details, 'Reason')).toBe('Ticket 42: agent stuck')
      expect(detail(details, 'Arguments')).toBe('chatId: 3')
      expect(detail(details, 'Request')).toBe('request-1Open approval page')
      expect(approvalLink(details)?.getAttribute('href')).toBe('/admin/approve/request-1')
      // The requester is the record's own admin, so is not named twice.
      expect(detail(details, 'Requested by')).toBeNull()
      expect(detail(details, 'Via')).toBe('API')
    })

    it('names a call and a write request made through the admin gatekeeper as an agent\'s', async () => {
      const agent = { workspaceId: 'ws-triage', chatId: 4 }
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        accessRecord({ via: 'gatekeeper', agent }),
        writeRecord({ via: 'gatekeeper', agent }),
      ]))
      await render(settingsWith(), admin)

      expect(detail(await expand(0), 'Via')).toBe('Agent')
      expect(detail(await expand(1), 'Via')).toBe('Agent')
    })

    it('shows a refused approval: who tried, the check that failed, and the passkey the answer named if it was their own', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        writeRecord({ event: 'refused', admin: 'third-admin', refusal: 'credential' }),
        writeRecord({ event: 'refused', admin: 'third-admin', refusal: 'signature', passkey: 'credential-1' }),
      ]))
      await render(settingsWith(), admin)

      const cells = [...logRows()[0].querySelectorAll('td')]
      expect(cells.slice(2).map((cell) => cell.textContent))
        .toEqual(['third-admin', 'stopAgent', 'Workspace writeRefused', 'owner@example.test'])
      expect(cells[4].querySelector('[title]')?.getAttribute('title')).toBe('Not a passkey this admin enrolled')
      const unnamed = await expand()
      expect(detail(unnamed, 'Refusal')).toBe('Not a passkey this admin enrolled')
      expect(detail(unnamed, 'Requested by')).toBe('admin')
      expect(detail(unnamed, 'Passkey')).toBeNull()
      expect(approvalLink(unnamed)).toBeNull()
      const named = await expand(1)
      expect(detail(named, 'Refusal')).toBe('The signature did not verify')
      expect(detail(named, 'Passkey')).toBe('credential-1')
    })

    it('shows an approval sent again as a refusal above the write it repeats', async () => {
      const replayedAt = new Date(WRITE_AT.getTime() + 60_000)
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        writeRecord({ event: 'refused', at: replayedAt, refusal: 'challenge', passkey: 'credential-1' }),
        writeRecord({ event: 'applied', passkey: 'credential-1' }),
      ]))
      await render(settingsWith(), admin)

      expect(logRows().map((row) => [
        row.querySelector('time')?.getAttribute('dateTime'), row.querySelectorAll('td')[4].textContent,
      ])).toEqual([
        [replayedAt.toISOString(), 'Workspace writeRefused'],
        [WRITE_AT.toISOString(), 'Workspace writeApplied'],
      ])
      const replay = await expand()
      expect(detail(replay, 'Request')).toBe('request-1')
      expect(detail(replay, 'Refusal')).toContain('the request no longer pending')
      expect(detail(await expand(1), 'Request')).toBe('request-1')
    })

    it('shows an approved write: its passkey, and who requested it when another admin approved it', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        writeRecord({ passkey: 'credential-1' }),
        writeRecord({ admin: 'admin', passkey: 'credential-2' }),
      ]))
      await render(settingsWith(), admin)

      expect(logRows().map((row) => row.querySelectorAll('td')[4].textContent))
        .toEqual(['Workspace writeApproved', 'Workspace writeApproved'])
      const byAnother = await expand()
      expect(detail(byAnother, 'Passkey')).toBe('credential-1')
      expect(detail(byAnother, 'Requested by')).toBe('admin')
      expect(detail(byAnother, 'Refusal')).toBeNull()
      expect(approvalLink(byAnother)).toBeNull()
      const byRequester = await expand(1)
      expect(detail(byRequester, 'Passkey')).toBe('credential-2')
      expect(detail(byRequester, 'Requested by')).toBeNull()
    })

    it('shows what an applied write reported, and why a failed or an expired one ended, when the record says', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        writeRecord({ event: 'applied', passkey: 'credential-1', outcome: '2 actions rejected, 0 remain pending' }),
        writeRecord({ event: 'applied', passkey: 'credential-1' }),
        writeRecord({ event: 'failed', passkey: 'credential-1', error: 'The workspace has another owner' }),
        writeRecord({ event: 'expired', admin: 'admin', error: 'The requester is no longer an admin' }),
        writeRecord({ event: 'expired', admin: 'admin' }),
        writeRecord({ event: 'denied', method: 'restartWorkspace', args: {} }),
      ]))
      await render(settingsWith(), admin)

      expect(logRows().map((row) => row.querySelectorAll('td')[4].textContent)).toEqual([
        'Workspace writeApplied', 'Workspace writeApplied', 'Workspace writeFailed',
        'Workspace writeExpired', 'Workspace writeExpired', 'Workspace writeDenied',
      ])
      const applied = await expand(0)
      expect(detail(applied, 'Outcome')).toBe('2 actions rejected, 0 remain pending')
      expect(detail(applied, 'Passkey')).toBe('credential-1')
      expect(detail(await expand(1), 'Outcome')).toBeNull()
      const failed = await expand(2)
      expect(detail(failed, 'Error')).toBe('The workspace has another owner')
      expect(detail(failed, 'Passkey')).toBe('credential-1')
      expect(detail(await expand(3), 'Error')).toBe('The requester is no longer an admin')
      expect(detail(await expand(4), 'Error')).toBeNull()
      const denied = await expand(5)
      expect(detail(denied, 'Arguments')).toBeNull()
      expect(detail(denied, 'Passkey')).toBeNull()
      expect(approvalLink(denied)).toBeNull()
    })

    it('filters by kind, which the log asks the server for as it is', async () => {
      const { listAdminAudit, onFilterChange } = await render()

      expect(kindSelect().textContent).toBe('Any kind')
      expect((await openOptions(kindSelect())).map((option) => option.textContent))
        .toEqual(['Any kind', 'Workspace access', 'User access', 'Workspace write', 'Setting change'])
      await choose(kindSelect(), 'Workspace access')
      expect(onFilterChange).toHaveBeenLastCalledWith({ kind: 'workspace' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ kind: 'workspace' }))
      expect(kindSelect().textContent).toBe('Workspace access')

      await choose(kindSelect(), 'User access')
      expect(onFilterChange).toHaveBeenLastCalledWith({ kind: 'user' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ kind: 'user' }))
      expect(kindSelect().textContent).toBe('User access')

      await choose(kindSelect(), 'Setting change')
      expect(onFilterChange).toHaveBeenLastCalledWith({ kind: 'setting' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ kind: 'setting' }))
      expect(kindSelect().textContent).toBe('Setting change')

      await choose(kindSelect(), 'Workspace write')
      expect(onFilterChange).toHaveBeenLastCalledWith({ kind: 'write' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ kind: 'write' }))
      expect(kindSelect().textContent).toBe('Workspace write')

      await choose(kindSelect(), 'Any kind')
      expect(onFilterChange).toHaveBeenLastCalledWith({ kind: undefined })
      expect(listAdminAudit.mock.lastCall?.[0]?.kind).toBeUndefined()
      expect(kindSelect().textContent).toBe('Any kind')
      // A kind alone asks for nothing of what a call exposed.
      for (const [query] of listAdminAudit.mock.calls) expect(query?.exposed).toBeUndefined()
    })

    it('filters by what a call exposed, which the log asks the server for as it is', async () => {
      const { listAdminAudit, onFilterChange } = await render(settingsWith(), fakeAdmin(), { admin: 'admin' })

      expect(exposedSelect().textContent).toBe('Anything')
      expect((await openOptions(exposedSelect())).map((option) => option.textContent))
        .toEqual(['Anything', 'Content reads', 'Metadata only'])
      await choose(exposedSelect(), 'Content reads')
      expect(onFilterChange).toHaveBeenLastCalledWith({ admin: 'admin', exposed: 'content' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ admin: 'admin', exposed: 'content' }))
      expect(exposedSelect().textContent).toBe('Content reads')

      await choose(exposedSelect(), 'Metadata only')
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ admin: 'admin', exposed: 'metadata' }))
      expect(exposedSelect().textContent).toBe('Metadata only')

      await choose(exposedSelect(), 'Anything')
      expect(onFilterChange).toHaveBeenLastCalledWith({ admin: 'admin', exposed: undefined })
      expect(listAdminAudit.mock.lastCall?.[0]?.exposed).toBeUndefined()
      expect(exposedSelect().textContent).toBe('Anything')
    })

    it('starts again from the newest page when what a call exposed is chosen', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord()], 'cursor-2'))
      const { listAdminAudit } = await render(settingsWith(), admin)
      await click(within(pages(), 'Older'))
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ cursor: 'cursor-2' }))

      await choose(exposedSelect(), 'Content reads')

      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ exposed: 'content' }))
      expect(pages().textContent).toContain('Page 1')
    })

    it('names a record by its kind, with what a call into a workspace exposed beside it and nowhere else', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(
        testPage([accessRecord(), userRecord(), settingRecord(), writeRecord()]))
      await render(settingsWith(), admin)

      expect([...card('Activity log').querySelectorAll('thead th')].map((head) => head.firstChild?.textContent))
        .toEqual(['Expand', 'Time', 'Admin', 'Action', 'Kind', 'Target user'])
      expect(logRows().map((row) => row.querySelectorAll('td')[4].textContent))
        .toEqual(['Workspace accessMetadataRefused', 'User access', 'Setting change', 'Workspace writeApproved'])
    })

    it('shows a content read: its badge, and in its details what the view was opened for and the grant it ran under', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord({
        method: 'getChat', requested: 'content', access: 'content', exposed: 'content', grantId: 'grant-7f3a',
        refused: undefined,
      })]))
      await render(settingsWith(), admin)

      const kind = logRows()[0].querySelectorAll('td')[4]
      expect(kind.textContent).toBe('Workspace accessContent')
      expect(kind.querySelector('[title="The call’s answer held content"]')?.textContent).toBe('Content')
      const details = await expand()
      expect(detail(details, 'Opened for')).toBe('Content')
      expect(detail(details, 'Access')).toBe('Content')
      expect(detail(details, 'Under grant')).toBe('grant-7f3a')
    })

    it('shows a call made under a grant whose answer held no content: the Metadata badge, and its grant', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord({
        method: 'listFiles', requested: 'content', access: 'content', grantId: 'grant-7f3a', refused: undefined,
      })]))
      await render(settingsWith(), admin)

      const kind = logRows()[0].querySelectorAll('td')[4]
      expect(kind.textContent).toBe('Workspace accessMetadata')
      expect(kind.querySelector('[title="The call’s answer held no content"]')?.textContent).toBe('Metadata')
      expect(detail(await expand(), 'Under grant')).toBe('grant-7f3a')
    })

    it.each([
      { code: ADMIN_ACCESS_ERROR_CODES.contentOff, name: 'Content off', requested: 'content', access: 'metadata' },
      {
        code: ADMIN_ACCESS_ERROR_CODES.contentNotRequested, name: 'Content not requested', requested: 'metadata',
        access: 'content',
      },
      { code: ADMIN_ACCESS_ERROR_CODES.grantRequired, name: 'No grant', requested: 'content', access: 'content' },
    ] as const)('names a content call refused $code: $name', async ({ code, name, requested, access }) => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        accessRecord({ method: 'readFile', args: { gadgetId: 'gadget-1', path: 'src/main.ts' }, requested, access, refused: code }),
      ]))
      await render(settingsWith(), admin)

      const kind = logRows()[0].querySelectorAll('td')[4]
      // A refused call read nothing, so it exposed no content.
      expect(kind.textContent).toBe('Workspace accessMetadataRefused')
      expect(kind.querySelector(`[title="${name}"]`)?.textContent).toBe('Refused')
      const details = await expand()
      expect(detail(details, 'Access')).toBe(`${access === 'content' ? 'Content' : 'Metadata'} · refused: ${name}`)
      expect(detail(details, 'Opened for')).toBe(requested === 'content' ? 'Content' : null)
      expect(detail(details, 'Under grant')).toBeNull()
    })

    it('shows a record of the shape kept before content reads as a metadata call, with no line for a view’s purpose or a grant', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([accessRecord({ access: 'metadata', refused: undefined })]))
      await render(settingsWith(), admin)

      expect(logRows()[0].querySelectorAll('td')[4].textContent).toBe('Workspace accessMetadata')
      const details = await expand()
      expect(detail(details, 'Opened for')).toBeNull()
      expect(detail(details, 'Under grant')).toBeNull()
      expect(detail(details, 'Access')).toBe('Metadata')
    })

    it('shows a record that says neither what its view was opened for nor what it exposed with no badge and no line for either', async () => {
      const { requested: _, exposed: __, ...bare } = accessRecord({ access: 'metadata', refused: undefined })
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([bare as unknown as AdminAccessRecord]))
      await render(settingsWith(), admin)

      const row = logRows()[0]
      expect(row.querySelectorAll('td')[4].textContent).toBe('Workspace access')
      const details = await expand()
      expect(detail(details, 'Opened for')).toBeNull()
      expect(detail(details, 'Under grant')).toBeNull()
      expect(row.textContent).not.toContain('undefined')
      expect(details.textContent).not.toContain('undefined')
    })

    it.each(['full', 'constructor'])('shows no badge for a record whose stored exposure, %s, the API does not name', async (exposed) => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        { ...accessRecord({ access: 'metadata', refused: undefined }), exposed } as unknown as AdminAccessRecord,
      ]))
      await render(settingsWith(), admin)

      const row = logRows()[0]
      expect(row.querySelectorAll('td')[4].textContent).toBe('Workspace access')
      expect(row.textContent).not.toContain('undefined')
    })

    it.each(['exportWorkspace', 'toString'])('shows a stored write record’s method, %s, as stored when it has no name for it', async (method) => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([{ ...writeRecord(), method } as unknown as AdminWriteRecord]))
      await render(settingsWith(), admin)

      expect(logRows()[0].querySelectorAll('td')[3].textContent).toBe(method)
      expect(detail(await expand(), 'Write')).toBe(method)
    })

    it('shows a request to read a workspace’s content: its name, a refusal of its own requester, and the grant it gave once applied', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        writeRecord({
          event: 'applied', method: 'grantContentAccess', args: {}, passkey: 'credential-1',
          outcome: 'grant grant-7f3a until 2026-10-24T10:30:00.000Z',
        }),
        writeRecord({ event: 'refused', admin: 'admin', method: 'grantContentAccess', args: {}, refusal: 'requester' }),
      ]))
      await render(settingsWith(), admin)

      expect(logRows().map((row) => [...row.querySelectorAll('td')].slice(2, 5).map((cell) => cell.textContent)))
        .toEqual([
          ['second-admin', 'grantContentAccess', 'Workspace writeApplied'],
          ['admin', 'grantContentAccess', 'Workspace writeRefused'],
        ])
      expect(logRows()[1].querySelectorAll('td')[4].querySelector('[title]')?.getAttribute('title'))
        .toBe('Requested by the same admin')
      const applied = await expand(0)
      expect(detail(applied, 'Write')).toBe('Grant content access')
      expect(detail(applied, 'Outcome')).toBe('grant grant-7f3a until 2026-10-24T10:30:00.000Z')
      expect(detail(applied, 'Requested by')).toBe('admin')
      const refused = await expand(1)
      expect(detail(refused, 'Refusal')).toBe('Requested by the same admin')
      // The admin who tried is the requester, named once, in the row.
      expect(detail(refused, 'Requested by')).toBeNull()
    })

    it('shows a grant an admin ended: who ended it and why, apart from who asked for it and why', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([writeRecord({
        event: 'revoked', admin: 'third-admin', method: 'grantContentAccess', args: {},
        reason: 'Ticket 42: owner unreachable', grantId: 'grant-7f3a', endReason: 'Ticket 42 closed',
      })]))
      await render(settingsWith(), admin)

      const cells = [...logRows()[0].querySelectorAll('td')].map((cell) => cell.textContent)
      expect(cells.slice(2)).toEqual(['third-admin', 'grantContentAccess', 'Workspace writeGrant ended', 'owner@example.test'])
      const details = await expand()
      expect(detail(details, 'Reason for ending')).toBe('Ticket 42 closed')
      expect(detail(details, 'Grant')).toBe('grant-7f3a')
      expect(detail(details, 'Reason')).toBe('Ticket 42: owner unreachable')
      expect(detail(details, 'Requested by')).toBe('admin')
      expect(detail(details, 'Passkey')).toBeNull()
    })

    it('filters by a write action picked in the Action filter', async () => {
      const { listAdminAudit, onFilterChange } = await render()
      const [, field] = card('Activity log').querySelectorAll<HTMLInputElement>('input[role="combobox"]')

      await type(field, 'restartW')
      const options = [...document.body.querySelectorAll('[role="option"]')]
      expect(options.map((option) => option.textContent)).toEqual(['restartWorkspace'])
      await act(async () => { options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })

      expect(onFilterChange).toHaveBeenLastCalledWith({ method: 'restartWorkspace' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ method: 'restartWorkspace' }))
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

    it('filters by the owner and the workspace a write record names, offering and titling them from write records alone', async () => {
      const admin = fakeAdmin()
      admin.listAdminAudit.mockResolvedValue(testPage([
        writeRecord({ workspaceOwner: 'grace' }), writeRecord({ event: 'applied', workspaceOwner: 'linus' }),
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

      await click(within(await expand(), 'Show only calls into Quarterly report'))
      expect(onFilterChange).toHaveBeenLastCalledWith({ owner: 'linus', workspace: 'ws-titled' })
      expect(listAdminAudit).toHaveBeenLastCalledWith(pageQuery({ owner: 'linus', workspace: 'ws-titled' }))
      expect(button('Show every workspace, not only Quarterly report').textContent).toBe('Workspace: Quarterly report')
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
      await render(heldDown())

      expect(accessSelect().textContent).toContain('Off')
      expect(card('Inspection access').textContent)
        .toContain('The level set here is Metadata, which that maximum limits to Off. Choose Off ' +
          'to set it here, so that a higher maximum does not raise it.')
    })

    it.each([
      'chat messages',
      'messages queued for an agent',
      'attachments',
      'file contents',
      'commit messages',
      'arguments of calls queued for an agent',
      'configuration an agent suggested for a connection',
      'which blueprint a gadget follows',
      'ids of the blueprints',
      'descriptions and fields of actions, observations and hooks',
    ])('says that Metadata withholds %s', async (part) => {
      await render()

      const help = card('Inspection access').textContent
      expect(help.slice(help.indexOf('withholds'), help.indexOf('Titles'))).toContain(part)
    })

    it('says what Metadata still shows, and that it can echo content', async () => {
      await render()

      expect(card('Inspection access').textContent).toContain(
        'Titles, file names, commit authors, share links’ notes, blueprint descriptions, and the ' +
          'names and hashes of attachments stay, and can echo content.')
    })

    it.each([
      'what each connected account’s gatekeeper says of it (its names, avatar and what it grants)',
      'the ids of the user’s blueprints',
    ])('says that, of a user’s account, Metadata withholds %s', async (part) => {
      await render()

      const help = card('Inspection access').textContent
      expect(help.slice(help.indexOf('Of a user’s account'), help.indexOf('Off refuses'))).toContain(part)
    })

    it('offers Off, Metadata and Content, in that order, and Content only where the deployment allows it', async () => {
      await render()

      expect((await openOptions(accessSelect())).map((option) => option.textContent))
        .toEqual(['Off', 'Metadata', 'Content'])
      expect(await enabledOptions(accessSelect())).toEqual(['Off', 'Metadata'])
      expect(card('Inspection access').textContent).not.toContain('Full')

      act(() => root.unmount())
      root = createRoot(container)
      await render(settingsWith({ access: { max: 'content' } }))
      expect(await enabledOptions(accessSelect())).toEqual(['Off', 'Metadata', 'Content'])
    })

    it('leaves only Off when the deployment allows no inspection', async () => {
      await render(heldDown())

      expect((await openOptions(accessSelect())).map((option) => option.textContent))
        .toEqual(['Off', 'Metadata', 'Content'])
      expect(await enabledOptions(accessSelect())).toEqual(['Off'])
      expect(card('Inspection access').textContent).toContain('ADMIN_WORKSPACE_ACCESS_MAX allows no inspection')
    })

    it('says that Content is read only under a live grant, and that such a read is recorded with it', async () => {
      await render()

      expect(card('Inspection access').textContent).toContain(
        'Content lets an admin also read what Metadata withholds of a workspace, but only under a live ' +
          'grant: one the workspace’s owner gave, or one a second admin approved with a passkey. Never ' +
          'without one. Each such read is recorded here with the grant it ran under.')
    })

    it('says why Content cannot be chosen while the deployment’s maximum is below it, and not once it allows it', async () => {
      const reason = 'Content cannot be chosen here: only this deployment’s ADMIN_WORKSPACE_ACCESS_MAX can allow it.'
      await render()
      expect(await enabledOptions(accessSelect())).not.toContain('Content')
      expect(card('Inspection access').textContent).toContain(reason)

      act(() => root.unmount())
      root = createRoot(container)
      await render(settingsWith({ access: { max: 'content' } }))
      expect(card('Inspection access').textContent).not.toContain(reason)
    })

    it('says which level holds a choice of Content down, under the reason it cannot be chosen', async () => {
      await render(settingsWith({ access: { chosen: 'content' } }))

      expect(accessSelect().textContent).toContain('Metadata')
      expect(card('Inspection access').textContent).toContain(
        'only this deployment’s ADMIN_WORKSPACE_ACCESS_MAX can allow it.' +
          'The level set here is Content, which that maximum limits to Metadata.')
    })

    it('sets Content where the deployment allows it', async () => {
      const { setAdminWorkspaceAccess } = await render(settingsWith({ access: { max: 'content' } }))

      await choose(accessSelect(), 'Content')

      expect(setAdminWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('content')
    })

    it('sets the level chosen, then re-reads the settings and the log', async () => {
      const { setAdminWorkspaceAccess, onSettingsChanged, listAdminAudit } = await render()

      await choose(accessSelect(), 'Off')

      expect(setAdminWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('off')
      expect(onSettingsChanged).toHaveBeenCalledOnce()
      expect(listAdminAudit).toHaveBeenCalledTimes(2)
    })

    it('stores the level shown as the admins’ choice while the maximum holds a higher one down, and sends nothing for the choice itself', async () => {
      const held = await render(heldDown())
      await choose(accessSelect(), 'Off')
      expect(held.setAdminWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('off')

      act(() => root.unmount())
      root = createRoot(container)
      const own = await render()
      await choose(accessSelect(), 'Metadata')
      expect(own.setAdminWorkspaceAccess).not.toHaveBeenCalled()
    })

    it('is disabled while its change is in flight', async () => {
      const admin = fakeAdmin()
      const call = deferred()
      admin.setAdminWorkspaceAccess.mockReturnValueOnce(call.promise)
      await render(settingsWith(), admin)

      await choose(accessSelect(), 'Off')
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

      await choose(accessSelect(), 'Off')
      ;(document.activeElement as HTMLElement | null)?.blur()
      await act(async () => call.resolve())

      expect(document.activeElement).toBe(accessSelect())
    })

    it('reports a failed change and keeps the server’s level', async () => {
      const admin = fakeAdmin()
      admin.setAdminWorkspaceAccess.mockRejectedValueOnce(new Error('The admin settings are unavailable'))
      const { onSettingsChanged } = await render(settingsWith(), admin)

      await choose(accessSelect(), 'Off')

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: 'Couldn’t update “Inspection access”',
        description: 'The admin settings are unavailable',
        variant: 'error',
      })
      expect(onSettingsChanged).not.toHaveBeenCalled()
      expect(accessSelect().textContent).toContain('Metadata')
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

      expect(stored()).toEqual({ time: 122, admin: 140, kind: 240, target: 140 })
    })

    it('resizes a column by dragging its edge, storing the width once the drag ends', async () => {
      await render()

      await pointer('pointerdown', handle('Admin'), 500)
      await pointer('pointermove', handle('Admin'), 560)
      expect(widths()[2]).toBe('200px')
      expect(stored()).toBeNull()
      await pointer('pointerup', handle('Admin'), 580)

      expect(widths()[2]).toBe('220px')
      expect(stored()).toEqual({ time: 170, admin: 220, kind: 240, target: 140 })
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
      expect(stored()).toEqual({ time: 170, admin: 140, kind: 240, target: 140 })
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
