export function helpText(): string {
  return `suit — multi-harness AI agent configurator

USAGE
  suit <harness> [--outfit X] [--mode Y] [--accessory A]... [--no-filter] [-- <harness args>]
  suit up --outfit <name> [--mode <name>] [--accessory <name>]... [--force]
  suit off [--force]
  suit current
  suit init [<url>] [--force]    (defaults to suit.templateUrl from package.json)
  suit sync
  suit status
  suit doctor
  suit list <outfits|modes|accessories>
  suit show <outfit|mode|accessory> <name>

FLAGS
  --accessory <name>   Any wardrobe component name (skill/hook/rule/agent/command),
                       or a curated bundle authored under accessories/. When the
                       name resolves to a non-accessory component, it's treated as
                       a singleton role and force-included into the kept set.

SCHEMA (v0.7+)
  enable: / disable:   Outfit, mode, and accessory manifests may declare
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
  suit up --outfit backend --mode focused
  suit current
  suit off
  suit claude --outfit backend --mode focused
  suit claude --outfit backend --accessory tracing --accessory pr-policy
  suit claude --outfit backend --accessory test-driven-development   # any skill works
  suit codex --outfit frontend -- --resume sess-123

See https://github.com/danmestas/suit for full docs.
`;
}
