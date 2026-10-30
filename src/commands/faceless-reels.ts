import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient, publicApiRequest } from '../client.js';
import { CliError } from '../errors.js';
import { cyan, dim, printResult, printTable } from '../output.js';

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
    .option('-d, --duration <seconds>', 'Target length in seconds (10–600, up to 10 minutes)')
    .option('--music-source <source>', 'none | preset | ai | library', 'none')
    .option('-e, --episodes <n>', 'Series size 1-4: quote per-episode credits × episodes')
    .action(async (opts: { preset?: string; duration?: string; musicSource?: string; episodes?: string }) => {
      const body = {
        preset_id: opts.preset,
        target_duration_sec: opts.duration ? Number(opts.duration) : undefined,
        music: opts.musicSource ? { source: opts.musicSource as 'none' | 'preset' | 'ai' | 'library' } : undefined,
        ...(opts.episodes ? { episodes: Number(opts.episodes) } : {}),
      };
      const estimate = await publicApiRequest<Record<string, any>>('POST', '/faceless-reels/estimate-cost', { body });
      printResult(estimate, () => {
        process.stdout.write(
          `${dim('scenes:')}    ${estimate.sceneCount}\n` +
          `${dim('images:')}    ${estimate.images}\n` +
          `${dim('voiceover:')} ${estimate.voiceover}\n` +
          `${dim('music:')}     ${estimate.music}\n` +
          `${dim('total:')}     ${estimate.total} credits\n` +
          (estimate.series_total !== undefined ? `${dim('series:')}    ${estimate.episodes} episodes × ${estimate.per_episode_total} = ${estimate.series_total} credits\n` : '')
        );
      });
    });

  // ── Series (1-4 episodes, one continuous story) ──────────────────────────────

  const series = reels
    .command('series')
    .description('Faceless SERIES: 1-4 episodes of one continuous story, posted in order');

  type SeriesOpts = {
    episodes?: string; channel?: string; preset?: string; duration?: string; aspect?: string;
    style?: string; voice?: string; spacing?: string; target?: string[]; premise?: string; tone?: string; world?: string;
  };
  const seriesBody = (topic: string, opts: SeriesOpts) => ({
    topic,
    ...(opts.episodes ? { episodes: Number(opts.episodes) } : {}),
    ...(opts.channel ? { subscription_id: opts.channel } : {}),
    ...(opts.preset ? { preset_id: opts.preset } : {}),
    ...(opts.duration ? { target_duration_sec: Number(opts.duration) } : {}),
    ...(opts.aspect ? { aspect_ratio: opts.aspect } : {}),
    ...(opts.style ? { style_id: opts.style } : {}),
    ...(opts.voice ? { voice_id: opts.voice } : {}),
    ...(opts.spacing ? { publish_spacing_hours: Number(opts.spacing) } : {}),
    ...(opts.target?.length ? { targets: opts.target } : {}),
    ...(opts.premise || opts.tone || opts.world ? { series_bible: { premise: opts.premise, tone: opts.tone, world: opts.world } } : {}),
  });
  const withSeriesOptions = (cmd: Command) => cmd
    .option('-e, --episodes <n>', 'Episodes 1-4 (default 3)')
    .option('-c, --channel <id>', 'File under this channel (its settings + accounts, posted in order)')
    .option('-p, --preset <id>', 'Without a channel: niche preset id (what-if-*) or saved format (cp_…)')
    .option('-d, --duration <seconds>', 'Seconds per episode (8-600)')
    .option('--aspect <ratio>', '9:16 | 16:9')
    .option('--style <id>', 'Visual style id')
    .option('--voice <id>', 'Narrator voice id')
    .option('--spacing <hours>', 'Hours between episode posts (0-168)')
    .option('--target <platform:account>', 'Without a channel: account to post to (repeatable)', (v: string, prev: string[] = []) => [...prev, v])
    .option('--premise <text>', 'Series bible: premise')
    .option('--tone <text>', 'Series bible: tone')
    .option('--world <text>', 'Series bible: world and its rules');

  withSeriesOptions(series.command('estimate <topic>').description('Quote a series (per-episode credits × episodes)'))
    .action(async (topic: string, opts: SeriesOpts) => {
      const result = await publicApiRequest<Record<string, any>>('POST', '/faceless-reels/series/estimate', { body: seriesBody(topic, opts) });
      printResult(result, () => {
        process.stdout.write(`${dim('Engine:')}   ${result.engine} ${dim(`(${result.aspect_ratio}, ${result.target_duration_sec}s per episode)`)}\n`);
        process.stdout.write(`${dim('Total:')}    ${result.episodes} × ${result.per_episode_total} = ${result.total} credits\n`);
      });
    });

  withSeriesOptions(series.command('create <topic>').description('Plan + start a series (bills credits per episode; async runs)'))
    .action(async (topic: string, opts: SeriesOpts) => {
      if (topic.trim().length < 3) throw new CliError('topic must be at least 3 characters', 'invalid_series_topic');
      const result = await publicApiRequest<Record<string, any>>('POST', '/faceless-reels/series', { body: seriesBody(topic, opts), idempotencyKey: randomUUID() });
      printResult(result, () => {
        process.stderr.write(`${dim('Series:')} ${cyan(result.id)} ${result.title} ${dim(`(${result.status})`)}\n`);
        for (const ep of result.episodes ?? []) {
          process.stderr.write(`  ${ep.index}. ${ep.title} ${dim(ep.run_id ? `run ${ep.run_id}` : (ep.error || ''))}\n`);
        }
        process.stderr.write(`${dim('Check it with:')} genfire faceless-reels series get ${result.id}\n`);
      });
    });

  series
    .command('list')
    .description('List your series')
    .option('-c, --channel <id>', 'Only series under this channel')
    .action(async (opts: { channel?: string }) => {
      const result = await publicApiRequest<Record<string, any>>('GET', `/faceless-reels/series${opts.channel ? `?subscription_id=${encodeURIComponent(opts.channel)}` : ''}`);
      printResult(result, () => {
        printTable(
          (result.data ?? []).map((s: any) => ({ id: s.id, title: s.title, status: s.status, episodes: s.episode_count, released: s.publish?.released_through ?? 0 })),
          ['id', 'title', 'status', 'episodes', 'released']
        );
      });
    });

  series
    .command('get <id>')
    .description('Show a series: bible, episodes, release progress')
    .action(async (id: string) => {
      const result = await publicApiRequest<Record<string, any>>('GET', `/faceless-reels/series/${encodeURIComponent(id)}`);
      printResult(result, () => {
        process.stdout.write(`${cyan(result.title)} ${dim(`(${result.status})`)}\n${dim('Premise:')} ${result.bible?.premise ?? ''}\n`);
        printTable(
          (result.episodes ?? []).map((e: any) => ({ '#': e.index, title: e.title, status: e.status, released: e.released ? 'yes' : '', video: e.video_url ?? '' })),
          ['#', 'title', 'status', 'released', 'video']
        );
      });
    });

  series
    .command('release <id>')
    .description('Post every episode that is next in line (normally automatic)')
    .action(async (id: string) => {
      const result = await publicApiRequest<Record<string, any>>('POST', `/faceless-reels/series/${encodeURIComponent(id)}/release`, { body: {} });
      printResult(result, () => process.stdout.write(`${dim('Released:')} ${(result.released ?? []).join(', ') || 'nothing new'}\n`));
    });

  // ── Saved formats + per-line voiceover redo ─────────────────────────────────

  reels
    .command('preset-from-link <url>')
    .description('Save a TikTok / Reel / Short\'s FORMAT as a reusable preset (never its audio, script or footage; bills one video analysis)')
    .option('-l, --label <name>', 'Name for the saved format')
    .action(async (url: string, opts: { label?: string }) => {
      const result = await publicApiRequest<Record<string, any>>('POST', '/faceless-reels/custom-presets/from-link', {
        body: { url, ...(opts.label ? { label: opts.label } : {}) },
        idempotencyKey: randomUUID(),
      });
      printResult(result, () => {
        process.stdout.write(`${dim('Saved:')} ${cyan(result.id)} ${result.label}\n`);
        process.stdout.write(`${dim('Hook:')}  ${result.format?.hook_pattern ?? ''}\n${dim('Cuts:')}  every ~${result.format?.shot_length_sec ?? '?'}s${result.format?.measured ? '' : ' (inferred)'}\n`);
        process.stdout.write(`${dim('Use it with:')} --preset ${result.id}\n`);
      });
    });

  reels
    .command('saved-presets')
    .description('List your saved formats (cp_… ids)')
    .action(async () => {
      const result = await publicApiRequest<Record<string, any>>('GET', '/faceless-reels/custom-presets');
      printResult(result, () => {
        printTable((result.data ?? []).map((p: any) => ({ id: p.id, label: p.label, style: p.recommended_style_id, length: p.target_duration_sec })), ['id', 'label', 'style', 'length']);
      });
    });

  reels
    .command('redo-line <reelId> [line]')
    .description('List an episode\'s voiceover lines, or re-voice ONE line (only compose + captions re-run)')
    .option('-t, --text <words>', 'New words for the line (omit for a fresh read)')
    .action(async (reelId: string, line: string | undefined, opts: { text?: string }) => {
      const base = `/faceless-reels/reels/${encodeURIComponent(reelId)}/voiceover-lines`;
      if (line === undefined) {
        const result = await publicApiRequest<Record<string, any>>('GET', base);
        printResult(result, () => {
          printTable((result.data ?? []).map((l: any) => ({ line: l.index, start: l.start_sec ?? '', text: l.text })), ['line', 'start', 'text']);
        });
        return;
      }
      const n = Number(line);
      if (!Number.isInteger(n) || n < 0) throw new CliError('line must be a 0-based line number', 'invalid_line');
      const result = await publicApiRequest<Record<string, any>>('POST', `${base}/${n}/redo`, { body: opts.text ? { text: opts.text } : {} });
      printResult(result, () => process.stderr.write(`${dim('Re-rendering line')} ${result.line} ${dim(`(${result.status}${result.shift_sec ? `, later lines shift ${result.shift_sec}s` : ''})`)}\n`));
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
    .description('Create a faceless channel (a recurring series; "subscription" is legacy naming)')
    .option('--label <name>', 'A name for the Story')
    .option('-p, --preset <id>', 'Niche preset id')
    .option('-s, --style <id>', 'Visual style id')
    .option('-c, --caption-preset <id>', 'Caption preset id')
    .option('--voice-id <id>', 'TTS voice id')
    .option('--vibe <mode>', 'Camera-motion feel: auto | calm | dynamic | energetic')
    .option('--animated-hook', 'Premium: animate the first scene with a real video clip')
    .option('--video-model <m>', 'i2v model for the animated hook: grok | seedance-mini')
    .option('-d, --duration <seconds>', 'Target length in seconds (10–600, up to 10 minutes)')
    .option('--topic-source <source>', 'ai-auto | user-list', 'ai-auto')
    .option('--topic-seeds <list>', 'Comma-separated topics (with --topic-source user-list)')
    .option('--cadence-per-day <n>', 'Reels per day (1–6)')
    .option('--slots <list>', 'Comma-separated local "HH:mm" times (count must equal cadence)')
    .option('--timezone <tz>', 'IANA timezone, e.g. America/New_York')
    .option('--niche <id>', 'Channel niche id (education, history, kids, storytelling, …)')
    .option('--format <f>', "'shorts' (9:16 reels) or 'longform' (16:9 explainers) — picks the engine")
    .option('--tagline <text>', 'One-line pitch under the channel name')
    .option('--description <text>', 'Longer channel description')
    .option('--avatar-url <url>', 'Square channel avatar image URL (https)')
    .option('--episode-aspect <ar>', "Episode default aspect ratio: 16:9 | 9:16")
    .option('--episode-motion <m>', 'Episode default motion: seamless | scenes | stills')
    .option('--disabled', 'Create the schedule paused')
    .action(async (opts: {
      label?: string; preset?: string; style?: string; captionPreset?: string; voiceId?: string;
      vibe?: string; animatedHook?: boolean; videoModel?: string; duration?: string; topicSource?: string; topicSeeds?: string; cadencePerDay?: string;
      slots?: string; timezone?: string; disabled?: boolean;
      niche?: string; format?: string; tagline?: string; description?: string; avatarUrl?: string;
      episodeAspect?: string; episodeMotion?: string;
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
        niche: opts.niche,
        format: opts.format as ('shorts' | 'longform') | undefined,
        tagline: opts.tagline,
        description: opts.description,
        avatar_url: opts.avatarUrl,
        episode_defaults: (opts.episodeAspect || opts.episodeMotion) ? {
          aspect_ratio: opts.episodeAspect as ('16:9' | '9:16') | undefined,
          motion_style: opts.episodeMotion as ('seamless' | 'scenes' | 'stills') | undefined,
        } : undefined,
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
    .option('-d, --duration <seconds>', 'Target length in seconds (10–600, up to 10 minutes)')
    .option('--cadence-per-day <n>', 'Reels per day (1–6)')
    .option('--slots <list>', 'Comma-separated local "HH:mm" times')
    .option('--timezone <tz>', 'IANA timezone')
    .option('--niche <id>', 'Channel niche id (education, history, kids, storytelling, …)')
    .option('--format <f>', "'shorts' (9:16 reels) or 'longform' (16:9 explainers) — picks the engine")
    .option('--tagline <text>', 'One-line pitch under the channel name')
    .option('--description <text>', 'Longer channel description')
    .option('--avatar-url <url>', 'Square channel avatar image URL (https)')
    .option('--episode-aspect <ar>', "Episode default aspect ratio: 16:9 | 9:16")
    .option('--episode-motion <m>', 'Episode default motion: seamless | scenes | stills')
    .option('--enable', 'Resume the schedule')
    .option('--disable', 'Pause the schedule')
    .action(async (id: string, opts: {
      label?: string; preset?: string; style?: string; captionPreset?: string; voiceId?: string;
      vibe?: string; animatedHook?: boolean; videoModel?: string; duration?: string; cadencePerDay?: string; slots?: string; timezone?: string;
      enable?: boolean; disable?: boolean;
      niche?: string; format?: string; tagline?: string; description?: string; avatarUrl?: string;
      episodeAspect?: string; episodeMotion?: string;
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
        niche: opts.niche,
        format: opts.format as ('shorts' | 'longform') | undefined,
        tagline: opts.tagline,
        description: opts.description,
        avatar_url: opts.avatarUrl,
        episode_defaults: (opts.episodeAspect || opts.episodeMotion) ? {
          aspect_ratio: opts.episodeAspect as ('16:9' | '9:16') | undefined,
          motion_style: opts.episodeMotion as ('seamless' | 'scenes' | 'stills') | undefined,
        } : undefined,
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

  // ── Channel episodes (/subscriptions/{id}/episodes) ─────────────────────────
  // One episode of a channel with per-episode overrides, its free quote, and
  // the channel's back catalogue. The MCP twin is genfire_create_channel_episode.

  const withEpisodeOptions = (cmd: Command): Command => cmd
    .option('--aspect-ratio <ar>', '16:9 | 9:16 (defaults to the channel)')
    .option('--motion <style>', 'seamless | scenes | stills')
    .option('--engine <engine>', 'reel | explainer (defaults to the channel format)')
    .option('-d, --duration <seconds>', 'Target length in seconds')
    .option('-s, --style <id>', 'Visual style id override')
    .option('--voice-id <id>', 'TTS voice id override')
    .option('--custom-script-file <path>', 'Plain-text file narrated verbatim')
    .option('--script-file <path>', 'JSON structured script ({ cast?, beats: [...] }) — authors every beat yourself')
    .option('--style-prompt <text>', 'Custom visual style prompt')
    .option('--style-anchor <url>', 'Image URL the visual style is anchored to')
    .option('--captions <on|off>', 'Burn in captions or not')
    .option('--fast', 'Fast mode (cheaper, quicker, fewer animated scenes)')
    .option('--no-fast', 'Force full-quality mode')
    .option(
      '--ref <url[|label]>',
      'Reference image URL with an optional |label (repeat for several)',
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[]
    );

  type EpisodeOpts = {
    aspectRatio?: string; motion?: string; engine?: string; duration?: string; style?: string; voiceId?: string;
    customScriptFile?: string; scriptFile?: string; stylePrompt?: string; styleAnchor?: string; captions?: string;
    fast?: boolean; ref?: string[];
  };

  const episodeBody = async (topic: string | undefined, opts: EpisodeOpts): Promise<Record<string, unknown>> => {
    const readText = async (path: string, flag: string) => {
      try {
        return await readFile(path, 'utf8');
      } catch (err) {
        throw new CliError(`Could not read ${flag} ${path}: ${(err as Error).message}`, 'invalid_file');
      }
    };
    let script: unknown;
    if (opts.scriptFile) {
      try {
        script = JSON.parse(await readText(opts.scriptFile, '--script-file'));
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError(`--script-file is not valid JSON: ${(err as Error).message}`, 'invalid_script_file');
      }
    }
    if (opts.captions !== undefined && opts.captions !== 'on' && opts.captions !== 'off') {
      throw new CliError('--captions must be on or off', 'invalid_option');
    }
    const duration = opts.duration === undefined ? undefined : Number(opts.duration);
    if (duration !== undefined && !Number.isFinite(duration)) {
      throw new CliError('--duration must be a number of seconds', 'invalid_duration');
    }
    const refs = (opts.ref ?? []).map((entry) => {
      const pipe = entry.indexOf('|');
      if (pipe === -1) return { url: entry.trim() };
      const label = entry.slice(pipe + 1).trim();
      return { url: entry.slice(0, pipe).trim(), ...(label ? { label } : {}) };
    });
    return {
      ...(topic ? { topic } : {}),
      ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
      ...(opts.motion ? { motion_style: opts.motion } : {}),
      ...(opts.engine ? { engine: opts.engine } : {}),
      ...(duration !== undefined ? { target_duration_sec: duration } : {}),
      ...(opts.style ? { style_id: opts.style } : {}),
      ...(opts.voiceId ? { voice_id: opts.voiceId } : {}),
      ...(opts.customScriptFile ? { custom_script: await readText(opts.customScriptFile, '--custom-script-file') } : {}),
      ...(script !== undefined ? { script } : {}),
      ...(opts.stylePrompt ? { custom_style_prompt: opts.stylePrompt } : {}),
      ...(opts.styleAnchor ? { style_anchor_url: opts.styleAnchor } : {}),
      ...(opts.captions ? { captions_on: opts.captions === 'on' } : {}),
      ...(opts.fast !== undefined ? { fast_mode: opts.fast } : {}),
      ...(refs.length ? { reference_images: refs } : {})
    };
  };

  subs
    .command('episodes <id>')
    .description("List a channel's episodes, newest first")
    .option('-l, --limit <n>', 'Max episodes, 1-100', '30')
    .action(async (id: string, opts: { limit: string }) => {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError('--limit must be an integer 1-100', 'invalid_limit');
      }
      const response = await publicApiRequest<{ object: 'list'; data: Array<Record<string, any>> }>(
        'GET',
        `/faceless-reels/subscriptions/${encodeURIComponent(id)}/episodes?limit=${limit}`
      );
      printResult(response, () => {
        if (!response.data?.length) {
          process.stdout.write(`${dim('No episodes yet. Make one: genfire faceless-reels subscriptions add-episode ' + id + ' "<topic>"')}\n`);
          return;
        }
        printTable(
          response.data.map((e) => ({
            id: e.id,
            topic: String(e.topic ?? '').slice(0, 40),
            status: e.status ?? '',
            kind: e.kind ?? '',
            aspect: e.aspect_ratio ?? '',
            created: e.created_at ? String(e.created_at).replace('T', ' ').slice(0, 16) : ''
          })),
          ['id', 'topic', 'status', 'kind', 'aspect', 'created']
        );
      });
    });

  withEpisodeOptions(
    subs
      .command('estimate-episode <id> [topic]')
      .description('Plan and price one episode of a channel. Free — nothing is billed')
  ).action(async (id: string, topic: string | undefined, opts: EpisodeOpts) => {
    const result = await publicApiRequest<Record<string, any>>(
      'POST',
      `/faceless-reels/subscriptions/${encodeURIComponent(id)}/estimate-episode`,
      { body: await episodeBody(topic, opts) }
    );
    printResult(result, () => {
      const credits = result.estimate?.total ?? result.estimate?.credits ?? result.credits;
      process.stdout.write(`${dim('Estimate:')} ${cyan(String(credits ?? '?'))} credits\n`);
      if (result.plan?.engine) process.stdout.write(`${dim('Engine:')}   ${result.plan.engine}\n`);
      if (result.plan?.target_duration_sec) process.stdout.write(`${dim('Length:')}   ${result.plan.target_duration_sec}s\n`);
    });
  });

  withEpisodeOptions(
    subs
      .command('add-episode <id> <topic>')
      .description('Produce ONE episode of a channel now, with per-episode overrides (bills credits; async run)')
  ).action(async (id: string, topic: string, opts: EpisodeOpts) => {
    if (topic.trim().length < 3) {
      throw new CliError('topic must be at least 3 characters', 'invalid_episode_topic');
    }
    const run = await publicApiRequest<Record<string, any>>(
      'POST',
      `/faceless-reels/subscriptions/${encodeURIComponent(id)}/episodes`,
      { body: await episodeBody(topic, opts), idempotencyKey: randomUUID() }
    );
    printResult(run, () => {
      process.stderr.write(`${dim('Run queued:')} ${run.id} ${dim(`(${run.status})`)}\n`);
      process.stderr.write(`${dim('Poll it with:')} genfire runs get ${run.id}\n`);
    });
  });
}
