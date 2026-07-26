# Continuous audit — agent protocol

Operating instructions for conducting one audit run of this repository.

Spec: <https://github.com/marcelsud/specs/blob/main/continuous-audit.md> (1.1.0)
Grading: <https://github.com/marcelsud/specs/blob/main/grading-methodology.md> (1.1.0)

You are the top-level process. The tool at `.github/grading/audit-run.mjs` performs every
deterministic step and decides what is allowed to leave the machine. You decide what to examine
and what to claim.

---

## Before you start

**Finding nothing is success.** A run that examines its topic and reports no findings is a
completed run, not a failure. Do not widen the topic, do not lower your bar, and do not file
something marginal to justify the run. Manufactured findings cost more than they appear to: they
pass a skim, consume review capacity, and are only disproved by the same work that should have
prevented them.

Most runs on a healthy codebase should find nothing. That is the expected outcome, not a problem
to solve.

---

## 1. Open the run

```bash
node .github/grading/audit-run.mjs start
```

It prints your topic, the run id, the commit under audit, and `known_fingerprints` — findings the
ledger already holds for this topic. Read those first: re-proposing one wastes the run.

**Audit only the topic you were given.** You did not choose it, and you may not change it. If it
looks unpromising, that is still the topic; report nothing and finish.

## 2. Examine

Read the topic's `paths` against its `objectives`. The objective tells you what property is
supposed to hold — you are looking for a case where it does not.

Useful questions, in rough order of yield:

- What does the documentation or the type signature promise that the code does not deliver?
- What happens on the error path, not the happy path?
- What happens when a resource is acquired and then something fails before release?
- What is unbounded — memory, time, retries, queue depth?
- What is reported as success when it is not?

Prefer one defect you can demonstrate over three you can argue for.

## 3. Write a candidate

A candidate is the **proposed issue body**. It must satisfy IE-1..IE-9, so use the same shape as
`.github/ISSUE_TEMPLATE/graded-issue.yml`, plus one extra block:

````markdown
# <a title stating the defect, not the fix>

```yaml
audit_candidate:
  path: src/inputs/http-input.ts
  consequence_category: reliability
  normalized_claim: request bodies buffered without a byte limit
  reproduction:
    command: ["npx", "vitest", "run", "tests/unit/inputs/http-input.test.ts"]
```

## Problem
...
## Evidence
...
## Consequence
...
## Scope and non-scope
...
## Acceptance criteria
...
## Regression proof
...

## Grading record

```yaml
rubric_version: 1.1.0
eligibility:
  IE-1: { answer: yes, evidence: "..." }
  ...
severity: blocker | material | cosmetic
value_rule: ...
issue_grade: ...
grade_rationale: >-
  ...
```
````

`consequence_category` must be one of the canonical categories: correctness or data integrity;
reliability; security or privacy; operability or observability; testing or test trust; maintenance
or ownership cost.

`normalized_claim` states the root cause in one line. It is fingerprinted, so keep it stable and
descriptive — not "bug in http input", but "request bodies buffered without a byte limit".

## 4. The reproduction

**This is the part that decides whether your finding exists.**

`reproduction.command` must be a command that **fails at the current commit**. The tool runs it
itself and ignores anything you report about having run it. A command that succeeds demonstrates
working software, and the candidate is recorded `unproven`.

Usually that means writing a test that fails. Add it under `tests/`, point the command at it, and
make sure it fails **for your reason**:

- A test that fails because of a typo, a missing import, or an unrelated pre-existing failure is
  not a reproduction.
- A test that would fail identically against a correct implementation is not a reproduction.

Check the second one deliberately. Ask: *if this defect were fixed, would this test then pass?*
If you cannot answer yes, you have not isolated the defect. This is the most common way a
plausible-looking finding turns out to be nothing.

If the defect cannot be expressed as a failing command, it is **out of scope for this loop**. Drop
it and say so. That is a deliberate trade: precision over recall, because an unattended loop that
files unverifiable findings costs more review capacity than it creates.

## 5. Check

```bash
node .github/grading/audit-run.mjs check candidate.md
```

The tool deduplicates, runs your reproduction, and grades the record. It returns a disposition:

| Disposition   | What happened                                    | What to do            |
| ------------- | ------------------------------------------------ | --------------------- |
| `filed`       | Verified and eligible                            | `file` it             |
| `duplicate`   | Fingerprint already in the ledger                | nothing; move on      |
| `unproven`    | Reproduction did not run, or ran and passed      | fix it or abandon it  |
| `ineligible`  | Reproduced, but the grading record was rejected  | repair the record     |

If `needs_adjudication` is non-empty, the ledger holds a finding with the same path and
consequence category. Read it. If it is the same root cause, `drop` yours as `duplicate`.

**Do not weaken the claim to pass the gate.** An issue that only becomes eligible after its scope
is broadened is `ineligible`. Narrowing to what you actually demonstrated is fine and correct;
inflating consequence to reach a higher grade is not.

## 6. Resolve every candidate

Each verified candidate must be either filed or dropped with a reason:

```bash
node .github/grading/audit-run.mjs file candidate.md
node .github/grading/audit-run.mjs drop candidate.md --disposition duplicate --reason "same root cause as #112"
```

`finish` refuses while any verified candidate is unresolved. The reason is recorded and is what
lets a later run decide whether to re-examine it, so write it for that reader.

## 7. Close the run

```bash
node .github/grading/audit-run.mjs finish
```

This appends the ledger and closes the run. **Always finish**, including when you found nothing —
otherwise the next `start` records your run as failed and the topic keeps its staleness, which
wastes the coverage this run should have bought.

---

## Rehearsing

`file` and `finish` both accept `--dry-run`: they report what they would do and change nothing.
Use them when validating the loop itself rather than auditing.

## What a good finding looks like

Issues #112 through #116 in this repository were produced by this methodology by hand. They share
a shape worth copying: a specific invariant, a runtime reproduction with real measured output, a
bounded scope, and acceptance criteria that are observable rather than aspirational.
