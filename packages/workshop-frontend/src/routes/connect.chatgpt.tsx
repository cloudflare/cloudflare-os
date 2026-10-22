import { createFileRoute } from '@tanstack/react-router'
import { ChatGptCallbackPage } from '../features/ai-models/ChatGptCallbackPage'

export const Route = createFileRoute('/connect/chatgpt')({
  component: ChatGptCallbackPage,
})
