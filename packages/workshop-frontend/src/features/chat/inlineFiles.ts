import type { ChatEmbeds, Overseer } from '@gadgets/workshop-shared/api'

/** A message's host-pinned files and the authenticated raw-byte reader. */
export type FileSnapshots = { oids: ChatEmbeds; readBlob: Overseer['readBlob'] }

/** An immutable file; paths are resolved only by the host when it saves the reply. */
export type InlineFile = { oid: string; stream: ReadableStream<Uint8Array> }

/** The narrow file-reading capability given to an inline view. */
export type SnapshotFileReader = (source: string) => Promise<InlineFile>

/** Read only a file already pinned into this message, without looking up its current path. */
export const readSnapshotFile = async (files: FileSnapshots, source: string): Promise<InlineFile> => {
  const oid = source.startsWith('worktree://') && Object.hasOwn(files.oids, source) ? files.oids[source] : undefined
  if (!oid) throw new Error(`File unavailable: ${source}`)
  return { oid, stream: await files.readBlob(oid) }
}
