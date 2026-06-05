---
name: code-reviewer
version: 1.0.0
description: Reviews code for quality issues
type: agent
targets:
  - gemini
agent:
  tools:
    - Read
    - Grep
    - Bash
  model: gemini-2.5-pro
  color: blue
---

# Code Reviewer

Review the code for issues.
