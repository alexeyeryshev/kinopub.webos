type LevelLike = {
  width?: number;
  height?: number;
};

function getPositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Normalizes an HLS level to the quality name it corresponds to, e.g. `1080`.
 *
 * `level.height` alone is not that name: it only matches for 16:9 content. A
 * 2.39:1 encode advertises 3840x1606 / 1920x804 / 1280x536 / 854x302 for what
 * the API calls 2160p / 1080p / 720p / 480p, so the advertised height is far
 * below the nominal quality. The width implies the nominal height for such
 * letterboxed encodes, while `height` stays correct for 4:3 and taller
 * content, so the larger of the two is the quality this level really is.
 */
export function getLevelQualityHeight(level: LevelLike) {
  const height = getPositiveNumber(level?.height);
  const width = getPositiveNumber(level?.width);
  const widthImpliedHeight = width ? Math.round((width * 9) / 16) : 0;

  return Math.max(height, widthImpliedHeight);
}

/**
 * Resolves the index of the HLS level that best matches a source-track name
 * such as `1080p`.
 *
 * Matching is nearest-normalized-height rather than exact so that a fixed
 * quality choice always lands on a deterministic level, even when the manifest
 * advertises resolutions that do not line up with the API quality names.
 * Returns -1 when there is nothing sensible to match against.
 */
export function findLevelIndexForQuality(levels: readonly LevelLike[] | undefined, qualityName: string) {
  const targetHeight = parseInt(qualityName);

  if (!levels?.length || isNaN(targetHeight)) {
    return -1;
  }

  let bestIndex = -1;
  let bestDistance = Infinity;

  levels.forEach((level, index) => {
    const levelHeight = getLevelQualityHeight(level);

    if (!levelHeight) {
      return;
    }

    const distance = Math.abs(levelHeight - targetHeight);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}
