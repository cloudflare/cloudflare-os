// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GadgetSummary, WorkspaceMetadata } from '@gadgets/workshop-shared/api'
import type { ReportIssueContext } from './features/issue-reports/ReportIssueHost'
import GadgetUseView from './GadgetUseView'

const mocks = vi.hoisted(() => ({ reports: [] as unknown[] }))

vi.mock('@tanstack/react-router', () => ({ Link: () => null }))
vi.mock('./components/UserMenu', () => ({
  default: ({ report }: { report: unknown }) => {
    mocks.reports.push(report)
    return null
  },
}))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./GadgetUI', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Props = ComponentProps<typeof GadgetUseView>

const GADGETS = [{ id: 1, title: 'Planner' }, { id: 2, title: 'Tracker' }] as GadgetSummary[]

let host: HTMLDivElement | undefined
let root: Root | undefined

/** The context the view's Report issue item was last given. */
const reportFrom = async (
  { selectedGadgetId, gadgets }: Pick<Props, 'selectedGadgetId' | 'gadgets'>,
): Promise<ReportIssueContext> => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <GadgetUseView
        selectedGadgetId={selectedGadgetId}
        gadgets={gadgets}
        overseer={{} as Props['overseer']}
        gadget={null}
        snapshot={null}
        gadgetOpenFailure={null}
        onRetryGadget={() => {}}
        onSelectGadget={() => {}}
        metadata={{ id: 'w1', title: 'Shared plan' } as WorkspaceMetadata}
        authenticatedApi={{} as Props['authenticatedApi']}
        currentUserId="profile-uma"
      />,
    )
  })
  return mocks.reports.at(-1) as ReportIssueContext
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  mocks.reports.length = 0
})

describe('Report issue from the use-only view', () => {
  it('names the workspace and the gadget that is open, for a collaborator who owns neither', async () => {
    expect(await reportFrom({ selectedGadgetId: 2, gadgets: GADGETS }))
      .toEqual({ workspace: { id: 'w1', owned: false }, gadgetId: 2 })
  })

  it('names the workspace alone while no gadget is open', async () => {
    expect(await reportFrom({ selectedGadgetId: null, gadgets: [] }))
      .toEqual({ workspace: { id: 'w1', owned: false } })
  })
})
