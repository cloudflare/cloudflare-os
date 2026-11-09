// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal() as typeof import('@cloudflare/kumo'),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {}, currentUser: null }),
  useOptionalAuthenticatedApi: () => null,
}))

import { entry, makeTestRoot } from '../../action-test-harness'
import { INCOMPLETE_DESCRIPTION_COPY } from '../../components/IncompleteDescriptionNotice'
import { RESTRICTED_APPROVAL_COPY } from '../../components/RestrictedApprovalNotice'
import { DraftReviewPane } from './DraftReviewPane'
import type { Draft, DraftGroup } from './drafts'
import { documentFixture } from '../resource-preview/fixtures'

const testRoot = makeTestRoot()
afterEach(() => testRoot.cleanup())

const longDescription = 'Send the following email to alice@example.com:\n\n' +
  'Hello Alice,\n\nThe numbers are in.\n\nRegards, the workspace.'

const draft = (id: number, over: Partial<Record<string, unknown>> = {}) => entry(id, {
  gatekeeperId: 4,
  description: {
    title: `Send email ${id}`, description: longDescription, implementsRevert: false,
    autoApprovable: false, ...over,
  },
}) as Draft

const group = (drafts: ActionLogEntry[], kind: DraftGroup['kind'] = 'email'): DraftGroup => ({
  key: '4:', gatekeeperId: 4, title: 'Mail', kind, drafts: drafts as Draft[], holdsAgent: false,
})

const makeOverseer = () => {
  const approved: number[] = []
  const rejected: number[] = []
  const overseer = {
    approveAction: vi.fn<(id: number) => Promise<void>>(async (id) => { approved.push(id) }),
    rejectAction: vi.fn<(id: number) => Promise<void>>(async (id) => { rejected.push(id) }),
    previewResource: vi.fn<() => Promise<null>>(async () => null),
  } as unknown as RpcStub<Overseer>
  return { overseer, approved, rejected }
}

const render = (g: DraftGroup, restricted = false, overseer = makeOverseer().overseer) =>
  testRoot.render(<DraftReviewPane overseer={overseer} group={g} restricted={restricted} />)

const button = (name: string) => {
  const found = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === name)
  if (!found) throw new Error(`No ${name} button`)
  return found
}

// The text a screen reader announces as the Apply button's description.
const applyDescribedBy = () => {
  const ids = button('Apply').getAttribute('aria-describedby')
  return ids === null ? null
    : ids.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join('\n')
}

describe('DraftReviewPane, listing what it cannot draw', () => {
  it('shows each draft in full, with its fields as literal text', async () => {
    const body = 'LGTM ```but``` <script>alert(1)</script>'
    await render(group([draft(1, { fields: [{ label: 'Body', kind: 'text', value: body, syntax: 'markdown' }] })]))

    expect(document.body.textContent).toContain('Regards, the workspace.')
    expect([...document.querySelectorAll('pre')].some(pre => pre.textContent === body)).toBe(true)
    expect(document.querySelector('script')).toBeNull()
  })

  it('flags a draft whose description is not marked complete', async () => {
    await render(group([draft(1)]))
    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)

    await render(group([draft(1, { descriptionIsComplete: true })]))
    expect(document.body.textContent).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('names the restricted notice and the whole request on Apply while restricted', async () => {
    const fields = [{ label: 'To', kind: 'list', items: ['a@example.com'] }]
    await render(group([draft(1, { fields, descriptionIsComplete: true })]), true)

    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    const described = applyDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
    expect(described).toContain('a@example.com')
  })

  it('lists even a drawable file while restricted, without asking for its preview', async () => {
    const { overseer } = makeOverseer()
    await render(group([draft(1)], 'spreadsheet'), true, overseer)

    expect(overseer.previewResource).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Regards, the workspace.')
  })

  it('applies every draft oldest first, and says how it went', async () => {
    const { overseer, approved } = makeOverseer()
    await render(group([draft(1), draft(2), draft(3)]), false, overseer)

    await act(async () => button('Apply all 3').click())
    expect(approved).toEqual([1, 2, 3])
    expect(document.querySelectorAll('li')).toHaveLength(3)
    expect([...document.querySelectorAll('li')].every(li => li.textContent?.includes('Applied'))).toBe(true)
  })

  it('discards all only once asked to confirm, newest first', async () => {
    const { overseer, rejected } = makeOverseer()
    await render(group([draft(1), draft(2)]), false, overseer)

    await act(async () => button('Discard all').click())
    expect(rejected).toEqual([])
    const confirm = [...document.querySelectorAll('[role="alert"] button')]
      .find(b => b.textContent === 'Discard') as HTMLButtonElement
    await act(async () => confirm.click())
    expect(rejected).toEqual([2, 1])
  })

  it('stops at the first draft that fails, and picks up from it on Try again', async () => {
    const { overseer, approved } = makeOverseer()
    let fail = true
    vi.mocked(overseer.approveAction).mockImplementation((async (id: number) => {
      if (id === 2 && fail) throw new Error('nope')
      approved.push(id)
    }) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(group([draft(1), draft(2), draft(3)]), false, overseer)

    await act(async () => button('Apply all 3').click())
    expect(approved).toEqual([1])
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Applied 1 of 3')

    fail = false
    await act(async () => button('Try again').click())
    expect(approved).toEqual([1, 2, 3])
  })
})

describe('DraftReviewPane, a file not created yet', () => {
  it('draws the new file its connection previews, though its drafts name no kind', async () => {
    const { overseer } = makeOverseer()
    vi.mocked(overseer.previewResource).mockImplementation((async () => documentFixture) as never)
    const creation = { ...draft(1, { title: 'Create Google Doc: Plan' }), creation: true } as Draft
    await render(group([creation, draft(2, { title: 'Append to Google Doc' })], 'other'), false, overseer)

    expect(overseer.previewResource).toHaveBeenCalledWith(4, undefined)
    expect(document.querySelector('section[aria-label="Mail, as it will be"]')).not.toBeNull()
    expect(document.querySelector('ol[aria-label="Drafts"]')).toBeNull()
    // Decided whole, as the new file: no change is singled out to step through.
    expect(document.querySelector('[data-change-id]')).toBeNull()
    expect(document.body.textContent).not.toContain('1 of 2')
    expect(button('Create document')).toBeDefined()
  })

  it('lists the drafts when the connection draws nothing', async () => {
    const creation = { ...draft(1), creation: true } as Draft
    await render(group([creation], 'other'))
    expect(document.querySelector('ol[aria-label="Drafts"]')).not.toBeNull()
  })
})
