import { RpcTarget } from 'capnweb'
import type { GadgetExportFormat, UiBundle } from '@gadgets/workshop-shared/api'
import { pipelined } from './pipelined'

// What a gadget's UI takes to load, so that loading can be seen.
const LOAD_TIME = 500
// What an export takes, so that it can be seen under way.
const EXPORT_TIME = 1200

/** What the gadget exports as: its tasks as a checklist or a table, and a PDF that cannot be made here, to see a failure. */
export const MOCK_EXPORT_FORMATS: GadgetExportFormat[] = [
  { id: 'markdown', label: 'Markdown', mode: 'server', contentType: 'text/markdown', fileExtension: '.md' },
  { id: 'csv', label: 'CSV', mode: 'server', contentType: 'text/csv', fileExtension: '.csv' },
  { id: 'pdf', label: 'PDF', mode: 'browser', contentType: 'application/pdf', fileExtension: '.pdf' },
]

/** What a handle's calls fail with once the workspace has restarted under it. */
export const RESTARTED = new Error('The workspace restarted.')

/** What a handle's calls fail with once the app's connection has dropped, as a disposed stub's do. */
export const DISCONNECTED = new Error('Attempted to use RPC stub after it has been disposed.')

/**
 * One `openWorkspace`, which the workspace restarting or the connection dropping breaks, as it
 * does an RPC stub: `broken` is then what its calls fail with.
 */
export type Handle = { broken?: Error; onBroken: Set<(error: unknown) => void> }

type Task = { text: string; done: boolean }

/** The gadget's server side, which its page calls over the connection it asks for. */
class MockGadgetServer extends RpcTarget {
  constructor(private readonly document: { title: string; tasks: Task[] }, private readonly onDone?: (task: string) => void) {
    super()
  }

  getDocument() {
    return this.document
  }

  toggle(index: number) {
    const task = this.document.tasks[index]
    if (task) task.done = !task.done
    if (task?.done) this.onDone?.(task.text)
    return this.document
  }

  [Symbol.dispose]() {}
}

/**
 * A gadget's UI: a document whose tasks are ticked off on its server side. Plain DOM, as a page in
 * the sandbox may import nothing. `gadget` is the connection the sandbox's prelude makes.
 */
export const UI_CODE = String.raw`
document.head.insertAdjacentHTML('beforeend', '<style>' + [
  'body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1d1d1f; }',
  'main { max-width: 40rem; margin: 0 auto; padding: 40px 32px; }',
  'h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.02em; }',
  'p { color: #6e6e73; margin: 0 0 24px; }',
  'label { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 12px; cursor: pointer; }',
  'label:hover { background: rgb(0 0 0 / 0.04); }',
  'label.done span { text-decoration: line-through; color: #8e8e93; }',
  'input { width: 18px; height: 18px; accent-color: #ff5c2e; }',
].join('\n') + '</style>')

const main = document.body.appendChild(document.createElement('main'))
const render = (doc) => {
  const left = doc.tasks.filter((task) => !task.done).length
  main.innerHTML = '<h1></h1><p></p>'
  main.querySelector('h1').textContent = doc.title
  main.querySelector('p').textContent = left ? left + ' of ' + doc.tasks.length + ' left to do' : 'All done'
  doc.tasks.forEach((task, index) => {
    const row = main.appendChild(document.createElement('label'))
    row.className = task.done ? 'done' : ''
    row.innerHTML = '<input type="checkbox"><span></span>'
    row.querySelector('input').checked = task.done
    row.querySelector('span').textContent = task.text
    row.querySelector('input').addEventListener('change', async () => render(await gadget.toggle(index)))
  })
}
render(await gadget.getDocument())
`

/**
 * A gadget in the fake workspace, whatever its id: a review's to-do list, which exports as a
 * checklist or a table (`MOCK_EXPORT_FORMATS`). `backUp` waits for a workspace that is restarting
 * to be back, and `ui` is its screen's code as it was last kept, which edits saved change.
 * `onDone` is told of each task ticked off, which a gadget connected to a document asks to note there.
 */
export class MockGadget {
  #document: { title: string; tasks: Task[] }

  constructor(title: string, private readonly backUp: () => Promise<void>, private readonly ui: (chatId?: number) => string = () => UI_CODE, private readonly onDone?: (task: string) => void) {
    this.#document = {
      title,
      tasks: [
        { text: 'Summarise the quarter’s incidents', done: true },
        { text: 'Chart deploy frequency against Q2', done: true },
        { text: 'Collect the team leads’ notes', done: false },
        { text: 'Draft the hiring plan for Q4', done: false },
        { text: 'Send for review', done: false },
      ],
    }
  }

  /** What it is called, which renaming it changes. */
  get title() {
    return this.#document.title
  }

  set title(title: string) {
    this.#document.title = title
  }

  /** The gadget, through the workspace's `handle`, which breaks with it. */
  open(handle: Handle) {
    const reachable = async () => {
      await this.backUp()
      if (handle.broken) throw handle.broken
    }
    return {
      getUiBundle: async (chatId?: number): Promise<UiBundle | null> => {
        await reachable()
        await new Promise((resolve) => setTimeout(resolve, LOAD_TIME))
        return { jsCode: this.ui(chatId) }
      },
      getExportFormats: async () => {
        await reachable()
        await new Promise((resolve) => setTimeout(resolve, LOAD_TIME))
        return MOCK_EXPORT_FORMATS
      },
      export: async (id: string) => {
        await reachable()
        await new Promise((resolve) => setTimeout(resolve, EXPORT_TIME))
        const { title, tasks } = this.#document
        const text = id === 'markdown'
          ? `# ${title}\n\n${tasks.map(({ text: task, done }) => `- [${done ? 'x' : ' '}] ${task}`).join('\n')}\n`
          : id === 'csv'
            ? `Task,Done\n${tasks.map(({ text: task, done }) => `"${task.replaceAll('"', '""')}",${done ? 'yes' : 'no'}`).join('\n')}\n`
            : undefined
        if (text === undefined) throw new Error('Browser rendering isn’t available in a scripted chat.')
        return new Blob([text]).stream()
      },
      connectToGadget: () => pipelined((async () => {
        await reachable()
        const server = new MockGadgetServer(this.#document, this.onDone)
        return Object.assign(server, { onRpcBroken: (callback: (error: unknown) => void) => void handle.onBroken.add(callback) })
      })()),
      onRpcBroken: (callback: (error: unknown) => void) => (handle.broken ? callback(handle.broken) : void handle.onBroken.add(callback)),
      // Nothing to release: the fake workspace keeps its gadgets.
      [Symbol.dispose]: () => {},
    }
  }
}
