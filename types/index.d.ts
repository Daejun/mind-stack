export type Topic = { label: string; turn: number }

export type Usage = {
  calls: number
  failures: number
  inputTokens: number
  outputTokens: number
}

export type Mind = {
  stack: Topic[]
  history: Topic[]
  isAuto: boolean
  isHeld: boolean
  isJudging: boolean
  columns: number
  usage: Usage
}

declare module 'claude-code' {
  interface PluginState {
    'mind-stack': { mind: Shaped<Mind> }
  }
}
