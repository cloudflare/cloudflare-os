import { useEffect } from 'react'
import { DownloadSimpleIcon } from '@phosphor-icons/react'
import { SettingsRow } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { ShimmerText } from '@/components/ShimmerText'
import { useGadgetExports } from './useGadgetExports'

const listFormatter = new Intl.ListFormat('en', { type: 'disjunction' })

/**
 * Saving a gadget as a file, as a row of its settings: the formats it offers, read as the row
 * shows, and Export, which saves it as the one chosen (straight away when there is only one).
 * What is under way, and why it failed, take the description's place. Nothing for a gadget that
 * offers none, or whose formats could not be read.
 */
export const GadgetExportRow = ({ workspaceId, workpieceId, title }: { workspaceId: string; workpieceId: number; title: string }) => {
  const exporting = useGadgetExports({ workspaceId, workpieceId })
  const exports = exporting?.exports
  useEffect(() => {
    if (exports) void exports.loadFormats()
  }, [exports])
  if (!exporting) return null
  const { formats, progress } = exporting.snapshot
  if (formats.status !== 'ready' || formats.formats.length === 0) return null
  const busy = progress?.status === 'exporting'
  const save = (id: string) => {
    const format = formats.formats.find((each) => each.id === id)
    if (format) void exporting.exports.exportAs(format, title)
  }

  return (
    <SettingsRow
      title="Export"
      description={progress?.status === 'exporting' ? (
        <span role="status"><ShimmerText>Exporting {progress.label}…</ShimmerText></span>
      ) : progress?.status === 'failed' ? (
        <span role="alert" className="text-kumo-danger">Couldn’t export {progress.label}. {progress.message}</span>
      ) : `Save it as a file: ${listFormatter.format(formats.formats.map(({ label }) => label))}.`}
      control={formats.formats.length === 1 ? (
        <Button icon={DownloadSimpleIcon} disabled={busy} onClick={() => save(formats.formats[0].id)}>Export</Button>
      ) : (
        <DropdownMenu label="Export" icon={DownloadSimpleIcon} align="end" disabled={busy}>
          {formats.formats.map((format) => (
            <DropdownMenu.Item key={format.id} label={format.label} onSelect={() => save(format.id)}>
              <span className="min-w-0 flex-1 truncate">{format.label}</span>
              <span className="text-(length:--menu-detail-text) leading-(--menu-detail-line) text-kumo-subtle">{format.fileExtension}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu>
      )}
    />
  )
}
