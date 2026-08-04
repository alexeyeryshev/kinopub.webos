/**
 * Shared categorisation of hls.js `ERROR` events.
 *
 * Both the diagnostics overlay and the decode-health indicator classify failures, and they have to
 * agree: an indicator warning about the decoder while the overlay reports `media/decode: 0` would
 * be worse than no indicator at all.
 */

export type FailureCategory = 'network' | 'buffer' | 'media' | 'other';

/**
 * hls.js reports buffer-starvation symptoms as MEDIA_ERROR because they surface through the media
 * element, so they must be matched by `details` before falling back to `type`.
 *
 * `bufferFullError` is deliberately absent: it is a SourceBuffer quota-exceeded/append-capacity
 * failure — the buffer is too full to append, the opposite condition from starvation — so it falls
 * through to the media/decode category instead.
 */
export const BUFFER_STARVATION_DETAILS = new Set(['bufferStalledError', 'bufferSeekOverHole', 'bufferNudgeOnStall']);

export function getFailureCategory(data: any): FailureCategory {
  const details = typeof data?.details === 'string' ? data.details : undefined;

  if (details && BUFFER_STARVATION_DETAILS.has(details)) {
    return 'buffer';
  }

  if (data?.type === 'networkError') {
    return 'network';
  }

  if (data?.type === 'mediaError' || data?.type === 'muxError') {
    return 'media';
  }

  return 'other';
}

export function formatCategoryLabel(category: FailureCategory) {
  switch (category) {
    case 'network':
      return 'network failure';
    case 'buffer':
      return 'buffer starvation';
    case 'media':
      return 'media/decode failure';
    default:
      return 'other failure';
  }
}
