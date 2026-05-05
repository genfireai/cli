import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

export function isInteractiveTty(): boolean {
  return Boolean(
    process.stdout.isTTY &&
    process.stdin.isTTY &&
    !process.env.GENFIRE_NO_TUI &&
    !process.env.CI
  );
}

export async function launchTui(): Promise<void> {
  const instance = render(React.createElement(App));
  await instance.waitUntilExit();
}
