import { describe, expect, it, vi } from 'vitest'
import { latestReads } from './latestReads'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

// Whether `promise` has settled, and how, once every pending callback has run.
const outcome = async (promise: Promise<void>) => {
  let settled: 'pending' | 'resolved' | 'rejected' = 'pending'
  promise.then(() => { settled = 'resolved' }, () => { settled = 'rejected' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return settled
}

describe('latestReads', () => {
  it('applies a lone read and resolves with it', async () => {
    const apply = vi.fn<(value: number) => void>()
    await latestReads(apply)(async () => 48)
    expect(apply).toHaveBeenCalledExactlyOnceWith(48)
  })

  it('rejects with a lone read that fails, applying nothing', async () => {
    const apply = vi.fn<(value: number) => void>()
    await expect(latestReads(apply)(async () => { throw new Error('unavailable') }))
      .rejects.toThrow('unavailable')
    expect(apply).not.toHaveBeenCalled()
  })

  it('applies only the later of two reads, however they answer', async () => {
    const apply = vi.fn<(value: number) => void>()
    const run = latestReads(apply)
    const first = deferred<number>()
    const second = deferred<number>()
    const firstCaller = run(() => first.promise)
    const secondCaller = run(() => second.promise)

    second.resolve(2)
    first.resolve(1)
    await Promise.all([firstCaller, secondCaller])

    expect(apply).toHaveBeenCalledExactlyOnceWith(2)
  })

  // Two settings saved one after the other: the first's read is replaced by the second's.
  it('keeps a replaced caller waiting for the later read, and fails it with that read', async () => {
    const apply = vi.fn<(value: number) => void>()
    const run = latestReads(apply)
    const first = deferred<number>()
    const second = deferred<number>()
    const firstCaller = run(() => first.promise)
    const secondCaller = run(() => second.promise)

    first.resolve(1)
    expect(await outcome(firstCaller)).toBe('pending')

    second.reject(new Error('unavailable'))
    await expect(firstCaller).rejects.toThrow('unavailable')
    await expect(secondCaller).rejects.toThrow('unavailable')
    expect(apply).not.toHaveBeenCalled()
  })

  it('resolves a replaced caller whose own read failed once the later read is applied', async () => {
    const apply = vi.fn<(value: number) => void>()
    const run = latestReads(apply)
    const first = deferred<number>()
    const second = deferred<number>()
    const firstCaller = run(() => first.promise)
    run(() => second.promise)

    first.reject(new Error('unavailable'))
    expect(await outcome(firstCaller)).toBe('pending')

    second.resolve(2)
    await expect(firstCaller).resolves.toBeUndefined()
    expect(apply).toHaveBeenCalledExactlyOnceWith(2)
  })

  // A field whose save started the replaced read is disabled until its caller settles.
  it('settles a replaced caller with the later read even when its own read never answers', async () => {
    const apply = vi.fn<(value: number) => void>()
    const run = latestReads(apply)
    const firstCaller = run(() => new Promise<number>(() => {}))
    const secondCaller = run(async () => 2)

    await expect(firstCaller).resolves.toBeUndefined()
    await expect(secondCaller).resolves.toBeUndefined()
    expect(apply).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('applies nothing from a replaced read that answers after the later one', async () => {
    const apply = vi.fn<(value: number) => void>()
    const run = latestReads(apply)
    const first = deferred<number>()
    const firstCaller = run(() => first.promise)
    await run(async () => 2)
    await firstCaller

    first.resolve(1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(apply).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('follows a chain of replacements to the read that is applied', async () => {
    const apply = vi.fn<(value: number) => void>()
    const run = latestReads(apply)
    const reads = [deferred<number>(), deferred<number>(), deferred<number>()]
    const firstCaller = run(() => reads[0]!.promise)
    run(() => reads[1]!.promise)

    reads[0]!.resolve(1)
    await outcome(firstCaller)
    run(() => reads[2]!.promise)
    reads[1]!.resolve(2)
    expect(await outcome(firstCaller)).toBe('pending')

    reads[2]!.resolve(3)
    await expect(firstCaller).resolves.toBeUndefined()
    expect(apply).toHaveBeenCalledExactlyOnceWith(3)
  })
})
