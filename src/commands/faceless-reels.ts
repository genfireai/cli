import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { createClient } from '../client.js';
import { dim, printResult, printTable } from '../output.js';

export function registerFacelessReelsCommand(program: Command): void {
  const reels = program
    .command('faceless-reels')
    .description('Faceless-reel catalogs, cost estimates, and recurring subscriptions ("Stories")');

  // ── Catalogs ────────────────────────────────────────────────────────────────

  reels
    .command('presets')
    .description('List niche presets (pass as --preset to `generate faceless-reel`)')
    .action(async () => {
      const client = await createClient();
      const response = await client.listFacelessReelPresets();
      printResult(response, () => {
        printTable(
          response.data.map((p) => ({ id: p.id, label: p.label, tone: p.tone, style: p.recommendedStyleId })),
          ['id', 'label', 'tone', 'style']
        );
      });
    });

  reels
    .command('styles')
    .description('List visual styles (pass as --style to `generate faceless-reel`)')
    .action(async () => {
      const client = await createClient();
      const response = await client.listFacelessReelStyles();
      printResult(response, () => {
        printTable(
          response.data.map((s) => ({ id: s.id, label: s.label, group: s.group })),
          ['id', 'label', 'group']
        );
      });
    });

  reels
    .command('music-presets')
    .description('List curated background-music tracks')
    .action(async () => {
      const client = await createClient();
      const response = await client.listFacelessReelMusicPresets();
      printResult(response, () => {
        printTable(
          response.data.map((m) => ({ id: m.id, label: m.label, mood: m.mood })),
          ['id', 'label', 'mood']
        );
      });
    });

  reels
    .command('caption-presets')
    .description('List caption font/animation presets')
    .action(async () => {
      const client = await createClient();
      const response = await client.listFacelessReelCaptionPresets();
      printResult(response, () => {
        printTable(
          response.data.map((c) => ({ id: c.id, label: c.label, animation: c.animation })),
          ['id', 'label', 'animation']
        );
      });
    });

  reels
    .command('estimate-cost')
    .description('Estimate the credit cost of a reel before generating it')
    .option('-p, --preset <id>', 'Niche preset id')
    .option('-d, --duration <seconds>', 'Target length in seconds (10–120)')
    .option('--music-source <source>', 'none | preset | ai | library', 'none')
    .action(async (opts: { preset?: string; duration?: string; musicSource?: string }) => {
      const client = await createClient();
      const estimate = await client.estimateFacelessReelCost({
        preset_id: opts.preset,
        target_duration_sec: opts.duration ? Number(opts.duration) : undefined,
        music: opts.musicSource ? { source: opts.musicSource as 'none' | 'preset' | 'ai' | 'library' } : undefined
      });
      printResult(estimate, () => {
        process.stdout.write(
          `${dim('scenes:')}    ${estimate.sceneCount}\n` +
          `${dim('images:')}    ${estimate.images}\n` +
          `${dim('voiceover:')} ${estimate.voiceover}\n` +
          `${dim('music:')}     ${estimate.music}\n` +
          `${dim('total:')}     ${estimate.total} credits\n`
        );
      });
    });

  // ── Subscriptions ("Stories") ────────────────────────────────────────────────

  const subs = reels
    .command('subscriptions')
    .description('Recurring "Stories" that auto-generate reels on a daily schedule');

  subs
    .command('list')
    .description('List your reel subscriptions')
    .action(async () => {
      const client = await createClient();
      const response = await client.listFacelessReelSubscriptions();
      printResult(response, () => {
        if (response.data.length === 0) {
          process.stdout.write(`${dim('No subscriptions. Create one: genfire faceless-reels subscriptions create')}\n`);
          return;
        }
        printTable(
          response.data.map((s) => ({
            id: s.id,
            label: s.label || '',
            preset: s.presetId,
            enabled: s.enabled ? 'yes' : 'no',
            perDay: s.cadencePerDay,
            slots: (s.slots || []).join(','),
            tz: s.timezone
          })),
          ['id', 'label', 'preset', 'enabled', 'perDay', 'slots', 'tz']
        );
      });
    });

  subs
    .command('create')
    .description('Create a recurring reel subscription')
    .option('--label <name>', 'A name for the Story')
    .option('-p, --preset <id>', 'Niche preset id')
    .option('-s, --style <id>', 'Visual style id')
    .option('-c, --caption-preset <id>', 'Caption preset id')
    .option('--voice-id <id>', 'TTS voice id')
    .option('--vibe <mode>', 'Camera-motion feel: auto | calm | dynamic | energetic')
    .option('--animated-hook', 'Premium: animate the first scene with a real video clip')
    .option('--video-model <m>', 'i2v model for the animated hook: grok | seedance-mini')
    .option('-d, --duration <seconds>', 'Target length in seconds (10–120)')
    .option('--topic-source <source>', 'ai-auto | user-list', 'ai-auto')
    .option('--topic-seeds <list>', 'Comma-separated topics (with --topic-source user-list)')
    .option('--cadence-per-day <n>', 'Reels per day (1–6)')
    .option('--slots <list>', 'Comma-separated local "HH:mm" times (count must equal cadence)')
    .option('--timezone <tz>', 'IANA timezone, e.g. America/New_York')
    .option('--disabled', 'Create the schedule paused')
    .action(async (opts: {
      label?: string; preset?: string; style?: string; captionPreset?: string; voiceId?: string;
      vibe?: string; animatedHook?: boolean; videoModel?: string; duration?: string; topicSource?: string; topicSeeds?: string; cadencePerDay?: string;
      slots?: string; timezone?: string; disabled?: boolean;
    }) => {
      const client = await createClient();
      const sub = await client.createFacelessReelSubscription({
        label: opts.label,
        preset_id: opts.preset,
        style_id: opts.style,
        caption_preset_id: opts.captionPreset,
        voice_id: opts.voiceId,
        motion_vibe: opts.vibe as ('auto' | 'calm' | 'dynamic' | 'energetic') | undefined,
        animated_hook: opts.animatedHook,
        video_model: opts.videoModel as ('grok' | 'seedance-mini') | undefined,
        target_duration_sec: opts.duration ? Number(opts.duration) : undefined,
        topic_source: opts.topicSource as 'ai-auto' | 'user-list' | undefined,
        topic_seeds: opts.topicSeeds ? opts.topicSeeds.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        cadence_per_day: opts.cadencePerDay ? Number(opts.cadencePerDay) : undefined,
        slots: opts.slots ? opts.slots.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        timezone: opts.timezone,
        enabled: opts.disabled ? false : undefined
      });
      printResult(sub, () => {
        process.stdout.write(`${dim('Created subscription')} ${sub.id}\n`);
      });
    });

  subs
    .command('update <id>')
    .description('Update a reel subscription (e.g. pause with --disabled)')
    .option('--label <name>', 'A name for the Story')
    .option('-p, --preset <id>', 'Niche preset id')
    .option('-s, --style <id>', 'Visual style id')
    .option('-c, --caption-preset <id>', 'Caption preset id')
    .option('--voice-id <id>', 'TTS voice id')
    .option('--vibe <mode>', 'Camera-motion feel: auto | calm | dynamic | energetic')
    .option('--animated-hook', 'Premium: animate the first scene with a real video clip')
    .option('--video-model <m>', 'i2v model for the animated hook: grok | seedance-mini')
    .option('-d, --duration <seconds>', 'Target length in seconds (10–120)')
    .option('--cadence-per-day <n>', 'Reels per day (1–6)')
    .option('--slots <list>', 'Comma-separated local "HH:mm" times')
    .option('--timezone <tz>', 'IANA timezone')
    .option('--enable', 'Resume the schedule')
    .option('--disable', 'Pause the schedule')
    .action(async (id: string, opts: {
      label?: string; preset?: string; style?: string; captionPreset?: string; voiceId?: string;
      vibe?: string; animatedHook?: boolean; videoModel?: string; duration?: string; cadencePerDay?: string; slots?: string; timezone?: string;
      enable?: boolean; disable?: boolean;
    }) => {
      const client = await createClient();
      const sub = await client.updateFacelessReelSubscription(id, {
        label: opts.label,
        preset_id: opts.preset,
        style_id: opts.style,
        caption_preset_id: opts.captionPreset,
        voice_id: opts.voiceId,
        motion_vibe: opts.vibe as ('auto' | 'calm' | 'dynamic' | 'energetic') | undefined,
        animated_hook: opts.animatedHook,
        video_model: opts.videoModel as ('grok' | 'seedance-mini') | undefined,
        target_duration_sec: opts.duration ? Number(opts.duration) : undefined,
        cadence_per_day: opts.cadencePerDay ? Number(opts.cadencePerDay) : undefined,
        slots: opts.slots ? opts.slots.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        timezone: opts.timezone,
        enabled: opts.enable ? true : opts.disable ? false : undefined
      });
      printResult(sub, () => {
        process.stdout.write(`${dim('Updated subscription')} ${sub.id}\n`);
      });
    });

  subs
    .command('delete <id>')
    .description('Delete a reel subscription')
    .action(async (id: string) => {
      const client = await createClient();
      const result = await client.deleteFacelessReelSubscription(id);
      printResult(result, () => {
        process.stdout.write(`${dim('Deleted subscription')} ${id}\n`);
      });
    });

  subs
    .command('run-now <id>')
    .description('Generate one reel now for a subscription (async run; poll with `genfire runs get`)')
    .option('--topic <text>', 'Optional topic override for this run')
    .action(async (id: string, opts: { topic?: string }) => {
      const client = await createClient();
      const run = await client.runFacelessReelSubscriptionNow(id, { topic: opts.topic }, { idempotencyKey: randomUUID() });
      printResult(run, () => {
        process.stderr.write(`${dim('Run queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
        process.stderr.write(`${dim('Poll it with:')} genfire runs get ${run.id}\n`);
      });
    });
}
