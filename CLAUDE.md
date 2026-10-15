# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`jev-router` is a Claude Code **mod** (plugin with a hooks module, needs Claude Code v2.1.287+). For each prompt it picks a route (`haiku` / `opus` / `fable` / `image` / `security`), forces every main-loop model request of that turn onto the chosen model, and adds three tools: `generate_image` and `edit_image` for OpenAI image work, and `daybreak`, which hands approved security work to OpenAI Daybreak through Codex. Routing decisions come from TypeSafe's Jev API (`https://api.typesafe.ai/v1/systemone`). README.md is the user-facing spec for the routing policy, `/route` commands, and settings.

## Commands

```powershell
claude plugin validate .           # manifest + lists every hooked event and outbound call; add --strict for CI
claude plugin test .               # runs every *.test.ts under the folder; exits 1 on failure
claude --plugin-dir .              # load the mod for one interactive session
```

`claude plugin test` takes no flag to pick a single test. To focus on one, put it in its own `*.test.ts` file under a separate folder, or point the command at a folder that holds only that file.

## Architecture

- `.claude-plugin/plugin.json`: manifest. Its `userConfig` holds the user-settable options. Defaults are **duplicated** in `readOptions()` in `hooks/register.ts`; change both together.
- `hooks/hooks.json` → `hooks/register.ts`: the only entry point. `register(on, options)` wires these engine events:
  - `prompt.submit`: calls `decide()`, sets the module-level `S.active` decision, updates the status line, appends to the log, and (on image turns) adds context telling Claude to use the image tools. It skips commands, meta prompts, and prompts typed mid-turn (`e.turnId`), so the running turn keeps its model. On error, `.catch` passes the prompt through unrouted.
  - `turn.step`: the enforcement point. It rewrites `e.model` to `S.active.model` for main-loop steps only (`!e.agentId`).
  - `agent.spawn`: subagents that name no model get the routed model (`routeSubagents`).
  - `turn.complete`: logs token usage per turn.
  - `command.run` for `/route` (registered in `session.start` with `immediate: true`), and `tool.call` handlers for `mcp__jev-router__generate_image` / `edit_image` (registered in `session.start` via `$.tool.register`).
- Decision order in `decide()`: a `/route` override or lock wins → classify → **security ask** (the classifier picked `security`, or `securitySensitive > 0.5` on a non-image route: ask "Send it to OpenAI Daybreak?"; yes → route `security`, which runs on Opus; anything else → Opus, never Fable) → ask the user if Jev's confidence is below the threshold, **or else** confirm Fable if `confirmFable` is on. If the user dismisses the dialog, Jev's pick stands, except for Fable: with `confirmFable` on, Fable runs only on an explicit yes. Dismissed or headless (`-p`, where nobody can answer), the turn runs on Opus with `decidedBy: 'rule'`. `decidedBy: 'jev'` means "the classifier's pick", so check `classification.source` to see whether Jev, Haiku or the default decided. `classifierName()` maps that source to the name the status line shows.
- `hooks/jev.ts`: classification. `ROUTE_CRITERIA` **is the routing policy**: the descriptions are sent to Jev as `choice` criteria and reused in the Haiku fallback prompt. Fallback chain: no `TYPESAFE_API_KEY` or a Jev error → `classifyWithHaiku` (one-word answer, fixed confidence 0.75, so it never triggers the ask) → `defaultClassification` (Opus). `classifyWithJev` throws on any problem, and `classifyWithHaiku` never throws.
- `hooks/daybreak.ts`: the `daybreak` tool for the `security` route. It runs `codex exec --cyber-access-program <daybreakProgram> [-m <daybreakModel>] -s read-only -C <absolute project root> -o .jev-router/daybreak-last-report.md -` with the task on stdin, and returns that report (an empty one is a failure). `runDaybreak` in `register.ts` refuses unless `S.active.route === 'security'`, meaning the user said yes or typed `/route security`. That gate is what keeps code from going to OpenAI unasked, so don't loosen it. It reuses `codexLaunch`/`absolute`/`tail` from `codex.ts`. Use `--cyber-access-program`, which works with `--ephemeral` and needs no feature flag. Don't use `--enable cli_daybreak` with `-c daybreak=true`: that feature is under development and the binary says it isn't supported on ephemeral threads.
- Image backends, chosen by the `imageBackend` setting (no automatic fallback):
  - `hooks/codex.ts` (default, `codex`): runs `codex exec` with the request on stdin (`-`), `-s workspace-write -C <absolute imageDir>`, source images attached with `-i`, and `-o <imageDir>/.codex-last-message.txt`. Writing that reply file first creates `imageDir`. Success means the named file exists afterwards; Codex's reply is never trusted. On Windows `codex` is an npm `.cmd`/`.ps1` shim that can't run by argv, so `codexLaunch()` runs `%ProgramFiles%\nodejs\node.exe` with `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js` (`codexPath` overrides). Codex 0.128 was refused by OpenAI's server ("requires a newer version of Codex"), so keep the CLI current.
  - `hooks/images.ts` (`api`): `outputPath()` names files for both backends. Generations use `$.http.fetch` (JSON). Edits need a multipart upload, which `$.http.fetch` can't send, so they shell out to `curl`, with the API key passed on **stdin** (`-H @-`), never in argv (a test checks this). Saving shells out because `$.fs.write` is text-only. On macOS/Linux it uses `mkdir -p` and `openssl base64 -d`; on Windows it uses System32 `powershell.exe` with the `DECODE_PS` script.
- All engine access goes through `$` (`$.fs`, `$.http`, `$.env`, `$.ui`, `$.process`, `$.model`, `$.clock`); there are no Node imports. State lives in module-level `S` and resets on reload.
- Decision log: JSONL at `logPath` (default `.jev-router/decisions.jsonl`), rewritten whole on every append and capped at 5,000 lines. Entry `type`s are `decision`, `override`, `image`, `daybreak`, `turn`.

## Windows (this machine)

- `$.process.run` **rejects** when a command can't start (`ENOENT … not found`). It doesn't return a nonzero exit code, so every host command must exist.
- A PowerShell launch has no `mkdir` or `openssl` on PATH. That broke both image tools until `windowsSystem32()` was added.
- On Windows (`OS=Windows_NT`), `images.ts` runs `%SystemRoot%\System32\curl.exe` and `…\WindowsPowerShell\v1.0\powershell.exe` **by absolute path**, so the launch chain's PATH doesn't matter. Keep it that way for any new host command.
- `curl --create-dirs` replaces `mkdir` for the edit response file.
- Codex's `elevated` Windows sandbox fails on this machine with `helper_unknown_error: setup refresh had errors`, so Codex can't run any shell command and Daybreak can't read files. The cause is in `~/.codex/.sandbox/sandbox.<date>.log`: the setup needs exclusive access to Codex's own runtime files (`%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\...\node_repl.exe`, `node.exe`) to change their permissions while Codex is running them (os error 32). The Codex Desktop app holds them too. Admin rights and a closed app didn't fix it. On 2026-10-14 the user switched `~/.codex/config.toml` to `[windows] sandbox = "unelevated"`, with a backup at `config.toml.bak-2026-10-14-elevated`, and Daybreak then worked end to end.
- The PowerShell decode gets its output path through the `JEV_IMAGE_OUT` env var. Never splice paths into `DECODE_PS`.
- Unit tests mock `process.run`, so they only check the argv. To check the real behaviour, launch from **PowerShell**, not Git Bash, which has `/usr/bin` on PATH and hides the problem: `claude --plugin-dir . -p "<ask it to call mcp__jev-router__edit_image …>" --allowedTools mcp__jev-router__edit_image`. With a fake `OPENAI_API_KEY`, success looks like `OpenAI HTTP 401`.

## Tests

`tests/router.test.ts` uses `claude-code/testing`. The `world()` helper answers every engine event in memory (env, clock, fs, http, ui, model, AskUserQuestion, turn.step, agent.spawn), so tests drive the mod with `$.prompt.submit`, `$.turn.step`, `$.agent.spawn`, `$.command.run` and `$.tool.call`, then assert on the recorded `seen` state. A `jev` value of `undefined` simulates Jev returning HTTP 503. Per-test plugin options go in the test's second argument, e.g. `{ options: { opusModel: ... } }`. The engine resolves relative paths before the mod sees them, using the host's separators (`C:\…\logo.png` on Windows), so `findFile` normalizes `\` to `/` and matches by suffix. The Windows image-tool tests switch platform by putting `OS: 'Windows_NT'` and `SystemRoot` in the `env` they pass to `world()`.

`claude plugin validate` warns that a CLAUDE.md at the plugin root isn't shipped with the plugin. That's expected: this file is for development sessions only.

## Other files

`../jev-router.zip` contains only empty directories, not the source.
