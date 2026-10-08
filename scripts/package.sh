#!/bin/sh
set -eu

cd -- "$(dirname -- "$0")/.."
glib-compile-schemas --strict --dry-run schemas
mkdir -p dist
gnome-extensions pack . --force --out-dir dist \
    --extra-source=config.js \
    --extra-source=writer.js \
    --extra-source=wsf.js \
    --extra-source=preferences.js \
    --extra-source=LICENSE
