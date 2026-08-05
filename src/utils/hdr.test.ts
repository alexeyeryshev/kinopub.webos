import { getDisplayDynamicRange, getLevelVideoRange, getStreamVideoRange, isHdrVideoRange } from './hdr';

describe('getLevelVideoRange', () => {
  it('reads the attribute hls.js preserves but does not parse', () => {
    // The pinned hls.js has no `videoRange` property; the raw attribute survives on `attrs`.
    expect(getLevelVideoRange({ attrs: { 'VIDEO-RANGE': 'PQ' } })).toBe('PQ');
    expect(getLevelVideoRange({ attrs: { 'VIDEO-RANGE': 'HLG' } })).toBe('HLG');
    expect(getLevelVideoRange({ attrs: { 'VIDEO-RANGE': 'SDR' } })).toBe('SDR');
  });

  it('accepts a typed field too, in case the runtime is ever upgraded', () => {
    expect(getLevelVideoRange({ videoRange: 'PQ' })).toBe('PQ');
  });

  it('normalises case', () => {
    expect(getLevelVideoRange({ attrs: { 'VIDEO-RANGE': 'pq' } })).toBe('PQ');
  });

  it('says nothing when the manifest declares nothing', () => {
    // The common case for these manifests, and the reason this cannot drive behaviour yet.
    expect(getLevelVideoRange({ attrs: {} })).toBeUndefined();
    expect(getLevelVideoRange({})).toBeUndefined();
    expect(getLevelVideoRange(undefined)).toBeUndefined();
    expect(getLevelVideoRange({ attrs: { 'VIDEO-RANGE': '' } })).toBeUndefined();
  });

  it('refuses a value it does not recognise rather than guessing', () => {
    expect(getLevelVideoRange({ attrs: { 'VIDEO-RANGE': 'DOLBYVISION' } })).toBeUndefined();
  });
});

describe('getStreamVideoRange', () => {
  const hdr = { attrs: { 'VIDEO-RANGE': 'PQ' } };
  const sdr = { attrs: { 'VIDEO-RANGE': 'SDR' } };
  const undeclared = { attrs: {} };

  it('prefers the level actually playing', () => {
    expect(getStreamVideoRange([sdr, hdr], 1)).toBe('PQ');
    expect(getStreamVideoRange([hdr, sdr], 1)).toBe('SDR');
  });

  it('falls back to the first declaration before a level has been chosen', () => {
    // Auto mode leaves `currentLevel` at -1 until hls.js picks one, and levels arrive a moment
    // after playback starts. Showing nothing for those seconds would flicker the badge and seed the
    // wrong subtitle default.
    expect(getStreamVideoRange([undeclared, hdr], -1)).toBe('PQ');
    expect(getStreamVideoRange([undeclared, hdr], undefined)).toBe('PQ');
  });

  it('does not borrow a range from a sibling once a level is playing', () => {
    // This test previously asserted the opposite and so locked in a bug. A master playlist here can
    // genuinely mix transfer functions -- `mixedPlaylist` builds an HLS4 playlist from all
    // available AVC+HEVC files -- so answering `PQ` because *some other* variant declares it would
    // dim subtitles to the HDR default and light the HDR badge while an SDR level plays.
    expect(getStreamVideoRange([hdr, undeclared], 1)).toBeUndefined();
    expect(getStreamVideoRange([hdr, sdr], 1)).toBe('SDR');
  });

  it('says nothing when no level declares anything', () => {
    expect(getStreamVideoRange([undeclared, undeclared], 0)).toBeUndefined();
    expect(getStreamVideoRange([], 0)).toBeUndefined();
    expect(getStreamVideoRange(undefined, 0)).toBeUndefined();
  });

  it('does not fall over on an out-of-range level index', () => {
    expect(getStreamVideoRange([hdr], 7)).toBe('PQ');
  });
});

describe('isHdrVideoRange', () => {
  it('counts the HDR transfer functions and nothing else', () => {
    expect(isHdrVideoRange('PQ')).toBe(true);
    expect(isHdrVideoRange('HLG')).toBe(true);
    expect(isHdrVideoRange('SDR')).toBe(false);
    // Absent is not the same as SDR: it means the manifest did not say.
    expect(isHdrVideoRange(undefined)).toBe(false);
  });
});

describe('getDisplayDynamicRange', () => {
  it('reports the display capability when the query is supported', () => {
    expect(getDisplayDynamicRange((query) => ({ matches: query === '(video-dynamic-range: high)' }))).toBe('high');
    expect(getDisplayDynamicRange((query) => ({ matches: query === '(dynamic-range: high)' }))).toBe('high');
  });

  it('reports standard when the queries run and do not match', () => {
    expect(getDisplayDynamicRange(() => ({ matches: false }))).toBe('standard');
  });

  it('reports unknown rather than standard when it cannot ask', () => {
    // Older webOS has no Media Queries Level 5, and an unsupported query is indistinguishable from
    // a genuine non-match. Claiming SDR there would be inventing an answer.
    expect(getDisplayDynamicRange(undefined)).toBe('unknown');
    expect(
      getDisplayDynamicRange(() => {
        throw new Error('unsupported');
      }),
    ).toBe('unknown');
  });
});
