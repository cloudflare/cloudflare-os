import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_KEY, openConnectWindow, openDisownedPopup, readPopupHandoff, ticketFromHandoffFragment } from './connectHandoff'

const TICKET = 'a'.repeat(64)
const NONCE = 'b'.repeat(64)

/** A popup as `window.open` returns it: its opener, its own storage, and a location to send it to. */
const fakePopup = () => {
  const store = new Map<string, string>()
  const popup = {
    opener: {} as object | null,
    openerWhenSent: undefined as object | null | undefined,
    storedWhenSent: undefined as string | undefined,
    close: vi.fn<() => void>(),
    sessionStorage: { setItem: vi.fn<(key: string, value: string) => void>((key, value) => void store.set(key, value)) },
    location: {
      replace: vi.fn<(url: string) => void>(() => {
        popup.openerWhenSent = popup.opener
        popup.storedWhenSent = store.get(HANDOFF_KEY)
      }),
    },
  }
  return popup
}

const stubOpen = (popup: object | null) => {
  const open = vi.fn<(url: string, name: string, features: string) => object | null>(() => popup)
  vi.stubGlobal('window', { open })
  return open
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openDisownedPopup', () => {
  it('opens an empty popup under a fresh name, disowns it and gives it the nonce before sending it on', () => {
    const popup = fakePopup()
    const open = stubOpen(popup)
    openDisownedPopup('https://gk.example/connect', { kind: 'connect', nonce: NONCE })
    expect(open).toHaveBeenCalledExactlyOnceWith('', expect.stringMatching(/^gadgets-connect-/), 'popup,width=520,height=680')
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith('https://gk.example/connect')
    expect(popup.openerWhenSent).toBeNull()
    expect(JSON.parse(popup.storedWhenSent!)).toEqual({ kind: 'connect', nonce: NONCE })
  })

  it('gives each popup a name of its own', () => {
    const open = stubOpen(fakePopup())
    openDisownedPopup('https://gk.example/a', { kind: 'connect', nonce: NONCE })
    openDisownedPopup('https://gk.example/b', { kind: 'connect', nonce: NONCE })
    expect(open.mock.calls[0][1]).not.toBe(open.mock.calls[1][1])
  })

  it('says so when the popup is blocked', () => {
    stubOpen(null)
    expect(() => openDisownedPopup('https://gk.example/connect', { kind: 'connect', nonce: NONCE })).toThrow(/blocked/)
  })

  it('closes the popup and starts nothing when its storage is refused', () => {
    const popup = fakePopup()
    popup.sessionStorage.setItem.mockImplementation(() => {
      throw new Error('SecurityError')
    })
    stubOpen(popup)
    expect(() => openDisownedPopup('https://gk.example/connect', { kind: 'connect', nonce: NONCE })).toThrow(/storage/)
    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.location.replace).not.toHaveBeenCalled()
  })
})

describe('openConnectWindow', () => {
  it('closes the popup it opened before', () => {
    const first = fakePopup()
    const second = fakePopup()
    const open = stubOpen(first)
    openConnectWindow({ url: 'https://gk.example/a', nonce: NONCE })
    open.mockReturnValue(second)
    openConnectWindow({ url: 'https://gk.example/b', nonce: NONCE })
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
  })
})

describe('ticketFromHandoffFragment', () => {
  it('reads a ticket with or without its hash, encoded or not', () => {
    expect(ticketFromHandoffFragment(`#${TICKET}`)).toBe(TICKET)
    expect(ticketFromHandoffFragment(TICKET)).toBe(TICKET)
    expect(ticketFromHandoffFragment(`#${encodeURIComponent(TICKET)}`)).toBe(TICKET)
  })

  it('reads nothing that is not 64 lowercase hex characters', () => {
    for (const hash of ['', '#', `#${TICKET.toUpperCase()}`, `#${TICKET}0`, '#%E0%A4%A', `#${'g'.repeat(64)}`]) {
      expect(ticketFromHandoffFragment(hash)).toBeNull()
    }
  })
})

const storage = (value: string | null) => {
  const removeItem = vi.fn<(key: string) => void>()
  return { getItem: () => value, removeItem }
}

describe('readPopupHandoff', () => {
  it('reads the record and spends it', () => {
    const held = storage(JSON.stringify({ kind: 'connect', nonce: NONCE }))
    expect(readPopupHandoff(held)).toEqual({ kind: 'connect', nonce: NONCE })
    expect(held.removeItem).toHaveBeenCalledExactlyOnceWith(HANDOFF_KEY)
  })

  it('reads nothing from a missing, malformed or foreign record', () => {
    for (const value of [null, 'nope', '7', JSON.stringify({ kind: 'other', nonce: NONCE }), JSON.stringify({ kind: 'connect', nonce: 'short' })]) {
      expect(readPopupHandoff(storage(value))).toBeNull()
    }
  })

  it('reads nothing when storage cannot be read', () => {
    expect(readPopupHandoff({ getItem: () => { throw new Error('SecurityError') }, removeItem: () => {} })).toBeNull()
  })
})
