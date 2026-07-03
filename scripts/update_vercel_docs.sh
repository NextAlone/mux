#!/usr/bin/env bash

set -e

DOCS_DIR="/tmp/ai-sdk-docs"
TEMP_DIR="$(mktemp -d)"
ARCHIVE_URL="https://codeload.github.com/vercel/ai/tar.gz/refs/heads/main"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "Fetching Vercel AI SDK documentation..."

ARCHIVE_PATH="$TEMP_DIR/vercel-ai.tar.gz"
EXTRACT_DIR="$TEMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"

curl -fsSL "$ARCHIVE_URL" -o "$ARCHIVE_PATH"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR"
CONTENT_DIR="$(find "$EXTRACT_DIR" -maxdepth 2 -type d -name content -print -quit)"

if [ -z "$CONTENT_DIR" ]; then
  echo "Error: content directory not found in archive"
  exit 1
fi

if [ -d "$DOCS_DIR" ]; then
  echo "Removing existing ai-sdk-docs directory..."
  rm -rf "$DOCS_DIR"
fi

mkdir -p "$DOCS_DIR"

echo "Copying documentation to $DOCS_DIR..."
cp -r "$CONTENT_DIR"/* "$DOCS_DIR/"
echo "Documentation updated successfully!"

echo "Vercel AI SDK documentation has been updated in $DOCS_DIR"
