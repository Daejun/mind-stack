import type { Mind, Topic } from '../types'

export type Verdict =
  | { action: 'same' }
  | { action: 'push'; label: string }
  | { action: 'pop'; to: number }
  | { action: 'switch'; label: string }

export const EMPTY: Mind = {
  stack: [],
  history: [],
  isAuto: true,
  isHeld: false,
  isJudging: false,
  columns: 80,
  usage: { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 },
}

const HISTORY_CAP = 50
const LABEL_WIDTH = 24
const SEP = ' → '

export const RULES = `You track the topic stack of a conversation between a developer and a coding assistant.
The stack lists the topics from the one the developer started with (index 0) down to the one in progress (the last index).
Given the stack, the end of the assistant's last reply and the developer's new message, decide what the new message does:

- "same": it continues the topic in progress (follow-ups, confirmations, small corrections, the next step of the same work).
- "push": it opens a sub-problem that came up while working on the topic in progress (an obstacle, a side question, a tool or environment problem). Give it a label.
- "pop": it goes back to an earlier topic of the stack, the ones above it being done or dropped. "to" is that topic's index.
- "switch": it starts work unrelated to every topic of the stack. Give it a label.

When the stack is empty, answer "push" with a label for the new message.
When unsure, answer "same".

A label is a noun phrase of 2 to 4 words, at most about 16 characters, in the language the developer writes in.
Keep technical terms, commands and identifiers in English as the developer writes them, and reuse the developer's own words.

Answer with one JSON object and nothing else:
{"action": "same" | "push" | "pop" | "switch", "to": <index, for pop>, "label": "<label, for push and switch>"}`

export function request(stack: Topic[], reply: string, prompt: string): string {
  const listed =
    stack.length === 0
      ? '(empty)'
      : stack.map((t, i) => `${i}: ${t.label}`).join('\n')

  return [
    `<stack>\n${listed}\n</stack>`,
    `<assistant_last_reply_end>\n${reply.slice(-400)}\n</assistant_last_reply_end>`,
    `<new_message>\n${prompt.slice(0, 600)}\n</new_message>`,
  ].join('\n\n')
}

export function cleanLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const label = raw.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim()
  if (label === '') {
    return undefined
  }

  return cut(label, LABEL_WIDTH)
}

export function parseVerdict(text: string, depth: number): Verdict | undefined {
  const found = text.match(/\{[\s\S]*\}/)
  if (!found) {
    return undefined
  }
  let raw: { action?: unknown; to?: unknown; label?: unknown }
  try {
    raw = JSON.parse(found[0])
  } catch {
    return undefined
  }
  const label = cleanLabel(raw.label)

  switch (raw.action) {
    case 'same':
      return { action: 'same' }
    case 'push':
    case 'switch':
      return label === undefined ? undefined : { action: raw.action, label }
    case 'pop': {
      const to = Number(raw.to)

      return Number.isInteger(to) && to >= 0 && to < depth
        ? { action: 'pop', to }
        : undefined
    }
    default:
      return undefined
  }
}

function closed(history: Topic[], done: Topic[]): Topic[] {
  return [...history, ...done].slice(-HISTORY_CAP)
}

export function apply(mind: Mind, v: Verdict, turn: number): Mind {
  const { stack, history } = mind

  if (stack.length === 0) {
    return v.action === 'push' || v.action === 'switch'
      ? { ...mind, stack: [{ label: v.label, turn }] }
      : mind
  }

  switch (v.action) {
    case 'same':
      return mind
    case 'push':
      return stack.at(-1)?.label === v.label
        ? mind
        : { ...mind, stack: [...stack, { label: v.label, turn }] }
    case 'pop':
      return {
        ...mind,
        stack: stack.slice(0, v.to + 1),
        history: closed(history, stack.slice(v.to + 1)),
      }
    case 'switch':
      return {
        ...mind,
        stack: [{ label: v.label, turn }],
        history: closed(history, stack),
      }
  }
}

function cellWidth(cp: number): number {
  const isWide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)

  return isWide ? 2 : 1
}

export function width(s: string): number {
  let w = 0
  for (const ch of s) {
    w += cellWidth(ch.codePointAt(0) ?? 0)
  }

  return w
}

function cut(s: string, max: number): string {
  if (width(s) <= max) {
    return s
  }
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = cellWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > max - 1) {
      break
    }
    out += ch
    w += cw
  }

  return out + '…'
}

// Root and current always stay; the middle gives way first.
export function trail(stack: Topic[], budget: number): string {
  const labels = stack.map(t => t.label)
  const full = labels.join(SEP)
  if (labels.length <= 2 || width(full) <= budget) {
    return full
  }

  const [root = '', ...rest] = labels
  const suffix = ` (${labels.length})`
  const tail: string[] = []
  let used = width(root + SEP + '…' + suffix)
  for (const label of [...rest].reverse()) {
    const w = width(SEP + label)
    if (tail.length > 0 && used + w > budget) {
      break
    }
    tail.unshift(label)
    used += w
  }

  return tail.length === rest.length
    ? full
    : [root, '…', ...tail].join(SEP) + suffix
}

// The engine heads the line with the mod's name ("mind-stack: "), so the
// line itself is the trail alone.
const ENGINE_PREFIX = 'mind-stack: '

export function statusText(mind: Mind): string | undefined {
  if (mind.stack.length === 0) {
    return mind.isJudging ? '…' : undefined
  }
  const suffix = (mind.isAuto ? '' : ' (manual)') + (mind.isJudging ? ' …' : '')
  const budget =
    Math.max(30, Math.min(mind.columns - 10, 120)) - width(ENGINE_PREFIX + suffix)

  return trail(mind.stack, budget) + suffix
}

export function listing(mind: Mind): string {
  const lines: string[] = []
  if (mind.stack.length === 0) {
    lines.push('stack: (비어 있음)')
  } else {
    lines.push('stack:')
    mind.stack.forEach((t, i) => {
      const mark = i === mind.stack.length - 1 ? '  <- 지금' : ''
      lines.push(`  ${i + 1}. ${t.label} (prompt #${t.turn})${mark}`)
    })
  }
  const done = mind.history.slice(-10)
  if (done.length > 0) {
    lines.push(`끝난 곁가지 (최근 ${done.length}개): ${done.map(t => t.label).join(', ')}`)
  }
  const u = mind.usage
  lines.push(
    `자동 판정: ${mind.isAuto ? '켜짐' : '꺼짐'}, haiku 호출 ${u.calls}회 (실패 ${u.failures}), ` +
      `input ${u.inputTokens} / output ${u.outputTokens} token`,
  )

  return lines.join('\n')
}
