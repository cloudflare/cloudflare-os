/* eslint-disable react/react-in-jsx-scope */

// A gadget's real sandboxed frame, in Chromium: what its code says on the console, the error it
// throws and the rejection it leaves unhandled, from the frame's console patch and its error
// listeners to what the view reports. jsdom runs no frame code, so the other suites post the
// frame's messages themselves.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  ConsoleLogEvent, GadgetClient, Overseer, ReportedGadgetError, UiBundle,
} from '@gadgets/workshop-shared/api'
import GadgetUI from './GadgetUI'

const FRAME_CODE = [
  'console.error("said");',
  'console.log("also");',
  'setTimeout(() => { throw new Error("thrown later") });',
  'Promise.reject(new Error("rejected"));',
].join('\n')

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it('reports the errors a gadget frame does not catch, and nothing it says on the console', async () => {
  const gadget = {
    getUiBundle: async (): Promise<UiBundle> => ({ jsCode: FRAME_CODE }),
    connectToGadget: async () => new RpcStub(new (class extends RpcTarget {})()),
  } as unknown as RpcStub<GadgetClient>
  const calls: ReportedGadgetError[][] = []
  const reportGadgetErrors: Overseer['reportGadgetErrors'] = async (_gadgetId, _chatId, entries) => {
    calls.push(entries)
  }
  const overseer = { reportGadgetErrors } as unknown as RpcStub<Overseer>
  const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()

  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(
    <GadgetUI gadget={gadget} overseer={overseer} gadgetId={1} height="200px" onConsoleLog={onConsoleLog} />,
  ))
  // The live console is shown all four: the two console calls and the two uncaught errors.
  await expect.poll(() => onConsoleLog.mock.calls.length).toBe(4)
  const shown = onConsoleLog.mock.calls.map(([log]) => `${log.level}: ${log.message.join(' ')}`)
  expect(shown).toContain('error: said')
  expect(shown).toContain('log: also')
  expect(shown.filter(line => line.startsWith('error: Uncaught') && line.includes('thrown later'))).toHaveLength(1)
  expect(shown.filter(line =>
    line.startsWith('error: Unhandled promise rejection:') && line.includes('rejected'))).toHaveLength(1)

  // Going away sends what the view has queued: one call, with exactly the two errors.
  await act(async () => root!.unmount())
  expect(calls).toHaveLength(1)
  const texts = calls[0].map(entry => entry.text)
  expect(texts).toHaveLength(2)
  expect(texts.filter(text => text.startsWith('Uncaught') && text.includes('thrown later'))).toHaveLength(1)
  expect(texts.filter(text =>
    text.startsWith('Unhandled promise rejection:') && text.includes('rejected'))).toHaveLength(1)
  for (const text of texts) {
    expect(text).not.toContain('said')
    expect(text).not.toContain('also')
  }
  // Each entry is its text alone.
  for (const entry of calls[0]) expect(Object.keys(entry)).toStrictEqual(['text'])
})
