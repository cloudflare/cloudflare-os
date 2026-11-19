import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform } from 'motion/react'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import {
  ArrowClockwiseIcon, ArrowLeftIcon, ArrowLineRightIcon, ArrowsInSimpleIcon, ArrowsOutSimpleIcon,
  CodeIcon, CornersInIcon, CornersOutIcon, DotsThreeIcon, DownloadSimpleIcon, EyeIcon, CheckIcon, FileArrowDownIcon, GearSixIcon, ShareNetworkIcon, XIcon,
} from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { AvatarStack, type AvatarStackProps } from '@/components/AvatarStack'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { Illustration } from '@/components/Illustration'
import { Grabber } from '@/components/Grabber'
import { HeaderBubble } from '@/components/HeaderBubble'
import { clampSize, resistSize } from '@/components/resizing'
import { IconSwitch } from '@/components/IconSwitch'
import { motionTransition } from '@/hooks/motionTransition'
import { CopyLinkButton } from './CopyLinkButton'
import { ExportItems, type ExportItemsProps } from './ExportItems'
import { GadgetChatMenu, type GadgetChatMenuProps } from './GadgetChatMenu'
import { AgentsBubble, type AgentsBubbleProps } from './AgentsBubble'
import { SidePaneTitle } from './SidePaneTitle'

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
      /**
       * Filling the window, for nothing but it: the step up. Gone into, the header goes away by
       * itself after a moment, the once, and the bar that brings it back fades while it is away,
       * unless the pointer is near the top (`pointerNearTop`).
       */
      fullScreen: boolean
      onFullScreenChange: (on: boolean) => void
      /** The pointer is near the window's top, where the bar shows again in full screen. */
      pointerNearTop?: boolean
      /** The way to a chat with it beside it (`GadgetChatMenu`), for whoever builds where it is. */
      chat?: Omit<GadgetChatMenuProps, 'title' | 'compact'>
    }

export type SidePaneProps = Placement & {
  /** The one shown. There may be none. */
  active?: SidePaneItem
  /** Who else is looking at the one shown. */
  people?: AvatarStackProps['people']
  /** An address for the one shown, to copy. */
  link?: string
  /** Loads the one shown again. */
  onReload?: () => void
  /** Saves the one shown to this device. */
  onDownload?: () => void
  /** What the one shown, a gadget, can be exported as and saved to, from more (`ExportItems`). */
  exports?: ExportItemsProps
  /** Goes to the settings of the one shown, a gadget, for whoever may change it, from its menu and its title. */
  onOpenSettings?: () => void
  /**
   * Toggles showing the code of the one shown, a gadget, in its place, from the header's switch.
   * Left out where it has none to show.
   */
  onViewCode?: () => void
  /** Its code is shown in its place (`onViewCode`), which the title says, with the way back. */
  viewingCode?: boolean
  /**
   * Invites people to use the one shown, with the same data as everyone else, for whoever may.
   * With `onCreateTemplate`, from a menu of its own in place of the link's button.
   */
  onInvite?: () => void
  /**
   * Where the one shown stands as a template, for whoever may make one, which the Share menu's item
   * says: none yet (Create template), one with changes to release (Release update), or one up to
   * date (Copy template link, which `onOpen` does). `copy` is how the last copying of the link went,
   * for a moment, which the Share button says with a tick or a cross in place of its icon.
   */
  template?: { stands: 'none' | 'changes' | 'current'; onOpen: () => void; copy?: 'copied' | 'failed' }
  /**
   * Filling a narrow screen, such as a phone's, where it is as big as it gets already: there is no
   * step up, and the step down is a back button at the start of the header.
   */
  narrow?: boolean
  /** The agents the one shown, a gadget, starts, after its title (`AgentsBubble`). */
  agents?: AgentsBubbleProps
  /** What is shown of the one shown. */
  children: ReactNode
}

// The header's height, which is how far it goes up to be put away.
const HEADER_HEIGHT = 60
const TUCK = HEADER_HEIGHT
// The surface's top corners, the card's own (`rounded-3xl`).
// What the template's item says, by where the app stands as one.
const TEMPLATE_ITEMS = {
  none: { label: 'Create template', description: 'Let others copy your app' },
  changes: { label: 'Release update', description: 'Release your latest changes to the template' },
  current: { label: 'Copy template link', description: 'Let others copy your app' },
} as const

const ShareItems = ({ onInvite, template }: Pick<SidePaneProps, 'onInvite' | 'template'>) => {
  const item = template && TEMPLATE_ITEMS[template.stands]
  return (
    <>
      {onInvite && (
        <DropdownMenu.Item illustration={<Illustration name="invite" />} onSelect={onInvite} description="Let others use this app with you">Invite people</DropdownMenu.Item>
      )}
      {template && item && (
        <DropdownMenu.Item illustration={<Illustration name="template" />} onSelect={template.onOpen} description={item.description}>{item.label}</DropdownMenu.Item>
      )}
    </>
  )
}

const CORNER = 24
// Pulled this far out of where it was, the header goes the rest of the way when let go.
const COMMITS_AT = 0.2
// A header narrower than this, in pixels, is crammed: its name is left a few letters, and what it
// shares goes into more.
const CRAMPED_BELOW = 460
// The most the header can be tugged down on, with it all the way out: it snaps away at once, where
// let go of short of it, after any tug down, it rolls up all the same.
const TUG_AT = 120
// How long after going into full screen the header goes away by itself, in milliseconds.
const AWAY_AFTER = 1000

/**
 * A file or an output: a header, then what it shows on a surface of its own.
 *
 * It grows in steps, which are at the end of its header, and the way to put it away is there too:
 * beside the page the button is Hide, which puts the pane away, and expanding it to take the page's
 * place is in more; expanded, it collapses back and fills the window; filling the window, it goes
 * back. Before those are who else is looking at it, more (reloading it, downloading a file, its code,
 * its settings, which is where it is exported, made into a template, updated, renamed and deleted,
 * and beside the page expanding it), and sharing it where it can be shared (a menu of Invite user
 * and Create template), which goes into more where the header has no room for it, as does the
 * switch to its code on a phone,
 * or else a button to copy the link. The header starts with the name of the one shown, which for a gadget goes to
 * its settings; as the page, before the rest at its end is the way to a chat with it beside it.
 *
 * What is shown fills the card under the header, out to its sides and bottom, with rounded top
 * corners and a line along the top. The bar at its top pushes the header up out of the way, and
 * pulls it back down; tugged down on, with the header out, it stretches a little and rolls the
 * header up when let go, however short the tug, or at once at the most it can be pulled, as people
 * pull. Filling the window, the corners square off as the header goes.
 */
export const SidePane = (props: SidePaneProps) => {
  const { active, people = [], link, onReload, onDownload, exports, onOpenSettings, onViewCode, viewingCode = false, onInvite, template, agents, narrow = false, children } = props
  const fullScreen = props.placement === 'page' && props.fullScreen
  const reduceMotion = useReducedMotion() ?? false

  // How far out the header is, 0 to 1. A motion value, so that dragging renders nothing again.
  const [headerShown, setHeaderShown] = useState(true)
  const reveal = useMotionValue(1)
  const grabbed = useRef(1)
  // The header was tugged away during this drag, which is over as far as the header goes.
  const tugged = useRef(false)
  const headerOffset = useTransform(reveal, (amount) => -(1 - amount) * TUCK)
  const showHeader = (shown: boolean) => {
    setHeaderShown(shown)
    if (reduceMotion) reveal.jump(shown ? 1 : 0)
    else animate(reveal, shown ? 1 : 0, motionTransition({ type: 'spring', duration: 0.3, bounce: 0.1 }))
  }

  // Gone into full screen, the header goes away by itself after a moment, so that the one shown
  // has the window; brought back, it stays. Put away that way, it is back on leaving full screen,
  // unless it was taken hold of since. Taking hold of it first is choosing for it.
  const awayTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const putAwayItself = useRef(false)
  const handled = () => {
    clearTimeout(awayTimer.current)
    putAwayItself.current = false
  }
  const fullScreenChanged = useEffectEvent((on: boolean) => {
    if (on) {
      awayTimer.current = setTimeout(() => {
        // One put away already was put away by whoever did it.
        if (reveal.get() < 1) return
        putAwayItself.current = true
        showHeader(false)
      }, AWAY_AFTER)
    } else if (putAwayItself.current) {
      putAwayItself.current = false
      showHeader(true)
    }
  })
  useEffect(() => {
    fullScreenChanged(fullScreen)
    return () => clearTimeout(awayTimer.current)
  }, [fullScreen])
  // Full screen with the header away, the bar to bring it back fades until the pointer nears the
  // top, or the keyboard comes to it.
  const barAway = fullScreen && !headerShown && props.placement === 'page' && props.pointerNearTop !== true

  // With the header away, the surface's top is the card's, which has an edge of its own.
  const lineOpacity = useTransform(reveal, [0, 0.5], [0, 1])
  // Filling the window, full screen or on a narrow screen, the card has no corners for the
  // surface's to meet, so they straighten as the header goes, and are square at the window's top.
  const corner = useMotionValue(CORNER)
  const fillsWindow = fullScreen || narrow
  const shapeCorners = useEffectEvent(() => corner.set(fillsWindow ? CORNER * clampSize(reveal.get(), 0, 1) : CORNER))
  useMotionValueEvent(reveal, 'change', shapeCorners)
  useLayoutEffect(() => shapeCorners(), [fillsWindow])

  // Whether the header has no room to spare, as in a narrow pane, where Share goes into more. Its
  // menu is drawn outside it, so what its width says is measured rather than asked of the CSS.
  const header = useRef<HTMLElement>(null)
  const [crammed, setCrammed] = useState(false)
  useEffect(() => {
    const element = header.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setCrammed(entry!.contentRect.width < CRAMPED_BELOW))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const shares = onInvite !== undefined || template !== undefined
  const shareInMore = crammed && shares
  // On a phone the switch between the app and its code is in more too, where it has no room.
  const codeInMore = narrow && onViewCode !== undefined

  const beside = props.placement === 'beside' ? props : undefined
  const page = props.placement === 'page' ? props : undefined
  // The header's one primary action: the way to a chat with it beside it.
  const chat = page?.chat && active && !fullScreen && (
    <HeaderBubble key="chat" origin="end">
      <GadgetChatMenu {...page.chat} title={active.title} compact={narrow} />
    </HeaderBubble>
  )
  const stepDown = beside ? beside.onHide : page?.onCollapse

  return (
    <section aria-label={active?.title ?? 'Side pane'} className="flex min-h-0 flex-1 flex-col">
      <motion.div style={{ marginTop: headerOffset }} inert={!headerShown} className="shrink-0">
        <header ref={header} style={{ height: HEADER_HEIGHT }} className="flex items-center gap-1.5 px-3">
          {narrow && stepDown && (
            <HeaderBubble key="back">
              <Button icon={ArrowLeftIcon} aria-label="Back" title="Back" onClick={stepDown} />
            </HeaderBubble>
          )}
          {/* First, so that it stays where it is whatever follows, and apart from what can be done with the one shown. */}
          {active && onViewCode && !narrow && (
            // Keyed, so that going to another swaps the bubble.
            <HeaderBubble key={`code:${active.key}`}>
              <IconSwitch
                aria-label="Show the code"
                title={viewingCode ? 'Show the app' : 'Show the code'}
                icons={{ off: EyeIcon, on: CodeIcon }}
                checked={viewingCode}
                onCheckedChange={() => onViewCode()}
              />
            </HeaderBubble>
          )}
          {active && (
            // Keyed, so that going to another swaps the bubble.
            <HeaderBubble key={active.key} className="min-w-0">
              <SidePaneTitle
                title={active.title}
                icon={active.icon}
                onOpenSettings={onOpenSettings}
              />
            </HeaderBubble>
          )}
          <span className="ms-auto flex shrink-0 items-center gap-1.5">
            {/* Something the one shown has, among what can be done with it rather than in the
                path to it, where it would read as a step further in. */}
            {active && agents && !viewingCode && <AgentsBubble {...agents} compact />}
            {people.length > 0 && (
              <HeaderBubble origin="end" className="me-1.5">
                <AvatarStack people={people} aria-label="Also here" />
              </HeaderBubble>
            )}
            {active && (onReload || onDownload || exports || shareInMore || codeInMore || onOpenSettings || (beside?.onExpand && !narrow)) && (
              <HeaderBubble origin="end">
                <DropdownMenu icon={DotsThreeIcon} aria-label={active ? `More for ${active.title}` : 'More'} align="end">
                  {codeInMore && (viewingCode
                    ? <DropdownMenu.Item icon={EyeIcon} onSelect={onViewCode}>Show the app</DropdownMenu.Item>
                    : <DropdownMenu.Item icon={CodeIcon} onSelect={onViewCode}>Show the code</DropdownMenu.Item>)}
                  {shareInMore && <ShareItems onInvite={onInvite} template={template} />}
                  {onReload && <DropdownMenu.Item icon={ArrowClockwiseIcon} onSelect={onReload}>Reload</DropdownMenu.Item>}
                  {onDownload && <DropdownMenu.Item icon={DownloadSimpleIcon} onSelect={onDownload}>Download</DropdownMenu.Item>}
                  {exports && (
                    // Its items are only there while it is open, so that each opening reads what there is again.
                    <DropdownMenu.Submenu label="Export" icon={FileArrowDownIcon}>
                      <div className="overflow-y-auto overscroll-contain p-1.5">
                        <ExportItems {...exports} />
                      </div>
                    </DropdownMenu.Submenu>
                  )}
                  {beside?.onExpand && !narrow && <DropdownMenu.Item icon={ArrowsOutSimpleIcon} onSelect={beside.onExpand}>Expand</DropdownMenu.Item>}
                  {onOpenSettings && (onReload || onDownload || exports || shareInMore || codeInMore || (beside?.onExpand && !narrow)) && <DropdownMenu.Separator />}
                  {onOpenSettings && <DropdownMenu.Item icon={GearSixIcon} onSelect={onOpenSettings}>App settings</DropdownMenu.Item>}
                </DropdownMenu>
              </HeaderBubble>
            )}
            {/* Keyed, so that the one button swaps for the other. In more instead where there is no room. */}
            {active && shares && !crammed && (
              <HeaderBubble key="share" origin="end">
                <DropdownMenu
                  icon={template?.copy === 'copied' ? CheckIcon : template?.copy === 'failed' ? XIcon : ShareNetworkIcon}
                  aria-label={template?.copy === 'copied' ? 'Template link copied' : template?.copy === 'failed' ? 'Couldn’t copy the template link' : 'Share'}
                  align="end"
                  inPlace
                >
                  <ShareItems onInvite={onInvite} template={template} />
                </DropdownMenu>
              </HeaderBubble>
            )}
            {active && link && !shares && (
              <HeaderBubble key="copy-link" origin="end">
                <CopyLinkButton link={link} title={active.title} />
              </HeaderBubble>
            )}
            {/* Where the gadget's page was expanded from beside a chat, Chat is ahead of the step down, which is last, where the arrow that puts the pane away was beside the chat. */}
            {page?.onCollapse && chat}
            {/* Keyed, so that expanding swaps the one button for the other in its place. On a narrow screen the back button at the start puts it away. */}
            {beside && !narrow && (
              <HeaderBubble key="hide" origin="end">
                <Button icon={ArrowLineRightIcon} aria-label="Hide pane" title="Hide pane" onClick={beside.onHide} />
              </HeaderBubble>
            )}
            {page && !narrow && (
              // Keyed, so that the one button swaps for the other.
              <HeaderBubble key={fullScreen ? 'exit-full-screen' : 'full-screen'} origin="end">
                {fullScreen
                  ? <Button icon={CornersInIcon} aria-label="Exit full screen" title="Exit full screen" onClick={() => page.onFullScreenChange(false)} />
                  : <Button icon={CornersOutIcon} aria-label="Full screen" title="Full screen" onClick={() => page.onFullScreenChange(true)} />}
              </HeaderBubble>
            )}
            {page?.onCollapse && !fullScreen && !narrow && (
              <HeaderBubble key="collapse" origin="end">
                <Button icon={ArrowsInSimpleIcon} aria-label="Collapse" title="Collapse" onClick={page.onCollapse} />
              </HeaderBubble>
            )}
            {/* Otherwise the header's one primary action is at its far end. */}
            {!page?.onCollapse && chat}
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
          <div
            className={cn(
              'absolute top-0 left-1/2 z-10 flex -translate-x-1/2 transition-opacity duration-300 has-focus-visible:opacity-100 motion-reduce:transition-none',
              barAway && 'opacity-0',
            )}
          >
            <Grabber
              aria-label={headerShown ? 'Hide the header' : 'Show the header'}
              expanded={headerShown}
              onDragStart={() => {
                handled()
                reveal.stop()
                grabbed.current = reveal.get()
                tugged.current = false
              }}
              onDrag={(offset) => {
                if (tugged.current) return
                // A header that was all the way out and is tugged down on, as a cord is, snaps away
                // as soon as it is tugged far enough, without waiting to be let go: down is where
                // people pull, and where there is room to.
                if (grabbed.current > 0.99 && offset > TUG_AT) {
                  tugged.current = true
                  showHeader(false)
                  return
                }
                reveal.set(resistSize(grabbed.current * TUCK + offset, 0, TUCK) / TUCK)
              }}
              onDragEnd={(offset) => {
                // What was left of the gesture, after the header snapped away, is nothing.
                if (tugged.current) {
                  tugged.current = false
                  return
                }
                // Let go of after any tug down, however short, it rolls up all the same.
                if (grabbed.current > 0.99 && offset > 0) {
                  showHeader(false)
                  return
                }
                const amount = clampSize(reveal.get(), 0, 1)
                showHeader(offset > 0 ? amount > COMMITS_AT : amount > 1 - COMMITS_AT)
              }}
              onToggle={() => {
                handled()
                showHeader(!headerShown)
              }}
            />
          </div>
          {children}
        </motion.div>
      )}
    </section>
  )
}
