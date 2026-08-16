# AGENTS.md

## Local agent skills

Skills live outside this repo at `C:\Users\Masoud\.agents\skills\<name>\`; resolve SKILL.md relative refs against that dir and activate by reading the skill's `SKILL.md`.

- `vercel-react-best-practices` — React/Next.js perf rules; reference-only, expanded rules in `rules/`, compiled doc in its `AGENTS.md`.
- `web-design-guidelines` — fetch fresh rules from `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md` before every review; output in terse `file:line` groups.
- `next-best-practices` — Next.js best practices across 19 sub-files; metadata says `user-invocable: false` but it still activates on explicit request.

## Tool quirks

- Skill docs that say "use WebFetch" → use `read_url` instead (no WebFetch tool here).
