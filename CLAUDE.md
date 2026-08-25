# stk — repo instructions

## Commit messages

- Prefix every commit subject with `[<tool>]:` where `<tool>` is the tool or area changed, matching its folder under `tools/` (e.g. `svg`).
  - Example: `[svg]: Inline Illustrator CSS classes as presentation attributes`
- Cross-cutting changes (dispatcher `bin/`, shared `lib/`, packaging, docs) use `[core]:`.
- Keep the existing global rules: single-line subject only, commit AND push after confirmation.
