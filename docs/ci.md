# Continuous integration workflows

This fork uses GitHub Actions for checks on pull requests and for publishing
installable packages. This document describes what each workflow does and how to
reproduce its checks locally.

> This repository is a fork. GitHub disables Actions on new forks by default, so
> the workflows below only run after Actions is enabled once under
> **Settings → Actions → General**.

## Node.js version

Every workflow builds with Node.js 14, matching `.nvmrc` (`lts/fermium`). This is
a hard requirement rather than a preference: the pinned `react-scripts` 4 /
webpack 4 toolchain fails on Node.js 17 and newer with
`ERR_OSSL_EVP_UNSUPPORTED`. The version is set in one place,
`.github/actions/setup-node-yarn`, which every workflow reuses for the Node.js
setup, the Yarn cache, and `yarn install --frozen-lockfile`.

## `ci.yml` — checks on pull requests and `master`

Runs on every pull request, on pushes to `master`, and on demand. Runs for
superseded commits on the same branch or pull request are cancelled.

| Job                    | What it does                                                                   | Local equivalent                                                |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Lint, format and types | ESLint, Prettier in check mode, `tsc --noEmit`, and the test runner            | `yarn lint && yarn format:check && yarn typecheck && yarn test` |
| Docs links             | Verifies relative links between Markdown files resolve to existing files       | `yarn check:docs`                                               |
| Build and package      | Builds the app, packages the IPKs, checks the installable IPK name, uploads it | `yarn build && yarn package`                                    |

Notes:

- The type check runs separately from the build because `tsc --noEmit` reports
  type errors in about a minute, while `yarn build` only reaches them after a
  full webpack build.
- There are no test files yet. The test step uses `--passWithNoTests`, so added
  tests start running without a workflow change.
- The docs link check (`scripts/check-docs-links.js`) is plain Node.js with no
  dependencies and requests no external URLs; it only resolves relative links on
  disk. It exists because the documentation here cross-references itself
  (`README.md` → `docs/`, `ROADMAP.md` → the diagnostics documents), and a moved
  file otherwise breaks those links silently.
- The build job fails if `out/kinopub.webos_v<version>.ipk` is missing, since
  that is the exact file the install instructions point at (`ares-install` takes
  the version-named package, and `scripts/package.js` derives the name from
  `package.json`).
- Packages are uploaded as the `ipk-packages` artifact and kept for 14 days, so a
  build from a pull request can be installed on a TV without building locally.

## No public web deployment

There is deliberately no workflow that publishes the built app to the web. One
existed (`deploy-pages.yml`, building `master` to the `gh-pages` branch) and was
removed: nobody used it, and the built bundle carries this fork's Sentry DSN, so
every anonymous visitor's playback errors were charged to a project meant for one
television. A public ingest endpoint that nothing depends on is cost without
benefit.

An inherited `netlify.toml` was removed for the same reason. It was inert unless
someone connected the repository to a Netlify account, but it would have
published the same bundle with the same consequence, and a loaded configuration
nobody uses is worse than no configuration at all.

A web build is still wanted eventually, as a way to reproduce playback problems
somewhere with real developer tools — see the roadmap. It needs the Sentry
initialisation in `src/utils/logging.ts` gated on the webOS runtime first, so
only the TV app reports.

## `release.yml` — packages attached to a release

Runs when a release is published, and can also be run manually against an
existing tag. It checks out the released tag, builds, packages, and uploads every
IPK to that release with `gh release upload --clobber`.

Before building, it checks that the tag matches the `package.json` version. IPK
names come from `package.json`, not from the tag, so a mismatch would publish
assets named after a different version than the release.

## `release-drafter.yml` and `pr-labeler.yml` — release notes

`release-drafter.yml` keeps a draft release up to date from merged pull requests,
grouped into categories by label according to `.github/release-drafter.yml`.

`pr-labeler.yml` supplies those labels. It applies one of `feature`, `fix`,
`documentation`, or `chore` to each pull request, derived in this order:

1. a conventional-commit title prefix (`fix:`, `feat(player):`, …);
2. a change that touches only Markdown files, which is labeled `documentation`;
3. the leading verb of the title, matching the imperative style used here
   ("Add …" → `feature`, "Fix …" → `fix`, "Document …" → `documentation`,
   "Bump …" → `chore`);
4. a keyword in the branch name.

If a category label is already present, the workflow checks who applied it (via
the issue's `labeled` timeline events) before touching anything:

- a label added by a person is left alone, so a manual choice is never
  overwritten;
- a label the workflow applied itself on an earlier run is recomputed, so a
  pull request that started as documentation-only and later gained code moves
  from `documentation` to `feature` instead of staying stuck.

If no rule matches, the pull request is left unlabeled and its entry appears in
the uncategorized part of the draft release.

The workflow uses `pull_request_target` because labeling needs a writable
`issues: write` token. It never checks out or runs code from the pull request;
it only calls the API.
