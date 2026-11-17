/** Saves bytes to the user's device under `name`, as a download. */
export const saveBytes = (bytes: Uint8Array, name: string) => {
  // As bytes and nothing else, so that it is saved rather than opened.
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
