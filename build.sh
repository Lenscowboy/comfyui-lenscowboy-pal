#!/bin/bash
# Build PAL Three.js bundle for ComfyUI
# Run from the comfyui-lenscowboy-pal directory
# Requires: npm install (for three.js), npx esbuild

set -e

echo "Building PAL Three.js bundle..."
npx esbuild build/entry.js \
  --bundle \
  --format=iife \
  --global-name=PALViewport \
  --outfile=web/pal_three_bundle.js \
  --minify

echo "Done. Bundle: web/pal_three_bundle.js ($(du -h web/pal_three_bundle.js | cut -f1))"
