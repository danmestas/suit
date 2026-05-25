export function helpText(): string {
  return `suit — multi-harness AI agent configurator

USAGE
  suit <harness> [--outfit X] [--fit F] [--cut Y] [--accessory A]... [--no-filter] [-- <harness args>]
  suit up --outfit <name> [--fit <name>] [--cut <name>] [--accessory <name>]... [--force]
  suit off [--force] [--keep-injected] [--project <path>]
  suit current [--project <path>]
  suit inject (--accessory|--bundle|--skill|--hook) <name> [--home <path>] [--from <path>] [--dry-run] [--no-reload] [--force] [--json]
  suit prepare --outfit <name> --target <name> [--fit <name>] [--cut <name>] [--accessory <name>]... [--quiet] [--dry-run] [--label <text>] [--shape project|sidecar] [--project <path>]
  suit init [<url>] [--force]    (defaults to suit.templateUrl from package.json)
  suit sync
  suit status
  suit doctor
  suit list <outfits|cuts|fits|accessories> [-v|--verbose] [--resolvable]
  suit show <outfit|cut|fit|accessory> <name>
  suit show bundle <path>                          # pretty-print a prepare-bundle's .suit-bundle.json

FLAGS
  --outfit <name>      Pre-built bundle of harness-native components — sets
                       the baseline component set for the session.
  --fit <name>         Seniority-tier overlay (junior-engineer / engineer /
                       senior-engineer / staff-engineer). Composes between
                       outfit and cut. Singleton per session.
  --cut <name>         Work-shape overlay (e.g. focused, ticket-writing) —
                       extends/overrides the outfit's components and injects
                       a prompt body as additional context.
  --accessory <name>   Any wardrobe component name (skill/hook/rule/agent/command),
                       or a curated bundle authored under accessories/. When the
                       name resolves to a non-accessory component, it's treated as
                       a singleton role and force-included into the kept set.

SCHEMA (v0.7+)
  Outfit / Cut / Accessory — the three composition primitives. Outfit is the
                             baseline bundle, cut is the work-shape overlay,
                             accessory is the piecemeal add-on (repeatable).
  enable: / disable:   Outfit, cut, and accessory manifests may declare
                       enable: { plugins: [...], mcps: [...], hooks: [...] } and
                       disable: { ... } blocks naming user-scope globals.
  globals.yaml         Per-machine snapshot at <wardrobe>/globals.yaml lists the
                       installed plugins/MCPs/hooks. Generate with
                       \`suit-build sync-globals\`; the resolver layers
                       enable/disable over it to filter the harness home.

ENVIRONMENT
  SUIT_CONTENT_PATH    override the default content directory (overrides clone)

EXAMPLES
  suit init https://github.com/user/their-config
  suit up --outfit backend --cut focused
  suit current
  suit off
  suit claude --outfit backend --cut focused
  suit claude --outfit backend --fit senior-engineer --cut executing
  suit claude --outfit backend --accessory tracing --accessory pr-policy
  suit claude --outfit backend --accessory test-driven-development   # any skill works
  suit codex --outfit frontend -- --resume sess-123

  # 'prepare' emits a stateless bundle to a tempdir and prints its path on
  # stdout. The caller (e.g. a multi-worker spawn wrapper) launches its own
  # agent against the bundle and owns cleanup (rm -rf) when done.
  BUNDLE=\$(suit prepare --outfit backend --target claude --quiet)
  claude --add-dir "\$BUNDLE" -- ...
  rm -rf "\$BUNDLE"

  # --target accepts 'claude' as an alias for 'claude-code'. --quiet drops the
  # trailing newline so wrapper-side capture is exact. --dry-run lists files
  # that WOULD be emitted, without writing a tempdir.
  suit prepare --outfit backend --target claude --dry-run

  # --label stamps the bundle with caller metadata for registry surveys.
  # 'suit show bundle <path>' pretty-prints the resulting .suit-bundle.json.
  BUNDLE=\$(suit prepare --outfit backend --target claude --label "worker-3" --quiet)
  suit show bundle "\$BUNDLE"

  # --shape sidecar emits a side-loadable bundle + a generated 'launch' script.
  # The caller does cwd=\$PROJECT && exec \$BUNDLE/launch — one line. Loads
  # the project's own CLAUDE.md natively (cwd auto-discovery) plus the bundle's
  # dressing via flags. Solves the 'project CLAUDE.md silently not loaded'
  # gap in the project-shape recipe.
  BUNDLE=\$(suit prepare --shape sidecar --outfit backend --target claude --project ~/projects/foo --quiet)
  exec "\$BUNDLE/launch"

  # 'inject' materializes a single component into a harness home so an
  # already-running worker can pick it up — scoped to exactly the named
  # component(s), idempotent, refuse-when-dirty. --home defaults to
  # \$CLAUDE_PROJECT_DIR then cwd, so a hook can self-inject with no --home.
  # Reload: claude-code file-watches skills/hooks (next turn); other harnesses
  # load on restart — 'reload:' in the output says which.
  suit inject --skill release-watch --home ~/projects/foo
  suit inject --accessory philosophy --home ~/projects/foo
  suit inject --hook rtk-suggest                       # self-inject into cwd/\$CLAUDE_PROJECT_DIR
  # 'suit off' removes injected files too; 'suit off --keep-injected' keeps them.

See https://github.com/danmestas/suit for full docs.
`;
}
