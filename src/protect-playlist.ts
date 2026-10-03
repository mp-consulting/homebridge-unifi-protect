/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-playlist.ts: M3U playlist server for UniFi Protect camera livestreams.
 */
import type { ProtectApi, ProtectNvrBootstrapData } from './unifi/index.js';
import { PROTECT_M3U_PLAYLIST_PORT, PROTECT_PLAYLIST_LOGO_URL } from './settings.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { HomebridgePluginLogging } from './lib/index.js';
import http from 'node:http';
import util from 'node:util';

// Options for the playlist server.
export interface ProtectPlaylistOptions {

  // Address to bind to. Defaults to all interfaces.
  address?: string | undefined;

  // Port to listen on. Defaults to PROTECT_M3U_PLAYLIST_PORT.
  port?: number | undefined;

  // Access token that clients must supply as the `token` query parameter. When unset, the playlist is available to anyone who can reach the port.
  token?: string | undefined;
}

// Sanitize a name for use within an M3U #EXTINF line. Double quotes would terminate an attribute value and line breaks would let a name inject arbitrary
// playlist entries. The display title follows the last comma on the line, so commas are removed there as well.
export function sanitizePlaylistName(name: string, isTitle = false): string {

  return name.replace(isTitle ? /["\r\n,]/g : /["\r\n]/g, '').trim();
}

// Generate the M3U playlist for the cameras in a Protect bootstrap.
export function generatePlaylist(bootstrap: ProtectNvrBootstrapData): string {

  const lines = ['#EXTM3U'];

  // Make sure we have access to the Protect API bootstrap before we begin.
  if(!bootstrap) {

    return lines.join('\n') + '\n';
  }

  // Find the RTSP aliases and publish them. We filter out any cameras that don't have RTSP aliases since they would be inaccessible in this context.
  for(const camera of bootstrap.cameras
    .filter(x => (x.videoCodec !== 'av1') && x.channels.some(channel => channel.isRtspEnabled))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {

    // Publish a playlist entry, including guide information that's suitable for apps that support it, such as Channels DVR.
    const publishEntry = (name = camera.name ?? camera.marketName, description = 'camera', rtspAlias = camera.channels[0]?.rtspAlias): void => {

      const attributeName = sanitizePlaylistName(name);
      const marketName = sanitizePlaylistName(camera.marketName);

      lines.push(util.format('#EXTINF:0 channel-id="%s" tvc-stream-vcodec="h264" tvc-stream-acodec="opus" tvg-logo="%s" ', attributeName,
        PROTECT_PLAYLIST_LOGO_URL) +
        util.format('tvc-guide-title="%s Livestream" tvc-guide-description="UniFi Protect %s %s livestream." ', attributeName, marketName, description) +
        util.format('tvc-guide-art="%s" tvc-guide-tags="HD, Live, New, UniFi Protect", %s', PROTECT_PLAYLIST_LOGO_URL, sanitizePlaylistName(name, true)));

      // By convention, the first RTSP alias is always the highest quality on UniFi Protect cameras. Grab it and we're done. We might be tempted to use the
      // RTSPS stream here, but many apps only supports RTSP, and we'll opt for maximizing compatibility here.
      lines.push(util.format('rtsp://%s:%s/%s', bootstrap.nvr.host, bootstrap.nvr.ports.rtsp, rtspAlias).replace(/[\r\n]/g, ''));
    };

    // Create a playlist entry for each camera.
    publishEntry();

    // Ensure we publish package cameras as well, when we have them.
    if(camera.featureFlags.hasPackageCamera) {

      const packageChannel = camera.channels.find(x => x.isRtspEnabled && (x.name === 'Package Camera'));

      if(!packageChannel) {

        continue;
      }

      publishEntry((camera.name ?? camera.marketName) + ' ' + packageChannel.name, 'package camera', packageChannel.rtspAlias);
    }
  }

  return lines.join('\n') + '\n';
}

// Validate the access token supplied with a request. We compare digests in constant time so the token can't be discovered through response timing.
export function isAuthorizedRequest(url: string | undefined, token: string | undefined): boolean {

  if(!token) {

    return true;
  }

  let supplied: string | null;

  try {

    supplied = new URL(url ?? '/', 'http://localhost').searchParams.get('token');
  } catch {

    return false;
  }

  if(supplied === null) {

    return false;
  }

  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

  return timingSafeEqual(digest(supplied), digest(token));
}

export class ProtectPlaylistServer {

  private readonly address: string | undefined;
  private readonly log: HomebridgePluginLogging;
  private readonly port: number;
  private server: http.Server | undefined;
  private readonly token: string | undefined;
  private readonly ufpApi: ProtectApi;

  constructor(ufpApi: ProtectApi, log: HomebridgePluginLogging, options: ProtectPlaylistOptions = {}) {

    this.address = options.address?.trim() || undefined;
    this.log = log;
    this.port = options.port ?? PROTECT_M3U_PLAYLIST_PORT;
    this.server = undefined;
    this.token = options.token?.trim() || undefined;
    this.ufpApi = ufpApi;

    this.start();
  }

  // Create a web service to publish an M3U playlist of Protect camera livestreams.
  private start(): void {

    const server = http.createServer();

    this.server = server;

    // Respond to requests for a Protect camera playlist.
    server.on('request', (request: http.IncomingMessage, response: http.ServerResponse) => {

      // Only allow access to those who have the access token, if one's been configured.
      if(!isAuthorizedRequest(request.url, this.token)) {

        response.writeHead(401, { 'Content-Type': 'text/plain' });
        response.end('Unauthorized.\n');

        return;
      }

      // Set the right MIME type for M3U playlists and send the playlist.
      response.writeHead(200, { 'Content-Type': 'application/x-mpegURL' });
      response.end(generatePlaylist(this.ufpApi.bootstrap));
    });

    // Handle errors when they occur.
    server.on('error', (error) => {

      // Explicitly handle address in use errors, given their relative common nature. Everything else, we log and abandon.
      if((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {

        this.log.error('The address and port we are attempting to use is already in use by something else. Will retry again shortly.');

        setTimeout(() => {

          server.close();
          server.listen(this.port, this.address);
        }, 5000);

        return;
      }

      this.log.error('M3U playlist publisher error: %s', error);
      server.close();
    });

    // Let users know we're up and running.
    server.on('listening', () => {

      this.log.info('Publishing an M3U playlist of Protect camera livestream URLs on %s port %s.', this.address ?? 'all interfaces,', this.port);

      // The playlist contains direct RTSP URLs to every camera. Without a token, anyone who can reach this port can retrieve them.
      if(!this.token) {

        this.log.warn('The M3U playlist is available to anyone who can reach this Homebridge server%s, exposing camera livestream URLs. Configure a playlist ' +
          'access token (and optionally a bind address) in the controller settings to restrict access.', this.address ? '' : ' on your network');
      }
    });

    // Listen on the address and port we've configured.
    server.listen(this.port, this.address);
  }

  // Stop publishing the playlist.
  public close(): void {

    this.server?.close();
    this.server = undefined;
  }

  // The port we're listening on, once we're up and running.
  public get listeningPort(): number | undefined {

    const address = this.server?.address();

    return (address && (typeof address === 'object')) ? address.port : undefined;
  }
}
