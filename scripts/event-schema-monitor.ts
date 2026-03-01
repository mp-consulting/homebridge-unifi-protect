#!/usr/bin/env npx tsx
/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * event-schema-monitor.ts: Connects to a UniFi Protect controller, listens to live events, and validates each message against known schemas.
 * Reports any schema drift (new fields, missing fields, type changes) that could indicate an API change in a firmware update.
 *
 * Credentials are read from the Homebridge config file (test/hbConfig/config.json) by default. Use --config to specify a different config
 * file, or override individual fields with --address, --username, --password.
 *
 * Usage:
 *   npx tsx scripts/event-schema-monitor.ts                                       # reads from test/hbConfig/config.json
 *   npx tsx scripts/event-schema-monitor.ts --config /path/to/config.json         # reads from a custom config file
 *   npx tsx scripts/event-schema-monitor.ts --address <ip> --username <u> --password <p>  # explicit credentials
 *   npx tsx scripts/event-schema-monitor.ts --dump                                # save raw event payloads to tmp/events/
 */
import { ProtectApi } from 'unifi-protect';
import type { ProtectEventPacket } from 'unifi-protect';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  eventSchemas, headerSchema, validateSchema, type SchemaIssue,
} from '../test/event-schemas.js';

// ---- Config file loading ----

const DEFAULT_CONFIG_PATH = join(import.meta.dirname ?? '.', '..', 'test', 'hbConfig', 'config.json');

// Read controller credentials from a Homebridge config.json file.
function loadFromConfig(configPath: string): { address: string; username: string; password: string } | undefined {

  if(!existsSync(configPath)) {

    return undefined;
  }

  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    platforms?: { controllers?: { address?: string; password?: string; username?: string }[]; platform?: string }[];
  };

  const platform = raw.platforms?.find(p => p.platform === 'UniFi Protect');
  const controller = platform?.controllers?.[0];

  if(!controller?.address || !controller?.username || !controller?.password) {

    return undefined;
  }

  return { address: controller.address, password: controller.password, username: controller.username };
}

// Color helpers for terminal output.
const colors = {

  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

// ---- CLI ----

function parseCliArgs(): { address: string; dump: boolean; username: string; password: string } {

  const { values } = parseArgs({

    options: {

      address:  { short: 'a', type: 'string' },
      config:   { short: 'c', type: 'string' },
      dump:     { short: 'd', type: 'boolean', default: false },
      password: { short: 'p', type: 'string' },
      username: { short: 'u', type: 'string' },
    },

    strict: false,
  });

  // Load from config file (explicit --config path, or default).
  const configPath = (values.config as string) ?? DEFAULT_CONFIG_PATH;
  const configCreds = loadFromConfig(configPath);

  // CLI flags override config file values.
  const address = (values.address as string) ?? configCreds?.address;
  const username = (values.username as string) ?? configCreds?.username;
  const password = (values.password as string) ?? configCreds?.password;

  if(!address || !username || !password) {

    console.error('Could not find controller credentials.');
    console.error();
    console.error('Options:');
    console.error('  1. Ensure test/hbConfig/config.json has a UniFi Protect platform with controller credentials.');
    console.error('  2. Use --config <path> to point to a different Homebridge config.json.');
    console.error('  3. Use --address <ip> --username <user> --password <pass> to specify credentials directly.');
    process.exit(1);
  }

  if(configCreds && !values.address) {

    console.log(colors.dim(`Loaded credentials from ${configPath}`));
  }

  return { address, dump: !!values.dump, password, username };
}

// Event dump directory (set when --dump is enabled).
let dumpDir = '';

// Track event statistics.
const stats = {

  matched: 0,
  total: 0,
  unknown: 0,
  withIssues: 0,
};

// Map issue types to the source files that need updating.
const UPDATE_GUIDES: Record<string, { description: string; files: string[] }> = {

  'data_schema': {
    description: 'Event payload schema changed',
    files: [
      'test/event-schemas.ts               — update the SchemaDefinition for this event type',
      'src/protect-types.ts                 — update the TypeScript interface if the plugin uses this field',
    ],
  },

  'header_schema': {
    description: 'Event header structure changed',
    files: [
      'test/event-schemas.ts               — update headerSchema or knownHeaderExtras',
    ],
  },

  'unknown_event': {
    description: 'New action:modelKey combination discovered',
    files: [
      'test/event-schemas.ts               — add a new entry in eventSchemas',
      'src/protect-events.ts               — add handling if the plugin should react to it',
    ],
  },
};

// Prompt the user about a detected schema change and show which files to update.
function promptSchemaChange(guideKey: string, eventType: string, issues: SchemaIssue[]): void {

  const guide = UPDATE_GUIDES[guideKey];

  console.log();
  console.log(colors.cyan('  ┌─ Schema change detected ─────────────────────────────────────────'));
  console.log(colors.cyan('  │'));
  console.log(colors.cyan(`  │  ${guide.description}: ${colors.bold(eventType)}`));
  console.log(colors.cyan('  │'));

  for(const issue of issues) {

    const icon = issue.issue === 'unexpected_field' ? '+' : issue.issue === 'missing_required' ? '-' : '~';

    console.log(colors.cyan(`  │  ${icon} ${issue.field}: ${issue.detail}`));
  }

  console.log(colors.cyan('  │'));
  console.log(colors.cyan('  │  Files to update:'));

  for(const file of guide.files) {

    console.log(colors.cyan(`  │    → ${file}`));
  }

  console.log(colors.cyan('  │'));
  console.log(colors.cyan('  └──────────────────────────────────────────────────────────────────'));
  console.log();
}

// Process a single incoming event packet.
function processEvent(packet: ProtectEventPacket): void {

  stats.total++;

  const timestamp = new Date().toISOString();
  const action = packet.header.action;
  const modelKey = packet.header.modelKey;
  const eventType = `${action}:${modelKey}`;

  // Dump the raw payload to disk when --dump is enabled.
  if(dumpDir) {

    const filename = `${timestamp.replace(/[:.]/g, '-')}_${action}_${modelKey}_${packet.header.id}.json`;

    writeFileSync(join(dumpDir, filename), JSON.stringify(packet, null, 2) + '\n');
  }

  // Validate the header against known required + optional fields.
  const headerIssues = validateSchema(packet.header as unknown as Record<string, unknown>, headerSchema, 'header.');

  if(headerIssues.length > 0) {

    stats.withIssues++;
    console.log(`${colors.dim(timestamp)} ${colors.red('MISMATCH')} ${colors.bold('HEADER')} ${eventType} id=${packet.header.id}`);

    for(const issue of headerIssues) {

      const icon = issue.issue === 'unexpected_field' ? colors.yellow('+') : colors.red('!');

      console.log(`  ${icon} ${colors.bold(issue.field)}: ${issue.issue} — ${issue.detail}`);
    }

    promptSchemaChange('header_schema', eventType, headerIssues);

    return;
  }

  // Look up the data schema for this event type.
  const eventDef = eventSchemas[eventType];

  if(!eventDef) {

    stats.unknown++;
    const payloadKeys = typeof packet.payload === 'object' && packet.payload !== null ? Object.keys(packet.payload as Record<string, unknown>) : [];

    console.log(`${colors.dim(timestamp)} ${colors.yellow('UNKNOWN')} ${colors.bold(eventType)} id=${packet.header.id}`);
    console.log(`  ${colors.yellow('No schema defined for this action:modelKey. Payload keys:')} ${payloadKeys.join(', ') || '(empty)'}`);

    promptSchemaChange('unknown_event', eventType, [{
      detail: `Payload keys: ${payloadKeys.join(', ') || '(empty)'}`,
      field: 'payload',
      issue: 'unexpected_field',
    }]);

    return;
  }

  // For partial schemas (device config updates), we skip strict required-field validation and only flag unexpected keys.
  // For non-partial schemas (add:event), we do full validation.
  const payload = packet.payload as Record<string, unknown>;
  let dataIssues: SchemaIssue[] = [];

  if(Object.keys(eventDef.schema).length > 0) {

    if(eventDef.partial) {

      // Partial mode: only check that present fields have correct types and flag unexpected fields.
      dataIssues = validateSchemaPartial(payload, eventDef.schema, 'payload.');
    } else {

      dataIssues = validateSchema(payload, eventDef.schema, 'payload.');
    }
  }

  // Validate sub-schemas.
  const subIssues: SchemaIssue[] = [];

  if(eventDef.subSchemas) {

    for(const sub of eventDef.subSchemas) {

      const subData = resolveDottedPath(payload, sub.path);

      if(subData === undefined || subData === null) {

        continue;
      }

      if(sub.isArray && Array.isArray(subData)) {

        for(const [i, element] of (subData as Record<string, unknown>[]).entries()) {

          subIssues.push(...validateSchema(element, sub.schema, `payload.${sub.path}[${i}].`));
        }
      } else if(!sub.isArray && typeof subData === 'object') {

        subIssues.push(...validateSchema(subData as Record<string, unknown>, sub.schema, `payload.${sub.path}.`));
      }
    }
  }

  const allIssues = [...dataIssues, ...subIssues];

  if(allIssues.length > 0) {

    stats.withIssues++;
    console.log(`${colors.dim(timestamp)} ${colors.red('MISMATCH')} ${colors.bold(eventDef.name)} (${eventType}) id=${packet.header.id}`);

    for(const issue of allIssues) {

      const icon = issue.issue === 'unexpected_field' ? colors.yellow('+') : colors.red('!');

      console.log(`  ${icon} ${colors.bold(issue.field)}: ${issue.issue} — ${issue.detail}`);
    }

    promptSchemaChange('data_schema', eventType, allIssues);
  } else {

    stats.matched++;

    const detail = formatEventDetail(action, modelKey, payload);

    console.log(`${colors.dim(timestamp)} ${colors.green('OK')} ${colors.bold(eventDef.name)} (${eventType}) id=${packet.header.id}${detail}`);
  }
}

// Resolve a dotted path like "metadata.detectedThumbnails" on an object.
function resolveDottedPath(obj: Record<string, unknown>, path: string): unknown {

  const parts = path.split('.');
  let current: unknown = obj;

  for(const part of parts) {

    if(current === null || current === undefined || typeof current !== 'object') {

      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// Partial schema validation: only check types of present fields and flag unexpected top-level keys.
function validateSchemaPartial(data: Record<string, unknown>, schema: SchemaDefinition, prefix = ''): SchemaIssue[] {

  const issues: SchemaIssue[] = [];

  // Check types of fields that are both present and defined in the schema.
  for(const [field, spec] of Object.entries(schema)) {

    const value = data[field];

    if(value === undefined || value === null) {

      continue;
    }

    const actual = Array.isArray(value) ? 'array' : typeof value;

    if(!spec.type.split('|').includes(actual)) {

      issues.push({ detail: `Expected ${spec.type}, got ${actual}`, field: prefix + field, issue: 'type_mismatch' });
    }
  }

  // Flag unexpected top-level fields.
  const topLevelExpected = new Set(Object.keys(schema));

  for(const key of Object.keys(data)) {

    if(!topLevelExpected.has(key)) {

      issues.push({ detail: `Type: ${Array.isArray(data[key]) ? 'array' : typeof data[key]}`, field: prefix + key, issue: 'unexpected_field' });
    }
  }

  return issues;
}

// Format a brief detail string for the OK log line based on the event type.
function formatEventDetail(action: string, modelKey: string, payload: Record<string, unknown>): string {

  if(action === 'add' && modelKey === 'event') {

    const parts: string[] = [];

    if(payload.type) {

      parts.push(`type=${payload.type}`);
    }

    if(Array.isArray(payload.smartDetectTypes) && payload.smartDetectTypes.length > 0) {

      parts.push(`smart=${(payload.smartDetectTypes as string[]).join(',')}`);
    }

    return parts.length > 0 ? ' ' + parts.join(' ') : '';
  }

  if(action === 'update') {

    const keys = Object.keys(payload);

    if(keys.length <= 5) {

      return ' keys=' + keys.join(',');
    }

    return ` keys=${keys.slice(0, 4).join(',')}… (${keys.length} total)`;
  }

  return '';
}

// Print summary on exit.
function printSummary(): void {

  console.log();
  console.log(colors.bold('--- Session Summary ---'));
  console.log(`  Total events:      ${stats.total}`);
  console.log(`  Schema matched:    ${colors.green(String(stats.matched))}`);
  console.log(`  Schema mismatch:   ${stats.withIssues > 0 ? colors.red(String(stats.withIssues)) : '0'}`);
  console.log(`  Unknown events:    ${stats.unknown > 0 ? colors.yellow(String(stats.unknown)) : '0'}`);
  console.log();
}

// Main entry point.
async function main(): Promise<void> {

  const { address, dump, username, password } = parseCliArgs();

  // Set up the event dump directory when --dump is enabled.
  if(dump) {

    dumpDir = join(import.meta.dirname ?? '.', '..', 'tmp', 'events');
    mkdirSync(dumpDir, { recursive: true });
    console.log(colors.dim(`Event payloads will be saved to ${dumpDir}`));
  }

  const log = {

    debug: (_message: string, ..._params: unknown[]) => void 0,
    error: (message: string, ...params: unknown[]) => console.error(colors.red('API Error:'), message, ...params),
    info: (_message: string, ..._params: unknown[]) => void 0,
    warn: (message: string, ...params: unknown[]) => console.warn(colors.yellow('API Warning:'), message, ...params),
  };

  const api = new ProtectApi(log);

  console.log(colors.bold('UniFi Protect Event Schema Monitor'));
  console.log(`Connecting to ${colors.blue(address)}...`);
  console.log();

  const loginResult = await api.login(address, username, password);

  if(!loginResult) {

    console.error(colors.red('Login failed. Check your credentials and controller address.'));
    process.exit(1);
  }

  console.log(colors.green('Connected.') + ' Bootstrapping...');

  await api.getBootstrap();

  const cameraCount = api.bootstrap?.cameras?.length ?? 0;
  const lightCount = api.bootstrap?.lights?.length ?? 0;
  const sensorCount = api.bootstrap?.sensors?.length ?? 0;

  console.log(colors.green('Bootstrap complete.') + ` ${cameraCount} camera(s), ${lightCount} light(s), ${sensorCount} sensor(s) found.`);
  console.log();
  console.log(colors.bold('Listening for events...') + ' Press Ctrl+C to stop.');
  console.log(colors.dim('Events will be validated against known schemas in real time.'));
  console.log();

  // Listen for all events.
  api.on('message', (packet: ProtectEventPacket) => {

    processEvent(packet);
  });

  // Graceful shutdown.
  const shutdown = () => {

    printSummary();
    api.reset();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {

  console.error(colors.red('Fatal error:'), error);
  process.exit(1);
});
