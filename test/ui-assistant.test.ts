/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * ui-assistant.test.ts: Tests for the webUI Assistant routes (Homebridge AI Kit) and the client-side guards on what the Assistant may see.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface ChatRequest {

  messages: { content: unknown; role: string }[];
  system?: string;
}

type Handler = (body: unknown) => unknown;

interface FakeServer {

  homebridgeConfigPath?: string | undefined;
  onRequest: (path: string, fn: Handler) => void;
  pushEvent: (event: string, data: unknown) => void;
}

interface AssistantModule {

  ASSISTANT_PLUGIN_NAME: string;
  UNIFI_PROTECT_AI_CONTEXT: string;
  registerAssistant: (server: FakeServer, options?: Record<string, unknown>) => void;
}

interface ClientModule {

  assistantController: (controller: unknown) => Record<string, unknown>;
  assistantDevice: (device: unknown) => Record<string, unknown>;
  deviceProblem: (device: unknown) => string | null;
  scrubText: (text: unknown, addresses?: unknown[]) => string;
}

// The webUI modules are plain JavaScript without type declarations. Importing them through a variable specifier keeps the test typecheck from demanding
// declarations while vitest still resolves them relative to this file.
const ASSISTANT_MODULE = '../homebridge-ui/assistant.js';
const CLIENT_MODULE = '../homebridge-ui/public/modules/assistant.js';

let server: AssistantModule;
let client: ClientModule;

beforeAll(async () => {

  server = await import(ASSISTANT_MODULE) as AssistantModule;
  client = await import(CLIENT_MODULE) as ClientModule;
});

const usage = { inputTokens: 10, outputTokens: 5 };

// Provider stand-in: no network, replies with `reply` (streamed in two chunks).
function fakeProvider(reply: string): { provider: Record<string, unknown>; requests: ChatRequest[] } {

  const requests: ChatRequest[] = [];
  const result = (text: string): Record<string, unknown> =>
    ({ message: { content: text, role: 'assistant' }, model: 'fake-model', stopReason: 'end', text, toolCalls: [], usage });

  const provider = {

    capabilities: { contextTokens: 100_000, jsonMode: false, streaming: true, tools: false },
    chat: async (request: ChatRequest): Promise<Record<string, unknown>> => {

      requests.push(request);

      return result(reply);
    },
    model: 'fake-model',
    name: 'anthropic',
    stream: async function *(request: ChatRequest): AsyncGenerator<Record<string, unknown>> {

      requests.push(request);

      const half = Math.ceil(reply.length / 2);

      yield { delta: reply.slice(0, half), type: 'text' };
      yield { delta: reply.slice(half), type: 'text' };
      yield { result: result(reply), stopReason: 'end', type: 'done', usage };
    },
  };

  return { provider, requests };
}

function fakeServer(homebridgeConfigPath?: string): { call: (path: string, body?: unknown) => Promise<unknown>; events: [string, unknown][];
  handlers: Map<string, Handler>; server: FakeServer; } {

  const handlers = new Map<string, Handler>();
  const events: [string, unknown][] = [];
  const fake: FakeServer = {

    homebridgeConfigPath,
    onRequest: (path, fn) => handlers.set(path, fn),
    pushEvent: (event, data) => events.push([ event, data ]),
  };

  const call = async (path: string, body: unknown = {}): Promise<unknown> => {

    const handler = handlers.get(path);

    if(!handler) {

      throw new Error('No handler for ' + path);
    }

    return handler(body);
  };

  return { call, events, handlers, server: fake };
}

async function writeConfig(platforms: unknown[]): Promise<string> {

  const dir = await mkdtemp(join(tmpdir(), 'unifi-protect-assistant-'));
  const path = join(dir, 'config.json');

  await writeFile(path, JSON.stringify({ bridge: { name: 'Homebridge' }, platforms }));

  return path;
}

describe('webUI Assistant routes', () => {

  it('registers the four Assistant routes', () => {

    const ui = fakeServer();

    server.registerAssistant(ui.server, { loadConfig: async () => null });

    expect([...ui.handlers.keys()].sort()).toEqual([ '/ai/ask', '/ai/config', '/ai/explain', '/ai/status' ]);
  });

  it('reports the Assistant as off when the AI Kit block is missing', async () => {

    const ui = fakeServer(await writeConfig([{ controllers: [{ address: '192.168.1.1', password: 'p', username: 'u' }], platform: 'UniFi Protect' }]));

    server.registerAssistant(ui.server);

    expect(await ui.call('/ai/status')).toEqual({ capabilities: null, enabled: false, model: null, provider: null });
    await expect(ui.call('/ai/explain', { error: 'x' })).rejects.toThrow('The Assistant is not set up');
  });

  it('reads the shared HomebridgeAiKit block and never returns its key', async () => {

    const ui = fakeServer(await writeConfig([
      { controllers: [], platform: 'UniFi Protect' },
      { apiKey: 'sk-ant-secret-key', platform: 'HomebridgeAiKit', provider: 'anthropic' },
    ]));

    server.registerAssistant(ui.server);

    const status = await ui.call('/ai/status');

    expect(status).toMatchObject({ enabled: true, provider: 'anthropic' });
    expect(JSON.stringify(status)).not.toContain('sk-ant-secret-key');
  });

  it('explains a device error with the UniFi Protect context and streams it', async () => {

    const { provider, requests } = fakeProvider('Check the PoE switch.');
    const ui = fakeServer();

    server.registerAssistant(ui.server, {

      createProvider: () => provider,
      loadConfig: async () => ({ enabled: true, model: 'fake-model', provider: 'anthropic' }),
    });

    const result = await ui.call('/ai/explain', {

      context: 'The user is looking at the feature options of a UniFi Protect device in the plugin webUI.',
      device: { marketName: 'G4 Doorbell Pro', modelKey: 'camera', name: 'Front Door', state: 'DISCONNECTED' },
      error: 'UniFi Protect reports this camera as disconnected (not connected).',
      requestId: 'r1',
    });

    expect(result).toEqual({ text: 'Check the PoE switch.', usage });
    expect(ui.events).toEqual([
      [ 'ai:chunk', { delta: 'Check the P', requestId: 'r1' } ],
      [ 'ai:chunk', { delta: 'oE switch.', requestId: 'r1' } ],
      [ 'ai:done', { requestId: 'r1' } ],
    ]);
    expect(requests[0]?.system).toContain(server.ASSISTANT_PLUGIN_NAME);
    expect(requests[0]?.system).toContain(server.UNIFI_PROTECT_AI_CONTEXT);
    expect(JSON.stringify(requests[0]?.messages)).toContain('G4 Doorbell Pro');
  });

  it('describes logins, error messages, TLS pinning, ONVIF and streaming in its context', () => {

    expect(server.ASSISTANT_PLUGIN_NAME).toBe('@mp-consulting/homebridge-unifi-protect');

    for(const fact of [ 'local', 'Full Management', '401', '403', 'Invalid login credentials given', 'Insufficient privileges', 'Connection refused',
      'Timed out after 20s', 'unifi-protect-tls-pins.json', 'verifyTls', '10001', 'ONVIF', '/onvif/device_service', 'videoProcessor' ]) {

      expect(server.UNIFI_PROTECT_AI_CONTEXT).toContain(fact);
    }
  });
});

describe('webUI Assistant data guards', () => {

  const camera = {

    connectionType: 'wired',
    firmwareVersion: '4.69.55',
    host: '10.0.0.42',
    id: 'camera-id-secret',
    isAdopted: true,
    isRebooting: false,
    isThirdPartyCamera: false,
    isUpdating: false,
    mac: 'AABBCCDDEEFF',
    marketName: 'G4 Doorbell Pro',
    modelKey: 'camera',
    name: 'Front Door',
    state: 'DISCONNECTED',
    type: 'UVC G4 Doorbell Pro',
  };

  it('scrubs the given address, IP and MAC addresses from error text', () => {

    const text = 'No reachable ONVIF service on cam.local/onvif/device_service (port 80: connect ECONNREFUSED 10.0.0.42:80, aa:bb:cc:dd:ee:ff).';

    expect(client.scrubText(text, [ 'cam.local', '', undefined ])).toBe(
      'No reachable ONVIF service on [address]/onvif/device_service (port 80: connect ECONNREFUSED [IP address]:80, [MAC address]).');
    expect(client.scrubText(undefined)).toBe('');
  });

  it('shares only whitelisted device facts', () => {

    const shared = client.assistantDevice(camera);

    expect(shared).toEqual({
      adopted: true,
      connectionType: 'wired',
      firmware: '4.69.55',
      marketName: 'G4 Doorbell Pro',
      modelKey: 'camera',
      name: 'Front Door',
      rebooting: false,
      state: 'DISCONNECTED',
      thirdPartyCamera: false,
      type: 'UVC G4 Doorbell Pro',
      updating: false,
    });

    const json = JSON.stringify(shared);

    for(const secret of [ '10.0.0.42', 'AABBCCDDEEFF', 'camera-id-secret' ]) {

      expect(json).not.toContain(secret);
    }
  });

  it('never shares controller credentials or addresses', () => {

    const shared = client.assistantController({ address: '10.0.0.1', name: 'UNVR', password: 'hunter2', username: 'admin', verifyTls: true });

    expect(shared).toEqual({ name: 'UNVR', verifyTls: true });
    expect(JSON.stringify(shared)).not.toMatch(/10\.0\.0\.1|hunter2|admin/);
  });

  it('reports devices that are not connected or updating, never the NVR or stateless devices', () => {

    expect(client.deviceProblem(camera)).toContain('disconnected');
    expect(client.deviceProblem({ ...camera, isUpdating: true })).toContain('updating');
    expect(client.deviceProblem({ ...camera, state: 'CONNECTED' })).toBeNull();
    expect(client.deviceProblem({ modelKey: 'nvr', state: 'DISCONNECTED' })).toBeNull();
    expect(client.deviceProblem({ modelKey: 'sensor' })).toBeNull();
    expect(client.deviceProblem(undefined)).toBeNull();
  });
});
