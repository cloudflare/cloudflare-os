/** Something open beside the page. */
export type AsideItem = {
  /** Tells it from anything else that can be opened. */
  key: string
  title: string
}

/** Everything open beside the page, in the order it was opened, and which of it is shown. Never empty. */
export type AsideTabs = {
  items: AsideItem[]
  activeKey: string
}

/** Opens `item` and shows it. One that is open already is only shown, where it is. */
export const openTab = (tabs: AsideTabs | undefined, item: AsideItem): AsideTabs => {
  const items = tabs?.items ?? []
  return {
    items: items.some(({ key }) => key === item.key) ? items.map((open) => (open.key === item.key ? item : open)) : [...items, item],
    activeKey: item.key,
  }
}

/** Shows the open item with `key`. */
export const selectTab = (tabs: AsideTabs | undefined, key: string): AsideTabs | undefined =>
  tabs?.items.some((item) => item.key === key) ? { ...tabs, activeKey: key } : tabs

/**
 * Closes the open item with `key`. When it was the one shown, the one after it is shown instead,
 * or the one before it when it was last. Closing the only one leaves nothing open.
 */
export const closeTab = (tabs: AsideTabs | undefined, key: string): AsideTabs | undefined => {
  const index = tabs?.items.findIndex((item) => item.key === key) ?? -1
  if (!tabs || index < 0) return tabs
  const items = tabs.items.toSpliced(index, 1)
  if (items.length === 0) return undefined
  return { items, activeKey: tabs.activeKey === key ? items[Math.min(index, items.length - 1)].key : tabs.activeKey }
}
