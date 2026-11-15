import { useState, type ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { ConnectedFileView } from '@/blocks/ConnectedFileView'
import { GadgetAsk, type GadgetAskGroup } from '@/blocks/GadgetAsk'
import { FanCard } from '@/blocks/FanCard'
import { GadgetCard } from '@/blocks/GadgetCard'
import { KindMark } from '@/components/KindMark'
import { GadgetPermissions, type GadgetAllowanceItem } from '@/blocks/GadgetPermissions'
import { GadgetReview } from '@/blocks/GadgetReview'
import { documentFixture } from '@/blocks/resource-preview/fixtures'
import { PREVIEW_BUDGET, PREVIEW_ROADMAP, PREVIEW_STANDUP, PREVIEW_TIP_JAR } from './previewPictures'
import { Section } from './Section'

const GOOGLE = { name: 'Google', logoUrl: '/favicon.svg', color: '#ffffff' }
const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 600))

const ROWS: GadgetAskGroup = {
  key: 'rows',
  title: 'Add rows to a spreadsheet',
  detail: 'Q3 Budget · 2 changes',
  service: GOOGLE,
  allowable: true,
  requests: [
    { actionId: 1, title: 'Add a row to Q3 Budget', description: 'Adds **Team offsite, $4,200** under Travel.', fields: [{ label: 'Row', kind: 'inline', value: 'Team offsite | Travel | 4200' }] },
    { actionId: 2, title: 'Add a row to Q3 Budget', description: 'Adds **Laptops, $9,800** under Equipment.', fields: [{ label: 'Row', kind: 'inline', value: 'Laptops | Equipment | 9800' }] },
  ],
}

const EMAIL: GadgetAskGroup = {
  key: 'email',
  title: 'Send email',
  detail: 'finance@example.com',
  service: GOOGLE,
  allowable: false,
  requests: [{ actionId: 3, title: 'Send “Q3 budget is ready”', description: 'Sends the budget summary to finance@example.com.', fields: [{ label: 'To', kind: 'inline', value: 'finance@example.com' }] }],
}

const AWAY: GadgetAskGroup = {
  ...ROWS,
  key: 'away',
  detail: 'Q3 Budget · 3 changes · since 3 hours ago',
}

// A gadget's page, as the ask sits over its foot.
const Page = ({ picture, children }: { picture: string; children: ReactNode }) => (
  <div className="relative h-[420px] w-full max-w-3xl overflow-hidden rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
    <img src={picture} alt="" className="size-full object-cover object-top" />
    <div className="absolute inset-x-0 bottom-0 flex justify-center p-3">
      <div className="w-full max-w-xl">{children}</div>
    </div>
  </div>
)

const AskPreview = ({ initial, madeBy, picture, title }: { initial: GadgetAskGroup[]; madeBy?: string; picture: string; title: string }) => {
  const [groups, setGroups] = useState(initial)
  const [notice, setNotice] = useState<string>()
  const drop = (key: string) => setGroups((current) => current.filter((group) => group.key !== key))
  return (
    <div className="flex w-full flex-col gap-2">
      <Page picture={picture}>
        <GadgetAsk
          gadgetTitle={title}
          madeBy={madeBy}
          groups={groups}
          notice={notice ? { text: notice, action: { label: 'Settings', onClick: () => {} } } : undefined}
          onAllow={async (key) => {
            await wait()
            const group = groups.find((each) => each.key === key)
            drop(key)
            if (group) setNotice(`${title} can ${group.title.charAt(0).toLowerCase()}${group.title.slice(1)} without asking now.`)
          }}
          onAllowOnce={async (key) => {
            await wait()
            drop(key)
          }}
          onDeny={async (key) => {
            await wait()
            drop(key)
          }}
        />
      </Page>
      <button type="button" className="self-start py-1 text-sm text-kumo-subtle hover:underline" onClick={() => { setGroups(initial); setNotice(undefined) }}>Ask again</button>
    </div>
  )
}

const ALLOWED: GadgetAllowanceItem[] = [
  { key: 'rows', title: 'Add rows to a spreadsheet', detail: 'Q3 Budget · Allowed by Ada Lovelace', service: GOOGLE },
  { key: 'labels', title: 'Label email', detail: 'ada@example.com · Allowed by Ada Lovelace', service: GOOGLE },
]

const EDITS = [
  { actionId: 101, title: 'Edit Aurora Launch Plan', description: 'Moves the public launch to **November 18**.', fields: [] },
  { actionId: 102, title: 'Edit Aurora Launch Plan', description: 'Marks Marketing as **Approved**.', fields: [] },
  { actionId: 103, title: 'Append to Aurora Launch Plan', description: 'Adds localization for German and Japanese.', fields: [] },
]

// A Doc's changes, reviewed on the Doc over the gadget: decided one by one, all at once, or allowed for good.
const ReviewOverPreview = () => {
  const [reviewing, setReviewing] = useState(false)
  const [decided, setDecided] = useState<ReadonlyMap<number, 'approved' | 'rejected'>>(new Map())
  const [allowed, setAllowed] = useState(false)
  const waiting = allowed ? [] : EDITS.filter(({ actionId }) => !decided.has(actionId))
  const group: GadgetAskGroup = {
    key: 'doc',
    title: 'Document edits',
    detail: `Aurora Launch Plan · ${waiting.length} changes`,
    service: GOOGLE,
    allowable: true,
    requests: waiting,
    onReview: () => setReviewing(true),
  }
  const reset = () => {
    setDecided(new Map())
    setAllowed(false)
    setReviewing(false)
  }
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="relative h-[520px] w-full max-w-3xl overflow-hidden rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
        <img src={PREVIEW_STANDUP} alt="" className="size-full object-cover object-top" />
        <div className="absolute inset-x-0 bottom-0 flex justify-center p-3">
          <div className="w-full max-w-xl">
            <GadgetAsk
              gadgetTitle="Launch Tracker"
              madeBy="Grace Hopper"
              groups={reviewing || waiting.length === 0 ? [] : [group]}
              onAllow={async () => {
                await wait()
                setAllowed(true)
              }}
              onAllowOnce={async () => {
                await wait()
                setDecided(new Map(EDITS.map(({ actionId }) => [actionId, 'approved'])))
              }}
              onDeny={async () => {
                await wait()
                setDecided(new Map(EDITS.map(({ actionId }) => [actionId, 'rejected'])))
              }}
            />
          </div>
        </div>
        <AnimatePresence>
          {reviewing && (
            <GadgetReview
              gadgetTitle="Launch Tracker"
              title="Aurora Launch Plan"
              detail={`${waiting.length} changes · since 3 hours ago`}
              service={GOOGLE}
              openIn={{ label: 'Open in Docs', href: documentFixture.url ?? '' }}
              onAlwaysAllow={async () => {
                await wait()
                setAllowed(true)
                setReviewing(false)
              }}
              onClose={() => setReviewing(false)}
            >
              <ConnectedFileView
                preview={documentFixture}
                kind="document"
                review={{
                  changes: waiting,
                  decided,
                  onDecide: async (ids, decision) => {
                    await wait()
                    setDecided((current) => new Map([...current, ...ids.map((id) => [id, decision === 'approve' ? 'approved' : 'rejected'] as const)]))
                    if (waiting.every(({ actionId }) => ids.includes(actionId))) setTimeout(() => setReviewing(false), 700)
                  },
                }}
              />
            </GadgetReview>
          )}
        </AnimatePresence>
      </div>
      <button type="button" className="self-start py-1 text-sm text-kumo-subtle hover:underline" onClick={reset}>Ask again</button>
    </div>
  )
}

const PermissionsPreview = ({ madeBy, initial }: { madeBy?: string; initial: GadgetAllowanceItem[] }) => {
  const [everything, setEverything] = useState(false)
  const [allowances, setAllowances] = useState(initial)
  return (
    <div className="w-full max-w-3xl">
      <GadgetPermissions
        madeBy={madeBy}
        everything={everything}
        allowances={allowances}
        onEverythingChange={async (on) => {
          await wait()
          setEverything(on)
        }}
        onAskAgain={async (key) => {
          await wait()
          setAllowances((current) => current.filter((each) => each.key !== key))
        }}
      />
    </div>
  )
}

/** What a gadget asks before it changes something, what it is allowed, and Home's gadgets. */
export const GadgetTrustPreview = () => (
  <>
    <Section title="GadgetAsk (someone else’s gadget, over its own page: it says whose it is, a row per kind of change with Always allow, Only this time and Don’t allow, and Send email, which its service never lets through unasked, with Allow only once; Always allow leaves a moment’s note with the way to take it back; a Doc’s rows have Review, which opens the Doc drawn with its changes over the gadget)">
      <AskPreview title="Budget Tracker" madeBy="Cloudflare" picture={PREVIEW_BUDGET} initial={[ROWS, EMAIL]} />
    </Section>
    <Section title="GadgetAsk with Review, GadgetReview (changes to a Google Doc: Review opens the Doc over the gadget, drawn with them, to step through and decide each or all, Always allow from its head, Escape or Back to the gadget; it goes back once nothing waits)">
      <ReviewOverPreview />
    </Section>
    <Section title="GadgetAsk (the user’s own gadget, with changes it made on a schedule while they were away)">
      <AskPreview title="Tip Jar" picture={PREVIEW_TIP_JAR} initial={[AWAY]} />
    </Section>
    <Section title="GadgetPermissions (on a gadget’s Connections: someone else’s, with two kinds allowed, each of which can ask again, and Don’t ask for everything its services allow; then the user’s own, with nothing allowed yet)">
      <PermissionsPreview madeBy="Cloudflare" initial={ALLOWED} />
      <PermissionsPreview initial={[]} />
    </Section>
    <Section title="GadgetCard, FanCard (Home’s Jump back in: what waits on the viewer first, saying how many, then starred, then recent; under each name its workspace, or who shared it; last, All gadgets, a fan of the rest)">
      <section aria-labelledby="gallery-jump-back-in" className="flex w-full max-w-2xl flex-col gap-3">
        <h2 id="gallery-jump-back-in" className="px-1 text-sm text-kumo-subtle">Jump back in</h2>
        <div className="grid grid-cols-3 gap-3">
          <GadgetCard title="Budget Tracker" icon={<KindMark name="spreadsheet" />} picture={PREVIEW_BUDGET} waiting={3} onOpen={() => {}} />
          <GadgetCard title="Standup Notes" icon={<KindMark name="checklist" />} picture={PREVIEW_STANDUP} detail="Platform team" index={1} onOpen={() => {}} />
          <GadgetCard title="Tip Jar" icon={<KindMark name="chart" />} picture={PREVIEW_TIP_JAR} detail="From Grace Hopper" index={2} onOpen={() => {}} />
          <GadgetCard title="Q3 Roadmap" icon={<KindMark name="board" />} picture={PREVIEW_ROADMAP} detail="Product" index={3} onOpen={() => {}} />
          <GadgetCard title="Hiring Pipeline" icon={<KindMark name="people" />} detail="Recruiting" index={4} onOpen={() => {}} />
          <FanCard
            title="All gadgets"
            icon={<KindMark name="collection" />}
            detail="14 in your Library"
            sheets={[PREVIEW_ROADMAP, PREVIEW_STANDUP, PREVIEW_BUDGET].map((picture) => <img key={picture} src={picture} alt="" className="size-full object-cover object-top" />)}
            onOpen={() => {}}
            index={5}
          />
        </div>
      </section>
    </Section>
  </>
)
