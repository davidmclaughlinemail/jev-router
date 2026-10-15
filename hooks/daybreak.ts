import type { EngineInterface } from 'claude-code'
import { absolute, codexLaunch, tail } from './codex'

/**
 * Security work handed to OpenAI Daybreak through the Codex CLI, on the user's ChatGPT plan.
 *
 * `--cyber-access-program` asks the server for the Daybreak tier. Whether it is granted
 * depends on the user's OpenAI account, not on anything sent from here.
 *
 * Codex runs read-only at the project root: it can read the code but change nothing, and
 * Claude applies any fixes in the session under the user's normal permissions. The report
 * is Codex's final message, which `-o` writes to `replyPath`.
 */

// A review can read a lot of code; allow the API's maximum.
const TIMEOUT_MS = 600_000

export type DaybreakProgram = 'standard' | 'daybreak_blue' | 'daybreak_red'

export function daybreakName(p: DaybreakProgram): string {
  return p === 'daybreak_red' ? 'Daybreak Red' : p === 'daybreak_blue' ? 'Daybreak Blue' : 'Daybreak (standard access)'
}

export type DaybreakOutcome = { ok: true; report: string } | { ok: false; error: string }

export async function daybreakReview(
  $: EngineInterface,
  codexPath: string,
  program: DaybreakProgram,
  model: string,
  replyPath: string,
  task: string,
  paths: string[],
): Promise<DaybreakOutcome> {
  const launch = await codexLaunch($, codexPath)
  if ('error' in launch) return { ok: false, error: launch.error }

  for (const p of paths) {
    if (!(await $.fs.exists(p))) return { ok: false, error: `No such file: ${p}` }
  }

  // Clearing the reply file first creates its folder and drops any earlier report.
  await $.fs.write(replyPath, '')
  const argv = [
    ...launch.argv, 'exec',
    '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '--cyber-access-program', program,
    ...(model ? ['-m', model] : []), // empty: Codex's own default model
    '-s', 'read-only',
    '-C', await absolute($, '.'),
    '-o', await absolute($, replyPath),
    '-', // the task comes on stdin
  ]

  const run = await $.process.run(argv, { stdin: instructions(task, paths), timeoutMs: TIMEOUT_MS })
  if (run.exitCode !== 0) return { ok: false, error: `codex exited ${run.exitCode}: ${tail(run.stderr)}` }
  const report = (await $.fs.read(replyPath).catch(() => '')).trim()
  if (!report) return { ok: false, error: 'Daybreak finished without a report.' }
  return { ok: true, report }
}

function instructions(task: string, paths: string[]): string {
  const lines = [
    "Defensive security work on this repository, handed over from Claude Code by the repository's owner.",
    '',
    `Task: ${task}`,
  ]
  if (paths.length) lines.push('', 'Start with these files:', ...paths.map(p => `- ${p}`))
  lines.push(
    '',
    'You are read-only: do not try to change any file.',
    'Report each finding with its file and line, severity, why it matters, and a concrete fix (a diff where it helps).',
    'If you find nothing, say so plainly.',
  )
  return lines.join('\n')
}
