import { useState } from 'react'
import type { AdminFormat, AdminSettingsView, BlueprintOutput, BlueprintPublicInfo, BlueprintUserSummary } from '@gadgets/workshop-shared/api'
import { ApiContext, type ApiSession } from '@/rpc/ApiContext'
import { AdminCapabilityProvider } from '@/settings/admin/AdminContext'
import { AdminFormatSettings } from '@/settings/admin/AdminFormatSettings'
import { never, PREVIEW_ADMIN_SETTINGS, previewAdmin, previewDelay } from './adminPreview'
import { Section } from './Section'

const DOC: BlueprintOutput = { id: 'document', noun: 'Doc', plural: 'Docs', icon: 'fileText' }
const SLIDES: BlueprintOutput = { id: 'presentation', noun: 'Slides', plural: 'Slides', icon: 'presentation' }
const SHEET: BlueprintOutput = { id: 'spreadsheet', noun: 'Sheet', plural: 'Sheets', icon: 'table' }

const FORMATS: AdminFormat[] = [
  { blueprintId: 'doc', blueprintTitle: 'Docs', blueprintDescription: 'A rich text document, edited together.', output: DOC, declared: DOC, enabled: true, agentHint: '', missing: false, bundled: true },
  { blueprintId: 'deck', blueprintTitle: 'Pitch deck', blueprintDescription: 'Slides for presenting.', output: { ...SLIDES, noun: 'Deck', plural: 'Decks' }, declared: SLIDES, overrides: { noun: 'Deck', plural: 'Decks' }, enabled: true, agentHint: 'prefer for customer-facing decks', missing: false, bundled: false },
  { blueprintId: 'sheet', blueprintTitle: 'Sheets', blueprintDescription: 'A spreadsheet.', output: SHEET, declared: SHEET, enabled: false, agentHint: '', missing: false, bundled: true },
  { blueprintId: 'tracker', blueprintTitle: 'Habit tracker, with a title long enough that it has to be cut off somewhere along the line', blueprintDescription: 'Tracks habits.', enabled: true, agentHint: '', missing: false, bundled: false },
  { blueprintId: 'gone', blueprintTitle: 'Old report', blueprintDescription: '', enabled: true, agentHint: '', missing: true, bundled: false },
]

const FEATURED = [
  { id: 'kanban', metadata: { title: 'Kanban board', output: { id: 'board', noun: 'Board', plural: 'Boards', icon: 'kanban' } } },
  { id: 'doc', metadata: { title: 'Docs', output: DOC } },
] as BlueprintPublicInfo[]
const OWN = [{ id: 'invoice', title: 'Invoice maker' }] as BlueprintUserSummary[]

// Only what the part asks the signed-in API for: the blueprints it could promote.
const session: ApiSession = {
  api: { listFeaturedBlueprints: async () => FEATURED, listOwnBlueprints: async () => OWN } as unknown as ApiSession['api'],
  user: { type: 'user', id: 'ada', name: 'Ada Lovelace' },
  userChanged: () => {},
  reconnecting: false,
}

/** A fake deployment whose formats change as the part changes them, as the server's would. */
const useFakeFormats = (initial: AdminFormat[]) => {
  const [admin] = useState(() => {
    let view: AdminSettingsView = { ...PREVIEW_ADMIN_SETTINGS, formats: initial }
    const set = (formats: AdminFormat[]) => {
      view = { ...view, formats }
    }
    return previewAdmin({
      getSettings: async () => {
        await previewDelay()
        return view
      },
      setFormatOrder: async (ids) => {
        await previewDelay()
        set(ids.map((id) => view.formats.find(({ blueprintId }) => blueprintId === id)!))
      },
      updateFormat: async (id, patch) => {
        await previewDelay()
        if (patch.agentHint === 'refuse') throw new Error('The preview refuses that hint.')
        set(view.formats.map((format) => {
          if (format.blueprintId !== id) return format
          const overrides = { ...format.overrides }
          for (const [key, value] of Object.entries(patch.overrides ?? {})) {
            if (value === null) delete overrides[key as keyof BlueprintOutput]
            else Object.assign(overrides, { [key]: value })
          }
          const merged = { ...format.declared, ...overrides }
          const output = merged.noun && merged.plural && merged.icon ? { id: merged.id ?? id, noun: merged.noun, plural: merged.plural, icon: merged.icon } : undefined
          return { ...format, enabled: patch.enabled ?? format.enabled, agentHint: patch.agentHint ?? format.agentHint, overrides, output }
        }))
      },
      removeFormat: async (id) => {
        await previewDelay()
        set(view.formats.filter(({ blueprintId }) => blueprintId !== id))
      },
      promoteFormat: async (id) => {
        await previewDelay()
        const featured = FEATURED.find((blueprint) => blueprint.id === id)
        const title = featured?.metadata.title ?? OWN.find((blueprint) => blueprint.id === id)?.title ?? id
        const output = featured?.metadata.output
        set([...view.formats, { blueprintId: id, blueprintTitle: title, blueprintDescription: '', output, declared: output, enabled: true, agentHint: '', missing: false, bundled: false }])
      },
    })
  })
  return admin
}

const Part = ({ formats }: { formats: AdminFormat[] }) => {
  const admin = useFakeFormats(formats)
  return (
    <AdminCapabilityProvider admin={admin}>
      <AdminFormatSettings />
    </AdminCapabilityProvider>
  )
}

/** The admin Formats part over a fake deployment, in each of its states. */
export const AdminFormatsPreview = () => (
  <ApiContext value={session}>
    <Section title="AdminFormatSettings: the deployment's standard formats, as the buttons people get, then each on a surface of its own that opens to how it is presented and how the agent picks it (a hint of “refuse” is refused): a bundled one, one renamed, one switched off, one that still needs a name, and one whose blueprint was deleted; reordered with the arrows; Promote offers what could be">
      <div className="flex w-full max-w-3xl flex-col gap-12">
        <Part formats={FORMATS} />
      </div>
    </Section>
    <Section title="AdminFormatSettings with none yet">
      <div className="flex w-full max-w-3xl flex-col gap-12">
        <Part formats={[]} />
      </div>
    </Section>
    <Section title="AdminFormatSettings while the settings load, and when they could not be read">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <AdminCapabilityProvider admin={previewAdmin({ getSettings: never })}>
          <AdminFormatSettings />
        </AdminCapabilityProvider>
        <AdminCapabilityProvider admin={previewAdmin({ getSettings: async () => { throw new Error('The deployment didn’t answer.') } })}>
          <AdminFormatSettings />
        </AdminCapabilityProvider>
      </div>
    </Section>
  </ApiContext>
)
