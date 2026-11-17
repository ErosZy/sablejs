"use strict";

const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "..");
const bundlePath = path.join(repositoryRoot, "dist", "compiler.js");
const noticesPath = path.join(repositoryRoot, "THIRD_PARTY_NOTICES");
const npmIgnorePath = path.join(repositoryRoot, ".npmignore");
const packageManifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
);

if (!fs.existsSync(bundlePath)) {
  throw new Error("dist/compiler.js is missing; run npm run build first");
}
if (!fs.existsSync(noticesPath)) {
  throw new Error("THIRD_PARTY_NOTICES is missing");
}

const npmIgnore = fs.readFileSync(npmIgnorePath, "utf8").split(/\r?\n/);
for (const pattern of ["archives/", "test/", "test-results/", "tools/"]) {
  if (!npmIgnore.includes(pattern)) {
    throw new Error(`.npmignore must exclude release/development path ${pattern}`);
  }
}
for (const required of ["src/", "dist/", "LICENSE", "SECURITY.md", "THIRD_PARTY_NOTICES"]) {
  if (!Array.isArray(packageManifest.files) || !packageManifest.files.includes(required)) {
    throw new Error(`package.json files allowlist is missing ${required}`);
  }
}

const bundle = fs.readFileSync(bundlePath, "utf8");
const notices = fs.readFileSync(noticesPath, "utf8");
const normalizedNotices = notices.replace(/\s+/g, " ").trim();
const bundledPackages = new Set();
for (const match of bundle.matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)) {
  bundledPackages.add(match[1]);
}

const missing = [];
for (const name of [...bundledPackages].sort()) {
  const packagePath = path.join(repositoryRoot, "node_modules", name);
  const manifestPath = path.join(packagePath, "package.json");
  if (!fs.existsSync(manifestPath)) {
    missing.push(`${name} (manifest missing)`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const marker = `${manifest.name}@${manifest.version}`;
  if (!notices.includes(marker)) missing.push(marker);
  const licenseName = fs
    .readdirSync(packagePath)
    .find((entry) => /^(?:licen[cs]e|copying)(?:\..*)?$/i.test(entry));
  if (!licenseName) {
    missing.push(`${marker} (license file missing)`);
    continue;
  }
  const license = fs
    .readFileSync(path.join(packagePath, licenseName), "utf8")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedNotices.includes(license)) {
    missing.push(`${marker} (license text missing)`);
  }
}

if (missing.length) {
  throw new Error(`THIRD_PARTY_NOTICES is missing bundled packages: ${missing.join(", ")}`);
}
console.log(
  `Compliance OK: ${bundledPackages.size} bundled third-party packages are covered by THIRD_PARTY_NOTICES`
);
