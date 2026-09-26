import fs from 'node:fs'
import { IMessageSDK, type Message } from '@photon-ai/imessage-kit'
import { GROUP_CHAT_ID, GROUP_CHAT_NAME, ROOMMATES } from '../config.ts'
import { handle, type Incoming } from '../agent.ts'

// Runs on a Mac signed in to Messages as the CFO's Apple ID, which is a member of the house group chat.
// Needs Full Disk Access for the terminal running it (System Settings → Privacy & Security).

const digits = (s: string) => s.replace(/\D/g, '').slice(-10)

// Handles not listed in .env get the next unclaimed roommate name the first time they speak,
// so approvals still count on stage even if the config is incomplete.
const claimed = new Map<string, string>()

function roommateFor(handleId: string | null) {
  if (!handleId) return 'Someone'
  const h = handleId.toLowerCase()
  const configured = ROOMMATES.find((r) => r.handle && (r.handle.toLowerCase() === h || (digits(r.handle) && digits(r.handle) === digits(h))))
  if (configured) return configured.name
  if (claimed.has(h)) return claimed.get(h)!
  const taken = new Set([...claimed.values(), ...ROOMMATES.filter((r) => r.handle).map((r) => r.name)])
  const next = ROOMMATES.find((r) => !taken.has(r.name))
  if (!next) return handleId
  claimed.set(h, next.name)
  console.log(`[imessage] ${handleId} isn't in .env, treating them as ${next.name}`)
  return next.name
}

async function findChat(sdk: IMessageSDK) {
  const groups = await sdk.listChats({ kind: 'group', sortBy: 'recent' })
  if (GROUP_CHAT_ID) return groups.find((g) => g.chatId === GROUP_CHAT_ID || g.chatId.endsWith(GROUP_CHAT_ID)) ?? null
  if (GROUP_CHAT_NAME) {
    // Loose match so emoji, casing, or extra spaces in the chat name don't matter.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const want = norm(GROUP_CHAT_NAME)
    const chat = groups.find((g) => g.name && norm(g.name) === want) ?? groups.find((g) => g.name && norm(g.name).includes(want))
    if (chat) return chat
    console.log(`No group chat named "${GROUP_CHAT_NAME}". Your recent group chats:`)
    for (const g of groups.slice(0, 15)) console.log(`  ${g.name ?? '(unnamed)'}  →  ${g.chatId}`)
    return null
  }
  console.log('Set GROUP_CHAT_NAME or GROUP_CHAT_ID in .env. Your recent group chats:')
  for (const g of groups.slice(0, 15)) console.log(`  ${g.name ?? '(unnamed)'}  →  ${g.chatId}`)
  return null
}

// Photos can land in chat.db a moment before the file finishes downloading.
async function imagePath(sdk: IMessageSDK, msg: Message): Promise<string | undefined> {
  for (let i = 0; i < 20; i++) {
    const current =
      i === 0 ? msg : (await sdk.getMessages({ chatId: msg.chatId!, since: new Date(msg.createdAt.getTime() - 1000), limit: 20 })).find((m) => m.id === msg.id)
    const att = current?.attachments.find((a) => a.mimeType.startsWith('image/') || a.mimeType === 'application/pdf')
    if (att?.localPath && fs.existsSync(att.localPath)) return att.localPath
    if (current && !current.hasAttachments) return undefined
    await new Promise((r) => setTimeout(r, 750))
  }
  return undefined
}

export async function runIMessage() {
  const sdk = new IMessageSDK()
  const chat = await findChat(sdk)
  if (!chat) process.exit(1)
  console.log(`🏦 CFO is listening in "${chat.name ?? chat.chatId}"`)

  const send = async (text: string, attachments?: string[]) => {
    await sdk.send({ to: chat.chatId, text })
    if (attachments?.length) await sdk.send({ to: chat.chatId, attachments })
  }

  await sdk.startWatching({
    onGroupMessage: async (msg) => {
      if (msg.chatId !== chat.chatId || msg.kind !== 'text') return
      const from = roommateFor(msg.participant)

      let incoming: Incoming
      if (msg.reaction) {
        if (msg.reaction.isRemoved) return
        const k = msg.reaction.kind
        const like = k === 'like' || k === 'love' || (k === 'emoji' && msg.reaction.emoji === '👍')
        const dislike = k === 'dislike' || (k === 'emoji' && msg.reaction.emoji === '👎')
        if (!like && !dislike) return
        incoming = { from, text: '', reaction: like ? 'like' : 'dislike' }
      } else {
        const img = msg.hasAttachments ? await imagePath(sdk, msg) : undefined
        if (!msg.text?.trim() && !img) return
        incoming = { from, text: (msg.text ?? '').replace(/￼/g, '').trim(), imagePath: img }
      }
      await handle(incoming, send)
    },
    onError: (e) => console.error('[imessage]', e),
  })

  const stop = async () => {
    await sdk.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
