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
}
