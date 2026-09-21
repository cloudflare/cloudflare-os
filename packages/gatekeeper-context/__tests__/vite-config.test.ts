import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite'
import { describe, expect, it, vi } from 'vitest'

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>()
  return {
    ...actual,
    loadEnv: () => ({ VITE_FRONTEND_ERROR_REPORTING: 'true' }),
  }
})

import config from '../vite.app.config'

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
