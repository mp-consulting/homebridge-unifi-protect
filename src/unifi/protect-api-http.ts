/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-api-http.ts: HTTP transport for the UniFi Protect API, with error handling and throttling.
 */
import type { Nullable } from './protect-types.js';
import type { ProtectLogging } from './protect-logging.js';
import type { RequestOptions as LibRequestOptions, RequestResponse } from '../lib/request.js';
import { CircuitBreaker } from './protect-api-circuit-breaker.js';
import { PROTECT_TLS_PIN_MISMATCH } from './protect-api-tls.js';
import { STATUS_CODES } from 'node:http';
import type https from 'node:https';
import { request } from '../lib/request.js';
import util from 'node:util';

// Number of API errors to accept before we backoff so we don't slam a Protect controller.
export const PROTECT_API_ERROR_LIMIT = 10;

// Interval, in seconds, to wait before trying to access the API again once we've hit the PROTECT_API_ERROR_LIMIT threshold.
export const PROTECT_API_RETRY_INTERVAL = 300;

// Protect API response timeout, in milliseconds. This should never be greater than 5000 ms.
const PROTECT_API_TIMEOUT = 3500;

// Protect controller status codes that indicate transient server-side issues. These should be kept in sync with the transparent retry policy that we hand to
// request() in retrieve, which retries on a subset of these codes before retrieve ever sees them.
//
// 400: Bad request.
// 404: Not found.
// 429: Too many requests.
// 500: Internal server error.
// 502: Bad gateway.
// 503: Service temporarily unavailable.
// 504: Gateway timeout.
const PROTECT_SERVER_ERRORS = new Set([ 400, 404, 429, 500, 502, 503, 504 ]);

/**
 * Configuration options for HTTP requests executed by `retrieve()`.
 *
 * @remarks The caller controls the method and body of the request...we own the transport and identity, so every request uses our authenticated session (cookie,
 * CSRF token) and connection pool.
 */
export interface RequestOptions {

  body?: string;
  method?: string;
}

/**
 * Options to tailor the behavior of {@link ProtectApi.retrieve}.
 *
 * @property {boolean} [logErrors=true] - Log errors. Defaults to `true`.
 * @property {number} [timeout=3500] - Amount of time, in milliseconds, to wait for the Protect controller to respond before timing out. Defaults to `3500`.
 */
export interface RetrieveOptions {

  logErrors?: boolean;
  timeout?: number;
}

// Internal options for our private retrieve interface, adding the ability to hand response interpretation back to the caller.
export interface InternalRetrieveOptions extends RetrieveOptions {

  decodeResponse?: boolean;
}

/**
 * What the HTTP transport needs from the API client that owns it.
 *
 * @internal
 */
export interface ProtectApiHttpHost {

  agent: () => Nullable<https.Agent>;
  headers: () => Record<string, string>;
  log: ProtectLogging;
  login: () => Promise<boolean>;
  logout: () => void;
  nvrAddress: () => string;
  reset: () => void;
}

/**
 * Determine whether an HTTP status code represents a successful response.
 *
 * @internal
 */
export function isResponseOk(code?: number): boolean {

  return (code !== undefined) && (code >= 200) && (code < 300);
}

/**
 * HTTP transport for the Protect API. Every request uses the owner's authenticated session and connection pool, and repeated failures trip a circuit breaker
 * that pauses communication with the controller.
 *
 * @internal
 */
export class ProtectApiHttp {

  public readonly breaker: CircuitBreaker;
  private readonly host: ProtectApiHttpHost;

  constructor(host: ProtectApiHttpHost) {

    this.breaker = new CircuitBreaker(PROTECT_API_ERROR_LIMIT, PROTECT_API_RETRY_INTERVAL * 1000);
    this.host = host;
  }

  // Communicate HTTP requests with a Protect controller, with error handling.
  public async retrieve(url: string, options: RequestOptions = { method: 'GET' }, retrieveOptions: InternalRetrieveOptions = {}): Promise<Nullable<RequestResponse>> {

    // Set our defaults unless the user has overriden them.
    const decodeResponse = retrieveOptions.decodeResponse ?? true;
    const logErrors = retrieveOptions.logErrors ?? true;
    const timeout = retrieveOptions.timeout ?? PROTECT_API_TIMEOUT;

    // Log errors if that's what the caller requested.
    const logError = (message: string, ...parameters: unknown[]): void => {

      if(!logErrors) {

        return;
      }

      this.host.log.error(message, ...parameters);
    };

    // Throttle requests once we've seen too many errors.
    switch(this.breaker.check()) {

      case 'tripped':

        // Let the user know we've got an API problem.
        this.host.log.error('Throttling API calls due to errors with the %s previous attempts. Pausing communication with the Protect controller for %s minutes.',
          this.breaker.errorCount, PROTECT_API_RETRY_INTERVAL / 60);
        this.host.reset();

        return null;

      case 'open':

        // We're still throttling our API calls.
        return null;

      case 'resumed':

        // Inform the user that we're out of the penalty box and try again.
        this.host.log.error('Resuming connectivity to the UniFi Protect API after pausing for %s minutes.', PROTECT_API_RETRY_INTERVAL / 60);

        if(!(await this.host.login())) {

          return null;
        }

        break;

      default:

        break;
    }

    let response;

    // Create a signal handler to deliver the abort operation.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // Catch Protect controller server-side issues.
    try {

      // Execute the API request. We intentionally use our own headers so that every request uses our authenticated session (cookie, CSRF token) and connection
      // pool. The caller controls the method and body...we own the transport and identity. Transient server-side failures are retried transparently with
      // exponential backoff. PATCH and POST are deliberately excluded from the retries...the Protect API isn't documented and we don't trust that either is
      // idempotent on the controller side. A silent retry could leave us with duplicate side effects we can't see. PATCH and POST failures bubble up through
      // our own error counting instead, so the caller gets to decide what to do about it.
      const requestOptions: LibRequestOptions = { headers: this.host.headers(), method: options.method ?? 'GET', signal: controller.signal };
      const agent = this.host.agent();

      if(agent) {

        requestOptions.agent = agent;
      }

      if(options.body !== undefined) {

        requestOptions.body = options.body;
      }

      if((options.method !== 'PATCH') && (options.method !== 'POST')) {

        requestOptions.retry = { factor: 2, maxRetries: 5, maxTimeout: 1500, minTimeout: 100, statusCodes: [ 429, 500, 502, 503, 504 ] };
      }

      response = await request(url, requestOptions);

      // The caller will sort through responses instead of us.
      if(!decodeResponse) {

        return response;
      }

      // Preemptively increase the error count.
      this.breaker.recordFailure();

      // Bad username and password.
      if(response.statusCode === 401) {

        this.host.logout();
        logError('Invalid login credentials given. Please check your login and password.');

        return null;
      }

      // Insufficient privileges.
      if(response.statusCode === 403) {

        logError('Insufficient privileges for this user. Please check the roles assigned to this user and ensure it has sufficient privileges.');

        return null;
      }

      if(!isResponseOk(response.statusCode)) {

        if(PROTECT_SERVER_ERRORS.has(response.statusCode)) {

          logError('Unable to connect to the Protect controller. This is temporary and may occur during device reboots.');

          return null;
        }

        // Some other unknown error occurred.
        logError('%s - %s', response.statusCode, STATUS_CODES[response.statusCode]);

        return null;
      }

      // We're all good - return the response and we're done.
      this.breaker.recordSuccess();

      return response;
    } catch(error) {

      // Increment our API error count.
      this.breaker.recordFailure();

      // We aborted the connection.
      if(controller.signal.aborted || ((error instanceof Error) && (error.name === 'AbortError'))) {

        logError('Protect controller is taking too long to respond to a request. This error can usually be safely ignored.');

        return null;
      }

      // Map the more common network errors to something more user-friendly.
      const cause = ((error instanceof Error) && ('code' in error) && (typeof (error as NodeJS.ErrnoException).code === 'string')) ?
        error as NodeJS.ErrnoException : null;

      if(cause) {

        this.logNetworkError(cause, logError);

        return null;
      }

      logError('Unknown error: %s', util.inspect(error, { colors: true, depth: null, sorted: true }));

      return null;
    } finally {

      // Clear out our response timeout.
      clearTimeout(timer);
    }
  }

  // Map common network errors to something more user-friendly.
  private logNetworkError(cause: NodeJS.ErrnoException, logError: (message: string, ...parameters: unknown[]) => void): void {

    switch(cause.code) {

      case 'ECONNREFUSED':
      case 'EHOSTDOWN':

        logError('Connection refused.');

        break;

      case 'ECONNRESET':

        logError('Network connection to Protect controller has been reset.');

        break;

      case 'ENOTFOUND':

        if(this.host.nvrAddress()) {

          logError('Hostname or IP address not found: %s. Please ensure the address you configured for this UniFi Protect controller is correct.',
            this.host.nvrAddress());
        } else {

          logError('No hostname or IP address provided.');
        }

        break;

      case 'ETIMEDOUT':

        logError('Connection timed out.');

        break;

      case PROTECT_TLS_PIN_MISMATCH:

        // The certificate pin has already informed the user in detail when the mismatch was first detected.
        break;

      default:

        // If we're logging when we have an error, do so.
        logError('Error: %s | %s.', cause.code, cause.message);

        break;
    }
  }
}
