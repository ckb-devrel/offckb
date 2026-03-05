---
"@offckb/cli": patch
---

Add skip-changeset label support to changeset-check CI workflow

PRs with the 'skip-changeset' label will now bypass the changeset requirement.
This is useful for documentation, CI, and refactoring changes that don't need
a changelog entry.
