import { useState } from 'react'

/** Open/closed state for any number of rows, by key, the way a chat keeps it outside its rows. */
export const useOpen = (initial: string[] = []) => {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set(initial))
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })
  return { open, toggle, of: (key: string) => ({ open: open.has(key), onToggle: () => toggle(key) }) }
}

const later = () => new Promise<void>((resolve) => setTimeout(resolve, 900))

/** What a preview's controls report, after a moment, the way a call to the backend would answer. */
export const useReport = () => {
  const [report, setReport] = useState('Use a control to see what it reports.')
  return {
    report,
    later,
    say: (what: string) => setReport(`Preview: ${what}.`),
    after: (what: string) => async () => {
      await later()
      setReport(`Preview: ${what}.`)
    },
  }
}
