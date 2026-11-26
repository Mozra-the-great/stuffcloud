import { describe, expect, it } from 'vitest';
import { isProgress, isReply, isRunRequest, progressFraction } from '../src/worker-protocol.ts';

/** Everything a worker could send for a number that is not a usable one. */
const NOT_A_NUMBER: readonly unknown[] = [
  undefined,
  null,
  '1',
  '',
  true,
  [],
  {},
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

describe('isProgress', () => {
  it('accepts every point from nothing done to everything done', () => {
    expect(isProgress({ completed: 0, total: 1 })).toBe(true);
    expect(isProgress({ completed: 1, total: 1 })).toBe(true);
    expect(isProgress({ completed: 0.5, total: 1 })).toBe(true);
    expect(isProgress({ completed: 3, total: 7.5 })).toBe(true);
  });

  it('is exact at both ends of the range', () => {
    expect(isProgress({ completed: 0, total: Number.MIN_VALUE })).toBe(true);
    expect(isProgress({ completed: Number.MIN_VALUE, total: Number.MIN_VALUE })).toBe(true);
    expect(isProgress({ completed: -Number.MIN_VALUE, total: 1 })).toBe(false);
    expect(isProgress({ completed: 1 + Number.EPSILON, total: 1 })).toBe(false);
    expect(isProgress({ completed: 0, total: 0 })).toBe(false);
    expect(isProgress({ completed: 0, total: -1 })).toBe(false);
    expect(isProgress({ completed: -1, total: -1 })).toBe(false);
  });

  it.each(NOT_A_NUMBER)('refuses %j as the completed count', (value) => {
    expect(isProgress({ completed: value, total: 1 })).toBe(false);
  });

  it.each(NOT_A_NUMBER)('refuses %j as the total', (value) => {
    expect(isProgress({ completed: 0, total: value })).toBe(false);
  });

  it('refuses infinite counts even when they are in order', () => {
    expect(
      isProgress({ completed: Number.POSITIVE_INFINITY, total: Number.POSITIVE_INFINITY }),
    ).toBe(false);
    expect(isProgress({ completed: 1, total: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it('needs both fields', () => {
    expect(isProgress({ completed: 0 })).toBe(false);
    expect(isProgress({ total: 1 })).toBe(false);
    expect(isProgress({})).toBe(false);
  });

  it.each([null, undefined, 3, 'progress', true, Symbol('p')])(
    'refuses the non-object %j',
    (value) => {
      expect(isProgress(value)).toBe(false);
    },
  );

  it('is the fraction of the work done', () => {
    expect(progressFraction({ completed: 1, total: 4 })).toBe(0.25);
    expect(progressFraction({ completed: 0, total: 4 })).toBe(0);
  });
});

describe('isReply', () => {
  const progress = { completed: 1, total: 2 };
  const kinds: readonly (readonly [string, Record<string, unknown>])[] = [
    ['progress', { progress }],
    ['result', { output: 'done' }],
    ['error', { message: 'it broke' }],
  ];

  it.each(kinds)('accepts a %s reply with any safe id', (type, body) => {
    for (const id of [0, 1, 41, Number.MAX_SAFE_INTEGER]) {
      expect(isReply({ type, id, ...body })).toBe(true);
    }
  });

  it.each(kinds)('refuses a %s reply whose id is not a non-negative safe integer', (type, body) => {
    for (const id of [
      -1,
      -0.5,
      0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      2 ** 53,
      '1',
      '',
      null,
      undefined,
      [],
      {},
      true,
    ]) {
      expect(isReply({ type, id, ...body })).toBe(false);
    }
    expect(isReply({ type, ...body })).toBe(false);
  });

  it('refuses a progress reply with a bad progress', () => {
    expect(isReply({ type: 'progress', id: 0 })).toBe(false);
    expect(isReply({ type: 'progress', id: 0, progress: null })).toBe(false);
    expect(isReply({ type: 'progress', id: 0, progress: { completed: 2, total: 1 } })).toBe(false);
    expect(isReply({ type: 'progress', id: 0, progress: { completed: '1', total: 2 } })).toBe(
      false,
    );
  });

  it('needs an output field in a result, whatever it holds', () => {
    expect(isReply({ type: 'result', id: 0 })).toBe(false);
    expect(isReply({ type: 'result', id: 0, output: undefined })).toBe(true);
    expect(isReply({ type: 'result', id: 0, output: null })).toBe(true);
  });

  it('needs a string message in an error, which may be empty', () => {
    expect(isReply({ type: 'error', id: 0, message: '' })).toBe(true);
    expect(isReply({ type: 'error', id: 0 })).toBe(false);
    expect(isReply({ type: 'error', id: 0, message: 5 })).toBe(false);
    expect(isReply({ type: 'error', id: 0, message: null })).toBe(false);
  });

  it('refuses a type it does not know, with false and not just something falsy', () => {
    expect(isReply({ type: 'cancel', id: 0 })).toBe(false);
    expect(isReply({ type: 'run', id: 0, input: 1 })).toBe(false);
    expect(isReply({ id: 0 })).toBe(false);
    expect(isReply({ type: 3, id: 0 })).toBe(false);
  });

  it.each([null, undefined, 3, 'result', true, []])('refuses the non-record %j', (value) => {
    expect(isReply(value)).toBe(false);
  });
});

describe('isRunRequest', () => {
  it('needs the type run, a safe id and an input field', () => {
    expect(isRunRequest({ type: 'run', id: 0, input: 1 })).toBe(true);
    expect(isRunRequest({ type: 'run', id: Number.MAX_SAFE_INTEGER, input: null })).toBe(true);
    expect(isRunRequest({ type: 'run', id: 0, input: undefined })).toBe(true);
    expect(isRunRequest({ type: 'run', id: 0 })).toBe(false);
    expect(isRunRequest({ type: 'result', id: 0, input: 1 })).toBe(false);
    expect(isRunRequest({ id: 0, input: 1 })).toBe(false);
  });

  it('refuses an id that is not a non-negative safe integer', () => {
    for (const id of [-1, 0.5, Number.NaN, 2 ** 53, '0', null, undefined]) {
      expect(isRunRequest({ type: 'run', id, input: 1 })).toBe(false);
    }
    expect(isRunRequest({ type: 'run', input: 1 })).toBe(false);
  });

  it.each([null, undefined, 3, 'run', true, []])('refuses the non-record %j', (value) => {
    expect(isRunRequest(value)).toBe(false);
  });
});
