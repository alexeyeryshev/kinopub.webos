import { DECODE_MIN_FRAMES, DecodeSample, evaluateDecodeHealth, pruneSamples, pruneTimestamps, worstOf } from './decodeHealth';

const NOW = 1_700_000_000_000;

/** A window of clean playback at `fps`, with `dropped` frames lost across it. */
function window(seconds: number, fps: number, dropped: number, startTotal = 0, startDropped = 0): DecodeSample[] {
  return [
    { at: NOW - seconds * 1000, totalVideoFrames: startTotal, droppedVideoFrames: startDropped },
    { at: NOW, totalVideoFrames: startTotal + seconds * fps, droppedVideoFrames: startDropped + dropped },
  ];
}

describe('evaluateDecodeHealth', () => {
  it('reports ok for clean playback', () => {
    const health = evaluateDecodeHealth(window(30, 24, 0), [], NOW);

    expect(health.severity).toBe('ok');
    expect(health.totalFrames).toBe(720);
    expect(health.droppedRatio).toBe(0);
  });

  it('stays ok below the warning ratio', () => {
    // 5 dropped of 720 is 0.7%, under the 1% warning line.
    expect(evaluateDecodeHealth(window(30, 24, 5), [], NOW).severity).toBe('ok');
  });

  it('warns at the warning ratio', () => {
    // 10 of 720 is 1.4%.
    const health = evaluateDecodeHealth(window(30, 24, 10), [], NOW);

    expect(health.severity).toBe('warning');
    expect(health.droppedRatio).toBeCloseTo(0.0139, 3);
  });

  it('escalates to severe at the severe ratio', () => {
    // 50 of 720 is 6.9%.
    expect(evaluateDecodeHealth(window(30, 24, 50), [], NOW).severity).toBe('severe');
  });

  it('normalises across frame rates, unlike a raw count', () => {
    // The same 5 dropped frames: harmless at both rates, and the ratio says so.
    expect(evaluateDecodeHealth(window(30, 24, 5), [], NOW).severity).toBe('ok');
    expect(evaluateDecodeHealth(window(30, 60, 5), [], NOW).severity).toBe('ok');

    // ...while the same *ratio* trips at both rates.
    expect(evaluateDecodeHealth(window(30, 24, 40), [], NOW).severity).toBe('severe');
    expect(evaluateDecodeHealth(window(30, 60, 100), [], NOW).severity).toBe('severe');
  });

  it('ignores the ratio until enough frames have been rendered', () => {
    // Two dropped of four would be 50%, but four frames prove nothing.
    const samples: DecodeSample[] = [
      { at: NOW - 1000, totalVideoFrames: 0, droppedVideoFrames: 0 },
      { at: NOW, totalVideoFrames: 4, droppedVideoFrames: 2 },
    ];

    const health = evaluateDecodeHealth(samples, [], NOW);

    expect(health.totalFrames).toBeLessThan(DECODE_MIN_FRAMES);
    expect(health.severity).toBe('ok');
  });

  it('treats a single hard decode error as a warning', () => {
    const health = evaluateDecodeHealth(window(30, 24, 0), [NOW - 5000], NOW);

    expect(health.severity).toBe('warning');
    expect(health.decodeErrors).toBe(1);
  });

  it('treats repeated hard decode errors as severe', () => {
    expect(evaluateDecodeHealth(window(30, 24, 0), [NOW - 9000, NOW - 6000, NOW - 3000], NOW).severity).toBe('severe');
  });

  it('ignores decode errors that have aged out of the window', () => {
    const health = evaluateDecodeHealth(window(30, 24, 0), [NOW - 120000], NOW);

    expect(health.decodeErrors).toBe(0);
    expect(health.severity).toBe('ok');
  });

  it('reports errors even before any frames have been sampled', () => {
    const health = evaluateDecodeHealth([], [NOW - 1000, NOW - 500, NOW], NOW);

    expect(health.severity).toBe('severe');
    expect(health.decodeErrors).toBe(3);
  });

  it('does not compare across a counter reset', () => {
    // Loading a new source restarts the element's counters; the delta would go negative and read
    // as a huge dropped ratio.
    const samples: DecodeSample[] = [
      { at: NOW - 20000, totalVideoFrames: 90000, droppedVideoFrames: 10 },
      { at: NOW, totalVideoFrames: 300, droppedVideoFrames: 0 },
    ];

    const health = evaluateDecodeHealth(samples, [], NOW);

    expect(health.severity).toBe('ok');
    expect(health.totalFrames).toBe(0);
  });
});

describe('pruneSamples', () => {
  it('keeps one sample from before the cutoff so a delta spans the whole window', () => {
    const samples: DecodeSample[] = [
      { at: NOW - 90000, totalVideoFrames: 0, droppedVideoFrames: 0 },
      { at: NOW - 40000, totalVideoFrames: 100, droppedVideoFrames: 0 },
      { at: NOW - 20000, totalVideoFrames: 200, droppedVideoFrames: 1 },
      { at: NOW, totalVideoFrames: 300, droppedVideoFrames: 2 },
    ];

    const pruned = pruneSamples(samples, NOW);

    expect(pruned).toHaveLength(3);
    expect(pruned[0].at).toBe(NOW - 40000);
  });

  it('keeps the newest sample when everything has aged out', () => {
    const samples: DecodeSample[] = [
      { at: NOW - 300000, totalVideoFrames: 0, droppedVideoFrames: 0 },
      { at: NOW - 200000, totalVideoFrames: 100, droppedVideoFrames: 0 },
    ];

    expect(pruneSamples(samples, NOW)).toEqual([samples[1]]);
  });

  it('leaves a fully in-window list alone', () => {
    const samples = window(10, 24, 0);

    expect(pruneSamples(samples, NOW)).toBe(samples);
  });
});

describe('pruneTimestamps', () => {
  it('drops timestamps older than the window', () => {
    expect(pruneTimestamps([NOW - 60000, NOW - 10000, NOW], NOW)).toEqual([NOW - 10000, NOW]);
  });
});

describe('worstOf', () => {
  it('picks the more severe of two levels', () => {
    expect(worstOf('ok', 'warning')).toBe('warning');
    expect(worstOf('severe', 'warning')).toBe('severe');
    expect(worstOf('ok', 'ok')).toBe('ok');
  });
});
