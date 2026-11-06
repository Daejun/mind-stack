import { describe, expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import {
  EMPTY,
  apply,
  isAsking,
  longLabel,
  request,
  sameMove,
  trailLine,
  parseVerdict,
  trail,
  width,
} from './stack'

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

// A model whose answers the test hands out one at a time.
function gatedModel(on: On): Array<(text: string) => void> {
  const gates: Array<(text: string) => void> = []
  on('model.complete', async () => {
    const text = await new Promise<string>(resolve => gates.push(resolve))
    return { value: { isAnswered: true, text, usage } }
  })
  return gates
}

function engine(on: On, id: () => string) {
  on('command.register', () => ({ value: { command: 'topic' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: id() }))
  on('session.turns', () => ({ value: 0 }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
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

  test('a reply that ends asking is sent longer', () => {
    expect(isAsking('이 순서로 진행할까요?')).toBe(true)
    expect(isAsking('**어느 쪽으로 할까요?**\n')).toBe(true)
    expect(isAsking('GPU 재현으로 갈지 정해 주세요.')).toBe(true)
    expect(isAsking('Shall I push it?')).toBe(true)
    expect(isAsking('테스트 7개가 통과했습니다.')).toBe(false)
    // Hangul after the ending is a sentence going on, not the end of a question.
    expect(isAsking('할까요 말까요 고민하다가 그대로 두었습니다')).toBe(false)
    // The question is looked for at the end only.
    expect(isAsking('왜 그럴까요? ' + '결과를 적었습니다. '.repeat(40))).toBe(false)

    const options = '1. A를 고친다\n' + 'x'.repeat(500) + '\n어느 것부터 할까요?'
    expect(request([], options, '1번 진행해').includes('1. A를 고친다')).toBe(true)
    const plain = '1. A를 고쳤다\n' + 'x'.repeat(500) + '\n끝났습니다.'
    expect(request([], plain, '다음').includes('1. A를 고쳤다')).toBe(false)
  })

  test('a label wider than the row is found before it is cut', () => {
    const long = '{"action":"push","label":"kpagecgroup /readable 확인"}'
    expect(longLabel(long)).toBe('kpagecgroup /readable 확인')
    expect(parseVerdict(long, 2)).toEqual({ action: 'push', label: 'kpagecgroup /readable …' })
    expect(longLabel('{"action":"push","label":"readable 확인"}')).toBe(undefined)
    expect(longLabel('{"action":"same"}')).toBe(undefined)
    expect(sameMove({ action: 'push', label: 'a' }, { action: 'push', label: 'b' })).toBe(true)
    expect(sameMove({ action: 'sibling', to: 0, label: 'a' }, { action: 'sibling', to: 1, label: 'a' })).toBe(false)
    expect(sameMove({ action: 'push', label: 'a' }, { action: 'switch', label: 'a' })).toBe(false)
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
    expect(m.stack.map(t => t.label)).toEqual(['fio bench', '주간보고'])
    expect(m.history.map(t => t.label)).toEqual(['lease 대기', 'procwait'])
  })

  test('a second switch replaces the root, a return to the root clears the doubt', async () => {
    let m = apply({ ...EMPTY, stack: at('main fetch') }, { action: 'switch', label: 'PR 목록' }, 2)
    m = apply(m, { action: 'push', label: '#828 답글' }, 3)
    expect(m.stack.map(t => t.label)).toEqual(['main fetch', 'PR 목록', '#828 답글'])
    expect(m.isRootDoubted).toBe(true)

    m = apply(m, { action: 'switch', label: '#840 정리' }, 4)
    expect(m.stack.map(t => t.label)).toEqual(['PR 목록', '#840 정리'])
    expect(m.history.map(t => t.label)).toEqual(['main fetch', '#828 답글'])

    let kept = apply({ ...EMPTY, stack: at('fio bench') }, { action: 'switch', label: 'agent.md' }, 2)
    kept = apply(kept, { action: 'pop', to: 0 }, 3)
    expect(kept.isRootDoubted).toBe(false)
    kept = apply(kept, { action: 'switch', label: 'hostlease' }, 4)
    expect(kept.stack.map(t => t.label)).toEqual(['fio bench', 'hostlease'])
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

  test('a trail too wide even folded cuts the root and the current topic', async () => {
    const long = (i: number) => '가나다라마바사아자차카' + String(i)
    for (const budget of [12, 20, 30, 40, 50]) {
      for (const n of [1, 2, 3, 5]) {
        const line = trail(at(...Array.from({ length: n }, (_, i) => long(i))), budget)
        expect(width(line)).toBeLessThanOrEqual(budget)
        if (n > 1 && budget >= 20) {
          expect(line.includes(' → ')).toBe(true)
        }
      }
    }
    // The current topic keeps the room; the root gives way to a few cells.
    expect(trail(at(long(0), long(1)), 30)).toBe('가나… → 가나다라마바사아자차…')
    expect(trail(at('fio bench', 'lease 대기'), 19)).toBe('fio b… → lease 대기')
    expect(trail(at('fio bench', 'x', 'lease 대기'), 6)).toBe('lease…')
  })

  test('the trail line shows the trail and a pending mark', async () => {
    expect(trailLine(EMPTY, 60)).toBe('(no topic)')
    expect(trailLine({ ...EMPTY, isJudging: true }, 60)).toBe('…')
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
    const marked: boolean[] = []

    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's1' }))
    on('session.turns', () => ({ value: 0 }))
    on('session.messages', () => ({ value: [] }))
    on('model.complete', (_, e) => {
      asked.push(e.prompt)
      marked.push(e.systemBlocks?.at(-1)?.cache === true)
      return { value: { isAnswered: true, text: verdicts.shift() ?? '', usage } }
    })
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount(HINT)
    const line = async () => (await ui.find({ key: 'trail' }))?.text ?? ''

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
    expect(JSON.parse(log[1] ?? '{}').after).toEqual(['fio bench', 'lease 대기'])
    expect(JSON.parse(log[1] ?? '{}').rules).toMatch(/^[0-9a-f]{8}$/)
    expect(marked).toEqual([true, true, true])
    expect(asked[1]?.includes('0: fio bench')).toBe(true)
    expect(lines).toEqual(['📚 fio bench', '📚 fio bench → lease 대기', '📚 fio bench'])
    expect((await ui.find({ type: 'Text', text: /shortcuts/ }))?.text).toBe('? for shortcuts')
    await ui.unmount()
  })

  test('a label too long for the row is asked again once', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const files = mockFiles(on)
    const answers = [
      '{"action":"push","label":"kpagecgroup /readable 확인"}',
      '{"action":"push","label":"readable 확인"}',
      '{"action":"push","label":"erofs mm 패치 설명 markdown 문서"}',
      '{"action":"push","label":"erofs mm 패치 설명 markdown 문서 작성"}',
    ]
    const asked: string[] = []

    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's4' }))
    on('session.turns', () => ({ value: 0 }))
    on('session.messages', () => ({ value: [] }))
    on('model.complete', (_, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: answers.shift() ?? '', usage } }
    })
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('kpagecgroup /readable 돌림?'))
    await clock.advance(5)
    await $.prompt.submit(typed('erofs랑 mm patch도 쉽게 설명하는 md 써줘'))
    await clock.advance(5)

    expect(asked.length).toBe(4)
    expect(asked[1]?.startsWith(asked[0] ?? '?')).toBe(true)
    expect(asked[1]?.includes('kpagecgroup /readable 확인')).toBe(true)
    const shown = (await $.command.run(topic(''))).text ?? ''
    expect(shown.includes('1. readable 확인')).toBe(true)
    // The second answer is still too long: the first one, cut, stands.
    expect(shown.includes('2. erofs mm 패치 설명 mark…')).toBe(true)
    expect(shown.includes('haiku calls 4')).toBe(true)
    const log = (files.get('/home/t/.claude/mind-stack/calls.jsonl') ?? '').trim().split('\n')
    expect(log.length).toBe(2)
    expect(JSON.parse(log[0] ?? '{}').retried).toBe('{"action":"push","label":"readable 확인"}')
  })

  test('prompts absorbed into a running turn still get numbers of their own', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    mockFiles(on)
    const answers = [
      '{"action":"push","label":"남은 할일 확인"}',
      '{"action":"push","label":"git push 실행"}',
      '{"action":"push","label":"readable 확인"}',
    ]

    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's5' }))
    // Absorbed prompts add no user turn: the count stays where it was.
    on('session.turns', () => ({ value: 0 }))
    on('session.messages', () => ({ value: [] }))
    on('model.complete', () => ({
      value: { isAnswered: true, text: answers.shift() ?? '', usage },
    }))
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    for (const text of ['남은 할일 확인좀', 'git push해줘 지금 바로', 'kpagecgroup /readable 돌림?']) {
      await $.prompt.submit(typed(text))
      await clock.advance(5)
    }
    await $.command.run(topic('push lease 대기'))

    const shown = (await $.command.run(topic(''))).text ?? ''
    expect(shown.includes('1. 남은 할일 확인 (prompt #1)')).toBe(true)
    expect(shown.includes('2. git push 실행 (prompt #2)')).toBe(true)
    expect(shown.includes('3. readable 확인 (prompt #3)')).toBe(true)
    expect(shown.includes('4. lease 대기 (prompt #3)')).toBe(true)
  })

  test('a short first prompt names the root, later short ones are not judged', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    mockFiles(on)
    const asked: string[] = []

    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's3' }))
    on('session.turns', () => ({ value: 0 }))
    on('session.messages', () => ({ value: [] }))
    on('model.complete', (_, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: '{"action":"push","label":"할일 확인"}', usage } }
    })
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('할일 확인좀'))
    await clock.advance(5)
    await $.prompt.submit(typed('v5를 내야하나?'))
    await clock.advance(5)

    expect(asked.length).toBe(1)
    const shown = await $.command.run(topic(''))
    expect(shown.text?.includes('1. 할일 확인')).toBe(true)
  })

  test("a short prompt that answers the last reply's question is judged", async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    mockFiles(on)
    const asked: string[] = []
    let reply = ''
    const verdicts = [
      '{"action":"push","label":"#84 답글"}',
      '{"action":"push","label":"#84 재측정"}',
    ]

    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's6' }))
    on('session.turns', () => ({ value: 0 }))
    on('session.messages', () => ({ value: [{ role: 'assistant', text: reply }] }))
    on('model.complete', (_, e) => {
      asked.push(e.prompt)
      return { value: { isAnswered: true, text: verdicts.shift() ?? '', usage } }
    })
    on('prompt.submit', (_, e) => ({ text: e.text }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('#84 답글 쓰자'))
    await clock.advance(5)
    reply = '답글을 올렸습니다.'
    await $.prompt.submit(typed('ㅇㅋ'))
    await clock.advance(5)
    reply = '1. 답글 고치기\n2. 재측정\n\n어느 쪽으로 할까요?'
    await $.prompt.submit(typed('2번 ㄱㄱ'))
    await clock.advance(5)

    expect(asked.length).toBe(2)
    expect(asked[1]?.includes('2. 재측정')).toBe(true)
    const shown = await $.command.run(topic(''))
    expect(shown.text?.includes('#84 재측정')).toBe(true)
  })

  test('a resume in the running process shows the stack that session saved', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    engineHint(on)
    mockFiles(on)
    let id = 's4'

    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: id }))
    on('session.turns', () => ({ value: 0 }))
    on('session.messages', () => ({ value: [] }))
    on('model.complete', () => ({
      value: { isAnswered: true, text: '{"action":"push","label":"fio bench"}', usage },
    }))
    on('prompt.submit', (_, e) => ({ text: e.text }))
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('fio bench 돌려줘'))
    await clock.advance(5)

    const ui = await $.ui.mount(HINT)
    const row = async () => (await ui.find({ type: 'Text', text: /📚/ }))?.text

    // The id moves on only after the end, as the engine does it.
    await $.session.end({ reason: 'resume', sessionId: 's4', resume: { id: 's4' } })
    await clock.advance(200)
    id = 's5'
    await clock.advance(1000)
    expect(await row()).toBe('📚 (no topic)')

    await $.session.end({ reason: 'resume', sessionId: 's5', resume: { id: 's5' } })
    id = 's4'
    await clock.advance(1000)
    expect(await row()).toBe('📚 fio bench')
    await ui.unmount()
    expect((await $.command.run(topic(''))).text?.includes('1. fio bench')).toBe(true)
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
    expect((await ui.find({ type: 'Text', text: /no topic/ }))?.text).toBe('📚 (no topic)')
    await ui.unmount()
    const shown = await $.command.run(topic('log'))
    expect(shown.text?.includes('failed 1')).toBe(true)
  })

  test('a verdict that comes after /resume leaves both sessions as saved', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    mockFiles(on)
    let id = 's5'
    engine(on, () => id)
    const gates = gatedModel(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('fio bench 돌려줘'))
    await clock.advance(5)
    gates.shift()!('{"action":"push","label":"fio bench"}')
    await clock.advance(5)

    await $.prompt.submit(typed('lease가 안 잡히는데 누가 쥐고 있어?'))
    await clock.advance(5)
    await $.session.end({ reason: 'resume', sessionId: 's5', resume: { id: 's5' } })
    gates.shift()!('{"action":"push","label":"lease 대기"}')
    await clock.advance(5)
    id = 's4'
    await clock.advance(1000)
    expect((await $.command.run(topic(''))).text?.includes('stack: (empty)')).toBe(true)

    await $.session.end({ reason: 'resume', sessionId: 's4', resume: { id: 's4' } })
    id = 's5'
    await clock.advance(1000)
    const shown = (await $.command.run(topic(''))).text ?? ''
    expect(shown.includes('1. fio bench')).toBe(true)
    expect(shown.includes('2.')).toBe(false)
  })

  test('verdicts that come after /clear do not reach the new session', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    mockFiles(on)
    let id = 'a1'
    engine(on, () => id)
    const gates = gatedModel(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('fio bench 돌려줘'))
    await clock.advance(5)
    await $.prompt.submit(typed('lease가 안 잡히는데 누가 쥐고 있어?'))
    await clock.advance(5)
    await $.session.end({ reason: 'clear', sessionId: 'a1', resume: { id: 'a1' } })
    id = 'a2'
    gates.shift()!('{"action":"push","label":"fio bench"}')
    await clock.advance(5)

    // The second prompt, queued behind the first, is never sent.
    expect(gates.length).toBe(0)
    const shown = (await $.command.run(topic(''))).text ?? ''
    expect(shown.includes('stack: (empty)')).toBe(true)
    expect(shown.includes('haiku calls 0')).toBe(true)
  })

  test('/topic push while a verdict is coming wins over it', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    mockFiles(on)
    engine(on, () => 's7')
    const gates = gatedModel(on)

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.prompt.submit(typed('fio bench 돌려줘'))
    await clock.advance(5)
    await $.command.run(topic('push 내 주제'))
    gates.shift()!('{"action":"push","label":"fio bench"}')
    await clock.advance(5)

    const shown = (await $.command.run(topic(''))).text ?? ''
    expect(shown.includes('1. 내 주제')).toBe(true)
    expect(shown.includes('2.')).toBe(false)
  })

  test('/topic push and pop edit the stack by hand', async ($, on) => {
    mock.store(on)
    mockFiles(on)
    on('command.register', () => ({ value: { command: 'topic' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 's3' }))
    on('session.turns', () => ({ value: 2 }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run(topic('push fio bench'))
    await $.command.run(topic('push lease 대기'))
    const popped = await $.command.run(topic('pop'))

    expect(popped.text?.includes('1. fio bench')).toBe(true)
    expect(popped.text?.includes('2.')).toBe(false)
  })
})
