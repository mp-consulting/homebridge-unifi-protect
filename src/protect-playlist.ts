/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * protect-playlist.ts: M3U playlist server for UniFi Protect camera livestreams.
 */
import type { HomebridgePluginLogging } from 'homebridge-plugin-utils';
import type { ProtectApi } from 'unifi-protect';
import { PROTECT_M3U_PLAYLIST_PORT, PROTECT_PLAYLIST_LOGO_URL } from './settings.js';
import http from 'node:http';
import util from 'node:util';

export class ProtectPlaylistServer {

  private readonly log: HomebridgePluginLogging;
  private readonly port: number;
  private readonly ufpApi: ProtectApi;

  constructor(ufpApi: ProtectApi, log: HomebridgePluginLogging, port?: number) {

    this.log = log;
    this.port = port ?? PROTECT_M3U_PLAYLIST_PORT;
    this.ufpApi = ufpApi;

    this.start();
  }

  // Create a web service to publish an M3U playlist of Protect camera livestreams.
  private start(): void {

    const server = http.createServer();

    // Respond to requests for a Protect camera playlist.
    server.on('request', (request, response) => {

      // Set the right MIME type for M3U playlists.
      response.writeHead(200, { 'Content-Type': 'application/x-mpegURL' });

      // Output the M3U header.
      response.write('#EXTM3U\n');

      // Make sure we have access to the Protect API bootstrap before we begin.
      if(this.ufpApi.bootstrap) {

        // Find the RTSP aliases and publish them. We filter out any cameras that don't have RTSP aliases since they would be inaccessible in this context.
        for(const camera of this.ufpApi.bootstrap.cameras
          .filter(x => (x.videoCodec !== 'av1') && x.channels.some(channel => channel.isRtspEnabled))
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {

          // Publish a playlist entry, including guide information that's suitable for apps that support it, such as Channels DVR.
          const publishEntry = (name = camera.name, description = 'camera', rtspAlias = camera.channels[0].rtspAlias): void => {

            response.write(util.format('#EXTINF:0 channel-id="%s" tvc-stream-vcodec="h264" tvc-stream-acodec="opus" tvg-logo="%s" ',
              name, PROTECT_PLAYLIST_LOGO_URL));

            response.write(util.format('tvc-guide-title="%s Livestream" tvc-guide-description="UniFi Protect %s %s livestream." ',
              name, camera.marketName, description));

            response.write(util.format('tvc-guide-art="%s" tvc-guide-tags="HD, Live, New, UniFi Protect", %s\n',
              PROTECT_PLAYLIST_LOGO_URL, name));

            // By convention, the first RTSP alias is always the highest quality on UniFi Protect cameras. Grab it and we're done. We might be tempted
            // to use the RTSPS stream here, but many apps only supports RTSP, and we'll opt for maximizing compatibility here.
            response.write(util.format('rtsp://%s:%s/%s\n', this.ufpApi.bootstrap?.nvr.host, this.ufpApi.bootstrap?.nvr.ports.rtsp, rtspAlias));
          };

          // Create a playlist entry for each camera.
          publishEntry();

          // Ensure we publish package cameras as well, when we have them.
          if(camera.featureFlags.hasPackageCamera) {

            const packageChannel = camera.channels.find(x => x.isRtspEnabled && (x.name === 'Package Camera'));

            if(!packageChannel) {

              continue;
            }

            publishEntry(camera.name + ' ' + packageChannel.name, 'package camera', packageChannel.rtspAlias);
          }
        }
      }

      // We're done with this response.
      response.end();
    });

    // Handle errors when they occur.
    server.on('error', (error) => {

      // Explicitly handle address in use errors, given their relative common nature. Everything else, we log and abandon.
      if((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {

        this.log.error('The address and port we are attempting to use is already in use by something else. Will retry again shortly.');

        setTimeout(() => {

          server.close();
          server.listen(this.port);
        }, 5000);

        return;
      }

      this.log.error('M3U playlist publisher error: %s', error);
      server.close();
    });

    // Let users know we're up and running.
    server.on('listening', () => {

      this.log.info('Publishing an M3U playlist of Protect camera livestream URLs on port %s.', this.port);
    });

    // Listen on the port we've configured.
    server.listen(this.port);
  }
}
