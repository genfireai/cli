import React, { useEffect } from 'react';
import { Box, Static } from 'ink';
import { Splash } from './components/Splash.js';
import { Header } from './components/Header.js';
import { LogView } from './components/LogView.js';
import { JobsPanel } from './components/JobsPanel.js';
import { Prompt } from './components/Prompt.js';
import { applyAuthToStore } from './session.js';
import { useTuiStore } from './store.js';
import './slash/commands.js';

export function App(): React.ReactElement {
  const log = useTuiStore((s) => s.log);

  useEffect(() => {
    applyAuthToStore()
      .then(() => {
        const account = useTuiStore.getState().account;
        if (account) {
          useTuiStore.getState().appendLog({
            kind: 'system',
            text: `Welcome back, ${account.email || account.id}.`
          });
        } else {
          useTuiStore.getState().appendLog({
            kind: 'system',
            text: 'Not authenticated. Type /login to sign in via your browser.'
          });
        }
      })
      .catch((err: Error) => {
        useTuiStore.getState().appendLog({
          kind: 'error',
          text: `Could not validate stored credentials: ${err.message}`
        });
      });
  }, []);

  return (
    <Box flexDirection="column">
      <Static items={[{ id: 'splash' }]}>
        {() => <Splash key="splash" />}
      </Static>
      <Header />
      <LogView />
      <JobsPanel />
      <Box marginTop={1}>
        <Prompt />
      </Box>
    </Box>
  );
}
