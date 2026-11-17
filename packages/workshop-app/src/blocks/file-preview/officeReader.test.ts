import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OfficeReadRequest } from './officeReads'

/** A worker that answers when told to, recording what it was asked and whether it was stopped. */
class FakeWorker {
  static all: FakeWorker[] = []
  posted: OfficeReadRequest[] = []
  terminated = false
  #listener: ((event: { data: unknown }) => void) | undefined
  constructor() {
    FakeWorker.all.push(this)
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === 'message') this.#listener = listener
  }
  postMessage(request: OfficeReadRequest) {
    this.posted.push(request)
  }
  terminate() {
    this.terminated = true
  }
  answer(result: unknown) {
    const request = this.posted.at(-1)!
    this.#listener?.({ data: { id: request.id, result } })
  }
}

const live = () => FakeWorker.all.filter(({ terminated }) => !terminated)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  FakeWorker.all = []
})

describe('readOffice in the viewer lane', () => {
  it('reads a file just opened first, then finishes the one it interrupted, failing neither', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const { readOffice } = await import('./officeReader')
    const first = new Uint8Array([1])
    const second = new Uint8Array([2])

    const a = readOffice('document', first, {}, { lane: 'viewer' })
    const b = readOffice('document', second, {}, { lane: 'viewer' })

    // The first was stopped for the second, which is read now.
    expect(FakeWorker.all[0].terminated).toBe(true)
    expect(live()[0].posted.map(({ bytes }) => bytes)).toEqual([second])
    live()[0].answer('second read')
    await expect(b).resolves.toBe('second read')

    // Then the first is read again from the start, and resolves too.
    expect(live()[0].posted.at(-1)!.bytes).toBe(first)
    live()[0].answer('first read')
    await expect(a).resolves.toBe('first read')
  })
})
