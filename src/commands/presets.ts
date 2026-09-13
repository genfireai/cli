import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { bold, cyan, dim, printResult, printTable, yellow } from '../output.js';
import { CanvasRunDeliverable, CanvasWorkflowRunStatus, waitForCanvasRun } from '../runHelpers.js';

/**
 * `genfire preset`, plus the canvas-workflow surface `genfire workflow
 * estimate` / `run-canvas` / `run-status` hangs off.
 *
 * A preset is a PUBLISHED template workflow made runnable by name: the caller
 * never sees a node graph, only a flat input list, a cost at defaults, and one
 * call that runs the chain. Paid presets ride the marketplace's own unlock
 * gate — a 402 asking for confirmation, then one purchase that unlocks the
 * preset forever.
 *
 * Every call here goes through `publicApiRequest`: the CLI pins @genfire/sdk
 * 0.23.0 and these routes postdate it. The SDK source in this repo types them
 * all (listPresets / getPreset / estimatePreset / runPreset /
 * estimateUserWorkflow / runUserWorkflow / getUserWorkflowRun), so this file
 * collapses onto typed methods at the next SDK cut.
 */

interface PresetInput {
  name: string;
  type?: string;
  label?: string;
  description?: string;
  default?: unknown;
}

interface Preset {
  id: string;
  title?: string;
  name?: string;
  description?: string | null;
  inputs?: PresetInput[];
  cost_credits?: number;
  price_credits?: number | null;
  [key: string]: unknown;
}

interface PresetRun {
  object: 'preset_run';
  presetId: string;
  presetVersion: number | null;
  workflowId: string;
  runId: string;
  totalCostCredits: number;
  pageId: string;
  selectedNodeIds: string[];
}

/** The 202 a canvas kickoff returns. Nothing has finished yet. */
interface CanvasWorkflowRun {
  runId: string;
  totalCostCredits: number;
  pageId: string;
  /** The selection the SERVER resolved — the default one when you sent none. */
  selectedNodeIds: string[];
}

interface EstimateNode {
  node_id: string;
  kind: string;
  credits: number;
  cached?: boolean;
}

/**
 * The deliverables of a finished canvas run — the nodes the user actually
 * asked for, as opposed to the work that produced them.
 *
 * Printed by both waiting commands because a canvas run's outputs are NOT on
 * `genfire runs output`: they hang off the per-node status document, so a run
 * that finished with nothing printed would leave the caller with a run id and
 * no way to guess where its files went.
 */
function printDeliverables(run: { output?: { deliverables?: CanvasRunDeliverable[] } }): void {
  const deliverables = run.output?.deliverables ?? [];
  if (deliverables.length === 0) return;
  process.stderr.write(`${dim('Deliverables:')}\n`);
  for (const entry of deliverables) {
    process.stderr.write(`  ${entry.node_id} ${dim(`(${entry.kind})`)} ${entry.output.url ?? entry.output.text ?? ''}\n`);
  }
}

/**
 * The per-node breakdown, read through a shim rather than indexed directly.
 *
 * Both estimate routes spread `issueQuote(...)` over their own response, and
 * issueQuote returns a `breakdown` of its own — so whatever it is handed WINS
 * over the top-level field. The canvas route used to hand it `{ nodes: [...] }`,
 * which silently replaced the documented array, and reading `.length` off that
 * printed no table at all. The backend returns the array on both routes now,
 * but a published CLI talks to whatever is deployed, so the object shape is
 * still accepted here rather than assumed gone.
 */
function estimateNodes(breakdown: unknown): EstimateNode[] {
  if (Array.isArray(breakdown)) return breakdown as EstimateNode[];
  const nested = (breakdown as { nodes?: unknown } | null | undefined)?.nodes;
  return Array.isArray(nested) ? (nested as EstimateNode[]) : [];
}

interface WorkflowEstimate {
  object: 'cost_estimate';
  credits: number;
  unit: string;
  /** An array. `{ nodes: [...] }` is the pre-fix canvas shape — see estimateNodes. */
  breakdown: EstimateNode[] | { nodes: EstimateNode[] };
  quote_id?: string;
  quote_token?: string;
  expires_at?: string;
  workflow_rev: number | null;
  page_id: string;
  selected_node_ids: string[];
}

interface PresetEstimate {
  object: 'cost_estimate';
  credits: number;
  unit: string;
  breakdown: EstimateNode[] | { nodes: EstimateNode[] };
  quote_id?: string;
  quote_token?: string;
  expires_at?: string;
  preset_id: string;
  preset_rev: number | null;
  selected_node_ids: string[];
}

const presetTitle = (preset: Preset): string => String(preset.title || preset.name || preset.id);

/**
 * `--input name=value`, repeated. Values arrive as strings from the shell, so
 * `true`/`false` and plain numbers are coerced — otherwise a boolean preset
 * input would be the string "true" and the graph would take it as truthy text.
 * Quote a value to keep it a string: `--input count='"12"'`.
 */
function parseInputs(pairs: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new CliError(`--input must be name=value (got "${pair}")`, 'invalid_input');
    }
    const name = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1);
    if (raw === 'true' || raw === 'false') out[name] = raw === 'true';
    else if (raw !== '' && !Number.isNaN(Number(raw))) out[name] = Number(raw);
    else if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) out[name] = raw.slice(1, -1);
    else out[name] = raw;
  }
  return out;
}

async function readInputsFile(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new CliError(`--inputs-file not found: ${path}`, 'inputs_file_not_found');
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(`${path} is not valid JSON: ${(err as Error).message}`, 'invalid_inputs');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`${path} must contain a flat { name: value } object.`, 'invalid_inputs');
  }
  return parsed as Record<string, unknown>;
}

export function registerPresetCommands(program: Command): void {
  const preset = program
    .command('preset')
    .description('Browse and run published presets — ready-made multi-step pipelines, runnable by name');

  preset
    .command('list')
    .description('List the published preset library. Free.')
    .action(async () => {
      const response = await publicApiRequest<{ object: 'list'; data: Preset[] }>('GET', '/presets');
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No presets are published.')}\n`);
          return;
        }
        printTable(
          response.data.map((entry) => ({
            id: entry.id,
            title: presetTitle(entry),
            credits: entry.cost_credits ?? '',
            unlock: entry.price_credits ? `${entry.price_credits} cr` : 'free'
          })),
          ['id', 'title', 'credits', 'unlock']
        );
        process.stdout.write(`\n${dim('Inspect one with: genfire preset get <id>')}\n`);
      });
    });

  preset
    .command('get <presetId>')
    .description("Show a preset's exact inputs, cost at defaults and unlock price. Build --input from this, not from the description.")
    .action(async (presetId: string) => {
      const found = await publicApiRequest<Preset>('GET', `/presets/${encodeURIComponent(presetId)}`);
      printResult(found, () => {
        process.stdout.write(`${bold(presetTitle(found))}  ${dim(found.id)}\n`);
        if (found.description) process.stdout.write(`${found.description}\n`);
        if (found.cost_credits !== undefined) {
          process.stdout.write(`\n${dim('Cost at defaults:')} ${cyan(String(found.cost_credits))} credits\n`);
        }
        if (found.price_credits) {
          process.stdout.write(
            `${yellow('Paid preset:')} ${found.price_credits} credits to unlock, one time. ` +
            `${dim('Run it once to see the 402, then re-run with --confirm-purchase.')}\n`
          );
        }
        const inputs = found.inputs ?? [];
        if (inputs.length === 0) {
          process.stdout.write(`\n${dim('This preset takes no inputs — price it with: genfire preset estimate <id>')}\n`);
          return;
        }
        process.stdout.write('\n');
        printTable(
          inputs.map((entry) => ({
            name: entry.name,
            type: entry.type ?? '',
            default: entry.default === undefined || entry.default === null ? '' : String(entry.default).slice(0, 40),
            about: (entry.label || entry.description || '').slice(0, 60)
          })),
          ['name', 'type', 'default', 'about']
        );
      });
    });

  preset
    .command('estimate <presetId>')
    .description('Price a preset BEFORE running it — the exact credits `preset run` will take, per node. Free, creates nothing.')
    .option(
      '-i, --input <name=value>',
      'Preset input, repeatable. Price it with the inputs you intend to submit — they are part of the quote.',
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[]
    )
    .option('--inputs-file <path>', 'JSON file of { name: value } instead of (or merged under) repeated --input flags')
    .option('--team <teamId>', 'Validate the run against a workspace credit pool, the same way the run would')
    .option('--project <projectId>', 'Validate the project the run would file into')
    .action(async (presetId: string, opts: {
      input: string[]; inputsFile?: string; team?: string; project?: string;
    }) => {
      const fromFile = opts.inputsFile ? await readInputsFile(opts.inputsFile) : {};
      const inputs = { ...fromFile, ...parseInputs(opts.input ?? []) };

      const estimate = await publicApiRequest<PresetEstimate>(
        'POST',
        `/presets/${encodeURIComponent(presetId)}/estimate`,
        {
          body: {
            ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
            ...(opts.team ? { team_id: opts.team } : {}),
            ...(opts.project ? { project_id: opts.project } : {})
          }
        }
      );

      const nodes = estimateNodes(estimate.breakdown);
      printResult(estimate, () => {
        process.stdout.write(
          `${bold(String(estimate.credits))} credits ` +
          `${dim(`(${nodes.length} nodes, preset rev ${estimate.preset_rev ?? 'unpinned'})`)}\n\n`
        );
        if (nodes.length > 0) {
          printTable(
            nodes.map((entry) => ({
              node: entry.node_id,
              kind: entry.kind,
              credits: entry.credits,
              // A preset run selects every runnable node, so nothing is served
              // from a cached output — the column stays for shape parity with
              // `workflow estimate`, and is expected to be empty here.
              cached: entry.cached ? 'yes' : ''
            })),
            ['node', 'kind', 'credits', 'cached']
          );
        }
        // The receipt. `preset run --quote` is the only thing that can spend
        // it: the token is hashed over the preset, its rev and these inputs.
        if (estimate.quote_token) {
          const flags = [
            ...opts.input.map((pair) => ` --input ${pair}`),
            opts.team ? ` --team ${opts.team}` : '',
            opts.project ? ` --project ${opts.project}` : ''
          ].join('');
          process.stdout.write(
            `\n${dim('Quote:')} ${estimate.quote_token}\n` +
            `${dim(`       genfire preset run ${presetId}${flags} --quote <token>${estimate.expires_at ? ` (expires ${estimate.expires_at})` : ''}\n`)}`
          );
        }
      });
    });

  preset
    .command('run <presetId>')
    .description('Run a preset with your own inputs. BILLS CREDITS. Price it with `preset estimate` first and spend that token with --quote.')
    .option(
      '-i, --input <name=value>',
      'Preset input, repeatable. Names come from `genfire preset get`. true/false and numbers are coerced; wrap a value in quotes to keep it a string.',
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[]
    )
    .option('--inputs-file <path>', 'JSON file of { name: value } instead of (or merged under) repeated --input flags')
    .option(
      '--confirm-purchase',
      'Pay a paid preset\'s one-time unlock. Only pass this after a 402 has told you the price and you agreed to it.'
    )
    .option('--team <teamId>', 'Bill this run to a workspace credit pool instead of your own balance')
    .option('--project <projectId>', 'File the outputs into this project')
    // The token must come from `preset estimate` and nowhere else: this route
    // verifies a quote hashed over the preset, its rev and these inputs, which
    // is exactly what that command mints. `workflow estimate` issues the same
    // capability hashed over a workflow id and a node selection, so its token
    // is a 409 quote_mismatch here.
    .option('--quote <token>', 'The quote_token `preset estimate` printed. A quote is a ceiling, never a floor: if the price dropped you pay the lower one.')
    .option('--no-wait', 'Return the queued run immediately instead of polling')
    .option('--wait-timeout <minutes>', 'Maximum minutes to wait', '30')
    .action(async (presetId: string, opts: {
      input: string[]; inputsFile?: string; confirmPurchase?: boolean;
      team?: string; project?: string; quote?: string;
      wait: boolean; waitTimeout: string;
    }) => {
      const fromFile = opts.inputsFile ? await readInputsFile(opts.inputsFile) : {};
      // Flags win over the file: the file is the saved shape, the flag is the
      // thing the user just typed.
      const inputs = { ...fromFile, ...parseInputs(opts.input ?? []) };

      const started = await publicApiRequest<PresetRun>(
        'POST',
        `/presets/${encodeURIComponent(presetId)}/runs`,
        {
          body: {
            ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
            ...(opts.confirmPurchase ? { confirm_purchase: true } : {}),
            ...(opts.team ? { team_id: opts.team } : {}),
            ...(opts.project ? { project_id: opts.project } : {}),
            ...(opts.quote ? { quote_token: opts.quote } : {})
          }
        }
      );

      if (!opts.wait) {
        printResult(started, () => {
          process.stderr.write(
            `${dim('Preset run queued:')} ${started.runId} ` +
            `${dim(`(${started.totalCostCredits} credits, workflow ${started.workflowId})`)}\n`
          );
          // NOT `genfire runs get`: a preset run is a CANVAS run, filed under
          // the instantiated copy, and the flat run route 404s on it.
          process.stderr.write(
            `${dim('Re-check with:')} genfire workflow run-status ${started.workflowId} ${started.runId}\n`
          );
        });
        return;
      }

      process.stderr.write(
        `${dim(`Polling preset run ${started.runId} (${started.totalCostCredits} credits)...`)}\n`
      );
      // The run is addressed under the instantiated COPY the 202 named, not on
      // /v1/runs — polling there 404s on the first tick of a run the server has
      // already billed.
      const finished = await waitForCanvasRun(started.workflowId, started.runId, {
        timeoutMs: Math.round(Number(opts.waitTimeout) * 60 * 1000)
      });
      process.stderr.write('\n');
      printResult({ preset: started, run: finished }, () => {
        process.stderr.write(`${dim(`Run ${finished.status}.`)} ${dim(`(${finished.runId})`)}\n`);
        printDeliverables(finished);
        process.stderr.write(
          `${dim('Per-node results:')} genfire workflow run-status ${started.workflowId} ${started.runId}\n`
        );
      });
    });
}

/**
 * `genfire workflow estimate` — price one of YOUR canvas workflows.
 *
 * Registered from here rather than commands/workflow.ts because it targets a
 * different surface: `genfire workflow list|get|run` speak to the PUBLISHED
 * workflow registry (`/v1/workflows`), while this prices a user-owned canvas
 * (`/v1/user-workflows`). Same noun to a user, two collections underneath.
 */
/**
 * `--overrides`: a JSON file path, or a literal JSON object.
 *
 * The shape is keyed by NODE and two levels deep — `{ "<node_id>": { "<param>":
 * value } }` — which is what the route's parser wants; a flat `"node.param"`
 * key is a 400 `invalid_param_overrides`, so it is worth saying in the flag's
 * own help rather than in a doc nobody is reading at the time.
 */
async function readOverrides(value: string): Promise<Record<string, unknown>> {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return readInputsFile(trimmed);
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    throw new CliError(`--overrides is not valid JSON: ${(err as Error).message}`, 'invalid_overrides');
  }
}

const OVERRIDES_HELP =
  'JSON file or literal, keyed by node: { "<node_id>": { "<param>": value } }. A flat "node.param" key is rejected.';

export function registerWorkflowEstimateCommand(workflow: Command): void {
  workflow
    .command('estimate <workflowId>')
    .description('Price one of YOUR canvas workflows before running it — exact credits, per node, with the cached ones marked. Free.')
    .option('--overrides <pathOrJson>', `${OVERRIDES_HELP} Price it as you intend to submit it.`)
    .option(
      '-n, --node <nodeId>',
      'Price only these nodes and what they depend on. Omit for the whole page.',
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[]
    )
    // A quote is keyed on the PAGE as well as the node set, so a run that
    // targets a different page than the estimate priced is a 409 rather than a
    // re-price. That is why the flag exists on both commands.
    .option('-p, --page <pageId>', 'Which page of the canvas to price. Defaults to the first.')
    .action(async (workflowId: string, opts: { overrides?: string; node: string[]; page?: string }) => {
      const paramOverrides = opts.overrides ? await readOverrides(opts.overrides) : undefined;

      const estimate = await publicApiRequest<WorkflowEstimate>(
        'POST',
        `/user-workflows/${encodeURIComponent(workflowId)}/estimate`,
        {
          body: {
            ...(paramOverrides ? { param_overrides: paramOverrides } : {}),
            ...(opts.node.length > 0 ? { selected_node_ids: opts.node } : {}),
            ...(opts.page ? { page_id: opts.page } : {})
          }
        }
      );

      const nodes = estimateNodes(estimate.breakdown);
      printResult(estimate, () => {
        process.stdout.write(
          `${bold(String(estimate.credits))} credits ` +
          `${dim(`(${nodes.length} nodes, workflow rev ${estimate.workflow_rev ?? 'unpinned'})`)}\n\n`
        );
        if (nodes.length > 0) {
          printTable(
            nodes.map((entry) => ({
              node: entry.node_id,
              kind: entry.kind,
              credits: entry.credits,
              cached: entry.cached ? 'yes' : ''
            })),
            ['node', 'kind', 'credits', 'cached']
          );
        }
        // The receipt. Without it the number above is just a number the user
        // was shown; with it the submit can be bound to this exact price, and
        // `workflow run-canvas --quote` is the command that spends it.
        if (estimate.quote_token) {
          process.stdout.write(
            `\n${dim('Quote:')} ${estimate.quote_token}\n` +
            `${dim(`       genfire workflow run-canvas ${workflowId} --quote <token>${estimate.expires_at ? ` (expires ${estimate.expires_at})` : ''}\n`)}`
          );
        }
      });
    });
}

/**
 * `genfire workflow run-canvas` and `genfire workflow run-status` — the SUBMIT
 * half of `workflow estimate`.
 *
 * `workflow run` targets the PUBLISHED registry (`/v1/workflows/{key}/runs`),
 * which takes a flat `input` object and verifies no quote. These two target a
 * user-owned canvas (`/v1/user-workflows/{id}/runs`), which takes a node
 * selection and does. Same noun to a user, two collections underneath, so they
 * are two commands rather than a flag on one.
 */
export function registerCanvasWorkflowRunCommands(workflow: Command): void {
  workflow
    .command('run-canvas <workflowId>')
    .description('Run one of YOUR canvas workflows. BILLS CREDITS — quote it with `workflow estimate` first and spend that token with --quote.')
    .option('--overrides <pathOrJson>', OVERRIDES_HELP)
    .option(
      '-n, --node <nodeId>',
      'Run only these nodes AND everything they depend on — how you redo one branch without re-paying for the rest. Omit for the page\'s Export nodes and generation leaves.',
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[]
    )
    .option('-p, --page <pageId>', 'Which page of the canvas to run. Defaults to the first — and must MATCH the page you priced, or the quote is a 409.')
    .option('--quote <token>', 'The quote_token `workflow estimate` printed. A quote is a ceiling, never a floor: if the price dropped you pay the lower one.')
    // No --team and no --project. Both are 400s on this route, not omissions:
    // the canvas bills the workspace the workflow itself belongs to
    // (`team_billing_unsupported` — move the workflow instead), and its nodes
    // file their own outputs (`project_filing_unsupported`). A flag whose only
    // possible outcome is a 400 is worse than no flag.
    .option('--no-wait', 'Return the queued run immediately instead of polling')
    .option('--wait-timeout <minutes>', 'Maximum minutes to wait', '30')
    .action(async (workflowId: string, opts: {
      overrides?: string; node: string[]; page?: string; quote?: string;
      wait: boolean; waitTimeout: string;
    }) => {
      const paramOverrides = opts.overrides ? await readOverrides(opts.overrides) : undefined;

      const started = await publicApiRequest<CanvasWorkflowRun>(
        'POST',
        `/user-workflows/${encodeURIComponent(workflowId)}/runs`,
        {
          body: {
            ...(paramOverrides ? { param_overrides: paramOverrides } : {}),
            ...(opts.node.length > 0 ? { selected_node_ids: opts.node } : {}),
            ...(opts.page ? { page_id: opts.page } : {}),
            ...(opts.quote ? { quote_token: opts.quote } : {})
          }
        }
      );

      if (!opts.wait) {
        printResult(started, () => {
          process.stderr.write(
            `${dim('Canvas run queued:')} ${started.runId} ` +
            `${dim(`(${started.totalCostCredits} credits, ${started.selectedNodeIds.length} nodes on page ${started.pageId})`)}\n`
          );
          process.stderr.write(
            `${dim('Re-check with:')} genfire workflow run-status ${workflowId} ${started.runId}\n`
          );
        });
        return;
      }

      process.stderr.write(
        `${dim(`Polling canvas run ${started.runId} (${started.totalCostCredits} credits, ${started.selectedNodeIds.length} nodes)...`)}\n`
      );
      const finished = await waitForCanvasRun(workflowId, started.runId, {
        timeoutMs: Math.round(Number(opts.waitTimeout) * 60 * 1000)
      });
      process.stderr.write('\n');
      printResult({ run: started, status: finished }, () => {
        process.stderr.write(`${dim(`Run ${finished.status}.`)} ${dim(`(${finished.runId})`)}\n`);
        printDeliverables(finished);
        process.stderr.write(
          `${dim('Per-node results:')} genfire workflow run-status ${workflowId} ${started.runId}\n`
        );
      });
    });

  workflow
    .command('run-status <workflowId> <runId>')
    .description('One canvas run node by node, with the deliverables split out from the work that produced them. Free.')
    .option('--intermediates', 'Also print the intermediate outputs, not just the deliverables')
    .action(async (workflowId: string, runId: string, opts: { intermediates?: boolean }) => {
      const run = await publicApiRequest<CanvasWorkflowRunStatus>(
        'GET',
        `/user-workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`
      );
      printResult(run, () => {
        process.stdout.write(
          `${bold(run.runId)} ${dim(`${run.status} · ${run.totalCostCredits} credits · `)}` +
          // The graph revision that ACTUALLY executed. Without it a run read
          // back a week later is indistinguishable from the canvas as it
          // stands now, which is the whole reason the route reports it.
          `${dim(`workflow rev ${run.workflowRev ?? 'unpinned'} · page ${run.pageId}`)}\n`
        );
        if (run.error) process.stdout.write(`${yellow('Error:')} ${run.error}\n`);
        if (run.nodes.length > 0) {
          process.stdout.write('\n');
          printTable(
            run.nodes.map((node) => ({
              node: node.nodeId,
              status: node.status,
              output: node.output ? (node.output.url ?? node.output.text ?? node.output.type) : '',
              error: node.error ?? ''
            })).map((row) => ({ ...row, output: String(row.output).slice(0, 60) })),
            ['node', 'status', 'output', 'error']
          );
        }
        const show = (label: string, entries: CanvasRunDeliverable[]) => {
          if (entries.length === 0) return;
          process.stdout.write(`\n${dim(label)}\n`);
          for (const entry of entries) {
            process.stdout.write(`  ${entry.node_id} ${dim(`(${entry.kind})`)} ${entry.output.url ?? entry.output.text ?? ''}\n`);
          }
        };
        // Deliverables are the ANSWER; intermediates are how it was made, and
        // printing both by default buries the one the user asked for.
        show('Deliverables:', run.output?.deliverables ?? []);
        if (opts.intermediates) show('Intermediates:', run.output?.intermediates ?? []);
        else if ((run.output?.intermediates ?? []).length > 0) {
          process.stdout.write(
            `\n${dim(`${run.output.intermediates.length} intermediate outputs — re-run with --intermediates to see them.`)}\n`
          );
        }
      });
    });
}
