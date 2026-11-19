import { createContext, use, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Dialog as BaseDialog } from '@cloudflare/kumo/primitives/dialog'
import { cn } from '@cloudflare/kumo/utils'
import { isMotionOff } from '@/prefs/motion'
import { pageMotion } from './dialogPageMotion'
import { SurfaceGlide } from './surfaceGlide'

/** Which of a dialog's pages it shows: `depth` says which way it goes to another, deeper being forward. */
export type DialogPage = { key: string; depth: number }

export type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Wider than most, for one that holds a service's own form, laid out for more room. */
  wide?: boolean
  /** Narrower than most, for one that holds little: a few lines of words and a card (a template's is 15rem wide), which it is about as wide as. */
  narrow?: boolean
  /**
   * Which page it shows, where it has several, one after another: it then stays as it goes from
   * one to the next, its surface taking the new page's size and the page sliding in where it
   * goes. A `Dialog` within it is the page it shows, drawn there rather than as a dialog of its
   * own, and what puts it away is that dialog's `onOpenChange`; its `open`, `wide` and `narrow` are this one's.
   */
  page?: DialogPage
  /** What it holds, with a `Dialog.Title` in it, which is what it is called. */
  children: ReactNode
}

// What a page's own `Dialog` is told of the page it is.
type PageContextValue = {
  /** The page is leaving, and is only drawn until it has gone. */
  leaving: boolean
  /** Makes what puts the page's dialog away what puts the whole away, until the returned function is called. */
  claim: (onOpenChange: (open: boolean) => void) => () => void
}
const PageContext = createContext<PageContextValue | undefined>(undefined)

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

// One page, and what its own `Dialog` is told of it.
const Page = ({ leaving, onClaim, children }: { leaving: boolean; onClaim: PageContextValue['claim']; children: ReactNode }) => {
  const value = useMemo(() => ({ leaving, claim: onClaim }), [leaving, onClaim])
  return (
    <PageContext value={value}>
      <div data-dialog-page={leaving ? 'leaving' : 'current'} inert={leaving} className="flex min-h-0 grow flex-col">
        {children}
      </div>
    </PageContext>
  )
}

// A dialog that is a page of another: what it holds, there, and the way it is put away.
const DialogAsPage = ({ page, onOpenChange, children }: { page: PageContextValue; onOpenChange: (open: boolean) => void; children: ReactNode }) => {
  useLayoutEffect(() => (page.leaving ? undefined : page.claim(onOpenChange)), [page, onOpenChange])
  return children
}

/**
 * Something that has the window to itself until it is answered or put away, in the middle of it
 * over everything else, which is dimmed and cannot be reached. Escape and a click beside it put it
 * away. It is no taller than the window: what is in it says which part scrolls.
 */
const DialogRoot = (props: DialogProps) => {
  const page = use(PageContext)
  return page ? <DialogAsPage page={page} onOpenChange={props.onOpenChange}>{props.children}</DialogAsPage> : <DialogSurface {...props} />
}

const DialogSurface = ({ open, onOpenChange, wide, narrow, page, children }: DialogProps) => {
  const key = page?.key ?? ''
  const depth = page?.depth ?? 0
  // What each page was last drawn with, so that one that leaves goes as it was.
  const drawn = useRef(children)
  useLayoutEffect(() => {
    drawn.current = children
  })
  const [shown, setShown] = useState({ key, depth, open })
  // The page going, while it does. Only from one page of an open dialog to the next: one opened
  // at another page starts there.
  const [leaving, setLeaving] = useState<{ key: string; children: ReactNode; forward: boolean }>()
  if (shown.key !== key || shown.open !== open) {
    setShown({ key, depth, open })
    if (shown.key !== key && open && shown.open) setLeaving({ key: shown.key, children: drawn.current, forward: depth >= shown.depth })
    else if (open && !shown.open) setLeaving(undefined)
  }

  // What puts each page's dialog away; the shown one's puts the whole away.
  const [owners] = useState(() => new Map<string, (open: boolean) => void>())
  const [claims] = useState(() => new Map<string, PageContextValue['claim']>())
  const claimFor = (pageKey: string) => {
    let claim = claims.get(pageKey)
    if (!claim) {
      claim = (owner) => {
        owners.set(pageKey, owner)
        return () => { if (owners.get(pageKey) === owner) owners.delete(pageKey) }
      }
      claims.set(pageKey, claim)
    }
    return claim
  }

  // The surface's width as last laid out, and that the arriving page was held at, which it leaves
  // at should another be gone to before it has settled. Its height glides by itself.
  const popupRef = useRef<HTMLDivElement>(null)
  const glide = useRef<SurfaceGlide>(undefined)
  const width = useRef<number>(undefined)
  const held = useRef<{ key: string; width: number }>(undefined)
  // The same function each render, so that the glide lasts as long as the surface does.
  const observe = useCallback((popup: HTMLDivElement | null) => {
    popupRef.current = popup
    if (!popup) return
    const glides = new SurfaceGlide(popup)
    glide.current = glides
    const observer = new ResizeObserver(() => { width.current = popup.offsetWidth })
    observer.observe(popup)
    return () => {
      observer.disconnect()
      glides.dispose()
      if (glide.current === glides) glide.current = undefined
    }
  }, [])

  useLayoutEffect(() => {
    const popup = popupRef.current
    const incoming = popup?.querySelector<HTMLElement>(':scope > [data-dialog-page="current"]')
    const outgoing = popup?.querySelector<HTMLElement>(':scope > [data-dialog-page="leaving"]')
    if (!leaving) return
    if (!popup || !incoming || !outgoing || !glide.current || width.current === undefined) {
      setLeaving(undefined)
      return
    }
    const from = width.current
    const leftWidth = held.current?.key === leaving.key ? held.current.width : from
    const leftHeight = glide.current.heightOf(outgoing) ?? outgoing.offsetHeight
    // The leaving page out of the flow, where it was and as big, at the top of the surface as the
    // new one is: the surface's height glides from the one's to the other's (`SurfaceGlide`).
    Object.assign(outgoing.style, {
      position: 'absolute',
      width: `${leftWidth}px`,
      height: `${leftHeight}px`,
      left: `calc(50% - ${leftWidth / 2}px)`,
      top: '0px',
    })
    // Each page as wide as once settled, in the middle of the surface, which is cut to its rounded
    // edge as it widens or narrows around them: a frame fixed in a page is cut by that rather than
    // by what scrolls it.
    const to = popup.offsetWidth
    held.current = { key, width: to }
    Object.assign(incoming.style, { position: 'relative', width: `${to}px`, alignSelf: 'center' })
    const uncut = glide.current.cut()
    glide.current.refresh()
    const reduced = isMotionOff()
    const targets = { surface: popup, incoming, outgoing }
    const animations = pageMotion({ from, to, forward: leaving.forward, reduced }).map(({ target, keyframes, options }) => targets[target].animate(keyframes, options))
    // Into the new page, unless it has taken the focus itself (a field's `autoFocus`).
    if (!incoming.contains(document.activeElement)) incoming.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true })
    let current = true
    void Promise.all(animations.map(({ finished }) => finished)).then(() => {
      if (!current) return
      held.current = undefined
      setLeaving(undefined)
    }, () => {})
    return () => {
      current = false
      for (const animation of animations) animation.cancel()
      uncut()
      for (const element of [incoming, outgoing]) {
        Object.assign(element.style, { position: '', width: '', height: '', left: '', top: '', alignSelf: '' })
      }
    }
  }, [leaving, key])

  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => (owners.get(key) ?? onOpenChange)(next)}>
      <BaseDialog.Portal>
        {/* Drawn for one opened from another too, which it dims as it dims the page. */}
        <BaseDialog.Backdrop forceRender className="fixed inset-0 z-50 bg-kumo-canvas/80 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        {/* A surface in it is a step less round than it is (`--surface-radius`), which whatever draws one there goes by.
            Centred by its margins rather than moved, so that what is fixed in it, such as a
            configurator's frame (`ResourceConfiguratorFrame`), is placed by the window while it is still.
            Its height glides to what it holds (`SurfaceGlide`). */}
        <BaseDialog.Popup ref={observe} className={cn(
          '[--surface-radius:1rem] fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-3xl bg-kumo-base text-base text-kumo-default ring-1 ring-kumo-contrast/6 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none',
          wide && 'w-[min(40rem,calc(100vw-1.5rem))]',
          narrow && 'w-[min(21rem,calc(100vw-1.5rem))]',
        )}>
          {page ? (
            <>
              {leaving && <Page key={leaving.key} leaving onClaim={claimFor(leaving.key)}>{leaving.children}</Page>}
              <Page key={key} leaving={false} onClaim={claimFor(key)}>{children}</Page>
            </>
          ) : children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

// Those of a page that is leaving are only drawn: the dialog is called and described by the page shown.
const DialogTitle = ({ className, children }: { className?: string; children: ReactNode }) =>
  use(PageContext)?.leaving ? <h2 className={className}>{children}</h2> : <BaseDialog.Title className={className}>{children}</BaseDialog.Title>

const DialogDescription = ({ className, children }: { className?: string; children: ReactNode }) =>
  use(PageContext)?.leaving ? <p className={className}>{children}</p> : <BaseDialog.Description className={className}>{children}</BaseDialog.Description>

export const Dialog = Object.assign(DialogRoot, {
  Title: DialogTitle,
  Description: DialogDescription,
  Close: BaseDialog.Close,
})
