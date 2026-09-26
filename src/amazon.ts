import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// MCP client for our vendored Amazon server (amazon-mcp/, built with `npm run amazon-build`).
// It uses the cookies saved by `npm run amazon-login`.

const SERVER = path.resolve(import.meta.dirname, '..', 'amazon-mcp', 'build', 'index.js')
const COOKIES = process.env.AMAZON_COOKIES_FILE ?? path.resolve(import.meta.dirname, '..', 'amazon-mcp', 'amazonCookies.json')

let client: Client | null = null

// Lets a shopping trip react to what the Amazon server is doing mid-call (e.g. a bank verification prompt).
const stepListeners = new Set<(line: string) => void>()
export function onAmazonStep(fn: (line: string) => void) {
  stepListeners.add(fn)
  return () => stepListeners.delete(fn)
}

export async function amazon() {
  if (client) return client
  if (!fs.existsSync(SERVER)) throw new Error('amazon tools not built, run `npm run amazon-build`')
  if (!fs.existsSync(COOKIES)) throw new Error('not logged in to amazon, run `npm run amazon-login`')
  const c = new Client({ name: 'roommate-cfo', version: '1.0.0' })
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...(process.env as Record<string, string>) },
      stderr: 'pipe',
    }),
  )
  const t = (c as any)._transport as StdioClientTransport
  t.stderr?.on('data', (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) {
      if (!/\[(STEP|ERROR)\]/.test(line)) continue
      console.log(`\x1b[35m  amazon │ ${line.trim()}\x1b[0m`)
      for (const l of stepListeners) l(line)
    }
  })
  client = c
  return c
}

export async function listTools() {
  return (await (await amazon()).listTools()).tools
}

// Calls a tool and returns only its text parts (images come back as base64 and would flood Grok's context).
export async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await (await amazon()).callTool({ name, arguments: args }, undefined, { timeout: 240_000 })
  const text = (res.content as { type: string; text?: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
  return { text, isError: !!res.isError }
}

// Start the Amazon server and its Chrome at boot, so the first shopping trip doesn't pay for it.
export function warmup() {
  callTool('get-cart-content').catch(() => {})
}
