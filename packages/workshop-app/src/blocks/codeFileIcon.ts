import {
  CssFile01Icon, FileCodeIcon, FileImageIcon, FileTextIcon, FileTypeIcon, HtmlFile01Icon, JavaScriptIcon,
  Settings02Icon, Typescript02Icon, type Icon,
} from '@/components/icons'
import { codeLanguage } from '@/files/codeLanguage'

const BY_LANGUAGE = {
  typescript: Typescript02Icon, tsx: Typescript02Icon, javascript: JavaScriptIcon, jsx: JavaScriptIcon,
  css: CssFile01Icon, html: HtmlFile01Icon, markdown: FileTypeIcon, json: FileCodeIcon,
} as const

const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i
// What sets a project up rather than being its code: its manifest and the files that configure tools.
const SETUP = /(^|\/)(package\.json|blueprint\.json|tsconfig[^/]*\.json|wrangler\.(jsonc?|toml)|\.[^/]*rc(\.\w+)?|[^/]*\.config\.\w+)$/i

/** The icon a file is listed with: what it is written in, a picture, or what sets the project up. */
export const codeFileIcon = (path: string): Icon => {
  if (SETUP.test(path)) return Settings02Icon
  if (IMAGE.test(path)) return FileImageIcon
  const language = codeLanguage(path)
  return language ? BY_LANGUAGE[language] : FileTextIcon
}
