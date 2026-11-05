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
  // The number the last judged prompt was given: a prompt absorbed into
  // the running turn adds no user turn, so session.turns() alone would give
  // the next one the same number.
  lastTurn: number
  usage: Usage
}

declare module 'claude-code' {
  interface PluginState {
    'mind-stack': { mind: Shaped<Mind> }
  }
}
