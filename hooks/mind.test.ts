import { describe, expect, mock, test } from 'claude-code/testing'

import { EMPTY, apply, parseVerdict, statusText, trail, width } from './stack'

const at = (...labels: string[]) => labels.map((label, turn) => ({ label, turn }))
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const topic = (args: string) => ({
  command: 'topic',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})
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

  test('a narrow trail keeps the root and the current topic', async () => {
    const stack = at('fio bench', 'lease 대기', 'procwait', 'hook 수정', 'pgrep 패턴', 'bgrun 로그')
    const line = trail(stack, 40)
    expect(line.startsWith('fio bench → … → ')).toBe(true)
    expect(line.includes('bgrun 로그')).toBe(true)
    expect(line.endsWith('(6)')).toBe(true)
    expect(width(line) <= 40).toBe(true)
    expect(trail(at('a', 'b'), 10)).toBe('a → b')
  })

  test('the status line shows the trail and a pending mark', async () => {
    expect(statusText(EMPTY)).toBe(undefined)
    expect(statusText({ ...EMPTY, stack: at('fio bench'), isJudging: true })).toBe(
      'fio bench …',
    )
  })
})

describe('hooks', () => {
  test('prompts move the status line through haiku verdicts', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const statuses: (string | undefined)[] = []
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
    on('ui.status', (_, e) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    on('model.complete', (_, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: verdicts.shift() ?? '', usage } }
    })
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

    for (const text of ['fio bench 돌려줘', 'lease가 안 잡히는데 누가 쥐고 있어?', '됐다. 이제 bench 결과 보자']) {
      await $.prompt.submit(typed(text))
      await clock.advance(5)
    }
    await $.prompt.submit(typed('ㅇㅇ'))
    await clock.advance(5)

    expect(asked.length).toBe(3)
    expect(asked[1]?.includes('0: fio bench')).toBe(true)
    expect(statuses).toContain('fio bench → lease 대기')
    expect(statuses.at(-1)).toBe('fio bench')
  })

  test('a failed call keeps the line and the conversation going', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const statuses: (string | undefined)[] = []

    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's2' }))
    on('session.turns', () => ({ value: 0 }))
    on('session.messages', () => ({ value: [] }))
    on('ui.status', (_, e) => {
      statuses.push(e.text)
      return { value: undefined }
    })
    on('model.complete', () => ({
      value: { isAnswered: false, reason: 'api-error', status: 404, error: 'model_not_found' as const, usage },
    }))
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const sent = await $.prompt.submit(typed('fio bench 돌려줘'))
    await clock.advance(5)

    expect(sent.text).toBe('fio bench 돌려줘')
    expect(statuses.at(-1)).toBe(undefined)
    const shown = await $.command.run(topic('log'))
    expect(shown.text?.includes('실패 1')).toBe(true)
  })

  test('/topic push and pop edit the stack by hand', async ($, on) => {
    mock.store(on)
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
