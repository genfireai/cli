import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { palette } from '../colors.js';

// ASCII rendition of the Lucide "Flame" icon used next to credit costs:
// rounded teardrop body, tapering tip that leans slightly, with an inner-flame
// notch on the lower-left. All-orange to match the GENFIRE wordmark.
//
// 8 rows × 7 cols. Each frame is a different "flicker" of the same shape —
// not a different shape — so the icon stays recognizable while it dances.
const FRAMES: string[][] = [
  // 0: upright, classic teardrop
  [
    '   ▟▖  ',
    '  ▟█▙  ',
    ' ▟███▖ ',
    '▟████▙ ',
    '█████▙ ',
    '██▟███▌',
    '▜█████▘',
    ' ▀▀▀▀  ',
  ],
  // 1: tip leans slightly right
  [
    '    ▟▖ ',
    '   ▟█▙ ',
    '  ▟███▖',
    ' ▟████▙',
    '▟█████▌',
    '██▟███▌',
    '▜█████▘',
    ' ▀▀▀▀  ',
  ],
  // 2: tip taller, narrow
  [
    '   ▟▘  ',
    '   █   ',
    '  ▟█▙  ',
    ' ▟███▖ ',
    '▟████▙ ',
    '██▟███▌',
    '▜█████▘',
    ' ▀▀▀▀  ',
  ],
  // 3: tip leans slightly left
  [
    '  ▟▖   ',
    '  ▟█▙  ',
    ' ▟███▖ ',
    '▟████▖ ',
    '█████▙ ',
    '██▟███▌',
    '▜█████▘',
    ' ▀▀▀▀  ',
  ],
  // 4: tip curls right, body bulges
  [
    '    ▟▖ ',
    '   ▟█▘ ',
    '  ▟██▖ ',
    ' ▟████▙',
    '▟█████▙',
    '██▟███▌',
    '▜█████▘',
    ' ▀▀▀▀  ',
  ],
  // 5: short stocky flicker
  [
    '       ',
    '  ▟▙   ',
    '  ▟█▙  ',
    ' ▟███▖ ',
    '▟████▙ ',
    '██▟███▌',
    '▜█████▘',
    ' ▀▀▀▀  ',
  ],
];

export function Flame(): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 220);
    return () => clearInterval(id);
  }, []);

  const rows = FRAMES[frame];
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Text key={i} color={palette.brand}>{row}</Text>
      ))}
    </Box>
  );
}
