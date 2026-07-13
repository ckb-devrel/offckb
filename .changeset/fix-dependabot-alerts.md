---
"@offckb/cli": patch
---

Resolve Dependabot security alerts via pnpm overrides for transitive dependencies:

- `qs` 6.15.0 → 6.15.2
- `ip-address` 10.1.0 → 10.1.1
- `js-yaml` 3.14.2 → 3.15.0 / 4.1.1 → 4.2.0
- `@babel/core` 7.28.6 → 7.29.7
- `@eslint/plugin-kit` 0.2.8 → 0.3.4
- `brace-expansion` 5.0.5 → 5.0.6

`elliptic` remains unfixed because a patched version (>=6.6.2) is not yet published on npm.
