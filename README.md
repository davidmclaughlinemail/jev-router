# jev-router

A Claude Code mod that routes every turn to the right model.

- **Jev decides.** Each prompt goes to TypeSafe's Jev, which returns a calibrated choice between Haiku, Opus, Fable and image work, plus two side checks (is this security work, is this a premium image).
- **You stay in control.** When Jev's confidence is under your threshold, a question pops up showing its ranking and you pick. Fable always asks first (configurable). `/route` overrides, locks, and explains.
- **Routing is enforced, not suggested.** A `turn.step` hook sends every model request of the turn to the chosen model, and subagents that don't name a model follow the same route.
- **All graphics go to OpenAI.** The mod gives Claude two tools, `generate_image` and `edit_image`. By default they run through the Codex CLI on your ChatGPT plan, so no API key is needed; set `imageBackend` to `api` to use the Images API instead. Image turns run on Haiku, which just drives those tools. Flare is the default tier; Sunburst is used when Jev flags a premium asset or Claude asks for it.

## Routing policy

| Route | Model (default id) | Used for |
|---|---|---|
| haiku | `claude-haiku-5-5` | Lookups, small edits, summaries, commit messages, chat |
| opus | `claude-opus-5-5` | Ordinary engineering, and the fallback for everything |
| fable | `claude-fable-5-1` | Architecture, long agentic work, deep ambiguous problems |
| image | Haiku + Codex image generation (or `gpt-image-2.5-flare` / `-sunburst` on the API) | Creating or editing any image |
| security | Opus + OpenAI Daybreak Blue through Codex (`--cyber-access-program daybreak_blue`), read-only | Vulnerability review, threat modeling, secure code review, after you say yes |

Rules on top of Jev:
- Security work (the classifier picks `security`, or Jev's `security` check is over 50%) **asks first**: "Send it to OpenAI Daybreak?" Yes runs the turn on Opus, which hands the analysis to the `daybreak` tool. That tool runs Codex read-only on your project and returns the findings, and Claude applies fixes only if you ask. No, or nobody answering, means Opus. Security work never goes to Fable, which carries extra safeguards for cybersecurity.
- The `daybreak` tool refuses on any turn you didn't approve (a yes, or `/route security`), so your code never goes to OpenAI unasked.
- Jev confidence below `confidenceThreshold` (default 0.7): you are asked.
- Jev picks Fable confidently and `confirmFable` is on: you are asked.
- Jev unreachable or no key: Haiku classifies with a one-word answer; if that fails too, Opus.
- Prompts typed while a turn is running keep the running turn's model.

The route descriptions Jev scores against live in `hooks/jev.ts` (`ROUTE_CRITERIA`). Editing them is how you tune the policy.

## Requirements

- Claude Code **v2.1.287 or later**, in the terminal or the Code tab of the Desktop app (mods run there)
- `TYPESAFE_API_KEY`: a Jev key from console.typesafe.ai (early access). Without it the router still works on the Haiku fallback.
- For images, either backend:
  - **codex (default):** the Codex CLI, recent enough for OpenAI's current models (0.162 or later; older versions are refused), signed in with `codex login` using your ChatGPT account. On Windows the mod runs `node.exe` from `Program Files\nodejs` on Codex's npm install by absolute path; if yours lives elsewhere, set `codexPath`.
  - **api:** `OPENAI_API_KEY` with access to `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`. On macOS or Linux, `curl` and `openssl` on the PATH; on Windows nothing extra (System32 `curl.exe` and `powershell.exe` by absolute path).
- For Daybreak: the same Codex CLI. The mod asks for `daybreakProgram` (default `daybreak_blue`), but your OpenAI account decides what you actually get. Codex doesn't say whether the program was granted or the server fell back to standard access, and no setting here relaxes guardrails your account doesn't have.

Put the keys in your shell profile or in `~/.claude/settings.json` under `env`. There is no `.env` file: the mod reads Claude Code's own environment.

To test in one folder without touching your global settings, copy `examples/settings.local.json` to `<test folder>/.claude/settings.local.json`, fill in the keys, and start `claude --plugin-dir <path to jev-router>` from that folder. The keys apply to that folder only. The mod itself still needs `--plugin-dir`, because `CLAUDE_CODE_PLUGIN_DIRS` in a folder's settings does not load it.

## Install

Try it for one session:

```bash
claude --plugin-dir /path/to/jev-router
```

Load it in every session by adding the folder to `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/jev-router",
    "TYPESAFE_API_KEY": "...",
    "OPENAI_API_KEY": "..."
  }
}
```

Check it loaded: run `/plugin` and look for `1 mod active · jev-router`. Before installing, `claude plugin validate ./jev-router` lists every event it hooks and every call it makes.

## Use

| Command | Effect |
|---|---|
| `/route` or `/route why` | The last decision: route, model, reason, and Jev's full probability breakdown |
| `/route opus` (or haiku, fable, image, security) | Next turn only, then Jev decides again. `/route security` counts as approving Daybreak |
| `/route lock fable` | Every turn on that route until `/route auto` |
| `/route auto` | Hand control back to Jev |
| `/route log` | The last 10 decisions |

`/route` runs immediately, even while Claude is working. The line under the prompt always shows the current route, who decided, and the confidence, for example `Opus 5.5 (Jev 91%)`.

## Settings

Change these in `/config` (each is a row there) or under `pluginConfigs` in settings, keyed `jev-router@inline` for a `--plugin-dir` install:

| Setting | Default | |
|---|---|---|
| `haikuModel`, `opusModel`, `fableModel` | `claude-haiku-5-5`, `claude-opus-5-5`, `claude-fable-5-1` | Model ids per route |
| `confidenceThreshold` | `0.7` | Ask below this |
| `confirmFable` | `true` | Ask before any Fable turn |
| `routeSubagents` | `true` | Subagents without a model follow the route |
| `imageDir` | `assets/generated` | Where images are saved |
| `imageBackend` | `codex` | `codex` (ChatGPT plan, through the Codex CLI) or `api` (Images API, `OPENAI_API_KEY`). No automatic fallback between them |
| `codexPath` | empty | Where Codex is, if not found automatically: `codex.js` on Windows, the `codex` executable elsewhere |
| `daybreakProgram` | `daybreak_blue` | Cyber access program requested for approved security work: `daybreak_blue`, `daybreak_red` (approved partners only) or `standard` |
| `daybreakModel` | empty | Empty uses Codex's default model; otherwise the model id passed with `-m` |
| `logPath` | `.jev-router/decisions.jsonl` | Decision log (add it to `.gitignore`) |

## The decision log

Every decision, override, image call and finished turn (with its token usage) is one JSON line in `logPath`. Turns where you overrode Jev, or picked differently when asked, are your labeled data for tuning `ROUTE_CRITERIA` and the threshold. The log keeps the last 5,000 lines.

## Things to know

- **Model switches cost cache.** Prompt caching is per model, so a turn routed to a different model than the previous one re-reads the conversation without the cache. The route holds for a whole turn to limit this; frequent switching in a long session costs more than it looks.
- **Jev sees the prompt plus the tail of Claude's last reply**, so a short follow-up like "yes, do that" routes with its context.
- **Codex images take about a minute.** Each one is a full Codex agent run (generation plus saving), sandboxed to `imageDir`, and it counts against your ChatGPT plan's Codex limits. The mod checks that the file exists afterwards rather than trusting Codex's reply.
- **Daybreak needs a working Codex sandbox.** Codex reads your code by running shell commands inside its sandbox. On Windows, a broken `elevated` sandbox setup ("setup refresh had errors") makes every read fail, and the report then says it couldn't read the files. Check with `codex exec -s read-only "print the first line of README.md"` in any project. The mod leaves the sandbox mode to your Codex config.
- **Image size (api backend).** Image files are decoded from the API's base64 output; very large outputs (over about 4 MB of base64) can exceed the mod API's read limit on edits.
- **Trust.** A mod runs with your permissions and reads the two API keys from your environment. Keep it in a folder or marketplace you control.

## Tests

```bash
claude plugin validate ./jev-router
claude plugin test ./jev-router
```

The suite (36 tests) covers confident routing, low-confidence asks, Fable confirmation, the Daybreak ask and the `daybreak` tool's approval gate, image routing, both fallbacks, subagent routing, every `/route` form, settings, and both image backends, with Jev, OpenAI, Codex, files and dialogs answered in memory.
