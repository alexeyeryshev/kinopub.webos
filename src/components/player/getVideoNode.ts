import { VideoPlayerBase } from '@enact/moonstone/VideoPlayer';

import { MediaRef } from 'components/media';

type VideoPlayerWithNode = {
  getVideoNode: () => MediaRef;
};

export function getVideoNode(player?: VideoPlayerBase): MediaRef | undefined {
  return (player as unknown as VideoPlayerWithNode | undefined)?.getVideoNode();
}
