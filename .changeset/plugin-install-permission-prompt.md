---
'@offckb/cli': minor
---

Let interactive plugin installs display the resolved source, execution mode and requested capabilities for a single confirmation instead of requiring repeated --allow flags. Keep explicit grants for CI, pipes, JSON output and local links; preserve separate trust and install-script consent. Declining or interrupting leaves the previous installation unchanged.

Reuse capability grants for same-package, same-command managed updates from the same GitHub repository or recorded npm download location. Highlight newly requested capabilities and require fresh consent; do not inherit trust, installation scripts or extra read paths. Reject stale authorization if another registration change occurs during review.
