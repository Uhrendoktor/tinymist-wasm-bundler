import * as vscode from "vscode";

/**
 * Converts a VS Code resource URI into the path format expected by Tinymist.
 *
 * The WASM server runs with POSIX path semantics even when the VS Code host is
 * Windows. Uri.fsPath applies host-specific separators (and is therefore not
 * suitable for WASM requests); Uri.path remains slash-separated.
 */
export function serverPathForUri(uri: vscode.Uri, isWeb: boolean): string {
  return isWeb ? uri.path : uri.fsPath;
}

/**
 * Compares paths returned by Tinymist with VS Code resource URIs.
 *
 * Windows file paths are case-insensitive and may be represented with either
 * slash style by different layers. Virtual workspace paths remain
 * case-sensitive and POSIX-style.
 */
export function serverPathsEqual(
  uri: vscode.Uri,
  serverPath: string,
  isWeb: boolean,
): boolean {
  const resourcePath = normalizePath(serverPathForUri(uri, isWeb));
  const requestedPath = normalizePath(serverPath);
  if (isWindowsFileUri(uri)) {
    return resourcePath.toLowerCase() === requestedPath.toLowerCase();
  }
  return resourcePath === requestedPath;
}

/**
 * Reconstructs a VS Code URI for a path returned by the WASM server.
 *
 * Keep the workspace filesystem provider's scheme and authority. In
 * particular, converting a vscode-vfs URI to file: would bypass the provider.
 */
export function uriForServerPath(
  serverPath: string,
  isWeb: boolean,
  sourceUri?: vscode.Uri,
): vscode.Uri {
  if (!isWeb) {
    return vscode.Uri.file(serverPath);
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  const matchingFolders = folders.filter(({ uri }) =>
    isWithinFolder(serverPath, uri.path, isWindowsFileUri(uri)),
  );
  const sourceProviderFolders = sourceUri
    ? matchingFolders.filter(
        ({ uri }) => uri.scheme === sourceUri.scheme && uri.authority === sourceUri.authority,
      )
    : [];
  const candidates = sourceProviderFolders.length > 0 ? sourceProviderFolders : matchingFolders;
  const folder = candidates.sort((left, right) => right.uri.path.length - left.uri.path.length)[0];

  if (folder) {
    return folder.uri.with({ path: serverPath, query: "", fragment: "" });
  }
  if (sourceUri) {
    return sourceUri.with({ path: serverPath, query: "", fragment: "" });
  }

  throw new Error(`No workspace filesystem provider owns server path: ${serverPath}`);
}

function isWindowsFileUri(uri: vscode.Uri): boolean {
  const hasDriveLetter =
    uri.path.length >= 4 &&
    uri.path[0] === "/" &&
    /^[a-z]$/i.test(uri.path[1]) &&
    uri.path[2] === ":" &&
    uri.path[3] === "/";
  return uri.scheme === "file" && (hasDriveLetter || uri.fsPath.includes("\\"));
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function isWithinFolder(candidate: string, folderPath: string, caseInsensitive: boolean): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(folderPath);
  const comparableCandidate = caseInsensitive
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  return (
    comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(comparableRoot === "/" ? "/" : `${comparableRoot}/`)
  );
}
