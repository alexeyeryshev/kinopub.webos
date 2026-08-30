const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const pkg = require('../package.json');

/**
 * Installs a package on a TV - the scripted equivalent of dropping an .ipk onto webOS Dev Manager.
 *
 * Installing goes through @webos-tools/cli rather than the @webosose/ares-cli used for packaging:
 * the OSE build expects a different permission layout and fails on a retail TV with
 * "rm: can't remove '/media/developer/temp': Permission denied".
 * Both packages expose identically named ares-* binaries in node_modules/.bin, so this resolves
 * the TV CLI by full path instead of relying on whichever one won.
 */

const APP_IDS = [pkg.name, 'netflix', 'amazon', 'ivi', 'youtube', 'ui30'];

/**
 * Readable names for the remote-button app ids - the id alone gives no hint which button it binds to.
 * ui30 is Rakuten TV
 */
const TARGET_ALIASES = { rakuten: 'ui30' };

const outDir = path.resolve(__dirname, '..', 'out');
const tvCliBin = (name) => path.resolve(__dirname, '..', 'node_modules', '@webos-tools', 'cli', 'bin', `${name}.js`);

function parseArgs(argv) {
  const args = { target: pkg.name, device: null, launch: false, release: null, repo: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--launch') {
      args.launch = true;
    } else if (arg === '--target' || arg === '-t') {
      args.target = argv[++i];
    } else if (arg === '--device' || arg === '-d') {
      args.device = argv[++i];
    } else if (arg === '--release') {
      // no value means the latest release
      const next = argv[i + 1];

      args.release = next && !next.startsWith('-') ? argv[++i] : 'latest';
    } else if (arg === '--repo') {
      args.repo = argv[++i];
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

function run(bin, args) {
  return execFileSync(process.execPath, [tvCliBin(bin), ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
}

// --list prints an empty table even when devices exist, so parse --listfull instead
function listDevices() {
  try {
    const output = run('ares-setup-device', ['--listfull']);
    const devices = JSON.parse(output.slice(output.indexOf('[')));

    return Array.isArray(devices) ? devices : [];
  } catch (ex) {
    return [];
  }
}

/**
 * Where releases live: the flag, then the current branch's remote (usually the fork releases are
 * published from), then the repository field in package.json
 */
function resolveRepo(explicit) {
  if (explicit) {
    return explicit;
  }

  const fromGit = () => {
    const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const remote = git(['config', `branch.${branch}.remote`]);

    return git(['remote', 'get-url', remote]);
  };

  let url;

  try {
    url = fromGit();
  } catch (ex) {
    url = pkg.repository;
  }

  // the repository name itself contains a dot, so only a trailing .git may be stripped
  const match = String(url).match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);

  if (!match) {
    throw new Error(`Could not work out the release repository from "${url}", pass --repo owner/name`);
  }

  return `${match[1]}/${match[2]}`;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': pkg.name, Accept: 'application/vnd.github+json' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub responded ${res.statusCode} for ${url}`));
          return;
        }

        let body = '';

        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': pkg.name, Accept: 'application/octet-stream' } }, (res) => {
        // asset links redirect to storage
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Could not download the package: ${res.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(dest);

        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function resolveReleaseIpk(release, repo, suffix) {
  const source = resolveRepo(repo);
  const url =
    release === 'latest'
      ? `https://api.github.com/repos/${source}/releases/latest`
      : `https://api.github.com/repos/${source}/releases/tags/${release}`;

  console.log(`Looking for release ${release} in ${source}...`);

  const data = await requestJson(url);
  const name = `${pkg.name}_${data.tag_name}${suffix}.ipk`;
  const asset = (data.assets || []).find((item) => item.name === name);

  if (!asset) {
    const available = (data.assets || []).map((item) => item.name).join(', ') || 'no files';

    throw new Error(`Release ${data.tag_name} has no ${name}. Available: ${available}`);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const dest = path.resolve(outDir, name);

  console.log(`Downloading ${name}...`);

  return download(asset.browser_download_url, dest);
}

async function main() {
  const { target: requestedTarget, device, launch, release, repo } = parseArgs(process.argv.slice(2));
  const target = TARGET_ALIASES[requestedTarget] || requestedTarget;

  if (!APP_IDS.includes(target)) {
    const known = [...APP_IDS, ...Object.keys(TARGET_ALIASES)];

    console.error(`Unknown target "${requestedTarget}". Available: ${known.join(', ')}`);
    process.exit(1);
  }

  const suffix = target === pkg.name ? '' : `_${target}`;
  const ipk = release ? await resolveReleaseIpk(release, repo, suffix) : path.resolve(outDir, `${pkg.name}_v${pkg.version}${suffix}.ipk`);

  if (!fs.existsSync(ipk)) {
    console.error(`Not found: ${path.relative(process.cwd(), ipk)}`);
    console.error('Build it with: yarn build && yarn package - or install a published one: yarn deploy --release');
    process.exit(1);
  }

  if (!listDevices().length) {
    console.error('No devices are registered.');
    console.error('Enable Developer Mode and its key server on the TV, then run once:');
    console.error('');
    console.error("  npx ares-setup-device --add tv --info \"{'host':'<TV IP>','port':'9922','username':'prisoner'}\"");
    console.error('  npx ares-novacom --device tv --getkey');
    console.error('');
    console.error('The second command asks for the passphrase shown in the Developer Mode app.');
    process.exit(1);
  }

  const deviceArgs = device ? ['-d', device] : [];

  console.log(`Installing ${path.basename(ipk)}${device ? ` on ${device}` : ''}...`);
  process.stdout.write(run('ares-install', [...deviceArgs, ipk]));

  if (launch) {
    console.log(`Launching ${target}...`);
    process.stdout.write(run('ares-launch', [...deviceArgs, target]));
  }
}

main().catch((ex) => {
  console.error(ex.stderr || ex.message);
  process.exit(1);
});
