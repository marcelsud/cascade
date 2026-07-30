#!/usr/bin/env node
import fs from "node:fs"
import { createHmac, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { AuditFailure } from "./audit.mjs"

const DEFAULT_CONFIG = ".github/grading/config.yml"
const EXPECTED = new Set(["finding", "clean"])
const OBSERVED = new Set(["finding", "clean", "abstain"])

export const wilsonLowerBound = (successes, total, z = 1.6448536269514722) => {
  if (total === 0) return null
  const probability = successes / total
  const z2 = z * z
  return (
    (probability +
      z2 / (2 * total) -
      z * Math.sqrt((probability * (1 - probability) + z2 / (4 * total)) / total)) /
    (1 + z2 / total)
  )
}

const canonicalRecord = (record) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "signature")
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  )

export const signCalibrationRecord = (record, secret) =>
  createHmac("sha256", secret).update(canonicalRecord(record)).digest("hex")

export const parseCalibrationResults = (text, { secret } = {}) => {
  if (!secret?.length) throw new AuditFailure("calibration requires an external signing key")
  const records = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        throw new AuditFailure(`malformed calibration JSON on line ${index + 1}`)
      }
    })

  if (records.length === 0) throw new AuditFailure("calibration results are empty")
  const seen = new Set()
  const identity = ["model", "prompt_hash", "toolchain_hash", "topic_id"]
  const expectedIdentity = identity.map((field) => records[0][field])

  records.forEach((record, index) => {
    const expectedSignature = signCalibrationRecord(record, secret)
    const suppliedSignature = String(record.signature ?? "")
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(Buffer.from(suppliedSignature), Buffer.from(expectedSignature))
    ) {
      throw new AuditFailure(
        `invalid controller signature: ${record.case_id ?? `line ${index + 1}`}`,
      )
    }
    for (const field of ["case_id", ...identity, "expected", "observed"]) {
      if (typeof record[field] !== "string" || record[field].trim() === "") {
        throw new AuditFailure(`calibration line ${index + 1} requires ${field}`)
      }
    }
    if (seen.has(record.case_id))
      throw new AuditFailure(`duplicate calibration case: ${record.case_id}`)
    seen.add(record.case_id)
    if (!EXPECTED.has(record.expected)) {
      throw new AuditFailure(`calibration expected must be finding or clean: ${record.case_id}`)
    }
    if (!OBSERVED.has(record.observed)) {
      throw new AuditFailure(
        `calibration observed must be finding, clean, or abstain: ${record.case_id}`,
      )
    }
    if (record.observed === "finding" && record.evidence_verified !== true) {
      throw new AuditFailure(`finding lacks externally verified evidence: ${record.case_id}`)
    }
    identity.forEach((field, identityIndex) => {
      if (record[field] !== expectedIdentity[identityIndex]) {
        throw new AuditFailure(`calibration mixes ${field} values`)
      }
    })
  })

  return records
}

const metric = (successes, total) => ({
  successes,
  total,
  estimate: total === 0 ? null : successes / total,
  lower_95_one_sided: wilsonLowerBound(successes, total),
})

export const evaluateCalibration = ({ records, policy }) => {
  const bugs = records.filter((record) => record.expected === "finding")
  const clean = records.filter((record) => record.expected === "clean")
  const tp = bugs.filter((record) => record.observed === "finding").length
  const fp = clean.filter((record) => record.observed === "finding").length
  const tn = clean.filter((record) => record.observed === "clean").length
  const abstentions = records.filter((record) => record.observed === "abstain").length
  const precision = metric(tp, tp + fp)
  const sensitivity = metric(tp, bugs.length)
  const specificity = metric(tn, clean.length)
  const abstentionRate = abstentions / records.length

  const enoughCases =
    bugs.length >= policy.minimum_bug_cases && clean.length >= policy.minimum_clean_cases
  const findingAuthority =
    enoughCases &&
    precision.lower_95_one_sided >= policy.finding_precision_lcb &&
    abstentionRate <= policy.max_abstention_rate
  const noFindingAuthority =
    enoughCases &&
    sensitivity.lower_95_one_sided >= policy.no_finding_sensitivity_lcb &&
    specificity.lower_95_one_sided >= policy.clean_specificity_lcb &&
    abstentionRate <= policy.max_abstention_rate

  return {
    identity: {
      model: records[0].model,
      prompt_hash: records[0].prompt_hash,
      toolchain_hash: records[0].toolchain_hash,
      topic_id: records[0].topic_id,
    },
    benchmark_scope: "fixed labeled cases only; no generalized accuracy claim",
    cases: { buggy: bugs.length, clean: clean.length, total: records.length },
    confusion: {
      true_positive: tp,
      false_positive: fp,
      true_negative: tn,
      false_negative: bugs.length - tp,
    },
    metrics: {
      precision,
      sensitivity,
      specificity,
      abstention_rate: abstentionRate,
    },
    thresholds: policy,
    authority: {
      finding: findingAuthority,
      no_finding: noFindingAuthority,
      qualified: findingAuthority && noFindingAuthority,
    },
  }
}

const option = (args, name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const runCli = () => {
  const [command, resultsFile, ...args] = process.argv.slice(2)
  if (command !== "evaluate" || !resultsFile) {
    throw new AuditFailure(
      "usage: calibration.mjs evaluate <results.jsonl> --key-file <path> [--config <file>] [--require-qualified]",
    )
  }
  const configFile = option(args, "--config") ?? DEFAULT_CONFIG
  const config = parseYaml(fs.readFileSync(configFile, "utf8"))
  const policy = config?.calibration
  if (!policy) throw new AuditFailure(`${configFile} declares no calibration policy`)

  const keyFile = option(args, "--key-file")
  if (!keyFile) throw new AuditFailure("calibration requires --key-file outside the repository")
  const absoluteKey = path.resolve(keyFile)
  const repository = path.resolve(process.cwd())
  if (absoluteKey === repository || absoluteKey.startsWith(`${repository}${path.sep}`)) {
    throw new AuditFailure("calibration signing key must remain outside the repository")
  }
  const records = parseCalibrationResults(fs.readFileSync(resultsFile, "utf8"), {
    secret: fs.readFileSync(absoluteKey),
  })
  const result = evaluateCalibration({ records, policy })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (args.includes("--require-qualified") && !result.authority.qualified) process.exitCode = 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
