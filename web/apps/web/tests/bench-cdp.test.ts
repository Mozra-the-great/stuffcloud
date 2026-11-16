import { describe, expect, it } from 'vitest';
import { CdpClient, evaluated, parseMetrics, stringField, type SocketLike } from '../bench/cdp.ts';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  reply(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  lastId(): number {
    const last = this.sent.at(-1);
    return (JSON.parse(last ?? '{}') as { id: number }).id;
  }
}

describe('CdpClient', () => {
  it('numbers calls, sends method and params, and resolves with the result', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const first = client.call('Page.enable');
    const second = client.call('Emulation.setCPUThrottlingRate', { rate: 6 });
    expect(socket.sent.map((text) => JSON.parse(text) as unknown)).toEqual([
      { id: 1, method: 'Page.enable', params: {} },
      { id: 2, method: 'Emulation.setCPUThrottlingRate', params: { rate: 6 } },
    ]);
    // answers may arrive in any order
    socket.reply({ id: 2, result: { b: 2 } });
    socket.reply({ id: 1, result: { a: 1 } });
    expect(await second).toEqual({ b: 2 });
    expect(await first).toEqual({ a: 1 });
  });

  it('adds the session id for calls inside a target', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const call = client.call('Runtime.enable', {}, 'S1');
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      id: 1,
      method: 'Runtime.enable',
      params: {},
      sessionId: 'S1',
    });
    socket.reply({ id: 1, result: {} });
    await call;
  });

  it('rejects with the browser message on a protocol error', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const call = client.call('Nope');
    socket.reply({ id: socket.lastId(), error: { code: -32601, message: 'not found' } });
    await expect(call).rejects.toThrow('not found');
  });

  it('rejects with a generic message when the error has no text', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const call = client.call('Nope');
    socket.reply({ id: socket.lastId(), error: {} });
    await expect(call).rejects.toThrow('DevTools error');
  });

  it('ignores events, unknown ids, malformed JSON and binary frames', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const call = client.call('X');
    socket.reply({ method: 'Page.loadEventFired', params: {} });
    socket.reply({ id: 99, result: {} });
    socket.reply([1, 2]);
    socket.reply('text');
    socket.onmessage?.({ data: '{not json' });
    socket.onmessage?.({ data: new ArrayBuffer(2) });
    socket.reply({ id: 1, result: 'ok' });
    expect(await call).toBe('ok');
  });

  it('answers each id only once', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const call = client.call('X');
    socket.reply({ id: 1, result: 'first' });
    socket.reply({ id: 1, result: 'second' });
    expect(await call).toBe('first');
  });

  it('rejects pending calls when the connection closes', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const call = client.call('X');
    socket.onclose?.();
    await expect(call).rejects.toThrow('DevTools connection closed');
  });

  it('closes the socket and rejects pending calls on close()', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const call = client.call('X');
    client.close();
    expect(socket.closed).toBe(true);
    await expect(call).rejects.toThrow('DevTools connection closed');
  });
});

describe('parseMetrics', () => {
  it('maps names to values and skips malformed items', () => {
    expect(
      parseMetrics({
        metrics: [
          { name: 'TaskDuration', value: 1.5 },
          { name: 'LayoutCount', value: 3 },
          { name: 'Broken' },
          { value: 1 },
          'x',
          null,
        ],
      }),
    ).toEqual({ TaskDuration: 1.5, LayoutCount: 3 });
  });

  it('throws when the answer has no metrics list', () => {
    expect(() => parseMetrics({})).toThrow('Performance.getMetrics returned no metrics');
    expect(() => parseMetrics(null)).toThrow('Performance.getMetrics returned no metrics');
    expect(() => parseMetrics({ metrics: 'no' })).toThrow(
      'Performance.getMetrics returned no metrics',
    );
  });
});

describe('stringField', () => {
  it('reads a string field and rejects everything else', () => {
    expect(stringField({ targetId: 'T' }, 'targetId')).toBe('T');
    expect(() => stringField({ targetId: 1 }, 'targetId')).toThrow(
      'DevTools answer has no string field "targetId"',
    );
    expect(() => stringField(undefined, 'targetId')).toThrow('no string field');
    expect(() => stringField([], 'targetId')).toThrow('no string field');
  });
});

describe('evaluated', () => {
  it('returns the value of a successful evaluation', () => {
    expect(evaluated({ result: { type: 'number', value: 4 } })).toBe(4);
    expect(evaluated({ result: { type: 'undefined' } })).toBeUndefined();
    expect(evaluated({ result: 'odd' })).toBeUndefined();
  });

  it('throws with the description of a page exception, else its text, else "unknown"', () => {
    expect(() =>
      evaluated({
        exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } },
      }),
    ).toThrow('page exception: Error: boom');
    expect(() => evaluated({ exceptionDetails: { text: 'Uncaught' } })).toThrow(
      'page exception: Uncaught',
    );
    expect(() => evaluated({ exceptionDetails: {} })).toThrow('page exception: unknown');
  });

  it('throws when there is no result object', () => {
    expect(() => evaluated(undefined)).toThrow('Runtime.evaluate returned nothing');
    expect(() => evaluated('x')).toThrow('Runtime.evaluate returned nothing');
  });
});
