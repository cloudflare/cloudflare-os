import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * Core Workshop flows at a desktop and a phone size, against the Workshop at `E2E_BASE_URL`.
 *
 * Signs in one of two ways. With `E2E_ACCESS_TOKEN`, a Cloudflare Access application token for a
 * user with an email (a PR preview: the backend keys users by the token's email claim, so a
 * service token, which has none, cannot sign in). The preview under test is the pull request's own
 * code and Access forwards the identity to it, so the token must belong to a test user that Access
 * admits to the previews application and nothing else. Without it, a fresh password account
 * through the signup page (a local `pnpm dev-server`, where signups are open).
 *
 * Nothing here asks a model for anything: the composer flow drafts a message but does not send it.
 */

const baseUrl = process.env.E2E_BASE_URL
if (!baseUrl) throw new Error('E2E_BASE_URL is required: the Workshop to test, for example http://localhost:3000')
const accessToken = process.env.E2E_ACCESS_TOKEN

const VIEWPORTS: { name: string; phone: boolean; options: BrowserContextOptions }[] = [
  { name: 'desktop', phone: false, options: { viewport: { width: 1280, height: 800 } } },
  // Below Tailwind's `md` (768px), where the sidebar becomes the "Open menu" drawer.
  { name: 'phone', phone: true, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
]

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

async function signIn(page: Page): Promise<void> {
  if (accessToken) {
    await page.goto(new URL('/', baseUrl).href)
  } else {
    await page.goto(new URL('/signup', baseUrl).href)
    const password = randomUUID()
    // The backend takes letters and digits only, starting with a letter.
    await page.getByLabel('Username').fill(`e2e${randomUUID().replaceAll('-', '').slice(0, 12)}`)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByLabel('Confirm Password').fill(password)
    await page.getByRole('button', { name: 'Create account' }).click()
  }
  const home = page.getByRole('heading', { name: 'What are we working on?' })
  const onboarding = page.getByText("Let's set you up")
  await home.or(onboarding).first().waitFor({ timeout: 30_000 })
  if (await onboarding.isVisible()) {
    for (const step of ['Next', 'Next', 'Next', "Let's build"]) {
      await page.getByRole('button', { name: step, exact: true }).click()
    }
  }
  await home.waitFor()
}

for (const { name, phone, options } of VIEWPORTS) {
  describe(`Workshop on a ${name}`, () => {
    let page: Page
    const pageErrors: string[] = []

    /** The primary navigation: the sidebar on a desktop, the menu drawer on a phone. */
    async function navigation(): Promise<Locator> {
      if (!phone) return page.getByRole('complementary', { name: 'Primary' })
      await page.getByRole('button', { name: 'Open menu' }).click()
      const drawer = page.getByRole('dialog', { name: 'Primary navigation' })
      await drawer.waitFor()
      return drawer
    }

    beforeAll(async () => {
      const context = await browser.newContext(options)
      // HttpOnly, as Access sets it, so the page's own scripts cannot read the token.
      if (accessToken) {
        await context.addCookies([{ name: 'CF_Authorization', value: accessToken, url: baseUrl, httpOnly: true, secure: true, sameSite: 'Lax' }])
      }
      page = await context.newPage()
      page.on('pageerror', (error) => pageErrors.push(error.message))
      await signIn(page)
    })

    afterAll(async () => {
      await page.context().close()
    })

    afterEach(() => {
      expect(pageErrors).toEqual([])
    })

    it('signs in and lands on Home with the composer', async () => {
      await expect.poll(() => page.getByPlaceholder('Start a new conversation…').isVisible()).toBe(true)
      expect(await page.getByRole('complementary', { name: 'Primary' }).isVisible()).toBe(!phone)
    })

    it('opens Workspaces from the navigation', async () => {
      await (await navigation()).getByRole('link', { name: 'Workspaces' }).click()
      await page.getByRole('heading', { name: 'Workspaces', level: 1 }).waitFor()
      expect(new URL(page.url()).pathname).toBe('/workspaces')
    })

    it('opens Profile from the profile menu', async () => {
      await (await navigation()).getByRole('button', { name: 'Open profile menu' }).click()
      await page.getByRole('menuitem', { name: 'Profile' }).click()
      await page.getByRole('heading', { name: 'Profile', level: 1 }).waitFor()
    })

    it('lists Gatekeepers', async () => {
      await page.goto(new URL('/gatekeepers', baseUrl).href)
      await page.getByRole('heading', { name: 'Gatekeepers', level: 1 }).waitFor()
    })

    it('drafts a message on Home', async () => {
      await (await navigation()).getByRole('link', { name: 'Home' }).click()
      const composer = page.getByPlaceholder('Start a new conversation…')
      await composer.fill('What can you help me with?')
      await expect.poll(() => page.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true)
    })
  })
}
