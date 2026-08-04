import { provesStreamRecovered } from './hlsRecovery';

describe('provesStreamRecovered', () => {
  it('accepts a media fragment on the stream that was failing', () => {
    expect(provesStreamRecovered({ sn: 57, type: 'main' }, 'main')).toBe(true);
  });

  it('accepts any media fragment when no stream is being recovered', () => {
    expect(provesStreamRecovered({ sn: 12, type: 'audio' }, undefined)).toBe(true);
  });

  it('rejects an init segment', () => {
    // The regression this guards: recovery restarts the loading engine, which
    // refetches the init segment, so accepting it would let recovery clear the
    // budget it just spent and retry forever.
    expect(provesStreamRecovered({ sn: 'initSegment', type: 'main' }, 'main')).toBe(false);
  });

  it('rejects an init segment even when nothing is being recovered', () => {
    expect(provesStreamRecovered({ sn: 'initSegment', type: 'main' }, undefined)).toBe(false);
  });

  it('rejects a fragment from a different stream than the one recovering', () => {
    expect(provesStreamRecovered({ sn: 59, type: 'audio' }, 'main')).toBe(false);
  });

  it('rejects a missing fragment', () => {
    expect(provesStreamRecovered(undefined, 'main')).toBe(false);
  });

  it('accepts a fragment with no type, since there is nothing to contradict', () => {
    expect(provesStreamRecovered({ sn: 3 }, 'main')).toBe(true);
  });

  it('does not let an init-segment reload refill the budget across retry cycles', () => {
    // Replays the loop captured on the LG G5: each fatal error spends one
    // attempt, recovery restarts loading, the init segment buffers, and the
    // media fragment fails again. The budget must keep draining.
    const limit = 6;
    let attempts = 0;

    for (let cycle = 0; cycle < limit; cycle += 1) {
      attempts += 1;

      // startLoad() refetches the init segment; it must not reset anything.
      if (provesStreamRecovered({ sn: 'initSegment', type: 'main' }, 'main')) {
        attempts = 0;
      }
    }

    expect(attempts).toBe(limit);
  });

  it('lets a real media fragment refill the budget', () => {
    let attempts = 4;

    if (provesStreamRecovered({ sn: 58, type: 'main' }, 'main')) {
      attempts = 0;
    }

    expect(attempts).toBe(0);
  });
});
