#!/bin/bash

set -ex
cd -- "$( dirname -- "${BASH_SOURCE[0]}" )"

asdf install nodejs 24.10.0
asdf local nodejs 24.10.0

# convert -density 1200 -resize 256x256 icon.svg icon.png

rm -rf mobb-ai-tracer-*.vsix
rm -rf out

# Dependencies are installed by pnpm from the monorepo root (pnpm -r install).
# esbuild bundles everything at build time and the VSIX ships with --no-dependencies,
# so a separate npm install is not needed.
npm run compile
npm run package
