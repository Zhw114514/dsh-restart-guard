/**
 * Pure route resolution for the guard: which model the upcoming request uses,
 * which model the identified engine will summarise with, and which summary
 * budget that implies. The engine *identity* is supplied by `identity.js`; this
 * module only maps a proven profile onto the routing rules it implies.
 *
 * @module dsh-restart-guard/route
 */

/** Normalise a `{provider, model}` pair, or undefined when incomplete. */
export function routeOf(source) {
  if (source === undefined || source === null) return undefined
  const provider = source.provider
  const model = source.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

export function routeKeyOf(route) {
  return route === undefined ? undefined : `${route.provider}/${route.model}`
}

/** Route that produced the latest assistant message, as the engine records it. */
export function answeredRouteOf(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    return routeOf(event.data?.message?.source)
  }
  return undefined
}

export function policyFor(engineConfig, route) {
  const policies = Array.isArray(engineConfig?.modelPolicies) ? engineConfig.modelPolicies : []
  return policies.find((entry) => entry?.provider === route.provider && entry?.model === route.model)
}

/**
 * Resolve the summary route and its request cap the way the identified engine
 * will. `identity` must come from `identifyEngine()`: an exact release
 * fingerprint, never a capability guess.
 *
 * @returns `{unknown:true, reason}` when identity is unproven, the pin
 *   contradicts it, the conversation is unresolvable, or the summary cap is not
 *   a positive integer. Never guesses.
 */
export function resolveSummaryPlan({ agent, engine, session, identity, pinnedMode = 'auto' }) {
  if (identity === undefined || identity.unknown === true) {
    return { unknown: true, reason: identity?.reason ?? 'engine identity unavailable' }
  }
  const profile = identity.profile
  if (pinnedMode !== 'auto' && pinnedMode !== profile) {
    return {
      unknown: true,
      reason: `engineRouteMode=${pinnedMode} does not match the identified release ${identity.version} (${profile})`,
    }
  }

  const headerRoute = routeOf(session?.requestHeader?.()?.config)
  const optionsRoute = routeOf(agent?.options)
  const answered = profile === 'v023' ? answeredRouteOf(session) : undefined
  const conversation =
    profile === 'v023' ? (answered ?? headerRoute ?? optionsRoute) : (headerRoute ?? optionsRoute)
  if (conversation === undefined) return { unknown: true, reason: 'no conversation route for policy resolution' }

  // `summarize()` resolves the policy by the *conversation* route, and
  // `summarizeWithLlm()` then uses that policy's `maxTokens`.
  const override = policyFor(engine?.config, conversation)
  const provider = override?.summarizationProvider ?? engine?.config?.summarizationProvider
  const model = override?.summarizationModel ?? engine?.config?.summarizationModel
  const configured = routeOf({ provider, model })
  const summaryMaxTokens = override?.maxTokens ?? engine?.config?.maxTokens
  if (!Number.isInteger(summaryMaxTokens) || summaryMaxTokens <= 0) {
    return { unknown: true, reason: `summary maxTokens is not a positive integer (${String(summaryMaxTokens)})` }
  }
  return {
    route: configured ?? conversation,
    conversation,
    version: identity.version,
    profile,
    configured: configured !== undefined,
    summaryMaxTokens,
  }
}
