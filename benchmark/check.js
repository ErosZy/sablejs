"use strict";

const fs = require("fs");
const path = require("path");
const { loadManifest, repositoryRoot, sha256 } = require("./evidence");
const { scanProduction } = require("../tools/check-benchmark-leakage");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function validateManifest(releaseReady = false) {
  const loaded = loadManifest();
  const manifest = loaded.value;
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push("unsupported corpus manifest schema");
  const entries = [...manifest.tuning, ...manifest.heldout];
  const ids = new Set();
  entries.forEach((entry) => {
    if (!entry.id || ids.has(entry.id)) errors.push(`duplicate or missing corpus id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.license) errors.push(`${entry.id}: missing license`);
    if (!entry.path) return errors.push(`${entry.id}: missing path`);
    const filename = path.resolve(repositoryRoot, entry.path);
    if (!fs.existsSync(filename)) return errors.push(`${entry.id}: missing ${entry.path}`);
    const actual = sha256(fs.readFileSync(filename));
    if (actual !== entry.sha256) errors.push(`${entry.id}: sha256 mismatch`);
  });
  const minimum = manifest.policy.minimumHeldoutPrograms;
  if (releaseReady && manifest.heldout.length < minimum) {
    errors.push(
      `heldout corpus has ${manifest.heldout.length} programs; O2 release requires ${minimum}`
    );
  }
  return {
    errors,
    loaded,
    counts: {
      tuning: manifest.tuning.length,
      heldout: manifest.heldout.length,
      adversarial: manifest.adversarial.length,
    },
  };
}

function validateArtifact(filename) {
  const artifact = JSON.parse(fs.readFileSync(path.resolve(filename), "utf8"));
  const errors = [];
  for (const field of ["environment", "configuration", "corpus"]) {
    if (!artifact[field]) errors.push(`artifact missing ${field}`);
  }
  if (!artifact.backends && !artifact.cases) errors.push("artifact missing backends/cases");
  if (artifact.errors && artifact.errors.length) errors.push("artifact contains benchmark errors");
  return errors;
}

function main() {
  const o2Release = process.argv.includes("--o2-release");
  const artifact = argument("artifact", "");
  const manifest = validateManifest(o2Release);
  const findings = scanProduction();
  const errors = manifest.errors.concat(
    findings.map((finding) => `${finding.filename}:${finding.line}: ${finding.kind}`)
  );
  if (artifact) errors.push(...validateArtifact(artifact));
  const result = {
    ok: errors.length === 0,
    o2Release,
    manifest: { path: manifest.loaded.path, sha256: manifest.loaded.sha256, ...manifest.counts },
    artifact: artifact || null,
    errors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exitCode = 1;
}

module.exports = { validateArtifact, validateManifest };

if (require.main === module) main();
