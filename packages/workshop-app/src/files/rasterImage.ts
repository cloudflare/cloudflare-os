// The only image types the browser is given as images. An SVG is a document that can run script:
// from a `blob:` URL, which is of the app's own origin, opened in a tab of its own, it would run
// as the app. These never run anything, however they are opened.
const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

/** Whether `mimeType` is an image that is only pixels, and so safe to give the browser as one. */
export const isRasterImage = (mimeType: string) => RASTER_IMAGE_TYPES.has(mimeType.split(';')[0].trim().toLowerCase())
