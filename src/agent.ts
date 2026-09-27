import { APPROVAL_LIMIT, APPROVALS_NEEDED, ALLOWANCE_TOPUP, MONTHLY_CONTRIBUTION, ROOMMATES, HOUSE_RULES, KNOWN_BILLERS, CARDHOLDER, TAX_SHIPPING_ALLOWANCE } from './config.ts'
import { understand, summarize } from './grok.ts'
import { startTrip, activeTrip, type TripResult } from './shopping.ts'
import { pay, payFromVault, poolBalances, rlusdBalance, txLink, wallet, ensurePayee } from './ledger.ts'
import { splitBill, formatShares, fmt } from './split.ts'
import { loadState, saveState, loadWallets, type Pending, type State } from './state.ts'

export type Incoming = { from: string; text: string; imagePath?: string; reaction?: 'like' | 'dislike' }
export type Send = (text: string, attachments?: string[]) => Promise<void>

const APPROVE = /^\s*(yes|yep|yeah|yup|y|approve[d]?|ok(ay)?|sure|do it|go|send it|lgtm)\b|^\s*(👍|✅)/i
const REJECT = /^\s*(no|nope|nah|reject|deny)\b|^\s*(👎|❌)/i


// Chat memory for Grok: the last lines verbatim, plus a rolling summary of everything older.
// When the buffer fills up, the oldest half gets folded into the summary (compaction).
const recent: string[] = []
let earlier = ''
const remember = (line: string) => {
  recent.push(line)
  if (recent.length > 24) {
    const old = recent.splice(0, 12)
    summarize(earlier, old)
      .then((s) => (earlier = s))
      .catch(() => (earlier = `${earlier}\n${old.join('\n')}`.slice(-2000)))
  }
}

// One thing at a time (messages, trip results), so two quick approvals can't both trigger a payment.
let queue = Promise.resolve()
let lastSend: Send = async () => {}
function exclusive(fn: () => Promise<void>) {
  queue = queue.then(fn).catch((e) => {
    console.error(e)
    return lastSend(`ugh something broke on my end (${(e as Error).message.slice(0, 120)}) try again in a sec`)
  })
  return queue
}

export function handle(msg: Incoming, rawSend: Send) {
  const send: Send = async (text, attachments) => {
    const out = casual(text)
    remember(`CFO: ${out}`)
    await rawSend(out, attachments)
  }
  lastSend = send
  return exclusive(() => processMessage(msg, send))
}

async function processMessage(msg: Incoming, send: Send) {
  const state = loadState()
  const line = msg.reaction ? `${msg.from} reacted ${msg.reaction === 'like' ? '👍' : '👎'}` : `${msg.from}: ${msg.text || ''}${msg.imagePath ? ' [photo]' : ''}`

  if (state.pending.length && isVote(msg)) {
    remember(line)
    return vote(state, msg, send)
  }
  if (msg.reaction) return

  const intent = await understand(msg.from, msg.text, msg.imagePath, await snapshot(state))
  remember(line)
  console.log(`[agent] ${line} ->`, intent)

  switch (intent.type) {
    case 'bill': {
      if (!validAmount(intent.amount)) return send(`can't read the total on that one lol, how much is it`)
      const { shares, reasoning } = splitBill(intent.category, intent.amount)
      const known = KNOWN_BILLERS.find((b) => b.match.test(intent.biller))
      return propose(state, send, {
        kind: 'bill',
        label: `${intent.biller} ${fmt(intent.amount)}`,
        header: `🧾 ${intent.biller} · ${fmt(intent.amount)}${intent.due ? ` · due ${intent.due}` : ''}`,
        reasoning,
        payee: known?.payee ?? 'Unverified Payee',
        payTo: intent.biller,
        knownPayee: !!known,
        amount: intent.amount,
        shares,
        proposedBy: msg.from,
      })
    }
    case 'purchase': {
      if (!validAmount(intent.amount)) return send(`how much is the ${intent.item}`)
      const { shares } = splitBill('other', intent.amount)
      return propose(state, send, {
        kind: 'purchase',
        label: `${intent.item} ${fmt(intent.amount)}`,
        header: `🛒 ${msg.from} wants a ${intent.item} · up to ${fmt(intent.amount)}${intent.store ? ` from ${intent.store}` : ''}`,
        reasoning: "house stuff so it's split evenly",
        payee: 'Store',
        payTo: 'the house card',
        item: intent.item,
        store: intent.store,
        knownPayee: true,
        amount: intent.amount,
        shares,
        proposedBy: msg.from,
      })
    }
    case 'balances':
      return balances(state, send)
    case 'deposit':
      return deposit(state, msg.from, intent.amount, send)
    case 'cancel': {
      const trip = activeTrip()
      if (trip && !state.pending.length) return trip.cancel()
      const dropped = state.pending.pop()
      saveState(state)
      return send(dropped ? `ok scrapped ${dropped.label}, nothing got paid` : `nothing's waiting on a vote rn`)
    }
    case 'reply':
      return send(intent.text)
  }
}

const validAmount = (n: number) => Number.isFinite(n) && n > 0 && n < 100_000
const isRoommate = (name: string) => ROOMMATES.some((r) => r.name === name)

function isVote(msg: Incoming) {
  if (msg.reaction) return true
  return !msg.imagePath && msg.text.length < 40 && (APPROVE.test(msg.text) || REJECT.test(msg.text))
}

type Proposal = Omit<Pending, 'id' | 'approvals' | 'memo'> & { header: string; reasoning: string; knownPayee: boolean }

async function propose(state: State, send: Send, p: Proposal) {
  const pending: Pending = {
    id: Date.now().toString(36),
    kind: p.kind,
    label: p.label,
    payee: p.payee,
    payTo: p.payTo,
    amount: p.amount,
    shares: p.shares,
    proposedBy: p.proposedBy,
    item: p.item,
    store: p.store,
    approvals: [],
    memo: `${p.label} | ${p.reasoning} | ${formatShares(p.shares)}`,
  }
  const summary = `${p.header}\n${p.reasoning}\n${formatShares(p.shares)}`
  const { vault, allowance } = await poolBalances()

  // Guardrails. The agent pays on its own only if every check passes; otherwise the roommates vote.
  const checks = [
    { ok: p.kind === 'bill', pass: 'bill', fail: 'purchases always get a vote' },
    { ok: p.knownPayee, pass: 'known biller', fail: `never paid ${p.payTo} before, could be sketchy` },
    { ok: p.amount <= APPROVAL_LIMIT, pass: `under $${APPROVAL_LIMIT}`, fail: `over $${APPROVAL_LIMIT}` },
    { ok: allowance >= p.amount, pass: `allowance covers it (${fmt(allowance)})`, fail: `my allowance is down to ${fmt(allowance)}` },
  ]
  if (checks.every((c) => c.ok)) {
    const passed = checks.slice(1).map((c) => `✓ ${c.pass}`).join(' · ')
    await send(`${summary}\n${passed}, paying it…`)
    pending.memo += ` | policy: auto-pay, ${checks.slice(1).map((c) => c.pass).join(', ')}`
    return execute(state, pending, send)
  }

  if (p.amount > vault) return send(`${summary}\nvault only has ${fmt(vault)} rn so i can't cover this yet`)

  const why = checks.find((c) => !c.ok)!.fail + (p.kind === 'bill' ? ` so i'm not auto-paying.` : '.')
  state.pending.push(pending)
  saveState(state)
  await send(`${summary}\n${why} need ${APPROVALS_NEEDED} of u to say yes (or 👍 this)`)
}

async function vote(state: State, msg: Incoming, send: Send) {
  const rejected = msg.reaction === 'dislike' || (!msg.reaction && REJECT.test(msg.text))
  if (rejected) {
    const p = state.pending.pop()!
    saveState(state)
    return send(`❌ ${msg.from} said no, scrapping ${p.label}`)
  }
  if (!isRoommate(msg.from)) return

  // Newest proposal this person hasn't approved yet.
  const p = [...state.pending].reverse().find((x) => !x.approvals.includes(msg.from))
  if (!p) return send(`${msg.from} u already said yes lol, waiting on someone else`)

  p.approvals.push(msg.from)
  saveState(state)
  const left = APPROVALS_NEEDED - p.approvals.length
  const which = state.pending.length > 1 ? ` for ${p.label}` : ''
  if (left > 0) return send(`✅ ${msg.from}'s in${which} (${p.approvals.length}/${APPROVALS_NEEDED}), need ${left} more`)

  await send(`✅ ${p.approvals.join(' + ')} said yes${which}${p.kind === 'purchase' ? '' : ', co-signing from the vault…'}`)
  return execute(state, p, send)
}

// Purchases: the chat agent hands the shopping to the browser sub-agent (its own process) and keeps
// answering the chat meanwhile. When the trip ends, the vault settles the real order total on the XRPL.
// Purchases: the vault loads the house card on-chain first (co-signed by the approvers), THEN the
// agent shops with that card, then any unspent money goes back to the vault. No approval, no load,
// no shopping.
async function purchase(state: State, p: Pending, send: Send): Promise<void> {
  state.pending = state.pending.filter((x) => x.id !== p.id)
  saveState(state)
  if (activeTrip()) return send(`already out shopping for something, one at a time lol. ask again after`)

  const load = round(p.amount * (1 + TAX_SHIPPING_ALLOWANCE))
  const { vault } = await poolBalances()
  if (load > vault) return send(`vault only has ${fmt(vault)}, can't load ${fmt(load)} onto the house card for this`)
  const card = wallet(await ensurePayee('House Card')).address
  const loadHash = await payFromVault(
    card,
    load,
    `house card load for ${p.item} | budget ${fmt(p.amount)} + tax/shipping room | policy: ${APPROVALS_NEEDED}-of-${ROOMMATES.length} approved by ${p.approvals.join(' + ')}`,
    p.approvals,
  )
  p.loaded = load
  p.loadHash = loadHash
  await send(`🔒 vault loaded ${fmt(load)} onto the house card (${CARDHOLDER}) for the ${p.item}, signed on-chain by ${p.approvals.join(' + ')}\n${txLink(loadHash)}`)

  const started = startTrip(
    { item: p.item!, budget: p.amount, store: p.store, forHouse: ROOMMATES.map((x) => x.name).join(', ') },
    (text, attachments) => void send(text, attachments),
    (r) => exclusive(() => finishTrip(p, r, send)),
  )
  if (!started) return refundCard(p, p.loaded!, 'shopping never started', send)
  await send(`🛒 ok going shopping for a ${p.item} on ${p.store ?? 'amazon'}, budget ${fmt(p.amount)}. watch my screen 👀`)
}

function rememberTrip(p: Pending, r: TripResult) {
  const s = loadState()
  const outcome =
    r.status === 'placed' ? `ordered for ${fmt(r.total)}` : r.status === 'stopped' ? `left at checkout (${fmt(r.total)})` : r.status === 'cancelled' ? 'cancelled' : `not bought: ${r.why}`
  s.trips = [
    ...(s.trips ?? []),
    { item: p.item ?? p.label, picked: r.pick?.title, price: r.pick?.price, link: r.pick?.link, outcome, orderNumber: r.status === 'placed' ? r.orderNumber : undefined, at: new Date().toISOString() },
  ].slice(-10)
  saveState(s)
}

// Sends unspent house-card money back to the vault on-chain.
async function refundCard(p: Pending, amount: number, why: string, send: Send) {
  if (!p.loaded || amount <= 0) return
  const hash = await pay(loadWallets().payees['House Card'], wallet(loadWallets().vault).address, round(amount), `house card refund: ${why} | ${p.item}`)
  await send(`↩️ sent ${fmt(amount)} back from the house card to the vault\n${txLink(hash)}`)
}

async function finishTrip(p: Pending, r: TripResult, send: Send) {
  console.log('[shopping]', r)
  rememberTrip(p, r)
  const link = r.pick ? `\n${r.pick.link}` : ''
  const shots = 'screenshot' in r && r.screenshot ? [r.screenshot] : undefined
  if (r.status === 'cancelled') {
    await send(`🛑 stopped shopping, nothing bought`)
    return refundCard(p, p.loaded ?? 0, 'cancelled', send)
  }
  if (r.status === 'blocked' || r.status === 'failed') {
    await send(`🛒 didn't buy the ${p.item}: ${r.why}. nothing charged${link}`, shots)
    return refundCard(p, p.loaded ?? 0, 'not bought', send)
  }
  if (r.status === 'stopped') {
    await send(`🛒 ${r.item.slice(0, 80)} · ${fmt(r.total)} is sitting at checkout on ${r.site}. rehearsal mode (CHECKOUT=stop) so i didn't place it${link}`, shots)
    return refundCard(p, p.loaded ?? 0, 'rehearsal, not placed', send)
  }

  const total = round(r.total)
  await send(`📦 ordered on the house card! ${r.item.slice(0, 80)} · ${fmt(total)}${r.orderNumber ? ` · order #${r.orderNumber}` : ''} (${r.site})${link}`, shots)

  // Book it: each roommate's share of the real total, recorded against the on-chain card load.
  const state = loadState()
  const { shares } = splitBill('other', total)
  for (const [n, v] of Object.entries(shares)) state.charged[n] = round((state.charged[n] ?? 0) + v)
  state.history.push({ label: `${r.item.slice(0, 40)} ${fmt(total)}`, amount: total, shares, hash: p.loadHash!, signers: p.approvals, at: new Date().toISOString() })
  saveState(state)
  await send(`🧾 split evenly: ${formatShares(shares)}`)
  return refundCard(p, round((p.loaded ?? 0) - total), `unspent after ${r.site} order${r.orderNumber ? ` #${r.orderNumber}` : ''}`, send)
}

async function execute(state: State, p: Pending, send: Send): Promise<void> {
  // Purchases that haven't been bought yet go shopping first; `item` is cleared once the order is placed.
  if (p.kind === 'purchase' && p.item) return purchase(state, p, send)
  const w = loadWallets()
  const to = wallet(w.payees[p.payee]).address
  const multisig = p.approvals.length >= APPROVALS_NEEDED
  const memo = multisig ? `${p.memo} | policy: ${APPROVALS_NEEDED}-of-${ROOMMATES.length} approved by ${p.approvals.join(' + ')}` : p.memo
  const hash = multisig ? await payFromVault(to, p.amount, memo, p.approvals) : await pay(w.allowance, to, p.amount, memo)

  for (const [n, v] of Object.entries(p.shares)) state.charged[n] = round((state.charged[n] ?? 0) + v)
  state.history.push({ label: p.label, amount: p.amount, shares: p.shares, hash, signers: p.approvals, at: new Date().toISOString() })
  state.pending = state.pending.filter((x) => x.id !== p.id)
  saveState(state)

  const how = multisig ? `signed on-chain by ${p.approvals.join(' + ')} (${APPROVALS_NEEDED}-of-${ROOMMATES.length} multisig)` : 'paid from my allowance'
  await send(`💸 paid ${p.payTo} ${fmt(p.amount)}, ${how}\n${txLink(hash)}`)

  // While we have two signatures in hand, refill the allowance so small bills keep auto-paying.
  if (multisig) {
    const { allowance } = await poolBalances()
    if (allowance < APPROVAL_LIMIT) {
      const topup = round(ALLOWANCE_TOPUP - allowance)
      const h = await payFromVault(wallet(w.allowance).address, topup, 'Allowance refill for the CFO agent', p.approvals)
      await send(`🔄 also used those sigs to refill my allowance to ${fmt(ALLOWANCE_TOPUP)}\n${txLink(h)}`)
    }
  }
}

async function deposit(state: State, from: string, amount: number, send: Send) {
  if (!isRoommate(from)) return
  if (!validAmount(amount)) return send(`how much u putting in ${from}`)
  const w = loadWallets()
  const seed = w.roommates[from]
  const has = await rlusdBalance(wallet(seed).address)
  if (has < amount) return send(`${from} ur wallet only has ${fmt(has)} rlusd`)

  const hash = await pay(seed, wallet(w.vault).address, amount, `${from}: pool contribution`)
  state.deposited[from] = round((state.deposited[from] ?? 0) + amount)
  saveState(state)
  const short = round(MONTHLY_CONTRIBUTION - state.deposited[from])
  const status = short > 0 ? `still ${fmt(short)} short this month tho` : `ur all caught up 🙌`
  await send(`🏦 got ${fmt(amount)} from ${from} into the vault, ${status}\n${txLink(hash)}`)
}

async function balances(state: State, send: Send) {
  const { vault, allowance } = await poolBalances()
  const lines = ROOMMATES.map((r) => `${r.name}: put in ${fmt(state.deposited[r.name])}, owes ${fmt(state.charged[r.name])} in bills so far`)
  const behind = ROOMMATES.filter((r) => state.deposited[r.name] < MONTHLY_CONTRIBUTION)
  const nudges = behind.map(
    (r) => `👀 ${r.name} ur ${fmt(MONTHLY_CONTRIBUTION - state.deposited[r.name])} short this month, say "send my share" and i'll pull it from ur wallet`,
  )
  await send(
    `🏦 house has ${fmt(vault + allowance)} rlusd on-chain (vault ${fmt(vault)} + my allowance ${fmt(allowance)})\n` +
      lines.join('\n') +
      (nudges.length ? `\n\n${nudges.join('\n')}` : "\n\neveryone's paid up 🎉"),
  )
}

async function snapshot(state: State) {
  const { vault, allowance } = await poolBalances().catch(() => ({ vault: NaN, allowance: NaN }))
  const people = ROOMMATES.map((r) => {
    const short = MONTHLY_CONTRIBUTION - state.deposited[r.name]
    return `- ${r.name}: deposited ${fmt(state.deposited[r.name])} of ${fmt(MONTHLY_CONTRIBUTION)}${short > 0 ? ` (short ${fmt(short)})` : ''}, share of bills so far ${fmt(state.charged[r.name])}`
  })
  const pending = state.pending.map((p) => `- ${p.label} proposed by ${p.proposedBy}, approved by ${p.approvals.join(', ') || 'nobody yet'}`)
  const history = state.history.slice(-8).map((h) => `- ${h.label} (${formatShares(h.shares)})${h.signers.length ? ` signed by ${h.signers.join(' + ')}` : ' auto-paid'}`)
  return [
    `House snapshot:`,
    `Pool: vault ${fmt(vault)} + allowance ${fmt(allowance)} RLUSD`,
    ...people,
    `Waiting on approval:\n${pending.join('\n') || '- nothing'}`,
    `Paid this month:\n${history.join('\n') || '- nothing yet'}`,
    `Rules:\n${HOUSE_RULES.map((r) => `- ${r}`).join('\n')}`,
    `Shopping right now: ${activeTrip() ? `${activeTrip()!.item} (budget ${fmt(activeTrip()!.budget)}, stage: ${activeTrip()!.stage}${activeTrip()!.pick ? `, picked ${activeTrip()!.pick!.title} $${activeTrip()!.pick!.price} ${activeTrip()!.pick!.link}` : ''})` : 'nothing'}`,
    `Recent shopping trips (share the link when asked):\n${(state.trips ?? []).slice(-6).map((t) => `- asked for "${t.item}": ${t.picked ? `${t.picked}${t.price ? ` $${t.price}` : ''} ${t.link ?? ''}` : 'nothing picked'} → ${t.outcome}${t.orderNumber ? ` (order #${t.orderNumber})` : ''}`).join('\n') || '- none'}`,
    `Earlier in the chat (summary): ${earlier || '(nothing yet)'}`,
    `Recent chat:\n${recent.join('\n') || '(none)'}`,
  ].join('\n')
}

const round = (n: number) => Math.round(n * 100) / 100

// Everything goes out lowercase, except links and XRPL addresses (those are case-sensitive).
function casual(text: string) {
  return text
    .split(/(https?:\/\/\S+|\br[1-9A-HJ-NP-Za-km-z]{24,34}\b)/)
    .map((part, i) => (i % 2 ? part : part.toLowerCase()))
    .join('')
}
