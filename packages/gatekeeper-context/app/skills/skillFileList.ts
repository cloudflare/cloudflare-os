import type { ListOrder, ListViewSpec } from '@gadgets/ui'
import { fileKind, fileSize, MANIFEST, type SkillFile } from './skillFiles'

// A skill's files are few, and one list: an order puts them in order, and groups nothing.
const together = (files: SkillFile[]) => [{ key: 'files', label: 'Files', entries: files.map((value) => ({ value })) }]

/** `SKILL.md` before the rest, which it is what the skill is. */
const manifestFirst = (a: SkillFile, b: SkillFile) => Number(b.path === MANIFEST) - Number(a.path === MANIFEST)

const byPath = (a: SkillFile, b: SkillFile) => a.path.localeCompare(b.path)

/** How a skill's files can be ordered and searched: by path, by what they are, and by how big, and found by path or by what they are. */
export const skillFileList: ListViewSpec<SkillFile, ListOrder<SkillFile>> = {
  orders: [
    { id: 'name', label: 'Name', arrange: (files) => together(files.toSorted((a, b) => manifestFirst(a, b) || byPath(a, b))) },
    { id: 'type', label: 'Type', arrange: (files) => together(files.toSorted((a, b) => manifestFirst(a, b) || fileKind(a).localeCompare(fileKind(b)) || byPath(a, b))) },
    { id: 'size', label: 'Size', arrange: (files) => together(files.toSorted((a, b) => fileSize(b) - fileSize(a) || byPath(a, b))) },
  ],
  searchText: (file) => `${file.path} ${fileKind(file)}`,
}
