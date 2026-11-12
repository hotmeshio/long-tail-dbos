#!/usr/bin/env sh
# Packs the sibling long-tail checkout into vendor/ for the image build.
# Once @hotmeshio/long-tail 0.35.0 is on npm, the Dockerfile installs it from the registry instead.
set -e
cd "$(dirname "$0")/.."
rm -f vendor/hotmeshio-long-tail-*.tgz
npm pack ../long-tail --pack-destination vendor >/dev/null
ls vendor/hotmeshio-long-tail-*.tgz
