export function helpText(): string {
  return `suit — multi-harness AI agent configurator

USAGE
  suit <harness> [--outfit X] [--cut Y] [--accessory A]... [--no-filter] [-- <harness args>]
  suit up --outfit <name> [--cut <name>] [--accessory <name>]... [--force]
  suit off [--force]
  suit current
  suit init [<url>] [--force]    (defaults to suit.templateUrl from package.json)
  suit sync
  suit status
  suit doctor
  suit list <outfits|cuts|accessories>
  suit show <outfit|cut|accessory> <name>

FLAGS
  --outfit <name>      Pre-built bundle of harness-native components — sets
                       the baseline component set for the session.
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
  suit claude --outfit backend --accessory tracing --accessory pr-policy
  suit claude --outfit backend --accessory test-driven-development   # any skill works
  suit codex --outfit frontend -- --resume sess-123

See https://github.com/danmestas/suit for full docs.
`;
}
