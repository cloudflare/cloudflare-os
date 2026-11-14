import { describe, expect, it } from 'vitest'
import { dashArray, elementBox, fitSlide, fontPixels, slideFontStack, slideScale } from './slideLayout'
import { geometryPath, knowsGeometry } from './slideGeometry'
import { fontStack, safeCssColor, safeImageDataUrl } from './safeStyle'

describe('slide scaling', () => {
  it('scales points to the rendered width', () => {
    expect(slideScale(960, 720)).toBeCloseTo(4 / 3)
    expect(slideScale(960, 0)).toBe(0)
    expect(fontPixels(18, 0.5)).toBe(9)
    expect(fontPixels(undefined, 1)).toBe(14)
  })

  it('fits a slide in a box by whichever side binds', () => {
    expect(fitSlide({ width: 1000, height: 1000 }, { width: 720, height: 405 })).toEqual({ width: 1000, height: 562.5 })
    const tall = fitSlide({ width: 1000, height: 300 }, { width: 720, height: 405 })
    expect(tall.width).toBeCloseTo(533.33)
    expect(tall.height).toBeCloseTo(300)
    expect(fitSlide({ width: 500, height: 500 }, { width: 400, height: 400 })).toEqual({ width: 500, height: 500 })
  })

  it('places and rotates an element in pixels', () => {
    expect(elementBox({ id: 'e', kind: 'shape', x: 72, y: 36, width: 144, height: 18, rotation: -4 }, 0.5)).toMatchObject({
      left: 36, top: 18, width: 72, height: 9, transform: 'rotate(-4deg)',
    })
    expect(elementBox({ id: 'e', kind: 'shape', x: Number.NaN, y: 0, width: -5, height: 10 }, 1)).toMatchObject({ left: 0, width: 0 })
  })
})

describe('slide drawing', () => {
  it('draws a known shape by its own outline and any other as its box', () => {
    expect(geometryPath('ROUND_RECTANGLE', 120, 60)).toBe('M10,0 H110 A10,10 0 0 1 120,10 V50 A10,10 0 0 1 110,60 H10 A10,10 0 0 1 0,50 V10 A10,10 0 0 1 10,0 Z')
    expect(geometryPath('TRIANGLE', 100, 50)).toBe('M50,0 L100,50 L0,50 Z')
    expect(knowsGeometry('FLOWCHART_PUNCHED_TAPE')).toBe(false)
    expect(geometryPath('FLOWCHART_PUNCHED_TAPE', 10, 5)).toBe('M0,0 L10,0 L10,5 L0,5 Z')
  })

  it('dashes by the stroke’s weight', () => {
    expect(dashArray('dashDot', 2)).toBe('8 6 2 6')
    expect(dashArray(undefined, 2)).toBeUndefined()
  })

  it('falls back to a system font of the same kind', () => {
    expect(slideFontStack('Merriweather')).toMatch(/^"Merriweather", Georgia/)
    expect(slideFontStack('Source Sans Pro')).toMatch(/^"Source Sans Pro", Arial/)
    expect(slideFontStack('Roboto Mono')).toMatch(/"Courier New"/)
  })
})

describe('values from the file', () => {
  it('accepts only inline image data URLs', () => {
    expect(safeImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBeDefined()
    expect(safeImageDataUrl('data:image/svg+xml;utf8,%3Csvg%3E')).toBeDefined()
    expect(safeImageDataUrl('https://lh3.googleusercontent.com/x.png')).toBeUndefined()
    expect(safeImageDataUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeUndefined()
    expect(safeImageDataUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeImageDataUrl('DATA:image/x-icon,abc')).toBeUndefined()
  })

  it('accepts colors and nothing that could load a resource', () => {
    expect(['#fff', '#1a73e8', '#1a73e880', 'rgb(26, 115, 232)', 'rgba(0,0,0,.5)', 'hsl(210 50% 40%)'].map(safeCssColor))
      .toEqual(['#fff', '#1a73e8', '#1a73e880', 'rgb(26, 115, 232)', 'rgba(0,0,0,.5)', 'hsl(210 50% 40%)'])
    expect(['url(https://x.test/a.png)', 'red; background: url(x)', 'var(--x)', 'expression(1)', '#ggg', ''].map(safeCssColor))
      .toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
  })

  it('quotes a plain font name ahead of the fallback and drops anything else', () => {
    expect(fontStack('Google Sans', 'Arial, sans-serif')).toBe('"Google Sans", Arial, sans-serif')
    expect(fontStack('x"; color: red', 'Arial')).toBe('Arial')
  })
})
