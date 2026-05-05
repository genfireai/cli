import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { useTuiStore } from '../store.js';
import { dispatchSlash, listSlash, parseSlashLine, suggestSlash } from '../slash/registry.js';
import { palette } from '../colors.js';
import { pickerCandidateCount, pickerSelectedHandle } from './InfluencerPicker.js';

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

  /**
   * Recompute the influencer-picker state from the latest draft. Picker opens
   * when there is an unterminated `@<handle>` immediately before the cursor
   * (cursor is always at end of draft). Closes when there's no active mention.
   */
  const refreshPicker = useCallback((latestDraft: string) => {
    const store = useTuiStore.getState();
    // Walk backwards from the end until whitespace, `@`, or start of string.
    let i = latestDraft.length;
    while (i > 0 && !/[\s]/.test(latestDraft[i - 1])) i--;
    const segment = latestDraft.slice(i);
    if (segment.startsWith('@')) {
      const query = segment.slice(1);
      // Only valid handle characters keep the picker open.
      if (/^[a-zA-Z0-9_-]*$/.test(query)) {
        const candidateCount = pickerCandidateCount();
        const selectedIndex = store.picker.open ? Math.min(store.picker.selectedIndex, Math.max(0, candidateCount - 1)) : 0;
        store.setPicker({
          open: true,
          atStart: i,
          query,
          selectedIndex
        });
        return;
      }
    }
    if (store.picker.open) store.closePicker();
  }, []);

  useInput((input, key) => {
    // Ctrl+C: pop the picker first, then clear the input, then exit.
    if (key.ctrl && input === 'c') {
      const store = useTuiStore.getState();
      if (store.picker.open) {
        store.closePicker();
        return;
      }
      if (draft.length > 0) {
        replaceDraft('');
        return;
      }
      store.requestExit();
      return;
    }

    if (busy) return;

    const store = useTuiStore.getState();
    const pickerOpen = store.picker.open;

    if (key.escape) {
      if (pickerOpen) {
        store.closePicker();
      }
      return;
    }

    if (key.return) {
      if (pickerOpen) {
        const handle = pickerSelectedHandle();
        if (handle) {
          // Replace the in-progress @<query> with @<handle> + space
          const before = draft.slice(0, store.picker.atStart);
          replaceDraft(before + '@' + handle + ' ');
        }
        store.closePicker();
        return;
      }
      void submitDraft();
      return;
    }

    if (key.tab) {
      if (pickerOpen) {
        // Tab also accepts the selected handle (matches dashboard convention).
        const handle = pickerSelectedHandle();
        if (handle) {
          const before = draft.slice(0, store.picker.atStart);
          replaceDraft(before + '@' + handle + ' ');
        }
        store.closePicker();
        return;
      }
      if (draft.startsWith('/')) {
        const matches = suggestSlash(draft);
        if (matches.length === 1) {
          replaceDraft('/' + matches[0] + ' ');
        } else if (matches.length > 1) {
          store.appendLog({ kind: 'info', text: matches.map((m) => '/' + m).join('  ') });
        }
      }
      return;
    }

    if (key.upArrow) {
      if (pickerOpen) {
        const next = Math.max(0, store.picker.selectedIndex - 1);
        store.setPicker({ selectedIndex: next });
        return;
      }
      if (history.length === 0) return;
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      replaceDraft(history[next]);
      return;
    }

    if (key.downArrow) {
      if (pickerOpen) {
        const max = Math.max(0, pickerCandidateCount() - 1);
        const next = Math.min(max, store.picker.selectedIndex + 1);
        store.setPicker({ selectedIndex: next });
        return;
      }
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
      const next = draft.slice(0, -1);
      replaceDraft(next);
      refreshPicker(next);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const next = draft + input;
      replaceDraft(next);
      refreshPicker(next);
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
