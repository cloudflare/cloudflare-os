import { useEffect, useState } from 'react'

/**
 * An object URL for `content`, typed `type`, released when either changes or the component goes
 * away. Nothing, for no content.
 */
export const useObjectUrl = (content: Blob | Uint8Array | undefined, type: string) => {
  const [made, setMade] = useState<{ content: Blob | Uint8Array; type: string; url: string }>()
  useEffect(() => {
    if (!content) return
    const url = URL.createObjectURL(new Blob([content as BlobPart], { type }))
    setMade({ content, type, url })
    return () => URL.revokeObjectURL(url)
  }, [content, type])
  // Only the URL made for what is asked for now: a revoked one shows nothing.
  return made && made.content === content && made.type === type ? made.url : undefined
}
