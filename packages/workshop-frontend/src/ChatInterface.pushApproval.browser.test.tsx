/* eslint-disable react/react-in-jsx-scope */

// A push's decision controls in the chat's transcript, in Chromium: a push adds "Review commits"
// to them, and whether they stay inside the request at the narrowest chat pane is a matter of
// layout, which jsdom does not do. The transcript decides a request in two places: the blocking
// callout, and the row of a request the tray does not hold.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Toasty, TooltipProvider } from '@cloudflare/kumo'
import type { ActionLogEntry, AiChatMessage } from '@gadgets/workshop-shared/api'

vi.mock('./AuthContext', () => {
  const context = { authenticatedApi: { listGatekeeperVendors: async () => [] }, currentUser: null }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => null }
})

import { makeOverseer, pushEntry } from './action-test-harness'
import ChatInterface from './ChatInterface'
import './styles.css'

// The harness holds animation frames for jsdom suites to release by hand; this one has real ones.
vi.unstubAllGlobals()

/** The narrowest chat pane GadgetEditor allows. */
const NARROWEST_PANE = 280

let host: HTMLDivElement | undefined, root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

/**
 * Renders chat 1 in a pane `width` wide with `log` as a pending request of its agent. The
 * workspace's queue holds the request unless `inTray` is false, which leaves a request that
 * does not block the agent to be decided on its transcript row.
 */
async function renderRequest(
  log: ActionLogEntry,
  options: { restricted: boolean, width: number, inTray?: boolean },
) {
  const server = makeOverseer()
  let subscriber: { message: (message: AiChatMessage) => void } | undefined
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: async () => ({ messages: [] }),
    listChats: async () => [{ id: 1, title: 'Chat', started: new Date(), lastActive: new Date() }],
    listModels: async () => [],
    listPreApprovableActions: async () => [],
    listAutoApprovedActionKinds: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: (next: typeof subscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
    viewChat: () => ({ [Symbol.dispose]: () => {} }),
  })
  host = document.body.appendChild(document.createElement('div'))
  // The column GadgetEditor gives the chat: a set width, which the chat fills.
  host.className = 'flex flex-col flex-shrink-0'
  host.style.width = `${options.width}px`
  host.style.height = '700px'
  root = createRoot(host)
  await act(async () => root!.render(
    <TooltipProvider>
      <Toasty>
        <ChatInterface workspaceId="workspace" overseer={server.overseer} restricted={options.restricted}
          selectedChatId={1} onNavigateToChat={() => {}} pendingConsoleLogCount={0} consoleLogPreview=""
          consoleLogSeverity="info" onConsumeConsoleLogs={() => ''} onDiscardConsoleLogs={() => {}}
          onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />
      </Toasty>
    </TooltipProvider>,
  ))
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: options.inTray === false ? [] : [log] })
  await act(async () => subscriber!.message({
    chatId: 1, sequence: 0, timestamp: new Date(), author: { type: 'agent', id: 'model', name: 'Model' },
    type: 'action', actionId: log.id, actionLog: log,
  } as AiChatMessage))
}

const blockingPush = pushEntry(1, {
  description: {
    ...pushEntry(1).description,
    title: 'Push 3 commits to the branch main of acme/widgets',
    awaitDecision: true,
  },
})

/** A push that does not block its agent and whose kind a rule could approve. */
const ruleOfferedPush = pushEntry(2, {
  description: {
    ...pushEntry(2).description,
    title: 'Push 3 commits to the branch main of acme/widgets',
    autoApprovable: true,
    actionKind: { tag: 'push', label: 'Push commits' },
  },
})

const DECISIONS = ['Deny', 'Review commits', 'Approve']
const RULE_OFFER = 'Always approve'

/** The request's decision controls, once the request is laid out. */
const decisions = () => vi.waitFor(() => {
  const found = [...host!.querySelectorAll('button')]
    .filter(button => [RULE_OFFER, ...DECISIONS].includes(button.textContent ?? ''))
  if (found.length === 0) throw new Error('The request has no decision controls')
  return found
})

/** Asserts that `card` spills nothing sideways and that each control is whole inside it. */
function expectInside(card: Element, controls: HTMLElement[]) {
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth)
  const edge = card.getBoundingClientRect()
  const pane = host!.getBoundingClientRect()
  expect(edge.left).toBeGreaterThanOrEqual(pane.left)
  expect(edge.right).toBeLessThanOrEqual(pane.right)
  for (const control of controls) {
    const box = control.getBoundingClientRect()
    expect(box.width).toBeGreaterThan(0)
    expect(box.left).toBeGreaterThanOrEqual(edge.left)
    expect(box.right).toBeLessThanOrEqual(edge.right)
    // No label breaks across lines to make room.
    expect(box.height).toBeLessThanOrEqual(28)
  }
}

for (const [name, restricted, labels] of [
  ['an unrestricted', false, DECISIONS],
  ['a restricted', true, ['Deny', 'Review commits']],
] as const) {
  it(`keeps every control of a push inside the callout at the narrowest pane, in ${name} workspace`, async () => {
    await renderRequest(blockingPush, { restricted, width: NARROWEST_PANE })

    const controls = await decisions()
    expect(controls.map(control => control.textContent)).toEqual(labels)
    expectInside(controls[0].closest('.rounded-2xl')!, controls)
  })
}

it('keeps the rule offer and every control of a push the tray does not hold inside the narrowest pane', async () => {
  await renderRequest(ruleOfferedPush, { restricted: false, width: NARROWEST_PANE, inTray: false })

  const controls = await decisions()
  expect(controls.map(control => control.textContent)).toEqual([RULE_OFFER, ...DECISIONS])
  expectInside(controls[0].closest('.group\\/work')!, controls)
})

it('keeps the controls beside the request where the pane has room for both', async () => {
  await renderRequest(blockingPush, { restricted: false, width: 700 })

  const controls = await decisions()
  expect(controls.map(control => control.textContent)).toEqual(DECISIONS)
  const title = [...host!.querySelectorAll('span')]
    .find(span => span.textContent === blockingPush.description.title)!.getBoundingClientRect()
  const tops = controls.map(control => control.getBoundingClientRect())
  // One line of controls, to the right of the request rather than under it.
  expect(new Set(tops.map(box => Math.round(box.top + box.height / 2))).size).toBe(1)
  expect(tops[0].left).toBeGreaterThanOrEqual(title.right)
})
