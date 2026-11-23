/**
 * Offline replay probe: rebuild the sandbox session in the real Session
 * (0.2.2 fixture), renumbering the kept events contiguously (the constructor
 * requires a seed from seq 0), then compare the projected messages of a
 * successful region with a failing one.
 *
 * Read-only: no DSH, no network, no engine calls.
 *
 * Run: node scripts/replay-probe.mjs <snapshot.zstd> <startSeq> <endSeq> [<startSeq> <endSeq> ...]
 */
import { pathToFileURL } from 'node:url'
import { readFrames } from '../../documents/deepseek-harness/default-workspace/dsh-restart-guard/scripts/zstd-frames.mjs'

const [snapshot, ...pairs] = process.argv.slice(2)
if (snapshot === undefined) throw new Error('usage: replay-probe.mjs <snapshot.zstd> <startSeq> <endSeq> ...')

const sessionApi = await import(
  pathToFileURL('D:/DSH-Env/restart-guard-candidate-v12/real-api-022/node_modules/@deepseek-ai/dsh-session/lib/index.js').href
)
const { Session, SessionId, SESSION_FORMAT_VERSION } = sessionApi
const buildHeader = (id) =>
  typeof sessionApi.buildSessionHeader === 'function'
    ? sessionApi.buildSessionHeader(id, {})
    : { version: SESSION_FORMAT_VERSION, id, createdAt: 1_700_000_000_000, isSeeded: false }

const KNOWN = new Set([
  'system/message', 'user/message', 'assistant/message', 'tool/result',
  'turn/start', 'turn/end', 'step/start', 'step/end', 'request/header',
  'compaction/start', 'compaction/end', 'compaction/summary', 'compaction/prune',
])
const raw = readFrames(snapshot).text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
const kept = raw.filter((event) => Number.isInteger(event.seq) && event.type !== undefined && event.data !== undefined && KNOWN.has(event.type))
const remap = new Map(kept.map((event, index) => [event.seq, index]))
const seed = kept.map((event, index) => {
  const next = { ...event, seq: index, time: event.time ?? 1_700_000_000_000 + index }
  if (next.surfaceOp?.op === 'replace') {
    const startSeq = remap.get(next.surfaceOp.startSeq)
    const endSeq = remap.get(next.surfaceOp.endSeq)
    if (startSeq === undefined || endSeq === undefined) return null
    next.surfaceOp = { ...next.surfaceOp, startSeq, endSeq }
  }
  if (Array.isArray(next.sourceEventSeqs)) {
    next.sourceEventSeqs = next.sourceEventSeqs.map((seq) => remap.get(seq)).filter((seq) => seq !== undefined)
  }
  return next
}).filter(Boolean)

const session = new Session(SessionId('session-replay'), seed, buildHeader(SessionId('session-replay')))
console.log(JSON.stringify({ raw: raw.length, kept: seed.length, surface: session.surface.nodes.length }))

const describeRegion = (oldStart, oldEnd) => {
  const startSeq = remap.get(oldStart)
  const endSeq = remap.get(oldEnd)
  const nodes = session.surface.nodes
  const startIdx = startSeq === undefined ? -1 : nodes.indexOf(startSeq)
  const endIdx = endSeq === undefined ? -1 : nodes.indexOf(endSeq)
  const slice = startIdx === -1 || endIdx === -1 ? [] : nodes.slice(startIdx, endIdx + 1)
  const roles = {}
  const blocks = {}
  const sources = {}
  const issues = []
  let projected = 0
  let chars = 0
  for (const seq of slice) {
    const event = session.eventAt(seq)
    if (event === undefined) { issues.push({ seq, issue: 'missing-event' }); continue }
    let message
    try {
      message = session.deriveEventMessage(event)
    } catch (error) {
      issues.push({ seq, issue: 'derive-threw', message: String(error?.message ?? error).slice(0, 200) })
      continue
    }
    if (message === null || message === undefined) continue
    projected += 1
    roles[message.role] = (roles[message.role] ?? 0) + 1
    const kind = message.source?.kind
    if (typeof kind === 'string') sources[kind] = (sources[kind] ?? 0) + 1
    if (!Array.isArray(message.content)) { issues.push({ seq, issue: 'content-not-array', type: typeof message.content }); continue }
    if (message.content.length === 0) issues.push({ seq, role: message.role, issue: 'empty-content' })
    for (const block of message.content) blocks[String(block?.type)] = (blocks[String(block?.type)] ?? 0) + 1
    try { chars += JSON.stringify(message).length } catch {}
  }
  return { oldStart, oldEnd, startIdx, endIdx, slice: slice.length, projected, chars, roles, blocks, sources, issues: issues.slice(0, 12), issueCount: issues.length }
}

for (let index = 0; index + 1 < pairs.length; index += 2) {
  console.log(JSON.stringify(describeRegion(Number(pairs[index]), Number(pairs[index + 1]))))
}
