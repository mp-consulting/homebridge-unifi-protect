/* Copyright(C) 2019-2026, Mickael Palma / MP Consulting. Licensed under the MIT License.
 *
 * livestream-index.test.ts: Tests for the livestream connection pooling index logic from protect-livestream.ts.
 *
 * The getIndex() method determines how livestream connections are pooled by channel/lens.
 */

// Reproduction of getIndex from LivestreamManager.
function getIndex(rtspEntry: { channel: { id: number }; lens?: number }): { channel: number; index: string; lens: number | undefined } {

  const channel = (rtspEntry.lens === undefined) ? rtspEntry.channel.id : 0;
  const lens = rtspEntry.lens;

  return { channel, index: channel.toString() + ((lens !== undefined) ? '.' + lens.toString() : ''), lens };
}

describe('LivestreamManager getIndex', () => {

  describe('standard channels (no lens)', () => {

    it('uses channel id directly for channel 0', () => {

      const result = getIndex({ channel: { id: 0 } });

      expect(result.channel).toBe(0);
      expect(result.index).toBe('0');
      expect(result.lens).toBeUndefined();
    });

    it('uses channel id directly for channel 1', () => {

      const result = getIndex({ channel: { id: 1 } });

      expect(result.channel).toBe(1);
      expect(result.index).toBe('1');
      expect(result.lens).toBeUndefined();
    });

    it('uses channel id directly for channel 2', () => {

      const result = getIndex({ channel: { id: 2 } });

      expect(result.channel).toBe(2);
      expect(result.index).toBe('2');
      expect(result.lens).toBeUndefined();
    });
  });

  describe('secondary lens entries', () => {

    it('forces channel to 0 when lens is specified', () => {

      const result = getIndex({ channel: { id: 3 }, lens: 1 });

      expect(result.channel).toBe(0);
      expect(result.index).toBe('0.1');
      expect(result.lens).toBe(1);
    });

    it('uses lens 0', () => {

      const result = getIndex({ channel: { id: 2 }, lens: 0 });

      expect(result.channel).toBe(0);
      expect(result.index).toBe('0.0');
      expect(result.lens).toBe(0);
    });

    it('handles high lens numbers', () => {

      const result = getIndex({ channel: { id: 1 }, lens: 5 });

      expect(result.channel).toBe(0);
      expect(result.index).toBe('0.5');
      expect(result.lens).toBe(5);
    });
  });

  describe('index uniqueness', () => {

    it('produces unique indices for different channels without lens', () => {

      const idx0 = getIndex({ channel: { id: 0 } });
      const idx1 = getIndex({ channel: { id: 1 } });
      const idx2 = getIndex({ channel: { id: 2 } });

      const indices = new Set([idx0.index, idx1.index, idx2.index]);

      expect(indices.size).toBe(3);
    });

    it('produces unique indices for different lenses', () => {

      const idx0 = getIndex({ channel: { id: 0 }, lens: 0 });
      const idx1 = getIndex({ channel: { id: 0 }, lens: 1 });
      const idx2 = getIndex({ channel: { id: 0 }, lens: 2 });

      const indices = new Set([idx0.index, idx1.index, idx2.index]);

      expect(indices.size).toBe(3);
    });

    it('produces unique indices between lens and non-lens entries', () => {

      const noLens = getIndex({ channel: { id: 0 } });
      const withLens = getIndex({ channel: { id: 0 }, lens: 1 });

      expect(noLens.index).not.toBe(withLens.index);
    });
  });
});
