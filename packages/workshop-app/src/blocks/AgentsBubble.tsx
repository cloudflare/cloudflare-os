import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { AgentMark } from './AgentMark'

export type AgentsBubbleProps = {
  /** The agents' names. */
  names: string[]
  /** One opens its page; several, the workspace's Agents. */
  onOpen: () => void
  /** Among a header's buttons: the mark alone for one, named when pointed at; several counted. */
  compact?: boolean
}

/**
 * The agents a gadget starts, in a header: one by its name, several by how many, as the clock
 * beside a chat's title counts its automations; or `compact`, among the header's buttons. Nothing
 * for none.
 */
export const AgentsBubble = ({ names, onOpen, compact = false }: AgentsBubbleProps) => {
  if (names.length === 0) return null
  const one = names.length === 1
  const label = one ? `Agent: ${names[0]}` : `Agents: ${names.join(', ')}`
  return (
    // Compact, it is among the buttons at a header's end, which it grows out from.
    <HeaderBubble origin={compact ? 'end' : 'start'} className={compact ? 'shrink-0' : 'min-w-0 shrink'}>
      {compact && one ? (
        <Button icon={<AgentMark size="small" />} aria-label={label} title={label} onClick={onOpen} />
      ) : (
        <Button
          icon={<AgentMark size="small" />}
          aria-label={label}
          title={one ? 'Agent' : names.join(', ')}
          onClick={onOpen}
          className="min-w-0 shrink"
        >
          <span className="max-w-40 truncate">{one ? names[0] : names.length}</span>
        </Button>
      )}
    </HeaderBubble>
  )
}
