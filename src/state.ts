import fs from 'node:fs'
import path from 'node:path'
import type { Payee } from './config.ts'

export type Wallets = {
  issuer?: string
  treasury?: string
  vault: string
  allowance: string
  roommates: Record<string, string>
  payees: Record<string, string>
}

export type Pending = {
  id: string
  kind: 'bill' | 'purchase'
  label: string
  // Account that receives the money, and the name shown in the chat.
  payee: Payee
  payTo: string
  amount: number
  shares: Record<string, number>
  proposedBy: string
  approvals: string[]
  memo: string
  // Purchases: what the shopper should buy, and where.
  item?: string
  store?: string
}

export type LedgerEntry = {
  label: string
  amount: number
  shares: Record<string, number>
  hash: string
  signers: string[]
  at: string
}

export type State = {
  // What each roommate has put into the pool, and what the house has charged them.
  deposited: Record<string, number>
  charged: Record<string, number>
  pending: Pending[]
  history: LedgerEntry[]
}

const ROOT = path.resolve(import.meta.dirname, '..')
const WALLETS_FILE = path.join(ROOT, '.wallets.json')
const STATE_FILE = path.join(ROOT, 'state.json')

export function loadWallets(): Wallets {
  if (!fs.existsSync(WALLETS_FILE)) throw new Error('No .wallets.json yet. Run `npm run setup` first.')
  return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'))
}

export function saveWallets(w: Wallets) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2))
}

export function loadState(): State {
  if (!fs.existsSync(STATE_FILE)) throw new Error('No state.json yet. Run `npm run setup` first.')
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (!Array.isArray(s.pending)) s.pending = s.pending ? [s.pending] : []
  return s as State
}

export function saveState(s: State) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

export function hasState() {
  return fs.existsSync(STATE_FILE)
}
