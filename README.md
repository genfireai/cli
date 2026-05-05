# GenFire CLI

Command-line interface for [GenFire](https://genfire.ai) — generate images, videos, speech, music, and sound effects, and run multi-step workflows from your terminal.

## Install

```bash
npm install -g @genfire/cli
```

Requires Node.js 20 or newer.

## Quick start

```bash
genfire auth login          # opens your browser to authorize the CLI
genfire account             # confirms you're signed in, shows your credit balance
genfire models list         # see available models
genfire generate image "a neon-lit alley at dusk" -o alley.png
```

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

## Commands

### Generate

```bash
genfire generate image   <prompt> [-m model] [-a 16:9] [-n 4] [-i ref.png] [-o out.png]
genfire generate video   <prompt> [-m model] [-d 8] [-i first-frame.png] [-o out.mp4]
genfire generate speech  <text>   --voice-id <id> [--format mp3_44100_128] [-o speech.mp3]
genfire generate music   <prompt> [-d 30] [--instrumental] [-o track.mp3]
genfire generate sfx     <prompt> [-d 5] [--loop] [-o sfx.mp3]
genfire generate lipsync --video clip.mp4 --audio voice.mp3 [-o synced.mp4]
genfire generate upload  <path>   # raw upload, prints the asset URL
```

Every media flag (`--image`, `--video`, `--audio`) accepts either an `https://` URL or a local file path. Local files are uploaded automatically before the generation runs.

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

### Workflows

GenFire's workflow system lets you chain multiple generations into one pipeline. Use `genfire workflow` to run published workflows from the CLI:

```bash
genfire workflow list
genfire workflow get  storyboard
genfire workflow run  storyboard --inputs vars.json -o results/
```

`--inputs` accepts either a path to a JSON file or a literal JSON string.

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

## License

MIT — see [LICENSE](./LICENSE).
