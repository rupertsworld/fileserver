// Reading the served tree at a git ref (spec/server.md#git-refs).
//
// Git is run directly, never through a shell, with an explicit `--git-dir`,
// so it never searches for a repository itself and never looks above the
// served root. The ref is the only argument a request supplies to git apart
// from the path, and it follows `--end-of-options`; paths follow `--`. Every
// command whose output is read in full is stopped after `gitTimeoutMs`.
//
// The repository is found on disk by walking the requested path from the
// root without following symbolic links. Its git directory, and a linked
// worktree's common directory, must resolve beneath the root.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";

/** How long a git command whose whole output the server waits for may run. */
export const gitTimeoutMs = 10_000;

/** A repository found for a request: its git directory and how many path segments lead to its working tree. */
export type GitRepository = { gitDir: string; depth: number };

/** A commit a ref resolved to, with what the server needs from it. */
export type GitCommit = { id: string; tree: string; committed: string };

/** What a path is in a commit's tree. */
export type GitResource =
  | { type: "missing" }
  | { type: "dir"; id: string }
  | { type: "file"; id: string; size: number }
  | { type: "symlink" }
  | { type: "submodule" };

/** One entry of a tree as git lists it; the name is raw bytes, which need not be UTF-8. */
export type GitTreeEntry = { name: Buffer; resource: Exclude<GitResource, { type: "missing" }> };

/**
 * A git failure, which the server reports as 500. The message is safe to
 * send to a client; `detail` holds what git said, for the server's log.
 */
export class GitError extends Error {
  readonly detail: string | undefined;
  constructor(message: string, detail?: string) { super(message); this.detail = detail; }
}

/**
 * Finds the nearest repository enclosing a path: the deepest of the root and
 * the directories along the path, as they exist on disk, that contain `.git`.
 * The walk stops at the first component that is missing, is not a
 * directory, or is a symbolic link. Returns undefined when there is no such
 * repository, or when its git directory or common directory is outside the root.
 */
export async function findRepository(root: string, segments: readonly string[]): Promise<GitRepository | undefined> {
  let found: { top: string; depth: number; marker: "dir" | "file" } | undefined;
  for (let depth = 0; depth <= segments.length; depth += 1) {
    const directory = join(root, ...segments.slice(0, depth));
    if (depth > 0) {
      const stats = await lstatIfPresent(directory);
      if (stats === undefined || !stats.isDirectory()) break;
    }
    const marker = await lstatIfPresent(join(directory, ".git"));
    if (marker?.isDirectory()) found = { top: directory, depth, marker: "dir" };
    else if (marker?.isFile()) found = { top: directory, depth, marker: "file" };
  }
  if (found === undefined) return undefined;

  let gitDir: string | undefined;
  if (found.marker === "dir") gitDir = join(found.top, ".git");
  else {
    const firstLine = (await readFile(join(found.top, ".git"), "utf8")).split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith("gitdir: ")) return undefined;
    gitDir = resolve(found.top, firstLine.slice("gitdir: ".length));
  }
  const canonicalGitDir = await canonicalInside(root, gitDir);
  if (canonicalGitDir === undefined) return undefined;
  let commonDir: string | undefined;
  try { commonDir = (await readFile(join(canonicalGitDir, "commondir"), "utf8")).replace(/\r?\n$/, ""); }
  catch (error) { if (!isMissing(error)) throw error; }
  if (commonDir !== undefined && await canonicalInside(root, resolve(canonicalGitDir, commonDir)) === undefined) return undefined;
  return { gitDir: canonicalGitDir, depth: found.depth };
}

/** Resolves a ref to a commit with `rev-parse`, or returns undefined when git cannot resolve it to one. */
export async function resolveCommit(gitDir: string, ref: string): Promise<GitCommit | undefined> {
  const parsed = await runGit(gitDir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], [0, 1]);
  const id = parsed.stdout.toString("utf8").trim();
  // A revision such as `^main` verifies but prints more than an object ID.
  if (parsed.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) return undefined;
  const commit = (await runGit(gitDir, ["cat-file", "commit", id])).stdout.toString("utf8");
  const header = commit.slice(0, commit.indexOf("\n\n") === -1 ? commit.length : commit.indexOf("\n\n"));
  const tree = /^tree ([0-9a-f]+)$/m.exec(header)?.[1];
  const seconds = /^committer .* (-?\d+) [+-]\d{4}$/m.exec(header)?.[1];
  if (tree === undefined || seconds === undefined) throw new GitError("git returned an unreadable commit");
  return { id, tree, committed: new Date(Number(seconds) * 1_000).toISOString() };
}

/** Raised when a path at a ref passes through a symbolic link. */
export class PathThroughLink extends Error {}

/**
 * Resolves a path, given as segments relative to the repository's working
 * tree, in a commit's tree. A path through a symbolic link rejects with
 * `PathThroughLink`.
 */
export async function resolvePath(gitDir: string, commit: GitCommit, segments: readonly string[]): Promise<GitResource> {
  if (segments.length === 0) return { type: "dir", id: commit.tree };
  const entry = await lookUp(gitDir, commit.id, segments.join("/"));
  if (entry !== undefined) return entry;
  // Git cannot descend through a link, a file, or a submodule, so a missing
  // path may lie beneath one; only a link changes the answer.
  for (let length = 1; length < segments.length; length += 1) {
    const parent = await lookUp(gitDir, commit.id, segments.slice(0, length).join("/"));
    if (parent === undefined) break;
    if (parent.type === "symlink") throw new PathThroughLink();
    if (parent.type !== "dir") break;
  }
  return { type: "missing" };
}

/** Lists one tree, one level deep, in git's order. */
export async function listTree(gitDir: string, tree: string): Promise<GitTreeEntry[]> {
  return parseTreeListing((await runGit(gitDir, ["ls-tree", "-z", "-l", "--full-tree", tree])).stdout);
}

/** Reads one blob whole. */
export async function readBlob(gitDir: string, id: string): Promise<Buffer> {
  return (await runGit(gitDir, ["cat-file", "blob", id])).stdout;
}

/** Reads several blobs whole with one `cat-file --batch`, keyed by object ID. */
export async function readBlobs(gitDir: string, ids: readonly string[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  if (ids.length === 0) return blobs;
  const unique = [...new Set(ids)];
  const output = (await runGit(gitDir, ["cat-file", "--batch"], [0], `${unique.join("\n")}\n`)).stdout;
  let offset = 0;
  for (const id of unique) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new GitError("git returned a truncated batch");
    const [objectId, type, size] = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    if (objectId !== id || type !== "blob" || size === undefined) throw new GitError("git returned an unexpected object");
    const start = headerEnd + 1;
    const end = start + Number(size);
    if (end > output.length) throw new GitError("git returned a truncated batch");
    blobs.set(id, output.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

/** Starts streaming one blob; the caller reads `stdout` and kills the process when it no longer needs it. */
export function streamBlob(gitDir: string, id: string): {
  child: ChildProcessByStdio<null, Readable, null>;
  exited: Promise<number | null>;
} {
  const child = spawn("git", [`--git-dir=${gitDir}`, "cat-file", "blob", id], {
    cwd: gitDir,
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("error", () => resolveExit(null));
    child.once("close", (code) => resolveExit(code));
  });
  return { child, exited };
}

async function lookUp(gitDir: string, commit: string, path: string): Promise<Exclude<GitResource, { type: "missing" }> | undefined> {
  const output = (await runGit(gitDir, ["ls-tree", "-z", "-l", "--full-tree", commit, "--", path])).stdout;
  const wanted = Buffer.from(path);
  return parseTreeListing(output).find(({ name }) => name.equals(wanted))?.resource;
}

/** Parses `ls-tree -z -l` output: `<mode> <type> <id> <size>\t<name>\0` per entry. */
function parseTreeListing(output: Buffer): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    const record = output.subarray(offset, end === -1 ? output.length : end);
    offset = end === -1 ? output.length : end + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) throw new GitError("git returned an unreadable tree");
    const [mode, type, id, size] = record.subarray(0, tab).toString("utf8").trim().split(/ +/);
    const name = Buffer.from(record.subarray(tab + 1));
    if (mode === undefined || id === undefined) throw new GitError("git returned an unreadable tree");
    if (type === "tree") entries.push({ name, resource: { type: "dir", id } });
    else if (type === "commit") entries.push({ name, resource: { type: "submodule" } });
    else if (type === "blob" && mode === "120000") entries.push({ name, resource: { type: "symlink" } });
    else if (type === "blob" && mode.startsWith("100")) entries.push({ name, resource: { type: "file", id, size: Number(size) } });
  }
  return entries;
}

/**
 * Runs git to completion and returns its exit code and output. An exit code
 * not in `expectedCodes`, a failure to start, or running past the time limit
 * rejects with a `GitError`.
 */
async function runGit(
  gitDir: string,
  args: readonly string[],
  expectedCodes: readonly number[] = [0],
  input?: string,
): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("git", [`--git-dir=${gitDir}`, ...args], {
      cwd: gitDir,
      env: gitEnvironment(),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, gitTimeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new GitError("git could not be run", error.message));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new GitError("git took too long")); return; }
      if (code === null || !expectedCodes.includes(code)) {
        reject(new GitError("git failed", Buffer.concat(stderr).toString("utf8").trim()));
        return;
      }
      resolveRun({ code, stdout: Buffer.concat(stdout) });
    });
    if (input !== undefined) {
      const stdin = child.stdin as Writable;
      stdin.once("error", () => { /* A git that exits early closes its input; the exit code reports why. */ });
      stdin.end(input);
    }
  });
}

/**
 * The environment git runs with: the server's own, without any inherited
 * `GIT_*` variable that could redirect git elsewhere, with pathspecs read
 * literally, and with nothing that could fetch, prompt, take a lock, or
 * substitute replacement objects for the ones a commit names.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return {
    ...environment,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function canonicalInside(root: string, path: string): Promise<string | undefined> {
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const fromRoot = relative(root, canonical);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
  return canonical;
}

async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
