import { useEffect, useState } from 'react'

/** Mounts a Select portal host above Kumo's body-level dialog layers. */
export function useDialogSelectPortalContainer(): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    const element = document.createElement('div')
    element.style.position = 'relative'
    element.style.zIndex = '1100'
    document.body.appendChild(element)
    setContainer(element)

    return () => {
      setContainer(null)
      element.remove()
    }
  }, [])

  return container
}
