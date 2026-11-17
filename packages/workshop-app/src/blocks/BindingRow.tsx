import { BrainIcon, LinkBreakIcon, RobotIcon } from '@phosphor-icons/react'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { ServiceLogo } from '@/components/ServiceLogo'
import { Tag } from '@/components/Tag'
import { CardAction } from './CardAction'
import { LIST_ACTION } from './StarButton'

export type BindingRowProps = {
  /** What it reaches, as the workspace calls it: a repository, a mailbox, an agent's name. */
  title: string
  /** The name the gadget's code knows it by, as in `env.NAME`. */
  name: string
  /** The service it goes through, whose logo it is drawn with. Absent for an agent or a model. */
  service?: { name: string; logoUrl?: string; color?: string }
  /** It is an agent the gadget starts, or a model its code calls, rather than a service's. */
  kind?: 'agent' | 'model'
  /** The model an agent thinks with, or the model itself, by name. */
  model?: string
  /** Proposed in a chat and not accepted yet, so it is only there in that chat. */
  pending?: boolean
  /** Takes it away from the gadget, asked for twice. Left out where it cannot be. */
  onRemove?: () => void
}

const KIND_ICON = { agent: RobotIcon, model: BrainIcon }

/**
 * One of what a gadget is bound to: the service's logo, or what it is, then what it reaches over
 * the name the code has for it and what it goes through, and, while it is pointed at or has the
 * focus, the way to take it away from the gadget, which asks first. Taking it away leaves the
 * connection in the workspace, for whatever else uses it.
 */
export const BindingRow = ({ title, name, service, kind, model, pending = false, onRemove }: BindingRowProps) => {
  const Glyph = kind && KIND_ICON[kind]
  const through = kind === 'agent'
    ? (model ? `Agent · thinks with ${model}` : 'Agent')
    : kind === 'model' ? (model ?? 'Model') : service?.name
  return (
    <li className="group relative flex items-center gap-3 rounded-2xl py-2.5 pr-1.5 pl-3 text-base hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5">
      {Glyph
        ? <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line"><Glyph className="size-5" /></span>
        : <ServiceLogo name={service?.name ?? title} src={service?.logoUrl} color={service?.color} small />}
      <span className="min-w-0 flex-1 leading-snug">
        <span className="block truncate font-medium text-kumo-default">{title}</span>
        <span className="block truncate text-kumo-subtle">
          <code className="font-mono text-[0.92em]">env.{name}</code>
          {through && ` · ${through}`}
        </span>
      </span>
      {/* Only the chat it was proposed in has it until its changes are kept. */}
      {pending && <Tag className="shrink-0">Waiting in a chat</Tag>}
      {onRemove && (
        <CardAction>
          <ConfirmMenu
            icon={LinkBreakIcon}
            aria-label={`Remove ${title} from the gadget`}
            triggerVariant="ghost"
            triggerClassName={LIST_ACTION}
            title={`Remove ${title}?`}
            description={`The gadget’s code loses env.${name}. The connection stays in the workspace, for whatever else uses it.`}
            confirmLabel="Remove"
            onConfirm={onRemove}
          />
        </CardAction>
      )}
    </li>
  )
}
