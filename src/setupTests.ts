import { installMediaSourceStub } from './testing/mediaSource';

// Runs before every test file is required, which is the only ordering that works: hls.js resolves
// the global `MediaSource` once, at module-evaluation time.
installMediaSourceStub();
