# Wardrobe-Driven Dual Emitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use bones-powers:subagent-driven-development (recommended) or bones-powers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform suit from a content owner into a thin, reproducible emitter that consumes wardrobe template repo(s) as the single source of truth for skills, agents, and MCP servers, producing correct artifacts for Claude Code and Gemini CLI with zero manual drift.

**Architecture:** Suit records a wardrobe template repo path on `suit init`. Every `suit up` reads the canonical content from that repo, applies the existing outfit/cut/accessory composition, and emits via dual adapters (claude-code, gemini) that produce the harness-native trees plus thin `AGENTS.md` shims. MCP servers are first-class components emitted to `.mcp.json` and Gemini settings.

**Tech Stack:** TypeScript (NodeNext), existing suit resolver (`resolution.ts`), `ProjectWriter`, harness adapters.

---

## Task 1: Branch Setup and Plan Commit `[slot: infra]`

**Files:**
- Create: (branch)
- Modify: (none)

- [ ] **Step 1: Create feature branch**
  ```bash
  git checkout -b feat/wardrobe-dual-emitter
  ```
  Expected: On feature branch.

- [ ] **Step 2: Commit the approved design spec**
  ```bash
  git add docs/bones-powers/specs/2026-06-02-wardrobe-driven-dual-emitter-design.md
  git commit -m "docs: add wardrobe-driven dual-emitter design spec"
  ```

## Task 2: Persistent Wardrobe Source Configuration `[slot: core]`

**Files:**
- Modify: `src/lib/ac/init.ts`
- Modify: `src/lib/content-store.ts`

- [ ] **Step 1: Extend `ContentStore` to persist the source URL/path.**
  (Add a `source` field to the store metadata).

- [ ] **Step 2: Modify `runInit` to call `store.setSource(url)` after successful clone.**

## Task 3: Dual-Emitter Content Loading `[slot: core]`

**Files:**
- Modify: `src/lib/ac/up.ts`
- Modify: `src/lib/ac/compose.ts`

- [ ] **Step 1: In `runUp`, resolve the wardrobe path from the content store before calling `composeBundle`.**
- [ ] **Step 2: Pass the wardrobe-derived components to the adapters.**

## Task 4: Thin AGENTS.md Shim Emission `[slot: core]`

**Files:**
- Modify: `src/lib/harness-adapters/claude-code.ts`
- Modify: `src/lib/harness-adapters/gemini.ts`

- [ ] **Step 1: Update Claude adapter `emit` to check for portable rules and write `@AGENTS.md` shim.**
- [ ] **Step 2: Update Gemini adapter similarly.**

## Task 5: MCP Server Emission `[slot: core]`

**Files:**
- Modify: `src/lib/harness-adapters/claude-code.ts`
- Modify: `src/lib/harness-adapters/gemini.ts`

- [ ] **Step 1: Implement `emitMcp` logic for `.mcp.json`.**
- [ ] **Step 2: Implement `emitMcp` logic for Gemini settings.**

## Task 6: Legacy Content Cleanup `[slot: infra]`

**Files:**
- Delete/Modify: `.claude/`, `.gemini/`, `GEMINI.md`

- [ ] **Step 1: Remove legacy hand-maintained content.**
- [ ] **Step 2: Update README to point to `suit init <wardrobe>`.**

## Task 7: Verification `[slot: test]`

- [ ] **Step 1: Manual/automated verification of end-to-end flow.**
