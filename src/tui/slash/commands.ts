import { randomUUID } from 'node:crypto';
import { GenFireApiError } from '@genfire/sdk';
import { registerSlash, listSlash, parseSlashLine } from './registry.js';
import { useTuiStore, JobStatus } from '../store.js';
import { runLogin, runLogout, refreshAccount, applyAuthToStore } from '../session.js';
import {
  downloadOutputs,
  extractOutputUrls,
  resolveMediaInput,
  waitForRun
} from '../../runHelpers.js';

function fmtTable(rows: string[][], headers: string[]): string {
  if (rows.length === 0) return '(no rows)';
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || '').length)));
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  return [pad(headers), separator, ...rows.map(pad)].join('\n');
}

function describe(line: string): string {
  return line.length > 200 ? line.slice(0, 197) + '...' : line;
}

registerSlash({
  name: 'help',
  summary: 'List available slash commands',
  execute: async ({ log }) => {
    const cmds = listSlash();
    const rows = cmds.map((c) => [`/${c.name}`, c.summary]);
    log(fmtTable(rows, ['command', 'description']), 'output');
    log('Type /<command> --help for usage. Press Tab to autocomplete. Use ↑/↓ for history.', 'info');
  }
});

registerSlash({
  name: 'quit',
  summary: 'Exit the GenFire CLI',
  execute: async () => {
    useTuiStore.getState().requestExit();
  }
});

registerSlash({
  name: 'exit',
  summary: 'Alias for /quit',
  execute: async () => {
    useTuiStore.getState().requestExit();
  }
});

registerSlash({
  name: 'clear',
  summary: 'Clear the message log',
  execute: async () => {
    useTuiStore.getState().clearLog();
  }
});

registerSlash({
  name: 'login',
  summary: 'Authenticate via your web browser',
  execute: async ({ args, log }) => {
    const noBrowser = args.includes('--no-browser');
    const apiKeyIndex = args.indexOf('--api-key');
    const apiKey = apiKeyIndex !== -1 ? args[apiKeyIndex + 1] : undefined;
    const labelIndex = args.indexOf('--label');
    const label = labelIndex !== -1 ? args[labelIndex + 1] : undefined;

    log('Starting login...', 'info');
    await runLogin({
      apiKey,
      noBrowser,
      label,
      onMessage: (text, kind) => log(text, kind)
    });
  }
});

registerSlash({
  name: 'logout',
  summary: 'Remove stored credentials',
  execute: async ({ log }) => {
    await runLogout();
    log('Logged out. Run /login to sign in again.', 'success');
  }
});

registerSlash({
  name: 'status',
  summary: 'Show authentication state',
  execute: async ({ client, account, log }) => {
    const state = useTuiStore.getState();
    if (!client) {
      log('Not authenticated. Run /login.', 'error');
      return;
    }
    const lines = [
      `Authenticated as ${account?.email || account?.id || '(unknown)'}`,
      `Source:  ${state.authSource}`,
      `API URL: ${state.baseUrl}`,
      `Plan:    ${account?.plan || 'unknown'}`,
      `Credits: ${account?.credits ?? '?'}`
    ];
    log(lines.join('\n'), 'output');
  }
});

registerSlash({
  name: 'account',
  summary: 'Show account identity and credit balance',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    await refreshAccount(client);
    const account = useTuiStore.getState().account;
    if (!account) return;
    log(
      `${account.displayName || account.id}  ${account.email || ''}\n` +
        `Plan:    ${account.plan}\n` +
        `Credits: ${account.credits} credits`,
      'output'
    );
  }
});

registerSlash({
  name: 'credits',
  summary: 'Show current credit balance',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const credits = await client.getCredits();
    useTuiStore.getState().setAccount(
      useTuiStore.getState().account
        ? { ...useTuiStore.getState().account!, credits: credits.balance }
        : null
    );
    log(`${credits.balance} ${credits.currency}`, 'output');
  }
});

registerSlash({
  name: 'models',
  summary: 'List models. Optional first arg filters by capability.',
  usage: '/models [capability]',
  requiresAuth: true,
  execute: async ({ args, client, log }) => {
    if (!client) return;
    const filter = args[0];
    const response = await client.listModels();
    const filtered = filter ? response.data.filter((m) => m.capability === filter) : response.data;
    if (filtered.length === 0) {
      log('No models match.', 'info');
      return;
    }
    const rows = filtered.map((m) => [m.id, m.capability, m.is_default ? 'yes' : '', m.name]);
    log(fmtTable(rows, ['id', 'capability', 'default', 'name']), 'output');
  }
});

registerSlash({
  name: 'pricing',
  summary: 'Show per-model credit pricing',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const pricing = await client.listPricing();
    const rows = pricing.data.map((p) => [p.model, p.capability, String(p.credits), p.unit]);
    log(fmtTable(rows, ['model', 'capability', 'credits', 'unit']), 'output');
  }
});

registerSlash({
  name: 'runs',
  summary: 'List or search past runs. Use /runs <id> to inspect a single run.',
  usage: '/runs [runId | --search dragon | --limit N | --status completed]',
  requiresAuth: true,
  execute: async ({ args, client, log }) => {
    if (!client) return;
    const idArg = args.find((a) => !a.startsWith('--'));
    if (idArg) {
      const run = await client.getRun(idArg);
      log(
        [
          `${run.id}  (${run.status})`,
          `Capability: ${run.capability}`,
          run.model ? `Model:      ${run.model}` : '',
          `Created:    ${run.created_at}`,
          run.completed_at ? `Completed:  ${run.completed_at}` : '',
          run.error ? `Error:      ${run.error.code}: ${run.error.message}` : ''
        ].filter(Boolean).join('\n'),
        run.status === 'failed' ? 'error' : 'output'
      );
      if (run.status === 'completed') {
        const urls = extractOutputUrls(run, run.capability);
        if (urls.length > 0) {
          log(urls.map((u) => u.url).join('\n'), 'info');
        }
      }
      return;
    }
    const limitIdx = args.indexOf('--limit');
    const statusIdx = args.indexOf('--status');
    const searchIdx = args.indexOf('--search');
    const response = await client.listRuns({
      limit: limitIdx !== -1 ? Number(args[limitIdx + 1]) : 20,
      status: statusIdx !== -1 ? (args[statusIdx + 1] as any) : undefined,
      // Searched server-side across the whole history, not just these 20 rows.
      q: searchIdx !== -1 ? args[searchIdx + 1] : undefined
    });
    if (response.data.length === 0) {
      log(searchIdx !== -1 ? 'No runs match that search.' : 'No runs.', 'info');
      return;
    }
    const rows = response.data.map((r) => [
      r.id,
      r.status,
      r.capability,
      r.model || '',
      r.created_at.replace('T', ' ').slice(0, 19)
    ]);
    log(fmtTable(rows, ['id', 'status', 'capability', 'model', 'created']), 'output');
  }
});

registerSlash({
  name: 'cost',
  summary: 'Estimate cost for a model. Usage: /cost <model> [--count N | --duration S]',
  usage: '/cost <model> [--count N | --duration S]',
  requiresAuth: true,
  execute: async ({ args, client, log }) => {
    if (!client) return;
    const modelId = args.find((a) => !a.startsWith('--'));
    if (!modelId) {
      log('Usage: /cost <model> [--count N | --duration S]', 'error');
      return;
    }
    const countIdx = args.indexOf('--count');
    const durationIdx = args.indexOf('--duration');
    const requestedMultiplier =
      countIdx !== -1 ? Number(args[countIdx + 1]) :
      durationIdx !== -1 ? Number(args[durationIdx + 1]) : 1;

    const pricing = await client.listPricing();
    const entry = pricing.data.find((p) => p.model === modelId);
    if (!entry) {
      log(`No pricing for model: ${modelId}. Try /pricing.`, 'error');
      return;
    }
    const multiplier = entry.unit === 'per_call' ? 1 : Math.max(1, Math.ceil(requestedMultiplier));
    const estimate = entry.credits * multiplier;
    const credits = await client.getCredits().catch(() => null);
    log(
      [
        `${entry.model}  (${entry.capability})`,
        `Unit:     ${entry.unit}`,
        `Per call: ${entry.credits} credits`,
        multiplier !== 1 ? `Multiplier: ×${multiplier}` : '',
        `Estimate: ${estimate} credits`,
        credits ? `Balance:  ${credits.balance}` : ''
      ].filter(Boolean).join('\n'),
      'output'
    );
  }
});

async function trackJob(label: string, runStarter: () => Promise<{ id: string }>): Promise<string> {
  const jobId = randomUUID();
  const store = useTuiStore.getState();
  store.upsertJob({ id: jobId, label, status: 'pending' });
  try {
    const run = await runStarter();
    store.updateJob(jobId, { runId: run.id, status: 'running' });
    return jobId;
  } catch (err) {
    store.updateJob(jobId, { status: 'failed', message: (err as Error).message, endedAt: Date.now() });
    throw err;
  }
}

async function followJob(jobId: string, fallbackName: string, output: string | undefined, log: (s: string, k?: any) => void): Promise<void> {
  const store = useTuiStore.getState();
  const job = store.jobs.find((j) => j.id === jobId);
  if (!job?.runId || !store.client) return;
  log(`Polling run ${job.runId}...`, 'info');
  try {
    const run = await waitForRun(store.client, job.runId, {
      onTick: (current, elapsed) => {
        store.updateJob(jobId, {
          message: `${current.status} • ${Math.round(elapsed / 1000)}s`
        });
      }
    });
    if (run.status === 'failed') {
      store.updateJob(jobId, {
        status: 'failed',
        message: run.error?.message || 'Run failed',
        endedAt: Date.now()
      });
      log(`Run failed: ${run.error?.message || 'unknown error'}`, 'error');
      return;
    }
    const urls = extractOutputUrls(run, fallbackName);
    const written = output ? await downloadOutputs(urls, output) : [];
    store.updateJob(jobId, {
      status: 'completed',
      message: 'completed',
      endedAt: Date.now(),
      outputUrls: urls.map((u) => u.url),
      downloadedPaths: written
    });
    if (written.length > 0) {
      log(`Saved ${written.length} file(s):`, 'success');
      written.forEach((p) => log(p, 'output'));
    } else {
      log('Output URLs:', 'success');
      urls.forEach((u) => log(u.url, 'output'));
    }
  } catch (err) {
    store.updateJob(jobId, {
      status: 'failed',
      message: (err as Error).message,
      endedAt: Date.now()
    });
    throw err;
  }
}

registerSlash({
  name: 'generate',
  summary: 'Generate media. Usage: /generate <image|video|speech|music|sfx> "<prompt>" [flags]',
  usage: '/generate <kind> "<prompt>" [-m model] [-i image] [-o path]',
  requiresAuth: true,
  execute: async ({ args, client, log }) => {
    if (!client) return;
    const kind = args[0];
    if (!['image', 'video', 'speech', 'music', 'sfx'].includes(kind || '')) {
      log('Usage: /generate <image|video|speech|music|sfx> "<prompt>" [flags]', 'error');
      return;
    }
    const prompt = args[1];
    if (!prompt) {
      log('Missing prompt. Usage: /generate ' + kind + ' "<prompt>"', 'error');
      return;
    }
    const flag = (name: string): string | undefined => {
      const idx = args.indexOf(name);
      return idx !== -1 ? args[idx + 1] : undefined;
    };
    const model = flag('-m') || flag('--model');
    const imagePath = flag('-i') || flag('--image');
    const output = flag('-o') || flag('--output');
    const aspect = flag('-a') || flag('--aspect-ratio');
    const duration = flag('-d') || flag('--duration');
    const count = flag('-n') || flag('--count');
    const voiceId = flag('--voice-id');
    const negativePrompt = flag('--negative-prompt');

    const imageUrl = imagePath ? (await resolveMediaInput(client, imagePath)).url : undefined;

    const label = `generate ${kind}: ${describe(prompt)}`;
    const jobId = await trackJob(label, async () => {
      switch (kind) {
        case 'image':
          return client.createImageGeneration(
            { prompt, model, aspect_ratio: aspect, count: count ? Number(count) : undefined, image_url: imageUrl },
            { idempotencyKey: randomUUID() }
          );
        case 'video':
          return client.createVideoGeneration(
            { prompt, model, aspect_ratio: aspect, duration: duration ? Number(duration) : undefined, image_url: imageUrl },
            { idempotencyKey: randomUUID() }
          );
        case 'speech':
          if (!voiceId) throw new Error('Speech requires --voice-id <id>');
          return client.createSpeech({ text: prompt, voice_id: voiceId, model }, { idempotencyKey: randomUUID() });
        case 'music':
          return client.createMusic(
            { prompt, model, duration_seconds: duration ? Number(duration) : undefined, image_url: imageUrl, negative_prompt: negativePrompt },
            { idempotencyKey: randomUUID() }
          );
        case 'sfx':
          return client.createSoundEffect(
            { prompt, model, duration_seconds: duration ? Number(duration) : undefined },
            { idempotencyKey: randomUUID() }
          );
        default:
          throw new Error(`Unsupported kind: ${kind}`);
      }
    });

    log(`Submitted ${label}`, 'info');
    await followJob(jobId, kind, output, log);
  }
});

registerSlash({
  name: 'workflow',
  summary: 'Run a workflow. Usage: /workflow run <key> --inputs path-or-json',
  usage: '/workflow list | /workflow run <key> --inputs path-or-json [-o dir]',
  requiresAuth: true,
  execute: async ({ args, client, log }) => {
    if (!client) return;
    const sub = args[0];
    if (sub === 'list') {
      const response = await client.listWorkflows();
      if (response.data.length === 0) {
        log('No workflows published.', 'info');
        return;
      }
      const rows = response.data.map((w) => [w.id, w.status, w.name]);
      log(fmtTable(rows, ['id', 'status', 'name']), 'output');
      return;
    }
    if (sub === 'get') {
      const key = args[1];
      if (!key) {
        log('Usage: /workflow get <key>', 'error');
        return;
      }
      const wf = await client.getWorkflow(key);
      log(
        `${wf.name}  (${wf.id})\n${wf.description}\n\nInputs:\n${JSON.stringify(wf.input_schema, null, 2)}`,
        'output'
      );
      return;
    }
    if (sub === 'run') {
      const key = args[1];
      if (!key) {
        log('Usage: /workflow run <key> --inputs <path-or-json> [-o dir]', 'error');
        return;
      }
      const inputsIdx = args.indexOf('--inputs');
      const outputIdx = args.indexOf('-o');
      const inputsArg = inputsIdx !== -1 ? args[inputsIdx + 1] : '{}';
      const output = outputIdx !== -1 ? args[outputIdx + 1] : undefined;

      let inputs: Record<string, unknown>;
      try {
        if (inputsArg.trim().startsWith('{')) {
          inputs = JSON.parse(inputsArg);
        } else {
          const { readFile } = await import('node:fs/promises');
          inputs = JSON.parse(await readFile(inputsArg, 'utf8'));
        }
      } catch (err) {
        log(`--inputs is not valid JSON: ${(err as Error).message}`, 'error');
        return;
      }

      const label = `workflow run: ${key}`;
      const jobId = await trackJob(label, async () =>
        client.runWorkflow(key, inputs, { idempotencyKey: randomUUID() })
      );
      log(`Submitted ${label}`, 'info');
      await followJob(jobId, `workflow-${key}`, output, log);
      return;
    }
    log('Usage: /workflow [list | get <key> | run <key> --inputs ...]', 'error');
  }
});

registerSlash({
  name: 'jobs',
  summary: 'Show currently tracked jobs',
  execute: async ({ log }) => {
    const jobs = useTuiStore.getState().jobs;
    if (jobs.length === 0) {
      log('No jobs tracked this session.', 'info');
      return;
    }
    const rows = jobs.map((j) => [
      j.id.slice(0, 8),
      j.status,
      j.runId?.slice(0, 12) || '',
      j.message || '',
      describe(j.label)
    ]);
    log(fmtTable(rows, ['job', 'status', 'run', 'message', 'label']), 'output');
  }
});

registerSlash({
  name: 'influencers',
  summary: 'List your trained influencers',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listInfluencers();
    if (response.data.length === 0) {
      log('No ready influencers. Train one in the dashboard at https://genfire.ai/dashboard/influencers', 'info');
      return;
    }
    const rows = response.data.map((i) => [
      '@' + (i.handle || '(unset)'),
      i.display_name || '',
      i.id,
      i.source_type
    ]);
    log(fmtTable(rows, ['handle', 'name', 'id', 'source']), 'output');
    log('Use in prompts: /generate image "@<handle> at a coffee shop"', 'info');
  }
});

registerSlash({
  name: 'usage',
  summary: 'Credit spend and run counts (default: last 30 days)',
  usage: '/usage [model|capability|day|none]',
  requiresAuth: true,
  execute: async ({ args, client, log }) => {
    if (!client) return;
    const groupBy = args[0];
    const valid = ['model', 'capability', 'day', 'none'];
    if (groupBy && !valid.includes(groupBy)) {
      log(`Invalid grouping "${groupBy}". Use one of: ${valid.join(', ')}`, 'error');
      return;
    }
    const summary = await client.getUsage(
      groupBy ? { group_by: groupBy as 'model' | 'capability' | 'day' | 'none' } : {}
    );
    const { totals } = summary;
    log(
      `${totals.credits_spent.toLocaleString()} credits · ${totals.runs_count} runs ` +
      `(${totals.successful_runs} ok, ${totals.failed_runs} failed)`,
      'output'
    );
    if (summary.breakdown.length === 0) {
      log('No usage in this period.', 'info');
      return;
    }
    const rows = summary.breakdown.map((e) => [
      e.group,
      e.credits_spent.toLocaleString(),
      String(e.runs_count),
      e.avg_credits_per_run.toFixed(1)
    ]);
    log(fmtTable(rows, [summary.group_by, 'credits', 'runs', 'avg']), 'output');
  }
});

registerSlash({
  name: 'brands',
  summary: 'List your brand profiles',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listBrands();
    if (response.data.length === 0) {
      log('No brands yet. Build one with: genfire brands ingest <url>', 'info');
      return;
    }
    const rows = response.data.map((b) => [b.id, b.name, b.status, b.website_url]);
    log(fmtTable(rows, ['id', 'name', 'status', 'website']), 'output');
  }
});

registerSlash({
  name: 'elements',
  summary: 'List your saved elements',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listElements();
    if (response.data.length === 0) {
      log('No elements yet. Create one with: genfire elements create <name>', 'info');
      return;
    }
    const rows = response.data.map((e) => [e.id, e.name, e.handle, e.source_type]);
    log(fmtTable(rows, ['id', 'name', 'handle', 'source']), 'output');
    log('Use in prompts by name, e.g. /generate image "<name> on a beach"', 'info');
  }
});

registerSlash({
  name: 'voices',
  summary: 'List voices available for speech generation',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listVoices();
    if (response.data.length === 0) {
      log('No cloned voices. Stock voices: genfire voices list --include-stock', 'info');
      return;
    }
    const rows = response.data.map((v) => [v.id, v.name, v.type, v.provider]);
    log(fmtTable(rows, ['id', 'name', 'type', 'provider']), 'output');
  }
});

registerSlash({
  name: 'documents',
  summary: 'List the documents in your Drive',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listDocuments();
    if (response.data.length === 0) {
      log('No documents yet. Create one with: genfire documents create --html-file <path>', 'info');
      return;
    }
    const rows = response.data.map((d) => [d.id, d.title, `${(d.bytes / 1024).toFixed(1)} KB`, d.url]);
    log(fmtTable(rows, ['id', 'title', 'size', 'url']), 'output');
  }
});

registerSlash({
  name: 'skills',
  summary: 'List your installed skills',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listSkills();
    if (response.data.length === 0) {
      log('No skills installed. Browse the marketplace: genfire skills market', 'info');
      return;
    }
    const rows = response.data.map((s) => [s.id, s.title, s.category || '', s.is_public ? 'public' : '']);
    log(fmtTable(rows, ['id', 'title', 'category', 'visibility']), 'output');
  }
});

registerSlash({
  name: 'social',
  summary: 'List connected social accounts',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listSocialAccounts();
    if (response.data.length === 0) {
      log(`No connected accounts. Connect one at ${response.connect_url}`, 'info');
      return;
    }
    const rows = response.data.map((a) => [
      a.target,
      a.platform,
      a.username || '',
      a.publish_enabled ? 'yes' : 'no'
    ]);
    log(fmtTable(rows, ['target', 'platform', 'username', 'publish']), 'output');
  }
});

registerSlash({
  name: 'webhooks',
  summary: 'List your webhook endpoints',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listWebhooks();
    if (response.data.length === 0) {
      log('No webhooks. Register one with: genfire webhooks create <url>', 'info');
      return;
    }
    const rows = response.data.map((e) => [e.id, e.url, e.status, e.events.join(',')]);
    log(fmtTable(rows, ['id', 'url', 'status', 'events']), 'output');
  }
});

registerSlash({
  name: 'batches',
  summary: 'List your recent batches',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listBatches({ limit: 20 });
    if (response.data.length === 0) {
      log('No batches yet. Create one with: genfire batch create', 'info');
      return;
    }
    const rows = response.data.map((b) => [
      b.id,
      b.target,
      b.status,
      `${b.completed_items}/${b.total_items}`
    ]);
    log(fmtTable(rows, ['id', 'target', 'status', 'done']), 'output');
  }
});

registerSlash({
  name: 'music-videos',
  summary: 'List music-video visual style presets',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const styles = await client.listMusicVideoStyles();
    const rows = styles.map((s) => [s.id, s.name, describe(s.description)]);
    log(fmtTable(rows, ['id', 'name', 'description']), 'output');
    log('Generate with: genfire music-videos create "<concept>" --style <id> --song <file>', 'info');
  }
});

registerSlash({
  name: 'reels',
  summary: 'List your recurring faceless-reel subscriptions',
  requiresAuth: true,
  execute: async ({ client, log }) => {
    if (!client) return;
    const response = await client.listFacelessReelSubscriptions();
    if (response.data.length === 0) {
      log('No reel subscriptions. Create one with: genfire faceless-reels subscriptions create', 'info');
      return;
    }
    const rows = response.data.map((s) => [
      s.id,
      s.label || s.presetId,
      `${s.cadencePerDay}/day`,
      s.enabled ? 'on' : 'off'
    ]);
    log(fmtTable(rows, ['id', 'label', 'cadence', 'enabled']), 'output');
  }
});

registerSlash({
  name: 'ads',
  summary: 'Search competitor ad libraries',
  usage: '/ads <brand or niche>',
  requiresAuth: true,
  execute: async ({ rawArgs, client, log }) => {
    if (!client) return;
    const query = rawArgs.trim();
    if (!query) {
      log('Usage: /ads <brand or niche>', 'error');
      return;
    }
    const response = await client.searchAds({ query, limit: 15 });
    if (response.data.length === 0) {
      log(`No ads found for "${query}".`, 'info');
      return;
    }
    const rows = response.data.map((ad) => {
      const a = ad as Record<string, unknown>;
      const days = Number(a.days_running);
      return [
        a.ad_id ? String(a.ad_id) : '',
        Number.isFinite(days) ? `${days}d${days >= 45 ? ' proven' : ''}` : '',
        a.body_text ? describe(String(a.body_text).replace(/\s+/g, ' ')).slice(0, 70) : ''
      ];
    });
    log(fmtTable(rows, ['ad_id', 'running', 'text']), 'output');
    log('45+ days running is the proven-performance signal.', 'info');
  }
});

/**
 * Side effect: importing this file registers all built-in slash commands.
 */
export const __slashCommandsRegistered = true;
