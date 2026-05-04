export function helpText(): string {
  return `suit — multi-harness AI agent configurator

USAGE
  suit <harness> [--outfit X] [--mode Y] [--no-filter] [-- <harness args>]
  suit init [<url>] [--force]    (defaults to suit.templateUrl from package.json)
  suit sync
  suit status
  suit doctor
  suit list <outfits|modes>
  suit show <outfit|mode> <name>

ENVIRONMENT
  SUIT_CONTENT_PATH    override the default content directory (overrides clone)

EXAMPLES
  suit init https://github.com/user/their-config
  suit claude --outfit backend --mode focused
  suit codex --outfit frontend -- --resume sess-123

See https://github.com/danmestas/suit for full docs.
`;
}
