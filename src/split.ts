import { ROOMMATES, DAYS_IN_MONTH, DAYS_AWAY, SPACE_HEATER, type Category } from './config.ts'

export type Split = { shares: Record<string, number>; reasoning: string }

const names = () => ROOMMATES.map((r) => r.name)

// Rounds to cents and pushes any leftover cent onto the first person so shares sum exactly.
function toCents(amount: number, weights: Record<string, number>) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0)
  const shares: Record<string, number> = {}
  let assigned = 0
  for (const [n, w] of Object.entries(weights)) {
    shares[n] = Math.round((amount * w * 100) / total) / 100
    assigned += shares[n]
  }
  const first = Object.keys(shares)[0]
  shares[first] = Math.round((shares[first] + amount - assigned) * 100) / 100
  return shares
}

export function splitBill(category: Category, amount: number): Split {
  if (category === 'internet') {
    const weights = Object.fromEntries(names().map((n) => [n, DAYS_IN_MONTH - (DAYS_AWAY[n] ?? 0)]))
    const away = Object.entries(DAYS_AWAY)
      .map(([n, d]) => `${n} was away ${d} days`)
      .join(', ')
    return { shares: toCents(amount, weights), reasoning: `split by days home, ${away} so they pay less` }
  }
  if (category === 'electricity') {
    const others = names().filter((n) => n !== SPACE_HEATER.who)
    const weights: Record<string, number> = { [SPACE_HEATER.who]: SPACE_HEATER.share }
    for (const n of others) weights[n] = (1 - SPACE_HEATER.share) / others.length
    return {
      shares: toCents(amount, weights),
      reasoning: `${SPACE_HEATER.who} runs the space heater so they pay ${SPACE_HEATER.share * 100}%, rest split evenly`,
    }
  }
  return { shares: toCents(amount, Object.fromEntries(names().map((n) => [n, 1]))), reasoning: 'split evenly' }
}

export const fmt = (n: number) => `$${n.toFixed(2)}`

export function formatShares(shares: Record<string, number>) {
  return Object.entries(shares)
    .map(([n, v]) => `${n} ${fmt(v)}`)
    .join(' · ')
}
