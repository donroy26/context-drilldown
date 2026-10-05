export type Tab = 'overview' | 'messages' | 'tools' | 'skills' | 'memory'
export type Part = { label: string; tokens: number; preview: string; isError?: boolean; path?: string }
export type Row = { label: string; detail: string; tokens: number; dim?: boolean; parts?: Part[]; path?: string }
export type Live = { percent: number; tokens: number; window: number }
export type Snapshot = {
  at: number
  exact: boolean
  model: string
  total: number
  max: number
  percent: number
  rows: Record<Tab, Row[]>
}

declare module 'claude-code' {
  interface PluginState {
    'context-x': { tab: Tab; snap: Snapshot | null; busy: boolean; open: number | null; live: Live | null }
  }
}
