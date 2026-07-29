import assert from "node:assert/strict"
import test from "node:test"
import {
  evaluateCalibration,
  parseCalibrationResults,
  signCalibrationRecord,
  wilsonLowerBound,
} from "./calibration.mjs"

const record = (caseId, expected, observed, overrides = {}) => ({
  case_id: caseId,
  topic_id: "alpha",
  model: "model-v1",
  prompt_hash: "prompt-1",
  toolchain_hash: "tools-1",
  expected,
  observed,
  ...(observed === "finding" ? { evidence_verified: true } : {}),
  ...overrides,
})

const policy = {
  minimum_bug_cases: 2,
  minimum_clean_cases: 2,
  finding_precision_lcb: 0.4,
  no_finding_sensitivity_lcb: 0.4,
  clean_specificity_lcb: 0.4,
  max_abstention_rate: 0.1,
}

const SECRET = "controller-secret"
const signed = (entry) => ({
  ...entry,
  signature: signCalibrationRecord(entry, SECRET),
})

test("Wilson lower bound reports uncertainty instead of the point estimate", () => {
  assert.equal(wilsonLowerBound(0, 0), null)
  assert.ok(wilsonLowerBound(60, 60) > 0.95)
  assert.ok(wilsonLowerBound(6, 6) < 0.7)
})

test("calibration qualifies only a sufficiently large verified result set", () => {
  const records = [
    record("bug-1", "finding", "finding"),
    record("bug-2", "finding", "finding"),
    record("clean-1", "clean", "clean"),
    record("clean-2", "clean", "clean"),
  ]
  const result = evaluateCalibration({ records, policy })
  assert.equal(result.authority.qualified, true)
  assert.equal(result.metrics.precision.estimate, 1)
  assert.equal(result.benchmark_scope.startsWith("fixed labeled"), true)
})

test("calibration fails closed on false findings, misses, and too few cases", () => {
  const errors = [
    record("bug-1", "finding", "clean"),
    record("bug-2", "finding", "finding"),
    record("clean-1", "clean", "finding"),
    record("clean-2", "clean", "clean"),
  ]
  assert.equal(evaluateCalibration({ records: errors, policy }).authority.qualified, false)
  assert.equal(
    evaluateCalibration({ records: errors.slice(0, 2), policy }).authority.qualified,
    false,
  )
})

test("result parser rejects unverified findings, duplicates, and mixed identities", () => {
  const jsonl = (records) => records.map((entry) => JSON.stringify(signed(entry))).join("\n")
  assert.throws(
    () =>
      parseCalibrationResults(
        jsonl([record("x", "finding", "finding", { evidence_verified: false })]),
        { secret: SECRET },
      ),
    /externally verified/,
  )
  assert.throws(
    () =>
      parseCalibrationResults(
        jsonl([record("x", "clean", "clean"), record("x", "clean", "clean")]),
        { secret: SECRET },
      ),
    /duplicate/,
  )
  assert.throws(
    () =>
      parseCalibrationResults(
        jsonl([record("x", "clean", "clean"), record("y", "clean", "clean", { model: "other" })]),
        { secret: SECRET },
      ),
    /mixes model/,
  )
  assert.throws(
    () =>
      parseCalibrationResults(
        jsonl([
          record("x", "clean", "clean"),
          record("y", "clean", "clean", { topic_id: "other" }),
        ]),
        { secret: SECRET },
      ),
    /mixes topic_id/,
  )
  assert.throws(
    () =>
      parseCalibrationResults(jsonl([record("x", "clean", "clean")]), {
        secret: "wrong",
      }),
    /signature/,
  )
})
