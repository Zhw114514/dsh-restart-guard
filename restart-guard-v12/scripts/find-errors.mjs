/**
 * Locate provider context errors inside a session log.
 * Usage: node find-errors.mjs <session.v4.jsonl>
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.argv[2]
const rl = createInterface({ input: createReadStream(logPath, 'utf8'), crlfDelay: Infinity })

const needles = ['maximum context length', 'CONTEXT_WINDOW_EXCEEDED']
let hits = 0

function excerpt(value, needle) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const index = text.indexOf(needle)
  if (index === -1) return null
  return text.slice(Math.max(0, index - 260), index + 320).replace(/\s+/g, ' ')
}

for await (const line of rl) {
  if (line.trim().length === 0) continue
  let found = false
  for (const needle of needles) if (line.includes(needle)) found = true
  if (!found) continue
  const event = JSON.parse(line)
  const blob = JSON.stringify(event.data ?? event)
  for (const needle of needles) {
    const text = excerpt(blob, needle)
    if (text === null) continue
    hits += 1
    console.log(`\n--- seq ${event.seq} type ${event.type} time ${new Date(event.time).toISOString()} ---`)
    console.log(text)
    if (hits >= 12) process.exit(0)
  }
}
console.log('hits:', hits)
