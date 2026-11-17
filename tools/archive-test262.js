"use strict";

// Archive Test262 gate results per release.
//
// The gate runner prints a JSON report to stdout; by default it truncates
// the failure list to 30 entries, which is fine for the gate itself but not
// for an archive. This script reruns the gate with the failure detail cap
// raised so the archived report carries the FULL failure list, stamps it
// with environment information, and writes it under archives/test262/.
//
//   node tools/archive-test262.js                # run the gate, then archive
//   node tools/archive-test262.js --report=x.json   # archive an existing report
//
// The gate's own exit code is preserved: archiving a failing run still
// exits non-zero (the release checklist must not pass on a red gate), but
// the failing report is archived first so the failure list is not lost.
//
// --report mode exists so the archiving pipeline can be exercised without
// rerunning the full gate (e.g., in CI or during development).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const archiveRoot = path.join(repositoryRoot, "archives", "test262");
const runnerPath = path.join(repositoryRoot, "test", "conformance", "test262.js");
// The gate default is 30; archives want every failing case, so raise the cap
// to a value no real run can reach.
const fullFailureDetailCap = "1000000";

function environmentInfo() {
  return {
    archivedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpus: os.cpus().length,
  };
}

function archiveFile(report, environment) {
  fs.mkdirSync(archiveRoot, { recursive: true });
  const revision = (report.revision || "unknown").slice(0, 12);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${revision}-${stamp}.json`;
  const filepath = path.join(archiveRoot, filename);
  fs.writeFileSync(filepath, `${JSON.stringify({ ...environment, ...report }, null, 2)}\n`);
  // A stable pointer for tooling and release notes: the latest archive.
  fs.writeFileSync(
    path.join(archiveRoot, "latest.json"),
    `${JSON.stringify(
      {
        file: filename,
        archivedAt: environment.archivedAt,
        revision: report.revision,
        failed: report.failed,
        passed: report.passed + (report.negativePassed || 0),
        files: report.files,
      },
      null,
      2
    )}\n`
  );
  return filepath;
}

function reportFromArgument() {
  const prefix = "--report=";
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (!value) return null;
  const filepath = path.resolve(process.cwd(), value.slice(prefix.length));
  return { filepath, report: JSON.parse(fs.readFileSync(filepath, "utf8")) };
}

function parseRunnerReport(output) {
  const text = String(output || "").trim();
  // Quiet mode emits progress lines before the final pretty-printed JSON.
  // A top-level object begins either at byte zero or immediately after a
  // newline; nested objects are indented and therefore cannot match.
  const objectStart = text.lastIndexOf("\n{");
  const json = objectStart === -1 ? text : text.slice(objectStart + 1);
  const report = JSON.parse(json);
  if (!report || typeof report !== "object" || typeof report.revision !== "string") {
    throw new TypeError("Test262 runner report is missing its revision");
  }
  return report;
}

function runGate() {
  const result = spawnSync(process.execPath, ["--expose-gc", runnerPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      sablejs_test262_failure_details: fullFailureDetailCap,
      sablejs_test_quiet: "1",
    },
    timeout: 30 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.stdout) {
    const parsed = parseRunnerReport(result.stdout);
    return { report: parsed, gateExitCode: result.status || 0, stderr: result.stderr };
  }
  throw new Error(`Test262 runner produced no report (exit=${result.status}): ${result.stderr}`);
}

function main() {
  const fromArgument = reportFromArgument();
  if (fromArgument) {
    const filepath = archiveFile(fromArgument.report, environmentInfo());
    console.log(
      `Archived existing report ${fromArgument.filepath} -> ${path.relative(
        repositoryRoot,
        filepath
      )}`
    );
  } else {
    const { report, gateExitCode, stderr } = runGate();
    const filepath = archiveFile(report, environmentInfo());
    console.log(
      `Archived Test262 gate (revision ${report.revision.slice(0, 12)}, ` +
        `passed=${report.passed + (report.negativePassed || 0)}, failed=${report.failed}, ` +
        `policyExcluded=${report.policyExcluded}) -> ${path.relative(repositoryRoot, filepath)}`
    );
    if (stderr && stderr.trim()) process.stderr.write(stderr);
    if (gateExitCode !== 0) process.exitCode = gateExitCode;
  }
}

if (require.main === module) main();

module.exports = { parseRunnerReport };
