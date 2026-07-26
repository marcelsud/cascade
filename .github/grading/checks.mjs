import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
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
const VITEST_CONFIG_CANDIDATES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
]
const VITEST_WORKSPACE_CANDIDATES = [
  "vitest.workspace.ts",
  "vitest.workspace.mts",
  "vitest.workspace.js",
  "vitest.workspace.mjs",
  "vitest.workspace.cjs",
  "vitest.projects.ts",
  "vitest.projects.mts",
  "vitest.projects.js",
  "vitest.projects.mjs",
  "vitest.projects.cjs",
]
// Config keys that can change which tests execute without changing the file set
// returned by `vitest list --filesOnly`. Any add/change between base and head
// fails RT-2 closed — list alone cannot see them.
const VITEST_EXECUTION_AFFECTING_KEYS = new Set([
  "dir",
  "testNamePattern",
  "passWithNoTests",
  "includeSource",
  "allowOnly",
])
const VITEST_LIST_TIMEOUT_MS = 60_000
const VITEST_RUN_SUBCOMMAND = "run"
const VITEST_NON_RUN_SUBCOMMANDS = new Set(["watch", "dev", "related", "bench", "list"])
// Runner flags that do not change which files Vitest collects. Value forms
// consume the next argv token; boolean forms do not.
const VITEST_HARMLESS_VALUE_OPTIONS = new Set([
  "--reporter",
  "--pool",
  "--poolOptions",
  "--maxWorkers",
  "--minWorkers",
  "--api",
  "--outputFile",
  "--environment",
  "--mode",
  "--testTimeout",
  "--hookTimeout",
  "--bail",
  "--retry",
  "--diff",
  "--slowTestThreshold",
  "--teardownTimeout",
  "--maxConcurrency",
  "--sequence",
  "--inspect",
  "--inspectBrk",
  "--expect",
])
const VITEST_HARMLESS_BOOLEAN_OPTIONS = new Set([
  "-u",
  "--update",
  "-w",
  "--watch",
  "--ui",
  "--open",
  "--silent",
  "--hideSkippedTests",
  "--coverage",
  "--isolate",
  "--no-isolate",
  "--globals",
  "--dom",
  "--fileParallelism",
  "--no-fileParallelism",
  "--passWithNoTests",
  "--logHeapUsage",
  "--allowOnly",
  "--dangerouslyIgnoreUnhandledErrors",
  "--expandSnapshotDiff",
  "--disableConsoleIntercept",
  "--typecheck",
  "--cache",
  "--no-cache",
  "--printConsoleTrace",
  "--run",
  "--no-color",
  "--clearScreen",
  "--no-clearScreen",
])
// Flags that exit before executing the suite — never a valid CI unit command.
const VITEST_EARLY_EXIT_OPTIONS = new Set(["-h", "--help", "-v", "--version"])
const SHELL_OPERATOR_TOKENS = new Set([
  "||",
  "&&",
  "|",
  ";",
  "&",
  ">",
  "<",
  ">>",
  "<<",
  ">&",
  "&>",
  "2>",
  "2>>",
  "1>",
  "1>>",
  "2>&1",
  ">&2",
])
// Selection-affecting CLI options. Presence fails RT-2 closed at parse time.
const VITEST_UNSUPPORTED_SELECTORS = new Set([
  "-t",
  "--testNamePattern",
  "--project",
  "--changed",
  "--shard",
  "--workspace",
  "--browser",
  "--standalone",
  "--mergeReports",
  "--related",
])
// Only skip VCS/package trees while walking source for RT-5/RT-6.
const SKIP_WALK_DIRECTORIES = new Set([".git", "node_modules"])

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
])
const MODE_SCAN_EXTENSIONS = SOURCE_EXTENSIONS

const CHECKER_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

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

const git = (cwd, args, { allowFailure = false, trim = true } = {}) => {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return trim ? output.trim() : output
  } catch (error) {
    if (allowFailure) return ""
    const detail = error?.stderr?.toString().trim() || error?.message || String(error)
    throw new CheckFailure(`git ${args.join(" ")} failed: ${detail}`)
  }
}

const listWorkingFiles = (root, relativeRoot = ".") => {
  const absoluteRoot = path.join(root, relativeRoot)
  if (!existsSync(absoluteRoot)) return []
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (SKIP_WALK_DIRECTORIES.has(entry)) continue
      const absolute = path.join(directory, entry)
      if (statSync(absolute).isDirectory()) visit(absolute)
      else files.push(path.relative(root, absolute).split(path.sep).join("/"))
    }
  }
  visit(absoluteRoot)
  return files
}

const listRevisionFiles = (cwd, revision, root = ".") => {
  const output = git(cwd, ["ls-tree", "-r", "--name-only", revision, "--", root])
  return output ? output.split("\n").filter(Boolean) : []
}

const readRevisionFile = (cwd, revision, file) =>
  // Preserve trailing newlines — content equality for rename detection depends on it.
  git(cwd, ["show", `${revision}:${file}`], { allowFailure: true, trim: false })

const readTextAt = (cwd, file, revision) => {
  if (revision) return readRevisionFile(cwd, revision, file)
  const absolute = path.join(cwd, file)
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : ""
}

const sourceKind = (file) => {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (file.endsWith(".mjs") || file.endsWith(".cjs") || file.endsWith(".js")) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

const readSources = (cwd, files, revision) => {
  const sources = new Map()
  for (const file of files) {
    const extension = path.extname(file)
    if (!MODE_SCAN_EXTENSIONS.has(extension)) {
      throw new CheckFailure(
        `RT-2 cannot inventory Vitest modes in unsupported extension: ${file}`,
      )
    }
    const content = readTextAt(cwd, file, revision)
    if (content === "") continue
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

const tokenizeCommand = (command) => {
  // Reject shell metacharacters that are not inside quotes before tokenizing.
  // Quoted content is preserved; unquoted operators/comments/redirections fail closed.
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === "#") {
      throw new CheckFailure(
        `RT-2 rejects shell comments in test:unit script: ${command}`,
      )
    }
    if (ch === "|" || ch === "&" || ch === ";" || ch === ">" || ch === "<" || ch === "`" || ch === "\n") {
      throw new CheckFailure(
        `RT-2 rejects shell operators in test:unit script: ${command}`,
      )
    }
    if (ch === "$" && command[i + 1] === "(") {
      throw new CheckFailure(
        `RT-2 rejects shell substitution in test:unit script: ${command}`,
      )
    }
  }

  const tokens = []
  const pattern = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\s]+/g
  for (const match of command.matchAll(pattern)) {
    const raw = match[0]
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      tokens.push(raw.slice(1, -1))
    } else {
      if (SHELL_OPERATOR_TOKENS.has(raw) || raw.startsWith(">") || raw.startsWith("<")) {
        throw new CheckFailure(
          `RT-2 rejects shell operators in test:unit script: ${command}`,
        )
      }
      tokens.push(raw)
    }
  }
  return tokens
}


const parseVitestUnitCommand = (script) => {
  const tokens = tokenizeCommand(script)
  if (tokens.length === 0) {
    throw new CheckFailure("RT-2 could not parse empty test:unit script")
  }

  let index = 0
  if (tokens[index] === "npm" && tokens[index + 1] === "exec") index += 2
  else if (
    tokens[index] === "npx" ||
    tokens[index] === "bunx" ||
    tokens[index] === "pnpm" ||
    tokens[index] === "yarn"
  ) {
    index += 1
    if (tokens[index] === "exec") index += 1
  } else if (tokens[index] === "bun" && tokens[index + 1] === "x") {
    index += 2
  } else if (tokens[index] === "node" && tokens[index + 1]?.includes("vitest")) {
    // node path/to/vitest ...
  }

  const runner = tokens[index]
  if (!runner || path.basename(runner) !== "vitest") {
    throw new CheckFailure(
      `RT-2 requires test:unit to invoke vitest; got script: ${script}`,
    )
  }
  index += 1

  // Require exactly one shell-free `vitest run` invocation. Bare `vitest`
  // without a subcommand defaults to watch mode and must not pass RT-2.
  if (!tokens[index] || tokens[index] !== VITEST_RUN_SUBCOMMAND) {
    if (tokens[index] && VITEST_NON_RUN_SUBCOMMANDS.has(tokens[index])) {
      throw new CheckFailure(
        `RT-2 requires test:unit to use vitest run; got subcommand '${tokens[index]}' (script: ${script})`,
      )
    }
    throw new CheckFailure(
      `RT-2 requires test:unit to use vitest run (script: ${script})`,
    )
  }
  index += 1

  const filters = []
  const cliExcludes = []
  let configPath
  let dir
  let root
  let passWithNoTests = false
  let allowOnly = false

  const takeValue = (flag, inline) => {
    const value = inline !== undefined ? inline : tokens[++index]
    if (typeof value !== "string" || value === "" || value.startsWith("-")) {
      throw new CheckFailure(
        `RT-2 could not parse value for ${flag} in test:unit script: ${script}`,
      )
    }
    return value
  }

  while (index < tokens.length) {
    const token = tokens[index]
    if (token === "--") {
      index += 1
      continue
    }
    if (token.startsWith("-")) {
      const eq = token.indexOf("=")
      const flag = eq === -1 ? token : token.slice(0, eq)
      const inline = eq === -1 ? undefined : token.slice(eq + 1)

      if (VITEST_EARLY_EXIT_OPTIONS.has(flag)) {
        throw new CheckFailure(
          `RT-2 rejects early-exit Vitest flag in test:unit: ${flag} (script: ${script})`,
        )
      }
      if (flag === "--config" || flag === "-c") {
        configPath = takeValue(flag, inline).split(path.sep).join("/")
      } else if (flag === "--exclude") {
        cliExcludes.push(takeValue(flag, inline).split(path.sep).join("/"))
      } else if (flag === "--dir") {
        dir = takeValue(flag, inline).split(path.sep).join("/")
      } else if (flag === "--root" || flag === "-r") {
        root = takeValue(flag, inline).split(path.sep).join("/")
      } else if (flag === "--passWithNoTests") {
        passWithNoTests = true
      } else if (flag === "--allowOnly") {
        allowOnly = true
      } else if (VITEST_UNSUPPORTED_SELECTORS.has(flag) || flag.startsWith("--project")) {
        throw new CheckFailure(
          `RT-2 cannot model unsupported Vitest selector in test:unit: ${flag} (script: ${script})`,
        )
      } else if (VITEST_HARMLESS_VALUE_OPTIONS.has(flag)) {
        takeValue(flag, inline)
      } else if (
        VITEST_HARMLESS_BOOLEAN_OPTIONS.has(flag) ||
        flag.startsWith("--coverage.") ||
        flag.startsWith("--poolOptions.") ||
        flag.startsWith("--browser.") ||
        flag.startsWith("--typecheck.") ||
        flag.startsWith("--sequence.") ||
        flag.startsWith("--expect.") ||
        flag.startsWith("--outputFile.") ||
        flag.startsWith("--no-")
      ) {
        // Boolean / namespaced runner options; optional inline values are ignored.
      } else if (inline !== undefined) {
        // Unknown flag=value form: fail closed — may affect collection.
        throw new CheckFailure(
          `RT-2 cannot model unsupported Vitest option in test:unit: ${flag} (script: ${script})`,
        )
      } else if (
        index + 1 < tokens.length &&
        !tokens[index + 1].startsWith("-") &&
        !tokens[index + 1].includes("/") &&
        !tokens[index + 1].includes("\\") &&
        !/\.(t|j|m|c)sx?$/.test(tokens[index + 1])
      ) {
        // Ambiguous next token for an unknown flag — fail closed rather than
        // mis-classify a selector value as a positional filter.
        throw new CheckFailure(
          `RT-2 cannot model unsupported Vitest option in test:unit: ${flag} (script: ${script})`,
        )
      } else {
        // Unknown boolean-looking flag with no safe value token: fail closed.
        throw new CheckFailure(
          `RT-2 cannot model unsupported Vitest option in test:unit: ${flag} (script: ${script})`,
        )
      }
      index += 1
      continue
    }
    filters.push(token.split(path.sep).join("/"))
    index += 1
  }

  const selectorParts = []
  if (filters.length > 0) selectorParts.push(`filters=${JSON.stringify(filters)}`)
  if (cliExcludes.length > 0) selectorParts.push(`exclude=${JSON.stringify(cliExcludes)}`)
  if (dir) selectorParts.push(`dir=${dir}`)
  if (root) selectorParts.push(`root=${root}`)
  if (passWithNoTests) selectorParts.push("passWithNoTests")
  if (allowOnly) selectorParts.push("allowOnly")

  return {
    script,
    filters,
    cliExcludes,
    dir,
    root,
    configPath,
    passWithNoTests,
    allowOnly,
    selector: selectorParts.length > 0 ? selectorParts.join(" ") : "(all included files)",
  }
}

const readPackageUnitScript = (cwd, revision) => {
  const content = readTextAt(cwd, "package.json", revision)
  if (!content) {
    throw new CheckFailure("RT-2 requires package.json with scripts.test:unit")
  }
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new CheckFailure(`RT-2 could not parse package.json: ${error.message}`)
  }
  const script = parsed?.scripts?.["test:unit"]
  if (typeof script !== "string" || script.trim() === "") {
    throw new CheckFailure("RT-2 requires package.json scripts.test:unit")
  }
  return script.trim()
}

const normalizeRepoPath = (file) => file.split(path.sep).join("/").replace(/^\.\//, "")

const resolveVitestEntry = () => {
  const candidates = [
    path.join(CHECKER_REPO_ROOT, "node_modules", "vitest", "vitest.mjs"),
    path.join(CHECKER_REPO_ROOT, "node_modules", "vitest", "vitest.js"),
    path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
    path.join(process.cwd(), "node_modules", "vitest", "vitest.js"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new CheckFailure(
    "RT-2 cannot locate the repository Vitest binary (node_modules/vitest/vitest.mjs)",
  )
}

const buildVitestListArgs = (command) => {
  const args = ["list"]
  if (command.configPath) {
    args.push("--config", command.configPath)
  }
  if (command.dir) {
    args.push("--dir", command.dir)
  }
  if (command.root) {
    args.push("--root", command.root)
  }
  for (const pattern of command.cliExcludes) {
    args.push("--exclude", pattern)
  }
  for (const filter of command.filters) {
    args.push(filter)
  }
  args.push("--filesOnly")
  return args
}

const parseVitestListOutput = (output, cwd) => {
  const files = []
  for (const rawLine of output.split("\n")) {
    let line = rawLine.trim()
    if (!line) continue
    // Workspace/project mode prefixes rows as `[name] path/to/file`.
    const projectPrefix = line.match(/^\[[^\]]+\]\s+(.+)$/)
    if (projectPrefix) line = projectPrefix[1].trim()
    if (!line || line.startsWith("✓") || line.startsWith("×") || line.startsWith("-")) continue
    // Ignore noisy non-path lines Vitest may still emit on stdout.
    if (/^(DEV|WAR|ERR|The CJS build)\b/i.test(line)) continue
    let file = line
    if (path.isAbsolute(file)) {
      file = path.relative(cwd, file)
      if (file.startsWith("..") || path.isAbsolute(file)) continue
    }
    file = normalizeRepoPath(file)
    if (!file || file.includes("\u0000")) continue
    files.push(file)
  }
  return [...new Set(files)].sort()
}

const runVitestList = (cwd, command) => {
  const vitestEntry = resolveVitestEntry()
  const args = buildVitestListArgs(command)
  const nodePathEntries = [
    path.join(CHECKER_REPO_ROOT, "node_modules"),
    path.join(path.resolve(cwd), "node_modules"),
  ]
  if (process.env.NODE_PATH) nodePathEntries.push(process.env.NODE_PATH)
  try {
    const output = execFileSync(process.execPath, [vitestEntry, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: VITEST_LIST_TIMEOUT_MS,
      env: {
        ...process.env,
        // Match the CI blocking run environment so env-gated configs resolve
        // the same way the unit job does.
        CI: "true",
        // Keep list output machine-readable.
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        // Allow fixtures / detached base worktrees without local installs to
        // resolve `vitest/config` from the checker repository.
        NODE_PATH: nodePathEntries.join(path.delimiter),
      },
    })
    return parseVitestListOutput(output, cwd)
  } catch (error) {
    if (error instanceof CheckFailure) throw error
    const timedOut = error?.killed || /ETIMEDOUT|timed out/i.test(String(error?.message ?? ""))
    const stderr = error?.stderr?.toString().trim() || ""
    const stdout = error?.stdout?.toString().trim() || ""
    const detail = stderr || stdout || error?.message || String(error)
    throw new CheckFailure(
      timedOut
        ? `RT-2 timed out obtaining Vitest collection via \`vitest list\` (limit ${VITEST_LIST_TIMEOUT_MS}ms)`
        : `RT-2 failed to obtain Vitest collection via \`vitest list\`: ${detail}`,
    )
  }
}

const withRevisionWorktree = (repoCwd, revision, fn) => {
  const absoluteRepo = path.resolve(repoCwd)
  const worktree = mkdtempSync(path.join(tmpdir(), "cascade-rt2-"))
  let added = false
  try {
    try {
      git(absoluteRepo, ["worktree", "add", "--detach", worktree, revision])
      added = true
    } catch (error) {
      const detail = error instanceof CheckFailure ? error.message : String(error)
      throw new CheckFailure(
        `RT-2 cannot check out merge base ${revision} to obtain Vitest collection: ${detail}`,
      )
    }

    // Detached base trees do not carry gitignored node_modules. Point Vitest at
    // an existing install so ESM config imports (`vitest/config`) resolve.
    const worktreeModules = path.join(worktree, "node_modules")
    if (!existsSync(worktreeModules)) {
      const moduleSources = [
        path.join(absoluteRepo, "node_modules"),
        path.join(CHECKER_REPO_ROOT, "node_modules"),
      ]
      for (const source of moduleSources) {
        if (!existsSync(source)) continue
        try {
          symlinkSync(source, worktreeModules, "dir")
          break
        } catch {
          // Try the next candidate; failure to link is handled when list runs.
        }
      }
    }

    return fn(worktree)
  } finally {
    if (added) {
      try {
        // Drop the temporary install link before worktree removal.
        rmSync(path.join(worktree, "node_modules"), { recursive: true, force: true })
      } catch {
        // ignore
      }
      try {
        git(absoluteRepo, ["worktree", "remove", "--force", worktree], { allowFailure: true })
      } catch {
        // Best-effort cleanup; rmSync below still runs.
      }
    }
    rmSync(worktree, { recursive: true, force: true })
  }
}

const scanExecutionAffectingKeys = (content, file) => {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, sourceKind(file))
  const found = []
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          continue
        }
        const key =
          property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? property.name.text
            : undefined
        if (!key || !VITEST_EXECUTION_AFFECTING_KEYS.has(key)) continue
        if (ts.isShorthandPropertyAssignment(property)) {
          found.push(`${key}=<shorthand>`)
          continue
        }
        const valueText = property.initializer.getText(source).replace(/\s+/g, " ").trim()
        found.push(`${key}=${valueText}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.sort()
}

const executionConfigFingerprint = (cwd, revision, preferredConfig) => {
  const files = new Set([
    ...VITEST_CONFIG_CANDIDATES,
    ...VITEST_WORKSPACE_CANDIDATES,
  ])
  if (preferredConfig) files.add(normalizeRepoPath(preferredConfig))

  const entries = []
  for (const file of [...files].sort()) {
    const content = readTextAt(cwd, file, revision)
    if (!content) continue
    const isWorkspace = VITEST_WORKSPACE_CANDIDATES.includes(file)
    if (isWorkspace) {
      const digest = createHash("sha256").update(content).digest("hex").slice(0, 16)
      entries.push(`${file}:workspace:${digest}`)
    }
    for (const key of scanExecutionAffectingKeys(content, file)) {
      entries.push(`${file}:${key}`)
    }
  }
  return entries
}

const executionCommandFingerprint = (command) =>
  JSON.stringify({
    passWithNoTests: Boolean(command.passWithNoTests),
    allowOnly: Boolean(command.allowOnly),
  })

const describeConfigSurface = (cwd, revision, command) => {
  const present = []
  if (command.configPath && readTextAt(cwd, command.configPath, revision)) {
    present.push(command.configPath)
  } else {
    for (const candidate of VITEST_CONFIG_CANDIDATES) {
      if (readTextAt(cwd, candidate, revision)) {
        present.push(candidate)
        break
      }
    }
  }
  for (const candidate of VITEST_WORKSPACE_CANDIDATES) {
    if (readTextAt(cwd, candidate, revision)) present.push(candidate)
  }
  return present.length > 0 ? present.join(",") : "(vitest defaults)"
}

export const collectBlockingTestFiles = (cwd, revision, unitScriptOverride) => {
  const unitScript =
    typeof unitScriptOverride === "string" && unitScriptOverride.trim() !== ""
      ? unitScriptOverride.trim()
      : readPackageUnitScript(cwd, revision)
  const command = parseVitestUnitCommand(unitScript)

  const collectFromTree = (treeCwd, treeRevision) => {
    const files = runVitestList(treeCwd, command)
    const configLabel = describeConfigSurface(treeCwd, treeRevision, command)
    const executionKeys = executionConfigFingerprint(treeCwd, treeRevision, command.configPath)
    return {
      files,
      command,
      config: {
        file: configLabel,
        executionKeys,
        executionCommand: executionCommandFingerprint(command),
      },
      unitScript,
    }
  }

  if (revision) {
    return withRevisionWorktree(cwd, revision, (worktree) => collectFromTree(worktree, undefined))
  }
  return collectFromTree(cwd, undefined)
}

const readApprovedRemovals = (cwd, base) => {
  // Spec §10.1: only policy already present at the merge-base may authorize a
  // reduction. Head-only additions in the same PR must not self-approve.
  const content = readTextAt(cwd, ".github/grading/config.yml", base)
  if (!content) return new Set()
  try {
    const config = parseYaml(content)
    const listed = config?.ratchets?.["RT-2"]?.approved_test_removals
    if (!Array.isArray(listed)) return new Set()
    return new Set(listed.map((entry) => normalizeRepoPath(String(entry))))
  } catch {
    return new Set()
  }
}

const describeSelector = (collection) =>
  `${collection.unitScript} [config=${collection.config.file} selector=${collection.command.selector} size=${collection.files.length}]`

const sameStringList = (left = [], right = []) => {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export const checkTestIntegrity = ({ base, cwd = process.cwd() }) => {
  requireValue(base, "RT-2 requires --base <sha>")
  git(cwd, ["cat-file", "-e", `${base}^{commit}`])

  const baseCollection = collectBlockingTestFiles(cwd, base)
  const headCollection = collectBlockingTestFiles(cwd, undefined)
  const headSet = new Set(headCollection.files)
  const baseSet = new Set(baseCollection.files)
  const approvedRemovals = readApprovedRemovals(cwd, base)
  const findings = []

  // Execution-affecting config/CLI keys do not always change `vitest list`
  // file sets (e.g. testNamePattern, passWithNoTests). Fail closed on any
  // add/change between merge base and head.
  if (
    !sameStringList(baseCollection.config.executionKeys, headCollection.config.executionKeys) ||
    baseCollection.config.executionCommand !== headCollection.config.executionCommand
  ) {
    findings.push(
      `blocking unit execution configuration changed (fail closed): base keys=${JSON.stringify(baseCollection.config.executionKeys)} cmd=${baseCollection.config.executionCommand}; head keys=${JSON.stringify(headCollection.config.executionKeys)} cmd=${headCollection.config.executionCommand}`,
    )
  }

  // Path-set difference alone treats renames/moves inside the blocking set as
  // drops. Net out base-only paths that still have a same-content successor in
  // the head blocking collection before requiring approved_test_removals.
  const baseOnly = baseCollection.files.filter((file) => !headSet.has(file))
  const headOnly = headCollection.files.filter((file) => !baseSet.has(file))
  const headContentBuckets = new Map()
  for (const file of headOnly) {
    const content = readTextAt(cwd, file, undefined)
    const bucket = headContentBuckets.get(content) ?? []
    bucket.push(file)
    headContentBuckets.set(content, bucket)
  }
  const renamedAway = new Set()
  for (const file of baseOnly) {
    const content = readTextAt(cwd, file, base)
    const bucket = headContentBuckets.get(content)
    if (!bucket || bucket.length === 0) continue
    bucket.shift()
    renamedAway.add(file)
  }

  const dropped = baseOnly.filter((file) => !renamedAway.has(file))
  const unapprovedDropped = dropped.filter((file) => !approvedRemovals.has(file))
  if (unapprovedDropped.length > 0) {
    const selectorChanged =
      baseCollection.unitScript !== headCollection.unitScript ||
      JSON.stringify(baseCollection.command.filters) !==
        JSON.stringify(headCollection.command.filters) ||
      JSON.stringify(baseCollection.command.cliExcludes) !==
        JSON.stringify(headCollection.command.cliExcludes) ||
      baseCollection.command.dir !== headCollection.command.dir ||
      baseCollection.command.root !== headCollection.command.root ||
      baseCollection.config.file !== headCollection.config.file ||
      !sameStringList(baseCollection.config.executionKeys, headCollection.config.executionKeys)
    if (selectorChanged) {
      findings.push(
        `blocking unit selector reduced effective test set: base=${describeSelector(baseCollection)} head=${describeSelector(headCollection)}`,
      )
    }
    findings.push(
      `blocking unit collection dropped ${unapprovedDropped.length} file(s): ${unapprovedDropped.join(", ")}`,
    )
  }

  const before = modeInventory(readSources(cwd, baseCollection.files, base))
  const after = modeInventory(readSources(cwd, headCollection.files))

  for (const mode of TEST_MODES) {
    const baseCount = before.counts.get(mode)
    const headCount = after.counts.get(mode)
    if (headCount > baseCount) {
      findings.push(
        `new Vitest ${mode} mode in blocking unit collection: baseline=${baseCount} head=${headCount}`,
      )
    }
  }

  for (const mode of ["skipIf", "runIf"]) {
    const baseSignatures = before.conditionalSignatures.get(mode)
    for (const [signature, count] of after.conditionalSignatures.get(mode)) {
      if (count > (baseSignatures.get(signature) ?? 0)) {
        findings.push(
          `new or changed conditional mode in blocking unit collection: ${signature}`,
        )
      }
    }
  }

  if (findings.length > 0) {
    throw new CheckFailure(`RT-2 test-integrity regression (${findings.length})`, findings)
  }

  return {
    modes: Object.fromEntries(after.counts),
    findings: [],
    blockingCollection: {
      label: "blocking unit collection (CI test:unit)",
      script: headCollection.unitScript,
      selector: headCollection.command.selector,
      config: headCollection.config.file,
      files: headCollection.files,
      size: headCollection.files.length,
      baseSize: baseCollection.files.length,
    },
  }
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
    console.log(
      `RT-2 pass: blocking unit collection size=${result.blockingCollection.size} modes=${JSON.stringify(result.modes)}`,
    )
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

