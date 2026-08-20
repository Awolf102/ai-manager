# Third-Party Notices

The MIT license in [LICENSE](LICENSE) covers the **original work** in this
repository — `src/`, `scripts/`, `docs/`, and the root configuration files. It does
not apply to any third-party material listed below, which remains the property of its
respective authors under its own license terms.

## Runtime dependencies

Runtime and build dependencies are declared in `package.json` and resolved from
npm; each carries its own license. Notable direct dependencies include
`@anthropic-ai/claude-agent-sdk`, `electron`, `react`, `node-pty`, `@xterm/xterm`,
`@xyflow/react`, `zustand`, and `lucide-react`.

## Agent skills (development tooling — not tracked, not redistributed)

Development of this project uses several third-party **Claude Code / agent skills**.
They are **not part of the application** — the app discovers skills from the user's
own `~/.claude/plugins` directory at runtime (`src/main/engine/skill-discovery.ts`),
never from this repository.

These skill directories (`.claude/skills/`, `.agents/skills/`) are **git-ignored** and
are not distributed with this repository. They were, however, committed in earlier
history, so the following attributions are recorded here:

| Skill | Upstream source | License |
|---|---|---|
| `impeccable` | vendored skill package | Apache-2.0 (declared in its `SKILL.md` frontmatter) |
| `ui-ux-pro-max` | vendored skill package | Not declared upstream — all rights reserved by its author |
| `emil-design-eng` | [`emilkowalski/skill`](https://github.com/emilkowalski/skill) | See upstream repository |
| `animation-vocabulary` | [`emilkowalski/skill`](https://github.com/emilkowalski/skill) | See upstream repository |
| `review-animations` | [`emilkowalski/skill`](https://github.com/emilkowalski/skill) | See upstream repository |

The pinned upstream sources and content hashes for the `emilkowalski/skill` skills
are recorded in [`skills-lock.json`](skills-lock.json).

No claim of ownership is made over any of the above. Each remains the property of its
respective author under its own license terms; the MIT license in [LICENSE](LICENSE)
does **not** apply to them.

## Trademarks

"Claude", "Claude Code", and "Anthropic" are trademarks of Anthropic PBC. This is an
independent, unaffiliated project that builds on the publicly released
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and
the `claude` CLI.
