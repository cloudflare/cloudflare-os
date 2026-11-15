import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { GadgetConnection, type GadgetSnapshot } from '@/aside/GadgetConnection'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'

const LOADING: GadgetSnapshot = { ui: { status: 'loading' }, people: [] }
const noSubscription = () => () => {}
const loading = () => LOADING

/**
 * The owner's view of a gadget, running, while `shown`: what people who can't use it live see
 * (`GadgetClient.openView`, which takes it again first when it is out of date). `frame` is for the
 * frame it is shown in, whose page alone is listened to. Shown again later, it is opened again.
 */
export const useViewPreview = (workspaceId: string, gadgetId: number, shown: boolean) => {
  const { api, user } = useApi()
  const notice = useConnectionNotice()
  // The API the connection opens the workspace with, read when it connects.
  const latestApi = useRef(api)
  const frame = useRef<HTMLIFrameElement>(null)
  const [connection, setConnection] = useState<GadgetConnection>()

  useEffect(() => {
    if (!shown) return
    const made = new GadgetConnection(() => latestApi.current.openWorkspace(workspaceId), gadgetId, {
      view: true,
      viewerId: user.id,
      connection: notice ?? undefined,
    })
    made.showIn(() => frame.current?.contentWindow)
    made.start()
    setConnection(made)
    return () => {
      made.stop()
      setConnection(undefined)
    }
    // `notice` is read as it is when the preview opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, gadgetId, shown, user.id])

  useLayoutEffect(() => {
    if (latestApi.current === api) return
    latestApi.current = api
    connection?.reconnect()
  }, [api, connection])

  const { ui } = useSyncExternalStore(connection?.subscribe ?? noSubscription, connection?.getSnapshot ?? loading)
  return { ui, frame, reload: () => connection?.reload() }
}
