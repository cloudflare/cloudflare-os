import { useState } from 'react'
import { DeleteGadgetDialog } from '@/blocks/DeleteGadgetDialog'
import { LibraryCard } from '@/blocks/LibraryCard'
import { LibraryRow } from '@/blocks/LibraryRow'
import { Button } from '@gadgets/ui'
import { useReport } from './previewState'
import { Section } from './Section'

type Item = { key: string; title: string; detail: string; icon?: 'fileText' | 'table'; time: string; uses?: boolean }

const ITEMS: Item[] = [
  { key: 'review', title: 'Q3 platform review', detail: 'Document · Engineering notes', icon: 'fileText', time: '4 hours ago' },
  { key: 'budget', title: 'Budget 2026', detail: 'Spreadsheet · Budget 2026', icon: 'table', time: 'Yesterday' },
  { key: 'paris', title: 'A walk through Paris, shared with the viewer to use', detail: 'App · Paris slides · Shared by Grace Hopper', time: 'Oct 27', uses: true },
]

/** Asks whether to delete something made, which either goes, or fails and says why. */
const DeleteDemo = ({ failing, report }: { failing?: boolean; report: ReturnType<typeof useReport> }) => {
  const { say, later } = report
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>{failing ? 'Deleting fails' : 'Delete a document'}</Button>
      <DeleteGadgetDialog
        open={open}
        onOpenChange={setOpen}
        title="Q3 platform review"
        workspace="Engineering notes"
        onConfirm={async () => {
          await later()
          if (failing) throw new Error('The workspace couldn’t be reached.')
          say('deleted Q3 platform review')
          setOpen(false)
        }}
      />
    </>
  )
}

/**
 * What else can be done with an output on the Library page, from its row and its card: renamed
 * where its title is, shared, its settings, and deleted, which asks first and takes it from the
 * list; whoever only uses it can open it and copy its link, and nothing more.
 */
export const LibraryMenuPreview = () => {
  const reporting = useReport()
  const { report, say } = reporting
  const [items, setItems] = useState(ITEMS)
  const [deleting, setDeleting] = useState<{ item: Item; open: boolean }>()
  const more = (item: Item) => item.uses ? undefined : {
    onRename: (title: string) => {
      setItems((current) => current.map((each) => (each.key === item.key ? { ...each, title } : each)))
      say(`renamed ${item.title} to ${title}`)
    },
    onInvite: () => say(`invite people to ${item.title}`),
    onOpenSettings: () => say(`open the settings of ${item.title}`),
    onDelete: () => setDeleting({ item, open: true }),
  }
  const shared = (item: Item) => ({
    title: item.title,
    icon: item.icon,
    starred: false,
    onStarredChange: () => {},
    href: `#${item.key}`,
    onSelect: () => say(`open ${item.title}`),
    more: more(item),
  })

  return (
    <>
      <Section title="LibraryRow, LibraryCard with more (pointed at, more slides out before the star: Open, Open in new tab and Copy link, then for whoever builds in its workspace Rename, typed where the title is and kept with Enter or by leaving it, Invite user…, App settings, Create template…, and Delete…, which asks first and takes it from the list once it is gone. Whoever it was shared with to use has only the first three)">
        <div className="flex w-[28rem] max-w-full flex-col rounded-3xl bg-kumo-tint p-1.5">
          {items.map((item) => <LibraryRow key={item.key} {...shared(item)} detail={item.detail} time={item.time} />)}
        </div>
        <div className="grid w-[40rem] max-w-full grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
          {items.map((item) => (
            <LibraryCard
              key={item.key}
              {...shared(item)}
              kind={item.detail.split(' · ')[0]}
              workspace={{ title: item.detail.split(' · ')[1], label: 'EN', onSelect: () => say('open the workspace') }}
              owner={item.uses ? { name: 'Grace Hopper' } : { name: 'Ada Lovelace', you: true }}
              time={item.time}
            />
          ))}
        </div>
        <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
        {deleting && (
          <DeleteGadgetDialog
            key={deleting.item.key}
            open={deleting.open}
            onOpenChange={(open) => setDeleting((current) => current && { ...current, open })}
            title={deleting.item.title}
            workspace={deleting.item.detail.split(' · ')[1]}
            onConfirm={async () => {
              await reporting.later()
              setItems((current) => current.filter(({ key }) => key !== deleting.item.key))
              setDeleting({ ...deleting, open: false })
              say(`deleted ${deleting.item.title}`)
            }}
          />
        )}
      </Section>
      <Section title="DeleteGadgetDialog (what deleting takes with it and what stays, asked before it is done; a failure stays in it, under why)">
        <DeleteDemo report={reporting} />
        <DeleteDemo report={reporting} failing />
      </Section>
    </>
  )
}
