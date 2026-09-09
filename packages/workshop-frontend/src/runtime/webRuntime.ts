import { envUrl, originUrl, shouldSendSystemNotification, type DeepLinkEvent, type PendingNativeLoginFlow, type SaveFileOptions, type SystemNotificationOptions, type Unsubscribe, type WorkshopRuntime } from './WorkshopRuntime'

type SaveFileHandle = { createWritable(): Promise<WritableStream<Uint8Array>> }
type SaveFilePicker = (options: { suggestedName?: string; types?: Array<{ description?: string; accept: Record<string, string[]> }> }) => Promise<SaveFileHandle>

function browserApiOrigin(): URL {
  if (import.meta.env.DEV) {
    const host = import.meta.env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
    return new URL(`http://${host}`)
  }
  return originUrl(new URL(window.location.href))
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 100)
  }
}

export function createWebRuntime(): WorkshopRuntime {
  const publicWebOrigin = envUrl('VITE_ODIE_PUBLIC_WEB_ORIGIN') ?? originUrl(new URL(window.location.href))
  let deniedThisRuntime = false
  return {
    kind: 'web',
    apiOrigin: envUrl('VITE_ODIE_API_ORIGIN') ?? browserApiOrigin(),
    publicWebOrigin,
    appLinkOrigin: envUrl('VITE_ODIE_APP_LINK_ORIGIN') ?? publicWebOrigin,
    async getNativeAppInfo() {
      return null
    },
    async openExternal(url: string) {
      // `noopener` returns null even when the new tab opens successfully. It cannot
      // detect popup blocking; never navigate away from the user's work as a fallback.
      window.open(url, '_blank', 'noopener')
    },
    async openOAuthTrampoline(url: string) {
      await this.openExternal(url)
    },
    async subscribeDeepLinks(_callback: (event: DeepLinkEvent) => void): Promise<Unsubscribe> {
      return () => {}
    },
    async readSessionSecret() {
      return localStorage.getItem('authToken')
    },
    async writeSessionSecret(token: string) {
      localStorage.setItem('authToken', token)
    },
    async clearSessionSecret() {
      localStorage.removeItem('authToken')
    },
    async readPendingNativeLoginFlow() {
      const raw = sessionStorage.getItem('pendingNativeLoginFlow')
      if (!raw) return null
      return JSON.parse(raw) as PendingNativeLoginFlow
    },
    async writePendingNativeLoginFlow(flow: PendingNativeLoginFlow) {
      sessionStorage.setItem('pendingNativeLoginFlow', JSON.stringify(flow))
    },
    async clearPendingNativeLoginFlow() {
      sessionStorage.removeItem('pendingNativeLoginFlow')
    },
    async saveBlob(blob: Blob, options: SaveFileOptions) {
      const showSaveFilePicker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
      if (showSaveFilePicker) {
        let handle: SaveFileHandle
        try {
          handle = await showSaveFilePicker({
            suggestedName: options.filename,
            types: options.extension ? [{
              description: options.description,
              accept: { [options.contentType]: [options.extension] },
            }] : undefined,
          })
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error
          return
        }
        const writable = await handle.createWritable()
        if ('stream' in blob && typeof blob.stream === 'function') {
          await blob.stream().pipeTo(writable)
        } else {
          const writer = writable.getWriter()
          try {
            await writer.write(new Uint8Array(await blob.arrayBuffer()))
            await writer.close()
          } catch (error) {
            await writer.abort(error).catch(() => {})
            throw error
          }
        }
        return
      }
      triggerBlobDownload(blob, options.filename)
    },
    async saveText(filename: string, content: string) {
      triggerBlobDownload(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename)
    },
    async requestNotificationPermission() {
      try {
        if (!('Notification' in window)) return false
        if (Notification.permission === 'granted') return true
        if (Notification.permission === 'denied' || deniedThisRuntime) return false
        const permission = await Notification.requestPermission()
        if (permission === 'denied') deniedThisRuntime = true
        return permission === 'granted'
      } catch {
        return false
      }
    },
    async sendNotification(options: SystemNotificationOptions) {
      try {
        if (!shouldSendSystemNotification() || !('Notification' in window) || Notification.permission !== 'granted') return
        const notification = new Notification(options.title, { body: options.body })
        void notification
      } catch {}
    },
    async lock() {},
    async unlock() { return true },
  }
}
