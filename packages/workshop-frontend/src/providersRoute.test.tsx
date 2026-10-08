// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

const api = vi.hoisted(() => ({
  listModels: vi.fn<() => Promise<AiChatAuthorInfo[]>>(async () => [{ type: 'agent', id: 'chat-model', name: 'Chat model' }]),
  listClassifierModels: async () => [{ type: 'agent', id: 'classifier-model', name: 'Classifier model' }],
  getQuickModel: async () => null,
  getAiConfig: async () => ({ enabled: false }),
  setQuickModel: vi.fn<(modelId: string | null) => Promise<void>>(async () => {}),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof Kumo>()),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: api }),
}))

import { Route } from './routes/providers'

// The route's component is code-split; load its chunk while collecting, outside the test timeout.
const ProvidersPage = Route.options.component!
await ProvidersPage.preload?.()

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
testGlobal.IS_REACT_ACT_ENVIRONMENT = true

async function menuItems(trigger: HTMLElement) {
  await act(async () => trigger.click())
  const items = Array.from(document.body.querySelectorAll('[role="menuitem"]'), item => item.textContent)
  await act(async () => trigger.click())
  return items
}

function nameOf(text: string) {
  return Array.from(document.body.querySelectorAll('span')).find(span => span.textContent === text)!
}

describe('ProvidersPage quick model', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    api.setQuickModel.mockClear()
  })

  async function renderPage() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<ProvidersPage />))
    await vi.waitFor(() => expect(document.body.textContent).toContain('Classifier model'))
  }

  // A classifier quick model would fail every title and binding-name request it was given.
  it('can be any chat model but never a classifier', async () => {
    await renderPage()
    expect(document.body.textContent).toContain('Quick model:')

    expect(nameOf('Classifier model').closest('[role="button"]')).toBeNull()
    await act(async () => nameOf('Classifier model').click())
    expect(api.setQuickModel).not.toHaveBeenCalled()
    await act(async () => nameOf('Chat model').closest<HTMLElement>('[role="button"]')!.click())
    expect(api.setQuickModel).toHaveBeenCalledWith('chat-model')

    const [chatMenu, classifierMenu] = document.body.querySelectorAll<HTMLElement>('[aria-label="Provider actions"]')
    expect(await menuItems(chatMenu)).toContain('Clear quick model')
    expect(await menuItems(classifierMenu)).not.toContainEqual(expect.stringContaining('quick model'))
  })

  // Reachable by finishing onboarding without a model, then adding Clef for a blueprint.
  it('offers no quick model when only classifiers are configured', async () => {
    api.listModels.mockResolvedValueOnce([])
    await renderPage()
    expect(document.body.textContent).not.toContain('Quick model:')
  })
})
