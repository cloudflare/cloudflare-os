import {
  FileCodeIcon, FileCssIcon, FileHtmlIcon, FileImageIcon, FileJsIcon, FileMdIcon, FileTextIcon, FileTsIcon, GearSixIcon, type Icon,
} from '@phosphor-icons/react'
import { codeLanguage } from '@/files/codeLanguage'

const BY_LANGUAGE = {
  typescript: FileTsIcon, tsx: FileTsIcon, javascript: FileJsIcon, jsx: FileJsIcon,
  css: FileCssIcon, html: FileHtmlIcon, markdown: FileMdIcon, json: FileCodeIcon,
} as const

const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i
// What sets a project up rather than being its code: its manifest and the files that configure tools.
const SETUP = /(^|\/)(package\.json|blueprint\.json|tsconfig[^/]*\.json|wrangler\.(jsonc?|toml)|\.[^/]*rc(\.\w+)?|[^/]*\.config\.\w+)$/i

/** The icon a file is listed with: what it is written in, a picture, or what sets the project up. */
export const codeFileIcon = (path: string): Icon => {
  if (SETUP.test(path)) return GearSixIcon
  if (IMAGE.test(path)) return FileImageIcon
  const language = codeLanguage(path)
  return language ? BY_LANGUAGE[language] : FileTextIcon
}
