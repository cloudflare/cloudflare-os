import { Chip } from '@/components/Chip'
import type { ChipAbout } from '@/components/ChipTooltip'
import { FormatIcon } from '@/components/FormatIcon'
import { ServiceLogo } from '@/components/ServiceLogo'
import { CommandIcon } from './CommandIcon'
import { connectionKind } from './ComposerConnectionLines'
import type { NewDraftPill } from './composerDraft'

/**
 * What a pill is drawn with and what there is to say of it beyond its name, in the card over it
 * while it is pointed at: what a skill is for and where it is kept, what a format or a template
 * is for, and what a connection holds and is of. Only what is known of it: where that is nothing,
 * the pill has no card.
 */
export const pillAbout = (pill: NewDraftPill): ChipAbout => {
  if (pill.itemType === 'command') {
    const { title, description, kind, source } = pill.data
    return { icon: <CommandIcon command={pill.data} />, title, description, facts: [kind === 'skill' ? 'Skill' : 'Command', ...(source ? [source] : [])] }
  }
  if (pill.itemType === 'format') {
    const { noun, icon, template, description } = pill.data
    // That it is a format is no more than its pill says: only with what it is for.
    return { icon: <FormatIcon name={icon} />, title: noun, description, facts: description ? [template ? 'Template' : 'Format'] : [] }
  }
  const { service, title, snippet } = pill.data
  return {
    icon: service.glyph ?? <ServiceLogo bare name={service.name} src={service.logoUrl} />,
    title,
    description: snippet?.trim() || undefined,
    facts: [connectionKind(pill.data)],
  }
}

/**
 * Something a draft holds besides its words, drawn at its start as the message it is sent as
 * draws it: the skill or command it goes with, the format or template it starts with, or a
 * connection it gives the chat, by its service's logo.
 */
export const ComposerPill = ({ pill }: { pill: NewDraftPill }) => {
  const { icon, title } = pillAbout(pill)
  return <Chip icon={icon}>{title}</Chip>
}
