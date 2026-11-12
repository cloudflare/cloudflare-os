import { useEffectEvent, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from 'motion/react'
import {
  ArrowClockwiseIcon, ArrowLineRightIcon, ArrowsInSimpleIcon, ArrowsOutSimpleIcon, CaretDownIcon, CheckIcon, DotsThreeIcon, XIcon,
} from '@phosphor-icons/react'
import { AvatarStack, type AvatarStackProps } from '@/components/AvatarStack'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { Grabber } from '@/components/Grabber'
import { HeaderBubble } from '@/components/HeaderBubble'
import { LogoIcon } from '@/components/LogoIcon'
import { clampSize, resistSize } from '@/components/resizing'
import { CopyLinkButton } from './CopyLinkButton'
import { SidePaneTitle } from './SidePaneTitle'

export type SidePaneItem = {
  key: string
  /** What it is: a file's name, an output's title. */
  title: string
  /** What kind of thing it is. */
  icon?: ReactElement
}

export type SidePaneProps = {
  /** Everything that is open, in the order it was opened. There may be nothing. */
  items: SidePaneItem[]
  /** The one that is shown. */
  activeKey?: string
  onSelect: (key: string) => void
  onCloseItem: (key: string) => void
  onCloseAll: () => void
  /** Puts the pane away, with what is open still open. */
  onHide: () => void
  /** Who else is looking at the one shown. */
  people?: AvatarStackProps['people']
  /** An address for the one shown, to copy. */
  link?: string
  /** Loads the one shown again. */
  onReload?: () => void
  /** The pane fills the window. */
  fullScreen: boolean
  onFullScreenChange: (on: boolean) => void
  /** The app's mark, which leads the header while the pane fills the window, was clicked. */
  onHome: () => void
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
 * What was opened beside the page: a header, then what it shows on a surface of its own.
 *
 * The header has how many things are open, which opens to a list to go between them or close
 * them all, then the name of the one shown, which closes it. At the far end are who else is
 * looking at it, more that can be done with it, a link to it, the way to have the pane fill the
 * window, and the way to put the pane away. Filling the window, the header is the app's mark
 * (`onHome`), the name, who else is there, the link, and the way back.
 *
 * What is shown fills the card under the header, out to its sides and bottom, with rounded top
 * corners and a line along the top. The bar at its top pushes the header up out of the way, and
 * pulls it back down. Filling the window, the corners square off as the header goes.
 */
export const SidePane = ({
  items, activeKey, onSelect, onCloseItem, onCloseAll, onHide, people = [], link, onReload, fullScreen, onFullScreenChange, onHome, children,
}: SidePaneProps) => {
  const active = items.find(({ key }) => key === activeKey)
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
  // Filling the window, the card has no corners for the surface's to meet, so they straighten as
  // the header goes, and are square at the window's top.
  const corner = useMotionValue(CORNER)
  const shapeCorners = useEffectEvent(() => corner.set(fullScreen ? CORNER * clampSize(reveal.get(), 0, 1) : CORNER))
  useMotionValueEvent(reveal, 'change', shapeCorners)
  useLayoutEffect(() => shapeCorners(), [fullScreen])

  return (
    <section aria-label={active?.title ?? 'Side pane'} className="flex min-h-0 flex-1 flex-col">
      <motion.div style={{ marginTop: headerOffset }} inert={!headerShown} className="shrink-0">
        <header style={{ height: HEADER_HEIGHT }} className="flex items-center gap-1.5 px-3">
          {fullScreen && (
            <HeaderBubble>
              {/* As the sidebar has it. */}
              <Button icon={<LogoIcon />} aria-label="Back to the chat" title="Back to the chat" className="[&>svg]:size-[1.5em]" onClick={onHome} />
            </HeaderBubble>
          )}
          {!fullScreen && items.length > 1 && (
            <HeaderBubble>
              <DropdownMenu
                aria-label={`Switch between the ${items.length} that are open`}
                triggerVariant="ghost"
                keepTrigger
                triggerClassName="bg-kumo-tint px-3 text-kumo-subtle ring-1 ring-kumo-line hover:text-kumo-default"
                label={(
                  <span className="flex items-center gap-1.5 tabular-nums">
                    {items.length}
                    <CaretDownIcon aria-hidden="true" weight="bold" className="size-3" />
                  </span>
                )}
              >
                {items.map(({ key, title, icon }) => (
                  <DropdownMenu.Item key={key} label={title} onSelect={() => onSelect(key)}>
                    {icon && <span className="flex shrink-0 text-kumo-subtle [&>svg]:size-[1.125em]">{icon}</span>}
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {key === activeKey && (
                      <>
                        <CheckIcon aria-hidden="true" weight="bold" className="size-3.5 shrink-0" />
                        <span className="sr-only">(shown)</span>
                      </>
                    )}
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator />
                <DropdownMenu.Item icon={XIcon} onSelect={onCloseAll}>Close all</DropdownMenu.Item>
              </DropdownMenu>
            </HeaderBubble>
          )}
          {active && (
            // Keyed, so that going to another swaps the bubble rather than renaming it.
            <HeaderBubble key={active.key} className="min-w-0">
              {/* Filling the window, it is only what is shown. */}
              <SidePaneTitle title={active.title} icon={active.icon} onClose={fullScreen ? undefined : () => onCloseItem(active.key)} />
            </HeaderBubble>
          )}
          <span className="ms-auto flex shrink-0 items-center gap-1.5">
            {people.length > 0 && (
              <HeaderBubble className="me-1.5">
                <AvatarStack people={people} aria-label="Also here" />
              </HeaderBubble>
            )}
            {/* Filling the window, it closes nothing: only reloads, when there is that. */}
            {active && (!fullScreen || onReload) && (
              <HeaderBubble>
                <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${active.title}`} align="end">
                  {onReload && <DropdownMenu.Item icon={ArrowClockwiseIcon} onSelect={onReload}>Reload</DropdownMenu.Item>}
                  {!fullScreen && <DropdownMenu.Item icon={XIcon} onSelect={() => onCloseItem(active.key)}>Close</DropdownMenu.Item>}
                </DropdownMenu>
              </HeaderBubble>
            )}
            {active && link && (
              <HeaderBubble>
                <CopyLinkButton link={link} title={active.title} />
              </HeaderBubble>
            )}
            {active && (
              // Keyed, so that the one button swaps for the other.
              <HeaderBubble key={fullScreen ? 'collapse' : 'expand'}>
                {fullScreen
                  ? <Button icon={ArrowsInSimpleIcon} aria-label="Exit full screen" title="Exit full screen" onClick={() => onFullScreenChange(false)} />
                  : <Button icon={ArrowsOutSimpleIcon} aria-label="Full screen" title="Full screen" onClick={() => onFullScreenChange(true)} />}
              </HeaderBubble>
            )}
            {!fullScreen && (
              <HeaderBubble>
                <Button icon={ArrowLineRightIcon} aria-label="Hide pane" title="Hide pane" onClick={onHide} />
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
