import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import OpenAI from 'openai'
import { XAI_MODEL, HOUSE_RULES, ROOMMATES, type Category } from './config.ts'

export type Intent =
  | { type: 'bill'; biller: string; category: Category; amount: number; due: string }
  | { type: 'purchase'; item: string; amount: number; store?: string }
  | { type: 'balances' }
  | { type: 'deposit'; amount: number }
  | { type: 'cancel' }
  | { type: 'reply'; text: string }
  | { type: 'ignore' }

const grok = process.env.XAI_API_KEY
  ? new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1', timeout: 60_000 })
  : null

const SYSTEM = `You are "CFO", the AI agent that runs the shared household account for ${ROOMMATES.length} roommates (${ROOMMATES.map((r) => r.name).join(', ')}) in their iMessage group chat. The house pool holds RLUSD on the XRP Ledger.

House rules:
${HOUSE_RULES.map((r) => `- ${r}`).join('\n')}

For each message, call exactly one tool:
- A photo or PDF of a bill -> record_bill. Read the biller (exactly as printed), total amount due, and due date off the bill. Scam or phishing-looking bills still go to record_bill; the agent's guardrails decide what to do with them. Category is "internet" for internet/wifi/cable, "electricity" for power/electric/gas & electric, otherwise "other".
- Someone suggesting the house buy something -> propose_purchase. The amount is the budget (their price, or a sensible budget if they only say "like $90"). If they name a store or site, pass it as store.
- Anyone asking who owes what, who's behind, or the pool balance -> show_balances.
- A roommate saying they want to pay in / top up / send their share to the pool -> deposit, with the amount (if they say "my share" or "what I owe", use the amount they're short from the house snapshot).
- Someone correcting or dropping a proposal that is still waiting on approval ("nvm", "cancel that", "actually it's $85") -> cancel. If they gave a corrected amount, the new proposal will come in a later message, so just cancel.
- Anything else addressed to you (mentions "CFO", asks about bills, spending, history, rules, who paid what) -> reply, using the house snapshot below. Text like a chill roommate: all lowercase, super casual, short (one or two lines), light slang is fine (lol, rn, u, ngl), no markdown, no made-up numbers.
- A photo that is not a bill -> reply briefly (same casual lowercase voice) saying you only handle bills and receipts.
- Normal roommate chatter not meant for you -> ignore.

You never do the split math yourself. The tools do it.`

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'record_bill',
      description: 'Record a bill read from an image so it can be split and paid.',
      parameters: {
        type: 'object',
        properties: {
          biller: { type: 'string', description: 'Company name on the bill' },
          category: { type: 'string', enum: ['internet', 'electricity', 'other'] },
          amount: { type: 'number', description: 'Total amount due in USD' },
          due: { type: 'string', description: 'Due date as written, e.g. "Oct 5"' },
        },
        required: ['biller', 'category', 'amount', 'due'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_purchase',
      description: 'A roommate wants the house pool to buy something.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'What to buy, with any details they gave, e.g. "cordless stick vacuum"' },
          store: { type: 'string', description: 'Store or website if they named one, e.g. "amazon", "target.com"' },
          amount: { type: 'number', description: 'Price in USD' },
        },
        required: ['item', 'amount'],
      },
    },
  },
  { type: 'function', function: { name: 'show_balances', description: 'Show pool balance and who is behind.', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'deposit',
      description: 'Move money from the sender’s own wallet into the house vault.',
      parameters: { type: 'object', properties: { amount: { type: 'number', description: 'USD amount' } }, required: ['amount'] },
    },
  },
  { type: 'function', function: { name: 'cancel', description: 'Drop the most recent proposal still waiting on approval.', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'reply',
      description: 'Say something in the group chat.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
  { type: 'function', function: { name: 'ignore', description: 'Not meant for the CFO.', parameters: { type: 'object', properties: {} } } },
]

// iPhone photos arrive as HEIC. Grok wants JPEG/PNG, so convert (and shrink) with macOS `sips`.
function toDataUri(file: string) {
  const ext = path.extname(file).toLowerCase()
  let src = file
  if (!['.jpg', '.jpeg', '.png'].includes(ext) || fs.statSync(file).size > 4_000_000) {
    src = path.join(os.tmpdir(), `cfo-${Date.now()}.jpg`)
    execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1600', file, '--out', src], { stdio: 'ignore' })
  }
  const mime = src.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${fs.readFileSync(src).toString('base64')}`
}

// `context` is a snapshot of the house (balances, pending approvals, history) plus the recent chat,
// so Grok can answer questions and follow-ups instead of seeing each message in isolation.
export async function understand(from: string, text: string, imagePath: string | undefined, context: string): Promise<Intent> {
  if (!grok) return fallback(text, imagePath)
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: `${from}: ${text || '(sent a photo)'}` }]
  if (imagePath) content.push({ type: 'image_url', image_url: { url: toDataUri(imagePath), detail: 'high' } })

  try {
    const res = await grok.chat.completions.create({
      model: XAI_MODEL,
      messages: [
        { role: 'system', content: `${SYSTEM}\n\n${context}` },
        { role: 'user', content },
      ],
      tools,
      tool_choice: 'required',
    })
    const call = res.choices[0].message.tool_calls?.[0]
    if (!call || call.type !== 'function') return { type: 'ignore' }
    const args = JSON.parse(call.function.arguments || '{}')
    switch (call.function.name) {
      case 'record_bill':
        return { type: 'bill', biller: args.biller, category: args.category, amount: Number(args.amount), due: args.due }
      case 'propose_purchase':
        return { type: 'purchase', item: args.item, amount: Number(args.amount), store: args.store || undefined }
      case 'show_balances':
        return { type: 'balances' }
      case 'deposit':
        return { type: 'deposit', amount: Number(args.amount) }
      case 'cancel':
        return { type: 'cancel' }
      case 'reply':
        return { type: 'reply', text: args.text }
      default:
        return { type: 'ignore' }
    }
  } catch (e) {
    console.error('[grok] falling back:', (e as Error).message)
    return fallback(text, imagePath)
  }
}

// Compaction for the chat memory: fold old lines into a short running summary.
export async function summarize(prior: string, lines: string[]): Promise<string> {
  if (!grok) return `${prior}\n${lines.join('\n')}`.slice(-2000)
  const res = await grok.chat.completions.create({
    model: XAI_MODEL,
    messages: [
      {
        role: 'system',
        content: 'Update a running summary of a roommate group chat with a house finance agent (CFO). Keep who asked for what, amounts, decisions, and anything still open. Max 120 words, plain text.',
      },
      { role: 'user', content: `Summary so far:\n${prior || '(empty)'}\n\nNew lines:\n${lines.join('\n')}` },
    ],
  })
  return res.choices[0].message.content?.trim() || prior
}

// Keeps the demo alive with no API key or no wifi: the demo bills in order, plus simple text rules.
const DEMO_BILLS: Intent[] = [
  { type: 'bill', biller: 'Metro Fiber', category: 'internet', amount: 60, due: 'Oct 5' },
  { type: 'bill', biller: 'Bay Power & Light', category: 'electricity', amount: 184, due: 'Oct 12' },
  { type: 'bill', biller: 'QuickPay Utilities', category: 'electricity', amount: 85, due: 'within 24 hours' },
]
let demoBill = 0

function fallback(text: string, imagePath?: string): Intent {
  if (imagePath) return DEMO_BILLS[demoBill++ % DEMO_BILLS.length]
  const price = text.match(/\$\s?(\d+(?:\.\d{1,2})?)/)
  if (price && /\b(get|buy|order|grab|purchase)\b/i.test(text)) {
    const item = text.match(/\b(?:get|buy|order|grab|purchase)\s+(?:us\s+)?(?:a|an|some|the)?\s*([a-z][a-z -]*?)(?:\?|,|\.|\s+for|\s+on|\s+\$|$)/i)?.[1] ?? 'that'
    return { type: 'purchase', item: item.trim(), amount: Number(price[1]) }
  }
  if (/\b(nvm|never ?mind|cancel|scratch that)\b/i.test(text)) return { type: 'cancel' }
  if (price && /\b(send|deposit|top ?up|pay in|put in)\b/i.test(text)) return { type: 'deposit', amount: Number(price[1]) }
  if (/behind|balance|owe|who.?s short|pool/i.test(text)) return { type: 'balances' }
  if (/\bcfo\b/i.test(text)) return { type: 'reply', text: "yo i'm here, drop a bill in the chat and i'll split it + pay it" }
  return { type: 'ignore' }
}
