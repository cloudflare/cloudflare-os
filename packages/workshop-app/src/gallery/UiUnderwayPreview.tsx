import { UiUnderway } from '@/blocks/UiUnderway'
import { Section } from './Section'

/** Where a gadget's UI will be, before it has one, in a pane's room. */
export const UiUnderwayPreview = () => (
  <Section title="UiUnderway (a gadget with no UI yet, beside its chat)">
    <div data-testid="ui-underway" className="flex h-96 w-full max-w-md rounded-2xl bg-kumo-recessed ring-1 ring-kumo-line">
      <UiUnderway title="Its UI shows here" description="As soon as the gadget builds one." />
    </div>
  </Section>
)
