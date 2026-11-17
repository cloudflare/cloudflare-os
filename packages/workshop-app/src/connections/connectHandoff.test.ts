import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_KEY, openConnectWindow, parsePopupHandoff, readPopupHandoff, ticketFromHandoffFragment } from './connectHandoff'

const TICKET = 'a'.repeat(64)
const NONCE = 'b'.repeat(64)
const FLOW = { url: 'https://service.example/connect', nonce: NONCE }

// A popup as `window.open` returns one: with an opener, storage of its own, and somewhere to be
// sent. `openerWhenSent` is what its opener was as it was sent on its way.
const fakePopup = ({ storage = true } = {}) => {
  const kept = new Map<string, string>()
  const popup = {
    opener: {} as object | null,
    openerWhenSent: undefined as object | null | undefined,
    close: vi.fn<() => void>(),
    sessionStorage: {
      kept,
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => {
        if (!storage) throw new Error('denied')
        kept.set(key, value)
      }),
    },
    location: {
      replace: vi.fn<(url: string) => void>(() => {
        popup.openerWhenSent = popup.opener
      }),
    },
  }
  return popup
}
const opening = (popup: ReturnType<typeof fakePopup> | null) => {
  const open = vi.fn<(url: string, name: string, features: string) => unknown>(() => popup)
  vi.stubGlobal('window', { open })
  return open
}

afterEach(() => vi.unstubAllGlobals())

describe('openConnectWindow', () => {
  it('opens an empty popup, disowns it and gives it the nonce before sending it to the flow', () => {
    const popup = fakePopup()
    const open = opening(popup)

    openConnectWindow(FLOW)

    expect(open).toHaveBeenCalledExactlyOnceWith('', expect.stringMatching(/^gadgets-connect-[0-9a-f]{32}$/), expect.not.stringContaining('noopener'))
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(FLOW.url)
    // No page of the flow ever has the app's window.
    expect(popup.openerWhenSent).toBeNull()
    expect(popup.sessionStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(popup.location.replace.mock.invocationCallOrder[0])
    expect(parsePopupHandoff(popup.sessionStorage.kept.get(HANDOFF_KEY)!)).toEqual({ kind: 'connect', nonce: NONCE })
  })

  it('opens each under a name of its own, and closes the one before', () => {
    const first = fakePopup()
    const open = opening(first)
    openConnectWindow(FLOW)
    open.mockReturnValue(fakePopup())
    openConnectWindow(FLOW)

    expect(open.mock.calls[0][1]).not.toBe(open.mock.calls[1][1])
    expect(first.close).toHaveBeenCalledOnce()
  })

  it('says so when the popup is blocked', () => {
    opening(null)
    expect(() => openConnectWindow(FLOW)).toThrow(/pop-up was blocked/)
  })

  it('starts nothing when the popup cannot keep the nonce', () => {
    const popup = fakePopup({ storage: false })
    opening(popup)

    expect(() => openConnectWindow(FLOW)).toThrow(/could not be finished/)
    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.location.replace).not.toHaveBeenCalled()
  })
})

describe('ticketFromHandoffFragment', () => {
  it('reads a ticket with or without its #, percent-encoded or not', () => {
    expect(ticketFromHandoffFragment(`#${TICKET}`)).toBe(TICKET)
    expect(ticketFromHandoffFragment(TICKET)).toBe(TICKET)
    expect(ticketFromHandoffFragment(`#${TICKET.slice(0, 63)}%61`)).toBe(TICKET)
  })

  it('takes nothing else for one', () => {
    for (const hash of ['', '#', `#${TICKET.slice(1)}`, `#${TICKET}a`, `#${TICKET.toUpperCase()}`, '#%E0%A4%A', `#${TICKET}&x=1`]) {
      expect(ticketFromHandoffFragment(hash)).toBeNull()
    }
  })
})

describe('parsePopupHandoff', () => {
  it('reads a connect and its nonce', () => {
    expect(parsePopupHandoff(JSON.stringify({ kind: 'connect', nonce: NONCE }))).toEqual({ kind: 'connect', nonce: NONCE })
  })

  it('takes nothing else: no record, another kind of flow, or a nonce that is not one', () => {
    for (const raw of [null, '', 'null', '[]', '{', JSON.stringify({ kind: 'login', nonce: NONCE }), JSON.stringify({ kind: 'connect' }), JSON.stringify({ kind: 'connect', nonce: 'b' })]) {
      expect(parsePopupHandoff(raw)).toBeNull()
    }
  })
})

describe('readPopupHandoff', () => {
  it('takes the record as it reads it, so that it is used once', () => {
    const kept = new Map([[HANDOFF_KEY, JSON.stringify({ kind: 'connect', nonce: NONCE })]])
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => kept.get(key) ?? null, removeItem: (key: string) => kept.delete(key) })

    expect(readPopupHandoff()).toEqual({ kind: 'connect', nonce: NONCE })
    expect(readPopupHandoff()).toBeNull()
  })

  it('reads nothing where storage cannot be read', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('denied') } })
    expect(readPopupHandoff()).toBeNull()
  })
})
