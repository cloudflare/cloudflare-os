import { describe, expect, it, vi } from 'vitest'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { ConnectedAccount } from '@/connections/connectionList'
import { finishOnboarding, onboardingChoicesOf, onboardingSteps, type OnboardingApi } from './onboardingSteps'

const vendor = (id: string, displayName: string, rest: Partial<GatekeeperVendorInfo['description']> = {}): GatekeeperVendorInfo => ({
  id,
  description: { displayName, url: `https://${id}.example`, ...rest },
  supportedResources: [],
})

const account = (of: GatekeeperVendorInfo): ConnectedAccount => ({
  id: 1,
  vendorId: of.id,
  vendor: of.description,
  description: { avatar: { url: '' } },
  supportedResources: [],
  credentialsValid: true,
})

const SLACK = vendor('slack', 'Slack', { tagline: 'Messages' })
const GITHUB = vendor('github', 'GitHub')
const WIKI = { ...vendor('wiki', 'Wiki'), unavailable: true }
const CONTEXT = vendor('context', 'Context Library', { autoProvisionsAccount: true })
const SCHEDULER = vendor('scheduler', 'Scheduled Tasks', { autoProvisionsAccount: true })

describe('onboardingChoicesOf', () => {
  it('offers each service that can be signed in to by name, saying which are connected', () => {
    const { services } = onboardingChoicesOf({ vendors: [SLACK, GITHUB, WIKI, CONTEXT], addable: [], accounts: [account(SLACK)] })
    expect(services.map(({ name, connected }) => [name, connected])).toEqual([['GitHub', false], ['Slack', true]])
    expect(services[1]).toMatchObject({ vendorId: 'slack', tagline: 'Messages' })
  })

  it('offers the tools that are added as they are, but for those the user has', () => {
    const { tools } = onboardingChoicesOf({ vendors: [], addable: [SCHEDULER, CONTEXT, SLACK], accounts: [account(SCHEDULER)] })
    expect(tools.map(({ vendorId }) => vendorId)).toEqual(['context'])
  })
})

describe('onboardingSteps', () => {
  it('has the connections while there may be something to offer', () => {
    expect(onboardingSteps({ status: 'loading' })).toEqual(['profile', 'connections'])
    expect(onboardingSteps({ status: 'failed', message: 'offline', retry: () => {} })).toEqual(['profile', 'connections'])
    expect(onboardingSteps({ status: 'ready', services: [], tools: [{ vendorId: 'context', name: 'Context Library' }] })).toEqual(['profile', 'connections'])
  })

  it('leaves them out once there is nothing to offer', () => {
    expect(onboardingSteps({ status: 'ready', services: [], tools: [] })).toEqual(['profile'])
  })
})

const fakeApi = (failing: string[] = []) => {
  const calls: string[] = []
  const api: OnboardingApi = {
    setOwnDisplayName: vi.fn<OnboardingApi['setOwnDisplayName']>(async (name: string) => void calls.push(`name ${name}`)),
    provisionAmbientAccount: vi.fn<OnboardingApi['provisionAmbientAccount']>(async (id: string) => {
      if (failing.includes(id)) throw new Error('disabled')
      calls.push(`provision ${id}`)
    }),
    completeOnboarding: vi.fn<OnboardingApi['completeOnboarding']>(async () => void calls.push('complete')),
  }
  return { api, calls }
}

const TOOLS = [{ vendorId: 'context', name: 'Context Library' }, { vendorId: 'scheduler', name: 'Scheduled Tasks' }]

describe('finishOnboarding', () => {
  it('keeps a changed name and turns the tools on, then marks the user set up', async () => {
    const { api, calls } = fakeApi()
    const result = await finishOnboarding(api, { name: '  Ada  ', previousName: 'ada', tools: TOOLS })
    expect(calls).toEqual(['name Ada', 'provision context', 'provision scheduler', 'complete'])
    expect(result).toEqual({ name: 'Ada', failedTools: [] })
  })

  it('leaves a name as it was when it is the same, or emptied', async () => {
    for (const name of ['ada', '   ']) {
      const { api } = fakeApi()
      expect((await finishOnboarding(api, { name, previousName: 'ada', tools: [] })).name).toBeUndefined()
      expect(api.setOwnDisplayName).not.toHaveBeenCalled()
    }
  })

  it('goes on past a tool that cannot be turned on, saying which', async () => {
    const { api, calls } = fakeApi(['scheduler'])
    const result = await finishOnboarding(api, { name: 'ada', previousName: 'ada', tools: TOOLS })
    expect(result.failedTools).toEqual(['Scheduled Tasks'])
    expect(calls).toContain('complete')
  })

  it('leaves the user to be set up when the name cannot be kept', async () => {
    const { api } = fakeApi()
    vi.mocked(api.setOwnDisplayName).mockRejectedValueOnce(new Error('offline'))
    await expect(finishOnboarding(api, { name: 'Ada', previousName: 'ada', tools: TOOLS })).rejects.toThrow('offline')
    expect(api.completeOnboarding).not.toHaveBeenCalled()
  })
})
