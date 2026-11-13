import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import type { Plugin } from 'vite'

/**
 * The files pdf.js fetches by name while it draws, each from a directory it is told the URL of:
 * character maps for East Asian text, the standard fonts a PDF may use without embedding, the
 * WebAssembly decoders for JBIG2 and JPEG 2000 images (most scanned documents), and a colour
 * profile. Without them such a PDF draws with text or images missing.
 */
const DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm', 'iccs']

/**
 * Publishes those directories under `/pdfjs/`, where PdfPreview.tsx points pdf.js: served from the
 * package in development, copied into the bundle for a build. Vite has no way to import a
 * directory whose files are requested by names only the library knows.
 */
export function pdfjsAssets(): Plugin {
  const packageRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  return {
    name: 'gadgets:pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const [directory, file, ...rest] = (request.url ?? '').split('?')[0].split('/').filter(Boolean)
        const path = join(packageRoot, directory ?? '', file ?? '')
        // Exactly a file of one listed directory: nothing else in the package is reachable. A
        // backslash is a separator to Windows, so a name holding one could climb out.
        if (!DIRECTORIES.includes(directory) || !file || rest.length > 0 || /^\.|[\\:]/.test(file) ||
            relative(join(packageRoot, directory), path).includes(sep) || !existsSync(path)) {
          next()
          return
        }
        if (file.endsWith('.wasm')) response.setHeader('Content-Type', 'application/wasm')
        createReadStream(path).pipe(response)
      })
    },
    generateBundle() {
      for (const directory of DIRECTORIES) {
        for (const file of readdirSync(join(packageRoot, directory))) {
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${directory}/${file}`,
            source: readFileSync(join(packageRoot, directory, file)),
          })
        }
      }
    },
  }
}
