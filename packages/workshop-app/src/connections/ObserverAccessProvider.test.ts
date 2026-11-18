import { describe, expect, it } from 'vitest'
import { RpcStub, RpcTarget } from 'capnweb'
import type { AuthenticatedApi, ObserverBindingNeed, ObserverConfigCallback } from '@gadgets/workshop-shared/api'
import { withObserverAccess } from './ObserverAccessProvider'

type Given = RpcStub<ObserverConfigCallback> | undefined
const NEEDS: ObserverBindingNeed[] = [{ gatekeeperId: 4, vendorId: 'google', resourceTitle: 'Plan' }]

class FakeGadget extends RpcTarget {
  title() {
    return 'Plan'
  }
}

class FakeOverseer extends RpcTarget {
  constructor(private readonly given: Given[]) {
    super()
  }

  getGadget(_id: number, configure?: Given) {
    this.given.push(configure?.dup())
    return new FakeGadget()
  }

  title() {
    return 'Notes'
  }
}

class FakeApi extends RpcTarget {
  given: Given[] = []

  openWorkspace(_id: string, _key?: string, configure?: Given) {
    this.given.push(configure?.dup())
    return new FakeOverseer(this.given)
  }
}

const asked: string[] = []
const configure = (what: string) => {
  const target = new (class extends RpcTarget {
    configure(needs: ObserverBindingNeed[]) {
      asked.push(`${what}: ${needs.length}`)
      return [{ gatekeeperId: 4, accountId: 9 }]
    }
  })()
  return new RpcStub(target) as unknown as RpcStub<ObserverConfigCallback>
}

describe('an API that asks the user to confirm their access', () => {
  it('gives every open, and every gadget got from one, the way to ask, still pipelined', async () => {
    const fake = new FakeApi()
    const api = withObserverAccess(new RpcStub(fake) as unknown as RpcStub<AuthenticatedApi>, configure) as unknown as RpcStub<FakeApi>
    const overseer = api.openWorkspace('notes')
    expect(await overseer.getGadget(3).title()).toBe('Plan')
    expect(await overseer.title()).toBe('Notes')
    expect(fake.given).toHaveLength(2)
    for (const given of fake.given) expect(await given!.configure(NEEDS)).toEqual([{ gatekeeperId: 4, accountId: 9 }])
    expect(asked).toEqual(['this workspace: 1', 'this gadget: 1'])
    overseer[Symbol.dispose]()
  })
})
