import { useState } from 'react'
import { GitBranchIcon, LightningIcon } from '@phosphor-icons/react'
import { ATTACHMENT_KIND_ICONS } from '@/blocks/attachmentKindIcons'
import { ContextRow } from '@/blocks/ContextRow'
import { ContextSection } from '@/blocks/ContextSection'
import { FormatIcon } from '@/components/FormatIcon'
import { ServiceLogo } from '@/components/ServiceLogo'
import { attachmentKind } from '@/files/attachmentKind'
import { useConnections } from '@/connections/useConnections'
import { useLibrary } from '@/library/OutputsFeedContext'
import type { ChatContext } from './chatContext'
import type { ChatAttachment, HookItem, OutputFormat, OutputItem } from './chatItems'

type Section = 'outputs' | 'automations' | 'files' | 'connectors'

export type ChatContextCardProps = {
  workspaceId: string
  context: ChatContext
  onOpenOutput: (output: OutputItem) => void
  onOpenAttachment: (file: ChatAttachment) => void
  /** An output's own page, for its row to link to so that it can be opened in another tab. */
  outputHref?: (output: OutputItem) => string
  /** Goes to an automation where it is listed, from its row. Left out, its row only says what it is. */
  onOpenAutomation?: (hook: HookItem) => void
  /** Where that is, so that it can be opened in another tab. */
  automationHref?: (hook: HookItem) => string
}

/** What kind of thing an output is, as the library draws it: its format's glyph, so that an app, a document and slides differ. */
const outputIcon = (output: OutputItem, format: OutputFormat | undefined) =>
  output.type === 'worktree' ? <GitBranchIcon aria-hidden="true" /> : <FormatIcon name={(output.format ?? format)?.icon} />

const fileIcon = (file: ChatAttachment) => {
  const Glyph = ATTACHMENT_KIND_ICONS[attachmentKind({ name: file.name, type: file.mimeType })]
  return <Glyph aria-hidden="true" />
}

/**
 * What a chat can use (`availableTo`), a section for each kind there is: the workspace's library,
 * its automations, what was uploaded to the chat and the services it reaches. Each folds away
 * under its title.
 */
export const ChatContextCard = ({ workspaceId, context, onOpenOutput, onOpenAttachment, outputHref, onOpenAutomation, automationHref }: ChatContextCardProps) => {
  const { outputs, hooks, files, connectors } = context
  // What the conversation does not say of an output's format, the library does.
  const library = useLibrary()
  const formats = new Map(
    library.status === 'ready'
      ? library.outputs.flatMap(({ workspaceId: at, workpieceId, output }) => (at === workspaceId && output ? [[workpieceId, { noun: output.noun, icon: output.icon }] as const] : []))
      : [],
  )
  // A service's name and logo, by its id, from those the user can connect.
  const { state: services } = useConnections()
  const vendors = new Map(services.status === 'ready' ? services.connections.map(({ vendorId, vendor }) => [vendorId.toLowerCase(), vendor] as const) : [])
  // Open, until folded away.
  const [folded, setFolded] = useState<ReadonlySet<Section>>(new Set())
  const toggle = (section: Section) => setFolded((current) => {
    const next = new Set(current)
    if (!next.delete(section)) next.add(section)
    return next
  })
  const section = (name: Section, title: string, count: number, rows: ReturnType<typeof ContextRow>[]) =>
    count > 0 && <ContextSection title={title} open={!folded.has(name)} onToggle={() => toggle(name)}>{rows}</ContextSection>

  return (
    <>
      {section('outputs', 'Library', outputs.length, outputs.map((output) => (
        <ContextRow key={output.key} icon={outputIcon(output, formats.get(output.workpieceId))} title={output.title} href={outputHref?.(output)} onSelect={() => onOpenOutput(output)} />
      )))}
      {section('automations', 'Automations', hooks.length, hooks.map((hook) => (
        <ContextRow key={hook.key} icon={<LightningIcon aria-hidden="true" />} title={hook.title} href={automationHref?.(hook)} onSelect={onOpenAutomation && (() => onOpenAutomation(hook))} />
      )))}
      {section('files', 'Uploads', files.length, files.map((file) => (
        <ContextRow key={file.id} icon={fileIcon(file)} title={file.name} onSelect={() => onOpenAttachment(file)} />
      )))}
      {section('connectors', 'Connectors', connectors.length, connectors.map(({ key, vendorId, scopes }) => {
        const vendor = vendorId === undefined ? undefined : vendors.get(vendorId.toLowerCase())
        // One with no service is named by what it reaches.
        const name = vendor?.displayName ?? (vendorId === undefined ? scopes[0] : vendorId) ?? 'Connection'
        const detail = vendorId === undefined ? undefined : scopes.join(', ') || undefined
        return <ContextRow key={key} icon={<ServiceLogo name={name} src={vendor?.logo?.url} bare />} title={name} detail={detail} />
      }))}
    </>
  )
}
