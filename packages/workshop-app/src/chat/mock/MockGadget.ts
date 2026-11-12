import { RpcTarget } from 'capnweb'
import type { UiBundle } from '@gadgets/workshop-shared/api'

// What a gadget's UI takes to load, so that loading can be seen.
const LOAD_TIME = 500

type Task = { text: string; done: boolean }

/** The gadget's server side, which its page calls over the connection it asks for. */
class MockGadgetServer extends RpcTarget {
  constructor(private readonly document: { title: string; tasks: Task[] }) {
    super()
  }

  getDocument() {
    return this.document
  }

  toggle(index: number) {
    const task = this.document.tasks[index]
    if (task) task.done = !task.done
    return this.document
  }

  [Symbol.dispose]() {}
}

/**
 * A gadget's UI: a document whose tasks are ticked off on its server side. Plain DOM, as a page in
 * the sandbox may import nothing. `gadget` is the connection the sandbox's prelude makes.
 */
const UI_CODE = String.raw`
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

/** A gadget in the fake workspace, whatever its id: a review's to-do list. */
export class MockGadget {
  #document: { title: string; tasks: Task[] }

  constructor(title: string) {
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

  async getUiBundle(): Promise<UiBundle | null> {
    await new Promise((resolve) => setTimeout(resolve, LOAD_TIME))
    return { jsCode: UI_CODE }
  }

  async connectToGadget() {
    return new MockGadgetServer(this.#document)
  }

  /** Nothing to release: the fake workspace keeps its gadgets. */
  [Symbol.dispose]() {}
}
