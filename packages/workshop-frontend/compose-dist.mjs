// Puts the new Workshop (`workshop-app`) in this package's `dist`, which is what a deployment serves,
// in place of this one. This app stays only for its admin page: its `index.html` becomes
// `admin.html`, which Workers assets serves at `/admin`, and its client router then draws the page.
// Every other path falls through to the new app's `index.html` (`not_found_handling`). Both builds
// name their bundles by content hash, so their `assets/` sit side by side; where a public file has
// the same name in both (the favicon), the new app's wins.
import { cpSync, existsSync, renameSync } from 'node:fs'

const app = new URL('../workshop-app/dist/', import.meta.url)
const dist = new URL('dist/', import.meta.url)

if (!existsSync(new URL('index.html', app))) {
  throw new Error('workshop-app has no build in ../workshop-app/dist; run its build first')
}
renameSync(new URL('index.html', dist), new URL('admin.html', dist))
cpSync(app, dist, { recursive: true, force: true })
