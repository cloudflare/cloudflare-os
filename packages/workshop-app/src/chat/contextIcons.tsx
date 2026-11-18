import { LightningIcon, PaperclipIcon, PlugsIcon, StackSimpleIcon } from '@phosphor-icons/react'

/** What each kind of thing a chat has is drawn as, on the button that opens them. */
export const CONTEXT_ICONS = {
  outputs: <StackSimpleIcon aria-hidden="true" />,
  automations: <LightningIcon aria-hidden="true" />,
  files: <PaperclipIcon aria-hidden="true" />,
  connectors: <PlugsIcon aria-hidden="true" />,
}
