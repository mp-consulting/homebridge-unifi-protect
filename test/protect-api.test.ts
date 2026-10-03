/* Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-api.test.ts: Integration tests for the UniFi Protect API client session handling, throttling, and TLS certificate pinning against a loopback
 * HTTPS server.
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROTECT_TLS_PIN_MISMATCH, ProtectApi } from '../src/unifi/index.js';
import type { AddressInfo } from 'node:net';
import { X509Certificate, createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { ProtectEventsChannel } from '../src/unifi/protect-api-events-channel.js';
import https from 'node:https';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const fixtures = join(import.meta.dirname, 'fixtures');
const cert = readFileSync(join(fixtures, 'tls-cert.pem'));
const key = readFileSync(join(fixtures, 'tls-key.pem'));
const certFingerprint = new X509Certificate(cert).fingerprint256;

// A request as seen by our loopback controller.
interface SeenRequest {

  body: string;
  headers: IncomingMessage['headers'];
  method: string;
  url: string;
}

type Handler = (request: SeenRequest, response: ServerResponse) => void;

// Create a silent logger with spies.
type LogFn = (message: string, ...parameters: unknown[]) => void;

function makeLog(): { debug: Mock<LogFn>, error: Mock<LogFn>, info: Mock<LogFn>, warn: Mock<LogFn> } {

  return { debug: vi.fn<LogFn>(), error: vi.fn<LogFn>(), info: vi.fn<LogFn>(), warn: vi.fn<LogFn>() };
}

// Accept a WebSocket upgrade by completing the RFC 6455 handshake.
function acceptUpgrade(request: IncomingMessage, socket: Duplex): void {

  const accept = createHash('sha1').update((request.headers['sec-websocket-key'] ?? '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
}

// Respond with a successful login.
function loginOk(response: ServerResponse): void {

  response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'TOKEN=session-cookie; path=/; HttpOnly', 'X-Updated-CSRF-Token': 'csrf-2' });
  response.end('{}');
}

describe('ProtectApi', () => {

  let address: string;
  let handler: Handler;
  let requests: SeenRequest[];
  let server: https.Server;
  let tlsConnections: number;

  beforeEach(async () => {

    requests = [];
    tlsConnections = 0;
    handler = (_request, response): void => {

      response.writeHead(404);
      response.end();
    };

    server = https.createServer({ cert, key }, (request, response) => {

      const chunks: Buffer[] = [];

      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {

        const seen = { body: Buffer.concat(chunks).toString(), headers: request.headers, method: request.method ?? '', url: request.url ?? '' };

        requests.push(seen);
        handler(seen, response);
      });
    });

    server.on('connection', () => tlsConnections++);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    address = '127.0.0.1:' + (server.address() as AddressInfo).port.toString();
  });

  afterEach(async () => {

    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('session', () => {

    it('acquires a CSRF token and retries when the initial login is rejected', async () => {

      let loginAttempts = 0;

      handler = (request, response): void => {

        if(request.url === '/api/auth/login') {

          // Reject the login unless a CSRF token was presented.
          if(!request.headers['x-csrf-token']) {

            loginAttempts++;
            response.writeHead(401);
            response.end();

            return;
          }

          loginAttempts++;
          loginOk(response);

          return;
        }

        if((request.url === '/') && (request.method === 'GET')) {

          response.writeHead(200, { 'X-CSRF-Token': 'csrf-1' });
          response.end('<html></html>');

          return;
        }

        response.writeHead(404);
        response.end();
      };

      const api = new ProtectApi(makeLog());
      const loginEvent = vi.fn();

      api.on('login', loginEvent);

      await expect(api.login(address, 'user', 'secret')).resolves.toBe(true);

      expect(loginAttempts).toBe(2);
      expect(loginEvent).toHaveBeenCalledWith(true);

      const logins = requests.filter(x => x.url === '/api/auth/login');

      expect(logins[0]?.headers['x-csrf-token']).toBeUndefined();
      expect(logins[1]?.headers['x-csrf-token']).toBe('csrf-1');
      expect(JSON.parse(logins[1]?.body ?? '')).toMatchObject({ password: 'secret', username: 'user' });

      api.reset();
    });

    it('fails the login when the controller never accepts the credentials', async () => {

      handler = (request, response): void => {

        response.writeHead(request.url === '/' ? 200 : 401, request.url === '/' ? { 'X-CSRF-Token': 'csrf-1' } : {});
        response.end();
      };

      const api = new ProtectApi(makeLog());

      await expect(api.login(address, 'user', 'wrong')).resolves.toBe(false);

      api.reset();
    });

    it('logs in again after a 401 response mid-session', async () => {

      let logins = 0;
      let rejectNext = false;

      handler = (request, response): void => {

        if(request.url === '/api/auth/login') {

          logins++;
          loginOk(response);

          return;
        }

        if(request.url.startsWith('/proxy/protect/api/ws/livestream')) {

          // Our session cookie and CSRF token must accompany every API request.
          expect(request.headers.cookie).toBe('TOKEN=session-cookie');
          expect(request.headers['x-csrf-token']).toBe('csrf-2');

          if(rejectNext) {

            rejectNext = false;
            response.writeHead(401);
            response.end();

            return;
          }

          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ url: 'wss://controller.local:7442/livestream' }));

          return;
        }

        response.writeHead(404);
        response.end();
      };

      const api = new ProtectApi(makeLog());

      await expect(api.login(address, 'user', 'secret')).resolves.toBe(true);
      expect(logins).toBe(1);

      // The session expires on the controller side.
      rejectNext = true;
      await expect(api.getWsEndpoint('livestream')).resolves.toBeNull();

      // The next call transparently logs back in.
      await expect(api.getWsEndpoint('livestream')).resolves.not.toBeNull();
      expect(logins).toBe(2);

      api.reset();
    });
  });

  describe('throttling', () => {

    it('stops talking to the controller after repeated server errors', async () => {

      // Server errors on our test endpoint, and rejected logins everywhere else so we avoid the transparent retries of GET requests.
      handler = (request, response): void => {

        response.writeHead(request.url === '/fail' ? 500 : 401);
        response.end();
      };

      const api = new ProtectApi(makeLog());

      // The failed login attempt seeds our address and connection pool, and already counts against our error budget.
      await expect(api.login(address, 'user', 'secret')).resolves.toBe(false);
      expect(api.isThrottled).toBe(false);

      // POST requests aren't transparently retried, so each call is exactly one request. We should throttle well before twenty attempts.
      let attempts = 0;

      for(; !api.isThrottled && (attempts < 20); attempts++) {

        await expect(api.retrieve('https://' + address + '/fail', { method: 'POST' }, { logErrors: false })).resolves.toBeNull();
      }

      expect(api.isThrottled).toBe(true);
      expect(attempts).toBeLessThanOrEqual(10);

      const seen = requests.length;

      // While throttled, nothing reaches the controller.
      await expect(api.retrieve('https://' + address + '/fail', { method: 'POST' })).resolves.toBeNull();
      expect(requests.length).toBe(seen);

      api.reset();
    });
  });

  describe('TLS certificate pinning', () => {

    it('pins the controller certificate on first use', async () => {

      handler = (request, response): void => {

        if(request.url === '/api/auth/login') {

          loginOk(response);

          return;
        }

        response.writeHead(404);
        response.end();
      };

      const log = makeLog();
      const onFingerprint = vi.fn();
      const api = new ProtectApi(log, { onFingerprint });

      await expect(api.login(address, 'user', 'secret')).resolves.toBe(true);

      expect(onFingerprint).toHaveBeenCalledTimes(1);
      expect(onFingerprint).toHaveBeenCalledWith(certFingerprint);
      expect(api.tlsFingerprint).toBe(certFingerprint);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('pinning'), expect.anything(), certFingerprint);

      api.reset();
    });

    it('accepts a controller presenting the pinned certificate', async () => {

      handler = (_request, response): void => loginOk(response);

      const onFingerprint = vi.fn();
      const api = new ProtectApi(makeLog(), { onFingerprint, pinnedFingerprint: certFingerprint.replace(/:/g, '').toLowerCase() });

      await expect(api.login(address, 'user', 'secret')).resolves.toBe(true);
      expect(onFingerprint).not.toHaveBeenCalled();

      api.reset();
    });

    it('refuses a mismatched certificate before any credentials are sent', async () => {

      handler = (_request, response): void => loginOk(response);

      const log = makeLog();
      const onFingerprintMismatch = vi.fn();
      const pinned = Array(32).fill('AB').join(':');
      const api = new ProtectApi(log, { onFingerprintMismatch, pinnedFingerprint: pinned });

      await expect(api.login(address, 'user', 'secret')).resolves.toBe(false);

      // We connected, but not a single HTTP request - and therefore no password - reached the server.
      expect(tlsConnections).toBeGreaterThan(0);
      expect(requests).toHaveLength(0);
      expect(onFingerprintMismatch).toHaveBeenCalledWith(pinned, certFingerprint);

      // The mismatch is reported once, no matter how many connection attempts we make.
      expect(onFingerprintMismatch).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('does not match the pinned certificate'), expect.anything(), pinned, certFingerprint);
      expect(api.tlsFingerprint).toBe(pinned);

      api.reset();
    });

    it('exposes an agent applying the same pin for additional connections', async () => {

      const pinned = Array(32).fill('CD').join(':');
      const api = new ProtectApi(makeLog(), { pinnedFingerprint: pinned });

      const error = await new Promise<NodeJS.ErrnoException>((resolve) => {

        const request = https.request('https://' + address + '/', { agent: api.tlsAgent, method: 'POST' }, () => resolve(new Error('connected')));

        request.on('error', resolve);
        request.end('secret');
      });

      expect(error.code).toBe(PROTECT_TLS_PIN_MISMATCH);
      expect(requests).toHaveLength(0);
      expect(api.tlsAgent).toBe(api.tlsAgent);
    });

    describe('realtime events WebSocket', () => {

      let upgrades: IncomingMessage['headers'][];
      let upgradedSockets: Duplex[];

      beforeEach(() => {

        upgrades = [];
        upgradedSockets = [];

        server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {

          upgrades.push(request.headers);
          upgradedSockets.push(socket);
          acceptUpgrade(request, socket);
        });
      });

      afterEach(() => {

        // Upgraded sockets are detached from the HTTP server, so we tear them down ourselves to let the server close.
        upgradedSockets.forEach(socket => socket.destroy());
      });

      it('refuses a mismatched certificate before the upgrade request or session cookie is sent', async () => {

        const log = makeLog();
        const pinned = Array(32).fill('EF').join(':');
        const api = new ProtectApi(makeLog(), { pinnedFingerprint: pinned });

        // Drive the events channel through the API's pinned agent, exactly as ProtectApi wires it, with a session cookie that must never leave the client.
        const channel = new ProtectEventsChannel({

          cookie: () => 'TOKEN=session-cookie',
          emitMessage: vi.fn(),
          isLoggedIn: () => false,
          lastUpdateId: () => 'update-id',
          log,
          login: async () => Promise.resolve(true),
          nvrAddress: () => address,
          tlsAgent: () => api.tlsAgent,
          verifyTls: () => false,
        });

        await expect(channel.connect()).resolves.toBe(false);

        // We reached the TLS layer, but neither the upgrade request nor its Cookie header made it to the server.
        expect(tlsConnections).toBeGreaterThan(0);
        expect(upgrades).toHaveLength(0);
        expect(requests).toHaveLength(0);
        expect(log.error).toHaveBeenCalledWith('Events API error: %s', expect.stringContaining('does not match the pinned fingerprint'));

        channel.close();
      });

      it('connects through the pinned agent when the controller presents the pinned certificate', async () => {

        handler = (_request, response): void => loginOk(response);

        const api = new ProtectApi(makeLog(), { pinnedFingerprint: certFingerprint });

        await expect(api.login(address, 'user', 'secret')).resolves.toBe(true);

        // Launch the events WebSocket the same way the bootstrap does.
        await expect((api as unknown as { launchEventsWs: () => Promise<boolean> }).launchEventsWs()).resolves.toBe(true);

        expect(upgrades).toHaveLength(1);
        expect(upgrades[0]?.cookie).toBe('TOKEN=session-cookie');
        expect(upgrades[0]?.upgrade).toBe('websocket');

        api.reset();
      });
    });

    it('performs strict validation when verifyTls is enabled', async () => {

      handler = (_request, response): void => loginOk(response);

      const onFingerprint = vi.fn();
      const api = new ProtectApi(makeLog(), { onFingerprint, verifyTls: true });

      // Our self-signed fixture isn't trusted by any certificate authority.
      await expect(api.login(address, 'user', 'secret')).resolves.toBe(false);
      expect(requests).toHaveLength(0);
      expect(onFingerprint).not.toHaveBeenCalled();
      expect(api.tlsFingerprint).toBeUndefined();

      api.reset();
    });
  });
});
