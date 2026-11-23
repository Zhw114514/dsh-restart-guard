/**
 * Calibration probe: for the last N assistant messages that carry provider
 * usage, compare the heuristic price of the surface up to that point with the
 * prompt size the provider actually reported.
 *
 * Usage: node calibrate.mjs <session.v4.jsonl> [samples]
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const [logPath, samplesArg] = process.argv.slice(2)
const samples = Number(samplesArg ?? 8)
const estimateUrl = pathToFileURL(
  'D:/DSH-Env/documents/deepseek-harness/default-workspace/downloads/pkgs/dsh-token-meter-0.2.3-alpha.2/package/lib/types/estimate.js',
)
const { estimateMessage, estimateToolsTokens } = await import(estimateUrl.href)

const events = new Map()
const surface = []
const anchors = []
let lastHeader = null

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
  if (event.type === 'request/header' && event.data?.header) lastHeader = event.data.header
  if (event.type === 'assistant/message' && event.data?.usage) {
    anchors.push({ seq: event.seq, usage: event.data.usage, surfaceIndex: surface.length - 1 })
  }
}

function messageOf(event) {
  const data = event?.data ?? {}
  if (data.message !== undefined) return data.message
  if (Array.isArray(data.content)) return { role: data.role ?? 'user', content: data.content }
  return null
}

const tools = estimateToolsTokens(lastHeader)
console.log('tools price:', tools, '| header tools:', lastHeader?.tools?.length)
console.log('sample | assistant seq | heuristic (incl tools) | provider prompt | ratio')
for (const anchor of anchors.slice(-samples)) {
  const idx = surface.indexOf(anchor.seq)
  let price = tools
  for (let i = 0; i <= idx; i += 1) {
    const message = messageOf(events.get(surface[i]))
    if (message !== null) price += estimateMessage(message)
  }
  const prompt = (anchor.usage.inputTokens ?? 0) + (anchor.usage.cacheReadTokens ?? 0)
  console.log(
    `seq ${anchor.seq}`.padEnd(12),
    String(price).padStart(9),
    String(prompt).padStart(9),
    (price / prompt).toFixed(2),
  )
}
