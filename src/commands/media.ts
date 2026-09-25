import { Command } from "commander";
import type { GenFireClient, Run } from "@genfire/sdk";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient, publicApiRequest } from "../client.js";
import { CliError } from "../errors.js";
import { bold, cyan, dim, printJson, printResult } from "../output.js";
import {
  downloadOutputs,
  extractOutputUrls,
  reportRunCompletion,
  waitForRun,
} from "../runHelpers.js";
import { resolveComposeMedia } from "./compose.js";

/**
 * Media utilities over `/v1/media/*` and the other one-shot media routes:
 * inspect, analyze, voice conversion/cloning, website capture, product
 * extraction and scene blockouts.
 *
 * `frames` lived inside `registerRuntimeCommands` and was registered on the
 * ROOT program from there, so a reader of index.ts could not see where it came
 * from and hiding the (currently dark) `runtime` group would have taken a
 * shipping command down with it. `/v1/media/frames` is independent of the
 * isolated execution runtime and ships this release, so it registers here —
 * top-level `frames` stays for existing scripts; `media frames` is the alias.
 */

function framesCommand(cmd: Command): Command {
  return cmd
    .description("Extract actual video frames and a contact sheet")
    .option("--times <seconds>", "Comma-separated seconds")
    .option("--width <pixels>", "Frame width")
    .action(async (video, opts) =>
      printJson(
        await publicApiRequest("POST", "/media/frames", {
          body: {
            video_url: video,
            ...(opts.times ? { times: opts.times.split(",").map(Number) } : {}),
            ...(opts.width ? { width: Number(opts.width) } : {}),
          },
        }),
      ),
    );
}

const YOUTUBE_HOST = /^https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be)\//i;
const ANALYSIS_DEPTHS = ["summary", "scenes", "shot-list"];

function parseDurationMs(value: string, flag: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) throw new CliError(`Invalid duration for ${flag}: ${value}`, "invalid_duration");
  const amount = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  if (unit === "ms") return Math.max(1, Math.round(amount));
  if (unit === "m") return Math.round(amount * 60 * 1000);
  return Math.round(amount * 1000);
}

interface WaitFlags {
  wait: boolean;
  waitTimeout: string;
  waitInterval: string;
}

function waitOptions(cmd: Command, timeout = "15m"): Command {
  return cmd
    .option("--no-wait", "Don't wait for the run; print the queued run and exit")
    .option("--wait-timeout <duration>", "Maximum time to wait, e.g. 15m, 600s", timeout)
    .option("--wait-interval <duration>", "Polling interval while waiting", "3s");
}

/** Poll a queued run to a terminal state (or print it, with --no-wait). */
async function settle(client: GenFireClient, queued: Run, opts: WaitFlags): Promise<Run | null> {
  if (!opts.wait || queued.status === "completed" || queued.status === "failed") {
    if (!opts.wait) {
      printResult(queued, () => {
        process.stderr.write(`${dim("Run queued:")} ${queued.id} ${dim(`(${queued.status})`)}\n`);
        process.stderr.write(`${dim("Re-check with:")} genfire runs get ${queued.id}\n`);
      });
      return null;
    }
    return queued;
  }
  process.stderr.write(`${dim(`Polling run ${queued.id}...`)}\n`);
  const run = await waitForRun(client, queued.id, {
    intervalMs: parseDurationMs(opts.waitInterval, "--wait-interval"),
    timeoutMs: parseDurationMs(opts.waitTimeout, "--wait-timeout"),
    onTick: (current, elapsed) => {
      if (current.status !== "completed" && current.status !== "failed") {
        process.stderr.write(`${dim(`  status=${current.status} elapsed=${Math.round(elapsed / 1000)}s\r`)}`);
      }
    },
  });
  process.stderr.write("\n");
  return run;
}

function failIfFailed(run: Run): void {
  if (run.status === "failed") {
    throw new CliError(`Run ${run.id} failed${run.error ? `: ${run.error.message}` : ""}`, run.error?.code || "run_failed");
  }
}

async function downloadAndReport(run: Run, fallbackBase: string, output: string | undefined, download: boolean): Promise<void> {
  if (run.status !== "completed" || !download) {
    reportRunCompletion(run, []);
    return;
  }
  const outputs = extractOutputUrls(run, fallbackBase);
  const written = outputs.length > 0 ? await downloadOutputs(outputs, output) : [];
  reportRunCompletion(run, written);
}

/** `desktop:1440x900` / `1440x900` → a capture viewport. */
export function parseViewport(raw: string): { name?: string; width: number; height: number } {
  const m = /^(?:([A-Za-z0-9_-]+):)?(\d+)x(\d+)$/.exec(raw.trim());
  if (!m) throw new CliError(`--viewport "${raw}" must look like [name:]WIDTHxHEIGHT, e.g. mobile:390x844.`, "invalid_viewport");
  return { ...(m[1] ? { name: m[1] } : {}), width: Number(m[2]), height: Number(m[3]) };
}

async function readJson(path: string, flag: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new CliError(`Could not read ${flag} ${path}: ${(err as Error).message}`, "invalid_file");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`${flag} ${path} must contain a JSON object.`, "invalid_file");
  }
  return parsed as Record<string, unknown>;
}

export function registerMediaCommands(program: Command): void {
  framesCommand(program.command("frames <video>"));

  const media = program
    .command("media")
    .description("Inspect, analyze, re-voice and capture media (probe, video analysis, voice conversion, website capture, product extraction)");

  framesCommand(media.command("frames <video>"));

  // ---- inspect (free, synchronous) ----
  media
    .command("inspect <source>")
    .description("Measure a file: real duration, display width/height, fps, audio track. URL, local path (uploaded) or run_ id. FREE")
    .action(async (source: string) => {
      // `run_…` ids are resolved by the route itself (account-scoped). Other run
      // id shapes (`dash_video_…`) are resolved to their output URL here, and a
      // local path is uploaded first.
      let url = source;
      if (!/^run_/.test(source) && !/^https?:\/\//i.test(source)) {
        url = await resolveComposeMedia(await createClient(), source);
      }
      const result = await publicApiRequest<Record<string, unknown>>("POST", "/media/inspect", { body: { url } });
      printResult(result, () => {
        for (const [key, value] of Object.entries(result)) {
          if (key === "object") continue;
          const shown = value && typeof value === "object" ? JSON.stringify(value) : String(value);
          process.stdout.write(`${dim(`${key}:`)} ${shown}\n`);
        }
      });
    });

  // ---- analyze (billed, async) ----
  waitOptions(
    media
      .command("analyze <video>")
      .description("Watch a video and describe it — summary, scenes or a shot list (POST /v1/videos/analyses). URL, local path, run_ id or a YouTube link. Billed")
      .option("--depth <depth>", `How detailed: ${ANALYSIS_DEPTHS.join(" | ")}`, "scenes")
      .option("--youtube", "Treat the URL as a YouTube link (auto-detected for youtube.com / youtu.be)")
      .option("--team <teamId>", "Bill this run to a workspace credit pool instead of your own balance"),
  ).action(async (video: string, opts: WaitFlags & { depth: string; youtube?: boolean; team?: string }) => {
    if (!ANALYSIS_DEPTHS.includes(opts.depth)) {
      throw new CliError(`--depth must be one of: ${ANALYSIS_DEPTHS.join(", ")}.`, "invalid_depth");
    }
    const client = await createClient();
    const isYoutube = opts.youtube || YOUTUBE_HOST.test(video);
    const source = isYoutube ? { youtube_url: video } : { video_url: await resolveComposeMedia(client, video) };
    const queued = await publicApiRequest<Run>("POST", "/videos/analyses", {
      body: { ...source, depth: opts.depth, ...(opts.team ? { team_id: opts.team } : {}) },
      idempotencyKey: randomUUID(),
    });
    const run = await settle(client, queued, opts);
    if (!run) return;
    failIfFailed(run);
    printResult(run, () => {
      const output = (run.output || {}) as Record<string, unknown>;
      const text = output.summary ?? output.text ?? output.analysis;
      if (typeof text === "string") process.stdout.write(`${text}\n`);
      else process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    });
  });

  // ---- convert-voice (billed per source second, synchronous) ----
  media
    .command("convert-voice")
    .description("Keep a performance, change the voice (speech-to-speech, ElevenLabs voices). Billed per measured second of the source")
    .option("--audio <urlOrPath>", "Source recording (URL, local path or run_ id)")
    .option("--video <urlOrPath>", "Source video — the result is the video re-voiced (needs videos:write)")
    .requiredOption("--voice-id <id>", "Target ElevenLabs voice id (see: genfire voices list)")
    .option("-m, --model <model>", "Speech-to-speech model id (default eleven_multilingual_sts_v2)")
    .option("--remove-noise", "Strip background noise from the source first")
    .option("--title <title>", "Title for the result")
    .option("--team <teamId>", "Bill this run to a workspace credit pool instead of your own balance")
    .option("--project <projectId>", "File the result into this project")
    .option("-o, --output <path>", "Where to save the result. File path or directory; defaults to cwd")
    .option("--no-download", "Don't download the result; only print the URL")
    .action(async (opts: {
      audio?: string; video?: string; voiceId: string; model?: string; removeNoise?: boolean; title?: string;
      team?: string; project?: string; output?: string; download: boolean;
    }) => {
      if (Boolean(opts.audio) === Boolean(opts.video)) {
        throw new CliError("Pass exactly one of --audio or --video.", "invalid_source");
      }
      const client = await createClient();
      const sourceUrl = await resolveComposeMedia(client, (opts.audio ?? opts.video)!);
      const run = await publicApiRequest<Run>("POST", "/audio/voice-conversions", {
        body: {
          ...(opts.video ? { video_url: sourceUrl } : { audio_url: sourceUrl }),
          voice_id: opts.voiceId,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.removeNoise ? { remove_background_noise: true } : {}),
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.team ? { team_id: opts.team } : {}),
          ...(opts.project ? { project_id: opts.project } : {}),
        },
        idempotencyKey: randomUUID(),
      });
      await downloadAndReport(run, "voice-conversion", opts.output, opts.download);
    });

  // ---- clone-voice (Kling, billed) ----
  media
    .command("clone-voice <sample>")
    .description("Clone a voice from a 5–30s single-speaker sample into a Kling voice id — the voice_id a Kling O3 element takes. Billed (kling_create_voice)")
    .option("--team <teamId>", "Bill this run to a workspace credit pool instead of your own balance")
    .action(async (sample: string, opts: { team?: string }) => {
      const client = await createClient();
      const voiceUrl = await resolveComposeMedia(client, sample);
      const run = await publicApiRequest<Run>("POST", "/videos/voices", {
        body: { voice_url: voiceUrl, ...(opts.team ? { team_id: opts.team } : {}) },
        idempotencyKey: randomUUID(),
      });
      failIfFailed(run);
      printResult(run, () => {
        const voiceId = (run.output as Record<string, unknown> | null)?.voice_id;
        if (voiceId) process.stdout.write(`${voiceId}\n`);
        else process.stderr.write(`${dim(`Run ${run.id} is ${run.status}. Re-check with: genfire runs get ${run.id}`)}\n`);
      });
    });

  // ---- capture (free, async) ----
  waitOptions(
    media
      .command("capture <url>")
      .description("Screenshot a website at one or more viewports (POST /v1/captures). FREE")
      .option(
        "--viewport <spec>",
        "Viewport as [name:]WIDTHxHEIGHT, repeatable (default: the server's desktop + mobile set)",
        (value: string, previous: string[]) => previous.concat([value]),
        [] as string[],
      )
      .option("--full-page", "Capture the whole scrollable page, not just the first screen")
      .option("--project <projectId>", "File the screenshots into this project")
      .option("-o, --output <path>", "Directory to save the screenshots; defaults to cwd")
      .option("--no-download", "Don't download the screenshots; only print the result"),
    "5m",
  ).action(async (url: string, opts: WaitFlags & {
    viewport: string[]; fullPage?: boolean; project?: string; output?: string; download: boolean;
  }) => {
    const viewports = opts.viewport.map(parseViewport);
    const client = await createClient();
    const queued = await publicApiRequest<Run>("POST", "/captures", {
      body: {
        url,
        ...(viewports.length > 0 ? { viewports } : {}),
        ...(opts.fullPage ? { full_page: true } : {}),
        ...(opts.project ? { project_id: opts.project } : {}),
      },
      idempotencyKey: randomUUID(),
    });
    const run = await settle(client, queued, opts);
    if (!run) return;
    failIfFailed(run);
    const shots = Array.isArray((run.output as any)?.shots) ? ((run.output as any).shots as Array<{ name: string; url: string }>) : [];
    if (!opts.download || shots.length === 0) {
      printResult(run, () => {
        for (const shot of shots) process.stdout.write(`${bold(shot.name)} ${cyan(shot.url)}\n`);
      });
      return;
    }
    const written = await downloadOutputs(
      shots.map((shot) => ({ url: shot.url, suggestedName: `capture-${shot.name}${/\.jpe?g(\?|$)/i.test(shot.url) ? ".jpg" : ".png"}` })),
      opts.output,
    );
    reportRunCompletion(run, written);
  });

  // ---- extract-product (free, synchronous) ----
  media
    .command("extract-product <url>")
    .description("Scrape a product page into structured product data (title, price, images, description). FREE")
    .action(async (url: string) => {
      const run = await publicApiRequest<Run>("POST", "/products/extract", {
        body: { url },
        idempotencyKey: randomUUID(),
      });
      failIfFailed(run);
      printResult(run, () => {
        const product = (run.output as Record<string, unknown> | null)?.product;
        process.stdout.write(`${JSON.stringify(product ?? run.output, null, 2)}\n`);
      });
    });

  // ---- blockout (synchronous) ----
  media
    .command("blockout <prompt>")
    .description("Plan a 3D scene layout (Blender blockout spec) from a description; reblock an existing spec or plan a camera move")
    .option("--mode <mode>", "blockout (new set) | reblock (edit --spec) | camera (camera move)", "blockout")
    .option("--spec <file>", "JSON file with the spec a previous blockout returned (required for reblock)")
    .option("--scene <file>", "JSON file describing the current scene context")
    .option("--max-objects <n>", "Cap on objects in the layout")
    .action(async (prompt: string, opts: { mode: string; spec?: string; scene?: string; maxObjects?: string }) => {
      const mode = opts.mode.trim().toLowerCase();
      if (!["blockout", "reblock", "camera"].includes(mode)) {
        throw new CliError("--mode must be blockout, reblock or camera.", "invalid_mode");
      }
      if (mode === "reblock" && !opts.spec) {
        throw new CliError("--mode reblock needs --spec (the spec a previous blockout returned).", "missing_spec");
      }
      const maxObjects = opts.maxObjects === undefined ? undefined : Number(opts.maxObjects);
      if (maxObjects !== undefined && (!Number.isInteger(maxObjects) || maxObjects < 1)) {
        throw new CliError("--max-objects must be a positive integer.", "invalid_option");
      }
      const result = await publicApiRequest("POST", "/scenes/blockouts", {
        body: {
          mode,
          prompt,
          ...(opts.spec ? { spec: await readJson(opts.spec, "--spec") } : {}),
          ...(opts.scene ? { scene: await readJson(opts.scene, "--scene") } : {}),
          ...(maxObjects !== undefined ? { max_objects: maxObjects } : {}),
        },
      });
      printJson(result);
    });
}
