// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Close: ({ render: renderClose }: { render: (props: object) => ReactElement }) => renderClose({}),
    },
  )
  let selectChange: ((value: string) => void) | undefined
  const Select = Object.assign(
    ({ label, onValueChange, children }: {
      label: string
      onValueChange: (value: string) => void
      children: ReactNode
    }) => {
      selectChange = onValueChange
      return <div aria-label={label}>{label}{children}</div>
    },
    { Option: ({ value, children }: { value: string, children: ReactNode }) => (
      <button type="button" data-value={value} onClick={() => selectChange?.(value)}>{children}</button>
    ) },
  )
  const Input = ({ label, value, onChange, type }: ComponentProps<'input'> & { label: string }) => (
    <label>{label}<input aria-label={label} value={value} onChange={onChange} type={type} /></label>
  )
  const SensitiveInput = ({ label, value, onValueChange }: {
    label: string
    value: string
    onValueChange: (value: string) => void
  }) => (
    <label>{label}<input aria-label={label} value={value}
      onChange={(event) => onValueChange(event.target.value)} /></label>
  )
  const Collapsible = {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    DefaultTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    DefaultPanel: ({ children }: { children: ReactNode }) => <>{children}</>,
  }
  return {
    Button: ({ loading: _loading, ...props }: ComponentProps<'button'> & { loading?: boolean }) => (
      <button type="button" {...props} />
    ),
    Collapsible,
    Dialog,
    Input,
    Select,
    SensitiveInput,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

import AddModelModal from './AddModelModal'

let container: HTMLDivElement
let root: Root
const addModel = vi.fn<AuthenticatedApi['addModel']>(async () => {})
const authenticatedApi = { addModel } as unknown as RpcStub<AuthenticatedApi>

function render(aiConfig: Parameters<typeof AddModelModal>[0]['aiConfig']) {
  act(() => {
    root.render(<AddModelModal
      visible
      onCancel={() => {}}
      onSuccess={() => {}}
      authenticatedApi={authenticatedApi}
      aiConfig={aiConfig}
    />)
  })
}

function change(label: string, value: string) {
  const input = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function select(value: string) {
  const option = container.querySelector(`[data-value="${value}"]`) as HTMLButtonElement
  act(() => option.click())
}

async function submit() {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent === 'Add Model')!
  await act(async () => button.click())
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  addModel.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AddModelModal OpenAI-compatible provider', () => {
  it('accepts a pasted completion endpoint', async () => {
    render({ enabled: false })

    select('other-openai-compatible')
    change('Model ID', 'provider/model')
    change('Display Name', 'My Model')
    change('API Token', 'secret')
    change('Base URL', 'https://models.example.com/v1/chat/completions/')
    change('Context Window', '128000')
    change('Maximum Output Tokens', '8192')

    await submit()

    expect(addModel).toHaveBeenCalledWith(
      { type: 'agent', id: 'provider/model', name: 'My Model' },
      {
        provider: 'openai-compatible',
        model: 'provider/model',
        apiToken: 'secret',
        apiUrl: 'https://models.example.com/v1/chat/completions/',
        contextWindow: 128_000,
        outputLimit: 8_192,
      },
    )
  })

  it('derives limits for a model recognized by base URL and ID', async () => {
    render({ enabled: false })

    select('other-openai-compatible')
    change('Model ID', 'gemma-4-31b')
    change('Display Name', 'Gemma 4')
    change('API Token', 'secret')
    change('Base URL', 'https://api.cerebras.ai/v1')

    expect(container.querySelector('[aria-label="Context Window"]')).toBeNull()
    expect(container.querySelector('[aria-label="Maximum Output Tokens"]')).toBeNull()

    await submit()
    expect(addModel).toHaveBeenCalledWith(
      { type: 'agent', id: 'gemma-4-31b', name: 'Gemma 4' },
      expect.objectContaining({
        provider: 'openai-compatible',
        model: 'gemma-4-31b',
        apiUrl: 'https://api.cerebras.ai/v1',
        contextWindow: 131_072,
        outputLimit: 40_960,
      }),
    )
  })

  it('is not offered in platform AI Gateway mode', () => {
    render({ enabled: true, enabledProviders: ['openai', 'openai-compatible'] })
    expect(container.textContent).not.toContain('OpenAI-compatible')
  })

  it.each([
    { baseUrl: 'http://models.example.com/v1', contextWindow: '128000', outputLimit: '8192' },
    { baseUrl: 'https://models.example.com/v1?route=chat', contextWindow: '128000', outputLimit: '8192' },
    { baseUrl: 'https://models.example.com/v1', contextWindow: '8192', outputLimit: '8192' },
  ])('does not submit invalid endpoint settings', async ({ baseUrl, contextWindow, outputLimit }) => {
    render({ enabled: false })
    select('other-openai-compatible')
    change('Model ID', 'provider/model')
    change('Display Name', 'My Model')
    change('API Token', 'secret')
    change('Base URL', baseUrl)
    change('Context Window', contextWindow)
    change('Maximum Output Tokens', outputLimit)

    await submit()
    expect(addModel).not.toHaveBeenCalled()
  })
})
