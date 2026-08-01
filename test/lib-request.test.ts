/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * lib-request.test.ts: Tests for the dependency-free HTTP(S) request utility.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { request } from '../src/lib/request.js';

describe('request', () => {

  let server: http.Server;
  let baseUrl: string;
  let flakyCount = 0;

  beforeAll(async () => {

    server = http.createServer((req, res) => {

      switch(req.url) {

        case '/json': {

          const chunks: Buffer[] = [];

          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {

            res.setHeader('x-test', 'yes');
            res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), method: req.method, ok: true }));
          });

          break;
        }

        case '/flaky':

          // Fail with a transient status code twice before recovering.
          if(++flakyCount < 3) {

            res.statusCode = 503;
            res.end();

            break;
          }

          res.end('recovered');

          break;

        case '/binary':

          res.end(Buffer.from([ 0xDE, 0xAD, 0xBE, 0xEF ]));

          break;

        case '/slow':

          // Deliberately never respond so abort handling can be exercised.
          break;

        default:

          res.statusCode = 404;
          res.end();

          break;
      }
    });

    await new Promise<void>(resolve => server.listen(0, resolve));

    baseUrl = 'http://localhost:' + (server.address() as AddressInfo).port;
  });

  afterAll(() => server.close());

  it('returns status, headers, and JSON body', async () => {

    const response = await request(baseUrl + '/json', { body: '{"hello":true}', method: 'POST' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-test']).toBe('yes');

    const body = await response.body.json() as { body: string; method: string; ok: boolean };

    expect(body.ok).toBe(true);
    expect(body.method).toBe('POST');
    expect(body.body).toBe('{"hello":true}');
  });

  it('exposes the body as text and ArrayBuffer', async () => {

    const response = await request(baseUrl + '/binary');
    const bytes = Buffer.from(await response.body.arrayBuffer());

    expect(bytes).toEqual(Buffer.from([ 0xDE, 0xAD, 0xBE, 0xEF ]));
  });

  it('returns non-2xx status codes without throwing', async () => {

    const response = await request(baseUrl + '/nope');

    expect(response.statusCode).toBe(404);
  });

  it('retries transient status codes with backoff when a retry policy is provided', async () => {

    flakyCount = 0;

    const response = await request(baseUrl + '/flaky', { retry: { maxRetries: 5, maxTimeout: 20, minTimeout: 5 } });

    expect(response.statusCode).toBe(200);
    expect(await response.body.text()).toBe('recovered');
    expect(flakyCount).toBe(3);
  });

  it('does not retry without a retry policy', async () => {

    flakyCount = 0;

    const response = await request(baseUrl + '/flaky');

    expect(response.statusCode).toBe(503);
    expect(flakyCount).toBe(1);
  });

  it('honors the abort signal', async () => {

    const controller = new AbortController();

    setTimeout(() => controller.abort(), 50);

    await expect(request(baseUrl + '/slow', { signal: controller.signal })).rejects.toThrow();
  });

  it('enforces TLS certificate validation based on the agent configuration', async () => {

    // Stand up an HTTPS server with a self-signed certificate, the same TLS posture as a UniFi controller.
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

    const tlsServer = https.createServer({ cert: readFileSync(join(fixtures, 'tls-cert.pem')), key: readFileSync(join(fixtures, 'tls-key.pem')) },
      (_req, res) => res.end('secure'));

    await new Promise<void>(resolve => tlsServer.listen(0, resolve));

    try {

      const tlsUrl = 'https://localhost:' + (tlsServer.address() as AddressInfo).port + '/';

      // With validation enabled (the default), the self-signed certificate must be rejected.
      await expect(request(tlsUrl, { agent: new https.Agent({ rejectUnauthorized: true }) })).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });

      // Validation is also the default when no agent is supplied at all.
      await expect(request(tlsUrl)).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });

      // With validation disabled - what verifyTls: false configures - the request must succeed.
      const response = await request(tlsUrl, { agent: new https.Agent({ rejectUnauthorized: false }) });

      expect(response.statusCode).toBe(200);
      expect(await response.body.text()).toBe('secure');
    } finally {

      tlsServer.close();
    }
  });

  it('rejects on connection errors to unreachable hosts', async () => {

    // Grab a port with nothing listening on it.
    const probe = http.createServer();

    await new Promise<void>(resolve => probe.listen(0, resolve));

    const deadPort = (probe.address() as AddressInfo).port;

    await new Promise<void>(resolve => probe.close(() => resolve()));

    // The just-freed port could in principle be rebound before we connect, so assert on a network-level failure rather than the exact refusal code.
    await expect(request('http://localhost:' + deadPort + '/')).rejects.toMatchObject({ code: expect.any(String) });
  });
});
