import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Page, ElementHandle } from 'puppeteer'
import { getAmazonDomain } from './config.js'
import { createBrowserAndPage, throwIfNotLoggedIn } from './utils.js'

// ##################################
// Real checkout (upstream only mocked this)
// ##################################
//
// checkoutPreview(): cart → "Proceed to checkout" → through any interstitials → final review page.
//                    Reads the order total. Never clicks "Place your order".
// performPurchase(maxTotal): same walk, re-reads the total, refuses if it's over maxTotal,
//                    otherwise clicks "Place your order" and reads the order number.

const PROCEED_SELECTORS = [
  'input[name="proceedToRetailCheckout"]',
  '#sc-buy-box-ptc-button input',
  '#sc-buy-box-ptc-button',
  '[data-feature-id="proceed-to-checkout-action"] input',
]
const PLACE_ORDER_SELECTORS = [
  'input[name="placeYourOrder1"]',
  '#submitOrderButtonId input',
  '#submitOrderButtonId',
  '#bottomSubmitOrderButtonId input',
  '#placeOrder',
  'input[name="placeYourOrder"]',
]
const PLACE_ORDER_TEXT = /^\s*(place your order|place order|buy now)\s*$/i
// Pages Amazon sometimes puts between the cart and the review page (address, payment, Prime upsell).
const CONTINUE_TEXT = /^\s*(use this address|deliver to this address|use this payment method|continue|no thanks|not now|skip)\b/i

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const step = (msg: string) => console.error(`[STEP] checkout: ${msg}`)

async function firstVisible(page: Page, selectors: string[]): Promise<ElementHandle | null> {
  for (const sel of selectors) {
    const el = await page.$(sel)
    if (el && (await el.isVisible().catch(() => false))) return el
  }
  return null
}

// Finds a visible button/link/input whose label matches, tags it, and returns a handle to it.
async function findByText(page: Page, re: RegExp): Promise<ElementHandle | null> {
  const tag = `cfo-${Date.now()}`
  const found = await page.evaluate(
    (source, flags, tag) => {
      const re = new RegExp(source, flags)
      const els = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, span.a-button-text'))
      for (const el of els) {
        const label = ((el as HTMLInputElement).value || el.textContent || '').trim()
        const rect = (el as HTMLElement).getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0 && re.test(label)) {
          el.setAttribute('data-cfo', tag)
          return true
        }
      }
      return false
    },
    re.source,
    re.flags,
    tag
  )
  return found ? page.$(`[data-cfo="${tag}"]`) : null
}

async function placeOrderButton(page: Page) {
  return (await firstVisible(page, PLACE_ORDER_SELECTORS)) ?? (await findByText(page, PLACE_ORDER_TEXT))
}

async function clickAndSettle(page: Page, el: ElementHandle) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}), el.click()])
  await sleep(1200)
}

async function assertSignedIn(page: Page) {
  await throwIfNotLoggedIn(page)
  if (/\/ap\/(signin|mfa|cvf)/.test(page.url()) || (await page.$('#ap_password'))) {
    throw new Error('Amazon is asking to sign in again at checkout. Re-run the login helper to refresh cookies.')
  }
}

// Pre-tax, pre-shipping price of the items ("Items: $18.99" / "Items (1): $18.99").
function readSubtotal(text: string): number | null {
  const m = text.match(/Items(?:\s*\(\d+\))?:?\s*\$\s?([\d,]+\.\d{2})/i) ?? text.match(/Subtotal[^\n$]{0,20}:?\s*\$\s?([\d,]+\.\d{2})/i)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

function readTotal(text: string): number | null {
  const m = text.match(/Order total:?\s*\$\s?([\d,]+\.\d{2})/i) ?? text.match(/Total\s*\(?[^\n$]{0,30}\)?:?\s*\$\s?([\d,]+\.\d{2})/i)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

async function screenshot(page: Page, name: string) {
  const dir = path.join(os.homedir(), 'Pictures', 'roommate-cfo')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}-${Date.now()}.png`)
  await page.screenshot({ path: file as `${string}.png` }).catch(() => {})
  return fs.existsSync(file) ? file : undefined
}

async function goToReviewPage(page: Page) {
  step('opening cart')
  await page.goto(`https://www.${getAmazonDomain()}/gp/cart/view.html?ref_=nav_cart`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await assertSignedIn(page)

  const proceed = await firstVisible(page, PROCEED_SELECTORS)
  if (!proceed) throw new Error('No "Proceed to checkout" button. Is the cart empty?')
  step('clicking Proceed to checkout')
  // A plain click is sometimes swallowed before Amazon's scripts are ready, so submit the button's own form.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
    proceed.evaluate(el => {
      const input = el as HTMLInputElement
      if (input.form) input.form.requestSubmit(input)
      else input.click()
    }),
  ])
  await sleep(1200)
  if (/\/cart\/view/.test(page.url())) {
    step('still on cart, retrying with a real click')
    await clickAndSettle(page, proceed)
  }

  for (let i = 0; i < 8; i++) {
    step(`on ${page.url().replace(/\?.*/, '')}`)
    await assertSignedIn(page)
    if (await placeOrderButton(page)) {
      step('reached final review page')
      return
    }
    const next = await findByText(page, CONTINUE_TEXT)
    if (next) {
      const label = await next.evaluate(el => ((el as HTMLInputElement).value || el.textContent || '').trim().slice(0, 40))
      step(`clicking "${label}"`)
      await clickAndSettle(page, next)
    } else await sleep(1500)
  }
  const shot = await screenshot(page, 'amazon-stuck')
  throw new Error(`Could not reach the final review page (stuck on ${page.url().replace(/\?.*/, '')}, screenshot ${shot})`)
}

async function reviewItems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sels = ['[data-testid="item-title"]', '.checkout-item-title', '.a-row.item-title', '.lineitem-title-text', '.a-text-bold.item-title']
    const out: string[] = []
    for (const sel of sels) document.querySelectorAll(sel).forEach(el => out.push((el.textContent || '').trim()))
    return out.filter(Boolean).slice(0, 10)
  })
}

export type CheckoutPreview = { subtotal: number | null; total: number | null; items: string[]; url: string; screenshot?: string }

export async function checkoutPreview(): Promise<CheckoutPreview> {
  const { browser, page } = await createBrowserAndPage()
  try {
    await goToReviewPage(page)
    const text = await page.evaluate(() => document.body.innerText)
    return { subtotal: readSubtotal(text), total: readTotal(text), items: await reviewItems(page), url: page.url(), screenshot: await screenshot(page, 'amazon-review') }
  } finally {
    await browser.close().catch(() => {})
  }
}

export type PurchaseResult =
  | { placed: true; total: number; orderNumber: string | null; items: string[]; screenshot?: string }
  | { placed: false; reason: string; total: number | null; screenshot?: string }

export async function performPurchase(maxTotal: number, maxSubtotal?: number): Promise<PurchaseResult> {
  const { browser, page } = await createBrowserAndPage()
  try {
    await goToReviewPage(page)
    const text = await page.evaluate(() => document.body.innerText)
    const total = readTotal(text)
    const subtotal = readSubtotal(text)
    const items = await reviewItems(page)

    // Guardrail lives here too, so the tool can never be used to overspend.
    if (total == null) return { placed: false, reason: 'Could not read the order total, refusing to buy.', total, screenshot: await screenshot(page, 'amazon-review') }
    if (maxSubtotal != null && subtotal != null && subtotal > maxSubtotal) {
      return { placed: false, reason: `Items cost $${subtotal.toFixed(2)} before tax, over the $${maxSubtotal.toFixed(2)} budget.`, total, screenshot: await screenshot(page, 'amazon-review') }
    }
    if (total > maxTotal) {
      return { placed: false, reason: `Order total $${total.toFixed(2)} is over the $${maxTotal.toFixed(2)} limit.`, total, screenshot: await screenshot(page, 'amazon-review') }
    }

    const button = await placeOrderButton(page)
    if (!button) return { placed: false, reason: 'Place order button disappeared.', total }
    await clickAndSettle(page, button)

    // Normally ~15s to the thank-you page. If the card's bank asks for a one-time code (3-D Secure,
    // "Verify payment"), a person has to type it in the visible window, so wait up to 2.5 min for that.
    let deadline = Date.now() + 20000
    let announced = false
    while (Date.now() < deadline) {
      const body = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (/\/cpe\/|verify payment|verification code/i.test(page.url() + ' ' + body) && !announced) {
        announced = true
        deadline = Date.now() + 150000
        await page.bringToFront().catch(() => {})
        console.error('[STEP] checkout: VERIFY_PAYMENT bank is asking for a verification code')
      }
      if (/already ordered|duplicate order|you recently ordered/i.test(body) && !/thank you/i.test(body)) {
        return { placed: false, reason: 'Amazon flagged this as a possible duplicate order, not confirming it.', total, screenshot: await screenshot(page, 'amazon-duplicate') }
      }
      if (/thankyou|thank-you|purchase-confirmation/i.test(page.url()) || /order placed|thank you, your order/i.test(body)) {
        const order = body.match(/\b(\d{3}-\d{7}-\d{7})\b/)?.[1] ?? page.url().match(/purchaseId=([\d-]+)/)?.[1] ?? null
        return { placed: true, total, orderNumber: order, items, screenshot: await screenshot(page, 'amazon-confirmation') }
      }
      await sleep(1500)
    }
    const reason = announced
      ? `The bank asked for a verification code and it wasn't entered in time, so the payment wasn't approved. Check Your Orders.`
      : `Clicked place order but never saw a confirmation (on ${page.url().replace(/\?.*/, '')}). Check Your Orders before retrying.`
    return { placed: false, reason, total, screenshot: await screenshot(page, 'amazon-after-click') }
  } finally {
    await browser.close().catch(() => {})
  }
}
