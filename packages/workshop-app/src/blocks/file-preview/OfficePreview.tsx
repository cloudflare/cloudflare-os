import { lazy, memo, Suspense, type ComponentType, type ReactNode } from 'react'
import { FilePreviewBoundary } from './FilePreviewBoundary'
import type { FilePreviewProps } from './previewTypes'

/** The files drawn from their bytes by the previewers here. */
export type OfficePreviewKind = 'document' | 'slides' | 'workbook' | 'delimited'

// Memoised, as a previewer's props never change and an open document or grid is too large to
// reconcile again whenever what holds it renders. Each loads on first use, its reader with it.
const previewer = (load: () => Promise<ComponentType<FilePreviewProps>>) => memo(lazy(() => load().then((component) => ({ default: component }))))

const PREVIEWERS: Record<OfficePreviewKind, ComponentType<FilePreviewProps>> = {
  document: previewer(() => import('./DocumentPreview').then((module) => module.DocumentPreview)),
  slides: previewer(() => import('./SlidesPreview').then((module) => module.SlidesPreview)),
  workbook: previewer(() => import('./WorkbookPreview').then((module) => module.WorkbookPreview)),
  delimited: previewer(() => import('./DelimitedPreview').then((module) => module.DelimitedPreview)),
}

export type OfficePreviewProps = FilePreviewProps & {
  kind: OfficePreviewKind
  /** Shown while the file is read. */
  loading: ReactNode
  /** Shown instead, with what to tell the person, for a file that could not be read. */
  failed: (message: string) => ReactNode
}

/**
 * A Word document, PowerPoint deck or Excel workbook drawn in its own layout, or a CSV or TSV as a
 * grid, from the file's bytes. The file is read in a worker, so a large one never holds up the page.
 */
export const OfficePreview = ({ kind, loading, failed, ...file }: OfficePreviewProps) => {
  const Previewer = PREVIEWERS[kind]
  return (
    <FilePreviewBoundary key={`${kind}:${file.name}`} fallback={failed}>
      <Suspense fallback={loading}>
        <Previewer {...file} />
      </Suspense>
    </FilePreviewBoundary>
  )
}
