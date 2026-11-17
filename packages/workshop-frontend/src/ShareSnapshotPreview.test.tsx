// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { ShareSnapshotPreview } from './ShareSnapshotPreview'

// Covers what the share dialog's snapshot preview holds open and how its full screen closes: each
// copy costs a whole copy of the gadget's storage (see Overseer.getGadgetSnapshot).

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('./GadgetUI', () => ({ default: () => <div data-testid="gadget-ui" /> }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./SnapshotRefreshButton', () => ({ SnapshotRefreshButton: () => null }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
})

// An open the test settles, and the stubs it hands out, each recording its disposal.
function snapshotOpen() {
  const held = { [Symbol.dispose]: vi.fn<() => void>() }
  const opened = { dup: () => held, [Symbol.dispose]: vi.fn<() => void>() }
  const { promise, resolve, reject } = Promise.withResolvers<typeof opened>()
  const opening = Object.assign(promise, { [Symbol.dispose]: vi.fn<() => void>() })
  const overseer = { getGadgetSnapshot: () => opening } as unknown as RpcStub<Overseer>
  return { overseer, opening, opened, held, resolve: () => resolve(opened), reject }
}

function render(overseer: RpcStub<Overseer>, fullscreen = false,
                onFullscreenChange = vi.fn<(fullscreen: boolean) => void>()) {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  act(() => root!.render(
    <ShareSnapshotPreview
      overseer={overseer}
      gadgetId={0}
      gadgetTitle="Itinerary"
      workspaceTitle="Trip planner"
      fullscreen={fullscreen}
      onFullscreenChange={onFullscreenChange}
    />,
  ))
  return onFullscreenChange
}

it('holds one copy while shown and disposes it on unmount', async () => {
  const open = snapshotOpen()
  render(open.overseer)
  await act(async () => open.resolve())
  expect(container!.querySelector('[data-testid="gadget-ui"]')).not.toBeNull()
  // The open's own result is let go at once; the duplicate is what the preview holds.
  expect(open.opened[Symbol.dispose]).toHaveBeenCalled()
  expect(open.held[Symbol.dispose]).not.toHaveBeenCalled()

  act(() => root!.unmount())
  root = undefined
  expect(open.held[Symbol.dispose]).toHaveBeenCalled()
})

it('disposes a copy whose open finishes after the preview is gone, keeping none', async () => {
  const open = snapshotOpen()
  render(open.overseer)
  act(() => root!.unmount())
  root = undefined
  expect(open.opening[Symbol.dispose]).toHaveBeenCalled()

  await act(async () => open.resolve())
  expect(open.opened[Symbol.dispose]).toHaveBeenCalled()
  expect(open.held[Symbol.dispose]).not.toHaveBeenCalled()
})

it('says the preview failed when the open is refused', async () => {
  const open = snapshotOpen()
  render(open.overseer)
  await act(async () => open.reject(new Error('No such gadget: 0')))
  expect(container!.textContent).toContain('Couldn’t load a preview.')
})

it('leaves full screen on Escape without letting the dialog close too', async () => {
  const open = snapshotOpen()
  const onFullscreenChange = render(open.overseer, true)
  await act(async () => open.resolve())
  const dialogEscape = vi.fn<() => void>()
  document.addEventListener('keydown', dialogEscape)
  try {
    act(() => {
      container!.querySelector('[aria-label="Exit full screen"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
  } finally {
    document.removeEventListener('keydown', dialogEscape)
  }
  expect(onFullscreenChange).toHaveBeenCalledWith(false)
  expect(dialogEscape).not.toHaveBeenCalled()
})
