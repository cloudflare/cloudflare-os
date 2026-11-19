import { useState, type Ref } from 'react'
import { ContextPanel, type ContextStat } from '@/blocks/ContextPanel'
import { ChatContextCard, type ChatContextCardProps } from './ChatContextCard'
import { contextSummary, type ChatContext } from './chatContext'
import { CONTEXT_ICONS } from './contextIcons'

/** How many there are of each kind a chat has, for the kinds it has. */
const statsOf = ({ outputs, hooks, files, connectors }: ChatContext): ContextStat[] =>
  [
    { key: 'outputs', icon: CONTEXT_ICONS.outputs, count: outputs.length },
    { key: 'automations', icon: CONTEXT_ICONS.automations, count: hooks.length, tight: true },
    { key: 'files', icon: CONTEXT_ICONS.files, count: files.length },
    { key: 'connectors', icon: CONTEXT_ICONS.connectors, count: connectors.length },
  ].filter(({ count }) => count > 0)

export type ChatContextPanelProps = ChatContextCardProps & {
  /** Whether it is open, as it was left: beside the conversation, where `ChatContextSide` is its card. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * There is no room for it beside the conversation, so it floats over it. It is then shut to begin
   * with, whatever was left, goes when something else is clicked, and what is done to it is not kept.
   */
  floating: boolean
  /** The button beside the conversation, to bring focus back to when the card is put away. */
  triggerRef?: Ref<HTMLButtonElement>
}

/**
 * What a chat has, as a button at the end of its header that says what there is. Where there is
 * room it opens the card beside the conversation (`ChatContextSide`; `useContextOpen` keeps whether
 * it is open); where there is not, it floats over it, shut until it is opened.
 */
export const ChatContextPanel = ({ open, onOpenChange, floating, triggerRef, ...props }: ChatContextPanelProps) => {
  // Open over the conversation, which is only for as long as it floats: it is shut again each time it comes to.
  const [floatOpen, setFloatOpen] = useState(false)
  const [wasFloating, setWasFloating] = useState(floating)
  if (floating !== wasFloating) {
    setWasFloating(floating)
    setFloatOpen(false)
  }

  return (
    <ContextPanel
      stats={statsOf(props.context)}
      summary={contextSummary(props.context)}
      open={floating ? floatOpen : open}
      onOpenChange={floating ? setFloatOpen : onOpenChange}
      floating={floating}
      triggerRef={triggerRef}
    >
      {floating && <ChatContextCard {...props} />}
    </ContextPanel>
  )
}
