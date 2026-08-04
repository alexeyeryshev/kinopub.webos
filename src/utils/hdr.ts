/**
 * What can and cannot be known about HDR from inside this application.
 *
 * Subtitles are visibly too bright in HDR — confirmed on the TV, where the best of the offered
 * values was 25% for an HDR title against 50-75% for SDR. Choosing that automatically needs a
 * reliable answer to "is this playing in HDR", and the honest position today is that we do not have
 * one:
 *
 * - **The player's `isHDR` badge guesses from the codec.** HEVC is a codec and HDR is a transfer
 *   characteristic; most HEVC content is SDR. It is wrong more often than it is right.
 * - **The `dynamic-range` media query reports a capability, not a mode.** It answers "can this
 *   display show HDR", which on an HDR television is always yes, whatever is currently playing.
 * - **The pinned hls.js does not parse `VIDEO-RANGE`.** Support for it arrived in a later version.
 *   The raw attribute does survive on `level.attrs`, though, because hls.js keeps the whole
 *   `EXT-X-STREAM-INF` attribute list — so *if* the manifest declares it, it is readable.
 * - **The KinoPub API exposes no per-file HDR flag.** `supportHdr` is a device capability; `File`
 *   carries only `codec`, `quality` and dimensions.
 *
 * So this module reads the two signals that might exist and reports them, rather than deciding
 * anything. The diagnostics overlay shows both, which is how we find out whether `VIDEO-RANGE` is
 * present in these manifests. Automatic selection can follow once that question has an answer.
 */

/** Values `VIDEO-RANGE` can take in an HLS master playlist. `PQ` and `HLG` are the HDR ones. */
export type VideoRange = 'SDR' | 'PQ' | 'HLG';

export type DisplayDynamicRange = 'high' | 'standard' | 'unknown';

/**
 * The `VIDEO-RANGE` attribute of a level, if the manifest declared one.
 *
 * Read off `attrs` rather than a typed field: the pinned hls.js has no `videoRange` property, but
 * it does preserve unrecognised attributes from the `EXT-X-STREAM-INF` line.
 */
export function getLevelVideoRange(level: any): VideoRange | undefined {
  const raw = level?.attrs?.['VIDEO-RANGE'] ?? level?.videoRange;

  if (typeof raw !== 'string' || !raw) {
    return undefined;
  }

  const normalized = raw.toUpperCase();

  return normalized === 'SDR' || normalized === 'PQ' || normalized === 'HLG' ? normalized : undefined;
}

/** `PQ` and `HLG` are HDR transfer functions; `SDR` is not; an absent attribute says nothing. */
export function isHdrVideoRange(range?: VideoRange) {
  return range === 'PQ' || range === 'HLG';
}

/**
 * Whether the *display* can show HDR. Deliberately not called `isHdr`: this is a capability, and
 * mistaking it for "HDR is playing right now" would dim SDR subtitles on every HDR television.
 */
export function getDisplayDynamicRange(matchMedia?: (query: string) => { matches: boolean }): DisplayDynamicRange {
  if (!matchMedia) {
    return 'unknown';
  }

  // `video-dynamic-range` is the more specific of the two and is checked first. Both are Media
  // Queries Level 5 and absent from older webOS builds, where a non-matching result is
  // indistinguishable from an unsupported query -- hence `standard` rather than a claim of SDR.
  for (const query of ['(video-dynamic-range: high)', '(dynamic-range: high)']) {
    try {
      if (matchMedia(query)?.matches) {
        return 'high';
      }
    } catch (e) {
      return 'unknown';
    }
  }

  return 'standard';
}

/** Reads the live display capability, or `unknown` outside a browser. */
export function readDisplayDynamicRange(): DisplayDynamicRange {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'unknown';
  }

  return getDisplayDynamicRange((query) => window.matchMedia(query));
}
