import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { parseMaxCredits, registerAgentCommand, waitSlices } from './agent.js';

test('a long --timeout becomes server waits of at most 300 s that add up to it', () => {
  for (const total of [1, 60, 300, 301, 900, 1000]) {
    const slices = waitSlices(total);
    assert.ok(slices.every((s) => s >= 1 && s <= 300), `${total}: ${slices}`);
    assert.equal(slices.reduce((a, b) => a + b, 0), total);
  }
  assert.ok(waitSlices(Number('nope')).length >= 1);
});

test('--max-credits is a non-negative number (the API clamps the top)', () => {
  assert.equal(parseMaxCredits(undefined), undefined);
  assert.equal(parseMaxCredits('40'), 40);
  assert.equal(parseMaxCredits('0'), 0);
  assert.throws(() => parseMaxCredits('-1'));
  assert.throws(() => parseMaxCredits('lots'));
});

test('genfire agent carries send, get, wait, approve, cancel and list', () => {
  const program = new Command();
  registerAgentCommand(program);
  const agent = program.commands.find((c) => c.name() === 'agent');
  assert.ok(agent);
  const names = agent!.commands.map((c) => c.name());
  for (const n of ['send', 'get', 'wait', 'approve', 'cancel', 'list']) assert.ok(names.includes(n), n);
});
