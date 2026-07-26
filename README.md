# Continuous audit ledger

Data branch. **Not** a development branch: no source, no CI, never merged into `main`.

Spec: <https://github.com/marcelsud/specs/blob/main/continuous-audit.md> §9

It lives outside `main` so that appending to it does not require code review and
does not interact with the project's merge gates. Every audit run reads it at
start and appends to it at end.

## Files

| File             | Contents                                            |
| ---------------- | --------------------------------------------------- |
| `topics.jsonl`   | One entry per run. Drives topic selection (§9.2).    |
| `findings.jsonl` | One entry per candidate finding, including rejections and why (§9.3). |

## Rules

- **Append-only** (§9.4). A correction is a new entry that supersedes the prior
  one, never an edit. Runs do not rewrite history.
- A **failed** run records `outcome: failed` and leaves its topic's staleness
  intact (§9.2). Recording a crashed run as `completed` would mark the topic
  audited and silently open a permanent coverage hole.
- Every disposition other than `filed` requires a `reason` (§9.3), because
  re-audit eligibility (§8.3) keys on *why* a candidate was rejected.

## Reading it

```bash
git show grading-ledger:topics.jsonl
node .github/grading/audit.mjs coverage    # from a main checkout
```
