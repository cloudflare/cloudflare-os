import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GatekeeperUserSelection, GatekeeperUserSelectionReceiver } from '@gadgets/workshop-shared/gatekeeper'
import { PersonPicking, UserPickers, type Minting, type OpenPicker } from './UserPicker'

const selectionOf = (userId: string): GatekeeperUserSelection => ({ ticket: `ticket:${userId}`, profile: { displayName: `${userId} (as named)` } })

// What `receive` resolves with, or the app's refusal, one call at a time.
const receiverOf = (receive: (selection: GatekeeperUserSelection) => Promise<void> = async () => {}) => {
  const received: GatekeeperUserSelection[] = []
  const receiver = {
    disposed: false,
    receive: (selection: GatekeeperUserSelection) => {
      received.push(selection)
      return Object.assign(receive(selection), { [Symbol.dispose]() {} })
    },
    [Symbol.dispose]() {
      receiver.disposed = true
    },
  }
  return { receiver: receiver as unknown as RpcStub<GatekeeperUserSelectionReceiver>, received, state: receiver }
}

const minted = (value: Promise<GatekeeperUserSelection | null>): Minting => Object.assign(value, { [Symbol.dispose]: vi.fn<() => void>() })
const mintOf = (selection: (userId: string) => GatekeeperUserSelection | null = selectionOf) => vi.fn<(userId: string) => Minting>((userId) => minted(Promise.resolve(selection(userId))))

const openOne = (pickers: UserPickers, receiver: RpcStub<GatekeeperUserSelectionReceiver>) => {
  const closed = pickers.open(receiver)
  return { closed, picker: pickers.getSnapshot() as OpenPicker }
}

describe('UserPickers', () => {
  it('has one open at a time, and lets go of its receiver as it closes', async () => {
    const pickers = new UserPickers()
    const { receiver, state } = receiverOf()
    const { closed, picker } = openOne(pickers, receiver)
    expect(() => pickers.open(receiverOf().receiver)).toThrow('already open')
    pickers.cancel()
    await closed
    expect(state.disposed).toBe(true)
    expect(pickers.getSnapshot()).toBeUndefined()
    await expect(picker.deliver(selectionOf('grace'))).rejects.toThrow('cancelled')
    // Another is opened once it has closed, which a late close of the first leaves open.
    const next = openOne(pickers, receiverOf().receiver)
    picker.close()
    expect(pickers.getSnapshot()).toBe(next.picker)
    expect(next.picker.id).not.toBe(picker.id)
  })
})

describe('PersonPicking', () => {
  it('makes a ticket for each person chosen, and adds them by the name the Workshop gave once the app takes them', async () => {
    const { receiver, received } = receiverOf()
    const { picker } = openOne(new UserPickers(), receiver)
    const mint = mintOf()
    const picking = new PersonPicking(picker, mint)
    await picking.pick('grace', 'Grace Hopper')
    expect(mint).toHaveBeenCalledWith('grace')
    expect(received).toEqual([selectionOf('grace')])
    expect(picking.getSnapshot()).toMatchObject({ picked: [{ id: 'grace', name: 'grace (as named)' }], pending: undefined, announcement: 'Added grace (as named)' })
    await picking.pick('grace', 'Grace Hopper')
    expect(mint).toHaveBeenCalledTimes(1)
    expect(picking.getSnapshot().notice).toBe('Grace Hopper is added already.')
  })

  it('says what the app refused, in its own words, and leaves them out', async () => {
    const { receiver } = receiverOf(async () => {
      throw new Error('They already have access.')
    })
    const { picker } = openOne(new UserPickers(), receiver)
    const picking = new PersonPicking(picker, mintOf())
    await picking.pick('grace', 'Grace Hopper')
    expect(picking.getSnapshot()).toMatchObject({ picked: [], pending: undefined, notice: 'Grace Hopper: They already have access.' })
  })

  it('says so of someone who can no longer be chosen, without telling the app', async () => {
    const { receiver, received } = receiverOf()
    const { picker } = openOne(new UserPickers(), receiver)
    const picking = new PersonPicking(picker, mintOf(() => null))
    await picking.pick('nobody', 'nobody')
    expect(received).toEqual([])
    expect(picking.getSnapshot().notice).toBe('nobody can no longer be chosen. Try searching again.')
  })

  it('takes one person at a time', async () => {
    const { picker } = openOne(new UserPickers(), receiverOf().receiver)
    let finish!: (selection: GatekeeperUserSelection) => void
    const mint = vi.fn<(userId: string) => Minting>(() => minted(new Promise((resolve) => {
      finish = resolve
    })))
    const picking = new PersonPicking(picker, mint)
    const first = picking.pick('grace', 'Grace Hopper')
    void picking.pick('alan', 'Alan Turing')
    expect(mint).toHaveBeenCalledTimes(1)
    expect(picking.getSnapshot().pending).toBe('grace')
    finish(selectionOf('grace'))
    await first
    expect(picking.getSnapshot().picked.map(({ id }) => id)).toEqual(['grace'])
  })

  it('closes on Done once whoever is being added is in, so that the app has everyone chosen', async () => {
    let accept!: () => void
    const { receiver } = receiverOf(() => new Promise<void>((resolve) => {
      accept = resolve
    }))
    const pickers = new UserPickers()
    const { closed, picker } = openOne(pickers, receiver)
    const picking = new PersonPicking(picker, mintOf())
    const adding = picking.pick('grace', 'Grace Hopper')
    picking.close()
    expect(picking.getSnapshot().closing).toBe(true)
    expect(picker.closed).toBe(false)
    await vi.waitFor(() => expect(accept).toBeTypeOf('function'))
    accept()
    await adding
    await closed
    expect(picker.closed).toBe(true)
  })

  it('stays open after Done where the one being added failed, so that it is seen', async () => {
    const { receiver } = receiverOf(async () => {
      throw new Error('No room.')
    })
    const { picker } = openOne(new UserPickers(), receiver)
    const picking = new PersonPicking(picker, mintOf())
    const adding = picking.pick('grace', 'Grace Hopper')
    picking.close()
    await adding
    expect(picker.closed).toBe(false)
    expect(picking.getSnapshot()).toMatchObject({ closing: false, notice: 'Grace Hopper: No room.' })
  })

  it('stops waiting when asked, letting go of the ticket being made', async () => {
    const pickers = new UserPickers()
    const { closed, picker } = openOne(pickers, receiverOf().receiver)
    const minting = minted(new Promise(() => {}))
    const picking = new PersonPicking(picker, () => minting)
    void picking.pick('grace', 'Grace Hopper')
    picking.close()
    picking.cancel()
    await closed
    expect(minting[Symbol.dispose]).toHaveBeenCalled()
    expect(pickers.getSnapshot()).toBeUndefined()
  })
})
