import { useEffect, useEffectEvent } from 'react'
import { ArrowsClockwiseIcon, CloudArrowUpIcon, DownloadSimpleIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'
import { ShimmerText } from '@/components/ShimmerText'

/** A kind of file the gadget can be saved as in one of the user's accounts. */
export type ExportSave = {
  key: string
  /** What the file is, as its service calls it: "Google Doc". */
  title: string
  /** What the service draws the kind with, or the service itself. */
  iconUrl?: string
  /** The name of the file the last such save made, which can be updated. */
  saved?: string
}

/** What the gadget can be exported as, as far as it has been read. */
export type ExportChoices =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; formats: { id: string; label: string }[]; saves: ExportSave[] }

export type ExportItemsProps = {
  /** Nothing until it has been opened. */
  choices?: ExportChoices
  /** It was opened, and reads what there is, as that can change with the gadget's code. */
  onOpen: () => void
  /** The format being exported, which the others wait for. */
  exporting?: string
  onExport: (formatId: string) => void
  /** Saves it as a new file of that kind, asking where. */
  onSave: (key: string) => void
  /** Saves it over the file the last such save made, asking first. */
  onUpdate: (key: string) => void
}

const Note = ({ children }: { children: string }) => (
  <p className="px-(--menu-pad-x) py-(--menu-pad-y) text-(length:--menu-text) leading-(--menu-line) text-kumo-subtle">{children}</p>
)

/**
 * What a gadget can be exported as, as the items of a menu: each format saved to the device when
 * chosen, then the kinds of file it can be saved as in the user's accounts, each with the update of
 * the file the last such save made before it. Put it in a menu's content, so that it is only there
 * while the menu is open and each opening reads what there is again.
 */
export const ExportItems = ({ choices, onOpen, exporting, onExport, onSave, onUpdate }: ExportItemsProps) => {
  const opened = useEffectEvent(onOpen)
  useEffect(() => opened(), [])

  if (!choices || choices.status === 'loading') {
    return <p role="status" className="px-(--menu-pad-x) py-(--menu-pad-y) text-(length:--menu-text) leading-(--menu-line) text-kumo-subtle"><ShimmerText>Loading…</ShimmerText></p>
  }
  if (choices.status === 'failed') {
    return (
      <>
        <Note>Export formats could not be loaded.</Note>
        <DropdownMenu.Item icon={ArrowsClockwiseIcon} keepOpen onSelect={onOpen}>Try again</DropdownMenu.Item>
      </>
    )
  }
  if (choices.formats.length === 0) return <Note>This gadget does not support exports.</Note>
  return (
    <>
      {choices.formats.map(({ id, label }) => (
        <DropdownMenu.Item key={id} icon={DownloadSimpleIcon} disabled={exporting !== undefined} onSelect={() => onExport(id)}>
          <span className={exporting !== undefined && exporting !== id ? 'text-kumo-inactive' : undefined}>
            {exporting === id ? <ShimmerText>{label}</ShimmerText> : label}
          </span>
        </DropdownMenu.Item>
      ))}
      {choices.saves.length > 0 && <DropdownMenu.Separator />}
      {choices.saves.flatMap(({ key, title, iconUrl, saved }) => [
        saved !== undefined && (
          <DropdownMenu.Item key={`${key}:update`} icon={ArrowsClockwiseIcon} label={`Update ${saved}`} onSelect={() => onUpdate(key)}>
            <span className="min-w-0 truncate">Update “{saved}”…</span>
          </DropdownMenu.Item>
        ),
        <DropdownMenu.Item key={key} icon={iconUrl ? undefined : CloudArrowUpIcon} label={`Save to ${title}`} onSelect={() => onSave(key)}>
          {iconUrl && <img src={iconUrl} alt="" className="size-(--menu-icon) shrink-0 object-contain" />}
          <span className="min-w-0 truncate">Save to {title}…</span>
        </DropdownMenu.Item>,
      ])}
    </>
  )
}
