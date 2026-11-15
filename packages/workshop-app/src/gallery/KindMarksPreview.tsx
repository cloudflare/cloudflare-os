import { FileTextIcon } from '@phosphor-icons/react'
import { ChatMark } from '@/components/ChatMark'
import { KIND_MARKS, KindMark } from '@/components/KindMark'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { Section } from './Section'

/** The marks things are drawn with by kind, at each size they are drawn at, beside the workspace's folder and the chat's cloud. */
export const KindMarksPreview = () => (
  <>
    <Section title="KindMark (each kind of thing, at the sizes a row, a card’s head, a tile and a page draw it)">
      <div data-marks="" className="grid w-full grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3">
        {KIND_MARKS.map((name) => (
          <div key={name} className="flex flex-col items-center gap-3 rounded-2xl bg-kumo-contrast/5 p-4 text-kumo-default">
            <KindMark name={name} className="size-14" />
            <span className="flex items-end gap-3">
              <KindMark name={name} className="size-8" />
              <KindMark name={name} className="size-5" />
              <KindMark name={name} className="size-3.5" />
            </span>
            <span className="text-xs text-kumo-subtle">{name}</span>
          </div>
        ))}
      </div>
    </Section>
    <Section title="KindMark beside the workspace’s folder, the chat’s cloud, and an outlined icon">
      <div data-marks-family="" className="flex items-center gap-4 rounded-2xl bg-kumo-contrast/5 p-4">
        <WorkspaceIcon label="HW" />
        <ChatMark />
        {(['gadget', 'document', 'spreadsheet', 'presentation', 'collection', 'pdf'] as const).map((name) => <KindMark key={name} name={name} className="size-8" />)}
        <FileTextIcon className="size-8 text-kumo-subtle" />
      </div>
    </Section>
  </>
)
