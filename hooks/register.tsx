import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Mind } from '../types'
import {
  EMPTY,
  RULES,
  apply,
  cleanLabel,
  listing,
  parseVerdict,
  request,
  trailLine,
  width,
} from './stack'

// Change the tag when Mind's fields change: it declines what an earlier
// version stored, which outlives a reload.
const mind = atom({ plugin: 'mind-stack', key: 'mind' } as const, EMPTY, {
  shape: 'mind-2',
})

const MODEL = 'haiku'
const MIN_PROMPT = 10
const STORE_INDEX = 'sessions'
const STORE_CAP = 30
const LOG_CAP = 200
const RESUME_POLL_MS = 200
const RESUME_TRIES = 25
// Where a prompt the developer wrote comes from.
const TYPED: ReadonlySet<string> = new Set(['composer', 'bridge'])

type $ = EngineInterface

function lastReply(messages: readonly SessionMessage[]): string {
  const m = messages.findLast(one => one.role === 'assistant' && one.text !== '')

  return m?.text ?? ''
}

// A copy per session in $.store, so a resumed session finds its stack again.
async function save($: $): Promise<void> {
  const id = await $.session.id()
  await $.store.set(`mind:${id}`, await read($, mind))
  const index = ((await $.store.get(STORE_INDEX)) as string[] | undefined) ?? []
  const next = [...index.filter(one => one !== id), id]
  for (const old of next.slice(0, -STORE_CAP)) {
    await $.store.delete(`mind:${old}`)
  }
  await $.store.set(STORE_INDEX, next.slice(-STORE_CAP))
}

// Brings back the stack the running session saved. A resume in the running
// process, like a /clear, goes on under another id with no session.start, so
// this runs wherever the state can be written: at the start, at a prompt and
// at /topic.
async function restore($: $): Promise<void> {
  const m = await read($, mind)
  if (m.stack.length > 0) {
    return
  }
  const saved = (await $.store.get(`mind:${await $.session.id()}`)) as Mind | undefined
  if (saved && Array.isArray(saved.stack) && saved.stack.length > 0) {
    await update($, mind, () => ({ ...EMPTY, ...saved, isJudging: false }))
  }
}

async function change($: $, fn: (m: Mind) => Mind): Promise<void> {
  // The hint line reads the state while drawing, so a write redraws it.
  await update($, mind, fn)
  await save($)
}

async function logPath($: $): Promise<string | undefined> {
  const home = await $.env.get('HOME')

  return home ? `${home}/.claude/mind-stack/calls.jsonl` : undefined
}

// One line per haiku call, the newest LOG_CAP kept. Kept out of the
// conversation: /topic shows totals alone.
async function logCall($: $, row: Record<string, unknown>): Promise<void> {
  const path = await logPath($)
  if (path === undefined) {
    return
  }
  const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
  const lines = [...old.split('\n').filter(line => line !== ''), JSON.stringify(row)]
  await $.fs.write(path, lines.slice(-LOG_CAP).join('\n') + '\n')
}

async function judge($: $, prompt: string, reply: string, turn: number) {
  const before = await read($, mind)
  await change($, m => ({ ...m, isJudging: true }))

  const startedAt = await $.clock.now()
  const asked = request(before.stack, reply, prompt)
  const r = await $.model.complete({
    model: MODEL,
    system: RULES,
    prompt: asked,
    maxTokens: 512,
    effort: 'low',
    timeoutMs: 8000,
  })
  const verdict = r.isAnswered
    ? parseVerdict(r.text, before.stack.length)
    : undefined
  const u = r.usage
  const input =
    u.input_tokens +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)

  await change($, m => {
    // A /topic command that ran meanwhile wins over this verdict.
    const isStale =
      JSON.stringify(m.stack) !== JSON.stringify(before.stack) || m.isHeld
    const judged = verdict && !isStale ? apply(m, verdict, turn) : m

    return {
      ...judged,
      isJudging: false,
      usage: {
        calls: m.usage.calls + 1,
        failures: m.usage.failures + (verdict ? 0 : 1),
        inputTokens: m.usage.inputTokens + input,
        outputTokens: m.usage.outputTokens + u.output_tokens,
      },
    }
  })

  // A log that cannot be written costs the judgment nothing.
  await logCall($, {
    at: new Date(startedAt).toISOString(),
    ms: (await $.clock.now()) - startedAt,
    session: await $.session.id(),
    turn,
    stack: before.stack.map(t => t.label),
    prompt: prompt.slice(0, 60),
    // The whole request, so a logged call can be judged again.
    request: asked,
    verdict: verdict ?? null,
    text: r.isAnswered ? r.text : null,
    inputTokens: input,
    outputTokens: u.output_tokens,
    ...(r.isAnswered ? {} : { reason: r.reason }),
  }).catch(() => undefined)
}

async function command($: $, args: string, columns: number): Promise<string> {
  await restore($)
  const [sub = '', ...rest] = args.trim().split(/\s+/)
  const word = rest.join(' ')
  const m = await read($, mind)
  // A stack set by hand is the developer's own: no switch doubts its root.
  const held = (next: Mind): Mind => ({ ...next, columns, isHeld: true, isRootDoubted: false })

  switch (sub) {
    case '':
    case 'log':
      await change($, x => ({ ...x, columns }))
      return `${listing(await read($, mind))}\n호출별 기록: ${(await logPath($)) ?? '(HOME 없음)'}`
    case 'push': {
      const label = cleanLabel(word)
      if (label === undefined) {
        return '사용법: /topic push <label>'
      }
      const turn = await $.session.turns()
      await change($, x => held(apply(x, { action: 'push', label }, turn)))
      return listing(await read($, mind))
    }
    case 'pop': {
      if (m.stack.length <= 1) {
        return '더 돌아갈 곳이 없습니다.\n' + listing(m)
      }
      // `/topic pop` goes up one level; `/topic pop 2` returns to item 2.
      const to = word === '' ? m.stack.length - 2 : Number(word) - 1
      if (!Number.isInteger(to) || to < 0 || to >= m.stack.length) {
        return `사용법: /topic pop [1-${m.stack.length}]`
      }
      await change($, x => held(apply(x, { action: 'pop', to }, 0)))
      return listing(await read($, mind))
    }
    case 'rename': {
      const label = cleanLabel(word)
      if (label === undefined || m.stack.length === 0) {
        return '사용법: /topic rename <label> (stack이 비어 있지 않을 때)'
      }
      await change($, x =>
        held({ ...x, stack: [...x.stack.slice(0, -1), { ...x.stack.at(-1)!, label }] }),
      )
      return listing(await read($, mind))
    }
    case 'reset':
      await change($, x => held({ ...x, stack: [], history: [] }))
      return 'stack을 비웠습니다.'
    case 'off':
      await change($, x => ({ ...x, columns, isAuto: false }))
      return '자동 판정을 껐습니다. /topic push, pop, rename으로만 바뀝니다.'
    case 'on':
      await change($, x => ({ ...x, columns, isAuto: true }))
      return '자동 판정을 켰습니다.'
    default:
      return '사용법: /topic [log | push <label> | pop [n] | rename <label> | reset | off | on]'
  }
}

export const register: Register = (on, options) => {
  const icon =
    typeof options.icon === 'string' && options.icon !== 'none' ? `${options.icon} ` : ''

  // Judgments run one at a time, in the order the prompts were sent.
  let queue: Promise<void> = Promise.resolve()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'topic',
      description: 'Show or edit the topic stack in the status line',
      argumentHint: '[log | push <label> | pop [n] | rename <label> | reset | off | on]',
      immediate: true,
    })
    await restore($)
    // 0.1.0 drew the trail as a status line; clear one left from then.
    $.ui.status(undefined)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // The next session's stack, if it saved one, comes back through restore().
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, mind, x => ({ ...EMPTY, isAuto: x.isAuto, columns: x.columns }))
    }
    // The resumed session's id comes a moment after this end, and no
    // session.start follows: wait for it, so the row shows its stack before
    // the first prompt.
    if (e.reason === 'resume') {
      const ended = e.sessionId
      let tries = 0
      const poll = async (): Promise<void> => {
        if ((await $.session.id()) !== ended) {
          await restore($)
        } else if (++tries < RESUME_TRIES) {
          $.clock.after(RESUME_POLL_MS, () => void poll().catch(() => undefined))
        }
      }
      $.clock.after(RESUME_POLL_MS, () => void poll().catch(() => undefined))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Task notifications, peers and scheduled prompts are not the developer
    // changing topic.
    if (e.command !== undefined || e.isMeta || !TYPED.has(e.origin.kind)) {
      return next(e)
    }
    await restore($)
    const m = await read($, mind)
    if (!m.isAuto) {
      return next(e)
    }
    if (m.isHeld) {
      await update($, mind, x => ({ ...x, isHeld: false }))
      return next(e)
    }
    const text = e.text.trim()
    // A short prompt is mostly a reply ("ㅇㅇ", "ㄱㄱ"), but the first one
    // ("할일 확인좀") is all there is to name the root by.
    if (text === '' || (text.length < MIN_PROMPT && m.stack.length > 0)) {
      return next(e)
    }
    const reply = lastReply(await $.session.messages())
    const turn = (await $.session.turns()) + 1

    // Off the prompt's path: the turn starts without waiting for haiku.
    $.clock.after(1, () => {
      queue = queue
        .then(() => judge($, text, reply, turn))
        .catch(() => change($, x => ({ ...x, isJudging: false })))
    })

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const m = await read($, mind)
    const line = trailLine(m, (e.viewport?.columns ?? m.columns) - 4 - width(icon))
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box paddingLeft={2}>
          <Text dimColor>
            {icon}
            {line}
          </Text>
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'topic' }, async ($, e) => ({
    // A plugin's or a test's run carries no presentation.
    text: await command($, e.args, e.presentation?.columns ?? EMPTY.columns),
  }))
}
