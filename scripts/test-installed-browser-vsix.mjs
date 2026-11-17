#!/usr/bin/env node

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "editors", "vscode", "package.json"));
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} = require("@vscode/test-electron");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function runPowerShell(script) {
  run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}

const vsixPath = path.resolve(process.argv[2] || "");
const vscodeVersion = process.env.TINYMIST_DESKTOP_TEST_VSCODE_VERSION || "1.114.0";
if (!process.argv[2] || !fs.statSync(vsixPath, { throwIfNoEntry: false })?.isFile()) {
  fail("Usage: node scripts/test-installed-browser-vsix.mjs <compiled-vsix-path>");
}

const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
const testRoot = path.join(runnerTemp, "tinymist-offline-vscode");
const userDataDir = path.join(testRoot, "user-data");
const extensionsDir = path.join(testRoot, "extensions");
const workspaceDir = path.join(testRoot, "workspace");
const harnessDir = path.join(root, "scripts", "vscode-desktop-test");
const testReportPath = path.join(workspaceDir, "tinymist-offline-test-report.json");
const pdfPath = path.join(workspaceDir, "tinymist-offline-output.pdf");
const firewallRule = `Tinymist VS Code offline test ${process.pid}`;

fs.rmSync(testRoot, { recursive: true, force: true });
for (const dir of [userDataDir, extensionsDir, workspaceDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

let firewallInstalled = false;
let vscodeExecutablePath;
let testExitCode = 1;

try {
  console.log(`Preparing clean VS Code Desktop ${vscodeVersion}`);
  vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
  if (!fs.existsSync(vscodeExecutablePath)) {
    fail(`VS Code executable was not downloaded: ${vscodeExecutablePath}`);
  }
  console.log(`VS Code executable: ${vscodeExecutablePath}`);

  const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(
    vscodeExecutablePath,
    { reuseMachineInstall: true },
  );

  // Block public and intranet egress for every VS Code process before the
  // VSIX is loaded. The GitHub Actions runner is a different executable and
  // retains its connection for artifact reporting; loopback remains usable.
  const escapedCodePath = vscodeExecutablePath.replace(/'/g, "''");
  const escapedRule = firewallRule.replace(/'/g, "''");
  runPowerShell(`
    $ErrorActionPreference = 'Stop'
    New-NetFirewallRule -DisplayName '${escapedRule}' -Direction Outbound -Action Block -Program '${escapedCodePath}' -RemoteAddress Internet,Intranet -Profile Any | Out-Null
    $rule = Get-NetFirewallRule -DisplayName '${escapedRule}' -ErrorAction Stop
    if ($rule.Direction -ne 'Outbound' -or $rule.Action -ne 'Block') { throw 'The VS Code outbound firewall rule was not installed' }
    Write-Output 'VS Code outbound Internet/Intranet access blocked; loopback preview traffic remains available.'
  `);
  firewallInstalled = true;

  console.log(`Installing compiled VSIX locally with egress blocked: ${vsixPath}`);
  run(cliPath, [
    ...cliArgs,
    "--user-data-dir",
    userDataDir,
    "--extensions-dir",
    extensionsDir,
    "--install-extension",
    vsixPath,
    "--force",
  ], { shell: process.platform === "win32" });

  const listed = spawnSync(cliPath, [
    ...cliArgs,
    "--user-data-dir",
    userDataDir,
    "--extensions-dir",
    extensionsDir,
    "--list-extensions",
    "--show-versions",
  ], { encoding: "utf8", shell: process.platform === "win32" });
  if (listed.error) throw listed.error;
  if (listed.status !== 0 || !listed.stdout.includes("myriad-dreamin.tinymist@")) {
    fail(`VSIX installation was not visible in the clean profile:\n${listed.stdout}\n${listed.stderr}`);
  }
  console.log(listed.stdout.trim());

  console.log("Launching desktop Extension Host with the installed VSIX (not extension-development mode).");
  testExitCode = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: harnessDir,
    extensionTestsPath: path.join(harnessDir, "index.js"),
    launchArgs: [
      workspaceDir,
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir,
      "--disable-updates",
      "--disable-workspace-trust",
      "--disable-gpu",
      "--verbose",
    ],
    extensionTestsEnv: {
      TINYMIST_OFFLINE_REPORT: testReportPath,
      TINYMIST_OFFLINE_PDF: pdfPath,
    },
  });
  if (testExitCode !== 0) {
    fail(`VS Code Desktop Extension Host tests failed with exit code ${testExitCode}`);
  }

  if (!fs.existsSync(testReportPath)) {
    fail("The VS Code desktop test host did not write its result report.");
  }
  console.log(fs.readFileSync(testReportPath, "utf8"));

  if (!fs.existsSync(pdfPath)) {
    fail("The VS Code desktop test did not persist the exported PDF for pixel verification.");
  }

  console.log("Rasterizing the PDF locally and checking for both red geometry and dark text.");
  run(process.env.PYTHON || "python", [
    path.join(root, "scripts", "verify-offline-pdf.py"),
    pdfPath,
  ]);

  console.log("Offline Windows VS Code Desktop test passed.");
} finally {
  if (firewallInstalled) {
    try {
      const escapedRule = firewallRule.replace(/'/g, "''");
      runPowerShell(`Get-NetFirewallRule -DisplayName '${escapedRule}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`);
    } catch (error) {
      console.error("Could not remove the temporary VS Code firewall rule:", error);
      process.exitCode = 1;
    }
  }
  if (testExitCode !== 0) {
    console.error(`Failure workspace and VS Code profile retained at: ${testRoot}`);
  }
}
