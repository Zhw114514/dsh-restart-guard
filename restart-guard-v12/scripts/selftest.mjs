/**
 * Self-test for the pure planning helpers. No DSH runtime, no model calls.
 * Run: node scripts/selftest.mjs
 */
import assert from 'node:assert/strict'
import {
  balanceAfter,
  calibrationRatio,
  computeWall,
  firstCompactableIndex,
  planChunk,
  summaryBudgetMeter,
  toolsPrice,
} from '../lib/planner.js'

let checks = 0
const check = (label, fn) => {
  fn()
  checks += 1
  console.log(`ok ${checks} - ${label}`)
}

check('wall divides by the calibration ratio and subtracts the margin', () => {
  // (1,048,576 - 256,000) / 1.838 - ceil(8,192 / 1.838)
  const wall = computeWall({ contextWindow: 1048576, reservedCompletionTokens: 256000, marginTokens: 8192, ratio: 1.838 })
  assert.equal(wall, Math.floor(792576 / 1.838) - Math.ceil(8192 / 1.838))
  // ratio 1 reproduces the naive meter-unit wall
  assert.equal(computeWall({ contextWindow: 1048576, reservedCompletionTokens: 256000, marginTokens: 8192 }), 784384)
})

check('wall is zero when nothing is usable', () => {
  assert.equal(computeWall({ contextWindow: 100, reservedCompletionTokens: 100 }), 0)
  assert.equal(computeWall({ contextWindow: 100, reservedCompletionTokens: 200 }), 0)
})

check('calibration ratio derives from the provider sample and clamps', () => {
  assert.equal(calibrationRatio({ realPromptTokens: 1_684_511, meterTotalTokens: 916_346 }).toFixed(3), '1.838')
  assert.equal(calibrationRatio({ realPromptTokens: 0, meterTotalTokens: 100 }), 1)
  assert.equal(calibrationRatio({ realPromptTokens: 100, meterTotalTokens: 0 }), 1)
  // never below 1 (an under-counting provider must not widen the budget)
  assert.equal(calibrationRatio({ realPromptTokens: 50, meterTotalTokens: 100 }), 1)
  // clamped so a bogus sample cannot explode the budget
  assert.equal(calibrationRatio({ realPromptTokens: 100_000, meterTotalTokens: 1 }), 8)
})

check('planChunk stops at the budget and skips unbalanced cuts', () => {
  const nodes = [{ tokens: 10 }, { tokens: 10 }, { tokens: 10 }, { tokens: 10 }]
  const balanced = Uint8Array.from([1, 0, 1, 1])
  const plan = planChunk({ nodes, balanced, firstIdx: 0, budget: 35, minTail: 1 })
  assert.deepEqual(plan, { startIdx: 0, endIdx: 2, tokens: 30, reachedTarget: false })

  const tight = planChunk({ nodes, balanced, firstIdx: 0, budget: 25, minTail: 1 })
  assert.deepEqual(tight, { startIdx: 0, endIdx: 0, tokens: 10, reachedTarget: false })
})

check('planChunk stops at the target instead of maximal compaction', () => {
  const nodes = [{ tokens: 10 }, { tokens: 10 }, { tokens: 10 }, { tokens: 10 }]
  const balanced = Uint8Array.from([1, 1, 1, 1])
  const plan = planChunk({ nodes, balanced, firstIdx: 0, budget: 100, minTail: 1, targetTokens: 15 })
  assert.deepEqual(plan, { startIdx: 0, endIdx: 1, tokens: 20, reachedTarget: true })
})

check('planChunk falls back to the largest fit when the target is unreachable', () => {
  const nodes = [{ tokens: 10 }, { tokens: 10 }, { tokens: 10 }]
  const balanced = Uint8Array.from([1, 1, 1])
  const plan = planChunk({ nodes, balanced, firstIdx: 0, budget: 25, minTail: 1, targetTokens: 100 })
  assert.deepEqual(plan, { startIdx: 0, endIdx: 1, tokens: 20, reachedTarget: false })
})

check('planChunk never splits a pair', () => {
  const nodes = [{ tokens: 10 }, { tokens: 10 }, { tokens: 10 }]
  const balanced = Uint8Array.from([0, 0, 0])
  assert.equal(planChunk({ nodes, balanced, firstIdx: 0, budget: 100, minTail: 1 }), null)
})

check('planChunk keeps the tail', () => {
  const nodes = [{ tokens: 10 }, { tokens: 10 }]
  const balanced = Uint8Array.from([1, 1])
  assert.deepEqual(planChunk({ nodes, balanced, firstIdx: 0, budget: 100, minTail: 1 }), {
    startIdx: 0,
    endIdx: 0,
    tokens: 10,
    reachedTarget: false,
  })
})

check('balanceAfter counts open tool calls', () => {
  const events = {
    0: { type: 'system/message', data: {} },
    1: { type: 'user/message', data: {} },
    2: { type: 'assistant/message', data: { message: { content: [{ type: 'text' }, { type: 'tool-call' }] } } },
    3: { type: 'tool/result', data: {} },
    4: { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }, { type: 'tool-call' }] } } },
    5: { type: 'tool/result', data: {} },
  }
  const session = { eventAt: (seq) => events[seq] }
  assert.deepEqual([...balanceAfter(session, [0, 1, 2, 3, 4, 5])], [1, 1, 0, 1, 0, 0])
})

check('firstCompactableIndex looks up a seq, never the node object', () => {
  const events = {
    0: { type: 'system/message' },
    1: { type: 'user/message' },
    5: { type: 'user/message' },
  }
  const session = {
    eventAt: (seq) => (typeof seq === 'number' ? events[seq] : undefined),
  }
  assert.equal(firstCompactableIndex(session, [{ seq: 0 }, { seq: 1 }]), 1)
  assert.equal(firstCompactableIndex(session, [{ seq: 5 }]), 0)
  assert.throws(() => firstCompactableIndex({ eventAt: () => undefined }, [{ seq: 0 }]), /unavailable/)
  assert.throws(() => firstCompactableIndex(session, [{}]), /no valid seq/)
})

check('summary budget subtracts system, tools, instruction and margin', () => {
  const full = summaryBudgetMeter({
    contextWindow: 1_048_576,
    reservedCompletionTokens: 256_000,
    ratio: 2,
    toolsTokens: 10_000,
    systemTokens: 20_000,
    instructionTokens: 4_000,
    marginTokens: 32_768,
    safetyRatio: 0.75,
  })
  const noFixed = summaryBudgetMeter({
    contextWindow: 1_048_576,
    reservedCompletionTokens: 256_000,
    ratio: 2,
    safetyRatio: 1,
  })
  assert.equal(noFixed, Math.floor((1_048_576 - 256_000) / 2))
  assert.ok(full < noFixed)
  // 18,432 of the fixed subtraction is margin/2; the rest is 34,000 meter.
  assert.equal(full, Math.floor((Math.floor((1_048_576 - 256_000) / 2) - 34_000 - 16_384) * 0.75))
})

check('planChunk starting after the system node never returns index 0', () => {
  const nodes = [{ tokens: 10 }, { tokens: 10 }, { tokens: 10 }]
  const balanced = Uint8Array.from([1, 1, 1])
  assert.deepEqual(planChunk({ nodes, balanced, firstIdx: 1, budget: 100, minTail: 1 }), {
    startIdx: 1,
    endIdx: 1,
    tokens: 10,
    reachedTarget: false,
  })
})

check('toolsPrice follows the 4-chars-per-token heuristic', () => {
  assert.equal(toolsPrice(undefined), 0)
  assert.equal(toolsPrice({ tools: [] }), 0)
  assert.equal(toolsPrice({ tools: [{ name: 'x' }] }), Math.ceil(JSON.stringify([{ name: 'x' }]).length / 4) + 4)
})

console.log(`\n${checks} checks passed`)
