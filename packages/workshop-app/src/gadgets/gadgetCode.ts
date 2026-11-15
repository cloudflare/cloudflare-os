import type { TreeNode } from '@gadgets/workshop-shared/api'

/** One file of a gadget's code, as its Code tab lists it. */
export type CodeFile = {
  /** Its path from the gadget's root: "lib/protocol.ts". */
  path: string
  /** Only a file or an executable has text to show; a symlink or submodule says what it is. */
  kind: 'file' | 'executable' | 'symlink' | 'submodule'
  /** What it is to the gadget, in a few words, for the files every gadget has. */
  role?: string
}

// The files every gadget is made of, by name without extension, and what each is to it.
const ROLES: Record<string, string> = {
  client: 'What it shows',
  server: 'What it keeps and does',
  readme: 'What it is',
}

// Where those come in the list: its two halves, then what it is, then everything else.
const ORDER = ['client', 'server', 'readme']

const stem = (path: string) => {
  if (path.includes('/')) return undefined
  const dot = path.lastIndexOf('.')
  return (dot > 0 ? path.slice(0, dot) : path).toLowerCase()
}

const rank = (path: string) => {
  const at = ORDER.indexOf(stem(path) ?? '')
  return at === -1 ? ORDER.length + (path.includes('/') ? 1 : 0) : at
}

/**
 * A commit's tree (`Overseer.listTree`) as the flat list of files the Code tab shows: the gadget's
 * screen and server side first, then its README, then the rest of what is at its root, then what is
 * in folders, each group by path.
 */
export const codeFiles = (tree: readonly TreeNode[]): CodeFile[] => {
  const files: CodeFile[] = []
  const walk = (nodes: readonly TreeNode[], prefix: string) => {
    for (const node of nodes) {
      const path = prefix + node.name
      if (node.kind === 'dir') walk(node.children, `${path}/`)
      else {
        const role = ROLES[stem(path) ?? '']
        files.push(role ? { path, kind: node.kind, role } : { path, kind: node.kind })
      }
    }
  }
  walk(tree, '')
  return files.toSorted((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path))
}

/** The file shown first: the one asked for, if it is there, else the first listed. */
export const shownFile = (files: readonly CodeFile[], asked: string | undefined) =>
  files.find(({ path }) => path === asked) ?? files[0]
