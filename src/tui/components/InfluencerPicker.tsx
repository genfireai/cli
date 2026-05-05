import React, { useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Influencer } from '@genfire/sdk';
import { useTuiStore } from '../store.js';
import { palette } from '../colors.js';

const MAX_VISIBLE = 6;

export function InfluencerPicker(): React.ReactElement | null {
  const picker = useTuiStore((s) => s.picker);
  const cache = useTuiStore((s) => s.influencerCache);
  const setInfluencerCache = useTuiStore((s) => s.setInfluencerCache);
  const client = useTuiStore((s) => s.client);

  // Lazy-fetch on first open of the session.
  useEffect(() => {
    if (picker.open && cache === null && client) {
      client.listInfluencers()
        .then((response) => setInfluencerCache(response.data))
        .catch(() => setInfluencerCache([]));
    }
  }, [picker.open, cache, client, setInfluencerCache]);

  const candidates = useMemo<Influencer[]>(() => {
    if (!cache) return [];
    const q = picker.query.toLowerCase();
    if (!q) return cache.slice(0, MAX_VISIBLE);
    return cache
      .filter((i) => i.handle.toLowerCase().startsWith(q) || i.display_name.toLowerCase().includes(q))
      .slice(0, MAX_VISIBLE);
  }, [cache, picker.query]);

  if (!picker.open) return null;

  if (cache === null) {
    return (
      <Box marginLeft={2}>
        <Text color={palette.muted} dimColor>loading influencers…</Text>
      </Box>
    );
  }

  if (cache.length === 0) {
    return (
      <Box marginLeft={2}>
        <Text color={palette.muted} dimColor>
          No ready influencers. Train one at https://genfire.ai/dashboard/influencers
        </Text>
      </Box>
    );
  }

  if (candidates.length === 0) {
    return (
      <Box marginLeft={2}>
        <Text color={palette.muted} dimColor>
          No influencers match @{picker.query}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Text color={palette.muted} dimColor>↑↓ select · Enter insert · Esc cancel</Text>
      {candidates.map((influencer, idx) => {
        const selected = idx === picker.selectedIndex;
        return (
          <Box key={influencer.id}>
            <Text color={selected ? palette.accent : palette.muted}>
              {selected ? '▸ ' : '  '}
            </Text>
            <Text color={selected ? palette.accent : palette.text} bold={selected}>
              @{influencer.handle.padEnd(14)}
            </Text>
            <Text color={palette.muted}>
              {(influencer.display_name || '').padEnd(20)}
            </Text>
            <Text color={palette.muted} dimColor>
              {influencer.source_type}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Returns the candidate that should be selected on Enter, given the current store state.
 */
export function pickerSelectedHandle(): string | null {
  const { picker, influencerCache } = useTuiStore.getState();
  if (!picker.open || !influencerCache) return null;
  const q = picker.query.toLowerCase();
  const candidates = q
    ? influencerCache.filter((i) => i.handle.toLowerCase().startsWith(q) || i.display_name.toLowerCase().includes(q))
    : influencerCache.slice(0, MAX_VISIBLE);
  const choice = candidates[picker.selectedIndex];
  return choice ? choice.handle : null;
}

export function pickerCandidateCount(): number {
  const { picker, influencerCache } = useTuiStore.getState();
  if (!picker.open || !influencerCache) return 0;
  const q = picker.query.toLowerCase();
  const candidates = q
    ? influencerCache.filter((i) => i.handle.toLowerCase().startsWith(q) || i.display_name.toLowerCase().includes(q))
    : influencerCache.slice(0, MAX_VISIBLE);
  return Math.min(candidates.length, MAX_VISIBLE);
}
