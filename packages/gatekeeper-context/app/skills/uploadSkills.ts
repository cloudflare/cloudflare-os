import { readUploadFiles } from './skillFiles'
import { prepareSkillUploads } from './skillUpload'
import type { SkillStore } from './SkillStore'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Adds the skills in files that were chosen to `store`, untagged, or to the collection `into`:
 * each Markdown file is a skill, and a folder with a `SKILL.md` is one with everything in it.
 * Gives their ids, or rejects with what to tell the user.
 */
export const uploadSkills = async (store: SkillStore, chosen: File[], into?: string) => {
  let candidates
  try {
    candidates = prepareSkillUploads(await readUploadFiles(chosen))
  } catch (error) {
    throw new Error(`Couldn’t read what was chosen: ${messageOf(error)}`, { cause: error })
  }
  if (candidates.length === 0) throw new Error('No skills in what was chosen. A skill is a Markdown file, or a folder with a SKILL.md in it.')
  try {
    return await store.addUploads(candidates, into)
  } catch (error) {
    throw new Error(`Couldn’t add what was chosen: ${messageOf(error)}`, { cause: error })
  }
}
