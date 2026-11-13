// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { useAutoApprovalChannel, type AutoApprovalChannel } from './autoApprovalChannel'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal() as typeof import('@cloudflare/kumo'),
  useKumoToastManager: () => ({ add: () => {} }),
}))

const { useAlwaysApproveTag } = await import('../../useAlwaysApproveTag')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
})

async function mount<T>(use: () => T) {
  let value: T | undefined
  const Probe = () => {
    value = use()
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Probe />))
  return { get current() { return value! } }
}

describe('useAutoApprovalChannel', () => {
  it('holds the window open until every change in it has settled', async () => {
    const channel = await mount(useAutoApprovalChannel)
    expect(channel.current.changing).toBe(false)

    let endFirst!: () => void
    let endSecond!: () => void
    await act(async () => { endFirst = channel.current.begin() })
    expect(channel.current.changing).toBe(true)

    await act(async () => { endSecond = channel.current.begin() })
    await act(async () => endFirst())
    // Two switches flipped in quick succession: the first settling says nothing about the second.
    expect(channel.current.changing).toBe(true)

    await act(async () => endSecond())
    expect(channel.current.changing).toBe(false)
    expect(channel.current.reloadTrigger).toBe(2)
  })

  it('ignores a second end for the same change', async () => {
    // A count stuck above zero would read as "a change is in flight" for the life of the view,
    // so every bulk apply would wait out the drain on every request a rule could cover.
    const channel = await mount(useAutoApprovalChannel)

    let end!: () => void
    await act(async () => { end = channel.current.begin() })
    await act(async () => end())
    await act(async () => end())

    expect(channel.current.changing).toBe(false)
    expect(channel.current.reloadTrigger).toBe(1)
  })
})

describe('useAlwaysApproveTag', () => {
  it('marks the change in flight across the server call, not after it', async () => {
    // The kernel starts its drain the moment it accepts the rule, so between the call going out
    // and the rule list being re-read, no list here says what is being applied. A window marked
    // only on completion would leave the tray's bulk run deciding requests in that gap.
    let acceptRule!: () => void
    const overseer = {
      setAutoApprovedActionKind: () => new Promise<void>(resolve => { acceptRule = resolve }),
    } as unknown as RpcStub<Overseer>

    let channel!: AutoApprovalChannel
    const hook = await mount(() => {
      channel = useAutoApprovalChannel()
      return useAlwaysApproveTag(overseer, () => {}, channel.begin)
    })

    let enabled!: Promise<boolean>
    await act(async () => {
      enabled = hook.current.alwaysApproveTag(1, 2, { tag: 'append', label: 'Append a slide' })
    })
    expect(channel.changing).toBe(true)

    await act(async () => { acceptRule(); await enabled })
    expect(channel.changing).toBe(false)
    expect(channel.reloadTrigger).toBe(1)
  })
})
