/* eslint-disable react/react-in-jsx-scope */

// A gadget's real sandboxed frame, in Chromium: what its code logs and the error it does not catch,
// from the frame's console patch and error listener to the batch the view sends. jsdom runs no
// frame code, so the other suites post the frame's messages themselves.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  ConsoleLogEvent, GadgetClient, Overseer, ReportedGadgetConsoleLog, ServerConfig, UiBundle,
} from '@gadgets/workshop-shared/api'
import GadgetUI from './GadgetUI'
import { ServerConfigContext } from './ServerConfigContext'

const FRAME_CODE = 'console.warn("frame-warn", { a: 1 }); setTimeout(() => { throw new Error("frame-boom") })'

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it('sends what a gadget frame logs, and the error it does not catch', async () => {
  const gadget = {
    getUiBundle: async (): Promise<UiBundle> => ({ jsCode: FRAME_CODE }),
    connectToGadget: async () => new RpcStub(new (class extends RpcTarget {})()),
  } as unknown as RpcStub<GadgetClient>
  const sent: ReportedGadgetConsoleLog[] = []
  const reportGadgetConsoleLogs: Overseer['reportGadgetConsoleLogs'] = async (_gadgetId, _chatId, entries) => {
    sent.push(...entries)
  }
  const overseer = { reportGadgetConsoleLogs } as unknown as RpcStub<Overseer>
  const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()

  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(
    <ServerConfigContext.Provider value={{ gadgetConsoleLogsRecorded: true } as ServerConfig}>
      <GadgetUI gadget={gadget} overseer={overseer} gadgetId={1} height="200px" onConsoleLog={onConsoleLog} />
    </ServerConfigContext.Provider>,
  ))
  await expect.poll(() => onConsoleLog.mock.calls.length).toBe(2)

  // Going away sends what the view has queued.
  await act(async () => root!.unmount())
  expect(sent).toStrictEqual([
    { time: expect.any(Date), level: 'warn', text: 'frame-warn {"a":1}' },
    { time: expect.any(Date), level: 'error', text: expect.stringMatching(/^Uncaught[^]*frame-boom/) },
  ])
})
