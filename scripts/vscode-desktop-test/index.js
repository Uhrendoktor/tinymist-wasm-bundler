const assert = require("node:assert/strict");
const vscode = require("vscode");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, read, timeoutMs = 120_000) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    try {
      lastValue = await read();
      if (lastValue !== undefined && lastValue !== false && lastValue !== null) {
        return lastValue;
      }
    } catch (error) {
      lastValue = String(error);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

async function inspectPreviewState() {
  return vscode.commands.executeCommand("tinymist.doInspectPreviewState");
}

async function verifyNetworkIsBlocked() {
  assert.equal(typeof fetch, "function", "The desktop extension host does not expose fetch for the offline check.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await fetch("https://example.com/", { signal: controller.signal });
    throw new Error(`The VS Code extension host reached the public network (HTTP ${response.status}).`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The VS Code extension host reached")) {
      throw error;
    }
    console.log("Verified: outbound HTTPS from the VS Code extension host failed as expected:", String(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  assert.equal(
    vscode.env.uiKind,
    vscode.UIKind.Desktop,
    "This test must run in plain VS Code Desktop, not VS Code for the Web.",
  );

  const extensionVersion = process.env.TINYMIST_EXTENSION_VERSION;
  assert(extensionVersion, "The runner did not identify the installed Tinymist VSIX version.");
  console.log(`Testing installed browser-only Tinymist VSIX ${extensionVersion} in VS Code Desktop ${vscode.version}.`);

  await verifyNetworkIsBlocked();

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert(workspace, "VS Code did not open the offline test workspace.");

  // Browser-only extensions run in VS Code's LocalWebWorker extension host on
  // Desktop. They are intentionally not returned by getExtension() in this
  // Node extension-test host. Opening a Typst document triggers the installed
  // extension's onLanguage:typst activation event in the WebWorker host.
  const source = [
    "#set page(width: 360pt, height: 240pt, margin: 20pt)",
    "#set text(fill: black, size: 12pt)",
    "#rect(width: 110pt, height: 38pt, fill: red)",
    "= WINDOWS_OFFLINE_TINYMIST_TEST",
    "First-page black text must appear next to the red rectangle.",
    "#pagebreak()",
    "= WINDOWS_OFFLINE_TINYMIST_PAGEBREAK_SECOND_PAGE",
    "Second-page content verifies that pagebreak creates a second page.",
    "#rect(width: 80pt, height: 25pt, fill: blue)",
    "",
  ].join("\n");
  const sourceUri = vscode.Uri.joinPath(workspace, "offline-smoke.typ");
  await vscode.workspace.fs.writeFile(sourceUri, new TextEncoder().encode(source));
  let document = await vscode.workspace.openTextDocument(sourceUri);
  if (document.languageId !== "typst") {
    document = await vscode.languages.setTextDocumentLanguage(document, "typst");
  }
  assert.equal(document.languageId, "typst", "VS Code did not recognize the Typst test document.");
  await vscode.window.showTextDocument(document);

  const requiredCommands = await waitFor("Tinymist WebWorker activation and diagnostic commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    const required = [
      "tinymist.doInspectPreviewState",
      "tinymist.doInspectPreviewHtml",
      "typst-preview.preview",
      "tinymist.export",
    ];
    return required.every((command) => commands.includes(command)) ? commands : undefined;
  });
  console.log("Tinymist WebWorker commands registered in Desktop:", requiredCommands.filter((command) =>
    ["tinymist.doInspectPreviewState", "tinymist.doInspectPreviewHtml", "typst-preview.preview", "tinymist.export"].includes(command),
  ));

  const previewHtml = await vscode.commands.executeCommand("tinymist.doInspectPreviewHtml");
  assert(previewHtml?.isString, "The active WASM server did not return its embedded preview HTML.");
  for (const key of ["statePlaceholder", "documentReady", "frontendReady", "browserTransport", "assetsInline"]) {
    assert(previewHtml[key], `The packaged preview HTML is missing ${key}: ${JSON.stringify(previewHtml)}`);
  }

  const launch = await vscode.commands.executeCommand("typst-preview.preview");
  assert(launch?.message === "ok" && launch.taskId, `Could not launch the installed preview: ${JSON.stringify(launch)}`);
  const taskId = launch.taskId;

  const rendered = await waitFor("preview frame with non-white content", async () => {
    const state = await inspectPreviewState();
    const task = state?.tasks?.find((candidate) => candidate.taskId === taskId);
    if (!task || !task.panel || !task.documentReady || !task.frontendStarted ||
        !task.browserTransportEnabled || !task.webviewSocketReady ||
        task.renderedFrames <= 0 || !task.renderMetrics) {
      return undefined;
    }
    return task;
  });

  const metrics = rendered.renderMetrics;
  console.log("Desktop preview metrics:", JSON.stringify(metrics));
  assert.equal(metrics.pageCount, 2,
    `Preview did not honor #pagebreak() as a second page: ${JSON.stringify(metrics)}`);
  assert(metrics.svgCount > 0 && metrics.visibleSvgCount > 0, `Preview did not create a visible SVG: ${JSON.stringify(metrics)}`);
  assert(metrics.nonWhitePaintElementCount > 0, `Preview contains no non-white painted geometry: ${JSON.stringify(metrics)}`);
  assert(metrics.paintedGlyphElementCount > 0 && metrics.darkTextGlyphElementCount > 0,
    `Preview contains no painted dark text glyphs: ${JSON.stringify(metrics)}`);
  assert(!metrics.renderError, `Preview renderer reported an error: ${metrics.renderError}`);

  const compileErrors = vscode.languages.getDiagnostics(sourceUri)
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);
  assert.equal(compileErrors.length, 0, `The test document did not compile: ${JSON.stringify(compileErrors.map((item) => item.message))}`);

  await vscode.workspace.getConfiguration("tinymist").update(
    "outputPath",
    "$root/$dir/$name",
    vscode.ConfigurationTarget.Workspace,
  );
  await vscode.window.showTextDocument(document);
  const pdfExport = await vscode.commands.executeCommand("tinymist.export", "Pdf");
  assert(pdfExport && typeof pdfExport.path === "string" && pdfExport.path,
    `PDF export returned no output path: ${JSON.stringify(pdfExport)}`);

  const pdfUri = vscode.Uri.file(pdfExport.path);
  const pdfBytes = await vscode.workspace.fs.readFile(pdfUri);
  assert.equal(new TextDecoder().decode(pdfBytes.subarray(0, 5)), "%PDF-",
    `PDF export did not write a valid PDF to ${pdfUri.toString()}`);

  const pdfCopy = vscode.Uri.joinPath(workspace, "tinymist-offline-output.pdf");
  await vscode.workspace.fs.writeFile(pdfCopy, pdfBytes);
  const report = {
    vscodeVersion: vscode.version,
    uiKind: vscode.env.uiKind,
    extensionVersion,
    taskId,
    preview: metrics,
    pdfBytes: pdfBytes.length,
    pdfUri: pdfUri.toString(),
  };
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(workspace, "tinymist-offline-test-report.json"),
    new TextEncoder().encode(JSON.stringify(report, null, 2)),
  );
  console.log("Desktop VSIX preview and PDF export passed initial checks:", JSON.stringify(report));
}

exports.run = run;
