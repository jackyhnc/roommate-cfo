import 'dotenv/config'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import OpenAI from 'openai'

// Grok Imagine. Takes ~15s, so callers post a status message first.
const MODEL = process.env.XAI_IMAGE_MODEL ?? 'grok-imagine-image-2.0'
const grok = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1', timeout: 120_000 })

// Saves into ~/Pictures, one of the folders Messages is allowed to attach from.
export async function generateImage(prompt: string) {
  const res = await grok.images.generate({ model: MODEL, prompt, n: 1, response_format: 'b64_json' } as OpenAI.Images.ImageGenerateParamsNonStreaming)
  const b64 = res.data?.[0]?.b64_json
  if (!b64) throw new Error('grok returned no image')
  const bytes = Buffer.from(b64, 'base64')
  const ext = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : bytes[0] === 0x52 && bytes[8] === 0x57 ? 'webp' : 'jpg'
  const dir = path.join(os.homedir(), 'Pictures', 'roommate-cfo')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `grok-${Date.now()}.${ext}`)
  fs.writeFileSync(file, bytes)
  return file
}
