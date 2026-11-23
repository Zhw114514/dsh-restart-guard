/**
 * Prediction: replay the real dead session and simulate what the guard would
 * do with a provider-calibrated ratio. No model call, no write.
 *
 * Usage: node predict.mjs <session.v4.jsonl> <realPromptTokens> [window] [reserved]
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { balanceAfter, computeWall, firstCompactableIndex, planChunk, summaryBudgetMeter, toolsPrice } from '../lib/planner.js'

const [logPath, realArg, windowArg, reservedArg] = process.argv.slice(2)
const realPromptTokens = Number(realArg)
const window = Number(windowArg ?? 1_048_576)
const reserved = Number(reservedArg ?? 256_000)
const summaryReserve = 65_536
const margin = 32768

const estimateUrl = pathToFileURL(
  'D:/DSH-Env/documents/deepseek-harness/default-workspace/downloads/pkgs/dsh-token-meter-0.2.3-alpha.2/package/lib/types/estimate.js',
)
const { estimateMessage } = await import(estimateUrl.href)

const events = new Map()
const surface = []
let lastHeader = null
let checkpointSample = null

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
  if (checkpointSample === null && event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint') {
    checkpointSample = estimateMessage({ role: 'user', content: event.data.content })
  }
}

const messageOf = (event) => {
  const data = event?.data ?? {}
  if (data.message !== undefined) return data.message
  if (Array.isArray(data.content)) return { role: data.role ?? 'user', content: data.content }
  return null
}
const priceOf = (seq) => {
  const message = messageOf(events.get(seq))
  return message === null ? 0 : estimateMessage(message)
}

let nodes = surface.map((seq) => ({ seq, tokens: priceOf(seq), type: events.get(seq)?.type }))
const total = nodes.reduce((sum, node) => sum + node.tokens, 0)
const ratio = realPromptTokens / total
const tools = toolsPrice(lastHeader)
const meterWall = computeWall({ contextWindow: window, reservedCompletionTokens: reserved, marginTokens: margin, ratio })
const meterBudget = summaryBudgetMeter({
  contextWindow: window,
  reservedCompletionTokens: summaryReserve,
  marginTokens: margin,
  ratio,
  toolsTokens: tools,
  systemTokens: nodes[0]?.tokens ?? 0,
  instructionTokens: 4096,
  safetyRatio: 0.75,
})
const summaryPrice = checkpointSample ?? 8000

console.log(`surface: ${nodes.length} nodes, ${total} meter units`)
console.log(`provider says ${realPromptTokens} real tokens -> ratio ${ratio.toFixed(3)}`)
console.log(`meterWall ${meterWall} | meterBudget ${meterBudget} | historical checkpoint ~${summaryPrice} meter`)
console.log(`currently ${total > meterWall ? 'OVER by ' + (total - meterWall) + ' meter' : 'inside'}`)

const sessionLike = { eventAt: (seq) => events.get(seq) }
let projected = total
for (let round = 0; round < 6; round += 1) {
  if (projected <= meterWall) break
  const balanced = balanceAfter(sessionLike, nodes.map((node) => (node.seq >= 0 ? node.seq : 1)))
  const firstIdx = firstCompactableIndex(sessionLike, nodes)
  const target = Math.ceil((projected - meterWall) * 1.2) + 4096
  const plan = planChunk({ nodes, balanced, firstIdx, budget: meterBudget, minTail: 1, targetTokens: target })
  if (plan === null) {
    console.log(`round ${round + 1}: no balanced chunk fits budget`)
    break
  }
  const removed = nodes.slice(plan.startIdx, plan.endIdx + 1).reduce((sum, node) => sum + node.tokens, 0)
  projected = projected - removed + summaryPrice
  console.log(
    `round ${round + 1}: compact nodes ${plan.startIdx}..${plan.endIdx} (seq ${nodes[plan.startIdx].seq}..${nodes[plan.endIdx].seq}) ` +
      `remove ${removed} meter (~${Math.round(removed * ratio)} real), add checkpoint ~${summaryPrice} -> projected ${projected} meter (~${Math.round(projected * ratio)} real)`,
  )
  // Replace the compacted range with one checkpoint node for the next round.
  nodes = [
    ...nodes.slice(0, plan.startIdx),
    { seq: -round - 1, tokens: summaryPrice, type: 'user/message' },
    ...nodes.slice(plan.endIdx + 1),
  ]
}
console.log(projected <= meterWall ? `\nprojected final: ${projected} meter (~${Math.round(projected * ratio)} real) 鈥?inside` : `\nstill over after 6 rounds: ${projected}`)
