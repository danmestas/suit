# Design Spec: Wardrobe-Driven Dual Emitter for Claude Code + Gemini CLI

**Date:** 2026-06-02  
**Status:** Approved — ready for implementation plan  
**Scope:** B (deepen quality/stability for Claude + Gemini) + A (eliminate drift) + B (add MCP declaration)

---

## 1. Problem Statement

Suit currently maintains manual, duplicated content in `.claude/`, `.gemini/`, `CLAUDE.md`, and `GEMINI.md`. This creates drift, manual sync burden, and violates the single-source-of-truth principle. The wardrobe template repo already exists as the canonical content store, but suit does not consume it as the sole source for skills, agents, and (future) MCP servers. The goal is to make suit a thin, reproducible emitter that reads from wardrobe template repo(s) and produces correct, non-divergent artifacts for Claude Code and Gemini CLI.

---

## 2. Goals & Non-Goals

### Goals
- Single source of truth: all canonical skills, agents, hooks, rules, commands, and MCP servers live in wardrobe template repo(s) controlled by the user (or the default public wardrobe).
- Zero-drift emission: every `suit up` (and `suit claude` / `suit gemini`) produces fresh `.claude/` and `.gemini/` trees from the same wardrobe commit + same composition.
- MCP as first-class component: `type: mcp` declarations with portable `mcpServers` shape are emitted correctly for both Claude (`.mcp.json`) and Gemini (settings entry).
- Thin AGENTS.md adapters: `CLAUDE.md` and `GEMINI.md` become one-line shims (`@AGENTS.md`) or contain only the suit marker; portable rules live in the generated `AGENTS.md`.
- Existing manual content in the suit repo is removed or converted to generated output only.

### Non-Goals (explicitly deferred)
- Wider harness emission (Cursor, Windsurf, Zed, Codex TOML, etc.).
- Local override directories (`local-skills/`, etc.).
- Offline caching or `suit sync` command.
- Permission/safety layer (OS sandbox, pr-policy accessory).
- Changes to the outfit/cut/accessory composition model itself.

---

## 3. Architecture

### 3.1 Components

**Wardrobe template repo (source of truth)**  
- Git repository containing `outfits/`, `cuts/`, `accessories/`, `skills/`, `agents/`, `hooks/`, `rules/`, `commands/`, and `mcp/` (or `mcp-servers/`).
- Every component carries YAML frontmatter: `name`, `version`, `type`, `targets`, `description`, optional `category` / `include` / `enable` / `disable` / `permissions`.
- Read-only input for suit. Never mutated by suit.

**Suit (applicator / dual emitter)**  
- Records the template repo path on `suit init <url-or-path>` (stored in `~/.suit/config.json` or `.suit/config.yaml`).
- On every emission (`suit up`, `suit claude`, `suit gemini`):
  1. Reads the wardrobe template repo (or uses `SUIT_CONTENT_PATH`).
  2. Applies outfit → fit → cut → accessory composition (existing resolver).
  3. Emits via per-target adapters:
     - Claude Code adapter → `.claude/` tree + `.mcp.json` + thin `CLAUDE.md`
     - Gemini adapter → `.gemini/` tree + settings MCP entry + thin `GEMINI.md`
     - Shared AGENTS.md composer → `AGENTS.md` (portable rules) or thin shims
- The emitted trees are always derived; hand-edits are overwritten on next emission.

**Key invariant**  
There is exactly one source of truth for any component. Emitted artifacts are byte-for-byte reproducible from the same wardrobe commit + same outfit/cut/accessory selection.

### 3.2 Resolution Order (multiple template repos)

1. User-specified template repo (via `suit init` or `SUIT_CONTENT_PATH`).
2. Default public wardrobe (`https://github.com/danmestas/wardrobe`) as fallback.
3. (Future) Local overrides in the current repo — not implemented in v1.

Component identity is `(name, type)`. Version is carried but does not affect identity for composition.

---

## 4. MCP as First-Class Component

### 4.1 Declaration

An MCP server is declared with `type: mcp` (or as a top-level `mcpServers:` block inside an outfit/cut/accessory). The existing `MCPBlock` schema captures the portable shape:

```yaml
---
name: memory
type: mcp
version: 1.0.0
targets: [claude-code, gemini]
description: Persistent memory server for cross-session recall.
mcp:
  command: npx
  args: ["-y", "@modelcontextprotocol/server-memory"]
  env: {}
---
```

### 4.2 Emission

- **Claude Code**: writes `.mcp.json` at repo root (or merges into `.claude/settings.json`) using the exact `mcpServers` object.
- **Gemini**: writes the inner server object into the `mcpServers` section of `~/.gemini/settings.json` (or project-scoped override if supported).
- Both emitters produce byte-identical inner objects for the 7 verbatim readers.
- `enable: { mcps: [...] }` / `disable: { mcps: [...] }` blocks (already present in the globals-targeting schema) control inclusion.

No TOML or Codex emission in this scope.

---

## 5. AGENTS.md Thin Adapters

### 5.1 Portable Rules

Rules that are pure instruction text (no harness-specific syntax) are eligible for `AGENTS.md`. In the wardrobe template they carry `targets: [...]` and are treated as portable by convention (or a future `portable: true` flag).

### 5.2 Emission Behavior

- When the composed set contains portable rules, the Claude and Gemini emitters write one-line shims:
  - `CLAUDE.md` → `@AGENTS.md` (plus suit outfit marker comment if needed).
  - `GEMINI.md` → `@AGENTS.md`.
- The full `AGENTS.md` (portable rules, optionally agents/skills sections) is written at repo root.
- Non-portable rules, skills, agents, hooks, and commands continue to emit into harness-native directories.

### 5.3 Drift Elimination

Because `CLAUDE.md` and `GEMINI.md` are generated shims and `AGENTS.md` is generated from the same wardrobe source, manual divergence is impossible. The previous full-copy `GEMINI.md` in the suit repo is removed.

---

## 6. Emission Lifecycle & Commands

**Primary emission points**  
- `suit up --outfit X [--cut Y] [--accessory Z...]` — reads wardrobe, composes, emits all derived artifacts.
- `suit claude ...` and `suit gemini ...` — convenience wrappers that invoke the same emission path before launch.
- `suit init <template-repo>` — records the source; does not emit.

**Safety**  
- Emission is a full replace of the derived trees (`.claude/`, `.gemini/`). No in-place patching.
- Existing `ProjectWriter` refuse-when-dirty preflight remains.
- Lockfile (`.suit/lock.yaml`) records wardrobe commit SHA + outfit/cut/accessory selection for `suit status` reporting.

**Idempotency**  
Re-running the same `suit up` command with unchanged inputs produces identical emitted trees.

---

## 7. Local Overrides (Deferred)

A future optional layer may support `local-skills/`, `local-agents/`, `local-mcp/` directories inside the current repo. Local definitions would merge with wardrobe content using deterministic precedence (same `(name, type)` → local wins on version or explicit flag). This increment does not implement or depend on local overrides.

---

## 8. Acceptance Criteria

Before the implementation is considered complete, the following must hold:

1. `suit init <wardrobe-repo>` followed by `suit up --outfit engineer --cut executing` produces a `.claude/` tree and a `.gemini/` tree whose skill/agent content is identical in substance (modulo harness-specific directory layout).
2. Changing a skill in the wardrobe template repo and re-running `suit up` updates both emitted trees; no manual sync step is required.
3. Declaring an MCP server in the wardrobe template (with appropriate `targets`) causes `.mcp.json` (Claude) and the Gemini settings entry to appear after emission.
4. `CLAUDE.md` and `GEMINI.md` are thin shims (`@AGENTS.md`) or contain only the suit marker; the portable rules live in `AGENTS.md`.
5. No content under `.claude/skills/`, `.gemini/skills/`, or `.claude/agents/` in the suit source tree is treated as canonical.

---

## 9. Open Questions (None Remaining)

All clarifying questions were resolved during the brainstorming process. The design is complete and approved.

---

**End of design spec.**
