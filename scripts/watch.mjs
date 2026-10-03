/* Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * watch.mjs: Development runner used by `npm run watch`. It compiles the plugin and launches Homebridge (with the config UI) against the test configuration.
 *
 * This script is run under `node --watch-path`, which restarts it whenever src/ or homebridge-ui/ change. We forward termination to Homebridge so a restart
 * never leaves an orphaned instance holding its ports.
 */
import { spawn, spawnSync } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Compile first. If the build fails, wait for the next change rather than launching a stale build.
const build = spawnSync(npx, [ 'tsc' ], { stdio: 'inherit' });

if(build.status !== 0) {

  console.error('Build failed - waiting for changes.');

  // Keep the process alive so node --watch can restart us on the next change.
  setInterval(() => {}, 1 << 30);
} else {

  const homebridge = spawn(npx, [ 'homebridge-config-ui-x', 'run', '-U', './test/hbConfig', '-D' ], {

    env: { ...process.env, NODE_OPTIONS: '--trace-warnings' },
    stdio: 'inherit',
  });

  const stop = () => {

    homebridge.kill('SIGTERM');
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  homebridge.on('exit', code => process.exit(code ?? 0));
}
