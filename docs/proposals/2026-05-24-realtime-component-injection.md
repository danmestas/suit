# Proposal: `suit inject` — realtime component injection into a running worker

- **Date:** 2026-05-24
- **Status:** Draft (awaiting operator review — no code yet)
- **Author:** suit-orch
- **Related:** ADR-0010 (include blocks), ADR-0011 (3-tier discovery), ADR-0012 (`suit up` / `suit off` lockfile + refuse-when-dirty)

## Context

A worker agent (claude, codex, pi, gemini) is mid-task and discovers it needs a
component it wasn't dressed with — a skill (`release-watch`), a hook, an
accessory bundle. Today the only remedy is to stop the worker and re-`suit up`,
losing in-session state (conversation, plan progress, working-tree context).

We want to slide a component into a *running* worker's harness home and have the
worker pick it up on its **next turn**, without restarting the process and
without disturbing the turn in flight.

Two callers motivate this:

1. **An orchestrator** decides a worker needs `X` and pushes it across the mesh.
2. **A worker's own hook** (the recursive, self-injecting case) runs
   `suit inject --skill X` from inside the worker's pane to self-equip. This is
   the case that justifies the whole design: it must be a one-liner with no
   `--target`.

## What the harnesses actually do on reload (the load-bearing finding)

The naïve framing — "materialize the file, then fire a reload verb" — is wrong
for the common case on Claude Code. Verified against Claude Code docs:

| Component (claude-code) | Pickup mechanism | Reload verb needed? |
|---|---|---|
| Standalone skill in `~/.claude/skills/` or `.claude/skills/` | **File-watched**, live change detection | **No** — visible next turn |
| Hooks in `settings.json` | **File-watched**, re-read per event | **No** |
| `CLAUDE.md` / `.claude/rules` | File-watched + lazy per-turn | **No** |
| Plugin-bundled skill/agent/hook/MCP | `/reload-plugins` (user-invocable only) | **Yes** |
| Non-plugin (user/project) MCP server | none | **Restart only** |

Consequence: for the dominant inject targets on Claude Code — a standalone skill
or a settings hook — **suit inject needs no reload signal at all**. suit's
materialization already writes standalone files into `.claude/` (see
`writer.ts` / `compose.ts` `TARGET_PROJECT_PREFIX`), so the harness file-watcher
does the work. The reload signal is a *conditional fallback*, fired only for
component kinds the watcher doesn't cover (plugin bundles, MCP servers).

The other three harnesses' live-reload verbs are **not yet verified** (no local
repos; see Open Questions). The design treats reload as a per-harness adapter
capability with a mandatory safe fallback: if a harness has no known
live-reload path for a given component kind, inject still **succeeds at
materialization** and the reply states `reload: restart-required`.

## Decision

### Verb

`suit inject` — a new top-level verb. Rejected alternatives: `apply` (collides
semantically with `suit up`'s project-state application), `add` (reads as
"add to the wardrobe," not "to a live session"). `inject` is honest: a foreign
object enters a running session at runtime.

It sits alongside the existing surface (`up`, `off`, `prepare`, `current`,
`list`, `show`, `status`, `sync`, `init`, `doctor`) and is orthogonal to `up`:
`up` dresses a *project* and persists until `off`; `inject` equips a *running
worker* and records the addition into the same project lockfile.

### CLI surface

```
suit inject <component>            --target <owner>/<session>
suit inject --skill     <name>     --target <owner>/<session>
suit inject --hook      <name>     --target <owner>/<session>
suit inject --accessory <name>     --target <owner>/<session>
suit inject --bundle    <name>     --target <owner>/<session>   # repeatable component manifest

# self-inject (hook case): --target defaults to self via env discovery
suit inject --skill release-watch

# flags
--from <path-or-url>     # source override; default = configured suit content path
--target-subject <subj>  # escape hatch: address the worker's NATS subject directly
--dry-run                # resolve + report what would be materialized, write nothing
--no-reload              # materialize only; never signal (operator will reload manually)
--json                   # machine-readable result for hook/script callers
```

Bare `suit inject <component>` infers kind from the wardrobe manifest's `type`.
The `--skill/--hook/--accessory/--bundle` flags are explicit disambiguators.

### Target identification

Primary form: `--target <owner>/<session>`, resolved to a NATS prompt subject by
listing the mesh (`nats micro list` + `micro info`, filtered on owner+session
metadata) → `agents.prompt.cc.<owner>.<session>`.

Fallbacks, in precedence order:

1. **Env-discovered self** (the hook case): when `--target` is omitted and the
   command runs inside a worker, default target = self from `$ORCH_OWNER` /
   `$SESH_SESSION` (or harness-equivalent env). Makes self-inject a one-liner.
2. **`--target-subject <subject>`**: address the NATS subject verbatim, skipping
   discovery. For when `micro list` is unavailable or the worker isn't a
   registered micro service.

If neither `--target` resolves nor self-discovery succeeds, exit non-zero
(`E_NO_TARGET`) before touching any filesystem.

### Mid-prompt behavior: write-immediately, reload-deferred (hard constraint)

**Never hot-reload mid-prompt.** Half-loaded plugin state, in-flight tool calls
bound to the old component set, and running-context drift are all unacceptable.
The sequence:

1. **Materialize immediately.** Write/symlink the component into the worker's
   harness home (`~/.claude/skills/<name>/`, etc.). Idempotent: re-injecting the
   same content is a disk no-op (sha256 match → skip).
2. **Signal immediately *if* a reload is required for this kind+harness.** Send a
   reload request to the worker adapter's `inject.reload` endpoint. For
   claude-code standalone skills/hooks this step is **skipped** — the watcher
   covers it.
3. **Adapter enqueues the reload.** If the worker is **idle**, fire the harness
   reload verb at once. If the worker is **in a turn**, hold the reload until
   the next turn-completion (`Stop`) event, then fire. Reload never lands
   mid-turn.
4. **Reply states the outcome** so the caller knows the worker's actual state:
   - `materialized: <abs path>` (or `unchanged` if idempotent no-op)
   - `reload: not-required` | `fired` | `queued` (waiting for Stop) |
     `restart-required` (no live-reload path for this kind/harness)

A worker therefore can use an injected standalone skill on its **very next
turn**; a plugin-bundled component is available after the queued reload fires
post-Stop; an MCP server addition surfaces as `restart-required` with a visible
marker for the operator.

### Wardrobe source of truth

Default source is the **configured suit content path** (the same path
`suit status` prints — the wardrobe clone). `--from <path-or-url>` overrides for
ad-hoc material (a local dir, a wardrobe ref). Resolution reuses the existing
3-tier discovery (project → user → builtin/content) so an injected name means
the same thing it would mean in `suit up`.

### Lockfile truthfulness

`suit current` reads `.suit/lock.json`; after an inject the lockfile **must**
reflect reality or the operator's mental model silently diverges from harness
state. On inject:

- Append the component to the lockfile's `resolution` (e.g. into a new
  `injected: []` list distinct from the `up`-applied `accessories`, so `off`
  knows provenance), and add its `files[]` rows (path + sha256 +
  `sourceComponent` + `mode`).
- Stamp an `injectedAt` marker per injected component.
- `suit current` then shows injected components explicitly (e.g. a
  `+ release-watch (injected 00:51)` line) distinct from the base resolution.
- `suit off` removes injected files via the same path+sha256 contract as
  `up`-applied files; injecting then `off` leaves no orphan.

If no lockfile exists (worker was launched via stateless `prepare`, not `up`),
inject creates a minimal lockfile recording only what it injected, so `current`
still works. This is the one new lockfile-creation path outside `up`.

### Idempotency & refuse-when-dirty

Inherits ADR-0012's contract. Re-injecting identical content → no-op. If the
target path exists but isn't lockfile-tracked (user hand-added) or its sha256
differs from the recorded value (user edited), inject **refuses** unless
`--force`. Protects worker-local edits from being clobbered by a live push.

## Failure modes

| Condition | Exit code | Cleanup posture |
|---|---|---|
| Component not found in wardrobe / `--from` | `E_NO_COMPONENT` | Nothing written; no signal sent. |
| Target unresolvable (no `--target`, no self-env, no subject) | `E_NO_TARGET` | Nothing written. |
| Worker unreachable on NATS (discovery or signal) | `E_UNREACHABLE` | **File already materialized** is kept (worker reads it on next turn / restart); reply says `reload: unreachable — file in place, restart to load`. Do **not** roll back the file. |
| Materialized OK but reload signal fired and worker never acked | `E_RELOAD_UNACKED` | File kept; lockfile recorded; reply flags `reload: unacked` so operator can `/reload-plugins` manually. |
| Reload fired but harness reload verb itself errored | `E_RELOAD_FAILED` | File kept; surface the harness error verbatim. |
| Refuse-when-dirty (untracked/edited target) | `E_DIRTY` | Nothing written; instruct `--force`. |
| No live-reload path for kind+harness | `0` (success) | File kept; reply `reload: restart-required`. Not an error — materialization succeeded. |

Guiding principle: **once the file is on disk, never silently remove it** — a
materialized-but-not-reloaded component still loads on the next process start,
so rollback would destroy recoverable state. Failures after materialization
report loudly but leave the file (and lockfile row) in place.

## Scope: per-session, not per-project-only

`suit up` is project-scoped (writes `.claude/` etc. into the cwd). `inject`
targets a **specific running worker's harness home**, which may be:

- the project `.claude/` (project-scope worker), or
- the user `~/.claude/` (a worker not bound to a project tree).

The target's harness home is resolved from the worker's harness type +
project/user scope (reusing `paths.ts` / harness-adapter home resolution). The
injected component lives at whichever scope the worker actually reads from —
inject does not invent a new scope tier.

### Auth / trust model

v1 trust model = **mesh membership**. Any caller with publish rights to the
worker's `inject.reload` subject can inject. There is no per-component
authorization. Per-component policy — allowlists of injectable components,
signed bundles, operator-approval gates — is **out of scope for v1** and noted
here only to pre-empt the question.

## Resolved design questions

1. **Reload verbs for codex / gemini / pi — DEFERRED to implementation.** The
   proposal carries the conservative `reload: restart-required` placeholder for
   these three; verifying their real reload paths does not block the design.
   Research is feasible (not "no repos"): `~/projects/pi-extensions` exists
   locally — its README Purpose section describes `monitor`, a Claude
   Code-style Monitor for Pi plus task-management tools, and is the right
   starting point for pi's extension-reload path. Codex and Gemini are
   public CLIs reachable via their published docs. Slice (d) does this research;
   until then each reports `restart-required` (correct, conservative — we
   knowingly leave reload coverage on the table for those harnesses in v1).

2. **Adapter reload wiring — REUSE detection, ADD a receive subject.** Two
   distinct concerns, previously conflated:
   - **(a) Turn-boundary DETECTION** — knowing when a `Stop` fires. This is
     already solved upstream; **reuse** an existing primitive (choice made at
     implementation time): Synadia §6.5 terminators (e.g. the subject
     `orch-goal-stop-account-daemon` subscribes to), sesh v0.4's
     `SubscribeToTask`, or the per-worker `agents.status.cc.<owner>.<session>`
     stream. Do **not** invent a new turn-state event.
   - **(b) Reload REQUEST receive-side** — the adapter must expose something for
     `suit inject` to signal. This subject is **new**, per worker, e.g.
     `agents.inject.reload.cc.<owner>.<session>`. Semantics: "enqueue this
     reload; fire when (a) reports idle." Tiny scope, no overlap with existing
     primitives.
   - The **queue-until-Stop** logic lives in the **adapter** (it owns
     turn-state), never in the suit CLI.

3. **Lockfile shape — SEPARATE `injected: []` list.** Decided. Keeps `up`'s
   `resolution` clean, gives `off` clean provenance, and leaves room for a future
   `suit off --keep-injected` knob without lockfile surgery.

4. **`--bundle` semantics — REUSE accessory `include`.** Decided. A bundle is a
   named accessory whose `include` block lists the components. No new
   composition primitive (Ousterhout-clean).

## Alternatives considered

- **Extend `suit up` with a `--live`/`--inject` flag.** Rejected: `up` is a
  project-state mutator with refuse-when-dirty full-resolution semantics;
  overloading it with single-component runtime push muddies both. A distinct
  verb keeps each mental model clean (ADR-0012 precedent: separate `off` rather
  than `up --remove`).
- **Pure NATS push (no filesystem).** Rejected: harnesses load components from
  disk; there's no in-memory inject API. The file must land on disk regardless.
- **Always fire `/reload-plugins`.** Rejected by the load-bearing finding:
  unnecessary (and riskier) for file-watched standalone skills/hooks; reserved
  for plugin/MCP kinds.

## Next step

Approved 2026-05-24. Slices to file as separate issues:

- **(a)** `suit inject` resolver + materializer + lockfile write (the
  `injected: []` list + file rows + idempotent refuse-when-dirty).
- **(b)** Target discovery: `--target <owner>/<session>` via `micro list`,
  env-discovered self-default, `--target-subject` escape hatch.
- **(c)** Adapter reload wiring: new per-worker `inject.reload` receive subject +
  queue-until-Stop, reusing an existing turn-boundary detection primitive.
- **(d)** Per-harness reload-verb research + adapter table (start pi at
  `~/projects/pi-extensions`; codex/gemini via public docs).
- **(e)** `suit current` / `suit off` injection awareness (show injected
  components; remove them via path+sha256; minimal-lockfile creation path).
- **(f)** Docs: `suit inject` verb in the suit README + a CHANGELOG entry under
  the release that ships it (v0.16.0 or whichever lands first).
