import { InfoIcon } from '@phosphor-icons/react'

const ICONS = {
  info: InfoIcon,
}

export type SystemRowProps = {
  icon: keyof typeof ICONS
  children: string
}

/** Something that happened in the chat that nobody said, such as a message this app can't show. */
export const SystemRow = ({ icon, children }: SystemRowProps) => {
  const RowIcon = ICONS[icon]
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-base/5 text-kumo-subtle">
      <RowIcon aria-hidden="true" className="size-5 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}
