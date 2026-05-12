---
name: claude-perm-fixture
description: outfit permissions fixture
type: outfit
targets: [claude-code]
categories: []
permissions:
  claude-code:
    allow:
      - "Bash(git status:*)"
      - "mcp__signoz__signoz_search_logs"
    deny:
      - "Bash(rm -rf:*)"
    additionalDirectories:
      - "~/src"
---

Body content (not emitted for outfits).
