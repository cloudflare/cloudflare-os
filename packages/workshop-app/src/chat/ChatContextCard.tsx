import { useState } from 'react'
import { matchesResourceUrlPattern, type SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { GitBranchIcon, LightningIcon } from '@phosphor-icons/react'
import { ATTACHMENT_KIND_ICONS } from '@/blocks/attachmentKindIcons'
import { ContextRow } from '@/blocks/ContextRow'
import { ContextSection } from '@/blocks/ContextSection'
import { FormatIcon } from '@/components/FormatIcon'
import { ServiceLogo } from '@/components/ServiceLogo'
import { attachmentKind } from '@/files/attachmentKind'
import { useConnections } from '@/connections/useConnections'
import { useLibrary } from '@/library/OutputsFeedContext'
import type { ChatConnector } from './chatConnectors'
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

// What kind of thing it is, as its service names it ("Google Doc"): by its kind's id, or else its
// address, as one of the service's own kinds rather than any web page.
const kindOf = ({ resourceTypeId, resourceUrl }: ChatConnector, resources: readonly SupportedResource[] | undefined) =>
  (resources?.find(({ id }) => id === resourceTypeId)
    ?? (resourceUrl === undefined ? undefined : resources?.find(({ urlPattern }) => urlPattern !== 'https://*' && matchesResourceUrlPattern(urlPattern, resourceUrl))))?.title

const fileIcon = (file: ChatAttachment) => {
  const Glyph = ATTACHMENT_KIND_ICONS[attachmentKind({ name: file.name, type: file.mimeType })]
  return <Glyph aria-hidden="true" />
}

/**
 * What a chat can use (`availableTo`), a section for each kind there is: the workspace's library,
 * its automations, what was uploaded to the chat and what it reaches on each service, each
 * thing on a line of its own, by its name and kind. Each folds away
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
  // A service's name, logo and kinds of thing, by its id, from those the user can connect.
  const { state: connections } = useConnections()
  const services = new Map(connections.status === 'ready' ? connections.connections.map(({ vendorId, vendor, resources }) => [vendorId.toLowerCase(), { vendor, resources }] as const) : [])
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
      {section('connectors', 'Connectors', connectors.length, connectors.map((connector) => {
        const service = connector.vendorId === undefined ? undefined : services.get(connector.vendorId.toLowerCase())
        const name = service?.vendor.displayName ?? connector.vendorId
        // Which one, and what kind of thing it is on its service; a whole account is the service's.
        const title = connector.title ?? name ?? 'Connection'
        const detail = name === undefined ? undefined : connector.title === undefined ? 'Account' : kindOf(connector, service?.resources) ?? name
        return <ContextRow key={connector.key} icon={<ServiceLogo name={name ?? title} src={service?.vendor.logo?.url} bare />} title={title} detail={detail} />
      }))}
    </>
  )
}
