import type { Mind, Topic } from '../types'

export type Verdict =
  | { action: 'same' }
  | { action: 'push'; label: string }
  | { action: 'pop'; to: number }
  | { action: 'sibling'; to: number; label: string }
  | { action: 'switch'; label: string }

export const EMPTY: Mind = {
  stack: [],
  history: [],
  isAuto: true,
  isHeld: false,
  isJudging: false,
  isRootDoubted: false,
  lastTurn: 0,
  usage: { calls: 0, failures: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
}

const HISTORY_CAP = 10
const LABEL_WIDTH = 24
export const SEP = ' → '
// The fewest cells the root keeps when the current topic needs the room.
const ROOT_MIN = 6

export const RULES = `You track the topic stack of a conversation between a developer and a coding assistant.
The stack lists the topics from the one the developer started with (index 0) down to the one in progress (the last index).
Each topic came up while working on the one before it.

Decide what the developer's new message does, in two steps.

Step 1. Find the topic T the new message belongs to: the deepest topic of the stack that the message is about or that the message's problem came out of.
If it belongs to no topic of the stack, answer "switch" with a label.

Step 2. Decide whether the message continues T's own work or opens a new, narrower problem under T.
- Continues T, and T is the last topic: "same".
- Continues T, and T is an earlier topic: "pop" with "to" = T's index. The topics above T are done.
- Opens a new problem under T, and T is the last topic: "push" with a label.
- Opens a new problem under T, and T is an earlier topic: "sibling" with "to" = T's index and a label. The topics above T are done.

A message about something the topic in progress does not cover does not belong to it, even when it comes right after it.
When the stack is empty, answer "push" with a label for the new message.
"same" is only a follow-up, a correction or an acknowledgement about the request the last reply was working on.
A message that accepts, answers or picks from what the last reply proposed or asked ("ok", "do that", "option 2") means that proposal, or the option it picks: judge the proposal as if the developer had written it, and take the label from the proposal's words. Accepting the next step of the request the last reply was working on is "same".
A message that asks for a different thing (another command, question, file or component) opens a topic, even in the same area.

For example, with the stack "0: fio bench", "1: lease wait":
"the lease is held by whom?" is {"action": "same"};
"why does lease-master print nothing?" is {"action": "push", "label": "lease-master"};
"the lease works now, run the bench again" is {"action": "pop", "to": 0};
"the lease works now. why does the bench output lack the latency column?" is {"action": "sibling", "to": 0, "label": "latency column"};
"let's write the weekly report" is {"action": "switch", "label": "weekly report"}.

A label is a noun phrase of 2 to 4 words, at most about 16 characters, in the language the developer writes in.
Name the specific task or problem the message opens, not the area it belongs to:
"#512 review reply" rather than "PR work", "lease wait" rather than "bench setup".
Write the label in the language of the new message, whatever the language of these examples or of the stack.
Keep technical terms, commands and identifiers in English as the developer writes them, and reuse the developer's own words.

Answer with one JSON object and nothing else:
{"action": "same" | "push" | "pop" | "sibling" | "switch", "to": <index, for pop and sibling>, "label": "<label, for push, sibling and switch>"}`

const REPLY_END = 400
// A reply that ends asking is sent longer, so the options it lists before
// the question come along: "1번 진행해" names one of them.
const ASKING_REPLY_END = 800
const ASK_SCAN = 300
const ASKS = /(\?|까요|주세요|주십시오|할지|정해|원하시면|알려)[^\p{L}\p{N}_]*$/u

// The last reply ends with a question or a proposal for the developer.
export function isAsking(reply: string): boolean {
  return ASKS.test(reply.slice(-ASK_SCAN).replace(/[\s*`_)\]]+$/u, ''))
}

export function request(stack: Topic[], reply: string, prompt: string): string {
  const end = isAsking(reply) ? ASKING_REPLY_END : REPLY_END
  const listed =
    stack.length === 0
      ? '(empty)'
      : stack.map((t, i) => `${i}: ${t.label}`).join('\n')

  return [
    `<stack>\n${listed}\n</stack>`,
    `<assistant_last_reply_end>\n${reply.slice(-end)}\n</assistant_last_reply_end>`,
    `<new_message>\n${prompt.slice(0, 600)}\n</new_message>`,
  ].join('\n\n')
}

function tidy(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const label = raw.replace(/["'`]/g, '').replace(/\s+/g, ' ').trim()

  return label === '' ? undefined : label
}

export function cleanLabel(raw: unknown): string | undefined {
  const label = tidy(raw)

  return label === undefined ? undefined : cut(label, LABEL_WIDTH)
}

type RawVerdict = { action?: unknown; to?: unknown; label?: unknown }

function verdictJson(text: string): RawVerdict | undefined {
  const found = text.match(/\{[\s\S]*\}/)
  if (!found) {
    return undefined
  }
  try {
    return JSON.parse(found[0])
  } catch {
    return undefined
  }
}

// The label of an answer when it is wider than a label may be, before
// cleanLabel cuts its end off.
export function longLabel(text: string): string | undefined {
  const label = tidy(verdictJson(text)?.label)

  return label !== undefined && width(label) > LABEL_WIDTH ? label : undefined
}

// The request asked again when the answer's label is too wide: the same
// request, the first answer, and the width it has to fit.
export function shorter(asked: string, answer: string, label: string): string {
  return [
    asked,
    `<your_answer>\n${answer.trim()}\n</your_answer>`,
    `The label "${label}" is too long for the row. ` +
      'Answer again with the same action and "to", and a shorter label: ' +
      '2 to 4 words, at most about 16 characters. ' +
      'Keep the words that name the task and drop the rest.',
  ].join('\n\n')
}

// Two verdicts that move the stack the same way, whatever their labels.
export function sameMove(a: Verdict, b: Verdict): boolean {
  return a.action === b.action && ('to' in a ? a.to : -1) === ('to' in b ? b.to : -1)
}

export function parseVerdict(text: string, depth: number): Verdict | undefined {
  const raw = verdictJson(text)
  if (raw === undefined) {
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
    case 'sibling': {
      const to = Number(raw.to)

      return label !== undefined && Number.isInteger(to) && to >= 0 && to < depth
        ? { action: 'sibling', to, label }
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
    return v.action === 'push' || v.action === 'sibling' || v.action === 'switch'
      ? { ...mind, stack: [{ label: v.label, turn }] }
      : mind
  }

  // Going back to the root shows it is still the starting point.
  const isRootDoubted =
    (v.action === 'pop' || v.action === 'sibling') && v.to === 0 ? false : mind.isRootDoubted

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
        isRootDoubted,
        stack: stack.slice(0, v.to + 1),
        history: closed(history, stack.slice(v.to + 1)),
      }
    case 'sibling':
      return {
        ...mind,
        isRootDoubted,
        stack: [...stack.slice(0, v.to + 1), { label: v.label, turn }],
        history: closed(history, stack.slice(v.to + 1)),
      }
    case 'switch': {
      // haiku says "switch" far more often than the developer leaves the
      // work, and a switch would wipe the root. The first one keeps the root
      // and opens the new topic under it; a second one with no return to the
      // root in between makes the topic the first switch opened the root.
      const base = mind.isRootDoubted && stack.length > 1 ? stack.slice(1) : stack
      return {
        ...mind,
        isRootDoubted: true,
        stack: [base[0]!, { label: v.label, turn }],
        history: closed(history, [...stack.slice(0, stack.length - base.length), ...base.slice(1)]),
      }
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
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x1f300 && cp <= 0x1faff)

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

// Root and current always stay; the middle gives way first, then the
// two labels themselves.
export function trail(stack: Topic[], budget: number): string {
  const labels = stack.map(t => t.label)
  const full = labels.join(SEP)
  if (width(full) <= budget) {
    return full
  }

  const [root = '', ...rest] = labels
  if (rest.length === 0) {
    return cut(root, budget)
  }
  const current = rest.at(-1)!
  const isFolded = rest.length > 1
  const between = isFolded ? SEP + '…' + SEP : SEP
  const suffix = isFolded ? ` (${labels.length})` : ''
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
  if (isFolded && used <= budget) {
    return [root, '…', ...tail].join(SEP) + suffix
  }

  // The current topic is what the row is for: it keeps its width and the
  // root gives way first, down to a few cells; past that both are cut.
  const room = budget - width(between + suffix)
  const rootMin = Math.min(width(root), ROOT_MIN)
  if (room < rootMin + 2) {
    return cut(current + suffix, budget)
  }
  const head = cut(root, Math.max(rootMin, room - width(current)))

  return head + between + cut(current, room - width(head)) + suffix
}

// The trail drawn dim on its own row under the prompt's hint line.
// An empty stack still takes its row, so the prompt does not jump when the
// first topic comes.
export function trailLine(mind: Mind, room: number): string {
  const suffix = (mind.isAuto ? '' : ' (manual)') + (mind.isJudging ? ' …' : '')
  if (mind.stack.length === 0) {
    return mind.isJudging ? '…' : '(no topic)' + suffix
  }
  const budget = Math.min(room, 120) - width(suffix)

  return trail(mind.stack, budget) + suffix
}

export function listing(mind: Mind): string {
  const lines: string[] = []
  if (mind.stack.length === 0) {
    lines.push('stack: (empty)')
  } else {
    lines.push('stack:')
    mind.stack.forEach((t, i) => {
      const mark = i === mind.stack.length - 1 ? '  <- now' : ''
      lines.push(`  ${i + 1}. ${t.label} (prompt #${t.turn})${mark}`)
    })
  }
  const done = mind.history.slice(-HISTORY_CAP)
  if (done.length > 0) {
    lines.push(`closed side topics (last ${done.length}): ${done.map(t => t.label).join(', ')}`)
  }
  const u = mind.usage
  lines.push(
    `automatic judging: ${mind.isAuto ? 'on' : 'off'}, haiku calls ${u.calls} (failed ${u.failures}), ` +
      `input ${u.inputTokens} (cache read ${u.cacheReadTokens}) / output ${u.outputTokens} token`,
  )

  return lines.join('\n')
}
