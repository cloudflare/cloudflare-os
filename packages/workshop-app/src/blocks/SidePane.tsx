import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from 'motion/react'
import {
  AppWindowIcon, ArrowClockwiseIcon, ArrowLeftIcon, ArrowLineRightIcon, ArrowsInSimpleIcon, ArrowsOutSimpleIcon, CaretDownIcon, CheckIcon,
  CodeIcon, CornersInIcon, CornersOutIcon, DotsThreeIcon, DownloadSimpleIcon, GearSixIcon, LayoutIcon, LinkIcon, UserPlusIcon,
} from '@phosphor-icons/react'
import { AvatarStack, type AvatarStackProps } from '@/components/AvatarStack'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { Grabber } from '@/components/Grabber'
import { HeaderBubble } from '@/components/HeaderBubble'
import { clampSize, resistSize } from '@/components/resizing'
import { CopyLinkButton } from './CopyLinkButton'
import { ExportSubmenu, type ExportSubmenuProps } from './ExportSubmenu'
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
      /** The workspace it is in, which its header starts with, as a chat's does. */
      workspace?: WorkspaceCrumbProps
      /** The way to a chat with it beside it (`GadgetChatMenu`), for whoever builds where it is. */
      chat?: Omit<GadgetChatMenuProps, 'title' | 'compact'>
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
  /** What the one shown, a gadget, can be exported as and saved to (`ExportSubmenu`). */
  exports?: ExportSubmenuProps
  /** Goes to the settings of the one shown, a gadget, for whoever may change it. */
  onOpenSettings?: () => void
  /** Shows the code of the one shown, a gadget, in its place, or goes back to it from its code. */
  onViewCode?: () => void
  /** Its code is shown in its place (`onViewCode`), which the title says, with the way back. */
  viewingCode?: boolean
  /** Shares the one shown with people, for whoever may, from a button of its own in place of the link's. */
  onShare?: () => void
  /** Updates the one shown, a gadget, from the newer version its template has, for whoever may. */
  onUpdate?: () => void
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

// Refused without permission, and missing on a page not served securely: nothing is copied.
const copyLink = (link: string) => void navigator.clipboard.writeText(link).catch(() => {})

/**
 * A file or an output: a header, then what it shows on a surface of its own.
 *
 * It grows in steps, and the end of its header has the step up, with the step down in the same
 * place: beside the page it expands to take the page's place; expanded, it collapses back and
 * fills the window; filling the window, it goes back. Before those are who else is looking at it,
 * more that can be done with it (exporting it, updating a gadget whose template has a newer
 * version, and beside the page putting the pane away), and sharing it where it can be shared, its
 * link then copied from more, or else a link to it. Beside the page, the header starts with how many
 * things the page has to show, which opens to the list of them, then the name of the one shown. As
 * the page, it starts with the workspace it is in, and before the rest at its end is the way to a
 * chat with it beside it.
 *
 * What is shown fills the card under the header, out to its sides and bottom, with rounded top
 * corners and a line along the top. The bar at its top pushes the header up out of the way, and
 * pulls it back down. Filling the window, the corners square off as the header goes.
 */
export const SidePane = (props: SidePaneProps) => {
  const { active, people = [], link, onReload, onDownload, exports, onOpenSettings, onViewCode, viewingCode = false, onShare, onUpdate, narrow = false, children } = props
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
              <SidePaneTitle
                title={active.title}
                icon={active.icon}
                trail={viewingCode && onViewCode ? { label: 'Code', icon: <CodeIcon />, onBack: onViewCode } : undefined}
              />
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
            {(beside || (active && (onReload || onDownload || exports || onOpenSettings || onViewCode || (onShare && link) || onUpdate))) && (
              <HeaderBubble>
                <DropdownMenu icon={DotsThreeIcon} aria-label={active ? `More for ${active.title}` : 'More'} align="end">
                  {onReload && <DropdownMenu.Item icon={ArrowClockwiseIcon} onSelect={onReload}>Reload</DropdownMenu.Item>}
                  {onDownload && <DropdownMenu.Item icon={DownloadSimpleIcon} onSelect={onDownload}>Download</DropdownMenu.Item>}
                  {exports && <ExportSubmenu {...exports} />}
                  {onShare && link && <DropdownMenu.Item icon={LinkIcon} onSelect={() => copyLink(link)}>Copy link</DropdownMenu.Item>}
                  {onViewCode && (viewingCode
                    ? <DropdownMenu.Item icon={AppWindowIcon} onSelect={onViewCode}>Back to {active?.title ?? 'it'}</DropdownMenu.Item>
                    : <DropdownMenu.Item icon={CodeIcon} onSelect={onViewCode}>View code</DropdownMenu.Item>)}
                  {onOpenSettings && <DropdownMenu.Item icon={GearSixIcon} onSelect={onOpenSettings}>Gadget settings</DropdownMenu.Item>}
                  {onUpdate && (
                    <DropdownMenu.Item icon={LayoutIcon} onSelect={onUpdate} label="Update from template">
                      <span className="min-w-0 flex-1">Update from template…</span>
                      <span className="shrink-0 text-(length:--menu-detail-text) text-kumo-brand">New version</span>
                    </DropdownMenu.Item>
                  )}
                  {beside && <DropdownMenu.Item icon={ArrowLineRightIcon} onSelect={beside.onHide}>Hide pane</DropdownMenu.Item>}
                </DropdownMenu>
              </HeaderBubble>
            )}
            {/* Keyed, so that the one button swaps for the other. */}
            {active && onShare && (
              <HeaderBubble key="share">
                <Button icon={UserPlusIcon} aria-label="Share" title="Share" onClick={onShare} />
              </HeaderBubble>
            )}
            {active && link && !onShare && (
              <HeaderBubble key="copy-link">
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
        </motion.div>
      )}
    </section>
  )
}
