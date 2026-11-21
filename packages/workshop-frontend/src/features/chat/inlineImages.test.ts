import { expect, it } from 'vitest'
import { isSvgImage } from './inlineImages'

it('recognizes SVG headers with repeated comments and rejects incomplete or non-SVG input', () => {
  expect(isSvgImage(' \ufeff<?xml version="1.0"?>\n' + '<!-- comment -->'.repeat(100) + '<svg>')).toBe(true)
  expect(isSvgImage('<!--'.repeat(100) + '-->'.repeat(100))).toBe(false)
  expect(isSvgImage('<!-- incomplete <svg>')).toBe(false)
  expect(isSvgImage('<?xml incomplete <svg>')).toBe(false)
  expect(isSvgImage('<svg-script>')).toBe(false)
  expect(isSvgImage('\u0089PNG\r\n')).toBe(false)
})
it('recognizes SVG doctypes without stopping inside quoted identifiers or internal subsets', () => {
  expect(isSvgImage('<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ' +
    '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg>')).toBe(true)
  expect(isSvgImage('<!DOCTYPE svg SYSTEM "path>name"><svg>')).toBe(true)
  expect(isSvgImage('<!-- before --><!DOCTYPE svg [<!ENTITY label "a>b">]><!-- after --><svg>')).toBe(true)
  expect(isSvgImage('<!DOCTYPE svg [<!-- ]> --><!ENTITY label "a>b">]><svg>')).toBe(true)
  expect(isSvgImage('<!DOCTYPE svg SYSTEM "incomplete <svg>')).toBe(false)
  expect(isSvgImage('<!DOCTYPE svg [<!ENTITY label "<svg>">')).toBe(false)
  expect(isSvgImage('<!DOCTYPE html><html>')).toBe(false)
})
