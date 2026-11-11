import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { WorkspaceCrumb } from './WorkspaceCrumb'

export type ChatHeaderProps = {
  /** The workspace the chat is in, once it is known. */
  workspace?: {
    id: string
    title: string
    /** Two letters shown on the folder. */
    label: string
    onOpen: () => void
  }
  /** The chat's title, once it is known. */
  title?: string
}

/** A chat's header: the way back to its workspace, then the chat's title. */
export const ChatHeader = ({ workspace, title }: ChatHeaderProps) => (
  <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
    {workspace && <WorkspaceCrumb {...workspace} />}
    {title && <HeaderBubble><Button>{title}</Button></HeaderBubble>}
  </nav>
)
