import React from 'react';
import { Box, Text } from 'ink';
import BigText from 'ink-big-text';
import { palette } from '../colors.js';
import { Flame } from './Flame.js';

export function Splash(): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1} marginTop={1}>
      <Box flexDirection="row">
        <Box marginTop={1}>
          <BigText text="GENFIRE" font="block" space={false} colors={[palette.brand, palette.brand]} />
        </Box>
        <Box marginLeft={2} marginTop={1}>
          <Flame />
        </Box>
      </Box>
      <Box marginLeft={2}>
        <Text color={palette.muted}>Generative media for agents and humans  ·  </Text>
        <Text color={palette.accent}>https://genfire.ai</Text>
      </Box>
    </Box>
  );
}
