#!/usr/bin/env bash
set -euo pipefail

mkdir -p docs

# Generate Mermaid PNG (requires mermaid CLI)
# Install once:
#   npm i -D @mermaid-js/mermaid-cli

npx mmdc -i docs/architecture.mmd -o docs/architecture-diagram.png

echo "Generated docs/architecture-diagram.png"

# Optional GIF generation from a local demo recording
# Example:
#   ffmpeg -i demo.mp4 -vf "fps=10,scale=960:-1:flags=lanczos" -loop 0 docs/demo-workflow.gif
