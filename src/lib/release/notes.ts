import type { ComponentSource, Target } from '../types.js';

export interface NotesContext {
  component: ComponentSource;
  summary: string;
  /** Git host + repo, e.g. "github.com/danmestas/agent-skills". */
  gitRepo: string;
}

const GIT_ONLY_TARGETS: readonly Target[] = ['codex', 'gemini', 'pi'];

/**
 * Render the markdown body for a GitHub release. Composes a per-target install
 * matrix from the component's declared `targets:` so each release page tells
 * the reader exactly how to install for any harness it ships to.
 */
export function renderReleaseNotes(ctx: NotesContext): string {
  const { component, summary, gitRepo } = ctx;
  const { name, version, description, targets } = component.manifest;
  const sections: string[] = [];
  sections.push(
    `# ${name} v${version}`,
    '',
    description,
    '',
    "## What's in this release",
    '',
    summary,
    '',
    '## Install',
  );
  if (targets.includes('claude-code')) {
    sections.push(
      '',
      '### Claude Code',
      '',
      `Download \`${name}-v${version}.zip\` from the assets below, unzip into your \`~/.claude/plugins/\` directory, then \`/plugin install ${name}\`.`,
    );
  }
  const gitTargets = targets.filter((t) => GIT_ONLY_TARGETS.includes(t));
  if (gitTargets.length > 0) {
    const friendly = gitTargets
      .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
      .join(' / ');
    sections.push(
      '',
      `### ${friendly}`,
      '',
      'Install from the git tag:',
      '',
      '```',
      `<harness-cli> install ${gitRepo}@${name}@v${version}`,
      '```',
    );
  }
  sections.push('', '## Targets', '', [...targets].join(', '));
  return sections.join('\n');
}
