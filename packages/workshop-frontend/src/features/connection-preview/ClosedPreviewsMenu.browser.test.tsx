/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { ConnectionPreview } from './connectionPreview'
import { ClosedPreviewsMenu } from './ClosedPreviewsMenu'
import '../../styles.css'

const ICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'

let host: HTMLDivElement | undefined, root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

const render = async (count: number) => {
  const opened: string[] = []
  // The first has the icon its connection's vendor gives it, and the rest none.
  const previews = Array.from({ length: count }, (_, i): ConnectionPreview =>
    ({ gatekeeperId: 7, item: `file-${i + 1}`, title: `File ${i + 1}`, iconUrl: i ? undefined : ICON }))
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root!.render(
    <ClosedPreviewsMenu previews={previews} onOpen={preview => opened.push(preview.title)} />,
  ))
  return opened
}
const item = (name: string) => page.getByRole('menuitem', { name, exact: true })

it('has one button, whose menu opens each closed preview under its own icon', async () => {
  const opened = await render(2)
  expect([...host!.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Previews'])

  await act(async () => userEvent.click(page.getByRole('button', { name: 'Previews' })))
  await expect.element(item('File 1')).toBeVisible()
  expect(item('File 1').element().querySelector('img')?.getAttribute('src')).toBe(ICON)
  // A connection whose vendor gives no icon has the usual one.
  expect(item('File 2').element().querySelector('img')).toBeNull()
  expect(item('File 2').element().querySelector('svg')).not.toBeNull()

  await act(async () => userEvent.click(item('File 2')))
  expect(opened).toEqual(['File 2'])
})

it('has no button when no preview is closed', async () => {
  await render(0)
  expect(host!.querySelector('button')).toBeNull()
})

it('keeps a menu of many previews to a height it scrolls in', async () => {
  const opened = await render(40)

  await act(async () => userEvent.click(page.getByRole('button', { name: 'Previews' })))
  await expect.element(item('File 1')).toBeVisible()
  const menu = document.querySelector('[role="menu"]')!
  expect(menu.clientHeight).toBeLessThanOrEqual(320)
  expect(menu.scrollHeight).toBeGreaterThan(menu.clientHeight)
  await act(async () => userEvent.click(item('File 40')))
  expect(opened).toEqual(['File 40'])
})
