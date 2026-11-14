import type { GadgetClient, GadgetExportFormat } from '@gadgets/workshop-shared/api'
import { fileNameOf, saveStream, type SavedFile } from '@/files/saveFile'

/** The part of a gadget exporting uses, and the lease that must be disposed. */
export type ExportsGadget = Pick<GadgetClient, 'getExportFormats' | 'export'> & Disposable

/** The part of a workspace's Overseer exporting uses, and the lease that must be disposed. */
export type ExportsOverseer = { getGadget(id: number): ExportsGadget } & Disposable

/** What a gadget can be saved as, read when it is asked for. */
export type ExportFormats =
  | { status: 'unread' }
  | { status: 'loading' }
  | { status: 'ready'; formats: readonly GadgetExportFormat[] }
  | { status: 'failed'; message: string }

/** The export under way, or the last that failed. */
export type ExportProgress =
  | { status: 'exporting'; label: string }
  | { status: 'failed'; label: string; message: string }

export type GadgetExportsSnapshot = { formats: ExportFormats; progress: ExportProgress | undefined }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The file a format is saved as: the name the gadget suggests, else its title. */
export const savedFileOf = (format: GadgetExportFormat, title: string): SavedFile => ({
  name: format.fileName ? fileNameOf(format.fileName, `gadget${format.fileExtension}`) : `${fileNameOf(title, 'gadget')}${format.fileExtension}`,
  contentType: format.contentType,
  extension: format.fileExtension,
  description: format.label,
})

/**
 * Saving one gadget to this device (`GadgetClient.export`), as it is or as a chat proposes it: what
 * it can be saved as, read each time that is asked for, since its code may have changed since; and
 * one export at a time, which says it is under way and, if it fails, why, until dismissed or the
 * next. Each call opens the workspace for itself and lets go once done.
 */
export class GadgetExports {
  #snapshot: GadgetExportsSnapshot = { formats: { status: 'unread' }, progress: undefined }
  #listeners = new Set<() => void>()
  // Counts reads, so only the latest is shown.
  #read = 0

  constructor(
    private readonly open: () => ExportsOverseer,
    private readonly workpieceId: number,
    private readonly chatId?: number,
  ) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  #set(change: Partial<GadgetExportsSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...change }
    for (const listener of this.#listeners) listener()
  }

  /** Reads what it can be saved as, over what was read before. */
  loadFormats = async () => {
    const read = ++this.#read
    this.#set({ formats: { status: 'loading' } })
    const overseer = this.open()
    const gadget = overseer.getGadget(this.workpieceId)
    try {
      const formats = await gadget.getExportFormats(this.chatId)
      if (read === this.#read) this.#set({ formats: { status: 'ready', formats } })
    } catch (error) {
      if (read === this.#read) this.#set({ formats: { status: 'failed', message: messageOf(error) } })
    } finally {
      gadget[Symbol.dispose]()
      overseer[Symbol.dispose]()
    }
  }

  /**
   * Saves it as `format`, named from `title` unless the gadget names it. Called from the click
   * that asked for it, so the browser may ask where. Refused while another is under way.
   */
  exportAs = async (format: GadgetExportFormat, title: string) => {
    if (this.#snapshot.progress?.status === 'exporting') return
    this.#set({ progress: { status: 'exporting', label: format.label } })
    let overseer: ExportsOverseer | undefined
    let gadget: ExportsGadget | undefined
    try {
      await saveStream(() => {
        overseer = this.open()
        gadget = overseer.getGadget(this.workpieceId)
        return gadget.export(format.id, this.chatId)
      }, savedFileOf(format, title))
      this.#set({ progress: undefined })
    } catch (error) {
      this.#set({ progress: { status: 'failed', label: format.label, message: messageOf(error) } })
    } finally {
      gadget?.[Symbol.dispose]()
      overseer?.[Symbol.dispose]()
    }
  }

  /** Puts away why the last export failed. */
  dismiss = () => {
    if (this.#snapshot.progress?.status === 'failed') this.#set({ progress: undefined })
  }
}
