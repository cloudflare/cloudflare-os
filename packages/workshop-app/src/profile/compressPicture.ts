// What the server keeps of a picture: a square JPEG, small enough to send with every look.
const SIZE = 256
const MAX_BYTES = 50 * 1024

const encode = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob>((resolve, reject) => {
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture couldn’t be read.'))), 'image/jpeg', quality)
})

/**
 * A picture for the user's profile, from an image file: its middle, cut square, at 256 pixels a
 * side, as a JPEG of no more than 50 KB, as the server takes it (`setAvatar`). Rejects with why a
 * file is not an image it can read.
 */
export const compressPicture = async (file: File): Promise<Uint8Array> => {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name} isn’t a picture this browser can read.`)
  })
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The picture couldn’t be drawn.')
  const side = Math.min(bitmap.width, bitmap.height)
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE)
  bitmap.close()
  // Less and less fine until it fits.
  for (let quality = 0.85; quality > 0.25; quality -= 0.1) {
    const blob = await encode(canvas, quality)
    if (blob.size <= MAX_BYTES) return new Uint8Array(await blob.arrayBuffer())
  }
  return new Uint8Array(await (await encode(canvas, 0.2)).arrayBuffer())
}
