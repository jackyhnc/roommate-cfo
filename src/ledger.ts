import { Client, Wallet, multisign, convertStringToHex, type Payment, type SubmittableTransaction } from 'xrpl'
import { XRPL_URL, EXPLORER, RLUSD_MODE, RIPPLE_RLUSD_ISSUER, RLUSD_CURRENCY } from './config.ts'
import { loadWallets, type Wallets } from './state.ts'

let client: Client | null = null

export async function xrpl() {
  if (client?.isConnected()) return client
  client = new Client(XRPL_URL)
  await client.connect()
  return client
}

export async function disconnect() {
  if (client?.isConnected()) await client.disconnect()
}

export const txLink = (hash: string) => `${EXPLORER}/transactions/${hash}`
export const accountLink = (address: string) => `${EXPLORER}/accounts/${address}`

export function rlusdIssuer(w: Wallets) {
  if (RLUSD_MODE === 'ripple') return RIPPLE_RLUSD_ISSUER
  return Wallet.fromSeed(w.issuer!).address
}

export function rlusd(w: Wallets, value: number) {
  return { currency: RLUSD_CURRENCY, issuer: rlusdIssuer(w), value: value.toFixed(2) }
}

export const wallet = (seed: string) => Wallet.fromSeed(seed)

function memos(text: string) {
  return [{ Memo: { MemoType: convertStringToHex('text/plain'), MemoData: convertStringToHex(text) } }]
}

async function submit(tx: SubmittableTransaction, signer: Wallet) {
  const c = await xrpl()
  const res = await c.submitAndWait(tx, { autofill: true, wallet: signer })
  return assertSuccess(res)
}

function assertSuccess(res: any) {
  const code = res.result.meta?.TransactionResult
  if (code !== 'tesSUCCESS') throw new Error(`XRPL tx failed: ${code}`)
  return res.result.hash as string
}

export async function pay(fromSeed: string, to: string, amount: number, memo: string) {
  const w = loadWallets()
  const from = wallet(fromSeed)
  const tx: Payment = {
    TransactionType: 'Payment',
    Account: from.address,
    Destination: to,
    Amount: rlusd(w, amount),
    Memos: memos(memo),
  }
  return submit(tx, from)
}

// Vault payments: the vault's master key is disabled, so the only way out is
// 2 roommates co-signing through its on-ledger SignerList.
export async function payFromVault(to: string, amount: number, memo: string, signerNames: string[]) {
  const w = loadWallets()
  const c = await xrpl()
  const vault = wallet(w.vault).address
  const tx = await c.autofill(
    {
      TransactionType: 'Payment',
      Account: vault,
      Destination: to,
      Amount: rlusd(w, amount),
      Memos: memos(memo),
    } as Payment,
    signerNames.length,
  )
  const blobs = signerNames.map((n) => wallet(w.roommates[n]).sign(tx, true).tx_blob)
  const res = await c.submitAndWait(multisign(blobs))
  return assertSuccess(res)
}

export async function rlusdBalance(address: string) {
  const w = loadWallets()
  const c = await xrpl()
  const res = await c.request({ command: 'account_lines', account: address, peer: rlusdIssuer(w) })
  const line = res.result.lines.find((l) => l.currency === RLUSD_CURRENCY)
  return line ? Number(line.balance) : 0
}

export async function poolBalances() {
  const w = loadWallets()
  const [vault, allowance] = await Promise.all([
    rlusdBalance(wallet(w.vault).address),
    rlusdBalance(wallet(w.allowance).address),
  ])
  return { vault, allowance }
}
