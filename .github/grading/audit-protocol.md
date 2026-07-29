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

## 2. Investigate

Do not start by guessing at defects. A hypothesis pulled from memory is nearly always wrong, and
checking it teaches you nothing about the subsystem. Build an understanding first; the defects
fall out of the gaps.

Work through these in order. Each one produces notes you will use in the next.

### 2a. Establish the contract

Before you can call anything a defect, you need to know what the code is supposed to do.

Read, in this order: the objective text in `.github/grading/config.yml`, the subsystem's
`AGENTS.md` Local Contracts, its `docs/` page, then its exported types and doc comments.

Write down the guarantees as a short list of testable statements. If a guarantee is vague
("handles errors gracefully"), that vagueness is itself worth noting — an untestable contract
cannot be violated, and cannot be relied on either.

### 2b. Map the actual behavior

Trace the code and enumerate the paths. Do not summarise; build a table.

For most subsystems the useful axes are the ones that multiply: error category × configuration
present or absent × downstream outcome. For a DLQ that is roughly
`{fatal, intermittent, logical} × {dlq configured, not} × {dlq send ok, fails}` — twelve cells,
each with an answer for *does the send fail, is the message acknowledged, what is counted*.

A table is the point. Prose lets you skip a cell without noticing; a table shows the hole.

### 2c. Diff contract against behavior

Compare 2a with 2b, cell by cell. Defects live in three places:

- a guarantee with no corresponding path;
- a path that contradicts a guarantee;
- a cell you could not fill in, because the behavior is genuinely unclear.

The third is often the most productive. Code no one can predict is code no one has tested.

### 2d. Check what the tests actually assert

Find the subsystem's tests and read their assertions, not their names. A suite can be large and
still assert nothing about the cell you care about.

Map your 2b table onto the tests: which cells are covered, which are named but not asserted,
which are absent. An uncovered cell is where a defect survives, and it is the cheapest place to
look next.

### 2e. Probe, do not speculate

**This is the step that separates a finding from a guess.** Write a throwaway script and observe
what the code actually does at the boundary you care about. Measure it.

Reading produces hypotheses. Only running produces answers, and the answer is frequently that
your hypothesis was wrong — which is worth learning in ten minutes rather than after you have
written an issue.

Probe the cells your table could not fill and the ones the tests do not cover. Delete the scripts
afterward; their output belongs in the candidate's Evidence section.

---

Only now consider whether you have a defect. Prefer one you can demonstrate over three you can
argue for. If the investigation produced no gap, say so and finish the run — that is the expected
outcome, and the notes are still worth the run because they will sharpen the topic next time.

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
    runner: vitest
    test_files: [tests/unit/inputs/http-input.test.ts]
    test_name: rejects request bodies over the configured limit
    failure_contains: expected status 413
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

The reproduction must be a Vitest test that **fails at the audited commit**. You declare its files,
test name, and a literal excerpt of the expected assertion failure; you do not choose the command.
The tool creates a disposable worktree at the recorded commit, installs dependencies from the
frozen lockfile with package scripts disabled, copies only the declared tests, and runs Vitest. It
accepts the named failing assertion and failure message from Vitest's structured result—not process
output. A collection error, printed text, passing test, unnamed failure, or different failure records
the candidate as `unproven`. The ledger keeps bounded test contents, hashes, structured assertion
output, the lockfile/runner identity, and a replay command.

Usually that means writing a test that fails. Add it under `tests/`, point the command at it, and
make sure it fails **for your reason**:

- A test that fails because of a typo, a missing import, or an unrelated pre-existing failure is
  not a reproduction.
- A test that would fail identically against a correct implementation is not a reproduction.

Check the second one deliberately. Ask: *if this defect were fixed, would this test then pass?*
If you cannot answer yes, you have not isolated the defect. This is the most common way a
plausible-looking finding turns out to be nothing.

If the defect cannot be expressed as a failing Vitest test, it is **out of scope for this loop**. Drop
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

First write a report that makes the inspection enumerable. Every inspected path must belong to the
selected topic and exist at the audited commit. Every behavior-cell evidence reference must name an
existing line in an inspected path. `contract_ids` are the selected topic's registered objectives.

````markdown
# Audit report

```yaml
audit_report:
  inspected_paths:
    - src/inputs/http-input.ts
  contract_ids: [REL-1, REL-2]
  behavior_cells:
    - id: body-over-limit
      evidence: [src/inputs/http-input.ts:120]
    - id: body-within-limit
      evidence: [src/inputs/http-input.ts:145]
```
````

```bash
node .github/grading/audit-run.mjs finish --report report.md
```

This validates and hashes the report, appends the ledger, and closes the run. **Always finish**,
including when you found nothing — otherwise the next `start` records your run as failed and the
topic keeps its staleness. A zero-finding run without inspection evidence does not count as
coverage. `file` and `finish` reject a changed `HEAD`, and `file` accepts only the exact candidate
body hashed by `check`.

---

## Rehearsing

`file` and `finish` both accept `--dry-run`: they report what they would do and change nothing.
Use them when validating the loop itself rather than auditing.

## Calibrating an agent

The audit loop produces evidence; it does not accept an agent's confidence estimate. A separate
controller runs private labeled buggy and clean cases, verifies every observed finding through the
same evidence gate, and signs each JSONL record with an external HMAC key. Keep both labels and key
outside the repository and outside the agent sandbox.

```bash
node .github/grading/calibration.mjs evaluate /private/results.jsonl \
  --key-file /private/controller.key --require-qualified
```

All records in one evaluation must name the same exact `model`, `prompt_hash`, `toolchain_hash`,
and `topic_id`. The gate reports precision, sensitivity, specificity, abstention, and one-sided
95% Wilson lower bounds. It exits nonzero until the minimum buggy/clean case counts and thresholds
in `config.yml` are met. Recalibrate after changing any member of that identity tuple. The result
applies to the fixed labeled benchmark only; do not present it as generalized repository quality.

## What a good finding looks like

Issues #112 through #116 in this repository were produced by this methodology by hand. They share
a shape worth copying: a specific invariant, a runtime reproduction with real measured output, a
bounded scope, and acceptance criteria that are observable rather than aspirational.
