export function helpText(): string {
  return `suit — multi-harness AI agent configurator

USAGE
  suit <harness> [--persona X] [--mode Y] [--no-filter] [-- <harness args>]
  suit init <url> [--force]
  suit sync
  suit status
  suit doctor
  suit list <personas|modes>
  suit show <persona|mode> <name>

ENVIRONMENT
  SUIT_CONTENT_PATH    override the default content directory (overrides clone)

EXAMPLES
  suit init https://github.com/user/their-config
  suit claude --persona backend --mode focused
  suit codex --persona frontend -- --resume sess-123

See https://github.com/danmestas/suit for full docs.
`;
}
