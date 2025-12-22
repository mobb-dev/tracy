#!/bin/bash

set -ex
cd -- "$( dirname -- "${BASH_SOURCE[0]}" )"

./package.sh
npm run publish:microsoft
npm run publish:openvsx
