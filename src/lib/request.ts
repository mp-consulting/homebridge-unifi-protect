/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * request.ts: Minimal, dependency-free HTTPS request utility built on Node's https module.
 */
import http from 'node:http';
import https from 'node:https';
import { sleep } from './util.js';

// Options for a single HTTP request.
export interface RequestOptions {

  agent?: https.Agent;
  body?: string | Buffer;
  headers?: Record<string, string | undefined>;
  maxResponseSize?: number;
  method?: string;
  retry?: RetryOptions;
  signal?: AbortSignal;
}

// Options controlling transparent retries of transient failures.
export interface RetryOptions {

  factor?: number;
  maxRetries?: number;
  maxTimeout?: number;
  minTimeout?: number;
  statusCodes?: number[];
}

// The response to an HTTP request. The body is fully buffered and exposed through convenience accessors.
export interface RequestResponse {

  body: {

    arrayBuffer: () => Promise<ArrayBuffer>;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  };
  headers: http.IncomingHttpHeaders;
  statusCode: number;
}

// Default cap, in bytes, on the size of a response body we're willing to buffer. This guards against a broken or hostile endpoint streaming an unbounded
// response into memory, while comfortably exceeding anything the UniFi APIs legitimately return.
const DEFAULT_MAX_RESPONSE_SIZE = 64 * 1024 * 1024;

// Status codes we consider transient by default when retrying.
const DEFAULT_RETRY_STATUS_CODES = [ 429, 500, 502, 503, 504 ];

// Execute a single HTTP request attempt and buffer the complete response.
function requestOnce(url: string, options: RequestOptions): Promise<RequestResponse> {

  return new Promise((resolve, reject) => {

    const requestFn = url.startsWith('http://') ? http.request : https.request;

    const req = requestFn(url, {

      agent: options.agent,
      headers: Object.fromEntries(Object.entries(options.headers ?? {}).filter(([ , value ]) => value !== undefined)) as Record<string, string>,
      method: options.method ?? 'GET',
      signal: options.signal,
    }, (res) => {

      const chunks: Buffer[] = [];
      const maxResponseSize = options.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
      let size = 0;

      let isOversized = false;

      res.on('data', (chunk: Buffer) => {

        if(isOversized) {

          return;
        }

        size += chunk.length;

        if(size > maxResponseSize) {

          // Reject, then tear the connection down. We deliberately don't hand the error to destroy() - that would re-emit it on the underlying socket, where
          // nobody may be listening for it once the response has started.
          isOversized = true;
          chunks.length = 0;
          reject(new Error('Response exceeds the maximum allowed size of ' + maxResponseSize + ' bytes.'));
          req.destroy();

          return;
        }

        chunks.push(chunk);
      });

      res.on('end', () => {

        const raw = Buffer.concat(chunks);

        resolve({

          body: {

            arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer),
            json: async (): Promise<unknown> => JSON.parse(raw.toString('utf8')),
            text: (): Promise<string> => Promise.resolve(raw.toString('utf8')),
          },
          headers: res.headers,
          statusCode: res.statusCode ?? 0,
        });
      });

      res.on('error', reject);
    });

    req.on('error', reject);

    if(options.body !== undefined) {

      req.write(options.body);
    }

    req.end();
  });
}

// Execute an HTTP request, transparently retrying transient failures with exponential backoff when a retry policy is provided.
export async function request(url: string, options: RequestOptions = {}): Promise<RequestResponse> {

  // No retry policy - execute a single attempt.
  if(!options.retry) {

    return requestOnce(url, options);
  }

  const factor = options.retry.factor ?? 2;
  const maxRetries = options.retry.maxRetries ?? 3;
  const maxTimeout = options.retry.maxTimeout ?? 1500;
  const minTimeout = options.retry.minTimeout ?? 100;
  const statusCodes = options.retry.statusCodes ?? DEFAULT_RETRY_STATUS_CODES;

  let attempt = 0;

  for(;;) {

    try {

      const response = await requestOnce(url, options);

      // If we have a retryable status code and attempts remaining, backoff and try again.
      if(statusCodes.includes(response.statusCode) && (attempt < maxRetries) && !options.signal?.aborted) {

        await sleep(Math.min(minTimeout * Math.pow(factor, attempt++), maxTimeout));

        continue;
      }

      return response;
    } catch(error) {

      // Aborts are never retried - they're deliberate or a timeout has hit.
      if(options.signal?.aborted || (attempt >= maxRetries)) {

        throw error;
      }

      // Retry transient network-level errors only.
      const code = (error as NodeJS.ErrnoException).code;

      if(![ 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE', 'ETIMEDOUT' ].includes(code ?? '')) {

        throw error;
      }

      await sleep(Math.min(minTimeout * Math.pow(factor, attempt++), maxTimeout));
    }
  }
}
