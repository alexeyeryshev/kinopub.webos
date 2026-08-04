import { getDisplayDynamicRange, getLevelVideoRange, isHdrVideoRange } from './hdr';

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
