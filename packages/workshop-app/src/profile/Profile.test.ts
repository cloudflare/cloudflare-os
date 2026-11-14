import { describe, expect, it, vi } from 'vitest'
import { Profile, type PasswordHash, type ProfileApi } from './Profile'

const fakeApi = () => ({
  getAvatar: vi.fn<ProfileApi['getAvatar']>(async () => new Uint8Array([1, 2])),
  setAvatar: vi.fn<ProfileApi['setAvatar']>(async () => {}),
  setOwnDisplayName: vi.fn<ProfileApi['setOwnDisplayName']>(async () => {}),
  changePassword: vi.fn<ProfileApi['changePassword']>(async () => {}),
  hasPasswordLogin: vi.fn<ProfileApi['hasPasswordLogin']>(async () => true),
})

const setUp = () => {
  const api = fakeApi()
  let made = 0
  const urls = { create: vi.fn<(bytes: Uint8Array) => string>(() => `blob:${++made}`), revoke: vi.fn<(url: string) => void>() }
  const hash = vi.fn<PasswordHash>(async (id, password) => new TextEncoder().encode(`${id}:${password}`))
  const profile = new Profile(() => api, { type: 'user', id: 'ada', name: 'Ada' }, hash, urls)
  return { api, urls, hash, profile }
}

describe('Profile', () => {
  it('reads the picture and whether the user has a password', async () => {
    const { api, profile } = setUp()
    profile.start()
    await vi.waitFor(() => expect(profile.getSnapshot()).toMatchObject({ picture: 'blob:1', hasPassword: true }))
    expect(api.getAvatar).toHaveBeenCalledWith('ada')
  })

  it('shows a new name only once the server has it, trimmed', async () => {
    const { api, profile } = setUp()
    const listener = vi.fn<() => void>()
    profile.subscribe(listener)
    await profile.rename('  Ada L.  ')
    expect(api.setOwnDisplayName).toHaveBeenCalledWith('Ada L.')
    expect(profile.getSnapshot().user.name).toBe('Ada L.')
    expect(listener).toHaveBeenCalled()

    api.setOwnDisplayName.mockRejectedValueOnce(new Error('Too long'))
    await expect(profile.rename('x'.repeat(500))).rejects.toThrow('Too long')
    expect(profile.getSnapshot().user.name).toBe('Ada L.')
  })

  it('shows a new picture and lets the old one go, and none once it is taken away', async () => {
    const { api, urls, profile } = setUp()
    profile.start()
    await vi.waitFor(() => expect(profile.getSnapshot().picture).toBe('blob:1'))
    await profile.setPicture(new Uint8Array([3]))
    expect(profile.getSnapshot().picture).toBe('blob:2')
    expect(urls.revoke).toHaveBeenCalledWith('blob:1')
    await profile.setPicture(null)
    expect(api.setAvatar).toHaveBeenLastCalledWith(null)
    expect(profile.getSnapshot().picture).toBeUndefined()
    expect(urls.revoke).toHaveBeenCalledWith('blob:2')
  })

  it('changes the password with both hashed as sign-in hashes them', async () => {
    const { api, hash, profile } = setUp()
    await profile.changePassword('old', 'new')
    expect(hash.mock.calls).toEqual([['ada', 'old'], ['ada', 'new']])
    expect(api.changePassword).toHaveBeenCalledWith(new TextEncoder().encode('ada:old'), new TextEncoder().encode('ada:new'))
  })

  it('ignores what an earlier start reads after it was stopped', async () => {
    const { api, profile } = setUp()
    let answer: (bytes: Uint8Array | null) => void = () => {}
    api.getAvatar.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    profile.start()
    profile.stop()
    answer(new Uint8Array([9]))
    await Promise.resolve()
    expect(profile.getSnapshot().picture).toBeUndefined()
  })
})
