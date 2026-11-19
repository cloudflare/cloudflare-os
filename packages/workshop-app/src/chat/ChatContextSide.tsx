import type { Ref } from 'react'
import { ContextSide } from '@/blocks/ContextSide'
import { ChatContextCard, type ChatContextCardProps } from './ChatContextCard'

export type ChatContextSideProps = ChatContextCardProps & {
  onMinimize: () => void
  /** Its minimize button, to bring focus to when it is opened. */
  minimizeRef?: Ref<HTMLButtonElement>
}

/** What a chat has, as the card beside its conversation (`ChatContextPanel` is its button). */
export const ChatContextSide = ({ onMinimize, minimizeRef, ...card }: ChatContextSideProps) => (
  <ContextSide onMinimize={onMinimize} minimizeRef={minimizeRef}>
    <ChatContextCard {...card} />
  </ContextSide>
)
