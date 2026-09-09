import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

vi.mock('@tanstack/router-plugin/vite', () => ({ TanStackRouterVite: vi.fn<typeof TanStackRouterVite>(() => []) }))

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>()
  return {
    ...actual,
    loadEnv: () => ({
      VITE_BACKEND_HOST: 'backend.from-env.test:9999',
      VITE_FRONTEND_ERROR_REPORTING: 'true',
    }),
  }
})

import config from './vite.config'

async function resolveConfig(value: UserConfigExport): Promise<UserConfig> {
  if (typeof value !== 'function') return value
  const env: ConfigEnv = { command: 'build', mode: 'test', isSsrBuild: false, isPreview: false }
  return await value(env)
}

describe('Vite development proxy', () => {
  it('disables automatic route splitting to prevent missing chunks from forcing a reload', async () => {
    await resolveConfig(config)
    expect(TanStackRouterVite).toHaveBeenLastCalledWith({ target: 'react', autoCodeSplitting: false })
  })

  it('uses loaded environment values for the proxy and source maps', async () => {
    const resolved = await resolveConfig(config)
    expect(resolved.server?.proxy).toMatchObject({
      '/api/client-errors': 'http://backend.from-env.test:9999',
      '/api/site-logo': 'http://backend.from-env.test:9999',
    })
    expect(resolved.build?.sourcemap).toBe('hidden')
  })
})
