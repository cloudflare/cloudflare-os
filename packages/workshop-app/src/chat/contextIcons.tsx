import { AttachmentIcon, ConnectIcon, FlashIcon, LayerIcon } from '@/components/icons'

/** What each kind of thing a chat has is drawn as, on the button that opens them. */
export const CONTEXT_ICONS = {
  outputs: <LayerIcon aria-hidden="true" />,
  automations: <FlashIcon aria-hidden="true" />,
  files: <AttachmentIcon aria-hidden="true" />,
  connectors: <ConnectIcon aria-hidden="true" />,
}
