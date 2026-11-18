import { describe, expect, it, vi } from 'vitest'
import { InlineViewHostImpl, inlineViewPageStart, inlineViewShell, type InlineViewTheme } from './inlineViewFrame'

const THEME: InlineViewTheme = { scheme: 'dark', tokens: { '--color-kumo-base': 'light-dark(#fff, #111)', '--font-sans': 'system-ui' } }

const host = () => {
  const options = { onMessageRequest: vi.fn<(message: string) => void>(), onResize: vi.fn<(height: number) => void>(), onError: vi.fn<(message: string) => void>() }
  return { options, host: new InlineViewHostImpl(options) }
}

describe('InlineViewHostImpl', () => {
  it('passes on a message to suggest', () => {
    const { options, host: view } = host()
    view.requestMessage('Go with B')
    expect(options.onMessageRequest).toHaveBeenCalledWith('Go with B')
  })

  it.each([[''], ['   '], [42], [undefined]])('refuses %j as a message', (message) => {
    const { options, host: view } = host()
    expect(() => view.requestMessage(message as string)).toThrow(TypeError)
    expect(options.onMessageRequest).not.toHaveBeenCalled()
  })

  it('takes only a height that is a number', () => {
    const { options, host: view } = host()
    view.resize(120)
    view.resize(Number.NaN)
    view.resize('120' as unknown as number)
    expect(options.onResize.mock.calls).toEqual([[120]])
  })

  it('reports what the view threw as text', () => {
    const { options, host: view } = host()
    view.reportError({ toString: () => 'boom' } as unknown as string)
    expect(options.onError).toHaveBeenCalledWith('boom')
  })
})

describe('the frame', () => {
  it('loads a shell that can reach nothing and starts the bootstrap', () => {
    const shell = inlineViewShell(THEME)
    expect(shell).toContain("default-src 'none'")
    expect(shell).toContain("connect-src 'none'")
    expect(shell).toContain('<script type="module" src="data:text/javascript')
  })

  it('starts the view’s page in the theme, with nothing of its body', () => {
    const start = inlineViewPageStart(THEME)
    expect(start).toContain('color-scheme: dark;')
    expect(start).toContain('--color-kumo-base: light-dark(#fff, #111);')
    expect(start).toContain("default-src 'none'")
    expect(start).not.toContain('<script')
    expect(start.trimEnd().endsWith('<body>')).toBe(true)
  })
})
