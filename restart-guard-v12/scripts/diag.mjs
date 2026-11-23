/**
 * Diagnostic: where does the surface price actually go?
 * Compares the full heuristic price with variants that drop block kinds the
 * provider may not be charged for.
 *
 * Usage: node diag.mjs <session.v4.jsonl>
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const logPath = process.argv[2]
const estimateUrl = pathToFileURL(
  'D:/DSH-Env/documents/deepseek-harness/default-workspace/downloads/pkgs/dsh-token-meter-0.2.3-alpha.2/package/lib/types/estimate.js',
)
const { estimateMessage } = await import(estimateUrl.href)

const events = new Map()
const surface = []
let lastUsage = null
let lastAssistantSeq = -1

const rl = createInterface({ input: createReadStream(logPath, 'utf8'), crlfDelay: Infinity })
for await (const line of rl) {
  if (line.trim().length === 0) continue
  const event = JSON.parse(line)
  if (event.type === 'session') continue
  events.set(event.seq, event)
  const op = event.surfaceOp
  if (op === 'append') surface.push(event.seq)
  else if (op && typeof op === 'object') {
    const s = surface.indexOf(op.startSeq)
    const e = surface.indexOf(op.endSeq)
    if (s !== -1 && e !== -1) surface.splice(s, e - s + 1, event.seq)
  }
  if (event.type === 'assistant/message' && event.data?.usage) {
    lastUsage = event.data.usage
    lastAssistantSeq = event.seq
  }
}

function messageOf(event) {
  const data = event?.data ?? {}
  if (data.message !== undefined) return data.message
  if (Array.isArray(data.content)) return { role: data.role ?? 'user', content: data.content }
  return null
}

const byType = new Map()
let all = 0
let withoutReasoning = 0
let reasoningOnly = 0

for (const seq of surface) {
  const event = events.get(seq)
  const message = messageOf(event)
  if (message === null) continue
  const price = estimateMessage(message)
  all += price
  byType.set(event.type, (byType.get(event.type) ?? 0) + price)
  const stripped = { ...message, content: (message.content ?? []).filter((b) => b.type !== 'reasoning') }
  const priceNoReasoning = estimateMessage(stripped)
  withoutReasoning += priceNoReasoning
  reasoningOnly += price - priceNoReasoning
}

console.log('surface nodes:', surface.length)
console.log('total (as logged)      :', all)
console.log('without reasoning      :', withoutReasoning)
console.log('reasoning share        :', reasoningOnly, `(${((reasoningOnly / all) * 100).toFixed(1)}%)`)
console.log('\nprice by event type:')
for (const [type, price] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(String(price).padStart(9), type)
}

// Anchor check: price the surface up to the last assistant message and compare
// with what the provider actually reported for that request.
const anchorIdx = surface.indexOf(lastAssistantSeq)
let upToAssistant = 0
for (let i = 0; i <= anchorIdx; i += 1) {
  const message = messageOf(events.get(surface[i]))
  if (message !== null) upToAssistant += estimateMessage(message)
}
console.log('\nlast reported usage:', JSON.stringify(lastUsage))
console.log('usage prompt (input+cacheRead):', (lastUsage?.inputTokens ?? 0) + (lastUsage?.cacheReadTokens ?? 0))
console.log('heuristic price up to that assistant message:', upToAssistant)
