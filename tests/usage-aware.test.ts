import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

const T0 = Date.parse('2026-10-14T02:25:00Z')
const TOOL = 'mcp__usage-aware__usage'

const limitsAt = (fiveHour: number) => [
  { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2026-10-14T04:30:00Z' },
  { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-10-17T10:00:00Z' },
]

// A negative level is a session whose first response has not finished: no reading yet.
function usageAt(fiveHour: number): SessionUsage {
  return {
    startedAt: T0,
    context: { window: 200_000 } as SessionUsage['context'],
    rateLimits: fiveHour < 0 ? [] : limitsAt(fiveHour),
    cost: { usd: 3.21 },
  }
}

// The engine beneath the plugin: usage at a level the test moves, and recorders for what reaches the bottom.
function world(on: On, level: { pct: number }, stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored)
  const submitted: { text: string; context?: readonly string[] }[] = []
  on('session.usage', () => ({ value: usageAt(level.pct) }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.notify', () => ({ value: { isSent: true, channel: 'test' } }) as never)
  on('prompt.submit', (_$, e) => {
    submitted.push({ text: e.text, context: e.context })
    return { text: e.text } as never
  })
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  return { clock, submitted }
}

const text = (r: unknown) => String((r as { result?: unknown; deny?: string }).result ?? (r as { deny?: string }).deny)

test('the tool reports each window, its reset and the cost', async ($, on) => {
  world(on, { pct: 32 })
  const r = await $.tool.call({ tool: TOOL, action: 'read' } as never)
  expect(text(r)).toContain('5h window: 32% used, resets in 2h05m')
  expect(text(r)).toContain('7d window: 41% used, resets in 3d7h')
  expect(text(r)).toContain('$3.21')
})

test('every prompt carries the figures as context', async ($, on) => {
  const { submitted } = world(on, { pct: 32 })
  await $.prompt.submit({ text: 'hi', wait: false } as never)
  expect(submitted[0]?.context?.join('\n')).toContain('5h 32% ↻2h05m · 7d 41% ↻3d7h · $3.21')
})

test('new agents are blocked past the stop line until the operator allows them', async ($, on) => {
  world(on, { pct: 92 })
  const blocked = await $.tool.call({ tool: 'Agent', prompt: 'review', description: 'r' } as never)
  expect(text(blocked)).toContain('no new agents')
  await $.tool.call({ tool: TOOL, action: 'allow_agents' } as never)
  const allowed = await $.tool.call({ tool: 'Agent', prompt: 'review', description: 'r' } as never)
  expect(text(allowed)).toBe('ran')
})

test('crossing a line leaves one notice on the next main-loop tool result', async ($, on) => {
  world(on, { pct: 80 })
  await $.session.measure({ context: {} as never, rateLimits: usageAt(80).rateLimits, changed: ['rateLimits'] } as never)
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect((first as { context?: string[] }).context?.join('\n')).toContain('crossed 75%')
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect((second as { context?: string[] }).context).toBeUndefined()
})

test('an armed resume submits its prompt once the window has reset', async ($, on) => {
  const { clock, submitted } = world(on, { pct: 95 })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await $.tool.call({ tool: TOOL, action: 'resume_after_reset', prompt: 'Continue the release from PROGRESS.md.' } as never)
  await clock.advance(2 * 3_600_000)
  expect(submitted.length).toBe(0)
  await clock.advance(10 * 60_000)
  expect(submitted.map(s => s.text).join('\n')).toContain('Continue the release from PROGRESS.md.')
})

test('a main-loop turn that dies at the limit arms its own resume', async ($, on) => {
  world(on, { pct: 100 })
  await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  const r = await $.tool.call({ tool: TOOL, action: 'read' } as never)
  expect(text(r)).toContain('armed resume: after the 5h reset')
})

test('a session with no reading yet is gated on the last reading another session saw', async ($, on) => {
  world(on, { pct: -1 }, { lastLimits: limitsAt(95) })
  const blocked = await $.tool.call({ tool: 'Agent', prompt: 'review', description: 'r' } as never)
  expect(text(blocked)).toContain('no new agents')
})

test('a stored reading past its reset gates nothing', async ($, on) => {
  world(on, { pct: -1 }, { lastLimits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-10-14T01:00:00Z' }] })
  const allowed = await $.tool.call({ tool: 'Agent', prompt: 'review', description: 'r' } as never)
  expect(text(allowed)).toBe('ran')
})

test('each reading is kept, and gates a session that has none of its own yet', async ($, on) => {
  const level = { pct: 92 }
  world(on, level)
  await $.session.measure({ context: {} as never, rateLimits: limitsAt(92), changed: ['rateLimits'] } as never)
  level.pct = -1
  const blocked = await $.tool.call({ tool: 'Agent', prompt: 'review', description: 'r' } as never)
  expect(text(blocked)).toContain('no new agents')
})

test('the first prompt of a session carries the last reading, marked as earlier', async ($, on) => {
  const { submitted } = world(on, { pct: -1 }, { lastLimits: limitsAt(32) })
  await $.prompt.submit({ text: 'hi', wait: false } as never)
  expect(submitted[0]?.context?.join('\n')).toContain('5h 32% ↻2h05m · 7d 41% ↻3d7h · $3.21 (last reading, from an earlier session)')
})
