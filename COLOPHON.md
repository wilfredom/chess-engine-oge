# COLOPHON

## How this was made

- **Model:** Claude Fable 5.1 (`claude-fable-5-1`), running in Claude Code with
  parallel subagents (workflows) for the web app build/testing and for an
  adversarial review of the engine. Subagents ran the same model.
- **Tokens:** approximately TOKENS_PLACEHOLDER (main session context consumed plus
  subagent output; exact accounting is not exposed to the model, so this is an
  estimate from the session's token counters).
- **Wall-clock time:** START_PLACEHOLDER to END_PLACEHOLDER UTC, about DURATION_PLACEHOLDER
  in total, of which roughly MATCH_HOURS_PLACEHOLDER were fastchess matches on a 4-core box.
- **Reference engines/tools:** Patricia 5.1 (commit 67d83d7, the first release line with
  `Skill_Level` is Patricia 4; Patricia 3.0 has no skill levels), fastchess 60d7a7a,
  python-chess 1.11.2 (move-generation oracle), chessground 9.2.1.

## Skill levels

LEVELS_PLACEHOLDER

## The prompt

PROMPT_PLACEHOLDER
