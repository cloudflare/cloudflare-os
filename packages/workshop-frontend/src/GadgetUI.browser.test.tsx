/* eslint-disable react/react-in-jsx-scope */
// A gadget UI's frame, in Chromium: how the runtime starts each kind of UI, which jsdom can't run.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConsoleLogEvent, GadgetClient, UiBundle } from '@gadgets/workshop-shared/api'
import GadgetUI from './GadgetUI'

class TestGadget extends RpcTarget {
  read() {
    return 'from the server'
  }

  async subscribe(callback: RpcStub<{ update(value: string): void }>) {
    await callback.update('called back')
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

// Runs `bundle` in a frame, returning each console message the UI reports, as one string.
const run = async (bundle: UiBundle) => {
  const logs: string[] = []
  const gadget = {
    getUiBundle: async () => bundle,
    connectToGadget: async () => new RpcStub(new TestGadget()),
  } as unknown as RpcStub<GadgetClient>
  const onConsoleLog = (log: ConsoleLogEvent) => logs.push(log.message.join(' '))
  await act(async () => {
    root.render(<GadgetUI gadget={gadget} height="100px" onConsoleLog={onConsoleLog} />)
  })
  return logs
}

it('calls main() with the gadget stub, setting no globals', async () => {
  const logs = await run({
    modules: [
      {
        path: 'client.js',
        code: `import { RpcTarget } from "capnweb";
import { label } from "gadget:ui/label.js";
export default {
  async main(gadget) {
    console.log("globals:", typeof globalThis.gadget, typeof globalThis.RpcTarget);
    console.log(label + ":", await gadget.read());
    class Callback extends RpcTarget { update(value) { console.log("callback:", value); } }
    await gadget.subscribe(new Callback());
  },
};`,
      },
      { path: 'ui/label.js', code: 'export const label = "read";' },
    ],
  })

  await expect.poll(() => logs).toContain('callback: called back')
  expect(logs).toContain('globals: undefined undefined')
  expect(logs).toContain('read: from the server')
})

it('runs a legacy client.js with the gadget, RpcTarget and RpcStub globals', async () => {
  const logs = await run({
    jsCode: `console.log("globals:", typeof gadget, typeof RpcTarget, typeof RpcStub);
gadget.read().then(value => console.log("read:", value));`,
  })

  await expect.poll(() => logs).toContain('read: from the server')
  expect(logs).toContain('globals: function function function')
})

it('reports a default export with no main()', async () => {
  const logs = await run({ modules: [{ path: 'client.js', code: 'export default {};' }] })

  await expect.poll(() => logs.join('\n')).toMatch(/default export has no main\(\) function/)
})
