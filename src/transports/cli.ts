import readline from 'node:readline/promises'
import path from 'node:path'
import { ROOMMATES } from '../config.ts'
import { handle, type Incoming } from '../agent.ts'
import { disconnect } from '../ledger.ts'

// Rehearse the demo in a terminal. Type as a roommate:
//   eford: can we get a vacuum? $90 on amazon
//   calvin: /photo demo/bills/metro-fiber.png
//   ryan: 👍
export async function runCli() {
  const names = ROOMMATES.map((r) => r.name.toLowerCase())
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const send = async (text: string, attachments?: string[]) =>
    console.log(`\n\x1b[32m🏦 CFO:\x1b[0m ${text.replace(/\n/g, '\n        ')}${attachments?.length ? `\n        [image] ${attachments.join(', ')}` : ''}\n`)
  console.log(`Group chat sim. Type "<name>: <message>", names: ${names.join(', ')}. "/photo <path>" sends an image. Ctrl+C to quit.\n`)

  for await (const line of rl) {
    const m = line.match(/^\s*(\w+)\s*:\s*(.*)$/)
    if (!m || !names.includes(m[1].toLowerCase())) {
      console.log('  format: alex: hello')
      continue
    }
    const from = ROOMMATES[names.indexOf(m[1].toLowerCase())].name
    const photo = m[2].match(/^\/photo\s+(.+)$/)
    const msg: Incoming = photo ? { from, text: '', imagePath: path.resolve(photo[1].trim()) } : { from, text: m[2] }
    await handle(msg, send)
  }
  // Input ended (Ctrl+D, Ctrl+C, or end of a piped script): every line has been handled by now.
  await disconnect()
  process.exit(0)
}
