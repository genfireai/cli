import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { useTuiStore } from '../store.js';
import { dispatchSlash, listSlash, parseSlashLine, suggestSlash } from '../slash/registry.js';
import { palette } from '../colors.js';

export interface PromptProps {
  onSubmit?: (line: string) => void;
}

const HISTORY_LIMIT = 100;

export function Prompt({ onSubmit }: PromptProps): React.ReactElement {
  const { exit } = useApp();
  const busy = useTuiStore((s) => s.busy);
  const exitRequested = useTuiStore((s) => s.exitRequested);
  const draft = useTuiStore((s) => s.inputDraft);
  const setDraft = useTuiStore((s) => s.setInputDraft);

  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  React.useEffect(() => {
    if (exitRequested) exit();
  }, [exitRequested, exit]);

  const replaceDraft = useCallback((value: string) => {
    setDraft(value);
  }, [setDraft]);

  const submitDraft = useCallback(async () => {
    const line = draft.trim();
    if (!line) return;
    setHistory((prev) => {
      const next = [...prev, line];
      return next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next;
    });
    setHistoryIndex(null);
    setDraft('');
    onSubmit?.(line);

    const store = useTuiStore.getState();
    if (line.startsWith('/')) {
      const { name } = parseSlashLine(line);
      store.appendLog({ kind: 'command', text: `/${name}${line.slice(name.length + 1)}` });
      await dispatchSlash(line);
    } else {
      store.appendLog({ kind: 'command', text: line });
      store.appendLog({
        kind: 'info',
        text: 'Free-form prompts are coming in v0.3 (planner-driven workflow generation). For now, use a slash command — try /help.'
      });
    }
  }, [draft, onSubmit, setDraft]);

  useInput((input, key) => {
    // Ignore input while a command is running. Ctrl+C still works to abort
    // the whole TUI from a busy state via Ctrl+C twice.
    if (key.ctrl && input === 'c') {
      if (draft.length > 0) {
        replaceDraft('');
        return;
      }
      useTuiStore.getState().requestExit();
      return;
    }

    if (busy) return;

    if (key.return) {
      void submitDraft();
      return;
    }

    if (key.tab) {
      if (draft.startsWith('/')) {
        const matches = suggestSlash(draft);
        if (matches.length === 1) {
          replaceDraft('/' + matches[0] + ' ');
        } else if (matches.length > 1) {
          const store = useTuiStore.getState();
          store.appendLog({ kind: 'info', text: matches.map((m) => '/' + m).join('  ') });
        }
      }
      return;
    }

    if (key.upArrow) {
      if (history.length === 0) return;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      replaceDraft(history[next]);
      return;
    }

    if (key.downArrow) {
      if (historyIndex === null) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        replaceDraft('');
      } else {
        setHistoryIndex(next);
        replaceDraft(history[next]);
      }
      return;
    }

    if (key.backspace || key.delete) {
      replaceDraft(draft.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      replaceDraft(draft + input);
    }
  });

  const showSuggestion = !busy && draft.startsWith('/') && draft.length > 1;
  const suggestions = showSuggestion ? suggestSlash(draft) : [];
  const inlineHint = suggestions.length > 0 && suggestions[0] !== draft.slice(1)
    ? suggestions[0].slice(draft.length - 1)
    : '';

  return (
    <Box flexDirection="column">
      <Box>
        {busy ? (
          <>
            <Text color={palette.brand}>
              <Spinner type="dots" />
            </Text>
            <Text color={palette.muted}> working...</Text>
          </>
        ) : (
          <>
            <Text color={palette.accent}>› </Text>
            <Text color={palette.text}>{draft}</Text>
            {inlineHint && <Text color={palette.muted} dimColor>{inlineHint}</Text>}
            <Text color={palette.accent}>▌</Text>
          </>
        )}
      </Box>
      {showSuggestion && suggestions.length > 1 && (
        <Box>
          <Text color={palette.muted} dimColor>
            {'  '}
            {suggestions.slice(0, 8).map((s) => '/' + s).join('  ')}
            {suggestions.length > 8 ? `  +${suggestions.length - 8} more` : ''}
          </Text>
        </Box>
      )}
      {!busy && draft.length === 0 && (
        <Box>
          <Text color={palette.muted} dimColor>  /help · /login · /generate · /workflow · /quit · Tab to autocomplete · ↑↓ history</Text>
        </Box>
      )}
    </Box>
  );
}
