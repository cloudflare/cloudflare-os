import { useEffect, useRef, useState } from 'react'
import { DropdownMenu, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { DownloadSimple } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import type { GadgetExportFormat } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from './components/WorkshopControls'
import { makeExportFilename, saveStreamToFile } from './fileTransfers'

type Props = {
  gadget: RpcStub<GadgetClient> | null
  gadgetTitle: string
  chatId?: number
}

export default function GadgetExportMenu({ gadget, gadgetTitle, chatId }: Props) {
  const [formats, setFormats] = useState<GadgetExportFormat[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const formatRequest = useRef(0)
  const toasts = useKumoToastManager()

  useEffect(() => {
    ++formatRequest.current
    setFormats(null)
    setLoading(false)
    setLoadFailed(false)
  }, [gadget, chatId])

  const loadFormats = () => {
    if (!gadget) return
    const request = ++formatRequest.current
    setFormats(null)
    setLoading(true)
    setLoadFailed(false)
    void gadget.getExportFormats(chatId).then(result => {
      if (formatRequest.current !== request) return
      setFormats(result)
      setLoading(false)
    }, error => {
      if (formatRequest.current !== request) return
      console.error('Failed to list Gadget export formats:', error)
      setLoading(false)
      setLoadFailed(true)
    })
  }

  const handleOpenChange = (open: boolean) => {
    if (open) {
      loadFormats()
    } else {
      ++formatRequest.current
      setFormats(null)
      setLoading(false)
      setLoadFailed(false)
    }
  }

  const download = async (format: GadgetExportFormat) => {
    if (!gadget || exportingId !== null) return

    setExportingId(format.id)
    try {
      await saveStreamToFile(
        () => gadget.export(format.id, chatId),
        makeExportFilename(gadgetTitle, format.fileExtension),
        {
          description: format.label,
          contentType: format.contentType,
          extension: format.fileExtension,
        },
      )
    } catch (error) {
      console.error(`Failed to export Gadget as ${format.label}:`, error)
      toasts.add({ title: `Failed to export ${format.label}`, variant: 'error' })
    } finally {
      setExportingId(null)
    }
  }

  if (!gadget) return null

  const exportingFormat = formats?.find(format => format.id === exportingId)
  const tooltip = exportingFormat ? `Exporting to ${exportingFormat.label}` : 'Export Gadget'

  return (
    <Tooltip content={tooltip} asChild>
      <span className="relative inline-flex">
        <DropdownMenu onOpenChange={handleOpenChange}>
          <DropdownMenu.Trigger
            render={(
              <WorkshopIconButton
                aria-label="Export Gadget"
                disabled={exportingId !== null}
              >
                <DownloadSimple size={17} />
              </WorkshopIconButton>
            )}
          />
          <DropdownMenu.Content className="themed-floating-shadow !z-[1100] !min-w-[144px] rounded-lg border border-kumo-line bg-kumo-base p-1">
            {loading ? (
              <div role="status" aria-label="Loading export formats" className="space-y-1 py-0.5">
                {['w-20', 'w-14'].map(width => (
                  <div key={width} className="flex h-7 items-center gap-2 px-2.5">
                    <span className="h-3 w-3 animate-pulse rounded bg-kumo-elevated" />
                    <span className={`h-2.5 ${width} animate-pulse rounded bg-kumo-elevated`} />
                  </div>
                ))}
              </div>
            ) : loadFailed ? (
              <div className="px-2.5 py-2 text-[12px] leading-4 text-kumo-subtle">
                <p>Export formats could not be loaded.</p>
                <button
                  type="button"
                  onClick={loadFormats}
                  className="mt-1 font-medium text-kumo-default hover:underline"
                >
                  Try again
                </button>
              </div>
            ) : formats?.length === 0 ? (
              <p className="px-2.5 py-2 text-[12px] leading-4 text-kumo-subtle">
                This Gadget does not support exports.
              </p>
            ) : formats?.map(format => (
              <DropdownMenu.Item
                key={format.id}
                icon={<DownloadSimple size={12} className="mr-2" />}
                onClick={() => { void download(format) }}
                className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
              >
                {format.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
        {exportingId !== null && (
          <span className="pointer-events-none absolute bottom-0 left-1 right-1 h-0.5 overflow-hidden rounded-full bg-kumo-fill">
            <span className="absolute inset-y-0 w-1/3 bg-kumo-brand animate-[thinking_1.5s_ease-in-out_infinite]" />
          </span>
        )}
      </span>
    </Tooltip>
  )
}
