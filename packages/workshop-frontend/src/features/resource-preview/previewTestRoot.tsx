import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import type { ChangeDecision } from './changeMarks'
import { ResourcePreviewView } from './ResourcePreviewView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A React root for one test file's renders, under jsdom. */
export function previewTestRoot() {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  return {
    async render(node: ReactNode) {
      if (!root) {
        container = document.createElement('div')
        document.body.append(container)
        root = createRoot(container)
      }
      await act(async () => root!.render(node))
      return container!
    },
    cleanup() {
      act(() => root?.unmount())
      container?.remove()
      root = undefined
      container = undefined
    },
  }
}

/** ResourcePreviewView with test defaults. */
export const renderPreview = (preview: ResourcePreview, options: {
  focusedChangeId?: number | null
  decided?: [number, ChangeDecision][]
  onChangeClick?: (changeId: number) => void
} = {}) => (
  <ResourcePreviewView
    preview={preview}
    focusedChangeId={options.focusedChangeId ?? null}
    decided={new Map(options.decided)}
    onChangeClick={options.onChangeClick ?? (() => {})}
  />
)

export const changeElements = (container: Element, changeId: number) =>
  [...container.querySelectorAll(`[data-change-id="${changeId}"]`)]
