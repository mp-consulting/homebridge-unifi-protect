/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * lib-ui-server.test.ts: Tests for the Homebridge custom UI IPC server base class.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomebridgePluginUiServer, RequestError } from '../src/lib/ui-server.js';

type IpcMessage = { action: string; payload: Record<string, unknown> };
type UiServerInternals = { processRequest: (request: { action: string; body?: unknown; path: string; requestId: number }) => Promise<void> };

describe('HomebridgePluginUiServer', () => {

  let sent: IpcMessage[];
  let originalSend: typeof process.send;
  let priorMessageListeners: ((...args: unknown[]) => void)[];
  let requestId = 0;

  beforeEach(() => {

    sent = [];

    // Note which 'message' listeners exist before the test - vitest's worker pool has its own that must survive us.
    priorMessageListeners = process.listeners('message') as ((...args: unknown[]) => void)[];

    // The class only runs as a child process communicating over the Node IPC channel. Vitest's worker pool uses that same channel, so we interpose a wrapper
    // that captures the UI server's messages and forwards everything else untouched.
    originalSend = process.send;

    process.send = ((message: IpcMessage, ...args: unknown[]): boolean => {

      if((message as { action?: string })?.action && [ 'ready', 'response' ].includes((message as { action: string }).action)) {

        sent.push(message);

        return true;
      }

      return originalSend ? (originalSend as (...sendArgs: unknown[]) => boolean).call(process, message, ...args) : true;
    }) as typeof process.send;
  });

  afterEach(() => {

    process.send = originalSend;

    // Remove only the 'message' listeners the servers under test registered, leaving vitest's own IPC listeners untouched.
    for(const listener of process.listeners('message')) {

      if(!priorMessageListeners.includes(listener as (...args: unknown[]) => void)) {

        process.removeListener('message', listener as (...args: unknown[]) => void);
      }
    }
  });

  // Deliver an inbound request directly to the dispatcher and wait for the matching response.
  const roundTrip = async (server: HomebridgePluginUiServer, path: string, body?: unknown): Promise<IpcMessage> => {

    const id = ++requestId;

    await (server as unknown as UiServerInternals).processRequest({ action: 'request', body, path, requestId: id });

    const response = sent.find(message => (message.action === 'response') && (message.payload.requestId === id));

    expect(response).toBeDefined();

    return response as IpcMessage;
  };

  it('announces readiness over IPC', () => {

    const server = new HomebridgePluginUiServer();

    server.ready();

    expect(sent).toContainEqual({ action: 'ready', payload: { server: true } });
  });

  it('routes requests to registered handlers and returns their results', async () => {

    const server = new HomebridgePluginUiServer();

    server.onRequest('/hello', (payload: { name: string }) => ({ greeting: 'hello ' + payload.name }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await roundTrip(server, '/hello', { name: 'world' });

    logSpy.mockRestore();

    expect(response.payload.success).toBe(true);
    expect(response.payload.data).toEqual({ greeting: 'hello world' });
  });

  it('supports async handlers', async () => {

    const server = new HomebridgePluginUiServer();

    server.onRequest('/async', async () => {

      await new Promise(resolve => setTimeout(resolve, 10));

      return 42;
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await roundTrip(server, '/async');

    logSpy.mockRestore();

    expect(response.payload.success).toBe(true);
    expect(response.payload.data).toBe(42);
  });

  it('responds with a failure for unknown paths', async () => {

    const server = new HomebridgePluginUiServer();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await roundTrip(server, '/unknown');

    errorSpy.mockRestore();

    expect(response.payload.success).toBe(false);
    expect(response.payload.data).toMatchObject({ message: 'Not Found', path: '/unknown' });
  });

  it('maps handler exceptions to failure responses', async () => {

    const server = new HomebridgePluginUiServer();

    server.onRequest('/boom', () => {

      throw new Error('kaboom');
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await roundTrip(server, '/boom');

    logSpy.mockRestore();
    errorSpy.mockRestore();

    expect(response.payload.success).toBe(false);
    expect(response.payload.data).toMatchObject({ message: 'kaboom' });
  });

  it('passes RequestError payloads through to the UI', async () => {

    const server = new HomebridgePluginUiServer();

    server.onRequest('/typed-error', () => {

      throw new RequestError('bad input', { code: 'EBADINPUT' });
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await roundTrip(server, '/typed-error');

    logSpy.mockRestore();

    expect(response.payload.success).toBe(false);
    expect(response.payload.data).toMatchObject({ error: { code: 'EBADINPUT' }, message: 'bad input' });
  });

  it('returns Not Found for paths that collide with Object.prototype property names', async () => {

    const server = new HomebridgePluginUiServer();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await roundTrip(server, 'toString');

    errorSpy.mockRestore();

    expect(response.payload.success).toBe(false);
    expect(response.payload.data).toMatchObject({ message: 'Not Found', path: 'toString' });
  });
});
