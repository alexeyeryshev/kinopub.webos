/**
 * Checks that relative links between Markdown files point at files that exist.
 *
 * The documentation in this repository cross-references itself (README -> docs,
 * ROADMAP -> diagnostics documents), and a renamed or moved file breaks those
 * links silently. External URLs are not requested; only links resolved on disk
 * are checked, so the check needs no network and no dependencies.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'build', 'out', 'dist', 'coverage', 'resources']);
const EXTERNAL_LINK = /^(https?:|mailto:|tel:|data:|#|\/\/)/i;
const INLINE_LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const REFERENCE_LINK = /^\s*\[[^\]]+\]:\s*(\S+)/gm;

function collectMarkdownFiles(directory) {
  const found = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        found.push(...collectMarkdownFiles(fullPath));
      }
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      found.push(fullPath);
    }
  }

  return found;
}

function collectLinks(contents) {
  const links = [];

  for (const pattern of [INLINE_LINK, REFERENCE_LINK]) {
    pattern.lastIndex = 0;

    let match = pattern.exec(contents);

    while (match) {
      links.push(match[1]);
      match = pattern.exec(contents);
    }
  }

  return links;
}

function checkFile(file) {
  const contents = fs.readFileSync(file, 'utf8');
  const problems = [];

  for (const link of collectLinks(contents)) {
    if (EXTERNAL_LINK.test(link)) {
      continue;
    }

    // Anchors and query strings are not resolved on disk, only the file part.
    const target = link.split('#')[0].split('?')[0];

    if (!target) {
      continue;
    }

    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));

    if (!fs.existsSync(resolved)) {
      problems.push({ file: path.relative(ROOT, file), link });
    }
  }

  return problems;
}

const problems = collectMarkdownFiles(ROOT).flatMap(checkFile);

if (problems.length) {
  console.error(`Found ${problems.length} broken relative link(s) in Markdown files:`);

  for (const problem of problems) {
    console.error(`  ${problem.file}: ${problem.link}`);
  }

  process.exit(1);
}

console.log('All relative links in Markdown files resolve to existing files.');
