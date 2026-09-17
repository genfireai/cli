import { Command } from "commander";
import { publicApiRequest } from "../client.js";
import { printJson } from "../output.js";

/**
 * Top-level media utilities that hit `/v1/media/*`.
 *
 * `frames` lived inside `registerRuntimeCommands` and was registered on the
 * ROOT program from there, so a reader of index.ts could not see where it came
 * from and hiding the (currently dark) `runtime` group would have taken a
 * shipping command down with it. `/v1/media/frames` is independent of the
 * isolated execution runtime and ships this release, so it registers here.
 */
export function registerMediaCommands(program: Command): void {
  program
    .command("frames <video>")
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
