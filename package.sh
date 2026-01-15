#!/bin/bash

set -ex
cd -- "$( dirname -- "${BASH_SOURCE[0]}" )"

asdf install nodejs 24.10.0
asdf local nodejs 24.10.0

# convert -density 1200 -resize 256x256 icon.svg icon.png

rm -rf mobb-ai-tracer-*.vsix
rm -rf node_modules
rm -rf out

# We use npm (not pnpm) because vsce bundler only works with npm.
# We use `npm install` (not `npm ci`) because package-lock.json is gitignored.
# This is intentional: we rely on pinned versions in package.json and the root
# pnpm-lock.yaml for reproducibility. Committing package-lock.json causes issues
# with native optional dependencies (like @node-rs/crc32) which are platform-specific
# - a lock file generated on macOS won't include Linux binaries, breaking CI builds.
npm install
npm run compile
npm run package
