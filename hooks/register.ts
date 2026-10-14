import type { EngineInterface, Register, SessionCost, SessionRateLimit } from 'claude-code'

import type { Band, Resume } from '../types'

// Thresholds on the fullest window (five_hour or seven_day), percent used.
const LOW = 75 // past this: say so, prefer no new fan-out
const STOP = 90 // past this: new agents are blocked until the operator says yes
const CUT_OFF = 98 // a turn that dies past this was cut off by the limit
const SLACK_MS = 90_000 // wait this long past resetsAt before resuming
const TICK_MS = 60_000

const TOOL = 'mcp__usage-aware__usage'
const GATED = new Set(['Agent', 'Workflow'])
const RANK: Record<Band, number> = { ok: 0, low: 1, stop: 2 }
const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

const bandRef = { plugin: 'usage-aware', key: 'band' } as const
const noticeRef = { plugin: 'usage-aware', key: 'pendingNotice' } as const
const resumeRef = { plugin: 'usage-aware', key: 'resume' } as const
const overrideRef = { plugin: 'usage-aware', key: 'override' } as const

type Input = { action?: string; prompt?: string }

const label = (w: SessionRateLimit) => LABEL[w.kind] ?? w.kind

const fullest = (limits: readonly SessionRateLimit[]) =>
  limits.reduce<SessionRateLimit | undefined>(
    (top, w) => (top === undefined || w.percentUsed > top.percentUsed ? w : top),
    undefined,
  )

const bandOf = (pct: number): Band => (pct >= STOP ? 'stop' : pct >= LOW ? 'low' : 'ok')

export function until(iso: string | undefined, now: number): string {
  if (iso === undefined) return 'unknown'
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'now'
  const mins = Math.floor(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

export function statusLine(limits: readonly SessionRateLimit[], cost: SessionCost | undefined, now: number) {
  const parts = limits.map(w => `${label(w)} ${w.percentUsed}% ↻${until(w.resetsAt, now)}`)
  if (cost !== undefined) parts.push(`$${cost.usd.toFixed(2)}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export function figures(limits: readonly SessionRateLimit[], cost: SessionCost | undefined, now: number) {
  const lines = limits.map(
    w => `${label(w)} window: ${w.percentUsed}% used, resets in ${until(w.resetsAt, now)} (${w.resetsAt ?? 'reset time unknown'})`,
  )
  if (cost !== undefined) lines.push(`this session so far: $${cost.usd.toFixed(2)} (subagents included)`)
  return lines.join('\n')
}

const GUIDANCE: Record<Band, string> = {
  ok: '',
  low:
    'Usage is getting low. Finish what is running, avoid new fan-out (parallel agents, workflows, big reviews) unless the operator agrees, and checkpoint long jobs as you go.',
  stop:
    'Usage is nearly out. New agents are blocked. Finish the current step, write a checkpoint (progress file, ledger), then call the usage tool with action resume_after_reset and a continuation prompt so the session picks itself up after the reset. If the operator may want to spend the rest anyway, ask them through AskUserQuestion with the figures in the question; on a yes, call the usage tool with action allow_agents.',
}

async function overrideActive($: EngineInterface, now: number) {
  const { value } = await $.state.get(overrideRef)
  return value != null && value.until > now
}

// Moves the band when a window moved; a rise leaves a notice for the main loop's next tool result.
async function reband($: EngineInterface, limits: readonly SessionRateLimit[], cost: SessionCost | undefined, now: number) {
  const top = fullest(limits)
  if (top === undefined) return
  const band = bandOf(top.percentUsed)
  const { value: was = 'ok' } = await $.state.get(bandRef)
  if (band === was) return
  await $.state.set(bandRef, band)
  if (RANK[band] < RANK[was]) {
    await $.state.set(noticeRef, null)
    if (band === 'ok') await $.state.set(overrideRef, null)
    return
  }
  await $.state.set(noticeRef, `[usage-aware] ${label(top)} window crossed ${band === 'stop' ? STOP : LOW}%.\n${figures(limits, cost, now)}\n${GUIDANCE[band]}`)
  $.ui.toast(`usage-aware: ${label(top)} at ${top.percentUsed}%, resets in ${until(top.resetsAt, now)}`)
}

async function arm($: EngineInterface, prompt: string, limits: readonly SessionRateLimit[]): Promise<Resume | undefined> {
  const top = fullest(limits.filter(w => w.resetsAt !== undefined))
  if (top?.resetsAt === undefined) return undefined
  const resume: Resume = { at: Date.parse(top.resetsAt) + SLACK_MS, prompt, window: label(top) }
  await $.state.set(resumeRef, resume)
  return resume
}

async function tick($: EngineInterface) {
  const { value: resume } = await $.state.get(resumeRef)
  if (resume == null || (await $.clock.now()) < resume.at) return
  await $.state.set(resumeRef, null)
  await $.state.set(overrideRef, null)
  $.ui.toast('usage-aware: the window reset, resuming')
  await $.prompt.submit({ text: `[usage-aware] The ${resume.window} usage window has reset. ${resume.prompt}` })
}

async function serve($: EngineInterface, input: Input) {
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const action = input.action ?? 'read'

  if (action === 'resume_after_reset') {
    if (!input.prompt) return { deny: 'usage-aware: resume_after_reset needs a prompt: what the session should do once the window resets.' }
    const resume = await arm($, input.prompt, usage.rateLimits)
    if (resume === undefined) return { deny: 'usage-aware: no rate-limit window with a reset time has been reported yet, so there is nothing to wait for.' }
    return { result: `Armed. When the ${resume.window} window resets (${new Date(resume.at).toISOString()}, in ${until(new Date(resume.at).toISOString(), now)}), this session submits:\n${resume.prompt}\nThis only fires while the session stays open.` }
  }
  if (action === 'cancel_resume') {
    await $.state.set(resumeRef, null)
    return { result: 'The armed resume is cancelled.' }
  }
  if (action === 'allow_agents') {
    const top = fullest(usage.rateLimits.filter(w => w.resetsAt !== undefined))
    const untilAt = top?.resetsAt !== undefined ? Date.parse(top.resetsAt) : now + 5 * 3_600_000
    await $.state.set(overrideRef, { until: untilAt })
    return { result: `New agents are allowed again until ${new Date(untilAt).toISOString()}. Only use this after the operator said yes.` }
  }

  const { value: resume } = await $.state.get(resumeRef)
  const { value: band = 'ok' } = await $.state.get(bandRef)
  if (usage.rateLimits.length === 0)
    return { result: `No rate-limit reading yet (none until the first response of this session, and none off a subscription).${usage.cost ? `\nThis session so far: $${usage.cost.usd.toFixed(2)}` : ''}` }
  return {
    result: [
      figures(usage.rateLimits, usage.cost, now),
      `band: ${band} (low from ${LOW}%, agents blocked from ${STOP}%)${(await overrideActive($, now)) ? ', operator override active' : ''}`,
      resume ? `armed resume: after the ${resume.window} reset, ${new Date(resume.at).toISOString()}` : 'no resume armed',
    ].join('\n'),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'usage',
      description:
        "Read this session's plan usage: percent used of the 5-hour and 7-day windows, when each resets, and what the session has cost. " +
        'Call it whenever the user asks how much usage is left, and before starting expensive fan-out. ' +
        'Other actions: resume_after_reset (with prompt) makes this session submit that prompt once the fullest window resets, so a job the limit stops picks itself up; ' +
        'cancel_resume drops it; allow_agents lifts the new-agent block for the current window, only after the operator said yes.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'resume_after_reset', 'cancel_resume', 'allow_agents'] },
          prompt: { type: 'string', description: 'For resume_after_reset: the continuation prompt, naming the checkpoint to resume from.' },
        },
      },
      isDeferred: false,
    })
    $.clock.every(TICK_MS, () => void tick($))
    const usage = await $.session.usage()
    $.ui.status(statusLine(usage.rateLimits, usage.cost, await $.clock.now()))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    $.ui.status(statusLine(e.rateLimits, e.cost, now))
    if (e.changed.includes('rateLimits')) await reband($, e.rateLimits, e.cost, now)
    return next(e)
  })

  // Every prompt carries the figures, so the model steers without having to ask.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) return next(e)
    const usage = await $.session.usage()
    const top = fullest(usage.rateLimits)
    if (top === undefined) return next(e)
    const now = await $.clock.now()
    const line = `[usage-aware] ${statusLine(usage.rateLimits, usage.cost, now)}. ${GUIDANCE[bandOf(top.percentUsed)]}`.trim()
    await $.state.set(noticeRef, null)
    return next({ ...e, context: [...(e.context ?? []), line] })
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL) return serve($, e as unknown as Input)

    if (GATED.has(e.tool)) {
      const usage = await $.session.usage()
      const top = fullest(usage.rateLimits)
      const now = await $.clock.now()
      if (top !== undefined && top.percentUsed >= STOP && !(await overrideActive($, now)))
        return {
          deny: `usage-aware: the ${label(top)} window is at ${top.percentUsed}% (resets in ${until(top.resetsAt, now)}), so no new agents. ${GUIDANCE.stop}`,
        }
    }

    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true) return ran
    const { value: notice } = await $.state.get(noticeRef)
    if (!notice) return ran
    await $.state.set(noticeRef, null)
    return { ...ran, context: [...(ran.context ?? []), notice] }
  }).catch(($, e, next) => (next.called || e.tool !== TOOL ? next(e) : { deny: 'usage-aware: the usage tool failed.' }))

  // A main-loop turn that dies at the limit arms its own resume, unless one is armed already.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || e.reason === 'aborted') return next(e)
    const usage = await $.session.usage()
    const top = fullest(usage.rateLimits)
    const looksCut = e.reason === 'error' || /usage limit|hit your limit|limit reached/i.test(e.answer)
    if (top === undefined || top.percentUsed < CUT_OFF || !looksCut) return next(e)
    const { value: armed } = await $.state.get(resumeRef)
    if (armed == null) {
      const resume = await arm(
        $,
        'The limit cut off the last turn mid-task. Re-read where it got to (the transcript tail, any progress or checkpoint files it wrote) and carry on with the task; if it was already finished, say so and stop.',
        usage.rateLimits,
      )
      if (resume !== undefined) {
        const now = await $.clock.now()
        void $.ui.notify(`Cut off at the ${resume.window} limit; resuming in ${until(new Date(resume.at).toISOString(), now)}.`)
      }
    }
    return next(e)
  })
}
