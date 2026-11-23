/* eslint-disable react/react-in-jsx-scope */

// A gadget's real sandboxed frame, in Chromium: what its code says on the console, the error it
// throws and the rejection it leaves unhandled, from the frame's console patch and its error
// listeners to what the view reports. jsdom runs no frame code, so the other suites call the
// frame's session themselves.

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

// Firefox's stack holds frames alone: the report puts the error's name and message ahead of it.
it('reports the message of an error whose stack leaves it out', async () => {
  const code = [
    'setTimeout(() => {',
    '  const error = new Error("the cart is empty");',
    '  Object.defineProperty(error, "stack", { value: "render@client.js:1:1\\n" });',
    '  throw error;',
    '});',
  ].join('\n')
  const gadget = {
    getUiBundle: async (): Promise<UiBundle> => ({ jsCode: code }),
    connectToGadget: async () => new RpcStub(new (class extends RpcTarget {})()),
  } as unknown as RpcStub<GadgetClient>
  const calls: ReportedGadgetError[][] = []
  const overseer = { reportGadgetErrors: async (_g: unknown, _c: unknown, entries: ReportedGadgetError[]) => {
    calls.push(entries)
  } } as unknown as RpcStub<Overseer>
  const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()

  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(
    <GadgetUI gadget={gadget} overseer={overseer} gadgetId={1} height="200px" onConsoleLog={onConsoleLog} />,
  ))
  await expect.poll(() => onConsoleLog.mock.calls.length).toBe(1)
  await act(async () => root!.unmount())
  root = undefined
  expect(calls).toHaveLength(1)
  expect(calls[0]![0]!.text).toContain('Error: the cart is empty')
  expect(calls[0]![0]!.text).toContain('render@client.js:1:1')
})

// A worker's uncaught exception reaches the frame with no thrown value, its diagnostic in the
// event's message.
it('reports the message of an uncaught error that has no thrown value', async () => {
  const code = [
    'const worker = new Worker("data:text/javascript,throw new Error(\\"the worker failed\\")");',
    'worker.onerror = (event) => { window.dispatchEvent(new ErrorEvent("error", { message: event.message })); };',
  ].join('\n')
  const gadget = {
    getUiBundle: async (): Promise<UiBundle> => ({ jsCode: code }),
    connectToGadget: async () => new RpcStub(new (class extends RpcTarget {})()),
  } as unknown as RpcStub<GadgetClient>
  const calls: ReportedGadgetError[][] = []
  const overseer = { reportGadgetErrors: async (_g: unknown, _c: unknown, entries: ReportedGadgetError[]) => {
    calls.push(entries)
  } } as unknown as RpcStub<Overseer>
  const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()

  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(
    <GadgetUI gadget={gadget} overseer={overseer} gadgetId={1} height="200px" onConsoleLog={onConsoleLog} />,
  ))
  await expect.poll(() => onConsoleLog.mock.calls.some(([log]) => log.message.join(' ').includes('the worker failed'))).toBe(true)
  await act(async () => root!.unmount())
  root = undefined
  const texts = calls.flat().map(entry => entry.text)
  expect(texts.some(text => text.includes('the worker failed'))).toBe(true)
  expect(texts.some(text => text.startsWith('Uncaught null'))).toBe(false)
})

// A rejection whose reason cannot be turned into text is still reported, by its stack.
it('reports a rejection whose reason has a stack but no usable toString', async () => {
  const code = [
    'const reason = new Error("unprintable");',
    'Object.defineProperty(reason, "toString", { value: 1 });',
    'Object.defineProperty(reason, "stack", { value: "Error: unprintable\\n    at load (client.js:1:1)" });',
    'Promise.reject(reason);',
  ].join('\n')
  const gadget = {
    getUiBundle: async (): Promise<UiBundle> => ({ jsCode: code }),
    connectToGadget: async () => new RpcStub(new (class extends RpcTarget {})()),
  } as unknown as RpcStub<GadgetClient>
  const calls: ReportedGadgetError[][] = []
  const overseer = { reportGadgetErrors: async (_g: unknown, _c: unknown, entries: ReportedGadgetError[]) => {
    calls.push(entries)
  } } as unknown as RpcStub<Overseer>
  const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()

  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(
    <GadgetUI gadget={gadget} overseer={overseer} gadgetId={1} height="200px" onConsoleLog={onConsoleLog} />,
  ))
  await expect.poll(() => onConsoleLog.mock.calls.length).toBeGreaterThan(0)
  await act(async () => root!.unmount())
  root = undefined
  const texts = calls.flat().map(entry => entry.text)
  expect(texts.some(text => text.startsWith('Unhandled promise rejection:') && text.includes('at load (client.js:1:1)')))
    .toBe(true)
})

it("names a bundle module by its file when an import misses one of its exports", async () => {
  const gadget = {
    getUiBundle: async (): Promise<UiBundle> => ({ modules: [
      { path: 'client.js', code: 'import { absent } from "gadget:dependency.js";\nexport const main = () => absent' },
      { path: 'dependency.js', code: 'export const present = 1' },
    ] }),
    connectToGadget: async () => new RpcStub(new (class extends RpcTarget {})()),
  } as unknown as RpcStub<GadgetClient>
  const calls: ReportedGadgetError[][] = []
  const overseer = { reportGadgetErrors: async (_g: unknown, _c: unknown, entries: ReportedGadgetError[]) => {
    calls.push(entries)
  } } as unknown as RpcStub<Overseer>
  const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()

  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(
    <GadgetUI gadget={gadget} overseer={overseer} gadgetId={1} height="200px" onConsoleLog={onConsoleLog} />,
  ))
  await expect.poll(() => onConsoleLog.mock.calls.length).toBe(1)
  await act(async () => root!.unmount())
  root = undefined
  expect(calls).toHaveLength(1)
  expect(calls[0]![0]!.text).toContain("The requested module 'dependency.js' does not provide an export named 'absent'")
})

it('keeps the frames of an error whose message names a data: URL', async () => {
  const code = [
    'function decode() { throw new Error("cannot decode data:image/png;base64,c2VjcmV0") }',
    'setTimeout(() => decode());',
  ].join('\n')
  const gadget = {
    getUiBundle: async (): Promise<UiBundle> => ({ jsCode: code }),
    connectToGadget: async () => new RpcStub(new (class extends RpcTarget {})()),
  } as unknown as RpcStub<GadgetClient>
  const calls: ReportedGadgetError[][] = []
  const overseer = { reportGadgetErrors: async (_g: unknown, _c: unknown, entries: ReportedGadgetError[]) => {
    calls.push(entries)
  } } as unknown as RpcStub<Overseer>
  const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()

  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(
    <GadgetUI gadget={gadget} overseer={overseer} gadgetId={1} height="200px" onConsoleLog={onConsoleLog} />,
  ))
  await expect.poll(() => onConsoleLog.mock.calls.length).toBe(1)
  await act(async () => root!.unmount())
  root = undefined
  expect(calls).toHaveLength(1)
  const text = calls[0]![0]!.text
  expect(text).toContain('Uncaught Error: cannot decode data:…')
  expect(text).not.toContain('c2VjcmV0')
  expect(text).toMatch(/\n {4}at decode \(client\.js:1:\d+\)/)
})
