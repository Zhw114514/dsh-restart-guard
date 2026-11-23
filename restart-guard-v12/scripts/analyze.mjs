/**
 * Read-only replay of one session log through the restart guard's arithmetic.
 * Folds the surface exactly like the session does (append / replace), prices
 * every node with the token meter's own estimate module, then reports what the
 * guard would do. No model call, no write.
 *
 * Usage: node analyze.mjs <session.v4.jsonl> [window] [reserved]
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { balanceAfter, computeWall, planChunk, toolsPrice } from '../lib/planner.js'

const [logPath, windowArg, reservedArg] = process.argv.slice(2)
if (!logPath) throw new Error('usage: node analyze.mjs <session.v4.jsonl> [window] [reserved]')

const estimateUrl = pathToFileURL(
  'D:/DSH-Env/documents/deepseek-harness/default-workspace/downloads/pkgs/dsh-token-meter-0.2.3-alpha.2/package/lib/types/estimate.js',
)
const { estimateMessage } = await import(estimateUrl.href)

const events = new Map()
const surface = [] // seqs, model-visible order
let header = null
let lastRequestHeader = null
let lastUsage = null
let compactionSummarySamples = []
let compactionCount = 0
let maxSeq = -1

const rl = createInterface({ input: createReadStream(logPath, 'utf8'), crlfDelay: Infinity })
for await (const line of rl) {
  if (line.trim().length === 0) continue
  const event = JSON.parse(line)
  if (event.type === 'session') { header = event; continue }
  events.set(event.seq, event)
  if (event.seq > maxSeq) maxSeq = event.seq

  const op = event.surfaceOp
  if (op === 'append') surface.push(event.seq)
  else if (op !== undefined && op !== null && typeof op === 'object') {
    const startIdx = surface.indexOf(op.startSeq)
    const endIdx = surface.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1) throw new Error(`replace ${event.seq}: range ${op.startSeq}-${op.endSeq} not on surface`)
    surface.splice(startIdx, endIdx - startIdx + 1, event.seq)
  }

  if (event.type === 'request/header') lastRequestHeader = event
  if (event.type === 'assistant/message' && event.data?.usage) lastUsage = event.data.usage
  if (event.type === 'compaction/summary') {
    compactionCount += 1
    compactionSummarySamples.push({ seq: event.seq, shadowed: event.data?.shadowedTokenCount, provider: event.data?.provider, model: event.data?.model })
  }
}

function messageOf(event) {
  const data = event?.data ?? {}
  if (data.message !== undefined) return data.message
  if (Array.isArray(data.content)) return { role: data.role ?? 'user', content: data.content, source: data.source }
  return null
}

const nodes = surface.map((seq) => {
  const event = events.get(seq)
  const message = messageOf(event)
  return { seq, type: event?.type, tokens: message === null ? 0 : estimateMessage(message) }
})

const total = nodes.reduce((sum, node) => sum + node.tokens, 0)
const window = Number(windowArg ?? 1_048_576)
const reserved = Number(reservedArg ?? lastRequestHeader?.data?.header?.config?.maxTokens ?? 256_000)
const headerTools = lastRequestHeader?.data?.header?.tools
const tools = toolsPrice({ tools: headerTools })
const wall = computeWall({ contextWindow: window, reservedCompletionTokens: reserved, marginTokens: 8192 })
const budget = Math.max(1024, window - 65536 - tools - 8192)

console.log('=== session ===')
console.log('id:', header?.id, '| preset:', header?.agentPreset, '| maxSeq:', maxSeq)
console.log('events:', events.size, '| surface nodes:', surface.length)
console.log('compactions:', compactionCount, '| prunes:', [...events.values()].filter((e) => e.type === 'compaction/prune').length)
console.log('last request header:', JSON.stringify(lastRequestHeader?.data?.header?.config))
console.log('tools in last header:', Array.isArray(headerTools) ? headerTools.length : 'n/a', '| tools price:', tools)
console.log('last reported usage:', JSON.stringify(lastUsage))

console.log('\n=== window arithmetic ===')
console.log(`window=${window} reserved=${reserved} tools=${tools}`)
console.log(`wall=${wall}  budget(summary input)=${budget}`)
console.log(`surface total (meter units)=${total}`)
console.log(total > wall ? `OVER WALL by ${total - wall}` : `inside wall, headroom ${wall - total}`)

console.log('\n=== largest surface nodes ===')
for (const node of [...nodes].sort((a, b) => b.tokens - a.tokens).slice(0, 8)) {
  console.log(String(node.tokens).padStart(8), node.type, 'seq', node.seq)
}

const sessionLike = { eventAt: (seq) => events.get(seq) }
const balanced = balanceAfter(sessionLike, surface)
const head = events.get(surface[0])
const firstIdx = head?.type === 'system/message' ? 1 : 0
const plan = planChunk({ nodes, balanced, firstIdx, budget, minTail: 1 })

console.log('\n=== guard plan (round 1) ===')
console.log('firstIdx:', firstIdx, '| head type:', head?.type)
if (plan === null) console.log('no balanced chunk fits the budget')
else console.log(`nodes ${plan.startIdx}..${plan.endIdx} (seq ${nodes[plan.startIdx].seq}..${nodes[plan.endIdx].seq}), ~${plan.tokens} tokens`)

console.log('\n=== historical compaction ratios ===')
for (const sample of compactionSummarySamples.slice(-5)) {
  console.log(`seq ${sample.seq} shadowed=${sample.shadowed} -> ${sample.provider}/${sample.model}`)
}
