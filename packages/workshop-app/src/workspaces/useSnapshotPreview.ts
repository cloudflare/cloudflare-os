import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getSnapshotSharingErrorCode, SNAPSHOT_SHARING_ERROR_CODES } from '@gadgets/workshop-shared/api'
import { GadgetConnection, type GadgetOverseer } from '@/aside/GadgetConnection'
import type { ExportItemsProps } from '@/blocks/ExportItems'
import type { SnapshotPreviewProps } from '@/blocks/SnapshotPreview'
import { saveStream } from '@/files/saveStream'
import { GadgetExports } from '@/gadgets/GadgetExports'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'

// Nothing of the workspace is followed: a snapshot stays as it was taken until it is taken again.
const unfollowed = () => Promise.resolve({ [Symbol.dispose]() {} })

/**
 * A snapshot of a gadget (`Overseer.getGadgetSnapshot`), live for as long as whatever shows it is
 * there: taken as it mounts and let go as it unmounts, so the copy lasts no longer than the look
 * at it. Its page runs as a gadget's does (`GadgetConnection`), told it is a snapshot, and what is
 * written in it stays in the copy. `refresh` takes it again, as whoever views it can, and its
 * exports are the snapshot's own.
 */
export const useSnapshotPreview = (workspaceId: string, gadgetId: number, title: string, onEscape: () => void) => {
  const { api } = useApi()
  const notice = useConnectionNotice()
  const latestApi = useRef(api)
  const [problem, setProblem] = useState<string>()
  const frame = useRef<HTMLIFrameElement>(null)
  const [made] = useState(() => {
    // The snapshot as last opened, used before it resolves, as Cap'n Web's promises can be.
    let snapshot: ReturnType<ReturnType<typeof api.openWorkspace>['getGadgetSnapshot']> | undefined
    const connection = new GadgetConnection((): GadgetOverseer => {
      // Disposed by the connection, with the snapshot it opened.
      const overseer = latestApi.current.openWorkspace(workspaceId)
      const opened = (snapshot = overseer.getGadgetSnapshot(gadgetId))
      return {
        getGadget: () => opened,
        subscribeToPresence: unfollowed,
        subscribeToChat: unfollowed,
        subscribeToWorkpieces: unfollowed,
        onRpcBroken: (callback) => overseer.onRpcBroken(callback),
        [Symbol.dispose]: () => overseer[Symbol.dispose](),
      }
    }, gadgetId, { renderMode: 'snapshot', onEscape, connection: notice ?? undefined })
    connection.showIn(() => frame.current?.contentWindow)
    const exports = new GadgetExports(() => ({
      getExportFormats: () => snapshot!.getExportFormats(),
      export: (id) => snapshot!.export(id),
      // The snapshot is the connection's to let go.
      [Symbol.dispose]() {},
    }), { saveToDevice: saveStream })
    return { connection, exports, snapshot: () => snapshot }
  })
  const { connection, exports } = made

  useEffect(() => {
    connection.start()
    exports.start()
    return () => {
      exports.stop()
      connection.stop()
    }
  }, [connection, exports])

  // A new connection to the backend takes it again, as the old copy went with the old one.
  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    connection.reconnect()
  }, [api, connection])

  const { ui } = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  const { choices, activity } = useSyncExternalStore(exports.subscribe, exports.getSnapshot)

  const refresh = async () => {
    if (notice?.blocked()) return
    setProblem(undefined)
    try {
      await made.snapshot()?.refresh()
      // The old copy's page is connected to nothing now: it starts over on the new one.
      connection.reload()
    } catch (error) {
      setProblem(getSnapshotSharingErrorCode(error) === SNAPSHOT_SHARING_ERROR_CODES.disabled
        ? 'An administrator turned off gadget snapshot sharing.'
        : 'Failed to refresh the snapshot')
      throw error
    }
  }

  const menu: ExportItemsProps = {
    choices: choices?.status === 'ready' ? { status: 'ready', formats: choices.formats.map(({ id, label }) => ({ id, label })), saves: [] } : choices,
    onOpen: () => void exports.list(),
    exporting: activity?.kind === 'exporting' ? activity.format.id : undefined,
    onExport: (id) => {
      const format = choices?.status === 'ready' ? choices.formats.find((each) => each.id === id) : undefined
      if (format && !notice?.blocked()) void exports.download(format, title)
    },
    onSave: () => {},
    onUpdate: () => {},
  }

  const snapshot: SnapshotPreviewProps['snapshot'] = ui.status === 'ready' ? ui : ui.status === 'loading' || ui.status === 'none' ? { status: ui.status } : { status: 'failed' }
  return {
    snapshot,
    frame,
    onRefresh: refresh,
    problem: problem ?? (activity?.kind === 'failed' ? `Couldn’t export it: ${activity.message}` : undefined),
    exports: menu,
  }
}
