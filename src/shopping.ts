import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import { callTool, onAmazonStep } from './amazon.ts'

// A shopping trip, tuned to finish in ~15s:
//
//   1. clear the cart + search Amazon            (in parallel, Amazon MCP)
//   2. the shopping sub-agent (Grok) picks one    (single fast call over the search results)
//   3. add it to the cart                         (Amazon MCP)
//   4. the supervisor checks out                  (Amazon MCP `perform-purchase` with the approved
//      budget as a hard cap: it reads the real total incl. tax/shipping and refuses if it's over)
//
// Grok never gets a purchase tool. Only the supervisor calls checkout, and only with the budget as the cap.

const CHECKOUT = (process.env.CHECKOUT ?? 'place') as 'stop' | 'place'
const TRIP_TIMEOUT_MS = Number(process.env.SHOPPER_TIMEOUT_MS ?? 5 * 60_000)
// The approved amount is the item budget before tax. Tax + shipping may add up to this much on top.
const TAX_SHIPPING_ALLOWANCE = 0.25
// Picking from a list doesn't need a reasoning model; this one answers in ~1s instead of ~4s.
const PICK_MODEL = process.env.SHOPPER_MODEL ?? 'grok-4.20-0309-non-reasoning'

// What the sub-agent picked, carried on every result so the chat agent can always link to it.
export type Picked = { title: string; price: number; link: string }

export type TripResult = (
  | { status: 'placed'; item: string; total: number; orderNumber: string | null; site: string; screenshot?: string }
  | { status: 'stopped'; item: string; total: number; site: string; screenshot?: string }
  | { status: 'blocked'; why: string; screenshot?: string }
  | { status: 'failed'; why: string; screenshot?: string }
  | { status: 'cancelled' }
) & { pick?: Picked }

export type Trip = { item: string; budget: number; stage: string; pick?: Picked; cancel: () => void }

export const productLink = (asin: string) => `https://www.amazon.com/dp/${asin}`

// Live transcript of the trip: printed to the terminal and appended to logs/shopping.log
// (`tail -f logs/shopping.log` to watch).
const LOG = path.resolve(import.meta.dirname, '..', 'logs', 'shopping.log')
let tripStart = Date.now()
export function log(...parts: unknown[]) {
  const line = `[${((Date.now() - tripStart) / 1000).toFixed(1).padStart(6)}s] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`
  console.log(`\x1b[36m${line}\x1b[0m`)
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.appendFileSync(LOG, line + '\n')
}

let active: Trip | null = null
export const activeTrip = () => active

const grok = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1', timeout: 30_000 })

type Result = { asin: string; title: string; isSponsored?: boolean; price?: string; reviews?: { averageRating?: string; reviewCount?: string } }
type Pick = { asin: string; title: string; price: number; why: string }

class Cancelled extends Error {}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const dollars = (s?: string) => (s ? Number(s.replace(/[^0-9.]/g, '')) || null : null)

async function tool(name: string, args: Record<string, unknown> = {}) {
  log(`tool ▸ ${name}`, args)
  const t = Date.now()
  const out = await callTool(name, args)
  log(`tool ◂ ${name} ${((Date.now() - t) / 1000).toFixed(1)}s: ${out.text.replace(/\s+/g, ' ').slice(0, 160)}`)
  if (/need to be logged in|log in to amazon first/i.test(out.text)) throw new Error(`amazon isn't logged in. someone run \`npm run amazon-login\``)
  return out.text
}

// The shopping sub-agent's decision: one Grok call that reads the results and picks.
async function pick(item: string, budget: number, results: Result[]): Promise<Pick | { gaveUp: string }> {
  const cap = budget // the budget is the item price; tax and shipping go on top
  const options = results
    .map((r) => ({ ...r, dollars: dollars(r.price) }))
    .filter((r) => r.dollars != null)
    .slice(0, 12)
    .map((r) => `${r.asin} | $${r.dollars!.toFixed(2)} | ${r.reviews?.averageRating ?? '?'} | ${r.reviews?.reviewCount ?? '?'} reviews | ${r.title.replace(/^Sponsored Ad - /, '').slice(0, 90)}`)
  if (!options.length) return { gaveUp: `amazon search came back empty for "${item}"` }

  log(`grok ▸ picking from ${options.length} results (${PICK_MODEL})`)
  const t = Date.now()
  const res = await grok.chat.completions.create({
    model: PICK_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `You shop for a shared house. Pick the single best product for what they asked for: it must match the request, cost at most $${cap.toFixed(2)}, ` +
          `and have the best mix of rating and number of reviews. Reply JSON: {"asin": string, "title": short product name, "price": number, ` +
          `"why": one casual lowercase line (rating, reviews, price)} or {"none": reason} if nothing fits.`,
      },
      { role: 'user', content: `They want: ${item}\n\nasin | price | rating | reviews | title\n${options.join('\n')}` },
    ],
  })
  const out = parseJson<Partial<Pick> & { none?: string }>(res.choices[0].message.content ?? '') ?? {}
  log(`grok ◂ ${((Date.now() - t) / 1000).toFixed(1)}s`, out)
  if (out.none || !out.asin) return { gaveUp: out.none ?? `nothing decent under $${cap.toFixed(2)}` }
  return { asin: out.asin, title: out.title ?? item, price: Number(out.price), why: out.why ?? '' }
}

export function startTrip(
  opts: { item: string; budget: number; store?: string; forHouse: string },
  onUpdate: (text: string, attachments?: string[]) => void,
  onDone: (r: TripResult) => void,
) {
  if (active) return false
  tripStart = Date.now()
  log(`=== trip: "${opts.item}", budget $${opts.budget} (CHECKOUT=${CHECKOUT}) ===`)
  let cancelled = false
  let finished = false
  const done = (r: TripResult) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    active = null
    r = { ...r, pick: trip.pick }
    log(`=== trip done in ${((Date.now() - tripStart) / 1000).toFixed(1)}s:`, r)
    onDone(r)
  }
  const timer = setTimeout(() => done({ status: 'failed', why: `took longer than ${Math.round(TRIP_TIMEOUT_MS / 60000)} min` }), TRIP_TIMEOUT_MS)
  const trip: Trip = {
    item: opts.item,
    budget: opts.budget,
    stage: 'searching',
    cancel: () => {
      cancelled = true
      done({ status: 'cancelled' })
    },
  }
  active = trip
  const check = () => {
    if (cancelled) throw new Cancelled()
  }

  ;(async () => {
    // 1. Empty the cart and search at the same time.
    const [cleared, searchText] = await Promise.all([tool('clear-cart'), tool('search-products', { searchTerm: opts.item })])
    // Never shop on top of leftovers: a failed clear gets one retry, then the trip stops.
    if (!/^(Successfully|No items)/i.test(cleared) && !/^(Successfully|No items)/i.test(await tool('clear-cart'))) {
      return done({ status: 'failed', why: `couldn't empty the amazon cart first, so i'm not buying anything` })
    }
    check()
    const results = parseJson<Result[]>(searchText)
    if (!results) return done({ status: 'failed', why: searchText.slice(0, 160) })

    // 2. Sub-agent picks.
    trip.stage = 'picking'
    const choice = await pick(opts.item, opts.budget, results)
    if ('gaveUp' in choice) return done({ status: 'blocked', why: choice.gaveUp })
    check()
    trip.pick = { title: choice.title, price: choice.price, link: productLink(choice.asin) }
    onUpdate(`👀 going with: ${choice.title.slice(0, 80)} · $${choice.price.toFixed(2)}\n${choice.why}\n${trip.pick.link}`)

    // 3. Cart.
    trip.stage = 'cart'
    const added = await tool('add-to-cart', { asin: choice.asin })
    if (!added.startsWith('✅')) return done({ status: 'failed', why: added.slice(0, 160) })
    check()

    // 4. Supervisor checkout, budget as a hard cap enforced inside the tool.
    trip.stage = 'checkout'
    if (CHECKOUT === 'stop') {
      const p = parseJson<{ subtotal: number | null; total: number | null; screenshot?: string }>(await tool('checkout-preview'))
      if (!p || p.total == null) return done({ status: 'blocked', why: `couldn't read the checkout total` })
      const items = p.subtotal ?? p.total
      if (items > opts.budget) return done({ status: 'blocked', why: `items cost $${items.toFixed(2)} before tax, over the $${opts.budget.toFixed(2)} budget`, screenshot: p.screenshot })
      return done({ status: 'stopped', item: choice.title, total: p.total, site: 'amazon.com', screenshot: p.screenshot })
    }
    const stopListening = onAmazonStep((line) => {
      if (line.includes('VERIFY_PAYMENT')) onUpdate(`🔐 the bank wants a verification code for this charge. whoever owns the card: check your phone and type the code into the amazon window on the laptop (2 min)`)
    })
    const buyText = await tool('perform-purchase', { maxSubtotal: opts.budget, maxTotal: round2(opts.budget * (1 + TAX_SHIPPING_ALLOWANCE)) })
    stopListening()
    const r = parseJson<{ placed: boolean; total: number | null; orderNumber?: string | null; reason?: string; screenshot?: string }>(buyText)
    if (!r) return done({ status: 'failed', why: buyText.slice(0, 160) })
    if (!r.placed) return done({ status: 'blocked', why: r.reason ?? 'amazon did not confirm the order', screenshot: r.screenshot })
    done({ status: 'placed', item: choice.title, total: r.total ?? choice.price, orderNumber: r.orderNumber ?? null, site: 'amazon.com', screenshot: r.screenshot })
  })().catch((e) => {
    if (e instanceof Cancelled) return
    console.error('[shopping]', e)
    done({ status: 'failed', why: (e as Error).message.slice(0, 160) })
  })

  return true
}
