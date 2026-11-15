import { describe, expect, it } from 'vitest'
import type { GatekeeperVendorInfo, ObserverBindingNeed } from '@gadgets/workshop-shared/api'
import { signInServices } from './SharingParts'

const need = (gatekeeperId: number, vendorId: string): ObserverBindingNeed => ({ gatekeeperId, vendorId, resourceTitle: `Connection ${gatekeeperId}` })
const vendor = (id: string, displayName: string, autoProvisionsAccount = false) =>
  ({ id, description: { displayName, autoProvisionsAccount } }) as unknown as GatekeeperVendorInfo

describe('signInServices', () => {
  const vendors = [vendor('google', 'Google'), vendor('scheduler', 'Scheduled Tasks', true), vendor('context', 'Skills', true), vendor('slack', 'Slack')]

  it('names each service that needs a sign-in once, leaving out those that set themselves up', () => {
    expect(signInServices([need(1, 'context'), need(2, 'scheduler'), need(5, 'Google'), need(6, 'google'), need(7, 'slack')], vendors))
      .toEqual(['Google', 'Slack'])
  })

  it('names none when every connection sets itself up, and waits for the services', () => {
    expect(signInServices([need(1, 'context'), need(2, 'scheduler')], vendors)).toEqual([])
    expect(signInServices([need(5, 'google')], undefined)).toBeUndefined()
  })
})
