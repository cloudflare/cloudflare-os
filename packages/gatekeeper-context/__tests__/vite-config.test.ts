import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite'
import { describe, expect, it, vi } from 'vite-plus/test'

// vite.config.ts takes `loadEnv` from 'vite-plus', so that is the module to stub -- mocking
// 'vite' would leave the real implementation in place and read the ambient environment.
vi.mock('vite-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite-plus')>()
  return {
    ...actual,
    loadEnv: () => ({ VITE_FRONTEND_ERROR_REPORTING: 'true' }),
  }
})

import config from '../vite.config'

async function resolveConfig(value: UserConfigExport): Promise<UserConfig> {
  if (typeof value !== 'function') return value
  const env: ConfigEnv = { command: 'build', mode: 'test', isSsrBuild: false, isPreview: false }
  return await value(env)
}

describe('Context app Vite config', () => {
  it('uses the loaded environment to emit hidden source maps', async () => {
    const resolved = await resolveConfig(config)
    expect(resolved.build?.sourcemap).toBe('hidden')
  })
})
