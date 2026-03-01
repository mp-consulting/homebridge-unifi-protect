/* Copyright(C) 2017-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * Shared event schema definitions for the UniFi Protect realtime events API.
 *
 * This file is the single source of truth for event payload schemas. It is used by:
 *   - test/protect-event-schemas.test.ts (static schema validation tests)
 *   - scripts/event-schema-monitor.ts (live event monitoring against a real controller)
 *
 * When the UniFi Protect API changes, update schemas here and both consumers pick up the changes automatically.
 *
 * Protect events differ from Access events — they use a binary protocol decoded into a header + payload pair:
 *
 *   - header: { action, id, modelKey, newUpdateId, [extraFields] }
 *   - payload: varies by action and modelKey
 *
 * For "add" actions the payload is always a ProtectEventAdd object.
 * For "update" actions the payload is a partial device config, indexed by modelKey.
 * For "remove" actions the payload can be empty or minimal.
 */
import type { ProtectEventAdd, ProtectEventPacket } from 'unifi-protect';

// ---- Schema definition types ----

export interface FieldSchema {

  required: boolean;
  type: string;
}

export type SchemaDefinition = Record<string, FieldSchema>;

export interface SchemaIssue {

  field: string;
  issue: 'missing_required' | 'unexpected_field' | 'type_mismatch';
  detail: string;
}

// ---- Header envelope schema ----

// Every event packet header must have these fields. Optional fields are extras that the controller may include.
export const headerSchema: SchemaDefinition = {

  'action':       { required: true,  type: 'string' },
  'id':           { required: true,  type: 'string' },
  'modelKey':     { required: true,  type: 'string' },
  'newUpdateId':  { required: true,  type: 'string' },

  // Optional header extras observed on real controllers.
  '_body':        { required: false, type: 'object' },
  '_isEvent':     { required: false, type: 'boolean' },
  'mac':          { required: false, type: 'string' },
  'modifiedKeys': { required: false, type: 'array' },
  'nvrMac':       { required: false, type: 'string' },
  'recordId':     { required: false, type: 'string' },
  'recordModel':  { required: false, type: 'string' },
  'state':        { required: false, type: 'string' },
  'token':        { required: false, type: 'object' },
};

// ---- Payload schemas: add:event ----

// ProtectEventAdd — new event item. The add:event payload varies by event sub-type (motion, doorbell ring,
// smart detection, device adoption, user actions, etc.). Only fields present across all sub-types are required.
export const eventAddSchema: SchemaDefinition = {

  // Fields present on all add:event sub-types.
  'id':                 { required: true,  type: 'string' },
  'locked':             { required: true,  type: 'boolean' },
  'modelKey':           { required: true,  type: 'string' },
  'score':              { required: true,  type: 'number' },
  'start':              { required: true,  type: 'number' },
  'type':               { required: true,  type: 'string' },
  'user':               { required: true,  type: 'string' },

  // Fields present on motion / detection / ring events.
  'camera':             { required: false, type: 'string' },
  'cameraId':           { required: false, type: 'string' },
  'detectedAt':         { required: false, type: 'number' },
  'device':             { required: false, type: 'object' },
  'end':                { required: false, type: 'number' },
  'eventId':            { required: false, type: 'string' },
  'favoriteObjectIds':  { required: false, type: 'object' },
  'isFavorite':         { required: false, type: 'object' },
  'metadata':           { required: false, type: 'object' },
  'partition':          { required: false, type: 'string' },
  'smartDetectEvents':  { required: false, type: 'array' },
  'smartDetectTypes':   { required: false, type: 'array' },
  'thumbnailId':        { required: false, type: 'string' },
};

// ProtectEventMetadata sub-schema (nested inside add:event payloads).
export const eventMetadataSchema: SchemaDefinition = {

  'accessEventId':      { required: false, type: 'string' },
  'action':             { required: false, type: 'string' },
  'clientPlatform':     { required: false, type: 'string' },
  'detectedAreas':      { required: false, type: 'array' },
  'detectedThumbnails': { required: false, type: 'array' },
  'deviceId':           { required: false, type: 'object' },
  'direction':          { required: false, type: 'string' },
  'doorName':           { required: false, type: 'string' },
  'fingerprint':        { required: false, type: 'object' },
  'firstName':          { required: false, type: 'string' },
  'hallwayMode':        { required: false, type: 'string' },
  'ip':                 { required: false, type: 'string' },
  'isLowBattery':       { required: false, type: 'boolean' },
  'isWireless':         { required: false, type: 'boolean' },
  'lastName':           { required: false, type: 'string' },
  'licensePlate':       { required: false, type: 'object' },
  'name':               { required: false, type: 'object' },
  'nfc':                { required: false, type: 'object' },
  'sensorId':           { required: false, type: 'string' },
  'sensorName':         { required: false, type: 'string' },
  'sensorType':         { required: false, type: 'string' },
  'userName':           { required: false, type: 'string' },
};

// ProtectEventMetadataDetectedThumbnail element sub-schema.
export const detectedThumbnailSchema: SchemaDefinition = {

  'attributes':         { required: false, type: 'object' },
  'clockBestWall':      { required: false, type: 'number' },
  'confidence':         { required: false, type: 'number' },
  'coord':              { required: false, type: 'array' },
  'croppedId':          { required: false, type: 'string' },
  'name':               { required: false, type: 'string' },
  'objectId':           { required: false, type: 'string' },
  'type':               { required: false, type: 'string' },
};

// ---- Payload schemas: update:event ----

// When an event is updated (e.g. confidence score finalized, event ended), only a subset of ProtectEventAdd fields appear.
export const eventUpdateSchema: SchemaDefinition = {

  'end':                { required: false, type: 'number' },
  'id':                 { required: false, type: 'string' },
  'locked':             { required: false, type: 'boolean' },
  'metadata':           { required: false, type: 'object' },
  'score':              { required: false, type: 'number' },
  'smartDetectEvents':  { required: false, type: 'array' },
  'smartDetectTypes':   { required: false, type: 'array' },
  'thumbnailId':        { required: false, type: 'string' },
  'type':               { required: false, type: 'string' },
};

// ---- Event registry ----

// Map action:modelKey combinations to their schemas.
export const eventSchemas: Record<string, {
  name: string; schema: SchemaDefinition; partial?: boolean;
  subSchemas?: { path: string; isArray: boolean; schema: SchemaDefinition }[];
}> = {

  'add:event': {
    name: 'EVENT_ADD',
    schema: eventAddSchema,
    subSchemas: [
      { isArray: false, path: 'metadata', schema: eventMetadataSchema },
      { isArray: true,  path: 'metadata.detectedThumbnails', schema: detectedThumbnailSchema },
    ],
  },

  'add:smartDetectObject': {
    name: 'SMART_DETECT_OBJECT_ADD',
    schema: eventAddSchema,
    subSchemas: [
      { isArray: false, path: 'metadata', schema: eventMetadataSchema },
      { isArray: true,  path: 'metadata.detectedThumbnails', schema: detectedThumbnailSchema },
    ],
  },

  'update:automation': { name: 'AUTOMATION_UPDATE', schema: {}, partial: true },
  'update:bridge':  { name: 'BRIDGE_UPDATE',  schema: {}, partial: true },
  'update:camera':  { name: 'CAMERA_UPDATE',  schema: {}, partial: true },
  'update:chime':   { name: 'CHIME_UPDATE',   schema: {}, partial: true },
  'update:event':   { name: 'EVENT_UPDATE',   schema: eventUpdateSchema, partial: true },
  'update:light':   { name: 'LIGHT_UPDATE',   schema: {}, partial: true },
  'update:nvr':     { name: 'NVR_UPDATE',     schema: {}, partial: true },
  'update:sensor':  { name: 'SENSOR_UPDATE',  schema: {}, partial: true },
  'update:user':    { name: 'USER_UPDATE',    schema: {}, partial: true },
  'update:viewer':  { name: 'VIEWER_UPDATE',  schema: {}, partial: true },

  'remove:event':   { name: 'EVENT_REMOVE',   schema: {}, partial: true },
};

// ---- Schema validation helpers ----

// Get the effective type of a value (distinguishes "array" from "object").
export function effectiveType(value: unknown): string {

  if(Array.isArray(value)) {

    return 'array';
  }

  return typeof value;
}

// Resolve a dotted path on an object, returning undefined if any segment is missing.
export function resolvePath(obj: Record<string, unknown>, path: string): unknown {

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

// Validate an object against a schema definition. Returns a list of issues found.
export function validateSchema(data: Record<string, unknown>, schema: SchemaDefinition, prefix = ''): SchemaIssue[] {

  const issues: SchemaIssue[] = [];

  // Check all defined fields.
  for(const [field, spec] of Object.entries(schema)) {

    const value = resolvePath(data, field);

    if(value === undefined || value === null) {

      if(spec.required) {

        issues.push({ detail: `Expected ${spec.type}, got undefined`, field: prefix + field, issue: 'missing_required' });
      }

      continue;
    }

    const actual = effectiveType(value);

    if(!spec.type.split('|').includes(actual)) {

      issues.push({ detail: `Expected ${spec.type}, got ${actual}`, field: prefix + field, issue: 'type_mismatch' });
    }
  }

  // Check for unexpected top-level fields (only for flat schemas, not dotted paths).
  const topLevelExpected = new Set(Object.keys(schema).map(k => k.split('.')[0]));

  for(const key of Object.keys(data)) {

    if(!topLevelExpected.has(key)) {

      issues.push({ detail: `Type: ${effectiveType(data[key])}`, field: prefix + key, issue: 'unexpected_field' });
    }
  }

  return issues;
}

// Extract the structure (keys and types) of an object as a flat map for comparison.
export function extractSchema(obj: Record<string, unknown>, prefix = ''): Record<string, string> {

  const schema: Record<string, string> = {};

  for(const [key, value] of Object.entries(obj)) {

    const fullKey = prefix ? `${prefix}.${key}` : key;

    if(Array.isArray(value)) {

      schema[fullKey] = 'array';

      if(value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {

        Object.assign(schema, extractSchema(value[0] as Record<string, unknown>, `${fullKey}[]`));
      }
    } else if(typeof value === 'object' && value !== null) {

      schema[fullKey] = 'object';
      Object.assign(schema, extractSchema(value as Record<string, unknown>, fullKey));
    } else {

      schema[fullKey] = typeof value;
    }
  }

  return schema;
}

// Compare two schemas and return the differences.
export function schemaDiff(expected: Record<string, string>, actual: Record<string, string>): { added: string[]; removed: string[]; typeChanged: string[] } {

  const added = Object.keys(actual).filter(k => !(k in expected));
  const removed = Object.keys(expected).filter(k => !(k in actual));
  const typeChanged = Object.keys(expected).filter(k => (k in actual) && expected[k] !== actual[k]);

  return { added, removed, typeChanged };
}

// ---- Reference payloads ----

// ProtectEventPacket: a reference event packet for testing.
export const referenceEventPacket: ProtectEventPacket = {

  header: {

    action: 'add',
    id: 'event-unique-id',
    modelKey: 'event',
    newUpdateId: 'update-uuid-001',
  },

  payload: {

    camera: 'camera-001',
    cameraId: 'camera-001',
    detectedAt: 1700000000000,
    end: 0,
    eventId: 'event-001',
    id: 'event-unique-id',
    locked: false,
    metadata: {},
    modelKey: 'event',
    partition: 'default',
    score: 0,
    smartDetectEvents: [],
    smartDetectTypes: [],
    start: 1700000000000,
    thumbnailId: 'thumb-001',
    type: 'motion',
    user: 'user-001',
  } satisfies ProtectEventAdd,
};
