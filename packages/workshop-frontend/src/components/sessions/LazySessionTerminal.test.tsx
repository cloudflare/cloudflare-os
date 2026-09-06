// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function renderLazyTerminal() {
  const { default: LazySessionTerminal } = await import('./LazySessionTerminal')
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(<LazySessionTerminal sessionId="session-1" runtime="opencode" terminalKind="shell" />)
  })
  return {
    container,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

describe('LazySessionTerminal', () => {
  afterEach(() => {
    vi.doUnmock('./SessionTerminal')
    vi.resetModules()
    vi.restoreAllMocks()
    document.body.textContent = ''
  })

  it('shows a local loading fallback until the terminal bundle resolves', async () => {
    let resolveTerminal: ((module: { default: React.ComponentType<{ sessionId: string }> }) => void) | undefined
    vi.doMock('./SessionTerminal', () => new Promise((resolve) => {
      resolveTerminal = resolve as typeof resolveTerminal
    }))

    const rendered = await renderLazyTerminal()

    expect(rendered.container.textContent).toContain('Loading terminal…')
    expect(rendered.container.textContent).toContain('Preparing the terminal client…')

    await act(async () => {
      resolveTerminal?.({ default: ({ sessionId }) => <div>terminal loaded for {sessionId}</div> })
      await Promise.resolve()
    })

    expect(rendered.container.textContent).toContain('terminal loaded for session-1')
    expect(rendered.container.textContent).not.toContain('Loading terminal…')

    await rendered.unmount()
  })

  it('shows a local error fallback when the terminal bundle fails to load', async () => {
    vi.doMock('./SessionTerminal', () => Promise.reject(new Error('chunk failed')))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const rendered = await renderLazyTerminal()
    await act(async () => {
      await Promise.resolve()
    })

    expect(rendered.container.textContent).toContain('Could not load the terminal client.')
    expect(rendered.container.textContent).toContain('Reload the page to try again.')

    await rendered.unmount()
  })
})
