import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { publicApiRequest } from "../client.js";
import { printJson } from "../output.js";
export function registerRuntimeCommands(program: Command): void {
  // `{ hidden: true }`, not unregistered: /v1/runtime/* is wired
  // (routes/publicRuntime.ts) but the isolated media runtime is unprovisioned
  // this release, so every one of these would fail against a live deploy. The
  // group stays fully callable for internal testing and only leaves the help
  // listing; drop the flag when the runtime is provisioned — the same flip that
  // publishes the held-back Firestation skills (loadOfficialSkills.ts).
  const runtime = program
    .command("runtime", { hidden: true })
    .description(
      "Durable execution workspaces, Blender scenes and built applications",
    );
  runtime
    .command("status")
    .description("Report whether the isolated execution runtime is configured")
    .action(async () => printJson(await publicApiRequest("GET", "/runtime")));
  runtime
    .command("list")
    .description("List the durable execution workspaces on this account")
    .action(async () =>
      printJson(await publicApiRequest("GET", "/runtime/workspaces")),
    );
  runtime
    .command("create <name>")
    .description("Create a durable workspace (media, scene or app)")
    .option("--kind <kind>", "media, scene or app", "media")
    .action(async (name, opts) =>
      printJson(
        await publicApiRequest("POST", "/runtime/workspaces", {
          body: { name, kind: opts.kind },
        }),
      ),
    );
  runtime
    .command("get <workspace>")
    .description("Show one workspace and its current revision")
    .action(async (id) =>
      printJson(
        await publicApiRequest(
          "GET",
          `/runtime/workspaces/${encodeURIComponent(id)}`,
        ),
      ),
    );
  runtime
    .command("exec <workspace>")
    .description("Run a bounded command in a workspace from a JSON request file")
    .requiredOption(
      "-f, --file <file>",
      "JSON execution request including rev and command",
    )
    .option("--key <key>", "Idempotency key")
    .action(async (id, opts) =>
      printJson(
        await publicApiRequest(
          "POST",
          `/runtime/workspaces/${encodeURIComponent(id)}/operations`,
          {
            body: JSON.parse(await readFile(opts.file, "utf8")),
            idempotencyKey: opts.key || randomUUID(),
          },
        ),
      ),
    );
  runtime
    .command("operation <id>")
    .description("Poll one execution operation and its result manifest")
    .action(async (id) =>
      printJson(
        await publicApiRequest(
          "GET",
          `/runtime/operations/${encodeURIComponent(id)}`,
        ),
      ),
    );
  runtime
    .command("artifact <operation> <path>")
    .description("Read one artifact an operation produced (URL expires in 15 minutes)")
    .action(async (id, path) =>
      printJson(
        await publicApiRequest(
          "GET",
          `/runtime/operations/${encodeURIComponent(id)}/artifacts?path=${encodeURIComponent(path)}`,
        ),
      ),
    );
  runtime
    .command("scene <workspace>")
    .description("Query or edit a saved Blender scene with a Python file")
    .requiredOption("-f, --file <file>", "Python source file")
    .requiredOption("--rev <n>", "Workspace revision")
    .option("--query", "Inspect without committing")
    .option("--key <key>", "Idempotency key")
    .action(async (id, opts) =>
      printJson(
        await publicApiRequest(
          "POST",
          `/runtime/scenes/${encodeURIComponent(id)}/operations`,
          {
            body: {
              rev: Number(opts.rev),
              code: await readFile(opts.file, "utf8"),
              mode: opts.query ? "query" : "edit",
            },
            idempotencyKey: opts.key || randomUUID(),
          },
        ),
      ),
    );
  runtime
    .command("deploy <workspace>")
    .description("Deploy a built application workspace")
    .requiredOption("-f, --file <file>", "JSON deployment request")
    .option("--key <key>", "Idempotency key")
    .action(async (id, opts) =>
      printJson(
        await publicApiRequest(
          "POST",
          `/runtime/apps/${encodeURIComponent(id)}/deployments`,
          {
            body: JSON.parse(await readFile(opts.file, "utf8")),
            idempotencyKey: opts.key || randomUUID(),
          },
        ),
      ),
    );

  // Code sandbox (/v1/sandbox/*): the same backend as the MCP
  // genfire_sandbox_exec tool and the Firestation agent's sandbox_exec. Dark
  // with the rest of this group until `sandboxV1` is on and the box is
  // provisioned (the API answers 503 until then).
  const sandbox = runtime
    .command("sandbox")
    .description("Persistent per-project code sandbox (FFmpeg, Python, Node)");
  sandbox
    .command("status")
    .description("Show whether the sandbox is available to you and today's quota")
    .action(async () => printJson(await publicApiRequest("GET", "/sandbox")));
  sandbox
    .command("exec")
    .description("Run bash in the sandbox (inline, from a script file, or a JSON request)")
    .option("-c, --command <bash>", "Command to run")
    .option("-s, --script <file>", "Run this local script's text as the command")
    .option("-f, --file <file>", "JSON request (command, timeout_seconds, background, restart, image_paths, project_id, input_media, save_paths)")
    .option("--project <id>", "Project whose workspace to use")
    .option("--timeout <seconds>", "timeout_seconds")
    .option("--background", "Start a background job")
    .option("--restart", "Start from a fresh sandbox")
    .option("--size <size>", "standard or xl (xl: bigger box for heavy renders)")
    .option("--input <id...>", "run ids or URLs to stage under ~/inputs/")
    .option("--save <path...>", "Files to save to Generations + the project")
    .option("--image <path...>", "Image files to return (up to 4)")
    .option("--images-dir <dir>", "Write returned images here instead of printing their bytes")
    .action(async (opts) => {
      const body: Record<string, unknown> = opts.file
        ? JSON.parse(await readFile(opts.file, "utf8"))
        : {};
      if (opts.script) body.command = await readFile(opts.script, "utf8");
      if (opts.command) body.command = opts.command;
      if (opts.project) body.project_id = opts.project;
      if (opts.timeout) body.timeout_seconds = Number(opts.timeout);
      if (opts.background) body.background = true;
      if (opts.restart) body.restart = true;
      if (opts.size) body.size = opts.size;
      if (opts.input) body.input_media = opts.input;
      if (opts.save) body.save_paths = opts.save;
      if (opts.image) body.image_paths = opts.image;
      const result: any = await publicApiRequest("POST", "/sandbox/exec", { body });
      const images: any[] = Array.isArray(result?.images) ? result.images : [];
      if (opts.imagesDir) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join, basename } = await import("node:path");
        await mkdir(opts.imagesDir, { recursive: true });
        for (const [i, image] of images.entries()) {
          if (typeof image?.data_base64 !== "string") continue;
          const ext = image.mime_type === "image/png" ? "png" : "jpg";
          const dest = join(opts.imagesDir, `${i + 1}_${basename(String(image.path || "image")).replace(/\.[^.]+$/, "")}.${ext}`);
          await writeFile(dest, Buffer.from(image.data_base64, "base64"));
          image.saved_to = dest;
        }
      }
      for (const image of images) {
        if (typeof image?.data_base64 === "string") delete image.data_base64;
      }
      printJson(result);
    });
  sandbox
    .command("job <workspace> <job>")
    .description("Poll a background sandbox job")
    .action(async (workspace, job) =>
      printJson(
        await publicApiRequest(
          "GET",
          `/sandbox/workspaces/${encodeURIComponent(workspace)}/jobs/${encodeURIComponent(job)}`,
        ),
      ),
    );
  sandbox
    .command("kill <workspace> <job>")
    .description("Stop a background sandbox job")
    .action(async (workspace, job) =>
      printJson(
        await publicApiRequest(
          "POST",
          `/sandbox/workspaces/${encodeURIComponent(workspace)}/jobs/${encodeURIComponent(job)}/kill`,
        ),
      ),
    );
  sandbox
    .command("workspaces")
    .description("List your sandbox workspaces")
    .action(async () =>
      printJson(await publicApiRequest("GET", "/sandbox/workspaces")),
    );
  sandbox
    .command("delete <workspace>")
    .description("Delete a sandbox workspace and its files (saved outputs are kept)")
    .action(async (workspace) =>
      printJson(
        await publicApiRequest(
          "DELETE",
          `/sandbox/workspaces/${encodeURIComponent(workspace)}`,
        ),
      ),
    );
}
