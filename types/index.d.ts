export type Topic = { label: string; turn: number }

export type Usage = {
  calls: number
  failures: number
  // All input tokens, those read from the prompt cache among them.
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export type Mind = {
  stack: Topic[]
  history: Topic[]
  isAuto: boolean
  isHeld: boolean
  isJudging: boolean
  // A switch kept the root: the next switch, with no return to the root
  // before it, replaces the root.
  isRootDoubted: boolean
  usage: Usage
}

declare module 'claude-code' {
  interface PluginState {
    'mind-stack': { mind: Shaped<Mind> }
  }
}
