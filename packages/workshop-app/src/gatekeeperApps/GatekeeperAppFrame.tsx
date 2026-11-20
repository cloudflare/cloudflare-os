import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import type { RpcStub } from 'capnweb'
import { isHexColor } from '@gadgets/workshop-shared/api'
import type { GatekeeperUiFrame, GatekeeperUserSelectionReceiver } from '@gadgets/workshop-shared/gatekeeper'
import type { GatekeeperAppTheme } from '@gadgets/workshop-shared/theme'
import { useApi } from '@/rpc/ApiContext'
import { useServerConfig } from '@/rpc/serverConfig'
import type { AppWorkspaceTarget } from './appNavigation'
import { GatekeeperAppHost, type AppHostPage } from './GatekeeperAppHost'
import { GatekeeperAppSession } from './GatekeeperAppSession'
import { GatekeeperUserPicker } from './GatekeeperUserPicker'
import { UserPickers } from './UserPicker'

export type GatekeeperAppFrameProps = {
  /** The app's page and its gatekeeper's API for it, from `getGatekeeperApp()`. */
  frame: GatekeeperUiFrame
  gatekeeperId: string
  /** What it is called, which the frame and the person picker say. */
  title: string
  onOpenWorkspace: (target: AppWorkspaceTarget) => void
  /** Starts a chat with `prompt` in the composer. */
  onOpenPrompt: (prompt: string) => void
}

// How long one listing of the workspaces serves the titles the app looks up: it asks for a page of
// rows at a time, and could ask in a loop.
const WORKSPACE_TITLES_FOR = 10_000

// The app's theme, which `index.html` keeps on the root as it changes.
const subscribeMode = (onChange: () => void) => {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
  return () => observer.disconnect()
}
const readMode = () => (document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light')

/**
 * A gatekeeper's management app, filling what it is in: its page in a frame sandboxed with no
 * origin, which reaches only its gatekeeper, through what the Workshop relays to it
 * (`GatekeeperAppHost`), and the Workshop's own theme and accent colour, as they change. For a
 * dialog of its own it grows over the whole window, and the person picker it may ask for opens
 * over that.
 */
export const GatekeeperAppFrame = ({ frame, gatekeeperId, title, onOpenWorkspace, onOpenPrompt }: GatekeeperAppFrameProps) => {
  const { api } = useApi()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [overlay, setOverlay] = useState(false)
  const overlayRef = useRef(false)
  const [pickers] = useState(() => new UserPickers())
  const picker = useSyncExternalStore(pickers.subscribe, pickers.getSnapshot)
  const mode = useSyncExternalStore(subscribeMode, readMode)
  const accent = useServerConfig()?.accentColor
  const theme: GatekeeperAppTheme = { mode, accentColor: accent && isHexColor(accent) ? accent : null }

  // The latest render's, read by the host as it is asked.
  const latest = useRef({ api, theme, onOpenWorkspace, onOpenPrompt })
  latest.current = { api, theme, onOpenWorkspace, onOpenPrompt }
  const session = useRef<GatekeeperAppSession>(undefined)

  useEffect(() => {
    const showOverlay = (next: boolean) => {
      if (overlayRef.current === next) return
      overlayRef.current = next
      setOverlay(next)
    }
    let titles: { at: number; titles: Promise<Map<string, string>> } | undefined
    const page: AppHostPage = {
      present: (active) => {
        // Put back already, as it often is when the app goes.
        if (!active && !overlayRef.current) return { rect: null, willResize: false }
        const before = iframeRef.current?.getBoundingClientRect()
        flushSync(() => showOverlay(active))
        const after = iframeRef.current?.getBoundingClientRect()
        const willResize = !!before && !!after && (before.width !== after.width || before.height !== after.height)
        // Where the page was, which the app holds its own to while it covers the window.
        const rect = active && before ? { left: before.left, top: before.top, width: before.width, height: before.height } : null
        return { rect, willResize }
      },
      openWorkspace: (target) => latest.current.onOpenWorkspace(target),
      openPrompt: (prompt) => latest.current.onOpenPrompt(prompt),
      resolveWorkspaceTitles: async (ids) => {
        if (!titles || Date.now() - titles.at >= WORKSPACE_TITLES_FOR) {
          const listing = {
            at: Date.now(),
            titles: latest.current.api.listWorkspaces().then((workspaces) => new Map(workspaces.map((workspace) => [workspace.id, workspace.title]))),
          }
          titles = listing
          // One that failed is asked again next time.
          listing.titles.catch(() => {
            if (titles === listing) titles = undefined
          })
        }
        const known = await titles.titles
        return ids.map((id) => known.get(id) ?? null)
      },
      openUserPicker: (receiver: RpcStub<GatekeeperUserSelectionReceiver>) => pickers.open(receiver),
      cancelUserPicker: () => pickers.cancel(),
    }
    const next = new GatekeeperAppSession(
      () => iframeRef.current?.contentWindow,
      gatekeeperId,
      () => new GatekeeperAppHost(frame.ui, page, latest.current.theme),
    )
    session.current = next
    window.addEventListener('message', next.receive)
    return () => {
      window.removeEventListener('message', next.receive)
      next.dispose()
      if (session.current === next) session.current = undefined
      showOverlay(false)
    }
    // A new frame, even with the same page, has a new API for it, and starts over.
  }, [frame, gatekeeperId, pickers])

  const { accentColor } = theme
  useEffect(() => {
    session.current?.updateTheme({ mode, accentColor })
  }, [mode, accentColor])

  return (
    <>
      <iframe
        ref={iframeRef}
        srcDoc={frame.iframeHtml}
        // Its own scripts, and the dialog its page asks before it is left with changes unsaved. No
        // origin, so it reaches nothing of the app's, and its page's policy lets it reach nothing else.
        sandbox="allow-scripts allow-modals"
        allow="clipboard-write"
        title={title}
        // Over everything but a dialog, which the person picker it may ask for is.
        className={overlay ? 'fixed inset-0 z-40 size-full border-0 bg-transparent' : 'block size-full border-0 bg-transparent'}
        style={{ colorScheme: mode }}
      />
      {picker && <GatekeeperUserPicker key={picker.id} picker={picker} gatekeeperId={gatekeeperId} appTitle={title} />}
    </>
  )
}
