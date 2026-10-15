import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { type Classification, type Route, ROUTES, classifyWithHaiku, classifyWithJev, isRoute, ranked } from './jev'
import { type ImageTier, editImage, generateImage } from './images'
import { codexImage } from './codex'
import { type DaybreakProgram, daybreakName, daybreakReview } from './daybreak'

/** One routing decision: what Jev said, what was chosen, and why. */
type Decision = {
  at: string
  prompt: string
  route: Route
  model: string
  imageTier?: ImageTier
  decidedBy: 'jev' | 'you' | 'override' | 'lock' | 'rule'
  reason: string
  classification?: Classification
}

type Override = { route: Route; sticky: boolean }

type Opts = {
  haikuModel: string
  opusModel: string
  fableModel: string
  threshold: number
  confirmFable: boolean
  routeSubagents: boolean
  imageDir: string
  imageBackend: 'codex' | 'api'
  codexPath: string
  daybreakProgram: DaybreakProgram
  daybreakModel: string
  logPath: string
}

const LABEL: Record<Route, string> = {
  haiku: 'Haiku 5.5',
  opus: 'Opus 5.5',
  fable: 'Fable 5.1',
  image: 'Images 2.5',
  security: 'Daybreak',
}

const MAX_LOG_LINES = 5000

// Codex writes Daybreak's report here; the folder is the decision log's, which stays out of git.
const DAYBREAK_REPLY = '.jev-router/daybreak-last-report.md'

// Module state. A reload starts it over, which is fine: the next prompt decides again.
const S: { opt: Opts; active?: Decision; override?: Override } = { opt: readOptions({}) }

export const register: Register = (on, options) => {
  S.opt = readOptions(options)
  S.active = undefined
  S.override = undefined

  on('session.start', async ($, e, next) => {
    await registerTools($)
    try {
      await $.command.register({
        name: 'route',
        description: 'Jev router: why | haiku | opus | fable | image | security | lock <route> | auto | log',
        argumentHint: '[why|haiku|opus|fable|image|security|lock <route>|auto|log]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`/route was not registered: ${String(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => ({ text: await runRouteCommand($, e.args) }))

  // Decide: classify each prompt typed while the session is idle.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.turnId) return next(e)

    const decision = await decide($, e.text)
    S.active = decision
    showStatus($, decision)
    await writeLog($, { type: 'decision', ...decision })

    const tool = `mcp__${$.plugin.name}__`
    const note =
      decision.route === 'image'
        ? `jev-router: this request is image work. Create images with ${tool}generate_image and change existing ones with ${tool}edit_image, using tier "${decision.imageTier}". Do not draw images by hand in SVG, HTML or code. Report the saved file path when done.`
        : decision.route === 'security'
          ? `jev-router: the user approved sending this security work to OpenAI ${daybreakLabel()}. Call ${tool}daybreak with the full task and the most relevant file paths; it reads the project read-only and returns findings. Report those findings to the user, and change code only if they ask.`
          : undefined
    if (!note) return next(e)
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => {
    // Never lose a prompt to a routing failure: send it on unrouted (the session's own model).
    $.ui.status('Jev router failed: this turn uses the session model')
    return next.called ? { text: e.text } : next(e)
  })

  // Enforce: every model request of the main loop goes to the routed model.
  on('turn.step', async function* ($, e, next) {
    const d = S.active
    // Subagent loops are routed when they spawn (agent.spawn); leave their steps alone.
    if (!d || e.agentId || e.model === d.model) return yield* next(e)
    return yield* next({ ...e, model: d.model })
  })

  // Subagents that name no model run on the turn's routed model.
  on('agent.spawn', async ($, e, next) => {
    const d = S.active
    if (!S.opt.routeSubagents || !d || e.model) return next(e)
    return next({ ...e, model: d.model })
  }).catch(($, e, next) => next(e))

  // Record what each main turn cost, for tuning later.
  on('turn.complete', async ($, e, next) => {
    const d = S.active
    if (!e.agentId && d) {
      await writeLog($, {
        type: 'turn',
        at: new Date().toISOString(),
        turnId: e.turnId,
        route: d.route,
        model: e.usage?.model ?? d.model,
        durationMs: e.durationMs,
        isAborted: e.isAborted,
        usage: e.usage,
      })
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__jev-router__generate_image' }, async ($, e) => ({
    result: await runGenerate($, e as unknown as Record<string, unknown>),
  })).catch(($, e, next) => ({ result: `generate_image failed inside jev-router: ${next.error?.message ?? 'unknown error'}` }))

  on('tool.call', { tool: 'mcp__jev-router__edit_image' }, async ($, e) => ({
    result: await runEdit($, e as unknown as Record<string, unknown>),
  })).catch(($, e, next) => ({ result: `edit_image failed inside jev-router: ${next.error?.message ?? 'unknown error'}` }))

  on('tool.call', { tool: 'mcp__jev-router__daybreak' }, async ($, e) => ({
    result: await runDaybreak($, e as unknown as Record<string, unknown>),
  })).catch(($, e, next) => ({ result: `daybreak failed inside jev-router: ${next.error?.message ?? 'unknown error'}` }))
}

// ---------- options ----------

function readOptions(options: PluginOptions): Opts {
  return {
    haikuModel: String(options.haikuModel ?? 'claude-haiku-5-5'),
    opusModel: String(options.opusModel ?? 'claude-opus-5-5'),
    fableModel: String(options.fableModel ?? 'claude-fable-5-1'),
    threshold: Number(options.confidenceThreshold ?? 0.7),
    confirmFable: options.confirmFable !== false,
    routeSubagents: options.routeSubagents !== false,
    imageDir: String(options.imageDir ?? 'assets/generated'),
    imageBackend: options.imageBackend === 'api' ? 'api' : 'codex',
    codexPath: String(options.codexPath ?? ''),
    daybreakProgram: options.daybreakProgram === 'daybreak_red' || options.daybreakProgram === 'standard' ? options.daybreakProgram : 'daybreak_blue',
    daybreakModel: String(options.daybreakModel ?? ''),
    logPath: String(options.logPath ?? '.jev-router/decisions.jsonl'),
  }
}

// The image route runs on Haiku: it only has to drive the image tools. The security route runs on
// Opus, which hands the analysis to Daybreak and then explains and applies its findings.
function modelFor(r: Route): string {
  return r === 'fable' ? S.opt.fableModel : r === 'opus' || r === 'security' ? S.opt.opusModel : S.opt.haikuModel
}

// ---------- deciding ----------

async function decide($: EngineInterface, text: string): Promise<Decision> {
  const base = { at: new Date().toISOString(), prompt: text.slice(0, 500) }

  const o = S.override
  if (o) {
    if (!o.sticky) S.override = undefined
    return {
      ...base,
      route: o.route,
      model: modelFor(o.route),
      imageTier: o.route === 'image' ? 'flare' : undefined,
      decidedBy: o.sticky ? 'lock' : 'override',
      reason: o.sticky ? 'locked with /route lock' : 'set with /route',
    }
  }

  const c = await classify($, text)
  let route = c.route
  let decidedBy: Decision['decidedBy'] = 'jev'
  let reason =
    c.source === 'jev'
      ? `Jev picked ${route} at ${pct(c.confidence)}`
      : c.source === 'fallback-haiku'
        ? `Jev unavailable (${c.error}); Haiku picked ${route}`
        : `Jev unavailable (${c.error}); default route`

  // Security work goes to OpenAI Daybreak, but only on a yes. Otherwise Opus, never Fable,
  // which carries extra safeguards for cybersecurity.
  if (route === 'security' || (route !== 'image' && c.securitySensitive > 0.5)) {
    const why =
      route === 'security' ? `${classifierName(c)} flagged security work` : `security-sensitive (${pct(c.securitySensitive)})`
    const answer = await askSafely(
      $,
      `${why}. Send it to OpenAI ${daybreakLabel()}, read-only through Codex?`,
      ['OpenAI Daybreak', 'Opus 5.5'],
    )
    route = answer === 'OpenAI Daybreak' ? 'security' : 'opus'
    decidedBy = answer === undefined ? 'rule' : 'you'
    reason =
      answer === 'OpenAI Daybreak'
        ? `${why}; you approved Daybreak`
        : answer === undefined
          ? `${why}; nobody approved Daybreak, so Opus`
          : `${why}; you chose Opus over Daybreak`
  }

  if (decidedBy === 'jev' && c.source === 'jev' && c.confidence < S.opt.threshold) {
    // Jev is unsure: ask, showing its ranking.
    const picked = await askForRoute($, c)
    if (picked) {
      route = picked
      decidedBy = 'you'
      reason = `Jev unsure (${pct(c.confidence)}); you picked ${route}`
    } else if (route === 'fable' && S.opt.confirmFable) {
      // Nobody picked, and Fable needs a yes: don't spend it unasked.
      route = 'opus'
      decidedBy = 'rule'
      reason = `Jev unsure (${pct(c.confidence)}) and nobody picked; Fable needs a yes, so Opus`
    }
  } else if (route === 'fable' && S.opt.confirmFable && decidedBy === 'jev') {
    const answer = await askSafely(
      $,
      `${classifierName(c)} wants Fable 5.1 for this turn (${pct(c.confidence)}). Use it?`,
      ['Fable 5.1', 'Opus 5.5'],
    )
    if (answer === 'Opus 5.5') {
      route = 'opus'
      decidedBy = 'you'
      reason = 'you chose Opus over Fable'
    } else if (answer !== 'Fable 5.1') {
      // Dismissed, or a -p run with nobody to ask: Fable runs only on a yes.
      route = 'opus'
      decidedBy = 'rule'
      reason = 'nobody confirmed Fable, so Opus'
    }
  }

  return {
    ...base,
    route,
    model: modelFor(route),
    imageTier: route === 'image' ? (c.premiumImage > 0.5 ? 'sunburst' : 'flare') : undefined,
    decidedBy,
    reason,
    classification: c,
  }
}

async function classify($: EngineInterface, text: string): Promise<Classification> {
  const state = await buildState($, text)
  const key = await $.env.get('TYPESAFE_API_KEY')
  if (!key) return classifyWithHaiku($, state, 'TYPESAFE_API_KEY is not set')
  try {
    return await classifyWithJev($, key, state)
  } catch (err) {
    return classifyWithHaiku($, state, err instanceof Error ? err.message : String(err))
  }
}

// Jev reads the new prompt plus the tail of the last reply, so "yes, do that" routes like what it answers.
async function buildState($: EngineInterface, text: string): Promise<string> {
  let lastReply = ''
  try {
    const messages = await $.session.messages()
    const last = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim().length > 0)
    lastReply = last ? last.text.slice(-1500) : ''
  } catch {
    // no transcript to read
  }
  return lastReply ? `Previous assistant reply (tail):\n${lastReply}\n\nNew request:\n${text}` : `New request:\n${text}`
}

async function askForRoute($: EngineInterface, c: Classification): Promise<Route | undefined> {
  const top = ranked(c).slice(0, 3)
  const labels = top.map(r => `${LABEL[r]} (${pct(c.probabilities[r] ?? 0)})`)
  const answer = await askSafely($, `Jev is unsure (${pct(c.confidence)}). Which model should take this turn?`, labels)
  if (answer === undefined) return undefined
  const i = labels.indexOf(answer)
  if (i >= 0) return top[i]
  return ROUTES.find(r => answer.toLowerCase().includes(r))
}

async function askSafely($: EngineInterface, question: string, labels: string[]): Promise<string | undefined> {
  try {
    return await $.ui.ask(question, labels)
  } catch {
    return undefined // dismissed, or a -p run with nobody to ask: keep Jev's pick
  }
}

// ---------- /route ----------

async function runRouteCommand($: EngineInterface, args: string): Promise<string> {
  const [first, second] = args.trim().toLowerCase().split(/\s+/).filter(Boolean)

  if (!first || first === 'why') {
    // A reload clears S.active; explain the last logged decision instead. Only for display:
    // S.active stays empty, so a stale decision never routes a turn or approves Daybreak.
    if (S.active) return explain(S.active, S.override)
    return explain(await lastLoggedDecision($), S.override, true)
  }

  if (first === 'auto') {
    S.override = undefined
    $.ui.status(S.active ? `${LABEL[S.active.route]} (Jev, auto)` : 'Jev: auto')
    return 'Jev is routing again.'
  }

  if (first === 'log') return recentDecisions($)

  const lock = first === 'lock'
  const target = lock ? second : first
  if (!isRoute(target)) return 'Usage: /route [why | haiku | opus | fable | image | security | lock <route> | auto | log]'

  S.override = { route: target, sticky: lock }
  $.ui.status(`${LABEL[target]} (${lock ? 'locked' : 'next turn'})`)
  await writeLog($, { type: 'override', at: new Date().toISOString(), route: target, sticky: lock })
  return lock
    ? `Locked to ${LABEL[target]} until /route auto.`
    : `Next turn runs on ${LABEL[target]}, then Jev takes over again.`
}

async function recentDecisions($: EngineInterface): Promise<string> {
  const path = S.opt.logPath
  const prior = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  const rows = prior
    .split('\n')
    .filter(l => l.includes('"type":"decision"'))
    .slice(-10)
    .map(l => {
      const d = JSON.parse(l) as Decision
      return `${d.at.slice(11, 19)}  ${LABEL[d.route].padEnd(10)} ${d.decidedBy.padEnd(8)} ${d.prompt.slice(0, 60)}`
    })
  return rows.length ? rows.join('\n') : `No decisions logged yet in ${path}.`
}

async function lastLoggedDecision($: EngineInterface): Promise<Decision | undefined> {
  const path = S.opt.logPath
  try {
    const prior = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const last = prior
      .split('\n')
      .filter(l => l.includes('"type":"decision"'))
      .pop()
    return last ? (JSON.parse(last) as Decision) : undefined
  } catch {
    return undefined
  }
}

function explain(d: Decision | undefined, o: Override | undefined, fromLog = false): string {
  const lines: string[] = []
  if (o) lines.push(o.sticky ? `Locked to ${LABEL[o.route]} (/route auto to unlock).` : `Next turn: ${LABEL[o.route]} (one time).`)
  if (!d) {
    lines.push('No turn routed yet in this session.')
    return lines.join('\n')
  }
  if (fromLog) lines.push(`From the log (the router reloaded since), routed at ${d.at.slice(11, 19)}:`)
  lines.push(`Last turn: ${LABEL[d.route]} on ${d.model}${d.imageTier ? `, image tier ${d.imageTier}` : ''}.`)
  lines.push(`Why: ${d.reason}.`)
  const c = d.classification
  if (c) {
    lines.push(`Classifier: ${c.source}${c.jevModel ? ` (${c.jevModel})` : ''}, ${c.latencyMs} ms.`)
    for (const r of ranked(c)) {
      const p = c.probabilities[r] ?? 0
      lines.push(`  ${LABEL[r].padEnd(11)} ${'#'.repeat(Math.round(p * 20)).padEnd(20)} ${pct(p)}`)
    }
    lines.push(`  security ${pct(c.securitySensitive)}, premium image ${pct(c.premiumImage)}`)
  }
  return lines.join('\n')
}

// ---------- status and log ----------

function showStatus($: EngineInterface, d: Decision) {
  const c = d.classification
  // decidedBy 'jev' means "the classifier's pick", which is Haiku or the default when Jev is unavailable.
  const who = d.decidedBy === 'jev' && c ? classifierName(c) : d.decidedBy
  const conf = c && c.source !== 'default' ? ` ${pct(c.confidence)}` : ''
  const tier = d.route === 'image' ? ` ${d.imageTier}` : ''
  const lock = S.override?.sticky ? ' [locked]' : ''
  $.ui.status(`${LABEL[d.route]}${tier} (${who}${conf})${lock}`)
}

async function writeLog($: EngineInterface, entry: Record<string, unknown>) {
  const path = S.opt.logPath
  try {
    const prior = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const lines = prior.split('\n').filter(l => l.length > 0)
    lines.push(JSON.stringify(entry))
    await $.fs.write(path, lines.slice(-MAX_LOG_LINES).join('\n') + '\n')
  } catch (err) {
    $.ui.log(`could not write the decision log: ${String(err)}`, { to: 'debug' })
  }
}

// ---------- image tools ----------

async function registerTools($: EngineInterface) {
  const common = {
    tier: {
      type: 'string',
      enum: ['flare', 'sunburst'],
      description: 'flare: fast, the default. sunburst: premium, for polished final assets.',
    },
    size: { type: 'string', description: 'For example 1024x1024, 1536x1024, 1024x1536, or auto.' },
    quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
    background: { type: 'string', enum: ['transparent', 'opaque', 'auto'] },
    output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
    filename: { type: 'string', description: 'Optional file name, without extension.' },
  }
  await $.tool.register({
    name: 'generate_image',
    description:
      'Generate an image with OpenAI image generation and save it into the project. Takes up to a few minutes. Use this for ALL image creation: illustrations, logos, icons, photos, mockup images, pictures of diagrams. Never draw images by hand in code when this tool fits. Returns the saved file path.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'A full description of the image.' }, ...common },
      required: ['prompt'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'edit_image',
    description:
      'Edit or restyle existing images with OpenAI image generation (takes up to a few minutes): change one element, swap a background, combine references. Use this for ALL image edits. Returns the saved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        image_paths: { type: 'array', items: { type: 'string' }, description: 'Source image files in the project.' },
        prompt: { type: 'string', description: 'What to change, and what to keep the same.' },
        mask_path: { type: 'string', description: 'Optional PNG mask; transparent areas are edited.' },
        ...common,
      },
      required: ['image_paths', 'prompt'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'daybreak',
    description:
      'Hand security work to OpenAI Daybreak through Codex: vulnerability review, secure code review, threat modeling, dependency risk, validating a security fix. It reads the project read-only, can take several minutes, and returns its findings. Works only on turns the user approved for Daybreak.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The full security task, with the context Daybreak needs.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files to start with, relative to the project.' },
      },
      required: ['task'],
    },
    isDeferred: false,
  })
}

// Daybreak sends project code to OpenAI, so it runs only on a turn the user approved:
// a yes to the dialog, or /route security.
async function runDaybreak($: EngineInterface, a: Record<string, unknown>): Promise<string> {
  if (S.active?.route !== 'security') {
    return 'The user has not approved Daybreak for this turn, so nothing was sent to OpenAI. They can approve it with /route security.'
  }
  const task = String(a.task ?? '').trim()
  if (!task) return 'daybreak needs a task.'
  const paths = Array.isArray(a.paths) ? a.paths.map(String) : []
  const out = await daybreakReview($, S.opt.codexPath, S.opt.daybreakProgram, S.opt.daybreakModel, DAYBREAK_REPLY, task, paths)
  await writeLog($, {
    type: 'daybreak',
    at: new Date().toISOString(),
    program: S.opt.daybreakProgram,
    model: S.opt.daybreakModel || 'codex default',
    ok: out.ok,
    ...(out.ok ? {} : { error: out.error }),
  })
  return out.ok ? `OpenAI ${daybreakLabel()} reported:\n\n${out.report}` : `Daybreak failed: ${out.error}`
}

// The image tools run through Codex on the user's ChatGPT plan by default, or the Images API
// when imageBackend is "api". There is no automatic fallback between them: the setting decides.
async function runGenerate($: EngineInterface, a: Record<string, unknown>): Promise<string> {
  const args = imageArgs(a)
  let out
  if (S.opt.imageBackend === 'codex') {
    out = await codexImage($, S.opt.codexPath, S.opt.imageDir, args)
  } else {
    const key = await $.env.get('OPENAI_API_KEY')
    if (!key) return 'OPENAI_API_KEY is not set, so no image was generated. Ask the user to set it, or to switch imageBackend to codex in /config.'
    out = await generateImage($, key, S.opt.imageDir, args)
  }
  await writeLog($, { type: 'image', at: new Date().toISOString(), op: 'generate', backend: S.opt.imageBackend, ...out })
  return out.ok ? `Saved ${out.path} (${out.model}).` : `Image generation failed: ${out.error}`
}

async function runEdit($: EngineInterface, a: Record<string, unknown>): Promise<string> {
  const paths = Array.isArray(a.image_paths) ? a.image_paths.map(String) : []
  if (paths.length === 0) return 'edit_image needs at least one path in image_paths.'
  const args = { ...imageArgs(a), imagePaths: paths, maskPath: str(a.mask_path) }
  let out
  if (S.opt.imageBackend === 'codex') {
    out = await codexImage($, S.opt.codexPath, S.opt.imageDir, args)
  } else {
    const key = await $.env.get('OPENAI_API_KEY')
    if (!key) return 'OPENAI_API_KEY is not set, so no image was edited. Ask the user to set it, or to switch imageBackend to codex in /config.'
    out = await editImage($, key, S.opt.imageDir, args)
  }
  await writeLog($, { type: 'image', at: new Date().toISOString(), op: 'edit', backend: S.opt.imageBackend, ...out })
  return out.ok ? `Saved ${out.path} (${out.model}).` : `Image edit failed: ${out.error}`
}

function imageArgs(a: Record<string, unknown>) {
  return {
    prompt: String(a.prompt ?? ''),
    tier: pickTier(a.tier),
    size: str(a.size),
    quality: str(a.quality),
    background: str(a.background),
    outputFormat: str(a.output_format),
    filename: str(a.filename),
  }
}

function pickTier(x: unknown): ImageTier {
  if (x === 'flare' || x === 'sunburst') return x
  return S.active?.imageTier ?? 'flare'
}

// ---------- helpers ----------

// "Daybreak Blue", or "Daybreak Blue (gpt-6-sol)" when a model is pinned.
function daybreakLabel(): string {
  const name = daybreakName(S.opt.daybreakProgram)
  return S.opt.daybreakModel ? `${name} (${S.opt.daybreakModel})` : name
}

function classifierName(c: Classification): string {
  return c.source === 'jev' ? 'Jev' : c.source === 'fallback-haiku' ? 'Haiku' : 'default'
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined
}
