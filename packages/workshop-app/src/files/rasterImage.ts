// The only image types the browser is given from an object URL, which is of the app's own origin
// and can be opened in a tab of its own. These never run anything, however they are opened; an
// SVG would, and is given another way (`svgImage.ts`).
const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

/** Whether `mimeType` is an image that is only pixels, and so safe to give the browser from an object URL. */
export const isRasterImage = (mimeType: string) => RASTER_IMAGE_TYPES.has(mimeType.split(';')[0].trim().toLowerCase())
