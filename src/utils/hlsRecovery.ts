/**
 * Decides whether an hls.js `FRAG_BUFFERED` event is real evidence that the stream which was
 * failing has recovered, and may therefore clear the fatal-error retry budget.
 *
 * This lives apart from the player so the rule can be tested directly. It is subtle in a way that
 * has already caused an infinite retry loop in production, and both failure modes below are
 * silent: the budget simply never runs out, so the player retries forever instead of reporting
 * that it gave up.
 */

/** The shape this needs from an hls.js `Fragment`; `frag.sn` is `number | 'initSegment'`. */
export type RecoveryFragment = {
  sn?: number | string;
  type?: string;
};

export function provesStreamRecovered(frag: RecoveryFragment | undefined, recoveringStream?: string) {
  if (!frag) {
    return false;
  }

  // An init segment proves nothing. hls.js emits FRAG_BUFFERED for it as well, and restarting the
  // loading engine is exactly what refetches one — so accepting it lets recovery manufacture its
  // own proof of success: each retry reloads the init segment, clears the budget it just spent,
  // and goes round again. Captured on an LG G5 as a ~4s loop that never gave up, with `attempts`
  // pinned at 1/6 across 325 failed requests while playback sat at zero frames.
  if (frag.sn === 'initSegment') {
    return false;
  }

  // Main and audio fragments load independently, so only the stream that was failing proves
  // recovery. Without this, a healthy audio fragment would clear the budget the main stream is
  // still burning through.
  if (recoveringStream && frag.type && frag.type !== recoveringStream) {
    return false;
  }

  return true;
}
