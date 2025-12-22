#!/bin/bash

set -ex
cd -- "$( dirname -- "${BASH_SOURCE[0]}" )"

asdf install nodejs 24.10.0
asdf local nodejs 24.10.0

# convert -density 1200 -resize 256x256 icon.svg icon.png

rm -rf mobb-ai-tracer-*.vsix
rm -rf node_modules
rm -rf out

# We use npm on purpose here as vsce bundler only works with npm.
npm ci
npm run compile
npm run package
