// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {} }),
}))
vi.mock('../../ServerConfigContext', () => ({
  useServerConfig: () => ({ adminContentGrants: true }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
// A menu item as a plain button: opening Kumo's menu takes pointer events jsdom does not have.
// The dialog is Kumo's own.
vi.mock('@cloudflare/kumo', async (original) => ({
  ...(await original<typeof import('@cloudflare/kumo')>()),
  DropdownMenu: {
    Item: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" role="menuitem" onClick={onClick}>{children}</button>
    ),
  },
}))

import {
  ReportIssueProvider,
  issueReportContext,
  type ReportIssueContext,
} from './ReportIssueHost'
import { ReportIssueItem } from './ReportIssueItem'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

/**
 * A menu as Kumo's behaves: its content is mounted only while it is open, and choosing an item
 * closes it.
 */
const Menu = ({ name, context }: { name: string; context?: ReportIssueContext }) => {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button type="button" ref={trigger} onClick={() => setOpen(true)}>{name}</button>
      {open && (
        <div
          role="menu"
          aria-label={name}
          tabIndex={-1}
          onClick={() => setOpen(false)}
          onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}
        >
          <ReportIssueItem context={context} opener={trigger} />
        </div>
      )}
    </div>
  )
}

let host: HTMLDivElement | undefined
let root: Root | undefined

const render = async (ui: ReactNode) => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => { root!.render(ui) })
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

const click = (element: HTMLElement) => act(async () => { element.click() })
const buttonNamed = (name: string) => {
  const found = [...document.body.querySelectorAll('button')]
    .find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
  if (found === undefined) throw new Error(`no button "${name}"`)
  return found
}
const item = (menu: string) => {
  const found = document.body.querySelector<HTMLElement>(`[role="menu"][aria-label="${menu}"] [role="menuitem"]`)
  if (found === null) throw new Error(`no item in "${menu}"`)
  return found
}
const dialogs = () => [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')]
const accessChoices = () =>
  [...dialogs()[0].querySelectorAll('fieldset')]
    .find((group) => group.textContent?.startsWith('Give admins access to'))!
    .querySelectorAll('[role="radio"]').length

describe('ReportIssueProvider', () => {
  it('keeps the dialog open after the menu that asked for it has unmounted', async () => {
    await render(<ReportIssueProvider><Menu name="Home menu" /></ReportIssueProvider>)
    expect(dialogs()).toHaveLength(0)

    await click(buttonNamed('Home menu'))
    expect(item('Home menu').textContent).toBe('Report issue')
    await click(item('Home menu'))

    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(dialogs()).toHaveLength(1)
    expect(dialogs()[0].textContent).toContain('What went wrong?')
  })

  it('serves every item with one dialog, which takes the context of the last request', async () => {
    await render(
      <ReportIssueProvider>
        <Menu name="Home menu" />
        <Menu name="Workspace menu" context={{ workspace: { id: 'w1', owned: true } }} />
      </ReportIssueProvider>,
    )
    await click(buttonNamed('Home menu'))
    await click(item('Home menu'))
    // From the home page: metadata, or the content of every workspace.
    expect(accessChoices()).toBe(2)

    await click(buttonNamed('Workspace menu'))
    await click(item('Workspace menu'))
    expect(dialogs()).toHaveLength(1)
    // From an owned workspace: this workspace's content as well.
    expect(accessChoices()).toBe(3)
  })

  it('gives focus back to the menu’s trigger once the dialog has closed', async () => {
    await render(<ReportIssueProvider><Menu name="Home menu" /></ReportIssueProvider>)
    await click(buttonNamed('Home menu'))
    await click(item('Home menu'))

    await click(buttonNamed('Close'))
    await vi.waitFor(() => expect(dialogs()).toHaveLength(0))
    expect(document.activeElement).toBe(buttonNamed('Home menu'))
  })
})

describe('ReportIssueItem outside a provider', () => {
  it('renders, and its click does nothing', async () => {
    await render(<Menu name="Lone menu" />)
    await click(buttonNamed('Lone menu'))
    await click(item('Lone menu'))
    expect(dialogs()).toHaveLength(0)
  })
})

describe('issueReportContext', () => {
  it('sends the ids it was given and the app’s version, and never who owns the workspace', () => {
    expect(issueReportContext({ workspace: { id: 'w1', owned: true }, chatId: 0, gadgetId: 3 }, '1.2.3'))
      .toEqual({ workspaceId: 'w1', chatId: 0, gadgetId: 3, appVersion: '1.2.3' })
  })

  it('leaves out a key it has nothing for', () => {
    expect(Object.keys(issueReportContext({}, undefined))).toEqual([])
    expect(Object.keys(issueReportContext({ workspace: { id: 'w1', owned: false } }, undefined)))
      .toEqual(['workspaceId'])
    expect(Object.keys(issueReportContext({}, '1.2.3'))).toEqual(['appVersion'])
  })
})
