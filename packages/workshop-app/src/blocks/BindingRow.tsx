import { useState } from 'react'
import { ArrowsLeftRightIcon, BrainIcon, LinkBreakIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { LinkButton } from '@/components/LinkButton'
import { ServiceLogo } from '@/components/ServiceLogo'
import { Tag } from '@/components/Tag'
import { Tooltip } from '@/components/Tooltip'
import { AgentMark } from './AgentMark'
import { CardAction } from './CardAction'
import { LIST_ACTION } from './StarButton'
import { useEditedField, type SaveOutcome } from './useEditedField'

export type BindingRowProps = {
  /** What it reaches, as the workspace calls it: a repository, a mailbox, an agent's name. */
  title: string
  /** The name the gadget's code knows it by, as in `env.NAME`. */
  name: string
  /** The service it goes through, whose logo it is drawn with. Absent for an agent or a model. */
  service?: { name: string; logoUrl?: string; color?: string }
  /** It is an agent the gadget starts, or a model its code calls, rather than a service's. */
  kind?: 'agent' | 'model'
  /** The model an agent thinks with, by name. A model is named by its `title`. */
  model?: string
  /** Proposed in a chat and not accepted yet, so it is only there in that chat. */
  pending?: boolean
  /** The gadget's title, for what taking it away asks. */
  gadget?: string
  /** Shows `env.NAME`, which is for those who build on the app (developer mode). */
  showsCodeName?: boolean
  /** Takes it away from the gadget, asked for twice. Left out where it cannot be. */
  onRemove?: () => void
  /** Gives it another name in the gadget's code, where the name is shown. Left out where it cannot be. */
  onRename?: (name: string) => Promise<SaveOutcome>
  /** Has a model reach another of the user's models under the same name. Left out where it cannot. */
  onChangeModel?: () => void
  /** What an agent wants of the user, said under the line in its colour, with a dot on its mark. */
  attention?: { words: string; tone: 'warning' | 'danger' }
  /** Opens what it reaches, as an agent's page: its title is then the way there. */
  onOpen?: () => void
  /** Where that opens, so that it can be opened in another tab. */
  href?: string
}

const NOT_RENAMED = Promise.resolve<SaveOutcome>({ saved: false })

/** What taking one away asks, in the words of whoever uses the app rather than its code's. */
export const removalWords = ({ title, name, service, kind, gadget, showsCodeName }: Pick<BindingRowProps, 'title' | 'name' | 'service' | 'kind' | 'gadget' | 'showsCodeName'>) => {
  const app = gadget ? `“${gadget}”` : 'This app'
  const code = showsCodeName ? ` Its code loses env.${name}.` : ''
  if (kind === 'agent') {
    return {
      label: 'Remove',
      title: `Remove ${title} from ${gadget ? app : 'this app'}?`,
      description: `${app} can’t start ${title} any more. What ${title} has already done stays in the workspace.${code}`,
    }
  }
  return {
    label: 'Disconnect',
    title: `Disconnect ${title}?`,
    description: `${app} can’t use ${kind === 'model' ? 'this model' : 'it'} any more, so parts of it may stop working. ${
      kind === 'model' ? 'The model stays yours, for anything else that uses it.' : `${service ? `Your ${service.name} account` : 'The account'} stays connected, for anything else that uses it.`
    }${code}`,
  }
}

/**
 * One of what a gadget is bound to: the service's logo, an agent's mark or a model's brain, then
 * what it reaches over the name the code has for it and what it goes through, and, while it is pointed at or has the
 * focus, the way to take it away from the gadget, which asks first. Taking it away leaves the
 * connection in the workspace, for whatever else uses it.
 *
 * The name the code has for it is only shown in developer mode (`showsCodeName`), and only then
 * renamed where it is (`onRename`), as a title is: it reads as the rest of the line
 * until pointed at or clicked into, and Enter or leaving it keeps what was typed. It is drawn as
 * the code's name for it, in a token of its own, which a pencil in it says can be edited, and
 * which, clicked into, is a field. A name that could not be kept stays in it, with why under the line, until it is put right or Escape puts
 * the name back.
 */
export const BindingRow = ({ title, name, service, kind, model, pending = false, gadget, showsCodeName = false, onRemove, onRename, onChangeModel, onOpen, href, attention }: BindingRowProps) => {
  const { field: { onValueChange, invalid, ...field }, problem } = useEditedField({ value: name, onSave: (next) => (onRename ? onRename(next) : NOT_RENAMED) })
  const [greeting, setGreeting] = useState(false)
  const removal = removalWords({ title, name, service, kind, gadget, showsCodeName })
  const through = kind === 'agent'
    ? (model ? `Agent · thinks with ${model}` : 'Agent')
    : kind === 'model' ? 'AI model' : service?.name
  return (
    <li
      onPointerEnter={kind === 'agent' ? () => setGreeting(true) : undefined}
      onPointerLeave={kind === 'agent' ? () => setGreeting(false) : undefined}
      className="group relative flex items-center gap-3 rounded-2xl py-2.5 pr-1.5 pl-3 text-base hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5">
      {kind === 'agent'
        ? (
            <span aria-hidden="true" className="relative shrink-0">
              <AgentMark greeting={greeting} state={attention?.tone === 'danger' ? 'failed' : 'idle'} />
              {attention && <span className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-kumo-tint', attention.tone === 'warning' ? 'bg-kumo-warning' : 'bg-kumo-danger')} />}
            </span>
          )
        : kind === 'model'
          ? <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line"><BrainIcon className="size-5" /></span>
          : <ServiceLogo name={service?.name ?? title} src={service?.logoUrl} color={service?.color} small />}
      <span className="min-w-0 flex-1 leading-snug">
        {onOpen
          ? (
              <LinkButton href={href} onClick={onOpen} className="block max-w-full truncate text-left font-medium text-kumo-default underline-offset-2 hover:underline">
                {title}
              </LinkButton>
            )
          : <span className="block truncate font-medium text-kumo-default">{title}</span>}
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-kumo-subtle">
          {!showsCodeName ? null : onRename ? (
            // All of `env.NAME` is the token, and the field's surface, as it is all the name the
            // code has for it. Clicked into it is lifted onto the page's base as a field is, its
            // ring the line's rather than the bold focus ring, which would crowd a line this small.
            <label className="group/name inline-flex min-w-0 shrink cursor-text items-center gap-1 rounded-md bg-kumo-fill px-1.5 py-px font-mono text-[0.85em] text-kumo-default ring-1 ring-transparent transition-[background-color,box-shadow] duration-100 hover:ring-kumo-line has-focus:bg-kumo-base has-focus:shadow-xs has-focus:ring-kumo-line has-aria-invalid:text-kumo-danger has-aria-invalid:ring-kumo-danger motion-reduce:transition-none">
              <span className="text-kumo-subtle">env.</span>
              <input
                {...field}
                aria-label={`Name of ${title} in the gadget’s code`}
                aria-invalid={invalid || undefined}
                autoCapitalize="characters"
                autoComplete="off"
                // Where `field-sizing` is not supported, about as wide as what is in it.
                size={Math.max(field.value.length, 1)}
                onChange={(event) => onValueChange(event.target.value)}
                // 16px at least on a narrow screen, or iOS zooms the page in on it.
                className="field-sizing-content min-w-0 appearance-none border-0 bg-transparent p-0 font-mono text-inherit outline-none max-md:text-[16px]"
              />
              {/* That it can be edited, until it is. */}
              <PencilSimpleIcon aria-hidden="true" className="hidden size-3 shrink-0 text-kumo-subtle group-hover/name:block group-has-focus/name:hidden pointer-coarse:block" />
            </label>
          ) : <code className="shrink-0 rounded-md bg-kumo-fill px-1.5 py-px font-mono text-[0.85em] text-kumo-default">env.{name}</code>}
          {through && <span className="min-w-0 truncate">{through}</span>}
        </span>
        {attention && <span className={cn('block truncate', attention.tone === 'warning' ? 'text-kumo-warning' : 'text-kumo-danger')}>{attention.words}</span>}
        {problem && <span role="alert" className="block text-sm text-pretty text-kumo-danger">{problem}</span>}
      </span>
      {/* Only the chat it was proposed in has it until its changes are kept. */}
      {pending && <Tag className="shrink-0">Waiting in a chat</Tag>}
      {/* One corner, the actions side by side in it. */}
      {(onChangeModel || onRemove) && (
        <CardAction>
          {onChangeModel && (
            <Tooltip content="Change model">
              <Button variant="ghost" icon={ArrowsLeftRightIcon} aria-label={`Change the model of env.${name}`} className={LIST_ACTION} onClick={onChangeModel} />
            </Tooltip>
          )}
          {onRemove && (
            <ConfirmMenu
              icon={LinkBreakIcon}
              aria-label={`${removal.label} ${title}`}
              triggerVariant="ghost"
              triggerClassName={LIST_ACTION}
              title={removal.title}
              description={removal.description}
              confirmLabel={removal.label}
              onConfirm={onRemove}
            />
          )}
        </CardAction>
      )}
    </li>
  )
}
