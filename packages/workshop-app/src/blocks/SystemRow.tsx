import { CodeIcon, InfoIcon, PlugIcon, type Icon } from '@phosphor-icons/react'
import { CodeBlock } from '@/components/CodeBlock'

const ICONS = {
  plug: PlugIcon,
  code: CodeIcon,
  info: InfoIcon,
} satisfies Record<string, Icon>

export type SystemRowProps = {
  icon: keyof typeof ICONS
  children: string
  /** Literal text shown under the line, such as a call's arguments. */
  detail?: string
}

/** Something that happened in the chat that nobody said: the gadget was used, a call arrived. */
export const SystemRow = ({ icon, children, detail }: SystemRowProps) => {
  const RowIcon = ICONS[icon]
  return (
    <div className="flex flex-col gap-1 px-2 py-1 text-base/5 text-kumo-subtle">
      <div className="flex items-center gap-2">
        <RowIcon aria-hidden="true" className="size-5 shrink-0" />
        <span className="min-w-0 truncate">{children}</span>
      </div>
      {detail && <div className="ms-7"><CodeBlock label="Arguments">{detail}</CodeBlock></div>}
    </div>
  )
}
