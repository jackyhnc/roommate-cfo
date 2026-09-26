import 'dotenv/config'

// Everything here is hardcoded for the demo: the house, its rules, and who pays whom.

export type Roommate = {
  name: string
  // iMessage handle (phone or email) so we can tell who is talking in the group chat.
  handle: string
  // How much they actually put into the pool this month (Ryan is short).
  deposited: number
}

export const MONTHLY_CONTRIBUTION = 300
export const APPROVAL_LIMIT = 100
export const APPROVALS_NEEDED = 2
export const ALLOWANCE_TOPUP = 150

export const ROOMMATES: Roommate[] = [
  { name: 'Calvin', handle: process.env.CALVIN_HANDLE ?? '', deposited: 300 },
  { name: 'Eford', handle: process.env.EFORD_HANDLE ?? '', deposited: 300 },
  { name: 'Ryan', handle: process.env.RYAN_HANDLE ?? '', deposited: 255 },
]

export type Category = 'internet' | 'electricity' | 'other'

// House facts the agent knows about this month. These drive the uneven splits.
export const DAYS_IN_MONTH = 30
export const DAYS_AWAY: Record<string, number> = { Ryan: 10 }
export const SPACE_HEATER = { who: 'Eford', share: 0.4 }

export const HOUSE_RULES = [
  'Internet is split by days each person was home this month.',
  'Electricity is split equally, except whoever runs the space heater pays 40%.',
  'Anything else (water, shared purchases) is split equally.',
  `Anything up to $${APPROVAL_LIMIT} is paid automatically. Over $${APPROVAL_LIMIT} needs ${APPROVALS_NEEDED} roommates to approve.`,
]

// Payee accounts created by `npm run setup`, keyed by the name the agent uses.
// "Unverified Payee" stands in for any biller the house has never paid before.
export const PAYEES = ['Metro Fiber', 'Bay Power & Light', 'Store', 'Unverified Payee'] as const
export type Payee = (typeof PAYEES)[number]

// Compliance allowlist: the only billers the agent may pay on its own.
// Anything else (a fake or phishing bill, a new vendor) always needs a vote.
export const KNOWN_BILLERS: { payee: Payee; match: RegExp }[] = [
  { payee: 'Metro Fiber', match: /metro\s*fiber/i },
  { payee: 'Bay Power & Light', match: /bay\s*power/i },
]

export const XRPL_URL = 'wss://s.altnet.rippletest.net:51233'
export const EXPLORER = 'https://testnet.xrpl.org'

// "ripple" = Ripple's real testnet RLUSD (fund the treasury from tryrlusd.com).
// "mock"   = our own issuer minting a token with the RLUSD currency code.
export const RLUSD_MODE = (process.env.RLUSD_MODE ?? 'mock') as 'ripple' | 'mock'
export const RIPPLE_RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De'
// 40-char hex of "RLUSD", the currency code RLUSD uses on-ledger.
export const RLUSD_CURRENCY = '524C555344000000000000000000000000000000'

export const XAI_MODEL = process.env.XAI_MODEL ?? 'grok-4.7'

export const GROUP_CHAT_NAME = process.env.GROUP_CHAT_NAME ?? ''
export const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID ?? ''
