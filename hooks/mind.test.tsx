import { describe, expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { EMPTY, apply, trailLine, parseVerdict, trail, width } from './stack'

const at = (...labels: string[]) => labels.map((label, turn) => ({ label, turn }))
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const topic = (args: string) => ({
  command: 'topic',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})
const HINT = {
  plugin: 'mind-stack',
  surface: 'terminal',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  viewport: { columns: 100, rows: 30 },
} as const

// Stands for the engine's file system and environment, in memory.
function mockFiles(on: On): Map<string, string> {
  const files = new Map<string, string>()
  mock.env(on, { HOME: '/home/t' })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  return files
}

// Stands for the engine: draws its hint line.
function engineHint(on: On) {
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.hint + (e.props.tail ?? '')}</Text>
  })
}

const usage = {
  input_tokens: 900,
  output_tokens: 40,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

describe('stack', () => {
  test('verdicts parse and reject what does not fit', async () => {
    expect(parseVerdict('{"action":"push","label":"lease 대기"}', 1)).toEqual({
      action: 'push',
      label: 'lease 대기',
    })
    expect(parseVerdict('sure: {"action":"pop","to":0}', 3)).toEqual({ action: 'pop', to: 0 })
    expect(parseVerdict('{"action":"pop","to":3}', 3)).toBe(undefined)
    expect(parseVerdict('{"action":"push"}', 1)).toBe(undefined)
    expect(parseVerdict('{"action":"sibling","to":1,"label":"토픽 민감도"}', 3)).toEqual({
      action: 'sibling',
      to: 1,
      label: '토픽 민감도',
    })
    expect(parseVerdict('{"action":"sibling","to":1}', 3)).toBe(undefined)
    expect(parseVerdict('no json', 1)).toBe(undefined)
  })

  test('push, pop and switch move the stack and the history', async () => {
    let m = apply(EMPTY, { action: 'push', label: 'fio bench' }, 1)
    m = apply(m, { action: 'push', label: 'lease 대기' }, 2)
    m = apply(m, { action: 'push', label: 'procwait' }, 3)
    expect(m.stack.map(t => t.label)).toEqual(['fio bench', 'lease 대기', 'procwait'])

    m = apply(m, { action: 'pop', to: 0 }, 4)
    expect(m.stack.map(t => t.label)).toEqual(['fio bench'])
    expect(m.history.map(t => t.label)).toEqual(['lease 대기', 'procwait'])

    m = apply(m, { action: 'switch', label: '주간보고' }, 5)
    expect(m.stack.map(t => t.label)).toEqual(['주간보고'])
    expect(m.history.map(t => t.label)).toEqual(['lease 대기', 'procwait', 'fio bench'])
  })

  test('a sibling closes the finished side topic and opens a new one', async () => {
    const m = apply(
      { ...EMPTY, stack: at('동작 확인 실험', 'mod 공유', '세모 느낌표') },
      { action: 'sibling', to: 1, label: '토픽 민감도' },
      13,
    )
    expect(m.stack.map(t => t.label)).toEqual(['동작 확인 실험', 'mod 공유', '토픽 민감도'])
    expect(m.history.map(t => t.label)).toEqual(['세모 느낌표'])
  })

  test('a narrow trail keeps the root and the current topic', async () => {
    const stack = at('fio bench', 'lease 대기', 'procwait', 'hook 수정', 'pgrep 패턴', 'bgrun 로그')
    const line = trail(stack, 40)
    expect(line.startsWith('fio bench → … → ')).toBe(true)
    expect(line.includes('bgrun 로그')).toBe(true)
    expect(line.endsWith('(6)')).toBe(true)
    expect(width(line) <= 40).toBe(true)
    expect(trail(at('a', 'b'), 10)).toBe('a → b')
  })

  test('the trail line shows the trail and a pending mark', async () => {
    expect(trailLine(EMPTY, 60)).toBe(undefined)
    expect(trailLine({ ...EMPTY, stack: at('fio bench'), isJudging: true }, 60)).toBe(
      'fio bench …',
    )
    expect(trailLine({ ...EMPTY, stack: at('fio bench'), isAuto: false }, 60)).toBe(
      'fio bench (manual)',
    )
  })
})

describe('hooks', () => {
  test('prompts move the trail line through haiku verdicts', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    engineHint(on)
    const files = mockFiles(on)
    const lines: string[] = []
    const verdicts = [
      '{"action":"push","label":"fio bench"}',
      '{"action":"push","label":"lease 대기"}',
      '{"action":"pop","to":0}',
    ]
    const asked: string[] = []

    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's1' }))
    on('session.turns', () => ({ value: 0 }))
    on('session.messages', () => ({ value: [] }))
    on('ui.status', () => ({ value: undefined }))
    on('model.complete', (_, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: verdicts.shift() ?? '', usage } }
    })
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount(HINT)
    const line = async () => (await ui.find({ type: 'Text', text: /fio/ }))?.text ?? ''

    for (const text of ['fio bench 돌려줘', 'lease가 안 잡히는데 누가 쥐고 있어?', '됐다. 이제 bench 결과 보자']) {
      await $.prompt.submit(typed(text))
      await clock.advance(5)
      lines.push(await line())
    }
    await $.prompt.submit(typed('ㅇㅇ'))
    await $.prompt.submit({
      text: '<task-notification>\n<task-id>b1</task-id> completed</task-notification>',
      wait: false,
      origin: { kind: 'task-notification' },
    })
    await clock.advance(5)

    expect(asked.length).toBe(3)
    const log = (files.get('/home/t/.claude/mind-stack/calls.jsonl') ?? '').trim().split('\n')
    expect(log.length).toBe(3)
    expect(JSON.parse(log[2] ?? '{}').verdict).toEqual({ action: 'pop', to: 0 })
    expect(JSON.parse(log[2] ?? '{}').request).toBe(asked[2])
    expect(asked[1]?.includes('0: fio bench')).toBe(true)
    expect(lines).toEqual(['📚 fio bench', '📚 fio bench → lease 대기', '📚 fio bench'])
    expect((await ui.find({ type: 'Text', text: /shortcuts/ }))?.text).toBe('? for shortcuts')
    await ui.unmount()
  })

  test('a failed call keeps the line and the conversation going', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    engineHint(on)
    mockFiles(on)

    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's2' }))
    on('session.turns', () => ({ value: 0 }))
    on('session.messages', () => ({ value: [] }))
    on('ui.status', () => ({ value: undefined }))
    on('model.complete', () => ({
      value: { isAnswered: false, reason: 'api-error', status: 404, error: 'model_not_found' as const, usage },
    }))
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const sent = await $.prompt.submit(typed('fio bench 돌려줘'))
    await clock.advance(5)

    expect(sent.text).toBe('fio bench 돌려줘')
    const ui = await $.ui.mount(HINT)
    expect((await ui.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
    expect(await ui.find({ type: 'Text', text: /fio/ })).toBe(undefined)
    await ui.unmount()
    const shown = await $.command.run(topic('log'))
    expect(shown.text?.includes('실패 1')).toBe(true)
  })

  test('/topic push and pop edit the stack by hand', async ($, on) => {
    mock.store(on)
    mockFiles(on)
    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's3' }))
    on('session.turns', () => ({ value: 2 }))
    on('ui.status', () => ({ value: undefined }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run(topic('push fio bench'))
    await $.command.run(topic('push lease 대기'))
    const popped = await $.command.run(topic('pop'))

    expect(popped.text?.includes('1. fio bench')).toBe(true)
    expect(popped.text?.includes('2.')).toBe(false)
  })
})
