import React from 'react';
import { Box, Text } from 'ink';
import { useTuiStore } from '../store.js';
import { palette } from '../colors.js';

export function Header(): React.ReactElement {
  const account = useTuiStore((s) => s.account);
  const baseUrl = useTuiStore((s) => s.baseUrl);
  const authSource = useTuiStore((s) => s.authSource);

  return (
    <Box borderStyle="single" borderColor={palette.muted} paddingX={1} flexDirection="row" justifyContent="space-between">
      <Box>
        <Text color={palette.brand} bold>GENFIRE</Text>
        <Text color={palette.muted}>  ·  </Text>
        {account ? (
          <>
            <Text color={palette.text}>{account.email || account.id}</Text>
            <Text color={palette.muted}>  ·  </Text>
            <Text color={palette.accent}>{account.credits.toLocaleString()} credits</Text>
            <Text color={palette.muted}>  ·  </Text>
            <Text color={palette.muted}>{account.plan}</Text>
          </>
        ) : (
          <>
            <Text color={palette.error}>not authenticated</Text>
            <Text color={palette.muted}>  ·  type </Text>
            <Text color={palette.accent}>/login</Text>
          </>
        )}
      </Box>
      <Box>
        <Text color={palette.muted} dimColor>{authSource !== 'none' ? `${authSource} · ` : ''}{baseUrl}</Text>
      </Box>
    </Box>
  );
}
