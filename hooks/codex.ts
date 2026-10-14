import type { EngineInterface } from 'claude-code'
import { type EditArgs, type ImageArgs, type ImageOutcome, outputPath, windowsSystem32 } from './images'

/**
 * Image work through the Codex CLI, billed to the user's ChatGPT plan instead of the API.
 *
 * `codex exec` is a whole agent run: it gets the request on stdin, generates with its
 * image tool, and must save exactly one file at the path we name. We confirm that file
 * exists afterwards rather than trusting its reply.
 */

const TIER_HINT = {
  flare: 'a good-quality draft; favor speed',
  sunburst: 'a polished, production-ready final asset; take care over detail',
} as const

// A Codex agent run, image generation included, takes about a minute; allow the API's maximum.
const TIMEOUT_MS = 600_000

export type CodexImageArgs = ImageArgs & Partial<Pick<EditArgs, 'imagePaths' | 'maskPath'>>

export async function codexImage($: EngineInterface, codexPath: string, dir: string, a: CodexImageArgs): Promise<ImageOutcome> {
  const launch = await codexLaunch($, codexPath)
  if ('error' in launch) return { ok: false, error: launch.error }

  const sources = [...(a.imagePaths ?? []), ...(a.maskPath ? [a.maskPath] : [])]
  for (const p of sources) {
    if (!(await $.fs.exists(p))) return { ok: false, error: `No such file: ${p}` }
  }

  // Writing Codex's reply file first creates the folder, which Codex needs as its working root.
  const lastMessage = `${dir}/.codex-last-message.txt`
  await $.fs.write(lastMessage, '')
  const absDir = await absolute($, dir)
  const path = await outputPath($, dir, a)
  const absPath = `${absDir}/${path.slice(path.lastIndexOf('/') + 1)}`

  // Sandboxed to the image folder: Codex can read the attached sources but write nowhere else.
  const argv = [
    ...launch.argv, 'exec',
    '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '-s', 'workspace-write',
    '-C', absDir,
    '-o', `${absDir}/.codex-last-message.txt`,
  ]
  for (const p of sources) argv.push('-i', await absolute($, p))
  argv.push('-') // the request comes on stdin

  const run = await $.process.run(argv, { stdin: instructions(a, absPath), timeoutMs: TIMEOUT_MS })
  if (run.exitCode !== 0) return { ok: false, error: `codex exited ${run.exitCode}: ${tail(run.stderr)}` }
  if (!(await $.fs.exists(path))) {
    const said = await $.fs.read(lastMessage).catch(() => '')
    return { ok: false, error: `Codex finished without saving ${path}. It said: ${said.slice(0, 300) || '(nothing)'}` }
  }
  return { ok: true, path, model: 'codex (ChatGPT plan)' }
}

function instructions(a: CodexImageArgs, absPath: string): string {
  const editing = (a.imagePaths?.length ?? 0) > 0
  const lines = [
    editing
      ? 'Use your image generation tool to edit the attached image(s) as described below.'
      : 'Use your image generation tool to create the image described below.',
    '',
    `Request: ${a.prompt}`,
    `Quality: ${TIER_HINT[a.tier]}.`,
  ]
  if (a.maskPath) lines.push('The last attached image is a mask: change only its transparent areas.')
  if (a.size) lines.push(`Size: ${a.size}.`)
  if (a.quality) lines.push(`Rendering quality: ${a.quality}.`)
  if (a.background) lines.push(`Background: ${a.background}.`)
  lines.push(
    '',
    `Save exactly one image file at this absolute path: ${absPath}`,
    'Do not create, change or delete any other file.',
    "Reply with only the saved file's absolute path.",
  )
  return lines.join('\n')
}

/**
 * How to start Codex without a shell. On Windows the npm install is a .cmd/.ps1 shim,
 * which can't be run by argv, so node.exe runs Codex's own codex.js by absolute path.
 * `codexPath` overrides where codex.js (or, elsewhere, the codex executable) lives.
 */
async function codexLaunch($: EngineInterface, codexPath: string): Promise<{ argv: string[] } | { error: string }> {
  if (!(await windowsSystem32($))) {
    if (!codexPath) return { argv: ['codex'] }
    return { argv: codexPath.endsWith('.js') ? ['node', codexPath] : [codexPath] }
  }
  const node = `${(await $.env.get('ProgramFiles')) ?? 'C:\\Program Files'}\\nodejs\\node.exe`
  const script = codexPath || `${(await $.env.get('APPDATA')) ?? ''}\\npm\\node_modules\\@openai\\codex\\bin\\codex.js`
  if (!(await $.fs.exists(node))) return { error: `Node.js not found at ${node}, which Codex needs.` }
  if (!(await $.fs.exists(script))) {
    return { error: `Codex not found at ${script}. Install it (npm install -g @openai/codex) or set codexPath in /config.` }
  }
  return { argv: [node, script] }
}

async function absolute($: EngineInterface, path: string): Promise<string> {
  return (await $.fs.stat(path, { resolve: true })).realPath ?? path
}

function tail(s: string): string {
  return s.trim().split('\n').slice(-3).join(' | ').slice(0, 400)
}
