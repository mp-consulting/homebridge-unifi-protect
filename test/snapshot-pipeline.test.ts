/* Copyright(C) 2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * snapshot-pipeline.test.ts: Tests for the snapshot source budgeting and in-flight coalescing in protect-snapshot.ts.
 *
 * HomeKit gives us a hard five second window to answer a snapshot request. These tests exercise how ProtectSnapshot divides that window between its sources,
 * and how it collapses concurrent requests for the same image into a single attempt.
 */
import { PROTECT_SNAPSHOT_FALLBACK_RESERVE, PROTECT_SNAPSHOT_TIMEOUT } from '../src/settings.js';
import { describe, expect, it, vi } from 'vitest';
import type { ProtectCamera } from '../src/devices/index.js';
import { ProtectSnapshot } from '../src/protect-snapshot.js';
import type { SnapshotRequest } from 'homebridge';

// The controller API call our fakes stand in for. We capture the options each call receives so we can assert on the timeout budget handed to it.
type ApiCall = { height?: number, timeout?: number, usePackageCamera?: boolean, width?: number };

// Build a ProtectSnapshot backed by a minimal fake camera. High resolution snapshots are off by default, which short-circuits both FFmpeg-backed sources and
// leaves the controller API as the only source that runs - exactly the configuration that isolates the budgeting logic.
function createSnapshot(options: Partial<{ getSnapshot: (device: unknown, opts: ApiCall) => Promise<Buffer | null>, highResSnapshots: boolean,
  isPackageCamera: boolean }> = {}): { calls: ApiCall[], log: Record<string, ReturnType<typeof vi.fn>>, snapshot: ProtectSnapshot } {

  const calls: ApiCall[] = [];
  const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  const getSnapshot = async (device: unknown, opts: ApiCall): Promise<Buffer | null> => {

    calls.push(opts);

    return options.getSnapshot ? options.getSnapshot(device, opts) : Buffer.from('controller-snapshot');
  };

  const ufpApi = { bootstrap: {}, getSnapshot, isThrottled: false };

  const camera = {

    accessory: { context: options.isPackageCamera ? { packageCamera: {} } : {} },
    api: { hap: {} },
    hints: { crop: false, highResSnapshots: options.highResSnapshots ?? false },
    isOnline: true,
    log,
    nvr: { ufpApi },
    platform: {},
    stream: undefined,
    ufp: { videoCodec: 'h264' },
    ufpApi,
  } as unknown as ProtectCamera;

  return { calls, log, snapshot: new ProtectSnapshot(camera) };
}

// A HomeKit snapshot request at a given size.
function snapshotRequest(width: number, height: number): SnapshotRequest {

  return { height, width } as SnapshotRequest;
}

// A promise we can settle from the outside, so a test can hold a snapshot attempt open while it issues more requests.
function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {

  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));

  return { promise, resolve };
}

describe('Snapshot source budgeting', () => {

  it('gives the controller API the full remaining budget when nothing follows it', async () => {

    const { calls, snapshot } = createSnapshot();

    await expect(snapshot.getSnapshot()).resolves.toEqual(Buffer.from('controller-snapshot'));
    expect(calls).toHaveLength(1);

    // The API is the last source in the chain for a regular camera, so it gets everything that's left - no reserve held back behind it.
    expect(calls[0].timeout).toBeGreaterThan(PROTECT_SNAPSHOT_TIMEOUT - 1000);
    expect(calls[0].timeout).toBeLessThanOrEqual(PROTECT_SNAPSHOT_TIMEOUT);
  });

  it('holds back a reserve for the RTSP fallback on package cameras, where the API runs first', async () => {

    const { calls, snapshot } = createSnapshot({ isPackageCamera: true });

    await expect(snapshot.getSnapshot()).resolves.toEqual(Buffer.from('controller-snapshot'));
    expect(calls).toHaveLength(1);
    expect(calls[0].usePackageCamera).toBe(true);

    // Package cameras try the API first, so it must leave time for the RTSP attempt queued up behind it.
    const expected = PROTECT_SNAPSHOT_TIMEOUT - PROTECT_SNAPSHOT_FALLBACK_RESERVE;

    expect(calls[0].timeout).toBeGreaterThan(expected - 1000);
    expect(calls[0].timeout).toBeLessThanOrEqual(expected);
  });

  it('bounds the API call well inside the overall snapshot budget', async () => {

    const { calls, snapshot } = createSnapshot();

    await snapshot.getSnapshot();

    // The whole point of plumbing a timeout through: the controller call can no longer outlast the deadline we're working against.
    expect(calls[0].timeout).toBeLessThanOrEqual(PROTECT_SNAPSHOT_TIMEOUT);
  });

  it('passes the requested dimensions through to the controller', async () => {

    const { calls, snapshot } = createSnapshot();

    await snapshot.getSnapshot(snapshotRequest(640, 480));

    expect(calls[0].width).toBe(640);
    expect(calls[0].height).toBe(480);
  });
});

describe('Snapshot in-flight coalescing', () => {

  it('collapses concurrent requests for the same dimensions into a single attempt', async () => {

    const gate = deferred<Buffer>();
    const { calls, snapshot } = createSnapshot({ getSnapshot: async (): Promise<Buffer> => gate.promise });

    // Three callers ask for the same image while the first attempt is still in flight.
    const requests = [ snapshot.getSnapshot(snapshotRequest(1920, 1080)), snapshot.getSnapshot(snapshotRequest(1920, 1080)),
      snapshot.getSnapshot(snapshotRequest(1920, 1080)) ];

    gate.resolve(Buffer.from('shared-snapshot'));

    const results = await Promise.all(requests);

    expect(calls).toHaveLength(1);
    expect(results.every((result) => result?.equals(Buffer.from('shared-snapshot')))).toBe(true);
  });

  it('does not collapse requests for different dimensions', async () => {

    const { calls, snapshot } = createSnapshot();

    await Promise.all([ snapshot.getSnapshot(snapshotRequest(1920, 1080)), snapshot.getSnapshot(snapshotRequest(640, 480)) ]);

    // Different sizes are different images - coalescing them would hand a caller something it didn't ask for.
    expect(calls).toHaveLength(2);
  });

  it('releases the in-flight entry so a later request starts fresh work', async () => {

    const { calls, snapshot } = createSnapshot();

    await snapshot.getSnapshot(snapshotRequest(1920, 1080));
    await snapshot.getSnapshot(snapshotRequest(1920, 1080));

    expect(calls).toHaveLength(2);
  });

  it('serves the cached image to every rider when the shared attempt fails', async () => {

    let attempt = 0;

    const { log, snapshot } = createSnapshot({ getSnapshot: async (): Promise<Buffer | null> => (++attempt === 1) ? Buffer.from('cached-me') : null });

    // Prime the cache with a successful request, then fail the next one.
    await expect(snapshot.getSnapshot()).resolves.toEqual(Buffer.from('cached-me'));

    const results = await Promise.all([ snapshot.getSnapshot(), snapshot.getSnapshot() ]);

    expect(results.every((result) => result?.equals(Buffer.from('cached-me')))).toBe(true);
    expect(log.warn).toHaveBeenCalledWith('Unable to retrieve a snapshot: using the most recent cached snapshot instead.');
  });

  it('reports an outright failure when there is no cached image to fall back on', async () => {

    const { log, snapshot } = createSnapshot({ getSnapshot: async (): Promise<Buffer | null> => null });

    await expect(snapshot.getSnapshot()).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith('Unable to retrieve a snapshot.');
  });
});
