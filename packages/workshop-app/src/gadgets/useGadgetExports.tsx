import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ExportChoices as MenuChoices, ExportItemsProps } from '@/blocks/ExportItems'
import type { PaneStatusProps } from '@/blocks/PaneStatus'
import { UpdateFileDialog } from '@/blocks/UpdateFileDialog'
import { TextField } from '@/components/TextField'
import type { AsideOutput } from '@/aside/asideItems'
import { ConnectResource } from '@/connections/SetUpConnection'
import { saveStream } from '@/files/saveStream'
import { readSavedExport, writeSavedExport } from '@/prefs/savedExports'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { GadgetExports, savedExportKey, type ExportChoices, type ExportGadget, type GadgetExportsSnapshot, type SaveChoice } from './GadgetExports'

const NOTHING: GadgetExportsSnapshot = {}
const noSubscription = () => () => {}
const nothing = () => NOTHING

// A save asked for, until its dialog has gone: of the exports it was asked of, so that it is
// dropped once the pane shows another gadget, or the same from another chat.
type Asking = { exports: GadgetExports; choice: SaveChoice; update: boolean; name: string; open: boolean }

const menuChoices = (choices: ExportChoices | undefined): MenuChoices | undefined =>
  choices?.status !== 'ready' ? choices : {
    status: 'ready',
    formats: choices.formats.map(({ id, label }) => ({ id, label })),
    saves: choices.saves.map(({ key, vendor, resource, saved }) => ({
      key,
      title: resource.title,
      // What the service draws the kind with, or failing that the service.
      iconUrl: resource.icon?.url ?? vendor.description.logo?.url,
      saved: saved?.name,
    })),
  }

/**
 * A gadget's exports (`GadgetExports`), for its settings: what it can be exported as (`menu`, for
 * `ExportItems`), what became of the last one (`status`), and the dialogs a save asks with
 * (`dialogs`).
 * Everyone it is shown to may export it, as the backend lets whoever can use it; only those who
 * may build in its workspace (`saves`) are offered saving it to their accounts, as in the old app.
 */
export const useGadgetExports = (gadget: AsideOutput | undefined, title: string, { saves }: { saves: boolean }) => {
  const { api, user } = useApi()
  const notice = useConnectionNotice()
  // The API each call opens the workspace with, read when it is made.
  const latestApi = useRef(api)
  latestApi.current = api
  const key = gadget?.type === 'gadget' ? `${gadget.workspaceId}/${gadget.workpieceId}/${gadget.chatId}/${saves}` : undefined
  const [current, setCurrent] = useState<{ key?: string; exports?: GadgetExports }>({})
  if (current.key !== key) {
    const exports = gadget && key
      ? new GadgetExports(() => {
          // Disposed by hand: `using` is not lowered for every browser this runs in.
          const overseer = latestApi.current.openWorkspace(gadget.workspaceId)
          const stub = overseer.getGadget(gadget.workpieceId)
          const handle: ExportGadget = {
            getExportFormats: (chatId) => stub.getExportFormats(chatId),
            // As it is, unawaited, so that a save pipelines it to the service.
            export: (id, chatId) => stub.export(id, chatId),
            [Symbol.dispose]: () => {
              stub[Symbol.dispose]()
              overseer[Symbol.dispose]()
            },
          }
          return handle
        }, {
          chatId: gadget.chatId,
          saveToDevice: saveStream,
          saving: saves ? {
            listVendors: () => latestApi.current.listGatekeeperVendors(),
            saveFile: (...args) => latestApi.current.saveFile(...args),
            keyOf: (target) => savedExportKey(user.id, gadget, target),
            read: readSavedExport,
            write: writeSavedExport,
          } : undefined,
        })
      : undefined
    setCurrent({ key, exports })
  }
  const { exports } = current

  useEffect(() => {
    exports?.start()
    return () => exports?.stop()
  }, [exports])

  const { choices, activity } = useSyncExternalStore(exports?.subscribe ?? noSubscription, exports?.getSnapshot ?? nothing)
  const [asking, setAsking] = useState<Asking>()

  const ask = (choiceKey: string, update: boolean) => {
    if (!exports || notice?.blocked()) return
    const choice = choices?.status === 'ready' ? choices.saves.find((each) => each.key === choiceKey) : undefined
    if (choice) setAsking({ exports, choice, update: update && choice.saved !== undefined, name: title, open: true })
  }

  const menu: ExportItemsProps | undefined = exports && {
    choices: menuChoices(choices),
    onOpen: () => void exports.list(),
    exporting: activity?.kind === 'exporting' ? activity.format.id : undefined,
    onExport: (id) => {
      const format = choices?.status === 'ready' ? choices.formats.find((each) => each.id === id) : undefined
      if (format && !notice?.blocked()) void exports.download(format, title)
    },
    onSave: (choiceKey) => ask(choiceKey, false),
    onUpdate: (choiceKey) => ask(choiceKey, true),
  }

  const status: PaneStatusProps | undefined = !activity ? undefined
    : activity.kind === 'exporting' ? { tone: 'working', title: `Exporting to ${activity.format.label}…` }
    : activity.kind === 'failed' ? { tone: 'failed', title: `Couldn’t export ${activity.format.label}`, description: activity.message, onDismiss: exports?.dismiss }
    : {
        tone: 'done',
        title: activity.title,
        action: activity.url !== undefined ? { label: 'Open', onSelect: () => window.open(activity.url, '_blank', 'noopener') } : undefined,
        onDismiss: exports?.dismiss,
      }

  const shown = asking?.exports === exports ? asking : undefined
  const setOpen = (open: boolean) => setAsking((was) => was && { ...was, open })
  const dialogs = shown && (shown.update && shown.choice.saved ? (
    <UpdateFileDialog
      open={shown.open}
      onOpenChange={setOpen}
      name={shown.choice.saved.name}
      onConfirm={async () => {
        const { saved } = shown.choice
        if (!saved || notice?.blocked()) return
        await shown.exports.save(shown.choice, { accountId: saved.accountId, destination: saved.url, name: saved.name })
        setOpen(false)
      }}
    />
  ) : (
    <ConnectResource
      key={shown.choice.key}
      open={shown.open}
      onOpenChange={setOpen}
      vendorId={shown.choice.vendor.id}
      name={shown.choice.vendor.description.displayName}
      logoUrl={shown.choice.vendor.description.logo?.url}
      resourceUrlPattern={shown.choice.resource.urlPattern}
      save={{
        title: `Save to ${shown.choice.resource.title}`,
        fields: (
          <TextField
            label="Name"
            value={shown.name}
            onValueChange={(name) => setAsking((was) => was && { ...was, name })}
          />
        ),
        ready: shown.name.trim() !== '',
        onSave: (accountId, destination) => shown.exports.save(shown.choice, { accountId, destination, name: shown.name.trim() }),
      }}
    />
  ))

  return { menu, status, dialogs }
}
