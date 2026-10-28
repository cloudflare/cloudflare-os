import { createFileRoute } from '@tanstack/react-router'
import { Composer } from '@/blocks/Composer'
import { ChatLayout } from '@/layouts/ChatLayout'

/** The start of a new conversation. */
export const Route = createFileRoute('/_app/')({
  component: () => <ChatLayout composer={<Composer onSend={() => {}} />} />,
})
