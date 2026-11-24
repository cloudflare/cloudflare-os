// Puts this app's build beside the old app's, in one directory a backend that serves the Workshop's
// pages itself can serve both from (`build:workshop-assets` in vite.config.ts):
//
//   dist-workshop/            the old app's build (`workshop-frontend/dist`), whole
//   dist-workshop/next.html   this app's page, which the backend sends for the `cfos-ui=next` cookie
//   dist-workshop/next-assets this app's chunks (`build.assetsDir`)
//
// What else this app's build holds at its root is the old app's too (`pdfjs/`, which must match,
// `sw.js`) or this build's own and not needed (`favicon.svg`, `assets-build-id`, which only the
// router reads). Anything new there fails the build, rather than going missing unnoticed. Source
// maps are left out: they are uploaded apart.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const OLD = '../workshop-frontend/dist'
const NEW = 'dist'
const OUT = 'dist-workshop'
const NEXT_PAGE = 'next.html'
const NEXT_ASSETS = 'next-assets'
// This build's root entries, besides its page and chunks, and why each is left behind.
const LEFT_BEHIND = new Set(['pdfjs', 'sw.js', 'favicon.svg', 'assets-build-id'])

const fail = (message: string): never => {
  console.error(`workshop-assets: ${message}`)
  process.exit(1)
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => statSync(join(dir, path)).isFile())
    .toSorted()

const notMap = (path: string) => !path.endsWith('.map')

for (const dir of [OLD, NEW]) {
  if (!existsSync(join(dir, 'index.html'))) fail(`${dir} holds no build`)
}

for (const entry of readdirSync(NEW)) {
  if (entry !== 'index.html' && entry !== NEXT_ASSETS && !LEFT_BEHIND.has(entry) && notMap(entry)) {
    fail(`${join(NEW, entry)} is new: carry it into ${OUT} or add it to LEFT_BEHIND`)
  }
}

// The old app's pdf.js files serve this app's thumbnails and previews too.
const oldPdfjs = filesUnder(join(OLD, 'pdfjs'))
const newPdfjs = filesUnder(join(NEW, 'pdfjs'))
if (oldPdfjs.join('\n') !== newPdfjs.join('\n') ||
    newPdfjs.some((path) => !readFileSync(join(OLD, 'pdfjs', path)).equals(readFileSync(join(NEW, 'pdfjs', path))))) {
  fail('the two builds publish different pdf.js files under pdfjs/; align their pdfjs-dist versions')
}

rmSync(OUT, { recursive: true, force: true })
cpSync(OLD, OUT, { recursive: true, filter: notMap })

const carry = (from: string, to: string) => {
  if (existsSync(to)) fail(`${relative(OUT, to)} is already in the old app's build`)
  cpSync(from, to, { recursive: true, filter: notMap })
}
carry(join(NEW, 'index.html'), join(OUT, NEXT_PAGE))
carry(join(NEW, NEXT_ASSETS), join(OUT, NEXT_ASSETS))
