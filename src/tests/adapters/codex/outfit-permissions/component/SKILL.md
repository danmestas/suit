---
name: codex-perm-fixture
description: outfit permissions fixture
type: outfit
targets: [codex]
categories: []
permissions:
  codex:
    approval_policy: on-request
    sandbox_mode: workspace-write
    rules:
      prefix_rules:
        - prefix: "git "
        - prefix: "npm "
    mcp_servers:
      signoz:
        enabled: true
        enabled_tools: ["signoz_search_logs"]
---

Body content (not emitted).
