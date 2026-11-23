/**
 * Pure planning helpers for dsh-restart-guard.
 *
 * Everything here is side-effect free so the guard's arithmetic can be tested
 * without a live Session, token meter, or model call.
 *
 * All quantities are in *meter units* (the token meter's 4-chars-per-token
 * heuristic). The caller converts provider-reported real tokens into meter
 * units with the calibration ratio before calling in.
 */

/** Tokens one node is priced at, defensively coerced. */
function nodePrice(node) {
  const value = node?.tokens
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Event seq carried by one priced node, or a bare seq in legacy callers. */
export function nodeSeq(node) {
  if (Number.isInteger(node) && node >= 0) return node
  const value = node?.seq
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * First surface index a compaction may legitimately cover.
 *
 * This is a *seq* lookup, not a node lookup: `Session.eventAt()` accepts a
 * numeric seq. Passing the node object itself returns undefined, silently
 * making the system prompt look unprotected and letting a chunk start at node 0.
 *
 * @param session - session exposing `eventAt(seq)`
 * @param nodes - priced surface nodes in order
 * @returns 1 when node 0 is a protected `system/message`, otherwise 0
 * @throws when node 0 has no seq or its event is unavailable
 */
export function firstCompactableIndex(session, nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return 0
  const headSeq = nodeSeq(nodes[0])
  if (headSeq === undefined) throw new Error('restart-guard: surface node 0 has no valid seq')
  const head = session.eventAt(headSeq)
  if (head === undefined) throw new Error(`restart-guard: surface event ${headSeq} is unavailable`)
  return head.type === 'system/message' ? 1 : 0
}

/**
 * Meter-unit budget for one summarization call, including every fixed prefix
 * the compaction engine will replay: tools, the protected system head, and the
 * trailing compaction instruction. `safetyRatio` deliberately spends extra
 * calls to keep the summary request away from the provider wall.
 *
 * @param input - window and reservation in real tokens, ratio, fixed meter costs
 * @returns non-negative meter-unit budget
 */
export function summaryBudgetMeter({
  contextWindow,
  reservedCompletionTokens,
  marginTokens = 0,
  ratio = 1,
  toolsTokens = 0,
  systemTokens = 0,
  instructionTokens = 0,
  safetyRatio = 1,
}) {
  const usable = contextWindow - (reservedCompletionTokens ?? 0)
  if (!Number.isFinite(usable) || usable <= 0) return 0
  const divisor = Number.isFinite(ratio) && ratio >= 1 ? ratio : 1
  const fixed =
    (Number.isFinite(toolsTokens) && toolsTokens > 0 ? toolsTokens : 0) +
    (Number.isFinite(systemTokens) && systemTokens > 0 ? systemTokens : 0) +
    (Number.isFinite(instructionTokens) && instructionTokens > 0 ? instructionTokens : 0) +
    Math.ceil((Number.isFinite(marginTokens) && marginTokens > 0 ? marginTokens : 0) / divisor)
  const raw = Math.floor(usable / divisor) - fixed
  if (!Number.isFinite(raw) || raw <= 0) return 0
  const safe = Number.isFinite(safetyRatio) ? Math.min(1, Math.max(0, safetyRatio)) : 1
  return Math.max(0, Math.floor(raw * safe))
}

/**
 * Balanced-after flags for the current surface: 1 when no tool call is still
 * open after that node. Mirrors the compaction engine's pairing rule so a cut
 * never splits a tool-call/tool-result pair.
 *
 * @param session - session exposing `eventAt(seq)`
 * @param nodes - current surface seqs in order
 * @returns one 1/0 flag per node
 */
export function balanceAfter(session, nodes) {
  const flags = new Uint8Array(nodes.length)
  let open = 0
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodeSeq(nodes[index])
    if (seq === undefined) throw new Error(`restart-guard: surface node ${index} has no valid seq`)
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error(`restart-guard: surface event ${seq} is unavailable`)
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content ?? []
      for (const block of content) if (block?.type === 'tool-call') open += 1
    } else if (event?.type === 'tool/result') {
      open -= 1
    }
    flags[index] = open === 0 ? 1 : 0
  }
  return flags
}

/**
 * The hard ceiling in *meter units* for a given calibration ratio: the provider
 * rejects `prompt + max_tokens` above the window, so the prompt may only use
 * `window - reserved`, divided by the ratio that converts real tokens to meter
 * units.
 *
 * @param input - window, the routed request's completion reservation, ratio, and margin
 * @returns the largest meter total a request may carry
 */
export function computeWall({ contextWindow, reservedCompletionTokens, marginTokens = 8192, ratio = 1 }) {
  const usable = contextWindow - (reservedCompletionTokens ?? 0)
  if (!Number.isFinite(usable) || usable <= 0) return 0
  return Math.floor(usable / ratio) - Math.ceil(marginTokens / ratio)
}

/**
 * Largest balanced prefix starting at `firstIdx` whose priced nodes fit
 * `budget`, always leaving `minTail` nodes in place. When `targetTokens` is
 * set, the smallest balanced prefix that reaches it wins: compacting more than
 * necessary destroys context the session still needs.
 *
 * @param input - priced nodes, balance flags, start index, budget, tail size, optional target
 * @returns the chosen inclusive index range and its price, or null when nothing fits
 */
export function planChunk({ nodes, balanced, firstIdx, budget, minTail = 1, targetTokens = 0 }) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  if (!Number.isInteger(firstIdx) || firstIdx < 0 || firstIdx >= nodes.length) return null
  if (!Number.isInteger(minTail) || minTail < 1) return null
  if (!Number.isFinite(budget) || budget <= 0) return null
  const limit = nodes.length - minTail
  if (firstIdx >= limit) return null
  let accumulated = 0
  let bestIdx = -1
  let bestTokens = 0
  for (let index = firstIdx; index < limit; index += 1) {
    const price = nodePrice(nodes[index])
    if (accumulated + price > budget) break
    accumulated += price
    if (balanced[index] !== 1) continue
    bestIdx = index
    bestTokens = accumulated
    if (targetTokens > 0 && accumulated >= targetTokens) {
      return { startIdx: firstIdx, endIdx: index, tokens: accumulated, reachedTarget: true }
    }
  }
  if (bestIdx === -1) return null
  return { startIdx: firstIdx, endIdx: bestIdx, tokens: bestTokens, reachedTarget: false }
}

/**
 * Convert a provider-reported prompt size into a multiplier over the meter's
 * own total for the same surface. A provider tokenization denser than the
 * heuristic yields a ratio above 1, and every budget must be divided by it.
 *
 * @param input - provider-reported prompt tokens and the meter total for that surface
 * @returns clamping ratio in [1, 8]; 1 when the sample is unusable
 */
export function calibrationRatio({ realPromptTokens, meterTotalTokens }) {
  if (!Number.isFinite(realPromptTokens) || realPromptTokens <= 0) return 1
  if (!Number.isFinite(meterTotalTokens) || meterTotalTokens <= 0) return 1
  const ratio = realPromptTokens / meterTotalTokens
  if (!Number.isFinite(ratio) || ratio < 1) return 1
  return Math.min(ratio, 8)
}

/**
 * Tool-schema price, matching the token meter's fixed 4-chars-per-token
 * heuristic (plus its structural overhead).
 *
 * @param header - canonical request envelope
 * @returns heuristic token price of the tool schemas (meter units)
 */
export function toolsPrice(header) {
  const tools = header?.tools
  if (!Array.isArray(tools) || tools.length === 0) return 0
  return Math.ceil(JSON.stringify(tools).length / 4) + 4
}

/**
 * Threshold the native compaction engine uses before it compacts on a model
 * switch: `floor(min(window * thresholdRatio, window - reserved - headroom))`.
 * Mirrors `resolveCompactSpec` in dsh-compaction-basic so the guard can prove
 * the native handler will skip after a successful recovery.
 *
 * @param config - engine config carrying `thresholdRatio` and `headroomTokens`
 * @param contextWindow - the NEW target model's window
 * @param reservedCompletionTokens - the request's effective completion reserve
 * @returns the native threshold in meter units, or undefined when unusable
 */
export function nativeThreshold({ config, contextWindow, reservedCompletionTokens }) {
  const window = Number(contextWindow)
  const reserved = Number(reservedCompletionTokens)
  if (!Number.isInteger(window) || window <= 0) return undefined
  if (!Number.isInteger(reserved) || reserved < 0) return undefined
  const ratio = Number(config?.thresholdRatio ?? 0.8)
  const headroom = Number(config?.headroomTokens ?? 65536)
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined
  if (!Number.isFinite(headroom) || headroom < 0) return undefined
  const messageBudget = window - reserved
  const pressureBudget = messageBudget - headroom
  if (messageBudget <= 0 || pressureBudget <= 0) return undefined
  return Math.floor(Math.min(window * ratio, pressureBudget))
}