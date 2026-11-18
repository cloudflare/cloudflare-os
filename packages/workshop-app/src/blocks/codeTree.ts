/** A file as the tree lists it: anything with a path. */
export type CodeTreeFile = { path: string }

/** A folder or a file in the tree, with how deep it is. */
export type CodeTreeNode<File extends CodeTreeFile> =
  | { kind: 'folder'; name: string; path: string; children: CodeTreeNode<File>[] }
  | { kind: 'file'; name: string; file: File }

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** A file's own name, without the folders it is in: "a/b/c.ts" is "c.ts". */
export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * Files as a tree of folders. At the root, the files come first in the order given (a gadget's
 * screen and server side, then what it is), then its folders; within a folder, as the editors
 * engineers know list them, its folders first and then its files, each by name.
 */
export const buildCodeTree = <File extends CodeTreeFile>(files: readonly File[]): CodeTreeNode<File>[] => {
  type Folder = { folders: Map<string, Folder>; files: File[] }
  const root: Folder = { folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let folder = root
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part)
      if (!next) folder.folders.set(part, next = { folders: new Map(), files: [] })
      folder = next
    }
    folder.files.push(file)
  }
  const nodes = (folder: Folder, prefix: string, atRoot: boolean): CodeTreeNode<File>[] => {
    const folders = [...folder.folders].toSorted(([a], [b]) => collator.compare(a, b)).map(([name, inner]): CodeTreeNode<File> => (
      { kind: 'folder', name, path: prefix + name, children: nodes(inner, `${prefix}${name}/`, false) }
    ))
    const listed = atRoot ? folder.files : folder.files.toSorted((a, b) => collator.compare(nameOf(a.path), nameOf(b.path)))
    const fileNodes = listed.map((file): CodeTreeNode<File> => ({ kind: 'file', name: nameOf(file.path), file }))
    return atRoot ? [...fileNodes, ...folders] : [...folders, ...fileNodes]
  }
  return nodes(root, '', true)
}

/** The folders a path is in, outermost first: "a/b/c.ts" is in "a" and "a/b". */
export const foldersOf = (path: string): string[] => {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

/** How well a path fits what was typed, and which of its characters fit, to mark. */
export type CodeMatch = { score: number; indices: number[] }

const BOUNDARY = /[/\-_.\s]/

// The characters of what was typed found in order in `text`, from `start`, preferring each where a
// word starts and runs carry on: a greedy pass that looks ahead for a better start, which is what
// people expect of a file finder without the cost of trying every way.
const matchFrom = (query: string, text: string, lower: string, start: number): CodeMatch | undefined => {
  const indices: number[] = []
  let score = 0
  let at = start
  for (let index = 0; index < query.length; index += 1) {
    const wanted = query[index]!
    let found = lower.indexOf(wanted, at)
    if (found === -1) return undefined
    // A later place where a word starts is better than the next place it comes up.
    const previous = indices.at(-1)
    if (previous === undefined || found !== previous + 1) {
      for (let look = found; look !== -1; look = lower.indexOf(wanted, look + 1)) {
        const startsWord = look === 0 || BOUNDARY.test(text[look - 1]!) || (text[look] !== lower[look] && text[look - 1] === lower[look - 1])
        if (startsWord) {
          found = look
          break
        }
      }
    }
    const startsWord = found === 0 || BOUNDARY.test(text[found - 1]!) || (text[found] !== lower[found] && text[found - 1] === lower[found - 1])
    score += 1
    if (startsWord) score += 3
    if (previous !== undefined && found === previous + 1) score += 4
    if (previous !== undefined) score -= Math.min(found - previous - 1, 6) * 0.25
    indices.push(found)
    at = found + 1
  }
  return { score, indices }
}

/**
 * How well a path fits what was typed, as a file finder takes it: its characters in order,
 * anywhere, better where they start words and run on, and best within the file's own name, so that
 * "srv" finds "server.ts" before "lib/services/view.ts". Nothing where it does not fit at all.
 */
export const matchPath = (typed: string, path: string): CodeMatch | undefined => {
  const query = typed.toLowerCase().replace(/\s+/g, '')
  if (query === '') return { score: 0, indices: [] }
  const lower = path.toLowerCase()
  const nameStart = path.lastIndexOf('/') + 1
  // First within the name alone, which counts for more, then across the whole path.
  const inName = matchFrom(query, path, lower, nameStart)
  if (inName) return { score: inName.score + 10 - path.length * 0.01, indices: inName.indices }
  const anywhere = matchFrom(query, path, lower, 0)
  return anywhere && { score: anywhere.score - path.length * 0.01, indices: anywhere.indices }
}

/** The paths that fit what was typed, best first, each with what fits in it. */
export const matchPaths = <File extends CodeTreeFile>(typed: string, files: readonly File[], most = 50) =>
  files
    .flatMap((file) => {
      const match = matchPath(typed, file.path)
      return match ? [{ file, ...match }] : []
    })
    .toSorted((a, b) => b.score - a.score)
    .slice(0, most)
