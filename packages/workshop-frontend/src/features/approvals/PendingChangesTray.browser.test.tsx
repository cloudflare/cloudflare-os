/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { PendingChangesTray } from './PendingChangesTray'
import type { BulkFailure } from './useBulkResolve'
import type { PendingChange, PendingChangeGroup } from './pendingChangeGroups'
import '../../styles.css'

const APPEND = { tag: 'append', label: 'Append a slide' }

// A request whose JSON field runs well past any height the composer stack can give the tray:
// the case the layout has to survive without putting a decision out of reach.
const BIG_JSON = JSON.stringify(
  { summary: 'Road trip planning', attendees: Array.from({ length: 40 }, (_, i) => `person${i}@example.com`) },
  null, 2)

function request(
  id: number,
  title: string,
  fields: unknown[] = [],
  over: { origin?: PendingChange['origin'], autoApprovable?: boolean } = {},
): PendingChange {
  return {
    id,
    gatekeeperId: 1,
    resourceTitle: 'Road trip 2026',
    createdAt: new Date(Date.now() - 60_000),
    state: 'pending',
    type: 'action',
    origin: over.origin ?? 'open-chat',
    description: {
      title,
      description: 'Adds a slide titled "Day three" after the itinerary.',
      implementsRevert: false,
      autoApprovable: over.autoApprovable === true,
      actionKind: APPEND,
      fields,
    },
  } as PendingChange
}

function group(entries: PendingChange[], gatekeeperId: number, title: string): PendingChangeGroup {
  return { gatekeeperId, title, entries, hasCreation: false }
}

/** A run that stopped partway, which the tray reports in its longest notice. */
const STOPPED: BulkFailure = {
  decision: 'approve', applied: 2, total: 12, title: 'Append a slide 3',
  reason: 'The provider refused the request because the presentation is locked for editing.',
}

/** Runs a browser interaction inside act(), so React has committed before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

let host: HTMLDivElement | undefined, root: Root | undefined
let previousViewport: { width: number, height: number } | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  if (previousViewport) {
    await page.viewport(previousViewport.width, previousViewport.height)
    previousViewport = undefined
  }
})

async function render({
  groups,
  restricted = false,
  maxHeight = '520px',
  failure = null,
  width = 720,
  autoApproved = false,
}: {
  groups: PendingChangeGroup[]
  restricted?: boolean
  maxHeight?: string
  failure?: BulkFailure | null
  /** The chat pane's width; 280px is the narrowest GadgetEditor supports. */
  width?: number
  autoApproved?: boolean
}) {
  host = document.body.appendChild(document.createElement('div'))
  // The width the composer gives it, and a height that forces the tray to scroll rather than
  // grow -- which is the whole point of the layout.
  host.style.width = `${width}px`
  host.style.maxHeight = maxHeight
  root = createRoot(host)
  await act(async () => root!.render(
    <PendingChangesTray
      groups={groups}
      rules={{ isEnabled: () => autoApproved, restricted }}
      ready={true}
      vendorIdByGatekeeper={new Map()}
      vendorBranding={new Map()}
      actions={{
        processing: new Set<number>(),
        onApprove: () => {},
        onReject: () => {},
        onAlwaysApprove: () => {},
        onManageRules: () => {},
      }}
      bulk={{
        run: async () => {}, progress: null, failure, dismissFailure: () => {},
      }}
    />,
  ))
}

it('keeps a decision reachable however tall the request is', async () => {
  const fields = [{ label: 'Event', kind: 'json', value: BIG_JSON }]
  await render({ groups: [group([
    request(1, 'Change Road trip 2026 and the theme', fields),
    request(2, 'Append a slide to Road trip 2026', fields),
  ], 1, 'Road trip 2026')] })

  await input(() => userEvent.click(host!.querySelector('button[aria-expanded="false"]')!))

  const tray = host!.firstElementChild!.getBoundingClientRect()
  const approve = [...host!.querySelectorAll('button')].filter(b => b.textContent === 'Approve')
  expect(approve.length).toBe(2)

  // The first request's controls sit inside the tray's own box, not below it: the card puts them
  // in its header, so the body can be as tall as the gatekeeper made it.
  const first = approve[0].getBoundingClientRect()
  expect(first.top).toBeGreaterThanOrEqual(tray.top)
  expect(first.bottom).toBeLessThanOrEqual(tray.bottom + 1)

  // And the group scrolls its own content rather than pushing the composer off screen.
  const body = host!.querySelector('[class*="max-h-[min(18rem"]')!
  expect(body.scrollHeight).toBeGreaterThan(body.clientHeight)
  expect(tray.height).toBeLessThanOrEqual(520)

  // The group's own "Apply all" stays inside the tray's scroller rather than being sliced by it:
  // the inner cap is set below the outer one precisely so this row survives a full-height body.
  // The tray header carries the same label, so the group's is the last one.
  const applyAll = [...host!.querySelectorAll('button')]
    .filter(b => b.textContent === 'Apply all 2')
  expect(applyAll).toHaveLength(2)
  const footer = applyAll[1].getBoundingClientRect()
  expect(footer.height).toBeGreaterThan(0)
  expect(footer.bottom).toBeLessThanOrEqual(tray.bottom + 1)
})

it('leaves the composer room on a short window', async () => {
  // The tray sits in the composer's unshrinkable section, inside a pane that hides its overflow:
  // a list tall enough to fill a short window pushes the composer past the bottom edge, where
  // scrolling the tray cannot bring it back. Enough collapsed groups to overflow any cap, and
  // a failed run's notice above them, which is the longest line the header can carry and wraps
  // at this width.
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(900, 500)
  await render({
    groups: Array.from({ length: 12 }, (_, i) =>
      group([request(i + 1, `Append a slide ${i + 1}`)], i + 1, `Resource ${i + 1}`)),
    maxHeight: 'none',
    failure: STOPPED,
  })

  const tray = host!.firstElementChild!
  const scroller = tray.lastElementChild!
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
  // Half the window is the generous reading of "room for the composer and some transcript"; the
  // cap itself is tighter. A fixed rem cap fails this outright at this height.
  expect(tray.getBoundingClientRect().height).toBeLessThanOrEqual(250)

  // The notice has to stay on screen with it: it is the only thing saying where the run
  // stopped and why, and it is the longest line the header can carry.
  const notice = host!.querySelector('[role="alert"]')!
  const box = notice.getBoundingClientRect()
  expect(box.height).toBeGreaterThan(0)
  expect(box.bottom).toBeLessThanOrEqual(tray.getBoundingClientRect().bottom + 1)
})

it('keeps a request in reach however many notices stand above it', async () => {
  // The narrowest supported chat pane is 280px (GadgetEditor), where every notice wraps to
  // several lines. Three can stand at once, and together they were enough to leave the request
  // list no height at all -- a tray whose whole point is below its own clipped edge.
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(900, 500)
  const pressured = Array.from({ length: 40 }, (_, i) => request(i + 1, `Append a slide ${i + 1}`))
  await render({
    groups: [
      group(pressured, 1, 'Road trip 2026'),
      group([request(41, 'Create an event')], 2, 'Team calendar'),
    ],
    maxHeight: 'none',
    failure: STOPPED,
    width: 280,
  })

  const tray = host!.firstElementChild!
  const list = tray.lastElementChild!
  expect(list.getBoundingClientRect().height).toBeGreaterThanOrEqual(80)
  // And it is inside the tray, not below the edge the tray clips at.
  expect(list.getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(tray.getBoundingClientRect().bottom + 1)

  // Which means the other connection's own row is reachable by scrolling the list.
  const rows = [...host!.querySelectorAll('button[aria-expanded]')]
  expect(rows.some(row => (row.textContent ?? '').includes('Team calendar'))).toBe(true)
})

it('keeps the connection name readable when its badges fill the row', async () => {
  // The badges are non-wrapping siblings of the title, so at the narrowest chat pane they took
  // the whole row and left the name nothing. The name is what says which service is waiting;
  // both badges are repeated inside the group.
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(900, 700)
  await render({
    groups: [group([
      request(1, 'Append a slide', [], { origin: 'elsewhere', autoApprovable: true }),
      request(2, 'Append another slide', [], { origin: 'elsewhere', autoApprovable: true }),
    ], 1, 'Road trip 2026')],
    width: 280,
    autoApproved: true,
  })

  const title = [...host!.querySelectorAll('span')]
    .find(span => span.textContent === 'Road trip 2026')!
  expect(title.getBoundingClientRect().width).toBeGreaterThanOrEqual(56)
  // The badges are there, just giving way: they are what shrinks, not the name.
  expect(host!.textContent).toContain('Asked elsewhere')
})

it('opens one group at a time, and keeps focus on the row that was pressed', async () => {
  await render({ groups: [
    group([request(1, 'Append a slide')], 1, 'Road trip 2026'),
    group([request(2, 'Create an event')], 2, 'Team calendar'),
  ] })

  const rows = () => [...host!.querySelectorAll('button[aria-expanded]')]
    .filter(b => (b.textContent ?? '').includes('request'))
  const [slides, calendar] = rows()

  await input(() => userEvent.click(slides))
  expect(slides.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(slides)

  await input(() => userEvent.click(calendar))
  // Two expanded bodies would push the tray past any height the composer stack can give it.
  expect(rows()[0].getAttribute('aria-expanded')).toBe('false')
  expect(rows()[1].getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(rows()[1])
})

it('reaches every group and its decisions by keyboard alone', async () => {
  await render({ groups: [
    group([request(1, 'Append a slide')], 1, 'Road trip 2026'),
    group([request(2, 'Create an event')], 2, 'Team calendar'),
  ] })

  const bulk = [...host!.querySelectorAll('button')].find(b => b.textContent?.startsWith('Apply all'))!
  bulk.focus()
  await input(() => userEvent.keyboard('{Tab}'))

  const slides = document.activeElement as HTMLButtonElement
  expect(slides.getAttribute('aria-expanded')).toBe('false')
  await input(() => userEvent.keyboard('{Enter}'))
  expect(slides.getAttribute('aria-expanded')).toBe('true')

  // Opening a group puts its decisions in the tab order right after it, rather than somewhere a
  // keyboard user has to hunt for.
  await input(() => userEvent.keyboard('{Tab}'))
  expect((document.activeElement as HTMLElement).textContent).toBe('Append a slide')
  await input(() => userEvent.keyboard('{Tab}'))
  expect((document.activeElement as HTMLElement).textContent).toBe('Deny')
  await input(() => userEvent.keyboard('{Tab}'))
  expect((document.activeElement as HTMLElement).textContent).toBe('Approve')
})

it('shows a restricted request in full, with no way to resolve the group at once', async () => {
  await render({
    groups: [group([
      request(1, 'Append a slide', [{ label: 'Event', kind: 'json', value: BIG_JSON }]),
      request(2, 'Append another slide'),
    ], 1, 'Road trip 2026')],
    restricted: true,
  })

  expect([...host!.querySelectorAll('button')].some(b => b.textContent?.startsWith('Apply all')))
    .toBe(false)

  await input(() => userEvent.click(host!.querySelector('button[aria-expanded="false"]')!))

  // The caps are dropped on purpose while restricted: the approver is the leak check, so the
  // whole field is laid out and the tray scrolls to it rather than clipping it.
  const json = [...host!.querySelectorAll('pre')].find(pre => pre.textContent === BIG_JSON)!
  expect(json.scrollHeight).toBeLessThanOrEqual(json.clientHeight + 1)
})
