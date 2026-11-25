import type { GadgetExportFormat, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { getResourceTypeId, type SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { webUrl } from '@gadgets/ui'
import type { SavedType } from '@/files/saveStream'
import type { SavedExport } from '@/prefs/preferenceFields'

/** A kind of file a gadget can be saved as in one of the user's accounts, and the export it is made from. */
export type SaveTarget = {
  vendor: GatekeeperVendorInfo
  resource: SupportedResource
  format: GadgetExportFormat
}

/** A save the export menu offers: where to, told apart by `key`, with the file the last one made, which it can update. */
export type SaveChoice = SaveTarget & { key: string; saved?: SavedExport }

/** What a gadget can be exported as, as far as it has been read. */
export type ExportChoices =
  | { status: 'loading' }
  | { status: 'ready'; formats: GadgetExportFormat[]; saves: SaveChoice[] }
  | { status: 'failed'; message: string }

/** What was last asked of the exports, while it is under way and for a moment once done. */
export type ExportActivity =
  | { kind: 'exporting'; format: GadgetExportFormat }
  | { kind: 'failed'; format: GadgetExportFormat; message: string }
  /** `url` is where the file is, where the service said so in a form a browser can open. */
  | { kind: 'saved'; title: string; url?: string }

export type GadgetExportsSnapshot = {
  /** Nothing until they are first asked for (`list()`). */
  choices?: ExportChoices
  activity?: ExportActivity
}

/** The part of a gadget its exports use, and the lease that must be disposed. */
export type ExportGadget = {
  getExportFormats(chatId?: number): Promise<GadgetExportFormat[]>
  export(id: string, chatId?: number): Promise<ReadableStream<Uint8Array>>
} & Disposable

/** How a gadget is saved to the user's accounts, for whoever may: the services, the save itself, and what was saved before. */
export type ExportSaving = {
  listVendors(): Promise<GatekeeperVendorInfo[]>
  /** `AuthenticatedApi.saveFile()`, given the export unawaited, so that it goes straight to the service. */
  saveFile(
    accountId: number, resourceTypeId: string, destination: string, name: string, contentType: string, file: Promise<ReadableStream<Uint8Array>>,
  ): Promise<{ url: string }>
  /** What a save to `target` is kept under (`savedExportKey`). */
  keyOf(target: SaveTarget): string
  read(key: string): SavedExport | undefined
  write(key: string, saved: SavedExport): void
}

export type GadgetExportsOptions = {
  /** Exports the gadget with the changes proposed in this chat. */
  chatId?: number
  /** Offers saving it to the user's accounts. */
  saving?: ExportSaving
  /** Saves an export to the device (`saveStream`). */
  saveToDevice: (open: () => Promise<ReadableStream<Uint8Array>>, name: string, type: SavedType) => Promise<void>
}

// How long a save that was made is said to have been, which is all there is to say of it.
const SAVED_SHOWN = 6000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const fileName = (name: string, fallback: string) => name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback

/**
 * What an export of the gadget titled `title` is saved as on the device: the name its format
 * suggests, or else the title with the format's extension, each made safe as a file's name, as the
 * old app made it.
 */
export const exportFileName = (title: string, { fileExtension, fileName: suggested }: Pick<GadgetExportFormat, 'fileExtension' | 'fileName'>) => {
  const fallback = `${fileName(title, 'gadget')}${fileExtension}`
  return suggested === undefined ? fallback : fileName(suggested, fallback)
}

/**
 * Every kind of file the services offered can make from one of `formats`: a kind with a form for
 * where it goes (`creationConfigurator`) that names the format among those it is made from
 * (`savableFrom`), with the one it likes best. A service that could not be reached offers none.
 */
export const saveTargetsOf = (vendors: readonly GatekeeperVendorInfo[], formats: readonly GadgetExportFormat[]): SaveTarget[] =>
  vendors.flatMap((vendor) => vendor.unavailable ? [] : vendor.supportedResources.flatMap((resource) => {
    const format = resource.creationConfigurator
      ? resource.savableFrom?.map((type) => formats.find(({ contentType }) => contentType === type)).find((found) => found)
      : undefined
    return format ? [{ vendor, resource, format }] : []
  }))

/**
 * What a gadget's last save to `target` is kept under, in the user's own account: the gadget's in
 * its workspace, as its id is only a count within it.
 */
export const savedExportKey = (gadget: { workspaceId: string; workpieceId: number }, { vendor, resource }: SaveTarget) =>
  JSON.stringify([gadget.workspaceId, gadget.workpieceId, vendor.id, getResourceTypeId(resource)])

/**
 * One gadget's exports: what it can be exported as, read each time it is asked for, as the code
 * they are read from may have changed since; an export saved to the device; and, given `saving`,
 * one saved as a file in one of the user's accounts, or over the file the last such save made.
 * Observable through `subscribe`/`getSnapshot`. Each call opens the gadget for as long as it
 * needs it, so nothing is held between them; `stop()` drops what comes back of what is under way,
 * until `start()` again.
 *
 * Only one export to the device is under way at a time. A save rejects with why it was not made,
 * for the dialog it was asked from to say.
 */
export class GadgetExports {
  #snapshot: GadgetExportsSnapshot = {}
  #listeners = new Set<() => void>()
  // Bumped by every listing and by `stop()`, so a listing that comes back late can tell it is stale.
  #listing = 0
  #stopped = false
  #shown: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly open: () => ExportGadget, private readonly options: GadgetExportsOptions) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  /** Reads what the gadget can be exported as and saved to, with what was shown up meanwhile only once it failed. */
  list = async () => {
    const listing = ++this.#listing
    this.#publish({ ...this.#snapshot, choices: { status: 'loading' } })
    const { chatId, saving } = this.options
    let gadget: ExportGadget | undefined
    try {
      gadget = this.open()
      // Without the services the formats are still offered, with nothing to save to.
      const [formats, vendors] = await Promise.all([gadget.getExportFormats(chatId), saving?.listVendors().catch(() => []) ?? []])
      if (listing !== this.#listing) return
      this.#publish({ ...this.#snapshot, choices: { status: 'ready', formats, saves: this.#choicesOf(saveTargetsOf(vendors, formats)) } })
    } catch (error) {
      if (listing === this.#listing) this.#publish({ ...this.#snapshot, choices: { status: 'failed', message: messageOf(error) } })
    } finally {
      gadget?.[Symbol.dispose]()
    }
  }

  /** Exports it as `format` to the device, under a name made from `title`; does nothing while another is under way. */
  download = async (format: GadgetExportFormat, title: string) => {
    if (this.#snapshot.activity?.kind === 'exporting') return
    this.#activity({ kind: 'exporting', format })
    let gadget: ExportGadget | undefined
    try {
      await this.options.saveToDevice(
        () => (gadget = this.open()).export(format.id, this.options.chatId),
        exportFileName(title, format),
        { description: format.label, contentType: format.contentType, extension: format.fileExtension },
      )
      this.#activity(undefined)
    } catch (error) {
      this.#activity({ kind: 'failed', format, message: messageOf(error) })
    } finally {
      gadget?.[Symbol.dispose]()
    }
  }

  /** Saves it as `choice` in the account chosen, where its form chose (`destination`), under `name`. */
  save = async (choice: SaveChoice, { accountId, destination, name }: { accountId: number; destination: string; name: string }) => {
    const { saving, chatId } = this.options
    if (!saving) throw new Error('This gadget can’t be saved from here.')
    const { resource, format } = choice
    const gadget = this.open()
    try {
      // Unawaited, so that the export is piped to the service without coming here.
      const { url } = await saving.saveFile(accountId, getResourceTypeId(resource), destination, name, format.contentType, gadget.export(format.id, chatId))
      const saved = { accountId, url, name }
      saving.write(choice.key, saved)
      if (this.#stopped) return
      const { choices } = this.#snapshot
      this.#publish({
        ...this.#snapshot,
        choices: choices?.status === 'ready' ? { ...choices, saves: choices.saves.map((each) => (each.key === choice.key ? { ...each, saved } : each)) } : choices,
      })
      this.#activity({ kind: 'saved', title: `Saved to ${resource.title}`, url: webUrl(url) })
    } finally {
      gadget[Symbol.dispose]()
    }
  }

  /** Puts what was said of the last export away. */
  dismiss = () => this.#activity(undefined)

  start() {
    this.#stopped = false
  }

  stop() {
    this.#stopped = true
    this.#listing++
    clearTimeout(this.#shown)
  }

  #choicesOf(targets: SaveTarget[]): SaveChoice[] {
    const { saving } = this.options
    if (!saving) return []
    return targets.map((target) => {
      const key = saving.keyOf(target)
      const saved = saving.read(key)
      return { ...target, key, ...(saved ? { saved } : {}) }
    })
  }

  #activity(activity: ExportActivity | undefined) {
    if (this.#stopped) return
    clearTimeout(this.#shown)
    this.#publish({ ...this.#snapshot, activity })
    if (activity?.kind === 'saved') this.#shown = setTimeout(() => this.#activity(undefined), SAVED_SHOWN)
  }

  #publish(snapshot: GadgetExportsSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}
