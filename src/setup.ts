// One-time testnet setup. Creates every account, funds the pool, locks the vault
// behind a 2-of-4 SignerList, and tops up the agent's allowance.
//
//   npm run setup            resume where it left off
//   npm run setup -- --fresh start over with brand new accounts
import fs from 'node:fs'
import { Wallet, AccountSetAsfFlags, type TrustSet, type SignerListSet, type AccountSet } from 'xrpl'
import {
  ROOMMATES,
  PAYEES,
  RLUSD_MODE,
  RLUSD_CURRENCY,
  ALLOWANCE_TOPUP,
  APPROVALS_NEEDED,
  MONTHLY_CONTRIBUTION,
} from './config.ts'
import { xrpl, disconnect, pay, payFromVault, wallet, rlusdIssuer, rlusdBalance, accountLink, txLink } from './ledger.ts'
import { saveWallets, loadWallets, saveState, hasState, type Wallets } from './state.ts'

const log = (...a: unknown[]) => console.log('•', ...a)

async function fund(): Promise<Wallet> {
  const c = await xrpl()
  for (let attempt = 1; ; attempt++) {
    try {
      return (await c.fundWallet()).wallet
    } catch (e) {
      if (attempt >= 4) throw e
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
}

async function submit(tx: any, seed: string) {
  const c = await xrpl()
  const res = await c.submitAndWait(tx, { autofill: true, wallet: wallet(seed) })
  const code = (res.result.meta as any)?.TransactionResult
  if (code !== 'tesSUCCESS') throw new Error(`${tx.TransactionType} failed: ${code}`)
  return res.result.hash
}

async function createAccounts(): Promise<Wallets> {
  const names = [
    ...(RLUSD_MODE === 'mock' ? ['issuer'] : ['treasury']),
    'vault',
    'allowance',
    ...ROOMMATES.map((r) => `roommate:${r.name}`),
    ...PAYEES.map((p) => `payee:${p}`),
  ]
  const seeds: Record<string, string> = {}
  for (const n of names) {
    const w = await fund()
    seeds[n] = w.seed!
    log(`funded ${n.padEnd(24)} ${w.address}`)
  }
  const w: Wallets = {
    issuer: seeds.issuer,
    treasury: seeds.treasury,
    vault: seeds.vault,
    allowance: seeds.allowance,
    roommates: Object.fromEntries(ROOMMATES.map((r) => [r.name, seeds[`roommate:${r.name}`]])),
    payees: Object.fromEntries(PAYEES.map((p) => [p, seeds[`payee:${p}`]])),
  }
  saveWallets(w)

  if (w.issuer) {
    await submit({ TransactionType: 'AccountSet', Account: wallet(w.issuer).address, SetFlag: AccountSetAsfFlags.asfDefaultRipple } as AccountSet, w.issuer)
    log('issuer: DefaultRipple on')
  }

  const holders = [w.treasury, w.vault, w.allowance, ...Object.values(w.roommates), ...Object.values(w.payees)].filter(Boolean) as string[]
  await Promise.all(
    holders.map((seed) =>
      submit(
        {
          TransactionType: 'TrustSet',
          Account: wallet(seed).address,
          LimitAmount: { currency: RLUSD_CURRENCY, issuer: rlusdIssuer(w), value: '1000000' },
        } as TrustSet,
        seed,
      ),
    ),
  )
  log(`RLUSD trustlines set on ${holders.length} accounts`)
  return w
}

async function fundRoommates(w: Wallets) {
  const total = ROOMMATES.length * MONTHLY_CONTRIBUTION
  if (RLUSD_MODE === 'mock') {
    for (const r of ROOMMATES) {
      await pay(w.issuer!, wallet(w.roommates[r.name]).address, MONTHLY_CONTRIBUTION, 'Test RLUSD')
    }
    log(`minted ${MONTHLY_CONTRIBUTION} RLUSD to each roommate`)
    return true
  }
  const treasury = wallet(w.treasury!).address
  const have = await rlusdBalance(treasury)
  if (have < total) {
    console.log(`\nTreasury holds ${have} RLUSD, needs ${total}.`)
    console.log(`Get testnet RLUSD from https://tryrlusd.com and send it to:\n\n  ${treasury}\n`)
    console.log('Then run `npm run setup` again.')
    return false
  }
  for (const r of ROOMMATES) {
    await pay(w.treasury!, wallet(w.roommates[r.name]).address, MONTHLY_CONTRIBUTION, 'Test RLUSD')
  }
  log(`sent ${MONTHLY_CONTRIBUTION} RLUSD to each roommate from the treasury`)
  return true
}

async function buildPool(w: Wallets) {
  const vault = wallet(w.vault).address

  for (const r of ROOMMATES) {
    const hash = await pay(w.roommates[r.name], vault, r.deposited, `${r.name}: October pool contribution`)
    log(`${r.name} deposited ${r.deposited} RLUSD  ${txLink(hash)}`)
  }

  await submit(
    {
      TransactionType: 'SignerListSet',
      Account: vault,
      SignerQuorum: APPROVALS_NEEDED,
      SignerEntries: ROOMMATES.map((r) => ({ SignerEntry: { Account: wallet(w.roommates[r.name]).address, SignerWeight: 1 } })),
    } as SignerListSet,
    w.vault,
  )
  log(`vault SignerList: ${APPROVALS_NEEDED} of ${ROOMMATES.length} roommates`)

  await submit({ TransactionType: 'AccountSet', Account: vault, SetFlag: AccountSetAsfFlags.asfDisableMaster } as AccountSet, w.vault)
  log('vault master key disabled (only roommate multisig can move funds now)')

  const signers = ROOMMATES.slice(0, APPROVALS_NEEDED).map((r) => r.name)
  const hash = await payFromVault(wallet(w.allowance).address, ALLOWANCE_TOPUP, 'Monthly allowance for the CFO agent', signers)
  log(`allowance topped up with ${ALLOWANCE_TOPUP} RLUSD (signed by ${signers.join(' + ')})  ${txLink(hash)}`)

  saveState({
    deposited: Object.fromEntries(ROOMMATES.map((r) => [r.name, r.deposited])),
    charged: Object.fromEntries(ROOMMATES.map((r) => [r.name, 0])),
    pending: [],
    history: [],
  })

  console.log(`\nVault:     ${accountLink(vault)}`)
  console.log(`Allowance: ${accountLink(wallet(w.allowance).address)}`)
}

async function main() {
  if (process.argv.includes('--fresh')) {
    for (const f of ['.wallets.json', 'state.json']) fs.rmSync(f, { force: true })
  }
  console.log(`RLUSD mode: ${RLUSD_MODE}\n`)
  const w = fs.existsSync('.wallets.json') ? loadWallets() : await createAccounts()
  if (hasState()) {
    console.log('Already set up. Use --fresh to start over.')
  } else if (await fundRoommates(w)) {
    await buildPool(w)
    console.log('\nSetup complete.')
  }
  await disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await disconnect()
  process.exit(1)
})
