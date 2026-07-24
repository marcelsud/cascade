<!-- Grading methodology rubric 1.0.1 — spec §13.2. Config: .github/grading/config.yml -->

Closes #<primary-issue>

## Exemption
<!-- Delete this section unless the PR is issue-exempt (spec §6.2). If exempt,
     apply the grading:exempt label, pick one class, and justify. -->
- Class: clean revert | emergency containment | dependency metadata | administrative repository change | release metadata
- Why normal issue grading is inapplicable:

## Acceptance evidence (SG-3)
<!-- One row per acceptance criterion of the primary issue. -->
| AC | Evidence (test file, command output, or CI run link) |
|----|-------------------------------------------------------|
| AC-1 | |

## Behavioral and failure-path tests (SG-5, EX-4, EX-5)
- Changed behavior exercised by:
- Material failure path exercised by:

## Slop ledger (SG-9, spec §9)
```yaml
slop_delta:
  added: { S3: 0, S2: 0, S1: 0 }
  removed: { S3: 0, S2: 0, S1: 0 }
```
<!-- Every added S1/S2 needs a §9.4 entry: tier, category, file:line,
     consequence, justification, disposition, owner, follow_up_issue. -->

## Ratchet exceptions (SG-8, spec §10.3)
None

## Author-proposed execution grade (spec §8)
<!-- Not authoritative; reviewer consensus computes the final grade. -->
| EX | Answer | Note (required for any "no") |
|----|--------|------------------------------|
| EX-1 | yes | |
| EX-2 | yes | |
| EX-3 | yes | |
| EX-4 | yes | |
| EX-5 | yes | |
| EX-6 | yes | |
| EX-7 | yes | |
| EX-8 | yes | |
| EX-9 | yes | |

Proposed execution grade: A

Proposed-grade rationale: All EX checks are yes and the slop ledger adds no S1, S2, or S3 liability.

## Reviewer consensus records (report-only)
<!-- Reviewers do not edit this PR body. Each reviewer independently copies
     `.github/grading/reviewer-template.yml` into a separate PR comment before
     reading another review. The persisted comments are §16 step 4 disagreement
     data. No consensus check is branch-protected in this phase. -->
