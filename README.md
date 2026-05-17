# GenFire CLI

Command-line interface for [GenFire](https://genfire.ai) — generate images, videos, speech, music, and sound effects, and run multi-step workflows from your terminal.

## Install

Pick whichever you prefer:

```bash
# Homebrew (macOS / Linux)
brew install genfireai/tap/genfire

# Install script (auto-installs Node if needed)
curl -fsSL https://raw.githubusercontent.com/genfireai/cli/main/install.sh | sh

# npm (requires Node 20+)
npm install -g @genfire/cli
```

Pin to a specific version:

```bash
brew install genfireai/tap/genfire    # always installs the latest stable
curl -fsSL https://raw.githubusercontent.com/genfireai/cli/main/install.sh | sh -s -- --version 0.3.5
npm install -g @genfire/cli@0.3.5
```

Requires Node.js 20 or newer for the npm and script paths. Homebrew installs Node automatically as a dependency.

## Quick start

```bash
genfire auth login          # opens your browser to authorize the CLI
genfire account             # confirms you're signed in, shows your credit balance
genfire models list         # see available models
genfire generate image "a neon-lit alley at dusk" -o alley.png
```

## Use with Claude Code

After installing the CLI, install the GenFire Skills bundle inside Claude Code:

```
/plugin marketplace add genfireai/skills
/plugin install genfire@genfire
```

Then ask Claude in plain English — *"generate a hero image of a neon-lit alley"*, *"run the storyboard workflow with these inputs"*, *"what's my credit balance?"* — and Claude runs the right `genfire` command for you. See [genfireai/skills](https://github.com/genfireai/skills) for what's bundled.

## Interactive shell

Run `genfire` with no arguments to drop into an interactive TUI with slash commands, autocomplete, command history, and a live job tracker:

```bash
genfire
```

Inside the shell:

```
› /login
› /generate image "a neon-lit alley at dusk" -o alley.png
› /workflow run storyboard --inputs '{"prompt":"sci-fi rooftop chase"}'
› /runs list
› /quit
```

Tab completes slash commands, ↑/↓ navigate history, Ctrl+C clears the input (twice to exit). The TUI auto-detects whether stdout is a terminal — when piped (e.g., `genfire | jq`), the CLI prints help instead of dropping into the TUI, so scripting still works.

## Authentication

`genfire auth login` opens a browser to `https://genfire.ai/cli-auth?session=...`, where you click **Approve**. The CLI exchanges a PKCE-protected code for an API key bound to your account, then stores it in your OS keychain (or `~/.config/genfire/credentials.json` with `chmod 600` if no keychain is available).

For headless / CI use, two alternatives:

```bash
# Either pass the API key once (still stored in keychain)
genfire auth login --api-key gfa_live_...

# Or set the env var (takes precedence over stored credentials)
export GENFIRE_API_KEY=gfa_live_...
```

Sign out and clear stored credentials:

```bash
genfire auth logout
```

### MCP setup

After logging in, one command configures the GenFire MCP server in your AI client — no manual key pasting:

```bash
genfire mcp setup                         # Claude Code (default)
genfire mcp setup --client claude-desktop
genfire mcp setup --client cursor
```

This reads the key from your keychain and writes the correct MCP config. Restart your client, then run `/mcp` (Claude Code) or check MCP settings to confirm 22 tools are connected.

## Commands

### Generate

```bash
genfire generate image   <prompt> [-m model] [-a 16:9] [-n 4] [-i ref.png] [--quality high] [--resolution 2K] [-o out.png]
genfire generate video   <prompt> [-m model] [-d 8] [-i first-frame.png] [-o out.mp4]
genfire generate speech  <text>   --voice-id <id> [--format mp3_44100_128] [-o speech.mp3]
genfire generate music   <prompt> [-d 30] [--instrumental] [-o track.mp3]
genfire generate sfx     <prompt> [-d 5] [--loop] [-o sfx.mp3]
genfire generate lipsync --video clip.mp4 --audio voice.mp3 [-o synced.mp4]
genfire generate upload  <path>   # raw upload, prints the asset URL
```

Every media flag (`--image`, `--video`, `--audio`) accepts either an `https://` URL or a local file path. Local files are uploaded automatically before the generation runs.

Model-specific image flags:

| Flag | Values | Applies to |
|---|---|---|
| `--quality` | `low` `medium` `high` `auto` | `image.gpt_image_2` only. Defaults to `high`. Cost multiplier: low=1×, medium=6×, high=22×. |
| `--resolution` | `1K` `2K` `4K` | Nano Banana family edit only (`image.nano_banana`, `image.nano_banana_2`, `image.nano_banana_pro`) — supply `--image` or `@<handle>` to route through the edit path. Cost multiplier: 1K=1×, 2K=1.5×, 4K=3×. |

### Cost preview

Estimate the credit cost of a generation before running it:

```bash
genfire cost image   "..." -m image.nano_banana_2 -n 4
genfire cost video   "..." -m video.veo_3_1 -d 8
```

### Runs

```bash
genfire runs list            [-s completed] [-c image_generation] [-l 50]
genfire runs get    <runId>
genfire runs output <runId>  [-o downloads/]
```

### Batches

Run up to 50 generations (or workflow executions) as one job, processed in parallel. Each item becomes its own run; one item failing doesn't stop the rest.

```bash
genfire batch create --mode operation --target images.generations.create --items items.json -c 3 -o out/
genfire batch list           [-s completed] [-m operation] [-l 50]
genfire batch get   <batchId>
genfire batch items <batchId> [-o out/]
```

`--items` accepts a path to a JSON file or a literal JSON array. Each entry is either `{ "input": { ... } }` or a bare input object (auto-wrapped). For image batches, set `quality` per item (`low` | `medium` | `high` | `auto`) — `image.gpt_image_2` defaults to `high`, which costs 22× a `low` image, and that multiplies across every item:

```json
[
  { "input": { "prompt": "a red fox in snow", "model": "image.gpt_image_2", "quality": "low" } },
  { "input": { "prompt": "a blue jay on a branch", "model": "image.gpt_image_2", "quality": "low" } }
]
```

`batch create` waits and polls by default (use `--no-wait` to submit and exit); completed item outputs download into `out/item-<index>/`.

### Workflows

GenFire's workflow system lets you chain multiple generations into one pipeline. Use `genfire workflow` to run published workflows from the CLI:

```bash
genfire workflow list
genfire workflow get  storyboard
genfire workflow run  storyboard --inputs vars.json -o results/
```

`--inputs` accepts either a path to a JSON file or a literal JSON string.

### Influencers

Train influencer characters in the [GenFire dashboard](https://genfire.ai/dashboard/influencers), then reference them in CLI prompts with `@<handle>` to inject identity-preserving conditioning. The CLI auto-switches to the model's edit variant and adds the influencer's reference photos behind the scenes.

```bash
genfire influencers list                    # show your ready influencers
genfire influencers get <influencerId>      # full details

# Reference an influencer in any image generation:
genfire generate image "@sarah at a coffee shop" -o sarah.png
genfire generate image "..." --influencer <id> -o out.png   # explicit alternative
```

In the interactive shell (`genfire`), typing `@` opens a live picker — arrow keys navigate, Enter or Tab inserts the handle, Esc cancels.

Notes:
- Only influencers in `ready` status can be referenced. Train and finalize them in the dashboard first.
- Currently one mention per request.
- Mention support requires a model with an internal edit variant (most do — see `genfire models list`). Pass `--model` to override the default.

### Models

```bash
genfire models list      [-c image_generation]
genfire models get       <id>
genfire models pricing   [-c video_generation]
```

## Global flags

These work on every command:

| Flag | Effect |
|---|---|
| `--json` | Print machine-readable JSON to stdout instead of pretty output |
| `--no-color` | Disable ANSI color in pretty output |
| `--no-wait` | (generation/workflow commands) Submit the run and exit immediately, instead of polling |
| `--wait-timeout <duration>` | Maximum poll time, e.g. `30m`, `600s` |
| `--wait-interval <duration>` | Polling interval, e.g. `2s`, `500ms` |
| `--no-download` | (generation/workflow commands) Don't download outputs locally; print URLs only |

## Scripting

The CLI is designed to compose with shell tools:

```bash
# Generate 10 variants from a CSV of prompts, save URLs to a file
while IFS= read -r prompt; do
  genfire generate image "$prompt" --json --no-download \
    | jq -r '.run.output.images[0].url'
done < prompts.csv > image_urls.txt

# Get the most recent completed video and play it
runId=$(genfire runs list --status completed --capability video_generation --limit 1 --json | jq -r '.data[0].id')
genfire runs output "$runId" -o ./latest.mp4
open ./latest.mp4
```

## Configuration

Persistent settings live at `~/.config/genfire/config.json` (or `%APPDATA%\genfire\config.json` on Windows). Override the API base URL with `GENFIRE_API_BASE_URL` for local development.

## Troubleshooting

If a command fails, the CLI prints a structured error like:

```
API error 401 (authentication_required): A Bearer token is required for this endpoint.
```

The first parenthetical (`authentication_required`) is the stable error code. The list below maps the most common ones to their fix.

| Error code | What it means | Fix |
|---|---|---|
| `authentication_required` | No API key found, or the key was rejected | Run `genfire auth login`. If you set `GENFIRE_API_KEY`, confirm the value matches a current key on your developer page. |
| `invalid_api_key` | The stored key was revoked or rotated | `genfire auth logout && genfire auth login` |
| `cli_session_expired` | Browser approval took longer than 10 minutes | `genfire auth login` again |
| `cli_session_pending` | You haven't clicked Approve in the browser yet | Click Approve at the URL the CLI printed |
| `invalid_model` | The model id you passed isn't recognized | `genfire models list` (or `genfire models list -c image_generation`) to see valid ids |
| `insufficient_credits` | Your balance is too low for this run | `genfire credits` to check balance, top up at https://genfire.ai/dashboard/credits |
| `invalid_prompt` | Prompt was empty or malformed | Provide a non-empty prompt as a positional argument |
| `invalid_count` | Image count is outside `1..4` | Use `-n 1` through `-n 4` |
| `invalid_aspect_ratio` | Aspect ratio not supported by this model | `genfire models get <id>` to see supported ratios |
| `upload_too_large` | File exceeds 5GB | Compress, trim, or split the source file |
| `invalid_size_bytes` | Upload size header is wrong | Re-run; usually transient |
| `cli_session_consumed` | Login session was already exchanged | `genfire auth login` to start a fresh session |
| `wait_timeout` | The poll loop hit `--wait-timeout` before the run finished | The run is still going on the server. Check it with `genfire runs get <id>`. Increase `--wait-timeout 30m` next time. |
| `download_failed` | Output URL was unreachable | Re-run `genfire runs output <id> -o <path>` to retry the download. Run is unaffected. |
| `invalid_inputs` | Workflow `--inputs` JSON didn't parse or wasn't an object | Check the workflow's expected schema with `genfire workflow get <id>` |
| `unknown_model` | Cost preview can't find pricing for that model | `genfire models pricing` to see priced models |
| `not_authenticated` | (TUI only) You ran a slash command before `/login` | Run `/login` first |
| `auth_denied` | You clicked Deny in the browser | Run `genfire auth login` again to retry |

If a generation **submitted but failed**, the run still has an id — `genfire runs get <id>` will print the underlying provider error. Common provider errors:

- `content_policy_violation` — the prompt was rejected by the model's safety filter. Rephrase and re-run.
- `provider_timeout` — the upstream model took too long. Safe to re-run; you'll only be charged once thanks to idempotency keys.

### Reporting bugs

When filing an issue at [genfireai/cli](https://github.com/genfireai/cli/issues), include:

1. The exact command you ran (redact any prompts containing private content)
2. The full error output
3. The output of `genfire --version`
4. Your OS and Node version (`node --version`)
5. Whether you're using the keychain (default) or `GENFIRE_DISABLE_KEYTAR=1`

### Common environment problems

- **`zsh: command not found: genfire`** — the global install didn't add `genfire` to your PATH. Check `npm config get prefix` and confirm its `bin/` is on your `$PATH`. The fix is usually `export PATH="$(npm config get prefix)/bin:$PATH"` in your shell rc file.
- **Browser doesn't open during `auth login`** — pass `--no-browser` and copy the URL manually. Common in SSH sessions, WSL2, and some sandboxed environments.
- **OS keychain unavailable** — on Linux without `libsecret-tools` installed, the CLI falls back to a chmod-600 file at `~/.config/genfire/credentials.json`. To install the keychain: `apt install libsecret-1-dev` (Debian/Ubuntu) or equivalent.

## License

MIT — see [LICENSE](./LICENSE).
