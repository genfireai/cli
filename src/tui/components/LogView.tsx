import React from 'react';
import { Box, Text } from 'ink';
import { useTuiStore, LogEntry } from '../store.js';
import { palette } from '../colors.js';

const KIND_COLOR: Record<LogEntry['kind'], string> = {
  system: palette.muted,
  command: palette.accent,
  output: palette.text,
  error: palette.error,
  success: palette.success,
  info: palette.muted
};

const KIND_PREFIX: Record<LogEntry['kind'], string> = {
  system: '·',
  command: '›',
  output: ' ',
  error: '✖',
  success: '✓',
  info: 'ℹ'
};

export function LogView(): React.ReactElement {
  const log = useTuiStore((s) => s.log);

  if (log.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text color={palette.muted} dimColor>
          Type /help to see available commands. Type /login to authenticate.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {log.map((entry) => {
        const lines = entry.text.split('\n');
        return (
          <Box key={entry.id} flexDirection="column" marginBottom={entry.kind === 'command' ? 0 : 1}>
            {lines.map((line, idx) => (
              <Box key={idx}>
                <Text color={KIND_COLOR[entry.kind]}>
                  {idx === 0 ? `${KIND_PREFIX[entry.kind]} ` : '  '}
                  {line}
                </Text>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
