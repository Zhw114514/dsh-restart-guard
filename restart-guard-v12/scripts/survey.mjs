/**
 * Read-only survey of one session log: event mix, surface fold, request headers.
 * Prints shapes only, never full content.
 *
 * Usage: node survey.mjs <session.v4.jsonl>
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const path = process.argv[2]
if (!path) throw new Error('usage: node survey.mjs <session.v4.jsonl>')

const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })

const typeCounts = new Map()
const surfaceCounts = new Map()
const samples = new Map()
let header = null
let lastRequestHeader = null
const requestHeaders = []
let lineCount = 0
let badJson = 0
let maxSeq = -1

for await (const line of rl) {
  lineCount += 1
  if (line.trim().length === 0) continue
  let event
  try {
    event = JSON.parse(line)
  } catch {
    badJson += 1
    continue
  }
  if (event.type === 'session') {
    header = { version: event.version, id: event.id, cwd: event.cwd, isSeeded: event.isSeeded, agentPreset: event.agentPreset }
    continue
  }
  typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1)
  if (typeof event.seq === 'number') maxSeq = Math.max(maxSeq, event.seq)

  const op = event.surfaceOp
  const surfaceKind = op === undefined ? 'none' : op === 'append' ? 'append' : 'replace'
  surfaceCounts.set(surfaceKind, (surfaceCounts.get(surfaceKind) ?? 0) + 1)

  if (op !== undefined && !samples.has(event.type)) {
    samples.set(event.type, summarize(event))
  }
  if (event.type === 'request/header') {
    requestHeaders.push(event)
    lastRequestHeader = event
  }
}

function summarize(event) {
  const data = event.data ?? {}
  const out = { type: event.type, surfaceOp: event.surfaceOp, dataKeys: Object.keys(data) }
  const message = data.message
  if (message) {
    out.role = message.role
    out.source = message.source
    out.contentTypes = Array.isArray(message.content) ? message.content.map((b) => b.type) : undefined
    out.contentBlocks = Array.isArray(message.content) ? message.content.length : undefined
  }
  return out
}

console.log('header:', JSON.stringify(header))
console.log('lines:', lineCount, 'badJson:', badJson, 'maxSeq:', maxSeq)
console.log('\ntop event types:')
for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(String(count).padStart(8), type)
}
console.log('\nsurface markers:', Object.fromEntries(surfaceCounts))
console.log('\nsample shape per surface type:')
for (const [type, sample] of samples) console.log(type, JSON.stringify(sample))
console.log('\nrequest/header count:', requestHeaders.length)
if (lastRequestHeader) {
  const cfg = lastRequestHeader.data?.header?.config ?? lastRequestHeader.data?.config
  console.log('last request header config:', JSON.stringify(cfg))
  console.log('has tools:', Array.isArray(lastRequestHeader.data?.header?.tools) ? lastRequestHeader.data.header.tools.length : 'n/a')
}
