export type Band = 'ok' | 'low' | 'stop'

export type Resume = { at: number; prompt: string; window: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-aware': {
      band: Band
      pendingNotice: string | null
      resume: Resume | null
      override: { until: number } | null
    }
  }
}
