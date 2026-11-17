// What `AuthenticatedApi.setAvatar` asks for: a compressed image, ideally under 50 KB.
const MAX_BYTES = 50 * 1024
// The picture's side, in pixels: several times the largest it is drawn at.
const SIDE = 256

const encode = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))), 'image/jpeg', quality)
  })

/**
 * An image file as a user's picture: the square at its middle, scaled to 256 pixels a side, as a
 * JPEG compressed until it is small enough to keep. Rejects for a file the browser cannot read
 * as an image. Ported from `workshop-frontend`'s `avatarUtils.ts`.
 */
export const avatarImage = async (file: File): Promise<Uint8Array> => {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = SIDE
  canvas.height = SIDE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The image could not be drawn.')
  const side = Math.min(bitmap.width, bitmap.height)
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIDE, SIDE)
  bitmap.close()

  for (let quality = 0.85; quality >= 0.3; quality -= 0.1) {
    const blob = await encode(canvas, quality)
    if (blob.size <= MAX_BYTES) return new Uint8Array(await blob.arrayBuffer())
  }
  // As small as it gets, whatever it comes to.
  return new Uint8Array(await (await encode(canvas, 0.2)).arrayBuffer())
}
