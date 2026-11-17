import { describe, expect, it } from 'vitest'
import { OwnAvatar } from './OwnAvatar'

const PICTURE = new Uint8Array([1, 2, 3])
const OTHER = new Uint8Array([4, 5])

/** A read that is answered when the test says. */
const pending = () => {
  let resolve!: (bytes: Uint8Array | null) => void
  let reject!: (error: Error) => void
  let calls = 0
  const promise = new Promise<Uint8Array | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { read: () => (calls++, promise), resolve, reject, calls: () => calls }
}

const settled = () => new Promise((resolve) => setTimeout(resolve))

describe('OwnAvatar', () => {
  it('reads a user’s picture once, whoever asks', async () => {
    const avatar = new OwnAvatar()
    const first = pending()
    const second = pending()
    avatar.load('ada', first.read)
    avatar.load('ada', second.read)
    first.resolve(PICTURE)
    await settled()
    expect(second.calls()).toBe(0)
    expect(avatar.getSnapshot()).toEqual({ userId: 'ada', bytes: PICTURE })
  })

  it('has no picture for a user who has set none', async () => {
    const avatar = new OwnAvatar()
    avatar.load('ada', async () => null)
    await settled()
    expect(avatar.getSnapshot()).toEqual({ userId: 'ada', bytes: undefined })
  })

  it('keeps a picture chosen while the old one was still being read', async () => {
    const avatar = new OwnAvatar()
    const reading = pending()
    avatar.load('ada', reading.read)
    avatar.set('ada', OTHER)
    reading.resolve(PICTURE)
    await settled()
    expect(avatar.getSnapshot()?.bytes).toBe(OTHER)
  })

  it('does not show one user the picture read for another', async () => {
    const avatar = new OwnAvatar()
    const ada = pending()
    avatar.load('ada', ada.read)
    avatar.load('grace', async () => OTHER)
    ada.resolve(PICTURE)
    await settled()
    expect(avatar.getSnapshot()).toEqual({ userId: 'grace', bytes: OTHER })
  })

  it('asks again for a picture that could not be read', async () => {
    const avatar = new OwnAvatar()
    const failing = pending()
    avatar.load('ada', failing.read)
    failing.reject(new Error('offline'))
    await settled()
    avatar.load('ada', async () => PICTURE)
    await settled()
    expect(avatar.getSnapshot()?.bytes).toBe(PICTURE)
  })

  it('tells whoever is listening of a new picture', () => {
    const avatar = new OwnAvatar()
    let told = 0
    avatar.subscribe(() => told++)
    avatar.set('ada', PICTURE)
    expect(told).toBe(1)
  })
})
