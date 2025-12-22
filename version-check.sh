#!/bin/bash

set -e
cd -- "$( dirname -- "${BASH_SOURCE[0]}" )"
BASE_DIR=$PWD

NAME=$(cat $BASE_DIR/package.json | jq -r .name)
VERSION=$(cat $BASE_DIR/package.json | jq -r .version)

git fetch origin main

if ! git diff --quiet HEAD origin/main -- $BASE_DIR; then
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-filesize 1 \
    "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/Mobb/vsextensions/mobb-ai-tracer/${VERSION}/vspackage?api-version=7.1-preview.1" || true)

  echo "STATUS=$STATUS"
  if [ "$STATUS" == "200" ]; then
    echo "$NAME@$VERSION already published in marketplace.visualstudio.com. Did you forget to update?"
    exit 1
  fi
fi
