import { describe, expect, it } from 'vitest'
import type { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { AccountsSubscriberAdapter } from './accountsSubscriber'

const DESCRIPTION = { displayName: 'acct' } as AccountDescription
const VENDOR = { displayName: 'vendor' } as VendorDescription

type Event = { kind: 'add'; id: number } | { kind: 'remove'; id: number } | { kind: 'ready' }

function recording() {
  const events: Event[] = []
  const subscriber = new AccountsSubscriberAdapter({
    add: ({ id }) => events.push({ kind: 'add', id }),
    remove: (id) => events.push({ kind: 'remove', id }),
    ready: () => events.push({ kind: 'ready' }),
  })
  const add = (id: number) => subscriber.add(id, DESCRIPTION, VENDOR, [], true, 'vendor')
  return { events, subscriber, add }
}

describe('AccountsSubscriberAdapter', () => {
  it('forwards adds, removes, and ready', () => {
    const { events, subscriber, add } = recording()
    add(1)
    add(2)
    subscriber.remove(1)
    subscriber.ready()
    expect(events).toEqual([
      { kind: 'add', id: 1 },
      { kind: 'add', id: 2 },
      { kind: 'remove', id: 1 },
      { kind: 'ready' },
    ])
  })

  // A post-reset catch-up replay (repeat adds + second ready) must be forwarded verbatim — no
  // synthesized removes; reconciliation was deliberately deleted (see the class comment).
  it('forwards a recovery replay (repeat adds + second ready) without synthesizing events', () => {
    const { events, subscriber, add } = recording()
    add(1)
    add(2)
    subscriber.ready()

    add(1)
    add(2)
    subscriber.ready()

    expect(events.filter(e => e.kind === 'remove')).toEqual([])
    expect(events.filter(e => e.kind === 'ready')).toHaveLength(2)
    expect(events.filter(e => e.kind === 'add')).toHaveLength(4)
  })
})
