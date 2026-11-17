import type { ReactNode } from 'react'
import { AssistantMessage } from '@/blocks/AssistantMessage'
import { messageInfo } from '@/blocks/messageInfo'
import type { ToolStepEntry } from '@/blocks/ToolStep'
import { UserMessage } from '@/blocks/UserMessage'
import { BUDGET_XLSX, Q3_PLAN_DOCX, ROADMAP_PPTX } from '@/chat/mock/officeFiles'
import { useOpen, useReport } from './previewState'
import { Section } from './Section'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

const picture = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#888"/><circle cx="4" cy="4" r="2.5" fill="#fff"/></svg>',
)

const SENT = new Date(2026, 10, 2, 9, 41)

const TRACE: ToolStepEntry[] = [
  { type: 'call', key: 'info-read', icon: 'file', label: 'Read src/chart.tsx', reasoning: 'The window is probably a constant.', sections: [] },
  { type: 'call', key: 'info-edit', icon: 'edit', label: 'Edited src/chart.tsx', sections: [{ label: 'Replaced', text: 'const WEEKS = 4' }, { label: 'With', text: 'const WEEKS = 12' }] },
  { type: 'thinking', key: 'info-thought', text: 'The worker already returns twelve weeks, so nothing else has to change.' },
]

// Live views, written as the agent is told to write them: its colours, no box of its own needed.
const CHART_ANSWER = `Tickets peaked in week 3, when the export bug landed, and have fallen every week since.

<inline-html>
<title>Tickets by week</title>
<style>
  .chart { display: flex; align-items: flex-end; gap: 10px; height: 148px; padding-top: 8px; }
  .bar { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; justify-content: flex-end; border: 0; background: none; padding: 0; cursor: pointer; color: inherit; }
  .fill { width: 100%; border-radius: 8px 8px 3px 3px; background: color-mix(in oklab, var(--text-color-kumo-default) 14%, transparent); transition: background 150ms; }
  .bar:hover .fill, .bar:focus-visible .fill { background: var(--color-kumo-brand); }
  .bar.peak .fill { background: color-mix(in oklab, var(--color-kumo-brand) 70%, transparent); }
  .n { font-size: 13px; font-variant-numeric: tabular-nums; }
  .w { font-size: 12px; color: var(--text-color-kumo-subtle); }
  h3 { margin: 0 0 2px; font-size: 15px; font-weight: 600; }
  p { margin: 0; color: var(--text-color-kumo-subtle); font-size: 13px; }
</style>
<h3>Support tickets by week</h3>
<p>Click a week to see its tickets.</p>
<div class="chart" id="chart"></div>
<script type="module">
  const weeks = [41, 58, 97, 72, 55, 43];
  const top = Math.max(...weeks);
  const chart = document.getElementById("chart");
  weeks.forEach((count, index) => {
    const bar = chart.appendChild(document.createElement("button"));
    bar.className = count === top ? "bar peak" : "bar";
    bar.innerHTML = \`<span class="n">\${count}</span><span class="fill" style="height:\${(count / top) * 100}%"></span><span class="w">W\${index + 1}</span>\`;
    bar.onclick = () => agent.send(\`Show me the tickets from week \${index + 1}.\`);
  });
</script>
</inline-html>

Want me to break week 3 down by product?`

const PLANS_ANSWER = `Here are the three ways to run it.

<inline-html>
<title>Hosting plans</title>
<style>
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .plan { border: 1px solid var(--color-kumo-line); border-radius: 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
  .plan b { font-weight: 600; }
  .price { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .note { color: var(--text-color-kumo-subtle); font-size: 13px; flex: 1; }
  button { margin-top: 8px; border: 0; border-radius: 999px; padding: 7px 12px; background: color-mix(in oklab, var(--text-color-kumo-default) 8%, transparent); color: inherit; cursor: pointer; }
  button:hover { background: color-mix(in oklab, var(--text-color-kumo-default) 14%, transparent); }
</style>
<div class="plans">
  <div class="plan"><b>Workers Free</b><span class="price">$0</span><span class="note">100k requests a day. Fine while it's just the team.</span><button data-plan="Workers Free">Choose</button></div>
  <div class="plan"><b>Workers Paid</b><span class="price">$5</span><span class="note">10M requests a month, then $0.30 per million.</span><button data-plan="Workers Paid">Choose</button></div>
  <div class="plan"><b>Enterprise</b><span class="price">Talk to us</span><span class="note">For the whole company, with support.</span><button data-plan="Enterprise">Choose</button></div>
</div>
<script type="module">
  for (const button of document.querySelectorAll("button")) {
    button.onclick = () => agent.send(\`Let's go with \${button.dataset.plan}.\`);
  }
</script>
</inline-html>`

const EMPTY_ANSWER = `This one went wrong.

<inline-html>
<title>Nothing here</title>
</inline-html>`

/** What people and the agent say, in every state, and what there is to know about a message. */
export const MessageBlocksPreview = () => {
  const { report, say } = useReport()
  const { open, toggle, of } = useOpen(['details'])

  return (
    <>
      <Section title="UserMessage (plain, a reply, a short reply to a long message, mentions, slash command, attachments, a Word document, deck and workbook drawn on their tiles once fetched, attachments alone, another sender, not read yet)">
        <Column>
          <UserMessage parts={[{ type: 'text', text: 'Create a dashboard showcasing my Jira stats' }]} onReply={() => say('reply')} />
          <UserMessage parts={[{ type: 'text', text: 'Make it twenty-four, and keep the weekly split.' }]} quote="The chart now covers 12 weeks" />
          <UserMessage
            parts={[{ type: 'text', text: 'Yes' }]}
            quote="The chart now covers 12 weeks (148 tickets). One edit to src/worker.ts failed because the limit is named maxResults there; I left it alone since 50 per page is enough. Want me to raise it anyway?"
          />
          <UserMessage
            parts={[
              { type: 'text', text: 'Turn ' },
              { type: 'capsule', title: 'PLAT-212 Chart shows 4 weeks', url: 'https://jira.example.com/browse/PLAT-212' },
              { type: 'text', text: ' into a ' },
              { type: 'format', noun: 'Document', icon: 'fileText' },
              { type: 'text', text: ' and a ' },
              { type: 'format', noun: 'Spreadsheet', icon: 'gridNine' },
            ]}
          />
          <UserMessage parts={[{ type: 'command', name: 'release-notes' }, { type: 'text', text: ' for the dashboard, since Monday' }]} />
          <UserMessage
            parts={[{ type: 'text', text: 'Here are the files' }]}
            attachments={[
              { id: 'image', name: 'chart.svg', mimeType: 'image/svg+xml', content: picture },
              { id: 'pdf', name: 'Project brief.pdf', mimeType: 'application/pdf' },
              { id: 'csv', name: 'Quarterly results with a long name.csv', mimeType: 'text/csv' },
            ]}
            onOpenAttachment={(id) => say(`open attachment ${id}`)}
          />
          <UserMessage
            parts={[{ type: 'text', text: 'The plan, the deck and the budget' }]}
            attachments={[
              { id: 'docx', name: 'Q3 plan.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
              { id: 'pptx', name: 'Roadmap.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
              { id: 'xlsx', name: 'Budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
            ]}
            loadAttachment={(id) => (id === 'docx' ? Q3_PLAN_DOCX() : id === 'pptx' ? ROADMAP_PPTX() : BUDGET_XLSX())}
            onOpenAttachment={(id) => say(`open attachment ${id}`)}
          />
          <UserMessage
            parts={[]}
            attachments={[{ id: 'only', name: 'chart.svg', mimeType: 'image/svg+xml', content: picture }]}
            onOpenAttachment={(id) => say(`open attachment ${id}`)}
            onReply={() => say('reply')}
          />
          <UserMessage parts={[{ type: 'text', text: 'I can take the export bug' }]} from="Grace Hopper" />
          <UserMessage parts={[{ type: 'text', text: 'Keep it under 100 words.' }]} unread />
        </Column>
      </Section>
      <Section title="AssistantMessage with live views (an answer's inline-html blocks on cards between its words, as wide as the conversation: drawn as they near the screen, a sketch standing in only if slow; Stop and Run again at its foot; a bar clicked asks to send its words, drawn in outline as yours until Send; a view first, a view last, and one with nothing in it)">
        <Column>
          <AssistantMessage text={CHART_ANSWER} onReply={() => say('reply')} onSendFromView={async (message) => { say(`send ${message}`); return true }} />
          <AssistantMessage text={PLANS_ANSWER} onSendFromView={async (message) => { say(`send ${message}`); return true }} />
          <AssistantMessage text={EMPTY_ANSWER} />
        </Column>
      </Section>
      <Section title="Message details (a bubble of their own under the message, as wide as what is in them, folding to their first line before they leave: a reply that took no steps, one with steps to open, one an automation woke it to write (the call in its details), one's own message, another person's, one not read yet; Details or the chevron puts them away)">
        <Column>
          <AssistantMessage
            text="I’ll build a personal Jira dashboard."
            details={{ ...of('no-trace'), ...messageInfo({ sender: 'Mock Model Fast', sentAt: SENT, trace: { steps: [], openSteps: open, onToggleStep: toggle } }) }}
          />
          <AssistantMessage
            text={'The chart now covers **twelve weeks**:\n\n- the window is a constant in `chart.tsx`\n- the worker already returned twelve'}
            details={{ ...of('details'), ...messageInfo({ sender: 'Mock Model', sentAt: SENT, trace: { steps: TRACE, openSteps: open, onToggleStep: toggle } }) }}
          />
          <AssistantMessage
            text="I told my computer I needed a break, and now it won’t stop sending me vacation ads."
            wokenBy="Tell a joke"
            details={{
              ...of('woken'),
              ...messageInfo({
                sender: 'Mock Model',
                sentAt: SENT,
                trace: { steps: [], openSteps: open, onToggleStep: toggle },
                prompt: {
                  label: 'Tell a joke',
                  call: 'onSchedule() with env.onSchedule_ARGS',
                  args: '[0]: {scheduleId: "b84856bb", title: "Tell a joke", description: "Every 2 minutes. Reply with a short, new, clean joke in this chat."}',
                },
              }),
            }}
          />
          <UserMessage
            parts={[{ type: 'text', text: 'Make it dark' }]}
            details={{ ...of('mine'), ...messageInfo({ sentAt: SENT }) }}
          />
          <UserMessage
            parts={[{ type: 'text', text: 'I can take the export bug' }]}
            from="Grace Hopper"
            details={{ ...of('theirs'), ...messageInfo({ sender: 'Grace Hopper', sentAt: SENT }) }}
          />
          <UserMessage
            parts={[{ type: 'text', text: 'Keep it under 100 words.' }]}
            unread
            details={{ ...of('unread'), ...messageInfo({}) }}
          />
        </Column>
      </Section>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
