/** Publishes an element's height as a CSS variable on `target`, and keeps it current. */
export const publishHeight = (element: HTMLElement | null, target: HTMLElement, name: string, scale = 1) => {
  if (!element) {
    target.style.setProperty(name, '0px')
    return () => {}
  }
  const update = () => target.style.setProperty(name, `${element.getBoundingClientRect().height * scale}px`)
  update()
  const observer = new ResizeObserver(update)
  observer.observe(element, { box: 'border-box' })
  return () => observer.disconnect()
}
