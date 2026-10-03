/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * ui-server.test.ts: Tests for the webUI server's network guards (address validation, snapshot proxy) and the ONVIF credential host-match rule.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';

type LookupEntry = { address: string; family: number };
type Lookup = (hostname: string, options: unknown) => Promise<LookupEntry[]>;
type GuardOptions = { isBlocked?: (ip: string) => boolean; lookup?: Lookup };
type SnapshotOptions = GuardOptions & { expectedHost?: string; maxBytes?: number; timeout?: number };

interface ServerModule {

  PluginUiServer: new () => unknown;
  canonicalHostname: (address: unknown) => string | null;
  fetchSnapshot: (url: unknown, options?: SnapshotOptions) => Promise<{ contentType: string; data: string }>;
  isBlockedIp: (ip: string) => boolean;
  isValidAddress: (address: unknown, options?: GuardOptions) => Promise<boolean>;
  resolveAllowedAddress: (address: unknown, options?: GuardOptions) => Promise<{ address: string; family: number; hostname: string }>;
}

interface OnvifModule {

  injectCredentials: (uri: string | null, username: string, password: string, host: string) => { credentialsWithheld: boolean; url: string | null };
  resolveMediaServiceUrl: (xAddr: string, host: string, port: number) => { rewritten: boolean; url: string };
  urlMatchesHost: (uri: string, host: string) => boolean;
}

// The webUI server and ONVIF helpers are plain JavaScript without type declarations. Importing them through a variable specifier keeps the test typecheck
// from demanding declarations while vitest still resolves them relative to this file.
const SERVER_MODULE = '../homebridge-ui/server.js';
const ONVIF_MODULE = '../homebridge-ui/onvif.js';

let server: ServerModule;
let onvif: OnvifModule;

// A lookup that answers every name with fixed addresses, standing in for DNS.
const fakeLookup = (...addresses: string[]): Lookup => vi.fn(async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));

beforeAll(async () => {

  server = await import(SERVER_MODULE) as ServerModule;
  onvif = await import(ONVIF_MODULE) as OnvifModule;
});

describe('address validation', () => {

  it.each([
    '127.0.0.1', '127.1.2.3', '0x7f.1', '2130706433', '017700000001', '0x7f000001', 'localhost', 'localhost.', 'LOCALHOST', '::1', '[::1]', '0.0.0.0', '::',
    '::ffff:127.0.0.1', '[::ffff:7f00:1]', '169.254.169.254', '169.254.1.1', 'fe80::1', '127.0.0.1:443',
  ])('rejects loopback, link-local, and unspecified address %s', async (address) => {

    expect(await server.isValidAddress(address)).toBe(false);
  });

  it.each([ '10.0.0.5', '172.16.4.2', '192.168.1.1', '192.168.1.1:7443', '100.64.0.1', '8.8.8.8' ])('allows LAN and routable address %s', async (address) => {

    expect(await server.isValidAddress(address)).toBe(true);
  });

  it.each([ undefined, null, '', '   ', 42, 'http://[bad' ])('rejects unusable input %s', async (address) => {

    expect(await server.isValidAddress(address)).toBe(false);
  });

  it('rejects a DNS name that resolves to loopback', async () => {

    const lookup = fakeLookup('127.0.0.1');

    expect(await server.isValidAddress('nvr.example.com', { lookup })).toBe(false);
    expect(lookup).toHaveBeenCalledWith('nvr.example.com', expect.objectContaining({ all: true }));
  });

  it('rejects a DNS name if any of its addresses is blocked', async () => {

    expect(await server.isValidAddress('nvr.example.com', { lookup: fakeLookup('192.168.1.10', '::1') })).toBe(false);
    expect(await server.isValidAddress('nvr.example.com', { lookup: fakeLookup('192.168.1.10', '::ffff:169.254.169.254') })).toBe(false);
  });

  it('accepts a DNS name that resolves only to LAN addresses and returns the vetted address', async () => {

    await expect(server.resolveAllowedAddress('NVR.example.com:7443', { lookup: fakeLookup('192.168.1.10', 'fd00::10') }))
      .resolves.toEqual({ address: '192.168.1.10', family: 4, hostname: 'nvr.example.com' });
  });

  it('uses the system resolver by default', async () => {

    const spy = vi.spyOn(dnsPromises, 'lookup').mockResolvedValue([{ address: '192.168.1.10', family: 4 }] as never);

    try {

      // A name that doesn't exist only validates if our stubbed resolver is the one being consulted.
      expect(await server.isValidAddress('nvr.invalid')).toBe(true);

      spy.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
      expect(await server.isValidAddress('nvr.invalid')).toBe(false);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {

      spy.mockRestore();
    }
  });

  it('unwraps IPv4-mapped IPv6 addresses before checking them', () => {

    expect(server.isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(server.isBlockedIp('::ffff:7f00:1')).toBe(true);
    expect(server.isBlockedIp('::ffff:192.168.1.1')).toBe(false);
    expect(server.isBlockedIp('fe80::1%en0')).toBe(true);
    expect(server.isBlockedIp('not-an-ip')).toBe(true);
  });

  it('canonicalizes alternate IPv4 spellings', () => {

    expect(server.canonicalHostname('0x7f.1')).toBe('127.0.0.1');
    expect(server.canonicalHostname('2130706433')).toBe('127.0.0.1');
    expect(server.canonicalHostname('[fe80::1]:80')).toBe('fe80::1');
  });
});

describe('fetchSnapshot', () => {

  let httpServer: Server;
  let port: number;
  let lastHeaders: IncomingHttpHeaders | undefined;
  let hits: number;
  let respond: (res: ServerResponse) => void;

  // Our test camera listens on loopback, which the guard rightly refuses. These options pretend "camera.test" resolves to it and lift the block so we can
  // exercise the response handling - and, because camera.test doesn't really resolve, they also prove the connection is pinned to the vetted address.
  const viaFakeCamera = (extra: SnapshotOptions = {}): SnapshotOptions => ({ isBlocked: () => false, lookup: fakeLookup('127.0.0.1'), ...extra });

  beforeAll(async () => {

    httpServer = http.createServer((req, res) => {

      hits++;
      lastHeaders = req.headers;
      respond(res);
    });

    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {

    await new Promise(resolve => httpServer.close(resolve));
  });

  beforeEach(() => {

    hits = 0;
    lastHeaders = undefined;
    respond = (res) => res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.from([ 0xFF, 0xD8, 0xFF ]));
  });

  it('returns the image as base64', async () => {

    await expect(server.fetchSnapshot('http://camera.test:' + port + '/snap.jpg', viaFakeCamera()))
      .resolves.toEqual({ contentType: 'image/jpeg', data: Buffer.from([ 0xFF, 0xD8, 0xFF ]).toString('base64') });
  });

  it.each([ 'http://127.0.0.1:{port}/', 'http://localhost:{port}/', 'http://0x7f.1:{port}/', 'http://[::1]:{port}/', 'http://169.254.169.254/latest/meta-data' ])(
    'refuses blocked host %s without connecting', async (template) => {

      await expect(server.fetchSnapshot(template.replace('{port}', String(port)))).rejects.toThrow(/not permitted/);
      expect(hits).toBe(0);
    });

  it('refuses a name that resolves to loopback', async () => {

    await expect(server.fetchSnapshot('http://camera.test:' + port + '/', { lookup: fakeLookup('127.0.0.1') })).rejects.toThrow(/not permitted/);
    expect(hits).toBe(0);
  });

  it.each([ 'file:///etc/passwd', 'ftp://192.168.1.10/snap.jpg', 'gopher://192.168.1.10/' ])('refuses non-http(s) URL %s', async (url) => {

    await expect(server.fetchSnapshot(url)).rejects.toThrow(/Only http\(s\)/);
  });

  it('rejects a missing URL', async () => {

    await expect(server.fetchSnapshot(undefined)).rejects.toThrow(/url is required/);
  });

  it('rejects responses that are not images', async () => {

    respond = (res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>secret admin page</html>');

    await expect(server.fetchSnapshot('http://camera.test:' + port + '/', viaFakeCamera())).rejects.toThrow(/did not return an image/);
  });

  it('rejects responses without a content type', async () => {

    respond = (res) => {

      res.removeHeader('Content-Type');
      res.writeHead(200).end('data');
    };

    await expect(server.fetchSnapshot('http://camera.test:' + port + '/', viaFakeCamera())).rejects.toThrow(/did not return an image/);
  });

  it('aborts oversized bodies announced by content-length', async () => {

    respond = (res) => res.writeHead(200, { 'Content-Length': '4096', 'Content-Type': 'image/jpeg' }).end(Buffer.alloc(4096));

    await expect(server.fetchSnapshot('http://camera.test:' + port + '/', viaFakeCamera({ maxBytes: 1024 }))).rejects.toThrow(/exceeded/);
  });

  it('aborts oversized streamed bodies', async () => {

    respond = (res) => {

      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.write(Buffer.alloc(800));
      setTimeout(() => res.end(Buffer.alloc(800)), 20);
    };

    await expect(server.fetchSnapshot('http://camera.test:' + port + '/', viaFakeCamera({ maxBytes: 1024 }))).rejects.toThrow(/exceeded/);
  });

  it('surfaces non-200 status codes', async () => {

    respond = (res) => res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="cam"' }).end();

    await expect(server.fetchSnapshot('http://camera.test:' + port + '/', viaFakeCamera())).rejects.toThrow(/HTTP 401/);
  });

  it('forwards embedded credentials as Basic auth only to the expected host', async () => {

    const url = 'http://admin:p%40ss@camera.test:' + port + '/snap.jpg';

    await server.fetchSnapshot(url, viaFakeCamera({ expectedHost: 'CAMERA.test' }));
    expect(lastHeaders?.authorization).toBe('Basic ' + Buffer.from('admin:p@ss').toString('base64'));

    await server.fetchSnapshot(url, viaFakeCamera({ expectedHost: '192.168.1.50' }));
    expect(lastHeaders?.authorization).toBeUndefined();

    await server.fetchSnapshot(url, viaFakeCamera());
    expect(lastHeaders?.authorization).toBe('Basic ' + Buffer.from('admin:p@ss').toString('base64'));
  });
});

describe('PluginUiServer request isolation', () => {

  type Handler = (payload: unknown) => Promise<unknown>;

  let originalSend: typeof process.send;
  let priorMessageListeners: ((...args: unknown[]) => void)[];

  beforeEach(() => {

    priorMessageListeners = process.listeners('message') as ((...args: unknown[]) => void)[];
    originalSend = process.send;

    // Swallow the UI server's own IPC traffic while forwarding vitest's worker messages untouched.
    process.send = ((message: { action?: string }, ...args: unknown[]): boolean => {

      if([ 'ready', 'response' ].includes(message?.action ?? '')) {

        return true;
      }

      return originalSend ? (originalSend as (...sendArgs: unknown[]) => boolean).call(process, message, ...args) : true;
    }) as NonNullable<typeof process.send>;
  });

  afterEach(() => {

    if(originalSend) {

      process.send = originalSend;
    } else {

      delete process.send;
    }

    for(const listener of process.listeners('message')) {

      if(!priorMessageListeners.includes(listener as (...args: unknown[]) => void)) {

        process.removeListener('message', listener as (...args: unknown[]) => void);
      }
    }
  });

  const handlerFor = (instance: unknown, path: string): Handler => (instance as { handlers: Map<string, Handler> }).handlers.get(path) as Handler;

  it('does not start a server merely by being imported', () => {

    expect(typeof server.PluginUiServer).toBe('function');
  });

  it('keeps concurrent /getDevices errors separate per requestId', async () => {

    const instance = new server.PluginUiServer();
    const getDevices = handlerFor(instance, '/getDevices');
    const getErrorMessage = handlerFor(instance, '/getErrorMessage');

    const [ first, second ] = await Promise.all([

      getDevices({ address: '127.0.0.1', password: 'x', requestId: 'a', username: 'x' }),
      getDevices({ address: '0.0.0.0', password: 'x', requestId: 'b', username: 'x' }),
    ]);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(await getErrorMessage({ requestId: 'a' })).toMatch(/127\.0\.0\.1/);
    expect(await getErrorMessage({ requestId: 'b' })).toMatch(/0\.0\.0\.0/);

    // Messages are handed out once.
    expect(await getErrorMessage({ requestId: 'a' })).toBe('');

    // Callers without a requestId still get the most recent error.
    expect(await getErrorMessage({})).toMatch(/not permitted/);
  });

  it('reports blocked controllers as offline in /checkStatus', async () => {

    const instance = new server.PluginUiServer();

    expect(await handlerFor(instance, '/checkStatus')({ address: '0x7f.1' })).toEqual({ online: false });
  });
});

describe('ONVIF credential host matching', () => {

  it('injects credentials into URLs on the host the user entered', () => {

    expect(onvif.injectCredentials('rtsp://192.168.1.50:554/stream1', 'admin', 'p@ss', '192.168.1.50'))
      .toEqual({ credentialsWithheld: false, url: 'rtsp://admin:p%40ss@192.168.1.50:554/stream1' });
  });

  it('matches hostnames case-insensitively and ignores port differences', () => {

    expect(onvif.urlMatchesHost('http://Camera.LAN:8080/snap.jpg', 'camera.lan')).toBe(true);
    expect(onvif.urlMatchesHost('http://[FE80::1]:80/', 'fe80::1')).toBe(true);
    expect(onvif.urlMatchesHost('http://192.168.1.50.evil.com/', '192.168.1.50')).toBe(false);
  });

  it('withholds credentials from URLs on a different host', () => {

    expect(onvif.injectCredentials('http://attacker.example.com/snap.jpg', 'admin', 'secret', '192.168.1.50'))
      .toEqual({ credentialsWithheld: true, url: 'http://attacker.example.com/snap.jpg' });
  });

  it('strips credentials a camera embedded into a foreign URL', () => {

    expect(onvif.injectCredentials('http://u:p@10.0.0.9/snap.jpg', 'admin', 'secret', '192.168.1.50').url).toBe('http://10.0.0.9/snap.jpg');
  });

  it('passes through empty and unparseable URLs', () => {

    expect(onvif.injectCredentials(null, 'admin', 'secret', '192.168.1.50').url).toBeNull();
    expect(onvif.injectCredentials('not a url', 'admin', 'secret', '192.168.1.50').url).toBe('not a url');
  });

  it('follows a media XAddr on the same host and rewrites a foreign one onto the user host', () => {

    expect(onvif.resolveMediaServiceUrl('http://192.168.1.50:2020/onvif/media', '192.168.1.50', 2020))
      .toEqual({ rewritten: false, url: 'http://192.168.1.50:2020/onvif/media' });
    expect(onvif.resolveMediaServiceUrl('http://attacker.example.com:80/onvif/media?x=1', '192.168.1.50', 2020))
      .toEqual({ rewritten: true, url: 'http://192.168.1.50:2020/onvif/media?x=1' });
  });
});
