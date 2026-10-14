import type { EngineInterface } from 'claude-code'

export type ImageTier = 'flare' | 'sunburst'

export const IMAGE_MODELS: Record<ImageTier, string> = {
  flare: 'gpt-image-2.5-flare',
  sunburst: 'gpt-image-2.5-sunburst',
}

const OPENAI = 'https://api.openai.com/v1/images'

export type ImageArgs = {
  prompt: string
  tier: ImageTier
  size?: string
  quality?: string
  background?: string
  outputFormat?: string
  filename?: string
}

export type EditArgs = ImageArgs & { imagePaths: readonly string[]; maskPath?: string }

export type ImageOutcome = { ok: true; path: string; model: string } | { ok: false; error: string }

/** Text-to-image through the Images API, saved as a file under `dir`. */
export async function generateImage($: EngineInterface, apiKey: string, dir: string, a: ImageArgs): Promise<ImageOutcome> {
  const model = IMAGE_MODELS[a.tier]
  const body: Record<string, unknown> = { model, prompt: a.prompt, n: 1 }
  if (a.size) body.size = a.size
  if (a.quality) body.quality = a.quality
  if (a.background) body.background = a.background
  if (a.outputFormat) body.output_format = a.outputFormat

  const res = await $.http.fetch(`${OPENAI}/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return { ok: false, error: `OpenAI HTTP ${res.status}: ${openAiMessage(res.text)}` }
  return saveFirstImage($, res.text, dir, a, model)
}

/**
 * Image edit. The Images edit endpoint takes multipart form data with the image files,
 * which $.http.fetch (text bodies only) cannot send, so curl does the upload.
 * The key goes to curl on stdin (`-H @-`), never on its command line.
 */
export async function editImage($: EngineInterface, apiKey: string, dir: string, a: EditArgs): Promise<ImageOutcome> {
  const model = IMAGE_MODELS[a.tier]
  for (const p of [...a.imagePaths, ...(a.maskPath ? [a.maskPath] : [])]) {
    if (!(await $.fs.exists(p))) return { ok: false, error: `No such file: ${p}` }
  }
  const responseFile = `${dir}/.last-edit-response.json`
  const sys = await windowsSystem32($)

  const argv = [
    sys ? `${sys}\\curl.exe` : 'curl', '-sS', '-X', 'POST', `${OPENAI}/edits`,
    '-H', '@-',
    '--create-dirs',
    '-F', `model=${model}`,
    '-F', `prompt=${a.prompt}`,
    '-o', responseFile,
    '-w', '%{http_code}',
  ]
  for (const p of a.imagePaths) argv.push('-F', `image[]=@${p}`)
  if (a.maskPath) argv.push('-F', `mask=@${a.maskPath}`)
  if (a.size) argv.push('-F', `size=${a.size}`)
  if (a.quality) argv.push('-F', `quality=${a.quality}`)
  if (a.background) argv.push('-F', `background=${a.background}`)
  if (a.outputFormat) argv.push('-F', `output_format=${a.outputFormat}`)

  const run = await $.process.run(argv, { stdin: `Authorization: Bearer ${apiKey}\n`, timeoutMs: 300_000 })
  if (run.exitCode !== 0) return { ok: false, error: `curl failed: ${run.stderr.slice(0, 300)}` }
  const text = await $.fs.read(responseFile)
  const status = Number(run.stdout.trim())
  if (status < 200 || status >= 300) return { ok: false, error: `OpenAI HTTP ${status}: ${openAiMessage(text)}` }
  return saveFirstImage($, text, dir, a, model)
}

async function saveFirstImage($: EngineInterface, json: string, dir: string, a: ImageArgs, model: string): Promise<ImageOutcome> {
  let b64: string | undefined
  try {
    b64 = (JSON.parse(json) as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json
  } catch {
    return { ok: false, error: 'OpenAI answered with something that is not JSON' }
  }
  if (!b64) return { ok: false, error: 'OpenAI answered without image data' }

  const path = await outputPath($, dir, a)

  // $.fs.write writes text only, so a host tool decodes the base64 into the binary file.
  const sys = await windowsSystem32($)
  let run
  if (sys) {
    // The output path goes in through the environment, never spliced into the script.
    run = await $.process.run(
      [`${sys}\\WindowsPowerShell\\v1.0\\powershell.exe`, '-NoProfile', '-NonInteractive', '-Command', DECODE_PS],
      { stdin: b64, env: { JEV_IMAGE_OUT: path } },
    )
  } else {
    await $.process.run(['mkdir', '-p', dir])
    run = await $.process.run(['openssl', 'base64', '-d', '-A', '-out', path], { stdin: b64 })
  }
  if (run.exitCode !== 0) return { ok: false, error: `Could not write ${path}: ${run.stderr.slice(0, 200)}` }
  return { ok: true, path, model }
}

// Reads base64 on stdin and writes the bytes to $env:JEV_IMAGE_OUT, creating its folder.
const DECODE_PS =
  "$ErrorActionPreference = 'Stop'; try { " +
  '$p = [IO.Path]::GetFullPath($env:JEV_IMAGE_OUT); ' +
  '[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)); ' +
  '[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String([Console]::In.ReadToEnd())) ' +
  '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'

/**
 * Windows has no mkdir or openssl executables, and what is on PATH depends on how
 * Claude Code was launched, so on Windows the System32 tools are run by absolute path.
 * Resolves undefined everywhere else.
 */
export async function windowsSystem32($: EngineInterface): Promise<string | undefined> {
  if ((await $.env.get('OS')) !== 'Windows_NT') return undefined
  return `${(await $.env.get('SystemRoot')) ?? 'C:\\Windows'}\\System32`
}

function openAiMessage(text: string): string {
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image'
  )
}

/** Where an image is saved: `<dir>/<filename or prompt slug>.<format>`, the same for every backend. */
export async function outputPath($: EngineInterface, dir: string, a: ImageArgs): Promise<string> {
  const ext = a.outputFormat === 'jpeg' ? 'jpg' : (a.outputFormat ?? 'png')
  const name = sanitize(a.filename) ?? `${slug(a.prompt)}-${await $.clock.now()}`
  return `${dir}/${name}.${ext}`
}

function sanitize(name: string | undefined): string | undefined {
  if (!name) return undefined
  const base = name.replace(/\.(png|jpe?g|webp)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-')
  return base.length > 0 ? base : undefined
}
