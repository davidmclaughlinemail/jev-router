import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

type Seen = {
  stepModels: string[]
  spawnModel?: string
  context: string[]
  status: string[]
  asked: string[]
  fetched: { url: string; body?: string }[]
  files: Map<string, string>
}

type World = {
  env?: Record<string, string>
  jev?: unknown // the Jev response body; undefined answers HTTP 503
  answer?: string // what the person picks when asked; undefined dismisses
  haikuWord?: string
}

function jevBody(route: Record<string, number>, extra: { security?: number; premium?: number } = {}) {
  const [choice, top] = Object.entries(route).sort((a, b) => b[1] - a[1])[0] ?? ['opus', 1]
  return {
    model: 'jev-1.13.0',
    answers: {
      route: { type: 'choice', choice, confidence: top, probabilities: route },
      security: { type: 'noul', noul: extra.security ?? 0.02 },
      premium_image: { type: 'noul', noul: extra.premium ?? 0.1 },
    },
  }
}

// The engine resolves the plugin's relative paths against the session's folder before they reach us,
// with the host's separators (backslashes on Windows).
function findFile(seen: Seen, path: string): string | undefined {
  const p = path.replaceAll('\\', '/')
  for (const [key, v] of seen.files) {
    const k = key.replaceAll('\\', '/')
    if (k === p || p.endsWith(`/${k}`) || k.endsWith(`/${p}`)) return v
  }
  return undefined
}

// The engine beneath the plugin, answered in memory.
function world(on: On, w: World): Seen {
  const seen: Seen = { stepModels: [], context: [], status: [], asked: [], fetched: [], files: new Map() }
  mock.env(on, w.env ?? { TYPESAFE_API_KEY: 'test-jev', OPENAI_API_KEY: 'test-openai' })
  mock.clock(on, { now: 1_000 })

  on('fs.exists', async ($, e) => ({ value: findFile(seen, e.path) !== undefined }))
  on('fs.read', async ($, e) => ({ value: findFile(seen, e.path) ?? '' }))
  // Every path resolves under /abs, so tests can tell absolute paths from relative ones.
  on('fs.stat', async ($, e) => ({
    value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: `/abs/${e.path.replaceAll('\\', '/').split('/').slice(-2).join('/')}` },
  }))
  on('fs.write', async ($, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.status', async ($, e) => {
    seen.status.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('session.messages', async () => ({ value: [] }))
  on('http.fetch', async ($, e) => {
    seen.fetched.push({ url: e.url, body: e.init?.body })
    if (w.jev === undefined) return { value: { status: 503, ok: false, headers: {}, text: 'down' } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(w.jev) } }
  })
  on('model.complete', async () => ({
    value: {
      isAnswered: true as const,
      text: w.haikuWord ?? 'opus',
      usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]?.question ?? ''
    seen.asked.push(q)
    if (w.answer === undefined) return { deny: 'dismissed' }
    return { result: { answers: { [q]: w.answer } } }
  })
  on('prompt.submit', async ($, e) => {
    seen.context.push(...(e.context ?? []))
    return { text: e.text, context: e.context }
  })
  on('turn.step', async function* ($, e) {
    seen.stepModels.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('agent.spawn', async ($, e) => {
    seen.spawnModel = e.model
    return { model: e.model ?? 'inherited' }
  })
  return seen
}

function submit(text: string) {
  return { text, wait: false, origin: { kind: 'composer' as const } }
}

function route(args: string) {
  return { command: 'route', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
}

function spawn(model?: string) {
  return {
    tool_use_id: 'tu1',
    prompt: 'search',
    description: 'search',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-sonnet-5-5',
    background: false,
    fork: false,
    ...(model ? { model } : {}),
  }
}

const STEP = { turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 }

async function drain(stream: AsyncGenerator<unknown, unknown>) {
  for await (const _ of stream) {
    // read to the end
  }
}

describe('routing', () => {
  test('a confident Jev pick routes the whole main turn', async ($, on) => {
    const seen = world(on, { jev: jevBody({ opus: 0.91, haiku: 0.05, fable: 0.03, image: 0.01 }) })
    await $.prompt.submit(submit('Add pagination to the orders API and its tests'))
    await drain($.turn.step(STEP))
    await drain($.turn.step({ ...STEP, index: 1 }))

    expect(seen.fetched[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(seen.stepModels).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(seen.asked).toEqual([])
    expect(seen.status.at(-1)).toContain('Opus 5.5')
    // The engine hands the plugin's relative path through resolved, so match on the file name.
    const log = [...seen.files.entries()].find(([k]) => k.endsWith('decisions.jsonl'))?.[1] ?? ''
    expect(log).toContain('"decidedBy":"jev"')
  })

  test('a low-confidence pick asks, and the answer wins', async ($, on) => {
    const seen = world(on, {
      jev: jevBody({ opus: 0.52, fable: 0.45, haiku: 0.03, image: 0 }),
      answer: 'Fable 5.1 (45%)',
    })
    await $.prompt.submit(submit('Should we split the monolith into services?'))
    await drain($.turn.step(STEP))

    expect(seen.asked.length).toBe(1)
    expect(seen.asked[0]).toContain('Jev is unsure (52%)')
    expect(seen.stepModels).toEqual(['claude-fable-5-1'])
  })

  test('dismissing the question keeps Jev pick', async ($, on) => {
    const seen = world(on, { jev: jevBody({ opus: 0.52, fable: 0.45, haiku: 0.03, image: 0 }) })
    await $.prompt.submit(submit('Should we split the monolith into services?'))
    await drain($.turn.step(STEP))
    expect(seen.stepModels).toEqual(['claude-opus-5-5'])
  })

  test('confident Fable still confirms before spending', async ($, on) => {
    const seen = world(on, { jev: jevBody({ fable: 0.88, opus: 0.1, haiku: 0.02, image: 0 }), answer: 'Opus 5.5' })
    await $.prompt.submit(submit('Redesign the whole data layer across all services'))
    await drain($.turn.step(STEP))
    expect(seen.asked[0]).toContain('Fable 5.1')
    expect(seen.stepModels).toEqual(['claude-opus-5-5'])
  })

  test('an unanswered Fable confirmation runs Opus', async ($, on) => {
    const seen = world(on, { jev: jevBody({ fable: 0.88, opus: 0.1, haiku: 0.02, image: 0 }) })
    await $.prompt.submit(submit('Redesign the whole data layer across all services'))
    await drain($.turn.step(STEP))
    expect(seen.asked.length).toBe(1)
    expect(seen.stepModels).toEqual(['claude-opus-5-5'])
    const why = await $.command.run(route('why'))
    expect(why.text).toContain('nobody confirmed Fable')
  })

  test('Jev unsure with Fable on top, nobody picks: Opus', async ($, on) => {
    const seen = world(on, { jev: jevBody({ fable: 0.5, opus: 0.45, haiku: 0.05, image: 0 }) })
    await $.prompt.submit(submit('Should we split the monolith into services?'))
    await drain($.turn.step(STEP))
    expect(seen.asked.length).toBe(1)
    expect(seen.stepModels).toEqual(['claude-opus-5-5'])
  })

  test('a Fable confirmation that says yes runs Fable', async ($, on) => {
    const seen = world(on, { jev: jevBody({ fable: 0.88, opus: 0.1, haiku: 0.02, image: 0 }), answer: 'Fable 5.1' })
    await $.prompt.submit(submit('Redesign the whole data layer across all services'))
    await drain($.turn.step(STEP))
    expect(seen.stepModels).toEqual(['claude-fable-5-1'])
  })

  test('the Haiku fallback asks before Fable too, naming Haiku', async ($, on) => {
    const seen = world(on, { env: { OPENAI_API_KEY: 'x' }, haikuWord: 'fable' })
    await $.prompt.submit(submit('Design the architecture for the whole codebase'))
    await drain($.turn.step(STEP))
    expect(seen.asked[0]).toContain('Haiku wants Fable 5.1')
    expect(seen.stepModels).toEqual(['claude-opus-5-5'])
  })

  test('security work never goes to Fable', async ($, on) => {
    const seen = world(on, { jev: jevBody({ fable: 0.9, opus: 0.08, haiku: 0.02, image: 0 }, { security: 0.93 }) })
    await $.prompt.submit(submit('Audit our auth service for injection vulnerabilities'))
    await drain($.turn.step(STEP))
    expect(seen.asked).toEqual([])
    expect(seen.stepModels).toEqual(['claude-opus-5-5'])
  })

  test('image work runs on Haiku and is told to use the image tools', async ($, on) => {
    const seen = world(on, { jev: jevBody({ image: 0.97, haiku: 0.02, opus: 0.01, fable: 0 }, { premium: 0.8 }) })
    await $.prompt.submit(submit('Make a hero illustration for the landing page'))
    await drain($.turn.step(STEP))
    expect(seen.stepModels).toEqual(['claude-haiku-5-5'])
    expect(seen.context.join('\n')).toContain('mcp__jev-router__generate_image')
    expect(seen.context.join('\n')).toContain('"sunburst"')
  })

  test('without a Jev key, Haiku classifies instead', async ($, on) => {
    const seen = world(on, { env: { OPENAI_API_KEY: 'x' }, haikuWord: 'haiku' })
    await $.prompt.submit(submit('What does this regex match?'))
    await drain($.turn.step(STEP))
    expect(seen.fetched).toEqual([])
    expect(seen.stepModels).toEqual(['claude-haiku-5-5'])
    // The status line credits whoever routed, not Jev.
    expect(seen.status.at(-1)).toBe('Haiku 5.5 (Haiku 75%)')
  })

  test('with both classifiers down, the status line says default', async ($, on) => {
    const seen = world(on, { env: { OPENAI_API_KEY: 'x' }, haikuWord: 'gibberish' })
    await $.prompt.submit(submit('Fix the flaky date test'))
    expect(seen.status.at(-1)).toBe('Opus 5.5 (default)')
  })

  test('Jev down falls back without blocking the prompt', async ($, on) => {
    const seen = world(on, { haikuWord: 'gibberish' })
    const r = await $.prompt.submit(submit('Fix the flaky date test'))
    await drain($.turn.step(STEP))
    expect(r.text).toBe('Fix the flaky date test')
    expect(seen.stepModels).toEqual(['claude-opus-5-5'])
  })

  test('subagents without a model inherit the route; explicit ones are kept', async ($, on) => {
    const seen = world(on, { jev: jevBody({ haiku: 0.95, opus: 0.05, fable: 0, image: 0 }) })
    await $.prompt.submit(submit('Find where we parse dates'))
    await $.agent.spawn(spawn())
    expect(seen.spawnModel).toBe('claude-haiku-5-5')
    await $.agent.spawn(spawn('opus'))
    expect(seen.spawnModel).toBe('opus')
  })

  test('subagent steps are left alone', async ($, on) => {
    const seen = world(on, { jev: jevBody({ haiku: 0.95, opus: 0.05, fable: 0, image: 0 }) })
    await $.prompt.submit(submit('Find where we parse dates'))
    await drain($.turn.step({ ...STEP, agentId: 'a1', model: 'claude-opus-5-5' }))
    expect(seen.stepModels).toEqual(['claude-opus-5-5'])
  })
})

describe('/route', () => {
  test('a one-shot override wins once, then Jev decides again', async ($, on) => {
    const seen = world(on, { jev: jevBody({ haiku: 0.95, opus: 0.05, fable: 0, image: 0 }) })
    await $.command.run(route('opus'))
    await $.prompt.submit(submit('first'))
    await drain($.turn.step(STEP))
    await $.prompt.submit(submit('second'))
    await drain($.turn.step({ ...STEP, turnId: 't2' }))
    expect(seen.stepModels).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
    expect(seen.fetched.length).toBe(1)
  })

  test('lock holds until auto, and why explains the last decision', async ($, on) => {
    const seen = world(on, { jev: jevBody({ haiku: 0.95, opus: 0.05, fable: 0, image: 0 }) })
    await $.command.run(route('lock fable'))
    await $.prompt.submit(submit('one'))
    await $.prompt.submit(submit('two'))
    await drain($.turn.step(STEP))
    expect(seen.stepModels).toEqual(['claude-fable-5-1'])
    expect(seen.fetched.length).toBe(0)

    const why = await $.command.run(route('why'))
    expect(why.text).toContain('Locked to Fable 5.1')

    await $.command.run(route('auto'))
    await $.prompt.submit(submit('three'))
    const after = await $.command.run(route('why'))
    expect(after.text).toContain('Jev picked haiku at 95%')
  })
})

describe('options', () => {
  test('confirmFable off runs Fable without asking', { options: { confirmFable: false } }, async ($, on) => {
    const seen = world(on, { jev: jevBody({ fable: 0.88, opus: 0.1, haiku: 0.02, image: 0 }) })
    await $.prompt.submit(submit('Redesign the whole data layer across all services'))
    await drain($.turn.step(STEP))
    expect(seen.asked).toEqual([])
    expect(seen.stepModels).toEqual(['claude-fable-5-1'])
  })

  test('model ids come from settings', { options: { opusModel: 'claude-opus-5-5-20261001' } }, async ($, on) => {
    const seen = world(on, { jev: jevBody({ opus: 0.9, haiku: 0.1, fable: 0, image: 0 }) })
    await $.prompt.submit(submit('Refactor the billing module'))
    await drain($.turn.step(STEP))
    expect(seen.stepModels).toEqual(['claude-opus-5-5-20261001'])
  })
})

const API = { options: { imageBackend: 'api' } }

describe('image tools (api backend)', () => {
  test('generate_image calls Images 2.5 and decodes the result to a file', API, async ($, on) => {
    const seen = world(on, { jev: { data: [{ b64_json: 'iVBORw0KGgo=' }] } })
    const runs: { argv: readonly string[]; stdin?: string }[] = []
    on('process.run', async ($, e) => {
      runs.push({ argv: e.argv, stdin: e.init?.stdin })
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const r = await $.tool.call({
      tool: 'mcp__jev-router__generate_image',
      prompt: 'A red fox logo',
      tier: 'sunburst',
      filename: 'fox',
    } as never)

    expect(seen.fetched[0]?.url).toBe('https://api.openai.com/v1/images/generations')
    expect(JSON.parse(seen.fetched[0]?.body ?? '{}').model).toBe('gpt-image-2.5-sunburst')
    const decode = runs.find(x => x.argv[0] === 'openssl')
    expect(decode?.argv).toEqual(['openssl', 'base64', '-d', '-A', '-out', 'assets/generated/fox.png'])
    expect(decode?.stdin).toBe('iVBORw0KGgo=')
    expect(String((r as { result?: unknown }).result)).toContain('Saved assets/generated/fox.png')
  })

  test('without an OpenAI key the tool says so instead of failing', API, async ($, on) => {
    world(on, { env: { TYPESAFE_API_KEY: 'k' } })
    const r = await $.tool.call({ tool: 'mcp__jev-router__generate_image', prompt: 'x' } as never)
    expect(String((r as { result?: unknown }).result)).toContain('OPENAI_API_KEY is not set')
  })

  test('edit_image keeps the key off the command line', API, async ($, on) => {
    const seen = world(on, {})
    seen.files.set('logo.png', 'binary')
    on('process.run', async ($, e) => {
      if (e.argv[0] === 'curl') {
        expect(e.argv.join(' ')).not.toContain('test-openai')
        expect(e.init?.stdin).toBe('Authorization: Bearer test-openai\n')
        seen.files.set('assets/generated/.last-edit-response.json', JSON.stringify({ data: [{ b64_json: 'AAAA' }] }))
        return { value: { exitCode: 0, stdout: '200', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const r = await $.tool.call({
      tool: 'mcp__jev-router__edit_image',
      image_paths: ['logo.png'],
      prompt: 'Make the background transparent',
    } as never)
    expect(String((r as { result?: unknown }).result)).toContain('gpt-image-2.5-flare')
  })
})

describe('image tools on Windows (api backend)', () => {
  const WINDOWS_ENV = { OPENAI_API_KEY: 'test-openai', OS: 'Windows_NT', SystemRoot: 'C:\\Windows' }
  const ok = (stdout = '') => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  test('generate_image decodes with System32 PowerShell, not mkdir or openssl', API, async ($, on) => {
    world(on, { env: WINDOWS_ENV, jev: { data: [{ b64_json: 'iVBORw0KGgo=' }] } })
    const runs: { argv: readonly string[]; stdin?: string; env?: Record<string, string> }[] = []
    on('process.run', async ($, e) => {
      runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env })
      return ok()
    })
    const r = await $.tool.call({ tool: 'mcp__jev-router__generate_image', prompt: 'A red fox logo', filename: 'fox' } as never)

    expect(runs.length).toBe(1)
    expect(runs[0]?.argv[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(runs[0]?.stdin).toBe('iVBORw0KGgo=')
    // The path rides in the environment, so it can't break out of the script.
    expect(runs[0]?.env).toEqual({ JEV_IMAGE_OUT: 'assets/generated/fox.png' })
    expect(runs[0]?.argv.join(' ')).not.toContain('fox.png')
    expect(String((r as { result?: unknown }).result)).toContain('Saved assets/generated/fox.png')
  })

  test('edit_image runs System32 curl, which creates the output folder itself', API, async ($, on) => {
    const seen = world(on, { env: WINDOWS_ENV })
    seen.files.set('logo.png', 'binary')
    const argv0: string[] = []
    on('process.run', async ($, e) => {
      argv0.push(e.argv[0] ?? '')
      if (e.argv[0]?.endsWith('curl.exe')) {
        expect(e.argv).toContain('--create-dirs')
        seen.files.set('assets/generated/.last-edit-response.json', JSON.stringify({ data: [{ b64_json: 'AAAA' }] }))
        return ok('200')
      }
      return ok()
    })
    const r = await $.tool.call({ tool: 'mcp__jev-router__edit_image', image_paths: ['logo.png'], prompt: 'x' } as never)
    expect(argv0).toEqual([
      'C:\\Windows\\System32\\curl.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ])
    expect(String((r as { result?: unknown }).result)).toContain('Saved')
  })
})

describe('image tools (codex backend, the default)', () => {
  const WINDOWS = { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }
  const NODE = 'C:\\Program Files\\nodejs\\node.exe'
  const CODEX_JS = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
  const result = (r: unknown) => String((r as { result?: unknown }).result)

  // Codex is answered in memory: it "saves" the file it was asked for unless told to fail.
  function codex(on: Parameters<typeof world>[0], seen: Seen, behave: { exitCode?: number; save?: boolean } = {}) {
    const runs: { argv: readonly string[]; stdin?: string }[] = []
    on('process.run', async ($, e) => {
      runs.push({ argv: e.argv, stdin: e.init?.stdin })
      const target = /absolute path: (\S+)/.exec(e.init?.stdin ?? '')?.[1] ?? ''
      if (behave.save !== false) seen.files.set(`assets/generated/${target.slice(target.lastIndexOf('/') + 1)}`, 'png')
      return { value: { exitCode: behave.exitCode ?? 0, stdout: '', stderr: behave.exitCode ? 'boom' : '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    return runs
  }

  test('generate_image runs codex exec on Windows through node and codex.js, no API key needed', async ($, on) => {
    const seen = world(on, { env: WINDOWS })
    seen.files.set(NODE, 'exe')
    seen.files.set(CODEX_JS, 'js')
    const runs = codex(on, seen)
    const r = await $.tool.call({ tool: 'mcp__jev-router__generate_image', prompt: 'A red fox logo', tier: 'sunburst', filename: 'fox' } as never)

    expect(runs.length).toBe(1)
    const argv = runs[0]?.argv ?? []
    expect(argv.slice(0, 3)).toEqual([NODE, CODEX_JS, 'exec'])
    // Sandboxed to the image folder, request on stdin, nothing from the prompt on the command line.
    expect(argv).toContain('workspace-write')
    expect(argv[argv.indexOf('-C') + 1]).toBe('/abs/assets/generated')
    expect(argv.at(-1)).toBe('-')
    expect(argv.join(' ')).not.toContain('red fox')
    expect(runs[0]?.stdin).toContain('Request: A red fox logo')
    expect(runs[0]?.stdin).toContain('production-ready')
    expect(runs[0]?.stdin).toContain('absolute path: /abs/assets/generated/fox.png')
    expect(seen.fetched).toEqual([])
    expect(result(r)).toBe('Saved assets/generated/fox.png (codex (ChatGPT plan)).')
  })

  test('edit_image attaches the sources with -i, as absolute paths', async ($, on) => {
    const seen = world(on, { env: {} })
    seen.files.set('logo.png', 'png')
    const runs = codex(on, seen)
    const r = await $.tool.call({ tool: 'mcp__jev-router__edit_image', image_paths: ['logo.png'], prompt: 'Make it blue', filename: 'blue' } as never)
    const argv = runs[0]?.argv ?? []
    expect(argv[0]).toBe('codex')
    expect(argv[argv.indexOf('-i') + 1]).toMatch(/^\/abs\/.*logo\.png$/)
    expect(runs[0]?.stdin).toContain('edit the attached image')
    expect(result(r)).toContain('Saved assets/generated/blue.png')
  })

  test('a codex run that saves nothing is reported, not trusted', async ($, on) => {
    const seen = world(on, { env: {} })
    codex(on, seen, { save: false })
    const r = await $.tool.call({ tool: 'mcp__jev-router__generate_image', prompt: 'x', filename: 'x' } as never)
    expect(result(r)).toContain('Codex finished without saving')
  })

  test('a failing codex run reports its exit code', async ($, on) => {
    const seen = world(on, { env: {} })
    codex(on, seen, { exitCode: 2 })
    const r = await $.tool.call({ tool: 'mcp__jev-router__generate_image', prompt: 'x' } as never)
    expect(result(r)).toContain('codex exited 2: boom')
  })

  test('missing Codex on Windows says how to fix it', async ($, on) => {
    const seen = world(on, { env: WINDOWS })
    seen.files.set(NODE, 'exe')
    const runs = codex(on, seen)
    const r = await $.tool.call({ tool: 'mcp__jev-router__generate_image', prompt: 'x' } as never)
    expect(runs).toEqual([])
    expect(result(r)).toContain('npm install -g @openai/codex')
  })

  test('codexPath overrides where Codex is', { options: { codexPath: 'D:\\tools\\codex.js' } }, async ($, on) => {
    const seen = world(on, { env: WINDOWS })
    seen.files.set(NODE, 'exe')
    seen.files.set('D:\\tools\\codex.js', 'js')
    const runs = codex(on, seen)
    await $.tool.call({ tool: 'mcp__jev-router__generate_image', prompt: 'x' } as never)
    expect(runs[0]?.argv.slice(0, 2)).toEqual([NODE, 'D:\\tools\\codex.js'])
  })
})
