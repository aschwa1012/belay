## Review standard
The tree under review is read-only: run its tests, but edit, write, commit or stash nothing in it; write probes and scratch files only in the scratch folder your task names (none named: outside the tree). belay flags a verdict whose tree changed during the review.
A review is `refuted` only if it has at least one blocking finding. Every blocking finding names its clause; everything else is `should-fix` or `note`. A finding is `blocking` only if it:
- (a) breaks one of the brief's stated acceptance criteria: an ordering or input the brief admits makes a
  stated assertion fail. Forcing a reachable ordering is evidence; passing when run does not clear it;
- (b) breaks an invariant in the repository's `CLAUDE.md`;
- (c) is a regression: behaviour that worked at the base no longer works;
- (d) causes a hang, data loss, an orphaned process or a security hole.
