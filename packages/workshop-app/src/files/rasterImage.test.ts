import { describe, expect, it } from 'vitest'
import { isRasterImage } from './rasterImage'

describe('isRasterImage', () => {
  it('is only the image types that are pixels, whatever their case or parameters', () => {
    expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'IMAGE/PNG', 'image/png; q=1'].map(isRasterImage)).toEqual(Array(7).fill(true))
    expect(['image/svg+xml', 'image/svg', 'text/html', 'image/bmp', '', 'image/png+xml'].map(isRasterImage)).toEqual(Array(6).fill(false))
  })
})
