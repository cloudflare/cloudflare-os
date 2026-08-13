import { useEffect } from 'react'
import { useSiteName } from './ServerConfigContext'

/**
 * Sets document.title to "<title> - <siteName>" for the lifetime of the calling component,
 * restoring the previous title on unmount. The site name comes from the admin-configurable
 * deployment config. Pass null/undefined to leave the title unchanged (useful while a page's
 * dynamic title is still loading).
 */
export function useDocumentTitle(title: string | null | undefined) {
  const siteName = useSiteName()

  useEffect(() => {
    if (title == null) return

    const previousTitle = document.title
    document.title = title ? `${title} - ${siteName}` : siteName

    return () => {
      document.title = previousTitle
    }
  }, [title, siteName])
}
