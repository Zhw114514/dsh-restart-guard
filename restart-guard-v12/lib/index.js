/**
 * dsh-restart-guard 闂?keep a resumed session from dying on its first request.
 *
 * A restart replays the whole event log, so a Session that grew past its model
 * window while it was live can come back with a surface that no request can
 * carry: the provider rejects it, automatic compaction deadlocks (its own
 * summary request carries the whole surface), and every later turn fails the
 * same way.
 *
 * The guard shrinks the surface before the request is built (`agent/pre-step`,
 * prepended) and before the request-error recovery path:
 *
 *   1. a model-free floor 闂?the tool-result pruner rewrites oversized results;
 *   2. chunked compaction 闂?only a prefix whose summarization input still fits
 *      under the window is compacted, repeated until the surface fits.
 *
 * Recovery is deliberately allowed to spend more requests: the summary budget
 * is conservative, context-limit failures shrink the chunk, and an interrupted
 * compaction transaction is closed or completed before another chunk starts.
 *
 * @module dsh-restart-guard
 */
import { appendFileSync } from 'node:fs'
import { identifyEngine } from './identity.js'
import { resolveSummaryPlan, routeKeyOf, routeOf } from './route.js'
import {
  balanceAfter,
  calibrationRatio,
  firstCompactableIndex,
  nativeThreshold,
  nodeSeq,
  planChunk,
  summaryBudgetMeter,
  toolsPrice,
} from './planner.js'

/**
 * Classify the relationship between the step's fixed route and the recorded
 * session header. Only `same` is a normal request; `switch` is a confirmed
 * model switch; `unknown` means a header exists but a route field is missing 鈥? * the guard refuses to guess because the native handler would compact blind.
 */
function classifySwitch(proposed, headerConfig) {
  if (headerConfig === undefined) return 'none'
  const header = routeOf(headerConfig)
  if (proposed === undefined || header === undefined) return 'unknown'
  if (proposed.provider === header.provider && proposed.model === header.model) return 'same'
  return 'switch'
}
/**
 * Upper-bound estimate of the serialized request body, in JS string characters.
 * Counts the projected messages array, the tool schemas, and a fixed structural
 * allowance. `toolHistory` is not added: it never reaches the body directly, it
 * only rewrites developer messages and tool declarations already counted here.
 */
function estimateRequestChars(session, header) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return undefined
  if (typeof session.eventAt !== 'function' || typeof session.deriveEventMessage !== 'function') return undefined
  try {
    const messages = []
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      const message = session.deriveEventMessage(event)
      if (message === null || message === undefined) continue
      messages.push(message)
    }
    const toolsChars = header?.tools === undefined ? 0 : JSON.stringify(header.tools).length
    return JSON.stringify(messages).length + toolsChars + 65536
  } catch {
    return undefined
  }
}
export const name = 'restart-guard'
export const inject = ['llm', 'tokenMeter']

/** Provider failure code the recovery path keys on. */
const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'

const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** When true, only log what would happen; never prune, compact, or retry. */
  dryRun: false,
  /**
   * Act on `pre-step` without any provider calibration. Off by default: the
   * meter's unit is not the provider's, so an uncalibrated wall can flag a
   * perfectly healthy session. With this off, `pre-step` still runs the
   * model-free prune, but leaves chunked compaction to a refusal or to the
   * transport heuristic below.
   */
  proactive: false,
  /**
   * Recover a model switch at pre-step, before the native engine compacts for
   * that switch. `false` restores the previous behaviour exactly.
   */
  switchRecovery: true,
  /**
   * Upper bound on the estimated request body length in JS string characters.
   * `0` disables the check and restores v11 behaviour exactly.
   */
  requestCharsBudget: 1_800_000,
  /** Safety margin in *real* provider tokens. */
  marginTokens: 32768,
  /** Which engine routing rules to mirror: auto probes the engine instance. */
  engineRouteMode: 'auto',
  /** Assumed real/meter ratio before a provider sample exists. */
  assumedRatio: 2,
  /** Hard cap on successful summarization chunks per guard run (chunks <= maxSummaryAttempts). */
  maxChunks: 6,
  /** Hard cap on summary/compaction attempts, including retries. */
  maxSummaryAttempts: 8,
  /** Hard cap on consecutive TRANSPORT retries inside one guard run. */
  maxTransportRetries: 3,
  /** First backoff before retrying a TRANSPORT failure, in milliseconds. */
  transportBackoffMs: 500,
  /** Upper bound for the exponential TRANSPORT backoff, in milliseconds. */
  transportBackoffMaxMs: 8000,
  /**
   * Treat a repeated TRANSPORT refusal as a context overflow. Off by default:
   * an ordinary network fault must never be read as an oversized request.
   */
  treatTransportAsOverflow: false,
  /** Consecutive TRANSPORT failures on the same request chain before the heuristic may act. */
  transportOverflowConsecutive: 2,
  /** Hard cap on repairs of an interrupted compaction transaction. */
  maxRecoveryAttempts: 3,
  /** Meter-unit allowance for the trailing compaction instruction. */
  summaryInstructionTokens: 4096,
  /** Fraction of the computed summary budget deliberately spent per call. */
  summaryBudgetRatio: 0.75,
  /** Nodes always kept verbatim after the compacted range. */
  minTailNodes: 1,
  /** Optional file that receives every guard line; the host logger may have no sink. */
  logFile: '',
  /** Preflight attestation path; empty means read DSH_RESTART_GUARD_ATTESTATION. */
  attestationPath: '',
  /** Profile name the attestation must match; empty means read DSH_PROFILE. */
  profileName: '',
  /** Extra age bound on the attestation, on top of the boot-id binding. */
  attestationMaxAgeMs: 86400000,
}

/** Read the latest open turn without assuming one exists. */
function currentOpenTurn(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error(`restart-guard: session event ${seq} is unavailable`)
    if (event.type === 'turn/start') return event.data?.turn ?? null
    if (event.type === 'turn/end') return null
  }
  return null
}

/**
 * Inspect the latest compaction bracket and the latest seed boundary.
 * An unmatched start after the newest seed boundary is an active lock; an
 * unmatched start before that boundary is stale evidence from a prior lifecycle.
 */
function inspectCompaction(session) {
  let start
  let end
  let latestEndSeedSeq
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error(`restart-guard: session event ${seq} is unavailable`)
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq
    if (start === undefined && end === undefined) {
      if (event.type === 'compaction/start') start = event
      else if (event.type === 'compaction/end') end = event
    }
    if ((start !== undefined || end !== undefined) && latestEndSeedSeq !== undefined) break
  }
  const active = start !== undefined && (latestEndSeedSeq === undefined || start.seq > latestEndSeedSeq)
  return { start, end, latestEndSeedSeq, active }
}

/** Whether a compaction summary plus its surface replacement were already committed. */
function compactionBodyCommitted(session, start) {
  const compactionId = start?.data?.compactionId
  if (typeof compactionId !== 'string' || compactionId.length === 0) return false
  let summary
  for (let seq = start.seq + 1; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) throw new Error(`restart-guard: session event ${seq} is unavailable`)
    if (event.type === 'compaction/summary' && event.data?.compactionId === compactionId) {
      summary = event
      continue
    }
    if (summary === undefined || event.seq <= summary.seq) continue
    if (
      event.surfaceOp?.op === 'replace' &&
      Array.isArray(event.sourceEventSeqs) &&
      event.sourceEventSeqs.includes(summary.seq)
    ) {
      return true
    }
    // Real `user/message` events carry `source` at the data level
    // (`{ role, content, source, id }`); older shapes nested it under `message`.
    const source = event.data?.source ?? event.data?.message?.source
    if (source?.kind === 'compact-checkpoint' && source.compactionId === compactionId) {
      return true
    }
  }
  return false
}

/** Append the one closing event an interrupted automatic compaction is missing. */
function closeCompaction(session, start, error) {
  const compactionId = start?.data?.compactionId
  const turn = start?.data?.turn
  if (typeof compactionId !== 'string' || compactionId.length === 0) {
    throw new Error('restart-guard: active compaction start has no compactionId')
  }
  if (turn !== null && !Number.isInteger(turn)) {
    throw new Error('restart-guard: active compaction start has no valid turn')
  }
  return session.append('compaction/end', {
    compactionId,
    ...(start.data?.sourceCommandId === undefined ? {} : { sourceCommandId: start.data.sourceCommandId }),
    turn,
    ...(error === undefined ? {} : { error }),
  })
}

/**
 * Close an interrupted automatic compaction owned by the current turn.
 * A committed replacement is completed with a success end; an incomplete
 * transaction is closed with an error so a retry can start safely.
 */
function recoverActiveCompaction(session, currentTurn, cause) {
  const state = inspectCompaction(session)
  if (!state.active) return undefined
  const start = state.start
  if (start.data?.sourceCommandId !== undefined) {
    throw new Error(`restart-guard: active manual compaction ${start.data.sourceCommandId} is not mine to close`)
  }
  const turn = start.data?.turn
  if (turn === null || turn === undefined || turn !== currentTurn) {
    throw new Error(`restart-guard: active compaction turn ${String(turn)} does not match current turn ${String(currentTurn)}`)
  }
  const bodyCommitted = compactionBodyCommitted(session, start)
  const error = bodyCommitted
    ? undefined
    : `restart-guard recovered interrupted compaction: ${cause}`
  const endEvent = closeCompaction(session, start, error)
  return { start, bodyCommitted, endEvent }
}

/** Whether a provider summary failure is worth another, smaller attempt. */
function isContextLimit(message) {
  return /maximum context length|CONTEXT_WINDOW_EXCEEDED|context.*length|too many tokens/i.test(message)
}

/** Whether the summary itself hit its output cap, where a smaller input is worth trying. */
function isOutputLimit(message) {
  return /truncated at the token cap|MAX_TOKENS|incomplete checkpoint/i.test(message)
}

/** Whether a failure means only the selected surface changed, so replanning is safe. */
function isSurfaceChanged(message) {
  return /surface changed|selected span|no longer a valid replacement target|selected surface changed/i.test(message)
}

/** Whether a transport/rate/server/empty-summary failure is worth retrying. */
function isRetryableTransport(message) {
  return /TRANSPORT|transport failed|RATE_LIMIT|SERVER|TIMEOUT|EMPTY_RESPONSE|request aborted|socket|ECONN|produced no text summary|summarization produced no text|empty response/i.test(message)
}

/** Wait before a retry, resolving early when the turn is cancelled. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Register the guard.
 * @param ctx - host context providing the LLM and token-meter services
 * @param rawConfig - bundle configuration
 */
export function apply(ctx, rawConfig = {}, testHooks = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const attestationPath = config.attestationPath || process.env.DSH_RESTART_GUARD_ATTESTATION || ''
  const bootId = process.env.DSH_RESTART_GUARD_BOOT_ID || ''
  const profileName = config.profileName || process.env.DSH_PROFILE || ''
  /** Calibration learned per session, bound to the exact provider/model it came from. */
  const ratioBySession = new WeakMap()
  /** Sessions already told that only an assumed ratio exists (log once). */
  const warnedUncalibrated = new WeakSet()
  /** Sessions already told that the summary route differs from the request route. */
  const warnedRouteMismatch = new WeakSet()
  /** Consecutive TRANSPORT refusals per session, scoped to one turn (request chain). */
  const transportStreak = new WeakMap()

  /** Identity a calibration sample is valid for. */
  const calibrationKey = (config) => (config === undefined ? undefined : `${config.provider}/${config.model}`)

  /** Whether this session owns a provider sample for the route it is on now. */
  const hasCalibrationForCurrentRoute = (session) => {
    const route = session?.requestHeader?.()?.config
    if (route === undefined) return false
    const stored = ratioBySession.get(session)
    return stored !== undefined && stored.key === calibrationKey(route)
  }

  const log = (level, text) => {
    try {
      const sink = ctx.logger?.[level] ?? (level === 'error' ? ctx.logger?.warn : undefined) ?? ctx.logger?.info
      sink?.(text)
    } catch {
      /* logging must never break a turn */
    }
    if (typeof config.logFile === 'string' && config.logFile.length > 0) {
      try {
        appendFileSync(config.logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`, 'utf8')
      } catch {
        /* a full or read-only log file must never break a turn */
      }
    }
  }

  /** Provider refusal text carries the real prompt size for the surface it rejected. */
  const realPromptFrom = (failure) => {
    const text = `${failure?.message ?? ''} ${failure?.cause?.message ?? ''}`
    const match = /\((\d+)\s+in the (?:messages|prompt)/i.exec(text)
    if (match === null) return undefined
    const value = Number(match[1])
    return Number.isFinite(value) && value > 0 ? value : undefined
  }

  /** Measure and require the token meter's surface to be the session's current surface. */
  const measureAligned = (session) => {
    let measurement = ctx.tokenMeter.measure(session)
    const surface = session.surface?.nodes
    if (!Array.isArray(surface)) return measurement
    const aligned = (nodes) =>
      Array.isArray(nodes) &&
      nodes.length === surface.length &&
      nodes.every((node, index) => nodeSeq(node) === surface[index])
    if (aligned(measurement.nodes)) return measurement
    measurement = ctx.tokenMeter.measure(session, session.requestHeader?.())
    if (aligned(measurement.nodes)) return measurement
    throw new Error(
      'restart-guard: token-meter surface does not match session.surface; refusing to plan a compaction',
    )
  }

  /**
   * Shrink one agent's surface until it fits the routed window.
   * @param agent - agent whose session is measured and compacted
   * @param signal - turn cancellation signal
   * @param force - ignore the pre-check (the provider already reported overflow)
   * @param realPrompt - provider-reported prompt size for the current surface
   * @returns status object; `recovered` is true only when the final surface is under the wall
   */
  /** Resolve the summary plan with this plugin's pinned-mode configuration. */
  const summaryPlanFor = async (agent, engine, session) => {
    const identify = testHooks.identify ?? identifyEngine
    const identity = await identify({
      engine,
      attestationPath,
      bootId,
      profile: profileName,
      maxAgeMs: config.attestationMaxAgeMs,
    })
    const plan = resolveSummaryPlan({
      agent,
      engine,
      session,
      identity,
      pinnedMode: config.engineRouteMode,
    })
    if (plan.unknown !== true && typeof identity.assertIntegrity === 'function') plan.assertIntegrity = identity.assertIntegrity
    return plan
  }
  async function guard(agent, signal, { trigger = 'pre-step', realPrompt, route, switchMode = false } = {}) {
    const unfinished = (reason, detail = {}) => {
      log('error', `[restart-guard] FAILED: ${reason}; ${JSON.stringify(detail)}`)
      return { recovered: false, changed: false, failed: true, reason, detail }
    }
    if (!config.enabled) return { recovered: false, changed: false }
    const session = agent?.session
    const proposed = routeOf(route)
    if (proposed === undefined) return { recovered: false, changed: false }

    const presets = ctx.get?.('agentPresets')
    const engine = presets?.serviceFor?.(agent, 'compaction')
    if (typeof engine?.compactRegion !== 'function') return { recovered: false, changed: false }

    // Budget and summary call must describe the same model. Summarizing with a
    // route other than the one whose window sized this budget would either
    // overflow the summary call or shrink the surface against the wrong unit.
    // An engine whose identity we cannot prove is never safe to act on.
    const summary = await summaryPlanFor(agent, engine, session)
    if (summary.unknown === true) {
      if (!warnedRouteMismatch.has(session)) {
        warnedRouteMismatch.add(session)
        log(
          'error',
          `[restart-guard] cannot prove the engine identity/routing (mode=${config.engineRouteMode}): ${summary.reason ?? 'unknown'}; ` +
            'deferring without prune or compaction',
        )
      }
      return { recovered: false, changed: false, skipped: 'route-unknown' }
    }
    if (routeKeyOf(summary.route) !== routeKeyOf(proposed)) {
      if (!warnedRouteMismatch.has(session)) {
        warnedRouteMismatch.add(session)
        log(
          'info',
          `[restart-guard] route mismatch: request route=${routeKeyOf(proposed)} summary route=${routeKeyOf(summary.route) ?? 'none'} ` +
            `(engine=${summary.version}/${summary.profile}, conversation=${routeKeyOf(summary.conversation)}, configured=${String(summary.configured)}); ` +
            'deferring without prune or compaction',
        )
      }
      return { recovered: false, changed: false, skipped: 'route-mismatch' }
    }

    const info = await ctx.llm.resolveModelInfo(proposed.provider, proposed.model, signal)
    const window = info?.context?.contextWindow
    if (!Number.isInteger(window) || window <= 0) return { recovered: false, changed: false }

    // Every reservation must be a positive integer. A zero would silently widen
    // the wall, and a header recorded for a different route describes a
    // different adapter: neither its explicit maxTokens nor its adapter-default
    // marker may size the proposed request.
    const header = session?.requestHeader?.()
    const headerRoute = routeOf(header?.config)
    const headerMatchesProposed = routeKeyOf(headerRoute) === routeKeyOf(proposed)
    const adapterDefaultMax = headerMatchesProposed && header?.adapterDefaults?.maxTokens === true
    const explicitMax = headerMatchesProposed ? header?.config?.maxTokens : undefined
    const positiveInteger = (value) => Number.isInteger(value) && value > 0

    if (explicitMax !== undefined && !positiveInteger(explicitMax)) {
      return unfinished(`explicit maxTokens for ${routeKeyOf(proposed)} is not a positive integer (${String(explicitMax)})`)
    }
    let reserved
    if (!headerMatchesProposed) {
      // Only the proposed route's own default may size a stale-header request.
      if (!positiveInteger(info.defaultMaxTokens)) {
        return unfinished(
          `stale header for ${routeKeyOf(proposed)} (header route ${routeKeyOf(headerRoute) ?? 'none'}) ` +
            `and no usable defaultMaxTokens (${String(info.defaultMaxTokens)})`,
        )
      }
      reserved = info.defaultMaxTokens
    } else if (adapterDefaultMax) {
      if (!positiveInteger(info.defaultMaxTokens)) {
        return unfinished(
          `adapter-default maxTokens is unavailable for ${routeKeyOf(proposed)} ` +
            `(defaultMaxTokens=${String(info.defaultMaxTokens)}); refusing to reuse the inherited ${String(explicitMax)}`,
        )
      }
      reserved = info.defaultMaxTokens
    } else if (explicitMax !== undefined) {
      reserved = explicitMax
    } else if (positiveInteger(info.defaultMaxTokens)) {
      reserved = info.defaultMaxTokens
    } else {
      return unfinished(
        `no trustworthy output reservation for ${routeKeyOf(proposed)} ` +
          `(defaultMaxTokens=${String(info.defaultMaxTokens)}); refusing to assume zero`,
      )
    }
    let measurement
    try {
      measurement = measureAligned(session)
    } catch (error) {
      return unfinished(error?.message ?? String(error))
    }
    const meterTotal = measurement.totalTokens

    // Calibrate from the rejected request's own number when available; otherwise
    // use the conservative configured assumption. A low assumption makes the
    // summary request look smaller than it really is, which is exactly the
    // failure this guard exists to prevent.
    const previous = ratioBySession.get(session)
    const currentKey = calibrationKey(proposed)
    // A sample from another route must never authorize this one: switching
    // models changes the tokenizer, so the old ratio would mis-size the budget.
    const usablePrevious = previous !== undefined && previous.key === currentKey ? previous.ratio : undefined
    const assumed = Number(config.assumedRatio)
    let ratio = realPrompt === undefined
      ? (usablePrevious ?? (Number.isFinite(assumed) && assumed >= 1 ? assumed : 2))
      : calibrationRatio({ realPromptTokens: realPrompt, meterTotalTokens: meterTotal })
    if (realPrompt !== undefined) ratioBySession.set(session, { key: currentKey, ratio })
    // The transport heuristic must not be easier to trigger than the configured
    // assumption: a larger ratio yields a smaller wall, so this stays conservative.
    if (trigger === 'transport') {
      ratio = Math.max(ratio, Number.isFinite(assumed) && assumed >= 1 ? assumed : 2)
    }

    const meterMargin = Math.ceil(config.marginTokens / ratio)
    const meterWall = Math.floor((window - reserved) / ratio) - meterMargin
    if (meterWall <= 0) return unfinished(`no usable wall (window=${window}, reserved=${reserved}, ratio=${ratio})`)

    // Byte (character) budget: independent of the token wall. `0` disables it.
    const charsBudget = Number(config.requestCharsBudget) > 0 ? Number(config.requestCharsBudget) : 0
    const charsState = () => {
      if (charsBudget === 0) return { ok: true }
      const estimatedChars = estimateRequestChars(session, session?.requestHeader?.())
      if (estimatedChars === undefined) return { ok: true, unavailable: true }
      const estimateWithMargin = Math.ceil(estimatedChars * 1.1)
      return { ok: estimateWithMargin <= charsBudget, estimatedChars, estimateWithMargin, budget: charsBudget }
    }

    const calibrated = realPrompt !== undefined || usablePrevious !== undefined

    // A refusal we could not parse is not a calibration sample. Falling back to
    // the configured assumption here would silently treat a guess as a
    // measurement; refuse instead and say what is missing.
    if (trigger === 'refusal' && realPrompt === undefined && usablePrevious === undefined) {
      return unfinished(
        `context-window refusal without a parseable token count and no calibration for ${currentKey ?? 'this route'}`,
      )
    }
    const openingChars = charsState()
    if (meterTotal <= meterWall && openingChars.ok) return { recovered: false, changed: false }

    // A guessed ratio may only shrink anything on an explicit opt-in.
    const allowCompaction = switchMode || trigger !== 'pre-step' || config.proactive || calibrated
    if (!allowCompaction && !warnedUncalibrated.has(session)) {
      warnedUncalibrated.add(session)
      log(
        'info',
        `[restart-guard] over wall by assumption only (meter=${meterTotal} wall=${meterWall} ratio=${ratio.toFixed(2)}); ` +
          'proactive=false, waiting for a provider refusal before compacting',
      )
    }

    if (allowCompaction) {
      log(
        'info',
        `[restart-guard] over wall: meter=${meterTotal} wall=${meterWall} ratio=${ratio.toFixed(2)} ` +
          `(window=${window}, reserved=${reserved}, trigger=${trigger}, model=${currentKey}, source=${realPrompt !== undefined ? 'refusal' : usablePrevious !== undefined ? 'recalled' : 'assumed'})`,
      )
    }
    if (config.dryRun) {
      log('info', '[restart-guard] dryRun: would prune and compact; nothing changed')
      if (switchMode) return { recovered: false, changed: false, dryRunBlocked: true }
      return { recovered: false, changed: false }
    }

    let changed = false
    let attempts = 0
    let chunks = 0
    let recoveries = 0
    let transportRetries = 0
    let budgetScale = 1

    /**
     * The recovery cap must not leave a transaction open. Close one that this
     * turn demonstrably owns, then fail; if it belongs to another turn or a
     * manual run, report it as remaining instead of touching it.
     */
    const failAfterRecoveryCap = () => {
      const state = inspectCompaction(session)
      if (state.active) {
        const turn = currentOpenTurn(session)
        if (turn === null) {
          log('error', '[restart-guard] active compaction REMAINS: no open turn to own its close')
          return failure(`recovery cap ${config.maxRecoveryAttempts} reached; active transaction remains`, { activeRemains: true })
        }
        try {
          const repair = recoverActiveCompaction(session, turn, 'recovery cap')
          log(
            'warn',
            `[restart-guard] closed active compaction ${repair.start.seq} before failing ` +
              `(end=${repair.endEvent.seq}, bodyCommitted=${repair.bodyCommitted})`,
          )
        } catch (error) {
          log('error', `[restart-guard] active compaction REMAINS: ${error?.message ?? String(error)}`)
          return failure(`recovery cap ${config.maxRecoveryAttempts} reached; active transaction remains`, { activeRemains: true })
        }
      }
      return failure(`recovery cap ${config.maxRecoveryAttempts} reached`)
    }

    const failure = (reason, detail = {}) => {
      const final = ctx.tokenMeter.measure(session).totalTokens
      log('error', `[restart-guard] FAILED: ${reason}; ${JSON.stringify({ final, wall: meterWall, chunks, attempts, recoveries, ...detail })}`)
      return { recovered: false, changed, failed: true, reason, detail: { final, wall: meterWall, chunks, attempts, recoveries, ...detail } }
    }

    // Step 1: model-free floor.
    const pruner = presets.serviceFor?.(agent, 'toolResultPruner')
    if (typeof pruner?.pruneSession === 'function') {
      const prePrune = typeof summary.assertIntegrity === 'function' ? summary.assertIntegrity() : { ok: true }
      if (prePrune.ok !== true) return unfinished(`engine integrity check failed before prune: ${prePrune.reason}`)
      try {
        const beforePrune = ctx.tokenMeter.measure(session).totalTokens
        pruner.pruneSession(session)
        measurement = measureAligned(session)
        if (measurement.totalTokens < beforePrune) changed = true
      } catch (error) {
        log('warn', `[restart-guard] tool-result prune failed: ${error?.message ?? String(error)}`)
      }
      const prunedChars = charsState()
      if (measurement.totalTokens <= meterWall && prunedChars.ok) {
        log('info', `[restart-guard] pruned to ${measurement.totalTokens}; request may proceed`)
        return { recovered: changed, changed }
      }
    }

    if (!allowCompaction) {
      return { recovered: false, changed, skipped: 'uncalibrated' }
    }

    // Step 2: chunked compaction. Each call is sized with a conservative
    // summary budget and must start at the first non-system node.
    for (;;) {
      measurement = measureAligned(session)
      const total = measurement.totalTokens
      const currentTurn = currentOpenTurn(session)
      const loopChars = charsState()
      if (total <= meterWall && loopChars.ok) break
      if (!loopChars.ok && charsBudget > 0) {
        log('info', `[restart-guard] over chars budget: estimate=${loopChars.estimatedChars} margin=${loopChars.estimateWithMargin} budget=${loopChars.budget}`)
      }
      if (chunks >= config.maxChunks) return failure(`chunk cap ${config.maxChunks} reached`)
      if (attempts >= config.maxSummaryAttempts) return failure(`summary attempt cap ${config.maxSummaryAttempts} reached`)

      // A prior attempt may have died after appending start, after a committed
      // replacement, or before any body. Close it before planning again.
      const preState = inspectCompaction(session)
      if (preState.active) {
        recoveries += 1
        if (recoveries > config.maxRecoveryAttempts) return failAfterRecoveryCap()
        if (currentTurn === null) return failure('active compaction but no open turn to own its close')
        try {
          const repair = recoverActiveCompaction(session, currentTurn, 'pre-plan lock')
          log(
            'warn',
            `[restart-guard] recovered active compaction start ${repair.start.seq} ` +
              `(bodyCommitted=${repair.bodyCommitted}, end=${repair.endEvent.seq})`,
          )
        } catch (error) {
          return failure(`could not recover active compaction: ${error?.message ?? String(error)}`)
        }
        continue
      }

      const nodes = measurement.nodes
      if (!Array.isArray(nodes) || nodes.length === 0) return failure('empty surface measurement')

      let firstIdx
      try {
        firstIdx = firstCompactableIndex(session, nodes)
      } catch (error) {
        return failure(`unsafe first node: ${error?.message ?? String(error)}`)
      }
      if (nodes.length - firstIdx <= config.minTailNodes) return failure('nothing left to compact safely')

      const headSeq = nodeSeq(nodes[0])
      const head = headSeq === undefined ? undefined : session.eventAt(headSeq)
      const systemTokens = head?.type === 'system/message' ? (nodes[0].tokens ?? 0) : 0
      const toolsMeter = toolsPrice(session.requestHeader())
      // The summary request's own cap, resolved exactly as the engine resolves it.
    const reserve = summary.summaryMaxTokens
      const budget = summaryBudgetMeter({
        contextWindow: window,
        reservedCompletionTokens: reserve,
        marginTokens: config.marginTokens,
        ratio,
        toolsTokens: toolsMeter,
        systemTokens,
        instructionTokens: config.summaryInstructionTokens,
        safetyRatio: Math.min(0.95, Math.max(0.15, config.summaryBudgetRatio * budgetScale)),
      })
      if (budget <= 0) return failure(`summary budget is zero (reserve=${reserve}, tools=${toolsMeter}, system=${systemTokens})`)

      let balanced
      try {
        balanced = balanceAfter(session, nodes)
      } catch (error) {
        return failure(`could not balance surface: ${error?.message ?? String(error)}`)
      }

      const target = Math.ceil((total - meterWall) * 1.2) + 4096
      const plan = planChunk({
        nodes,
        balanced,
        firstIdx,
        budget,
        minTail: config.minTailNodes,
        targetTokens: target,
      })
      if (plan === null) {
        return failure(`no balanced chunk fits budget ${budget}; firstIdx=${firstIdx}, nodes=${nodes.length}`)
      }
      if (!Number.isInteger(plan.startIdx) || plan.startIdx < firstIdx || plan.startIdx >= nodes.length) {
        return failure(`planner returned an invalid start index ${plan.startIdx}`)
      }
      if (!Number.isInteger(plan.endIdx) || plan.endIdx < plan.startIdx || plan.endIdx >= nodes.length) {
        return failure(`planner returned an invalid end index ${plan.endIdx}`)
      }
      const startSeq = nodeSeq(nodes[plan.startIdx])
      const endSeq = nodeSeq(nodes[plan.endIdx])
      if (startSeq === undefined || endSeq === undefined) return failure('planner selected a node without a seq')
      if (head?.type === 'system/message' && startSeq === headSeq) {
        return failure(
          `refusing to shadow the system head at seq ${headSeq}; firstIdx=${firstIdx}, startIdx=${plan.startIdx}`,
        )
      }
      if (plan.tokens <= 0) return failure(`chunk has no priced content (${plan.startIdx}..${plan.endIdx})`)

      log(
        'info',
        `[restart-guard] chunk ${chunks + 1}: nodes ${plan.startIdx}..${plan.endIdx}, seq ${startSeq}..${endSeq}, ` +
          `~${plan.tokens} meter (~${Math.round(plan.tokens * ratio)} real), target ${target}, budget ${budget}`,
      )

      const preCompact = typeof summary.assertIntegrity === 'function' ? summary.assertIntegrity() : { ok: true }
      if (preCompact.ok !== true) return unfinished(`engine integrity check failed before compaction: ${preCompact.reason}`)
      attempts += 1
      const before = total
      let attemptError
      try {
        await engine.compactRegion(startSeq, endSeq, agent, signal)
      } catch (error) {
        attemptError = error
      }

      // The engine may have committed a replacement and then failed to append
      // compaction/end. Inspect the durable bracket rather than trusting the
      // thrown message.
      const postState = inspectCompaction(session)
      if (postState.active) {
        recoveries += 1
        if (recoveries > config.maxRecoveryAttempts) return failAfterRecoveryCap()
        if (currentTurn === null) return failure('active compaction but no open turn to own its close')
        try {
          const repair = recoverActiveCompaction(session, currentTurn, attemptError?.message ?? 'interrupted compaction')
          log(
            'warn',
            `[restart-guard] recovered active compaction start ${repair.start.seq} ` +
              `(bodyCommitted=${repair.bodyCommitted}, end=${repair.endEvent.seq}, source=${attemptError?.message ?? 'replacement committed but end missing'})`,
          )
          const after = measureAligned(session).totalTokens
          if (repair.bodyCommitted && after < before) {
            changed = true
            chunks += 1
            log('info', `[restart-guard] recovered chunk ${chunks}: ${before} -> ${after} meter`)
            continue
          }
        } catch (error) {
          return failure(`could not recover interrupted compaction: ${error?.message ?? String(error)}`)
        }
        continue
      }

      if (attemptError !== undefined) {
        const message = attemptError?.message ?? String(attemptError)
        if (signal?.aborted === true) return failure('cancelled during compaction')
        if (isContextLimit(message)) {
          budgetScale = Math.max(0.15, budgetScale * 0.6)
          log('warn', `[restart-guard] chunk rejected by the window; retrying with budget scale ${budgetScale.toFixed(2)}`)
          continue
        }
        if (isOutputLimit(message)) {
          budgetScale = Math.max(0.15, budgetScale * 0.6)
          log('warn', `[restart-guard] summary hit its output cap; retrying with smaller budget scale ${budgetScale.toFixed(2)}`)
          continue
        }
        if (isSurfaceChanged(message)) {
          log('warn', `[restart-guard] chunk surface changed; replanning: ${message}`)
          continue
        }
        if (isRetryableTransport(message)) {
          transportRetries += 1
          if (transportRetries > config.maxTransportRetries) {
            return failure(`transport retry cap ${config.maxTransportRetries} reached: ${message}`)
          }
          const delay = Math.min(
            config.transportBackoffMaxMs,
            config.transportBackoffMs * 2 ** (transportRetries - 1),
          )
          log(
            'warn',
            `[restart-guard] transient compaction failure ${transportRetries}/${config.maxTransportRetries}; ` +
              `retrying in ${delay}ms: ${message}`,
          )
          await sleep(delay, signal)
          if (signal?.aborted === true) return failure('cancelled during transport backoff')
          continue
        }
        return failure(`chunk failed: ${message}`)
      }

      const after = measureAligned(session).totalTokens
      log('info', `[restart-guard] after chunk ${chunks + 1}: ${before} -> ${after} meter (~${Math.round(after * ratio)} real)`)
      if (after >= before) return failure(`compaction made no progress (${before} -> ${after})`)
      changed = true
      chunks += 1
    }

    const final = measureAligned(session).totalTokens
    if (final > meterWall) {
      return failure(`still ${final} > ${meterWall} meter after ${chunks} chunks`)
    }
    const finalChars = charsState()
    if (!finalChars.ok) {
      return failure(
        `request chars budget not met: estimated=${finalChars.estimatedChars ?? 'n/a'} ` +
          `margin=${finalChars.estimateWithMargin ?? 'n/a'} budget=${charsBudget}`,
      )
    }
    if (charsBudget > 0) {
      log(
        'info',
        `[restart-guard] chars budget satisfied: estimate=${finalChars.estimatedChars} ` +
          `margin=${finalChars.estimateWithMargin} budget=${charsBudget}`,
      )
    }
    if (switchMode) {
      // The native handler re-measures with the NEW header before it decides.
      // Prove it will take its early-exit branch, or refuse to continue.
      const header = session?.requestHeader?.()
      const proposedHeader = { ...(header ?? {}), config: proposed }
      const nativeMeasure = ctx.tokenMeter.measure(session, proposedHeader).totalTokens
      const threshold = nativeThreshold({
        config: engine.config,
        contextWindow: window,
        reservedCompletionTokens: reserved,
      })
      if (!Number.isInteger(threshold) || threshold <= 0) {
        return failure(`cannot compute the native compaction threshold for ${routeKeyOf(proposed)}`)
      }
      if (nativeMeasure >= threshold) {
        return failure(
          `model-switch recovery left ${nativeMeasure} >= native threshold ${threshold}; refusing a second compaction`,
        )
      }
      log(
        'info',
        `[restart-guard] model-switch recovery settled at ${nativeMeasure} < native threshold ${threshold} ` +
          `(${routeKeyOf(proposed)}); native compaction will skip`,
      )
    }
    if (changed) {
      log('info', `[restart-guard] surface now ${final} <= ${meterWall} meter (~${Math.round(final * ratio)} real); request may proceed`)
    }
    return { recovered: changed, changed }
  }

  // Runs before the automatic compaction policy, and before the loop builds the request.
  // `modelSelection` is the step's fixed route 闂?the one the request will use 闂?  // while `session.requestHeader()` still names the previously recorded model
  // right after a switch.
  ctx.on(
    'agent/pre-step',
    async ({ agent, signal, modelSelection }, next) => {
      const route = routeOf(modelSelection)
      const headerConfig = agent?.session?.requestHeader?.()?.config
      const state = classifySwitch(route, headerConfig)
      const rejectStep = (reason, writes = false) => {
        log(
          'error',
          `[restart-guard] REJECT model switch: reason=${reason} ` +
            `proposed=${routeKeyOf(route) ?? 'none'} header=${routeKeyOf(routeOf(headerConfig)) ?? 'none'} writes=${writes}`,
        )
        return { kind: 'reject' }
      }
      try {
        if (state === 'unknown') return rejectStep('switch-state-unknown')
        if (state === 'switch') {
          if (config.switchRecovery !== true) {
            log('info', '[restart-guard] model switch detected but switchRecovery=false; leaving it to the native handler')
            return next()
          }
          const result = await guard(agent, signal, { trigger: 'model-switch', route, switchMode: true })
          if (result.dryRunBlocked === true) return rejectStep('dryRun_blocked_model_switch')
          if (result.failed === true) return rejectStep(result.reason ?? 'recovery-failed', result.changed === true)
          if (result.skipped !== undefined) return rejectStep(`guard-skipped:${result.skipped}`)
          return next()
        }
        if (route !== undefined) await guard(agent, signal, { trigger: 'pre-step', route })
      } catch (error) {
        log('error', `[restart-guard] guard failed: ${error?.message ?? String(error)}; continuing the turn`)
        if (state === 'switch') return rejectStep('guard-exception')
      }
      return next()
    },
    { prepend: true },
  )

  // A completed reply proves the chain recovered, so the streak restarts.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'assistant/message') transportStreak.delete(session)
  })

  // Safety net: the provider refused the request. A context-window refusal
  // carries the real prompt size, which is the calibration sample worth trusting.
  ctx.on(
    'agent/request-error',
    async ({ agent, failure, signal }, next) => {
      if (!config.enabled) return next()
      const session = agent?.session
      const code = failure?.code

      if (code === 'TRANSPORT') {
        if (!config.treatTransportAsOverflow) return next()
        if (session === undefined) return next()
        // A streak belongs to one request chain. A new turn starts at zero, so
        // an unrelated earlier failure can never accumulate into this one.
        const turn = currentOpenTurn(session)
        const prior = transportStreak.get(session)
        const count = prior !== undefined && prior.turn === turn ? prior.count + 1 : 1
        transportStreak.set(session, { turn, count })
        const need = Math.max(2, config.transportOverflowConsecutive)
        if (count < need) {
          log('info', `[restart-guard] TRANSPORT ${count}/${need} on turn ${String(turn)}; not treated as overflow yet`)
          return next()
        }
        // Repeated TRANSPORTs alone are not evidence of size: without a provider
        // sample for this exact route there is no trusted unit, and
        // `assumedRatio` must never authorize a chunked compaction.
        if (!hasCalibrationForCurrentRoute(session)) {
          transportStreak.delete(session)
          log(
            'info',
            '[restart-guard] TRANSPORT streak reached without a provider calibration for this route; not compacting',
          )
          return next()
        }
        try {
          const result = await guard(agent, signal, { trigger: 'transport', route: routeOf(session.requestHeader?.()?.config) })
          if (result?.recovered === true) {
            transportStreak.delete(session)
            return { kind: 'retry' }
          }
        } catch (error) {
          log('error', `[restart-guard] transport heuristic failed: ${error?.message ?? String(error)}`)
        }
        // The evidence did not hold: clear the streak so a later lone TRANSPORT
        // cannot fire on the strength of this chain's earlier count.
        transportStreak.delete(session)
        log('info', '[restart-guard] TRANSPORT streak did not yield an over-wall surface; leaving the error as-is')
        return next()
      }

      if (code !== CONTEXT_WINDOW_EXCEEDED) return next()
      const parsed = realPromptFrom(failure)
      if (config.dryRun) {
        log('info', `[restart-guard] dryRun: refusal reports ${parsed ?? 'unknown'} real prompt tokens; would calibrate and compact`)
        return next()
      }
      try {
        const result = await guard(agent, signal, { trigger: 'refusal', realPrompt: parsed, route: routeOf(session?.requestHeader?.()?.config) })
        if (result?.recovered === true) return { kind: 'retry' }
      } catch (error) {
        log('error', `[restart-guard] overflow recovery failed: ${error?.message ?? String(error)}`)
      }
      return next()
    },
    { prepend: true },
  )
}
