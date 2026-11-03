// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Toasty } from '@cloudflare/kumo'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, ServerConfig } from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../../ServerConfigContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MODELS: AiChatAuthorInfo[] = [
  { type: 'agent', id: 'claude-haiku', name: 'Claude Haiku' },
  { type: 'agent', id: 'gpt-luna', name: 'GPT Luna' },
]

// Only what the page reads on load; nothing here asserts on calls.
const api = {
  listModels: async (kind?: string) => (kind === 'decision' ? [] : MODELS),
  getQuickModel: async () => null,
  getAiConfig: async () => ({
    enabled: true, enabledProviders: ['anthropic', 'openai'],
    builtInModelIds: MODELS.map((model) => model.id), userModelsEnabled: true,
  }),
}

vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))

describe('the AI providers page’s quick model', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  const render = async (cloudflareLimitsEnabled: boolean) => {
    const { Route } = await import('../../routes/providers')
    // The route's component loads as its own chunk, which is loaded before it renders.
    const ProvidersPage = Route.options.component as ComponentType & { preload?: () => Promise<void> }
    await ProvidersPage.preload?.()

    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ServerConfigContext.Provider value={{ cloudflareLimitsEnabled } as ServerConfig}>
        <Toasty><ProvidersPage /></Toasty>
      </ServerConfigContext.Provider>))
    await vi.waitFor(() => expect(document.body.textContent).toContain('GPT Luna'))
  }

  const quickRows = () => Array.from(document.body.querySelectorAll('[title]'))
    .map((element) => element.getAttribute('title'))
    .filter((title) => title?.includes('quick model'))

  it('offers every chat model as the quick model', async () => {
    await render(false)
    expect(quickRows()).toEqual(['Click to set as quick model', 'Click to set as quick model'])
  })

  // The server refuses a quick model there, since quick tasks count against no limit.
  it('offers none where Cloudflare limits apply, and says the deployment’s model is used',
    async () => {
      await render(true)
      expect(quickRows()).toEqual([])
      expect(document.body.querySelector('[role="button"][title]')).toBeNull()
      expect(document.body.textContent)
        .toContain('Fast tasks like generating chat titles use your deployment’s own model.')
    })
})
