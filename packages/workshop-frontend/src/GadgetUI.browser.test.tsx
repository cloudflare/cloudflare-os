/* eslint-disable react/react-in-jsx-scope */
// A gadget UI's frame, in Chromium: how the runtime starts each kind of UI, which jsdom can't run.

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_FOCUS_ANCHOR_LENGTH,
  MAX_FOCUS_CONTEXT_LENGTH,
  MAX_FOCUS_LABEL_LENGTH,
  type ConsoleLogEvent,
  type GadgetClient,
  type UiBundle,
  type WorkpieceId,
} from '@gadgets/workshop-shared/api'
import GadgetUI, { type GadgetUIFocus } from './GadgetUI'
import { FOCUS_URL_WRITE_DELAY_MS, useFocusUrl } from './features/gadget-focus/useFocusUrl'

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
const run = async (bundle: UiBundle, onIframeEscape?: () => void, renderMode?: 'snapshot') => {
  const logs: string[] = []
  const gadget = {
    getUiBundle: async () => bundle,
    connectToGadget: async () => new RpcStub(new TestGadget()),
  } as unknown as RpcStub<GadgetClient>
  const onConsoleLog = (log: ConsoleLogEvent) => logs.push(log.message.join(' '))
  await act(async () => {
    root.render(
      <GadgetUI gadget={gadget} height="100px" renderMode={renderMode} onConsoleLog={onConsoleLog} onIframeEscape={onIframeEscape} />,
    )
  })
  return logs
}

it('calls main() with the gadget and host stubs, setting no globals', async () => {
  const logs = await run({
    modules: [
      {
        path: 'client.js',
        code: `import { RpcTarget } from "capnweb";
import { label } from "gadget:ui/label.js";
export default {
  async main(gadget, host) {
    console.log("globals:", typeof globalThis.gadget, typeof globalThis.RpcTarget);
    console.log("host:", typeof host);
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
  // A stub, which is a callable proxy.
  expect(logs).toContain('host: function')
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

it('sets gadgetRenderMode before any module evaluates for a snapshot, and leaves it unset live', async () => {
  const bundle = (label: string): UiBundle => ({
    modules: [{ path: 'client.js', code: `console.log("${label}:", String(globalThis.gadgetRenderMode));
export default { main() {} };` }],
  })
  const snapshot = await run(bundle('snapshot'), undefined, 'snapshot')
  await expect.poll(() => snapshot).toContain('snapshot: snapshot')
  // Each run is a fresh frame, as a different view would mount.
  await act(async () => root.render(null))
  const legacy = await run({ jsCode: 'console.log("legacy:", String(globalThis.gadgetRenderMode));' },
    undefined, 'snapshot')
  await expect.poll(() => legacy).toContain('legacy: snapshot')
  await act(async () => root.render(null))
  const live = await run(bundle('live'))
  await expect.poll(() => live).toContain('live: undefined')
})

it('reports a default export with no main()', async () => {
  const logs = await run({ modules: [{ path: 'client.js', code: 'export default {};' }] })

  await expect.poll(() => logs.join('\n')).toMatch(/default export has no main\(\) function/)
})

it('forwards Escape pressed in the frame to the page', async () => {
  let escapes = 0
  await run({
    jsCode: `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));`,
  }, () => escapes++)

  await expect.poll(() => escapes).toBe(1)
})

// ─── focus ────────────────────────────────────────────────────────────────────

// Drives one frame's UI from the test. The UI hands one to the gadget's server as it starts.
interface FrameControl {
  report(focus: unknown): void
  register(): Promise<void>
}

const FOCUS_UI: UiBundle = {
  modules: [{
    path: 'client.js',
    code: `import { RpcTarget } from "capnweb";
export default {
  async main(gadget, host) {
    class Control extends RpcTarget {
      report(focus) { return host.reportFocus(focus); }
      register() { return host.onNavigate(anchor => gadget.navigate(anchor)); }
    }
    await gadget.attach(new Control());
  },
};`,
  }],
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

// What the frames of one GadgetUI did, in order, as seen by its parent and the gadget's server.
class FocusRecorder {
  readonly frames: RpcStub<FrameControl>[] = []
  readonly events: string[] = []
  readonly logs: string[] = []
  // Each navigate call a frame made, settled by the test.
  readonly navigations: { anchor: string; resolve: (result: boolean) => void }[] = []
  // What latestAnchor() gives, when a test has a report still on its way to the anchor.
  latest: { anchor: string | undefined } | undefined

  focus(anchor: string | undefined, navigation: number): GadgetUIFocus {
    return {
      anchor,
      navigation,
      latestAnchor: () => this.latest ? this.latest.anchor : anchor,
      onFocusChange: focus => this.events.push(`change ${JSON.stringify(focus)}`),
      onFocusReset: () => this.events.push('reset'),
    }
  }

  dispose() {
    for (const frame of this.frames) frame[Symbol.dispose]()
  }
}

class FocusGadget extends RpcTarget {
  readonly #recorder: FocusRecorder

  constructor(recorder: FocusRecorder) {
    super()
    this.#recorder = recorder
  }

  attach(control: RpcStub<FrameControl>) {
    this.#recorder.frames.push(control.dup())
  }

  navigate(anchor: string) {
    const { promise, resolve } = deferred<boolean>()
    this.#recorder.events.push(`navigate ${anchor}`)
    this.#recorder.navigations.push({ anchor, resolve })
    return promise
  }
}

// Long enough for a call to cross the frame's session and back, so that one that hasn't happened by
// then isn't merely in flight.
const settle = () => new Promise(resolve => setTimeout(resolve, 100))

describe('focus', () => {
  let recorder: FocusRecorder

  beforeEach(() => {
    recorder = new FocusRecorder()
    shown = undefined
  })

  afterEach(() => {
    recorder.dispose()
  })

  const focusGadget = (connectToGadget = async () => new RpcStub(new FocusGadget(recorder))) => ({
    getUiBundle: async () => FOCUS_UI,
    connectToGadget,
  } as unknown as RpcStub<GadgetClient>)

  // Renders (or rerenders) a GadgetUI with the focus UI, the anchor and the reload trigger given.
  // A changed anchor is one set elsewhere, unless it is the frame's `own` report coming back.
  let shown: { anchor: string | undefined; navigation: number } | undefined
  const show = async (
    gadget: RpcStub<GadgetClient>,
    anchor: string | undefined,
    reloadTrigger = 0,
    change: 'elsewhere' | 'own' = 'elsewhere',
  ) => {
    const navigation = shown === undefined
      ? 0
      : shown.navigation + (shown.anchor !== anchor && change === 'elsewhere' ? 1 : 0)
    shown = { anchor, navigation }
    await act(async () => {
      root.render(
        <GadgetUI
          gadget={gadget}
          height="100px"
          reloadTrigger={reloadTrigger}
          focus={recorder.focus(anchor, navigation)}
          onConsoleLog={log => recorder.logs.push(log.message.join(' '))}
        />,
      )
    })
  }

  const frame = async (index: number) => {
    await expect.poll(() => recorder.frames.length).toBeGreaterThan(index)
    return recorder.frames[index]
  }

  it('passes a report on, with only the focus fields', async () => {
    await show(focusGadget(), undefined)
    await (await frame(0)).report({ anchor: 'cell/B7', label: 'Q3 › B7', context: '1,204', extra: true })

    expect(recorder.events).toEqual([
      'change {"anchor":"cell/B7","label":"Q3 › B7","context":"1,204"}',
    ])
  })

  it('navigates a registering frame to the anchor, resolving only once navigate has', async () => {
    await show(focusGadget(), 'cell/B7')
    let registered = false
    const registration = (await frame(0)).register().then(() => { registered = true })

    await expect.poll(() => recorder.navigations.map(n => n.anchor)).toEqual(['cell/B7'])
    await settle()
    expect(registered).toBe(false)

    recorder.navigations[0].resolve(true)
    await registration
    expect(recorder.events).toEqual(['navigate cell/B7'])
  })

  it('keeps the callback past its registration, for a later anchor', async () => {
    const gadget = focusGadget()
    await show(gadget, undefined)
    await (await frame(0)).register()

    await show(gadget, 'cell/C1')

    await expect.poll(() => recorder.events).toEqual(['reset', 'navigate cell/C1'])
  })

  it("doesn't send the frame to its own report as the anchor changes to it", async () => {
    const gadget = focusGadget()
    await show(gadget, undefined)
    const control = await frame(0)
    await control.register()
    await control.report({ anchor: 'cell/B7', label: 'B7' })

    await show(gadget, 'cell/B7', 0, 'own')
    await settle()
    expect(recorder.events).toEqual(['change {"anchor":"cell/B7","label":"B7"}'])

    await show(gadget, 'cell/C1')
    await expect.poll(() => recorder.events.at(-1)).toBe('navigate cell/C1')
  })

  it('resets before sending the frame to a spot it did not report, which it may never report', async () => {
    const gadget = focusGadget()
    await show(gadget, undefined)
    const control = await frame(0)
    await control.register()
    await control.report({ anchor: 'cell/B7', label: 'B7' })
    await show(gadget, 'cell/B7', 0, 'own')

    await show(gadget, 'cell/C1')
    await expect.poll(() => recorder.navigations.length).toBe(1)
    recorder.navigations[0].resolve(true)
    await settle()

    expect(recorder.events).toEqual(['change {"anchor":"cell/B7","label":"B7"}', 'reset', 'navigate cell/C1'])
  })

  it('resets on a code reload, then sends the new frame to the anchor', async () => {
    const gadget = focusGadget()
    await show(gadget, 'cell/B7')
    const registration = (await frame(0)).register()
    await expect.poll(() => recorder.navigations.length).toBe(1)
    recorder.navigations[0].resolve(true)
    await registration

    await show(gadget, 'cell/B7', 1)
    const reloaded = (await frame(1)).register()
    await expect.poll(() => recorder.navigations.length).toBe(2)
    recorder.navigations[1].resolve(true)
    await reloaded

    expect(recorder.events).toEqual(['navigate cell/B7', 'reset', 'navigate cell/B7'])
  })

  it('sends the frame on only once its navigate call settles, skipping targets replaced meanwhile', async () => {
    const gadget = focusGadget()
    await show(gadget, undefined)
    await (await frame(0)).register()

    await show(gadget, 'cell/B7')
    await expect.poll(() => recorder.navigations.length).toBe(1)
    await show(gadget, 'cell/C1')
    await show(gadget, 'cell/D4')
    await settle()
    expect(recorder.navigations.map(n => n.anchor)).toEqual(['cell/B7'])

    recorder.navigations[0].resolve(true)
    await expect.poll(() => recorder.navigations.map(n => n.anchor)).toEqual(['cell/B7', 'cell/D4'])
  })

  it("drops a queued target once the anchor is removed, though the call before it is running", async () => {
    const gadget = focusGadget()
    await show(gadget, undefined)
    await (await frame(0)).register()

    await show(gadget, 'cell/B7')
    await expect.poll(() => recorder.navigations.length).toBe(1)
    await show(gadget, 'cell/C1')
    await show(gadget, undefined)
    recorder.navigations[0].resolve(true)
    await settle()

    expect(recorder.navigations.map(n => n.anchor)).toEqual(['cell/B7'])
  })

  it('keeps reports once the anchor is removed, with no call left waiting behind the running one', async () => {
    const gadget = focusGadget()
    await show(gadget, undefined)
    const control = await frame(0)
    await control.register()

    await show(gadget, 'cell/B7')
    await expect.poll(() => recorder.navigations.length).toBe(1)
    await show(gadget, 'cell/C1')
    await show(gadget, undefined)
    await control.report({ anchor: 'cell/D4', label: 'D4' })

    expect(recorder.events.filter(e => e.startsWith('change'))).toEqual([
      'change {"anchor":"cell/D4","label":"D4"}',
    ])
  })

  it('ignores reports from a navigate call a newer target has replaced', async () => {
    const gadget = focusGadget()
    await show(gadget, undefined)
    const control = await frame(0)
    await control.register()

    await show(gadget, 'cell/B7')
    await expect.poll(() => recorder.navigations.length).toBe(1)
    await show(gadget, 'cell/C1')
    await control.report({ anchor: 'cell/B7', label: 'B7' })
    recorder.navigations[0].resolve(true)
    await expect.poll(() => recorder.navigations.length).toBe(2)
    await control.report({ anchor: 'cell/C1', label: 'C1' })

    expect(recorder.events.filter(e => e.startsWith('change'))).toEqual([
      'change {"anchor":"cell/C1","label":"C1"}',
    ])
  })

  it('sends a frame reloaded before its last report reached the anchor to that report', async () => {
    const gadget = focusGadget()
    await show(gadget, 'cell/B7')
    const control = await frame(0)
    const registration = control.register()
    await expect.poll(() => recorder.navigations.length).toBe(1)
    recorder.navigations[0].resolve(true)
    await registration
    await control.report({ anchor: 'cell/C1', label: 'C1' })
    recorder.latest = { anchor: 'cell/C1' }

    await show(gadget, 'cell/B7', 1)
    void (await frame(1)).register()

    await expect.poll(() => recorder.navigations.map(n => n.anchor)).toEqual(['cell/B7', 'cell/C1'])
  })

  it('resets when a failed reconnect reloads the frame, then sends the new frame to the anchor', async () => {
    await show(focusGadget(), 'cell/B7')
    const registration = (await frame(0)).register()
    await expect.poll(() => recorder.navigations.length).toBe(1)
    recorder.navigations[0].resolve(true)
    await registration

    // The reconnect fails, and the reloaded frame's handshake succeeds.
    let connections = 0
    await show(focusGadget(async () => {
      if (connections++ === 0) throw new Error('connection lost')
      return new RpcStub(new FocusGadget(recorder))
    }), 'cell/B7')
    const reloaded = (await frame(1)).register()
    await expect.poll(() => recorder.navigations.length).toBe(2)
    recorder.navigations[1].resolve(true)
    await reloaded

    expect(recorder.events).toEqual(['navigate cell/B7', 'reset', 'navigate cell/B7'])
  })

  it('clears an anchor that no longer resolves', async () => {
    await show(focusGadget(), 'gone')
    const registration = (await frame(0)).register()
    await expect.poll(() => recorder.navigations.length).toBe(1)
    recorder.navigations[0].resolve(false)
    await registration

    expect(recorder.events).toEqual(['navigate gone', 'change null'])
  })

  it('keeps a report made while navigate was pending', async () => {
    await show(focusGadget(), 'gone')
    const control = await frame(0)
    const registration = control.register()
    await expect.poll(() => recorder.navigations.length).toBe(1)
    await control.report({ anchor: 'cell/C1', label: 'C1' })
    recorder.navigations[0].resolve(false)
    await registration

    expect(recorder.events).toEqual(['navigate gone', 'change {"anchor":"cell/C1","label":"C1"}'])
  })

  it('ignores a failure superseded by a newer navigate', async () => {
    const gadget = focusGadget()
    await show(gadget, 'gone')
    const registration = (await frame(0)).register()
    await expect.poll(() => recorder.navigations.length).toBe(1)

    await show(gadget, 'cell/C1')
    recorder.navigations[0].resolve(false)
    await registration
    await expect.poll(() => recorder.navigations.length).toBe(2)
    recorder.navigations[1].resolve(true)
    await settle()

    expect(recorder.events).toEqual(['navigate gone', 'reset', 'navigate cell/C1'])
  })

  it('ignores a failure from a callback the frame has since replaced', async () => {
    await show(focusGadget(), 'cell/B7')
    const control = await frame(0)
    const first = control.register()
    await expect.poll(() => recorder.navigations.length).toBe(1)

    const second = control.register()
    await settle()
    recorder.navigations[0].resolve(false)
    await first
    await expect.poll(() => recorder.navigations.length).toBe(2)
    recorder.navigations[1].resolve(true)
    await second

    expect(recorder.events).toEqual(['navigate cell/B7', 'navigate cell/B7'])
  })

  it('sends the frame back to a spot it reported after sending it elsewhere', async () => {
    const gadget = focusGadget()
    await show(gadget, undefined)
    const control = await frame(0)
    await control.register()
    await control.report({ anchor: 'cell/B7', label: 'B7' })
    await show(gadget, 'cell/B7', 0, 'own')

    await show(gadget, 'gone')
    await expect.poll(() => recorder.navigations.length).toBe(1)
    await show(gadget, 'cell/B7')
    // The return supersedes the failure.
    recorder.navigations[0].resolve(false)
    await expect.poll(() => recorder.navigations.length).toBe(2)
    recorder.navigations[1].resolve(true)
    await settle()

    expect(recorder.events).toEqual([
      'change {"anchor":"cell/B7","label":"B7"}', 'reset', 'navigate gone', 'reset', 'navigate cell/B7',
    ])
  })

  it('sends the frame back and forth between spots, though it reports each one it is sent to', async () => {
    const gadget = focusGadget()
    await show(gadget, undefined)
    const control = await frame(0)
    await control.register()

    // As a chip clicked in each of two messages in turn would, with the gadget reporting from
    // navigate as it is asked to.
    const anchors = ['cell/B7', 'cell/C1', 'cell/B7', 'cell/C1']
    for (const [index, anchor] of anchors.entries()) {
      await show(gadget, anchor)
      await expect.poll(() => recorder.navigations.length).toBe(index + 1)
      recorder.navigations[index].resolve(true)
      await control.report({ anchor, label: anchor })
    }

    expect(recorder.navigations.map(n => n.anchor)).toEqual(anchors)
  })

  it('sends the frame to a spot a link names, though it reported and left it before the URL showed it', async () => {
    const gadget = focusGadget()
    let search: { w?: WorkpieceId; at?: string } = { w: 1 }
    let setSearch!: (changes: { w?: WorkpieceId; at: string | undefined }) => void
    // The URL, with the hook that keeps the frame's focus in it.
    const Url = () => {
      const [, rerender] = useState(0)
      setSearch = changes => {
        search = { ...search, ...changes }
        act(() => rerender(count => count + 1))
      }
      const focus = useFocusUrl({
        workspaceId: 'trips',
        urlWorkpieceId: search.w ?? null,
        at: search.at,
        selectedGadgetId: 1,
        selectionSettled: true,
        replaceSearch: setSearch,
      })
      return <GadgetUI gadget={gadget} height="100px" focus={focus} />
    }
    await act(async () => root.render(<Url />))
    const control = await frame(0)
    await control.register()

    // The first is written at once, and holds back the rest.
    await control.report({ anchor: 'cell/A1', label: 'A1' })
    await control.report({ anchor: 'cell/B7', label: 'B7' })
    await control.report({ anchor: 'cell/C1', label: 'C1' })
    expect(search.at).toBe('cell/A1')
    setSearch({ at: 'cell/B7' })

    await expect.poll(() => recorder.navigations.map(n => n.anchor)).toEqual(['cell/B7'])
    recorder.navigations[0].resolve(true)
    await new Promise(resolve => setTimeout(resolve, FOCUS_URL_WRITE_DELAY_MS + 100))
    expect(search.at).toBe('cell/B7')
  })

  it("ignores a replaced frame's pending navigate failing as its session closes", async () => {
    const gadget = focusGadget()
    await show(gadget, 'cell/B7')
    const registration = (await frame(0)).register()
    await expect.poll(() => recorder.navigations.length).toBe(1)

    await show(gadget, 'cell/B7', 1)
    await expect(registration).rejects.toBeDefined()
    const reloaded = (await frame(1)).register()
    await expect.poll(() => recorder.navigations.length).toBe(2)
    recorder.navigations[1].resolve(true)
    await reloaded
    await settle()

    expect(recorder.events).toEqual(['navigate cell/B7', 'reset', 'navigate cell/B7'])
  })

  it('drops a malformed or oversized report, telling the console why', async () => {
    await show(focusGadget(), undefined)
    const control = await frame(0)
    await control.report('cell/B7')
    await control.report({ anchor: 7, label: 'B7' })
    await control.report({ anchor: 'cell/B7' })
    await control.report({ anchor: 'cell/B7', label: 'B7', context: 7 })
    await control.report({ anchor: 'a'.repeat(MAX_FOCUS_ANCHOR_LENGTH + 1), label: 'B7' })
    await control.report({ anchor: 'cell/B7', label: 'l'.repeat(MAX_FOCUS_LABEL_LENGTH + 1) })
    await control.report({ anchor: 'cell/B7', label: 'B7', context: 'c'.repeat(MAX_FOCUS_CONTEXT_LENGTH + 1) })
    expect(recorder.events).toEqual([])
    expect(recorder.logs.filter(log => log.startsWith('host.reportFocus() ignored'))).toHaveLength(7)

    const atLimits = {
      anchor: 'a'.repeat(MAX_FOCUS_ANCHOR_LENGTH),
      label: 'l'.repeat(MAX_FOCUS_LABEL_LENGTH),
      context: 'c'.repeat(MAX_FOCUS_CONTEXT_LENGTH),
    }
    await control.report(atLimits)
    expect(recorder.events).toEqual([`change ${JSON.stringify(atLimits)}`])
  })
})
