import { beforeEach, expect, test, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: { workspaceFolders: [] },
  Uri: {
    file: (path: string) => ({ scheme: "file", authority: "", path }),
  },
}));

import * as vscode from "vscode";
import { serverPathForUri, serverPathsEqual, uriForServerPath } from "./server-path";

function mockUri(
  scheme: string,
  path: string,
  authority = "",
  fsPath = path,
): vscode.Uri {
  return {
    scheme,
    path,
    authority,
    fsPath,
    with(change: { path?: string; query?: string; fragment?: string }) {
      return mockUri(scheme, change.path ?? path, authority, fsPath);
    },
  } as vscode.Uri;
}

function setWorkspaceFolders(folders: vscode.WorkspaceFolder[]) {
  (vscode.workspace as unknown as { workspaceFolders: vscode.WorkspaceFolder[] }).workspaceFolders =
    folders;
}

beforeEach(() => setWorkspaceFolders([]));

test("uses URI paths for WASM on Windows instead of host-specific fsPath", () => {
  const uri = mockUri("file", "/c:/Users/alice/project/main.typ", "", "c:\\Users\\alice\\project\\main.typ");

  expect(serverPathForUri(uri, true)).toBe("/c:/Users/alice/project/main.typ");
  expect(serverPathForUri(uri, false)).toBe("c:\\Users\\alice\\project\\main.typ");
});

test("matches Windows file paths independent of separator and casing", () => {
  const uri = mockUri("file", "/c:/Users/Alice/main.typ", "", "C:\\Users\\Alice\\main.typ");

  expect(serverPathsEqual(uri, "/C:/users/alice/main.typ", true)).toBe(true);
  expect(serverPathsEqual(uri, "c:\\users\\alice\\main.typ", false)).toBe(true);
});

test("maps WASM paths back to the most specific matching virtual workspace URI", () => {
  const root = mockUri("vscode-vfs", "/repo", "github");
  const nested = mockUri("vscode-vfs", "/repo/packages", "github");
  setWorkspaceFolders([
    { uri: root } as vscode.WorkspaceFolder,
    { uri: nested } as vscode.WorkspaceFolder,
  ]);

  const source = mockUri("vscode-vfs", "/repo/packages/demo/main.typ", "github");
  const result = uriForServerPath("/repo/packages/demo/output.pdf", true, source);

  expect(result.scheme).toBe("vscode-vfs");
  expect(result.authority).toBe("github");
  expect(result.path).toBe("/repo/packages/demo/output.pdf");
});

test("maps rooted Windows WASM paths without converting them to backslashes", () => {
  const folder = mockUri("file", "/c:/work", "", "c:\\work");
  setWorkspaceFolders([{ uri: folder } as vscode.WorkspaceFolder]);

  const result = uriForServerPath("/C:/work/build/output.pdf", true);

  expect(result.scheme).toBe("file");
  expect(result.path).toBe("/C:/work/build/output.pdf");
});

test("uses Uri.file for native server paths", () => {
  const result = uriForServerPath("C:\\work\\main.typ", false);

  expect(result.scheme).toBe("file");
  expect(result.path).toBe("C:\\work\\main.typ");
});
