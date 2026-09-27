import fs from 'fs'
import path from 'path'
import puppeteer from 'puppeteer'
import { COOKIES_FILE_PATH, AMAZON_COOKIES, IS_BROWSER_VISIBLE } from './config.js'

/** Get the current timestamp like "2024-06-06_15-30-45" */
export function getTimestamp() {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(
    now.getSeconds()
  )}`
}

export function loadAmazonCookiesFile() {
  if (fs.existsSync(COOKIES_FILE_PATH)) {
    try {
      const json = JSON.parse(fs.readFileSync(COOKIES_FILE_PATH, 'utf-8'))
      console.error('[INFO] Loaded Amazon cookies from file')
      return json.map((cookie: any) => ({
        ...cookie,
        // Ensure sameSite is set to a valid value
        sameSite: cookie.sameSite || 'Lax',
      }))
    } catch (error: any) {
      throw new Error(`Error reading or parsing amazonCookies.json: ${error.message}`)
    }
  } else {
    throw new Error(
      `No amazonCookies.json file found at ${COOKIES_FILE_PATH}. Please create it by logging into Amazon and exporting your cookies.`
    )
  }
}

// One Chrome for the whole server lifetime; each tool call gets its own tab.
// Launching a browser per call cost ~3-5s every time.
export const PROFILE_DIR = path.join(new URL('.', import.meta.url).pathname, '..', '.chrome-profile')

let sharedBrowser: Promise<puppeteer.Browser> | null = null

async function getBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = (async () => {
      // A persistent profile (shared with login_and_save_cookies.cjs) keeps the session the way a normal
      // browser does: Amazon's refreshed cookies are saved, so checkout doesn't ask to sign in again.
      const freshProfile = !fs.existsSync(PROFILE_DIR)
      const launch = () => puppeteer.launch({
        userDataDir: PROFILE_DIR,
        headless: !IS_BROWSER_VISIBLE,
        devtools: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: null,
      })
      let browser: puppeteer.Browser
      try {
        browser = await launch()
      } catch {
        // A Chrome that was killed leaves its profile lock behind; clear it and try once more.
        for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(PROFILE_DIR, f), { force: true })
        browser = await launch()
      }
      browser.on('disconnected', () => (sharedBrowser = null))
      // Seed from the exported cookies only when the profile is new; otherwise its own cookies are fresher.
      if (freshProfile && AMAZON_COOKIES?.length > 0) {
        await browser.setCookie(...AMAZON_COOKIES)
        console.error('[INFO] Set Amazon cookies in the browser')
      } else {
        console.error('[WARN] No Amazon cookies found, proceeding without them')
      }
      return browser
    })()
    sharedBrowser.catch(() => (sharedBrowser = null))
  }
  return sharedBrowser
}

/**
 * Returns a fresh tab in the shared browser. `browser.close()` on the returned handle only closes
 * that tab, so existing call sites keep working unchanged.
 */
export async function createBrowserAndPage(): Promise<{ browser: puppeteer.Browser; page: puppeteer.Page }> {
  const browser = await getBrowser()
  const page = await browser.newPage()

  // Skip heavy resources: pages become usable much sooner. CSS stays so visibility checks still work.
  await page.setRequestInterception(true)
  page.on('request', req => {
    if (['image', 'media', 'font'].includes(req.resourceType())) req.abort().catch(() => {})
    else req.continue().catch(() => {})
  })

  // Remove automation indicators
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    })
  })

  // Set user agent to match real browser
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  )
  await page.setViewport({ width: 1366, height: 768 })

  const tab = { close: () => page.close().catch(() => {}) } as unknown as puppeteer.Browser
  return { browser: tab, page }
}

export async function downloadImageAsBase64(url: string): Promise<string> {
  const response = await fetch(url)
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const b64 = buffer.toString('base64')
  return `${b64}`
}

export async function throwIfNotLoggedIn(page: puppeteer.Page): Promise<void> {
  const isLoginPage = (await page.$('#ap_email')) !== null || (await page.$('#signInSubmit')) !== null
  if (isLoginPage) {
    throw new Error('You need to be logged in to access this feature. Please log in to Amazon first and then try again.')
  }
}
