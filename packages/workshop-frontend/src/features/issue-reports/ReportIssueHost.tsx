import { createContext, useContext, useState, type ReactNode } from 'react'
import type { IssueReportContext, WorkpieceId } from '@gadgets/workshop-shared/api'
import { entryScriptOf } from '../stale-session/versionChecks'
import { ReportIssueDialog } from './ReportIssueDialog'

/**
 * Where the user was when they chose "Report issue", as the menu that holds the item knows it.
 * Ids only: the dialog opens its own session for whatever it does to a workspace.
 */
export type ReportIssueContext = {
  /** The workspace the menu belongs to. Absent on the home page. `owned` decides only what the
   * dialog offers: the server decides who may give a grant. */
  workspace?: { id: string; owned: boolean }
  /** The chat that is open. */
  chatId?: number
  /** The gadget that is open. */
  gadgetId?: WorkpieceId
}

/**
 * Where the reporter was, as a report is filed with it: the ids the context holds and the
 * version of the app. A key with nothing to send is absent, and `owned` stays on the client.
 */
export const issueReportContext = (
  context: ReportIssueContext,
  appVersion: string | undefined,
): IssueReportContext => ({
  ...(context.workspace !== undefined && { workspaceId: context.workspace.id }),
  ...(context.chatId !== undefined && { chatId: context.chatId }),
  ...(context.gadgetId !== undefined && { gadgetId: context.gadgetId }),
  ...(appVersion !== undefined && { appVersion }),
})

/**
 * The version a report is filed with: the frontend build this page runs, by its entry script,
 * then the backend the page is connected to. The two differ in a tab that outlived a
 * deployment, whose connection moved to the newer backend while the page stayed the older
 * build, and a fault in the page is the build's. Either part is left out when it is not known.
 */
export const reportAppVersion = (backendVersion: string | undefined): string | undefined => {
  const parts = [entryScriptOf(document), backendVersion].filter((part) => part !== undefined)
  return parts.length > 0 ? parts.join(' @ ') : undefined
}

type OpenReportIssue = (context: ReportIssueContext, opener: HTMLElement | null) => void

const ReportIssueOpener = createContext<OpenReportIssue>(() => {})

/**
 * Opens the Report issue dialog for a context. `opener` takes focus when the dialog closes: the
 * trigger of the menu the request came from, since the menu's item is gone by then. Outside a
 * ReportIssueProvider the function does nothing.
 */
export const useReportIssue = (): OpenReportIssue => useContext(ReportIssueOpener)

/**
 * Holds the app's one Report issue dialog. A menu's content unmounts when the menu closes, so
 * the dialog lives here, above every menu and route, and a menu's item only asks for it.
 */
export const ReportIssueProvider = ({ children }: { children: ReactNode }) => {
  // `request` numbers the requests, so that each starts from an empty draft.
  const [open, setOpen] =
    useState<{ context: ReportIssueContext; opener: HTMLElement | null; request: number } | null>(null)

  const openReportIssue: OpenReportIssue = (context, opener) => {
    setOpen((current) => ({ context, opener, request: (current?.request ?? 0) + 1 }))
  }

  return (
    <ReportIssueOpener.Provider value={openReportIssue}>
      {children}
      {open !== null && (
        <ReportIssueDialog
          key={open.request}
          context={open.context}
          onClosed={() => {
            setOpen(null)
            if (open.opener?.isConnected) open.opener.focus()
          }}
        />
      )}
    </ReportIssueOpener.Provider>
  )
}
