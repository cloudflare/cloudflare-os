// Ported from `workshop-frontend`'s `siteLogoUtils.ts`, which checks an image before the browser
// decodes it, and makes it the PNG `AdminApi.setSiteLogo` asks for. Its favicon is the shell's, which
// this app does not have yet.
import { MAX_SITE_LOGO_BYTES } from '@gadgets/workshop-shared/api'

const SITE_LOGO_SIZE = 256
const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const MAX_SOURCE_PIXELS = 16_000_000
const MAX_SOURCE_DIMENSION = 8_192
let nextCacheBust = 0

type ImageDimensions = { width: number; height: number }

/** Calculates aspect-preserving output dimensions with a 256px longest edge. */
export function siteLogoDimensions(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error('Invalid image dimensions.')
  const scale = SITE_LOGO_SIZE / Math.max(width, height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function pngDimensions(data: Uint8Array): ImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (data.byteLength < 24 || !signature.every((byte, index) => data[index] === byte)) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function jpegDimensions(data: Uint8Array): ImageDimensions | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 4 <= data.byteLength) {
    if (data[offset] !== 0xff) return null
    while (offset < data.byteLength && data[offset] === 0xff) offset++
    if (offset >= data.byteLength) return null
    const marker = data[offset++]
    if (marker === 0xd9 || marker === 0xda || offset + 2 > data.byteLength) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0x00) return null
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > data.byteLength) return null
    if (startOfFrame.has(marker)) {
      if (length < 7) return null
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
    }
    offset += length
  }
  return null
}

function webpDimensions(data: Uint8Array): ImageDimensions | null {
  const text = (offset: number, length: number) =>
    String.fromCharCode(...data.subarray(offset, offset + length))
  if (data.byteLength < 25 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP') return null
  const type = text(12, 4)
  if (type === 'VP8X' && data.byteLength >= 30) {
    return {
      width: 1 + data[24] + data[25] * 256 + data[26] * 65_536,
      height: 1 + data[27] + data[28] * 256 + data[29] * 65_536,
    }
  }
  if (type === 'VP8L' && data[20] === 0x2f) {
    return {
      width: 1 + data[21] + ((data[22] & 0x3f) << 8),
      height: 1 + (data[22] >> 6) + (data[23] << 2) + ((data[24] & 0x0f) << 10),
    }
  }
  if (type === 'VP8 ' && data.byteLength >= 30 &&
      data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  return null
}

function readFile(file: File, mode: 'arrayBuffer'): Promise<ArrayBuffer>
function readFile(file: File, mode: 'text'): Promise<string>
function readFile(file: File, mode: 'arrayBuffer' | 'text'): Promise<ArrayBuffer | string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer | string), { once: true })
    reader.addEventListener('error', () => reject(new Error('Failed to read the selected image.')), {
      once: true,
    })
    if (mode === 'arrayBuffer') reader.readAsArrayBuffer(file)
    else reader.readAsText(file)
  })
}

/** Whether an attribute's or a style's text in an SVG reaches anything outside the file. */
export function hasExternalSvgResource(value: string): boolean {
  if (/@import/i.test(value)) return true
  for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
    const target = match[1].trim().replace(/^["']|["']$/g, '').trim()
    if (!target.startsWith('#')) return true
  }
  return false
}

async function validateSvgResources(file: File): Promise<void> {
  const document = new DOMParser().parseFromString(await readFile(file, 'text'), 'image/svg+xml')
  const root = document.documentElement
  if (root.localName !== 'svg' || document.querySelector('parsererror')) {
    throw new Error('The selected file is not a supported image.')
  }
  const blockedElements = new Set([
    'script', 'foreignobject', 'image', 'feimage', 'iframe', 'object', 'embed',
    'set', 'animate', 'animatecolor', 'animatetransform', 'animatemotion', 'mpath', 'discard',
  ])
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (blockedElements.has(element.localName.toLowerCase())) {
      throw new Error('SVG logos cannot contain embedded images or external resources.')
    }
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on') ||
          ((name === 'href' || name.endsWith(':href') || name === 'src') &&
            value !== '' && !value.startsWith('#')) || hasExternalSvgResource(value)) {
        throw new Error('SVG logos cannot contain embedded images or external resources.')
      }
    }
    if (element.localName === 'style' && hasExternalSvgResource(element.textContent ?? '')) {
      throw new Error('SVG logos cannot contain embedded images or external resources.')
    }
  }
}

function validateSourceDimensions(
  { width, height }: ImageDimensions,
  enforceRasterLimit = true,
): void {
  if (width <= 0 || height <= 0 || (enforceRasterLimit &&
      (width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION ||
        width * height > MAX_SOURCE_PIXELS))) {
    throw new Error('Logo source dimensions are too large.')
  }
}

/** A PNG's, a JPEG's or a WebP's size, from its header, or null for anything else. */
export function imageDimensions(data: Uint8Array): ImageDimensions | null {
  return pngDimensions(data) ?? jpegDimensions(data) ?? webpDimensions(data)
}

async function preflightRasterDimensions(file: File): Promise<void> {
  if (file.type === 'image/svg+xml') {
    await validateSvgResources(file)
    return
  }
  const data = new Uint8Array(await readFile(file, 'arrayBuffer'))
  const dimensions = imageDimensions(data)
  if (!dimensions) throw new Error('The selected file is not a supported image.')
  validateSourceDimensions(dimensions)
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Failed to encode the logo as PNG.'))
    }, 'image/png')
  })
}

type DecodedImage = {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (file.type !== 'image/svg+xml' && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      }
    } catch {
      // Fall through to the broadly-supported HTML image decoder.
    }
  }

  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.addEventListener('load', () => resolve(element), { once: true })
      element.addEventListener('error', () => {
        reject(new Error('The selected file could not be decoded as an image.'))
      }, { once: true })
      element.src = url
    })
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

/** Decodes, scales, and rasterizes an uploaded image into a bounded static PNG. */
export async function prepareSiteLogo(file: File): Promise<Uint8Array> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Logo source image is too large (max 5 MB).')
  if (file.type && !file.type.startsWith('image/')) throw new Error('Choose an image file.')
  await preflightRasterDimensions(file)

  let image: DecodedImage
  try {
    image = await decodeImage(file)
  } catch {
    throw new Error('The selected file could not be decoded as an image.')
  }

  try {
    validateSourceDimensions(image, file.type !== 'image/svg+xml')
    const dimensions = siteLogoDimensions(image.width, image.height)
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Failed to prepare the logo image.')
    context.drawImage(image.source, 0, 0, dimensions.width, dimensions.height)

    const png = await canvasToPng(canvas)
    if (png.size > MAX_SITE_LOGO_BYTES) {
      throw new Error('Logo is too complex to fit within the upload limit.')
    }
    return new Uint8Array(await png.arrayBuffer())
  } finally {
    image.close()
  }
}

/** Adds a client-only token so a fresh config fetch reloads the stable logo resource. */
export function cacheBustSiteLogoUrl(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}v=${Date.now().toString(36)}-${nextCacheBust++}`
}
