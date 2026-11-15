import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from 'motion/react'
import {
  ArrowClockwiseIcon, ArrowLeftIcon, ArrowSquareOutIcon, ArrowLineRightIcon, ArrowsInSimpleIcon, ArrowsOutSimpleIcon, CaretDownIcon, CheckIcon,
  CaretLeftIcon, CaretRightIcon, CornersInIcon, CornersOutIcon, DotsThreeIcon, DownloadSimpleIcon, ExportIcon, CodeIcon, GearSixIcon, XIcon,
} from '@phosphor-icons/react'
import { AvatarStack, type AvatarStackProps } from '@/components/AvatarStack'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { Grabber } from '@/components/Grabber'
import { HeaderBubble } from '@/components/HeaderBubble'
import { clampSize, resistSize } from '@/components/resizing'
import { ShimmerText } from '@/components/ShimmerText'
import { useMenuPages } from '@/components/useMenuPages'
import { CopyLinkButton } from './CopyLinkButton'
import { GadgetChatMenu, type GadgetChatMenuProps } from './GadgetChatMenu'
import { SidePaneTitle } from './SidePaneTitle'
import { WorkspaceCrumb, type WorkspaceCrumbProps } from './WorkspaceCrumb'

export type SidePaneItem = {
  key: string
  /** What it is: a file's name, an output's title. */
  title: string
  /** What kind of thing it is. */
  icon?: ReactElement
}

type Placement =
  /** Beside the page, showing one of what the page has, such as what its workspace made. */
  | {
      placement: 'beside'
      /** What there is to show, most recent first. There may be nothing. */
      items: SidePaneItem[]
      onSelect: (key: string) => void
      /** Puts the pane away. */
      onHide: () => void
      /** Has the one shown take the page's place, when it can: the step up from beside it. */
      onExpand?: () => void
    }
  /** The page itself. */
  | {
      placement: 'page'
      /** Back beside the page it was expanded from, when it was: the step down. */
      onCollapse?: () => void
      /** Filling the window, for nothing but it: the step up. */
      fullScreen: boolean
      onFullScreenChange: (on: boolean) => void
      /** The workspace it is in, which its header starts with, as a chat's does, when it is a named one. */
      workspace?: WorkspaceCrumbProps
      /** The way to a chat with it beside it (`GadgetChatMenu`), for whoever builds where it is. */
      chat?: Omit<GadgetChatMenuProps, 'title' | 'compact'>
    }

/**
 * The kinds of file the one shown can be saved as, read when they are asked for, and the export
 * under way or the last that failed, which the header says.
 */
export type SidePaneExports = {
  formats:
    | { status: 'unread' | 'loading' }
    | { status: 'ready'; formats: readonly { id: string; label: string; fileExtension: string }[] }
    | { status: 'failed'; message: string }
  /** Reads the formats, as the list of them is shown. */
  onRead: () => void
  onExport: (id: string) => void
  progress?: { status: 'exporting'; label: string } | { status: 'failed'; label: string; message: string }
  onDismiss: () => void
}

export type SidePaneProps = Placement & {
  /** The one shown. Beside the page it need not be among the items: it was opened from elsewhere. */
  active?: SidePaneItem
  /** Who else is looking at the one shown. */
  people?: AvatarStackProps['people']
  /** An address for the one shown, to copy. */
  link?: string
  /** Loads the one shown again. */
  onReload?: () => void
  /** Saves the one shown to this device. */
  onDownload?: () => void
  /** Where the one shown opens in its own editor, such as a Google Doc's: "Open in Docs". */
  openIn?: { label: string; href: string }
  /** Shares the one shown with other people. */
  onShare?: () => void
  /** Goes to the one shown's own settings: a gadget's. */
  onOpenSettings?: () => void
  /** Goes to the code of the one shown: a gadget's, on its settings page. */
  onViewCode?: () => void
  /** Saves the one shown as a file of a kind it offers, such as a gadget as a PDF. */
  exports?: SidePaneExports
  /**
   * Filling a narrow screen, such as a phone's, where it is as big as it gets already: there is no
   * step up, and the step down is a back button at the start of the header.
   */
  narrow?: boolean
  /** What is shown of the one shown. */
  children: ReactNode
}

// The header's height, which is how far it goes up to be put away.
const HEADER_HEIGHT = 60
const TUCK = HEADER_HEIGHT
// The surface's top corners, the card's own (`rounded-3xl`).
const CORNER = 24
// Pulled this far out of where it was, the header goes the rest of the way when let go.
const COMMITS_AT = 0.2

/**
 * A file or an output: a header, then what it shows on a surface of its own.
 *
 * It grows in steps, and the end of its header has the step up, with the step down in the same
 * place: beside the page it expands to take the page's place; expanded, it collapses back and
 * fills the window; filling the window, it goes back. Before those are who else is looking at it,
 * more that can be done with it (which beside the page includes putting the pane away), and a link
 * to it. Beside the page, the header starts with how many things the page has to show, which
 * opens to the list of them, then the name of the one shown. As the page, it starts with the
 * workspace it is in, and before the rest at its end is the way to a chat with it beside it.
 *
 * What is shown fills the card under the header, out to its sides and bottom, with rounded top
 * corners and a line along the top. The bar at its top pushes the header up out of the way, and
 * pulls it back down. Filling the window, the corners square off as the header goes.
 */
export const SidePane = (props: SidePaneProps) => {
  const { active, people = [], link, onReload, onDownload, openIn, onShare, onOpenSettings, onViewCode, exports, narrow = false, children } = props
  const fullScreen = props.placement === 'page' && props.fullScreen
  const reduceMotion = useReducedMotion() ?? false

  // How far out the header is, 0 to 1. A motion value, so that dragging renders nothing again.
  const [headerShown, setHeaderShown] = useState(true)
  const reveal = useMotionValue(1)
  const grabbed = useRef(1)
  const headerOffset = useTransform(reveal, (amount) => -(1 - amount) * TUCK)
  const showHeader = (shown: boolean) => {
    setHeaderShown(shown)
    if (reduceMotion) reveal.jump(shown ? 1 : 0)
    else animate(reveal, shown ? 1 : 0, { type: 'spring', duration: 0.3, bounce: 0.1 })
  }

  // With the header away, the surface's top is the card's, which has an edge of its own.
  const lineOpacity = useTransform(reveal, [0, 0.5], [0, 1])
  // Filling the window, full screen or on a narrow screen, the card has no corners for the
  // surface's to meet, so they straighten as the header goes, and are square at the window's top.
  const corner = useMotionValue(CORNER)
  const fillsWindow = fullScreen || narrow
  const shapeCorners = useEffectEvent(() => corner.set(fillsWindow ? CORNER * clampSize(reveal.get(), 0, 1) : CORNER))
  useMotionValueEvent(reveal, 'change', shapeCorners)
  useLayoutEffect(() => shapeCorners(), [fillsWindow])

  const beside = props.placement === 'beside' ? props : undefined
  const page = props.placement === 'page' ? props : undefined
  const listed = beside?.items.some(({ key }) => key === active?.key) ?? true
  const choices = beside && (listed ? beside.items : active ? [active, ...beside.items] : beside.items)
  const stepDown = beside ? beside.onHide : page?.onCollapse

  return (
    <section aria-label={active?.title ?? 'Side pane'} className="flex min-h-0 flex-1 flex-col">
      <motion.div style={{ marginTop: headerOffset }} inert={!headerShown} className="shrink-0">
        <header style={{ height: HEADER_HEIGHT }} className="flex items-center gap-1.5 px-3">
          {narrow && stepDown && (
            <HeaderBubble key="back">
              <Button icon={ArrowLeftIcon} aria-label="Back" title="Back" onClick={stepDown} />
            </HeaderBubble>
          )}
          {beside && choices && choices.length > 1 && (
            <HeaderBubble>
              <DropdownMenu
                aria-label={`Switch between the ${beside.items.length} in this workspace`}
                triggerVariant="ghost"
                keepTrigger
                triggerClassName="bg-kumo-tint px-3 text-kumo-subtle ring-1 ring-kumo-line hover:text-kumo-default"
                label={(
                  <span className="flex items-center gap-1.5 tabular-nums">
                    {beside.items.length}
                    <CaretDownIcon aria-hidden="true" weight="bold" className="size-3" />
                  </span>
                )}
              >
                {choices.map(({ key, title, icon }) => (
                  <DropdownMenu.Item key={key} label={title} onSelect={() => beside.onSelect(key)}>
                    {icon && <span className="flex shrink-0 text-kumo-subtle [&>svg]:size-[1.125em]">{icon}</span>}
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {key === active?.key && (
                      <>
                        <CheckIcon aria-hidden="true" weight="bold" className="size-3.5 shrink-0" />
                        <span className="sr-only">(shown)</span>
                      </>
                    )}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu>
            </HeaderBubble>
          )}
          {page?.workspace && !fullScreen && !narrow && <WorkspaceCrumb {...page.workspace} />}
          {active && (
            // Keyed, so that going to another swaps the bubble rather than renaming it.
            <HeaderBubble key={active.key} className="min-w-0">
              <SidePaneTitle title={active.title} icon={active.icon} />
            </HeaderBubble>
          )}
          <span className="ms-auto flex shrink-0 items-center gap-1.5">
            {people.length > 0 && (
              <HeaderBubble className="me-1.5">
                <AvatarStack people={people} aria-label="Also here" />
              </HeaderBubble>
            )}
            {page?.chat && active && !fullScreen && (
              <HeaderBubble key="chat">
                <GadgetChatMenu {...page.chat} title={active.title} compact={narrow} />
              </HeaderBubble>
            )}
            {(beside || (active && (onReload || onDownload || openIn || onShare || onOpenSettings || onViewCode || exports))) && (
              <HeaderBubble>
                <MoreMenu
                  title={active?.title}
                  onShare={onShare}
                  onReload={onReload}
                  openIn={openIn}
                  onDownload={onDownload}
                  exports={active ? exports : undefined}
                  onOpenSettings={onOpenSettings}
                  onViewCode={onViewCode}
                  onHide={beside?.onHide}
                />
              </HeaderBubble>
            )}
            {active && link && (
              <HeaderBubble>
                <CopyLinkButton link={link} title={active.title} />
              </HeaderBubble>
            )}
            {/* Keyed, so that expanding swaps the one button for the other in its place. */}
            {beside?.onExpand && active && !narrow && (
              <HeaderBubble key="expand">
                <Button icon={ArrowsOutSimpleIcon} aria-label="Expand" title="Expand" onClick={beside.onExpand} />
              </HeaderBubble>
            )}
            {page?.onCollapse && !fullScreen && !narrow && (
              <HeaderBubble key="collapse">
                <Button icon={ArrowsInSimpleIcon} aria-label="Collapse" title="Collapse" onClick={page.onCollapse} />
              </HeaderBubble>
            )}
            {page && !narrow && (
              // Keyed, so that the one button swaps for the other.
              <HeaderBubble key={fullScreen ? 'exit-full-screen' : 'full-screen'}>
                {fullScreen
                  ? <Button icon={CornersInIcon} aria-label="Exit full screen" title="Exit full screen" onClick={() => page.onFullScreenChange(false)} />
                  : <Button icon={CornersOutIcon} aria-label="Full screen" title="Full screen" onClick={() => page.onFullScreenChange(true)} />}
              </HeaderBubble>
            )}
          </span>
        </header>
      </motion.div>
      {/* With nothing shown, there is nothing to make room for: no surface, and no bar. */}
      {!active ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        // Its top corners are the card's, so that they meet them with the header away.
        <motion.div
          style={{ borderTopLeftRadius: corner, borderTopRightRadius: corner }}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-kumo-tint"
        >
          <motion.span
            style={{ opacity: lineOpacity, borderTopLeftRadius: corner, borderTopRightRadius: corner }}
            className="pointer-events-none absolute inset-0 z-10 border-t border-kumo-line"
          />
          <Grabber
            aria-label={headerShown ? 'Hide the header' : 'Show the header'}
            expanded={headerShown}
            className="absolute top-0 left-1/2 z-10 -translate-x-1/2"
            onDragStart={() => {
              reveal.stop()
              grabbed.current = reveal.get()
            }}
            onDrag={(offset) => reveal.set(resistSize(grabbed.current * TUCK + offset, 0, TUCK) / TUCK)}
            onDragEnd={(offset) => {
              const amount = clampSize(reveal.get(), 0, 1)
              showHeader(offset > 0 ? amount > COMMITS_AT : amount > 1 - COMMITS_AT)
            }}
            onToggle={() => showHeader(!headerShown)}
          />
          {children}
          <ExportStatus progress={exports?.progress} onDismiss={exports?.onDismiss} />
        </motion.div>
      )}
    </section>
  )
}

type MoreMenuProps = Pick<SidePaneProps, 'onShare' | 'onReload' | 'openIn' | 'onDownload' | 'exports' | 'onOpenSettings' | 'onViewCode'> & {
  title?: string
  onHide?: () => void
}

/** More that can be done with the one shown; Export shows the formats it offers in the menu's place. */
const MoreMenu = ({ title, onShare, onReload, openIn, onDownload, exports, onOpenSettings, onViewCode, onHide }: MoreMenuProps) => {
  const { page, show, rows, onOpenChangeComplete } = useMenuPages<'more' | 'export'>('more')
  const exporting = exports?.progress?.status === 'exporting'
  const formats = exports?.formats
  return (
    <DropdownMenu icon={DotsThreeIcon} aria-label={title ? `More for ${title}` : 'More'} align="end" onOpenChangeComplete={onOpenChangeComplete}>
      <div ref={rows}>
        {page === 'export' && exports && formats ? (
          <>
            <DropdownMenu.Item icon={CaretLeftIcon} onSelect={() => show('more')} keepsOpen label="Back">
              <span className="text-kumo-subtle">Export</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            {formats.status === 'ready' && formats.formats.length > 0 ? formats.formats.map((format) => (
              <DropdownMenu.Item key={format.id} label={format.label} disabled={exporting} onSelect={() => exports.onExport(format.id)}>
                {/* In the icons' column, so the formats line up under the rows' names. */}
                <span aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{format.label}</span>
                <span className="text-sm text-kumo-subtle">{format.fileExtension}</span>
              </DropdownMenu.Item>
            )) : formats.status === 'failed' ? (
              <>
                <p role="alert" className="max-w-64 py-2 ps-10 pe-3 text-sm text-pretty text-kumo-danger">Couldn’t read what it can be saved as. {formats.message}</p>
                <DropdownMenu.Item icon={ArrowClockwiseIcon} keepsOpen onSelect={exports.onRead}>Try again</DropdownMenu.Item>
              </>
            ) : formats.status === 'ready' ? (
              <p className="max-w-64 py-2 ps-10 pe-3 text-sm text-pretty text-kumo-subtle">It can’t be saved as a file.</p>
            ) : (
              <p role="status" className="py-2 ps-10 pe-3 text-sm text-kumo-subtle"><ShimmerText>Reading its formats…</ShimmerText></p>
            )}
          </>
        ) : (
          <>
            {onShare && <DropdownMenu.Item icon={ExportIcon} onSelect={onShare}>Share…</DropdownMenu.Item>}
            {onReload && <DropdownMenu.Item icon={ArrowClockwiseIcon} onSelect={onReload}>Reload</DropdownMenu.Item>}
            {openIn && <DropdownMenu.Item icon={ArrowSquareOutIcon} onSelect={() => window.open(openIn.href, '_blank', 'noopener')}>{openIn.label}</DropdownMenu.Item>}
            {onDownload && <DropdownMenu.Item icon={DownloadSimpleIcon} onSelect={onDownload}>Download</DropdownMenu.Item>}
            {exports && (
              <DropdownMenu.Item
                icon={DownloadSimpleIcon}
                keepsOpen
                label="Export"
                row="export"
                onSelect={() => {
                  // Read each time, as its code may have changed since.
                  exports.onRead()
                  show('export')
                }}
              >
                <span className="flex-1">Export</span>
                <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
              </DropdownMenu.Item>
            )}
            {onViewCode && <DropdownMenu.Item icon={CodeIcon} onSelect={onViewCode}>View code</DropdownMenu.Item>}
            {onOpenSettings && <DropdownMenu.Item icon={GearSixIcon} onSelect={onOpenSettings}>Gadget settings</DropdownMenu.Item>}
            {onHide && <DropdownMenu.Item icon={ArrowLineRightIcon} onSelect={onHide}>Hide pane</DropdownMenu.Item>}
          </>
        )}
      </div>
    </DropdownMenu>
  )
}

/**
 * The export under way, or why the last failed until it is put away: a pill floating at the foot of
 * what is shown, which has room for it however narrow the header is, and stays while the header is
 * pushed away.
 */
const ExportStatus = ({ progress, onDismiss }: { progress: SidePaneExports['progress']; onDismiss?: () => void }) => {
  const transition = useReducedMotion() ? { duration: 0 } : { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const }
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <AnimatePresence initial={false}>
        {progress && (
          <motion.div
            key={progress.status}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={transition}
            className="pointer-events-auto flex max-w-md min-w-0 items-center gap-1 rounded-[18px] bg-kumo-base py-1 ps-4 pe-1 text-sm shadow-[0_6px_24px_rgba(0,0,0,0.08)] ring-1 ring-kumo-contrast/6"
          >
            {progress.status === 'exporting' ? (
              <span role="status" className="flex min-h-7 items-center pe-3 text-kumo-subtle">
                <ShimmerText>Exporting {progress.label}…</ShimmerText>
              </span>
            ) : (
              <>
                <span role="alert" className="min-w-0 py-1 text-pretty text-kumo-danger">Couldn’t export {progress.label}. {progress.message}</span>
                <Button
                  variant="ghost"
                  icon={<XIcon weight="bold" />}
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={onDismiss}
                  className="size-7 shrink-0 self-start text-kumo-subtle hover:text-kumo-default [&>svg]:size-3"
                />
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
