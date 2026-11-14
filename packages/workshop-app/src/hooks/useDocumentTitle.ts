import { useEffect } from 'react'

const APP = 'Cloudflare OS'

/**
 * Names the browser tab after what the page shows, while the calling component is mounted, so
 * that tabs of the app can be told apart. Nothing changes for an `undefined` title, such as one
 * still loading, or a component that is not the page.
 */
export const useDocumentTitle = (title: string | undefined) => {
  useEffect(() => {
    if (title === undefined) return
    document.title = `${title} · ${APP}`
    return () => {
      document.title = APP
    }
  }, [title])
}
