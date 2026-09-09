import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntime } from './webRuntime'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web runtime external navigation', () => {
  it.each(['openExternal', 'openOAuthTrampoline'] as const)(
    '%s never navigates the current tab when noopener returns null',
    async (method) => {
      const href = 'https://odie.example/workspace/current?view=chat#draft'
      const assign = vi.fn<Location['assign']>()
      const replace = vi.fn<Location['replace']>()
      const reload = vi.fn<Location['reload']>()
      const open = vi.fn<Window['open']>(() => null)
      const location = { href, assign, replace, reload }
      vi.stubGlobal('window', { location, open })

      await createWebRuntime()[method]('https://external.example/start')

      expect(open).toHaveBeenCalledExactlyOnceWith('https://external.example/start', '_blank', 'noopener')
      expect(assign).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
      expect(location.href).toBe(href)
    },
  )

  it('propagates an opening failure without attempting same-tab navigation', async () => {
    const assign = vi.fn<Location['assign']>()
    const error = new Error('Opening unavailable')
    vi.stubGlobal('window', {
      location: { href: 'https://odie.example/workspace/current', assign },
      open: vi.fn<Window['open']>(() => { throw error }),
    })

    await expect(createWebRuntime().openExternal('https://external.example/')).rejects.toBe(error)
    expect(assign).not.toHaveBeenCalled()
  })
})
