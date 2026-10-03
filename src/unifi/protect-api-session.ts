/* Copyright(C) 2019-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-api-session.ts: Authentication session management (login, cookies, and CSRF tokens) for the UniFi Protect API.
 */
import type { RequestOptions, RetrieveOptions } from './protect-api-http.js';
import type { Nullable } from './protect-types.js';
import type { RequestResponse } from '../lib/request.js';
import { isResponseOk } from './protect-api-http.js';

/**
 * What the session needs from the API client that owns it.
 *
 * @internal
 */
export interface ProtectApiSessionHost {

  loginEndpoint: () => string;
  logout: () => void;
  retrieve: (url: string, options?: RequestOptions, retrieveOptions?: RetrieveOptions) => Promise<Nullable<RequestResponse>>;
}

// Utility to grab the headers we're interested in a normalized manner.
function getHeader(name: string, headers?: RequestResponse['headers']): Nullable<string> {

  const rawHeader = headers?.[name.toLowerCase()];

  if(!rawHeader) {

    return null;
  }

  // Normalize it to a string.
  return Array.isArray(rawHeader) ? (rawHeader[0] ?? null) : rawHeader;
}

/**
 * Cookie-based authentication session with CSRF token protection, mimicking the Protect web interface.
 *
 * @internal
 */
export class ProtectApiSession {

  private _headers: Record<string, string>;
  private readonly host: ProtectApiSessionHost;
  public nvrAddress: string;
  private password: string;
  public username: string;

  constructor(host: ProtectApiSessionHost) {

    this._headers = {};
    this.host = host;
    this.nvrAddress = '';
    this.password = '';
    this.username = '';
  }

  // Set the credentials we use to login.
  public setCredentials(nvrAddress: string, username: string, password: string): void {

    this.nvrAddress = nvrAddress;
    this.username = username;
    this.password = password;
  }

  // Login to the UniFi Protect API.
  public async login(): Promise<boolean> {

    // If we're already logged in, we're done.
    if(this.isLoggedIn) {

      return true;
    }

    // Attempt to log in directly. If we already have a CSRF token (from a prior session or a previous login attempt), we skip the CSRF pre-fetch entirely and
    // go straight to the login endpoint. The login response provides an updated CSRF token, so the pre-fetch is only needed if we have no token at all and the
    // controller rejects our login without one.
    const loginBody = JSON.stringify({ password: this.password, rememberMe: true, token: '', username: this.username });

    let response = await this.host.retrieve(this.host.loginEndpoint(), { body: loginBody, method: 'POST' });

    // If the login failed and we don't have a CSRF token, acquire one and retry. UniFi OS has cross-site request forgery protection built into its web
    // management UI. Some controllers require a valid CSRF token on the login request itself.
    if(!isResponseOk(response?.statusCode) && !this._headers['x-csrf-token']) {

      const csrfResponse = await this.host.retrieve('https://' + this.nvrAddress, { method: 'GET' }, { logErrors: false });

      if(isResponseOk(csrfResponse?.statusCode)) {

        const csrfToken = getHeader('X-CSRF-Token', csrfResponse?.headers);

        // Preserve the CSRF token, if found, and retry the login.
        if(csrfToken) {

          this._headers['x-csrf-token'] = csrfToken;
          response = await this.host.retrieve(this.host.loginEndpoint(), { body: loginBody, method: 'POST' });
        }
      }
    }

    // Something went wrong with the login call, possibly a controller reboot or failure.
    if(!isResponseOk(response?.statusCode)) {

      this.host.logout();

      return false;
    }

    // We're logged in. Let's configure our headers.
    const csrfToken = getHeader('X-Updated-CSRF-Token', response?.headers) ?? getHeader('X-CSRF-Token', response?.headers);
    const cookie = getHeader('Set-Cookie', response?.headers);

    // Save the refreshed cookie and CSRF token for future API calls and we're done.
    if(csrfToken && cookie) {

      // Only preserve the token element of the cookie and not the superfluous information that's been added to it.
      this._headers.cookie = cookie.split(';')[0] ?? cookie;

      // Save the CSRF token.
      this._headers['x-csrf-token'] = csrfToken;

      return true;
    }

    // Clear out our login credentials.
    this.host.logout();

    return false;
  }

  // Clear our session, preserving any CSRF token we have for future logins.
  public clear(): void {

    // Save our CSRF token, if we have one.
    const csrfToken = this._headers['x-csrf-token'];

    // Initialize the headers we need.
    this._headers = {};
    this._headers['content-type'] = 'application/json';
    this._headers['user-agent'] = 'unifi-protect';

    // Restore the CSRF token if we have one.
    if(csrfToken) {

      this._headers['x-csrf-token'] = csrfToken;
    }
  }

  // The session cookie, if we're logged in.
  public get cookie(): string | undefined {

    return this._headers.cookie;
  }

  // The headers that identify our session on each request.
  public get headers(): Record<string, string> {

    return this._headers;
  }

  // Whether we have an authenticated session.
  public get isLoggedIn(): boolean {

    return !!(this._headers.cookie && this._headers['x-csrf-token']);
  }
}
