/** Saves bytes the client already holds as a file download. */
export function saveBytesToFile(bytes: Uint8Array, name: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
