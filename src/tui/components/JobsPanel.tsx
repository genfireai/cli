import React from 'react';
import { Box, Text } from 'ink';
import { useTuiStore } from '../store.js';
import { palette } from '../colors.js';

const STATUS_COLOR: Record<string, string> = {
  pending: palette.muted,
  running: palette.warning,
  completed: palette.success,
  failed: palette.error,
  cancelled: palette.muted
};

const STATUS_GLYPH: Record<string, string> = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✖',
  cancelled: '⊘'
};

export function JobsPanel(): React.ReactElement | null {
  const jobs = useTuiStore((s) => s.jobs);

  // Hide while there are no jobs to keep the chrome quiet.
  if (jobs.length === 0) return null;

  // Only show the most recent 5 to avoid eating screen space.
  const recent = jobs.slice(-5);

  return (
    <Box borderStyle="single" borderColor={palette.muted} paddingX={1} flexDirection="column" marginTop={1}>
      <Text color={palette.muted} dimColor>jobs</Text>
      {recent.map((job) => {
        const elapsed = job.endedAt
          ? `${Math.round((job.endedAt - job.startedAt) / 1000)}s`
          : `${Math.round((Date.now() - job.startedAt) / 1000)}s`;
        return (
          <Box key={job.id}>
            <Text color={STATUS_COLOR[job.status] || palette.text}>
              {STATUS_GLYPH[job.status] || '?'} {job.status.padEnd(9)}
            </Text>
            <Text color={palette.muted} dimColor>{elapsed.padStart(5)} </Text>
            <Text color={palette.text}>{job.label.length > 60 ? job.label.slice(0, 57) + '...' : job.label}</Text>
            {job.message && job.status === 'running' && (
              <Text color={palette.muted} dimColor> · {job.message}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
