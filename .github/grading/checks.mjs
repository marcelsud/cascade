import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { parse as parseYaml } from "yaml"

const RUBRIC_VERSION = "1.0.1"
const ELIGIBILITY_IDS = Array.from({ length: 9 }, (_, index) => `IE-${index + 1}`)
const VALUE_RULE_GRADES = new Map([
  ["D-nonconsequential", "D"],
  ["C-bounded-debt", "C"],
  ["A-blocker", "A"],
  ["A-core-guarantee", "A"],
  ["A-multi-component", "A"],
  ["A-project-gate", "A"],
  ["A-release-critical", "A"],
  ["B-localized-material", "B"],
])
const TEST_MODES = ["only", "skip", "todo", "skipIf", "runIf", "fails"]
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"])

export class CheckFailure extends Error {
  constructor(message, findings = []) {
    super(message)
    this.name = "CheckFailure"
    this.findings = findings
  }
}

const requireValue = (value, message) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CheckFailure(message)
  }
  return value.trim()
}

const parseRecordCandidate = (text) => {
  const candidates = []
  const fence = /```(?:yaml|yml)\s*\n([\s\S]*?)```/g
  for (const match of text.matchAll(fence)) {
    candidates.push(match[1])
  }
  if (candidates.length === 0) candidates.push(text)

  for (const candidate of candidates) {
    try {
      const parsed = parseYaml(candidate)
      if (parsed && typeof parsed === "object" && parsed.eligibility) return parsed
    } catch {
      // Another fenced YAML block may precede the grading record.
    }
  }
  throw new CheckFailure("No parseable §5.4 grading record found")
}

export const validateIssueRecord = (recordOrText) => {
  const record = typeof recordOrText === "string" ? parseRecordCandidate(recordOrText) : recordOrText
  if (!record || typeof record !== "object") throw new CheckFailure("Issue record must be a mapping")
  if (record.rubric_version !== RUBRIC_VERSION) {
    throw new CheckFailure(`rubric_version must be ${RUBRIC_VERSION}`)
  }

  for (const id of ELIGIBILITY_IDS) {
    const entry = record.eligibility?.[id]
    if (!entry || String(entry.answer).toLowerCase() !== "yes") {
      throw new CheckFailure(`${id} must answer yes`)
    }
    requireValue(entry.evidence, `${id} must cite non-empty evidence`)
  }

  if (!new Set(["blocker", "material", "cosmetic"]).has(record.severity)) {
    throw new CheckFailure("severity must be blocker, material, or cosmetic")
  }

  const valueRule = requireValue(record.value_rule, "value_rule is required")
  const computedGrade = VALUE_RULE_GRADES.get(valueRule)
  if (!computedGrade) throw new CheckFailure(`Unknown value_rule: ${valueRule}`)
  if (valueRule === "A-blocker" && record.severity !== "blocker") {
    throw new CheckFailure("A-blocker requires severity: blocker")
  }
  if (valueRule === "B-localized-material" && record.severity !== "material") {
    throw new CheckFailure("B-localized-material requires severity: material")
  }
  if (record.issue_grade !== computedGrade) {
    throw new CheckFailure(
      `issue_grade ${String(record.issue_grade)} conflicts with ${valueRule}; expected ${computedGrade}`,
    )
  }
  requireValue(record.grade_rationale, "grade_rationale is required")

  return { grade: computedGrade, record }
}

export const parseCoverageLines = (report) => {
  const match = report.match(
    /^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m,
  )
  if (!match) throw new CheckFailure("Coverage report has no parseable All files row")
  return Number(match[4])
}

export const checkCoverage = ({ report, baseline }) => {
  const current = parseCoverageLines(report)
  const expected = Number(baseline)
  if (!Number.isFinite(expected)) throw new CheckFailure("Coverage baseline is not numeric")
  const delta = Number((current - expected).toFixed(2))
  const result = { baseline: expected, current, delta }
  if (current < expected) {
    throw new CheckFailure(
      `RT-4 coverage regression: baseline=${expected.toFixed(2)} current=${current.toFixed(2)} delta=${delta.toFixed(2)}`,
      [result],
    )
  }
  return result
}

const git = (cwd, args, { allowFailure = false } = {}) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch (error) {
    if (allowFailure) return ""
    const detail = error?.stderr?.toString().trim() || error?.message || String(error)
    throw new CheckFailure(`git ${args.join(" ")} failed: ${detail}`)
  }
}

const listWorkingFiles = (root, relativeRoot) => {
  const absoluteRoot = path.join(root, relativeRoot)
  if (!existsSync(absoluteRoot)) return []
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry)
      if (statSync(absolute).isDirectory()) visit(absolute)
      else files.push(path.relative(root, absolute).split(path.sep).join("/"))
    }
  }
  visit(absoluteRoot)
  return files
}

const listRevisionFiles = (cwd, revision, root) => {
  const output = git(cwd, ["ls-tree", "-r", "--name-only", revision, "--", root])
  return output ? output.split("\n").filter(Boolean) : []
}

const readRevisionFile = (cwd, revision, file) =>
  git(cwd, ["show", `${revision}:${file}`], { allowFailure: true })

const sourceKind = (file) => {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (file.endsWith(".js")) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

const readSources = (cwd, files, revision) => {
  const sources = new Map()
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue
    const content = revision
      ? readRevisionFile(cwd, revision, file)
      : readFileSync(path.join(cwd, file), "utf8")
    sources.set(file, content)
  }
  return sources
}

const modeInventory = (sources) => {
  const counts = new Map(TEST_MODES.map((mode) => [mode, 0]))
  const conditionalSignatures = new Map([
    ["skipIf", new Map()],
    ["runIf", new Map()],
  ])

  for (const [file, content] of sources) {
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, sourceKind(file))
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && TEST_MODES.includes(node.name.text)) {
        const mode = node.name.text
        counts.set(mode, counts.get(mode) + 1)
        if (
          (mode === "skipIf" || mode === "runIf") &&
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node
        ) {
          const argumentsText = node.parent.arguments
            .map((argument) => argument.getText(source).replace(/\s+/g, ""))
            .join(",")
          const signature = `${mode}(${argumentsText})`
          const signatures = conditionalSignatures.get(mode)
          signatures.set(signature, (signatures.get(signature) ?? 0) + 1)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  return { counts, conditionalSignatures }
}

const addedDiscoveryConfig = (cwd, base) => {
  const diff = git(cwd, [
    "diff",
    "--unified=0",
    `${base}...HEAD`,
    "--",
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mts",
    "vitest.config.mjs",
  ])
  const discoveryKey = /\b(include|exclude|watchExclude|testNamePattern|passWithNoTests|allowOnly)\s*:/
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++") && discoveryKey.test(line.slice(1)))
}

export const checkTestIntegrity = ({ base, cwd = process.cwd() }) => {
  requireValue(base, "RT-2 requires --base <sha>")
  git(cwd, ["cat-file", "-e", `${base}^{commit}`])

  const baseFiles = listRevisionFiles(cwd, base, "tests")
  const headFiles = listWorkingFiles(cwd, "tests")
  const before = modeInventory(readSources(cwd, baseFiles, base))
  const after = modeInventory(readSources(cwd, headFiles))
  const findings = []

  for (const mode of TEST_MODES) {
    const baseCount = before.counts.get(mode)
    const headCount = after.counts.get(mode)
    if (headCount > baseCount) {
      findings.push(`new Vitest ${mode} mode: baseline=${baseCount} head=${headCount}`)
    }
  }

  for (const mode of ["skipIf", "runIf"]) {
    const baseSignatures = before.conditionalSignatures.get(mode)
    for (const [signature, count] of after.conditionalSignatures.get(mode)) {
      if (count > (baseSignatures.get(signature) ?? 0)) {
        findings.push(`new or changed conditional mode: ${signature}`)
      }
    }
  }

  for (const line of addedDiscoveryConfig(cwd, base)) {
    findings.push(`test discovery configuration changed: ${line.slice(1).trim()}`)
  }

  if (findings.length > 0) {
    throw new CheckFailure(`RT-2 test-integrity regression (${findings.length})`, findings)
  }
  return { modes: Object.fromEntries(after.counts), findings: [] }
}

const isFunctionNode = (node) =>
  (ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)) &&
  node.body

const propertyName = (name, source) => {
  if (!name) return undefined
  return name.getText(source)
}

const rawFunctionName = (node, source) => {
  if (node.name) {
    const ownName = propertyName(node.name, source)
    const owner = node.parent?.name ? propertyName(node.parent.name, source) : undefined
    return owner ? `${owner}.${ownName}` : ownName
  }
  if (ts.isVariableDeclaration(node.parent)) return propertyName(node.parent.name, source)
  if (ts.isPropertyAssignment(node.parent)) return propertyName(node.parent.name, source)
  if (ts.isConstructorDeclaration(node)) {
    const owner = node.parent?.name ? propertyName(node.parent.name, source) : "class"
    return `${owner}.constructor`
  }
  if (ts.isCallExpression(node.parent)) return `<callback:${node.parent.expression.getText(source)}>`
  return "<anonymous>"
}

const functionComplexity = (root) => {
  let complexity = 1
  const visit = (node) => {
    if (node !== root && isFunctionNode(node)) return
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node) ||
      ts.isCaseClause(node)
    ) {
      complexity += 1
    } else if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind)
    ) {
      complexity += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(root.body)
  return complexity
}

export const collectComplexities = (content, file) => {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, sourceKind(file))
  const occurrences = new Map()
  const functions = new Map()
  const visit = (node) => {
    if (isFunctionNode(node)) {
      const rawName = rawFunctionName(node, source)
      const occurrence = (occurrences.get(rawName) ?? 0) + 1
      occurrences.set(rawName, occurrence)
      const id = `${rawName}#${occurrence}`
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      functions.set(id, {
        id,
        complexity: functionComplexity(node),
        location: `${file}:${line}`,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return functions
}

const changedSourceFiles = (cwd, base) => {
  const output = git(cwd, ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`, "--", "src"])
  return output
    ? output.split("\n").filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    : []
}

export const checkComplexity = ({ base, ceiling, cwd = process.cwd() }) => {
  requireValue(base, "RT-5 requires --base <sha>")
  const max = Number(ceiling)
  if (!Number.isFinite(max)) throw new CheckFailure("RT-5 complexity ceiling is not numeric")
  const findings = []

  for (const file of changedSourceFiles(cwd, base)) {
    const headFunctions = collectComplexities(readFileSync(path.join(cwd, file), "utf8"), file)
    const baseContent = readRevisionFile(cwd, base, file)
    const baseFunctions = baseContent ? collectComplexities(baseContent, file) : new Map()

    for (const [id, head] of headFunctions) {
      if (head.complexity <= max) continue
      const before = baseFunctions.get(id)
      if (!before) {
        findings.push(`${head.location} new function complexity ${head.complexity} exceeds ${max}`)
      } else if (before.complexity <= max) {
        findings.push(
          `${head.location} complexity crossed ceiling: ${before.complexity} -> ${head.complexity} (max ${max})`,
        )
      } else if (head.complexity > before.complexity) {
        findings.push(
          `${head.location} existing hotspot worsened: ${before.complexity} -> ${head.complexity} (max ${max})`,
        )
      }
    }
  }

  if (findings.length > 0) throw new CheckFailure(`RT-5 complexity signal (${findings.length})`, findings)
  return { findings: [] }
}

const normalizedBody = (bodyText) => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, bodyText)
  const tokens = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.Identifier) tokens.push("$id")
    else if (
      [
        ts.SyntaxKind.StringLiteral,
        ts.SyntaxKind.NumericLiteral,
        ts.SyntaxKind.BigIntLiteral,
        ts.SyntaxKind.NoSubstitutionTemplateLiteral,
        ts.SyntaxKind.RegularExpressionLiteral,
      ].includes(token)
    ) {
      tokens.push("$literal")
    } else {
      tokens.push(scanner.getTokenText())
    }
  }
  return tokens
}

export const collectDuplicateCandidates = (content, file, minimumTokens) => {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, sourceKind(file))
  const candidates = []
  const visit = (node) => {
    if (isFunctionNode(node)) {
      const tokens = normalizedBody(node.body.getText(source))
      if (tokens.length >= minimumTokens) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        candidates.push({
          hash: createHash("sha256").update(tokens.join(" ")).digest("hex"),
          location: `${file}:${line}`,
          tokens: tokens.length,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return candidates
}

const duplicateGroups = (sources, minimumTokens) => {
  const groups = new Map()
  for (const [file, content] of sources) {
    for (const candidate of collectDuplicateCandidates(content, file, minimumTokens)) {
      const group = groups.get(candidate.hash) ?? []
      group.push(candidate)
      groups.set(candidate.hash, group)
    }
  }
  return groups
}

export const checkDuplicates = ({ base, minimumTokens, cwd = process.cwd() }) => {
  requireValue(base, "RT-6 requires --base <sha>")
  const minimum = Number(minimumTokens)
  if (!Number.isInteger(minimum) || minimum < 1) {
    throw new CheckFailure("RT-6 minimum_tokens must be a positive integer")
  }

  const baseFiles = listRevisionFiles(cwd, base, "src")
  const headFiles = listWorkingFiles(cwd, "src")
  const before = duplicateGroups(readSources(cwd, baseFiles, base), minimum)
  const after = duplicateGroups(readSources(cwd, headFiles), minimum)
  const findings = []

  for (const [hash, group] of after) {
    if (group.length < 2) continue
    const baseCount = before.get(hash)?.length ?? 0
    if (group.length > baseCount) {
      findings.push(
        `new duplicate block (${group[0].tokens} tokens, ${baseCount} -> ${group.length} copies): ${group
          .map(({ location }) => location)
          .join(", ")}`,
      )
    }
  }

  if (findings.length > 0) throw new CheckFailure(`RT-6 duplicate-rule signal (${findings.length})`, findings)
  return { findings: [] }
}

const readConfig = (file) => parseYaml(readFileSync(file, "utf8"))

const option = (args, name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const printFailure = (error) => {
  console.error(error.message)
  for (const finding of error.findings ?? []) {
    console.error(`- ${typeof finding === "string" ? finding : JSON.stringify(finding)}`)
  }
}

export const runCli = (argv = process.argv.slice(2), cwd = process.cwd()) => {
  const [command, ...args] = argv
  if (command === "issue-grade") {
    const file = requireValue(args[0], "usage: checks.mjs issue-grade <markdown-or-yaml-file>")
    const { grade } = validateIssueRecord(readFileSync(path.resolve(cwd, file), "utf8"))
    console.log(`issue-grade: ${grade}`)
    return
  }

  if (command === "test-integrity") {
    const result = checkTestIntegrity({ base: option(args, "--base"), cwd })
    console.log(`RT-2 pass: ${JSON.stringify(result.modes)}`)
    return
  }

  if (command === "coverage") {
    const reportFile = requireValue(option(args, "--report"), "coverage requires --report <file>")
    const configFile = requireValue(option(args, "--config"), "coverage requires --config <file>")
    const config = readConfig(path.resolve(cwd, configFile))
    const result = checkCoverage({
      report: readFileSync(path.resolve(cwd, reportFile), "utf8"),
      baseline: config.ratchets?.["RT-4"]?.baseline_total_lines_pct,
    })
    console.log(
      `RT-4 pass: baseline=${result.baseline.toFixed(2)} current=${result.current.toFixed(2)} delta=${result.delta.toFixed(2)}`,
    )
    return
  }

  if (command === "complexity") {
    const configFile = requireValue(option(args, "--config"), "complexity requires --config <file>")
    const config = readConfig(path.resolve(cwd, configFile))
    checkComplexity({
      base: option(args, "--base"),
      ceiling: config.ratchets?.["RT-5"]?.max_cyclomatic_complexity,
      cwd,
    })
    console.log("RT-5 pass: no new or worsened over-ceiling function")
    return
  }

  if (command === "duplicates") {
    const configFile = requireValue(option(args, "--config"), "duplicates requires --config <file>")
    const config = readConfig(path.resolve(cwd, configFile))
    checkDuplicates({
      base: option(args, "--base"),
      minimumTokens: config.ratchets?.["RT-6"]?.minimum_tokens,
      cwd,
    })
    console.log("RT-6 pass: no new duplicate block signal")
    return
  }

  throw new CheckFailure(
    "usage: checks.mjs <issue-grade|test-integrity|coverage|complexity|duplicates> [options]",
  )
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    runCli()
  } catch (error) {
    printFailure(error)
    process.exitCode = 1
  }
}

