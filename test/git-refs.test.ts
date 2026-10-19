// Reading at a git ref (spec/server.md#git-refs), against real temporary
// repositories: a repository with a linked worktree and a nested repository
// inside the served root, plus repositories arranged around the root to show
// which ones the server may use.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import { FileServer, type FileServerOptions } from "../src/server.ts";
import { expectNoEvent, openSocket } from "../src/conformance/helpers.ts";
import { makeRoot, rawRequest } from "./helpers.ts";

const run = promisify(execFile);
const committedAt = "2026-01-02T03:04:05.000Z";
const immutable = "max-age=31536000, immutable";

/** Runs git in a directory with a fixed identity and commit date. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "-c", "init.defaultBranch=main",
    "-c", "commit.gpgsign=false",
    ...args,
  ], { cwd, env: { ...process.env, GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt } });
  return stdout.trim();
}

async function writeFiles(directory: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), contents);
  }
}

type Fixture = {
  root: string;
  project: string;
  v1: string;
  main: string;
  feature: string;
};

/**
 * Builds the shared fixture inside a new root:
 *
 * - `project/`, a repository whose tag `v1` and branch `main` differ, with an
 *   uncommitted change on disk, a symbolic link, a submodule entry, hidden and
 *   ignorable files, and a directory deleted at `main`;
 * - `project-feature/`, a linked worktree of `project` on branch `feature`;
 * - `project/inner/`, a separate repository nested in the working tree;
 * - `loose.txt`, outside any repository.
 */
async function makeFixture(): Promise<Fixture> {
  const root = await makeRoot({ "loose.txt": "loose" });
  const project = join(root, "project");
  await mkdir(project);
  await git(project, "init", "-q");
  await writeFiles(project, {
    "readme.txt": "version one\n",
    "notes.md": "---\nstatus: old\n---\nOld body\n",
    "docs/index.html": "<h1>v1</h1>",
    "docs/guide.txt": "guide",
    ".hidden.txt": "hidden",
    "build/out.txt": "built",
    "gone/file.txt": "gone",
  });
  await symlink("docs", join(project, "link"));
  await git(project, "add", "-A");
  await git(project, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor`);
  await git(project, "commit", "-q", "-m", "one");
  await git(project, "tag", "v1");
  const v1 = await git(project, "rev-parse", "HEAD");

  await writeFiles(project, { "readme.txt": "version two\n", "notes.md": "---\nstatus: new\n---\nNew body\n" });
  await git(project, "rm", "-q", "-r", "gone");
  await git(project, "add", "readme.txt", "notes.md");
  await git(project, "commit", "-q", "-m", "two");
  const main = await git(project, "rev-parse", "HEAD");
  await writeFiles(project, { "readme.txt": "working copy\n" });

  const worktree = join(root, "project-feature");
  await git(project, "worktree", "add", "-q", "-b", "feature", worktree, "v1");
  await writeFiles(worktree, { "readme.txt": "feature\n" });
  await git(worktree, "commit", "-q", "-a", "-m", "feature");
  const feature = await git(worktree, "rev-parse", "HEAD");

  const inner = join(project, "inner");
  await mkdir(inner);
  await git(inner, "init", "-q");
  await writeFiles(inner, { "inner.txt": "inner main" });
  await git(inner, "add", "-A");
  await git(inner, "commit", "-q", "-m", "inner");
  return { root, project, v1, main, feature };
}

async function serve(context: TestContext, root: string, options: Omit<FileServerOptions, "root"> = {}): Promise<string> {
  const server = await new FileServer({ ...options, root }).listen({ port: 0 });
  context.after(() => server.close());
  return server.url as string;
}

async function blobId(repository: string, revision: string, path: string): Promise<string> {
  return git(repository, "rev-parse", `${revision}:${path}`);
}

test("a file reads as it is at a branch, tag, commit, or expression", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const read = async (query: string): Promise<string> => {
    const response = await fetch(`${base}/project/readme.txt${query}`);
    assert.equal(response.status, 200, query);
    return response.text();
  };
  assert.equal(await read(""), "working copy\n");
  assert.equal(await read("?ref=main"), "version two\n");
  assert.equal(await read("?ref=v1"), "version one\n");
  assert.equal(await read(`?ref=${fixture.v1}`), "version one\n");
  assert.equal(await read(`?ref=${fixture.v1.slice(0, 7)}`), "version one\n");
  assert.equal(await read("?ref=main~1"), "version one\n");
  assert.equal(await read("?ref=HEAD"), "version two\n");
  assert.equal(await read("?ref=main%5E%7Bcommit%7D"), "version two\n");
});

test("file bytes at a ref carry a strong blob ETag, a ref-qualified Link, and no Last-Modified", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const etag = `"${await blobId(fixture.project, "main", "readme.txt")}"`;

  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${base}/project/readme.txt?ref=main`, { method });
    assert.equal(response.status, 200, method);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("content-length"), "12");
    assert.equal(response.headers.get("etag"), etag);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("link"), '<readme.txt?json&ref=main>; rel="describedby"');
    assert.equal(response.headers.get("last-modified"), null);
    assert.equal(response.headers.get("cache-control"), null);
    assert.equal(response.headers.get("allow"), null);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(await response.text(), method === "GET" ? "version two\n" : "");
  }
  const encoded = await fetch(`${base}/project/readme.txt?ref=${encodeURIComponent("main~0")}`);
  assert.equal(encoded.headers.get("link"), '<readme.txt?json&ref=main~0>; rel="describedby"');
  const spaced = await fetch(`${base}/project/readme.txt?ref=${encodeURIComponent("main@{0}")}`);
  assert.equal(spaced.headers.get("link"), `<readme.txt?json&ref=${encodeURIComponent("main@{0}")}>; rel="describedby"`);
});

test("only a full commit ID marks content at a ref as immutable", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const full = await fetch(`${base}/project/readme.txt?ref=${fixture.main}`);
  assert.equal(full.headers.get("cache-control"), immutable);
  const etag = full.headers.get("etag") as string;

  const notModified = await fetch(`${base}/project/readme.txt?ref=${fixture.main}`, { headers: { "If-None-Match": etag } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("cache-control"), immutable);
  const partial = await fetch(`${base}/project/readme.txt?ref=${fixture.main}`, { headers: { Range: "bytes=0-6" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("cache-control"), immutable);

  for (const ref of [fixture.main.slice(0, 12), fixture.main.toUpperCase(), "main", "HEAD"]) {
    const response = await fetch(`${base}/project/readme.txt?ref=${ref}`);
    assert.equal(response.status, 200, ref);
    assert.equal(response.headers.get("cache-control"), null, ref);
  }
  const description = await fetch(`${base}/project/readme.txt?json&ref=${fixture.main}`);
  assert.equal(description.headers.get("cache-control"), null);
  assert.equal(description.headers.get("etag"), null);
});

test("conditionals and ranges at a ref use the strong ETag and ignore dates", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const url = `${base}/project/readme.txt?ref=main`;
  const etag = (await fetch(url)).headers.get("etag") as string;

  const notModified = await fetch(url, { headers: { "If-None-Match": `"other", ${etag}` } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("etag"), etag);
  assert.equal(notModified.headers.get("link"), '<readme.txt?json&ref=main>; rel="describedby"');
  assert.equal(notModified.headers.get("last-modified"), null);
  assert.equal(await notModified.text(), "");
  assert.equal((await fetch(url, { headers: { "If-None-Match": `W/${etag}` } })).status, 304);
  assert.equal((await fetch(url, { method: "HEAD", headers: { "If-None-Match": etag } })).status, 304);
  assert.equal((await fetch(url, { headers: { "If-None-Match": '"other"' } })).status, 200);
  assert.equal((await fetch(url, { headers: { "If-Modified-Since": "Fri, 01 Jan 2100 00:00:00 GMT" } })).status, 200);

  const partial = await fetch(url, { headers: { Range: "bytes=0-6" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 0-6/12");
  assert.equal(partial.headers.get("content-length"), "7");
  assert.equal(await partial.text(), "version");
  const suffix = await fetch(url, { headers: { Range: "bytes=-4" } });
  assert.equal(await suffix.text(), "two\n");
  const open = await fetch(url, { headers: { Range: "bytes=8-" } });
  assert.equal(await open.text(), "two\n");

  const matching = await fetch(url, { headers: { Range: "bytes=0-6", "If-Range": etag } });
  assert.equal(matching.status, 206);
  for (const ifRange of [`W/${etag}`, '"other"', "Fri, 01 Jan 2100 00:00:00 GMT", new Date(committedAt).toUTCString()]) {
    const response = await fetch(url, { headers: { Range: "bytes=0-6", "If-Range": ifRange } });
    assert.equal(response.status, 200, ifRange);
    assert.equal(await response.text(), "version two\n");
  }

  const unsatisfiable = await fetch(url, { headers: { Range: "bytes=100-" } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get("content-range"), "bytes */12");
  assert.equal(unsatisfiable.headers.get("etag"), etag);
  const head = await fetch(url, { method: "HEAD", headers: { Range: "bytes=0-6" } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "12");
});

test("a large file at a ref streams whole and in ranges", async (context) => {
  const root = await makeRoot();
  await git(root, "init", "-q");
  const bytes = Buffer.alloc(3 * 1024 * 1024);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  await writeFile(join(root, "large.bin"), bytes);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "large");
  const base = await serve(context, root);

  const whole = await fetch(`${base}/large.bin?ref=main`);
  assert.equal(whole.headers.get("content-type"), "application/octet-stream");
  assert(Buffer.from(await whole.arrayBuffer()).equals(bytes));
  const start = 1_000_003;
  const end = 2_500_000;
  const range = await fetch(`${base}/large.bin?ref=main`, { headers: { Range: `bytes=${start}-${end}` } });
  assert.equal(range.status, 206);
  assert(Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(start, end + 1)));
});

test("a description at a ref runs the parser on the committed bytes and dates the commit", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const response = await fetch(`${base}/project/notes.md?json&ref=v1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal(response.headers.get("accept-patch"), null);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
  assert.equal(response.headers.get("link"), null);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), {
    path: "project/notes.md",
    kind: "file",
    contentType: "text/markdown; charset=utf-8",
    size: 29,
    modified: committedAt,
    frontmatter: { status: "old" },
    body: "Old body\n",
  });
  const head = await fetch(`${base}/project/notes.md?json&ref=v1`, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(body)));
  assert.equal(await head.text(), "");

  const live = await fetch(`${base}/project/notes.md?json`);
  assert.equal(live.headers.get("allow"), "GET, HEAD, PUT, PATCH, OPTIONS");
  assert.deepEqual((await live.json() as { frontmatter: unknown }).frontmatter, { status: "new" });
});

test("a listing at a ref shows the tree at that ref with every entry kind", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root, { ignore: ["build/"] });
  const response = await fetch(`${base}/project?json&ref=v1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  const listing = await response.json() as { path: string; kind: string; entries: Array<Record<string, unknown>> };
  assert.equal(listing.path, "project");
  assert.equal(listing.kind, "dir");
  assert.deepEqual(listing.entries.map(({ path, kind }) => [path, kind]), [
    ["project/docs", "dir"],
    ["project/gone", "dir"],
    ["project/link", "symlink"],
    ["project/notes.md", "file"],
    ["project/readme.txt", "file"],
    ["project/vendor", "submodule"],
  ]);
  for (const entry of listing.entries) {
    const own = await fetch(`${base}/${entry.path as string}?json&ref=v1`);
    assert.equal(own.status, 200, entry.path as string);
    const description = await own.json() as Record<string, unknown>;
    if (entry.kind === "dir") assert.deepEqual({ path: description.path, kind: description.kind }, entry);
    else assert.deepEqual(description, entry);
  }
  assert.deepEqual(listing.entries[3], {
    path: "project/notes.md",
    kind: "file",
    contentType: "text/markdown; charset=utf-8",
    size: 29,
    modified: committedAt,
    frontmatter: { status: "old" },
    body: "Old body\n",
  });

  const slash = await (await fetch(`${base}/project/?json&ref=v1`)).json();
  assert.deepEqual(slash, listing);
  const atMain = await (await fetch(`${base}/project?json&ref=main`)).json() as { entries: Array<{ path: string }> };
  assert.deepEqual(atMain.entries.map(({ path }) => path), [
    "project/docs", "project/link", "project/notes.md", "project/readme.txt", "project/vendor",
  ]);
  const live = await (await fetch(`${base}/project?json`)).json() as { entries: Array<{ path: string }> };
  assert(live.entries.some(({ path }) => path === "project/inner"));
});

test("a path absent from the disk reads from the ref, and a path absent at the ref is 404", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  assert.equal(await (await fetch(`${base}/project/gone/file.txt?ref=v1`)).text(), "gone");
  const listing = await (await fetch(`${base}/project/gone?json&ref=v1`)).json() as { entries: Array<{ path: string }> };
  assert.deepEqual(listing.entries.map(({ path }) => path), ["project/gone/file.txt"]);
  assert.equal((await fetch(`${base}/project/gone/file.txt`)).status, 404);

  for (const path of ["project/gone/file.txt?ref=main", "project/gone?json&ref=main", "project/nothing.txt?ref=main",
    "project/readme.txt/more?ref=main", "project/docs/nothing/deeper?ref=main"]) {
    const response = await fetch(`${base}/${path}`);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(typeof (await response.json() as { error?: unknown }).error, "string");
  }
});

test("directory URLs at a ref serve index.html, redirect, and refuse a file with a slash", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const index = await fetch(`${base}/project/docs/?ref=v1`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(index.headers.get("link"), '<index.html?json&ref=v1>; rel="describedby"');
  assert.equal(await index.text(), "<h1>v1</h1>");

  const redirect = await fetch(`${base}/project/docs?ref=v1`, { redirect: "manual" });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), "docs/?ref=v1");

  const noIndex = await fetch(`${base}/project/gone/?ref=v1`);
  assert.equal(noIndex.status, 404);
  assert.match((await noIndex.json() as { error: string }).error, /\?json/);
  assert.equal((await fetch(`${base}/project/readme.txt/?ref=main`)).status, 404);
  assert.equal((await fetch(`${base}/project/readme.txt/?json&ref=main`)).status, 404);
});

test("hidden and ignored paths stay hidden at a ref, judged by their type at the ref", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root, { ignore: ["build/", "*.html"] });
  for (const path of ["project/.hidden.txt?ref=v1", "project/%2Ehidden.txt?json&ref=v1", "project/.git/HEAD?ref=main",
    "project/build?json&ref=v1", "project/build/out.txt?ref=v1", "project/docs/index.html?ref=v1"]) {
    assert.equal((await rawRequest(base, "GET", `/${path}`)).status, 404, path);
  }
  const docs = await (await fetch(`${base}/project/docs?json&ref=v1`)).json() as { entries: Array<{ path: string }> };
  assert.deepEqual(docs.entries.map(({ path }) => path), ["project/docs/guide.txt"]);
  const noIndex = await fetch(`${base}/project/docs/?ref=v1`);
  assert.equal(noIndex.status, 404);
});

test("a directory-only ignore pattern does not hide a file of that name at a ref", async (context) => {
  const root = await makeRoot();
  await git(root, "init", "-q");
  await writeFiles(root, { "build": "a file named build", "logs/a.txt": "a" });
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "files");
  const base = await serve(context, root, { ignore: ["build/", "logs/"] });
  assert.equal(await (await fetch(`${base}/build?ref=main`)).text(), "a file named build");
  assert.equal((await fetch(`${base}/logs?json&ref=main`)).status, 404);
  const listing = await (await fetch(`${base}/?json&ref=main`)).json() as { entries: Array<{ path: string }> };
  assert.deepEqual(listing.entries.map(({ path }) => path), ["build"]);
});

test("symbolic links at a ref have only an exact description, and submodules are opaque", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  assert.deepEqual(await (await fetch(`${base}/project/link?json&ref=v1`)).json(), { path: "project/link", kind: "symlink" });
  const head = await fetch(`${base}/project/link?json&ref=v1`, { method: "HEAD" });
  assert.equal(head.status, 200);
  for (const path of ["project/link?ref=v1", "project/link/?ref=v1", "project/link/?json&ref=v1",
    "project/link/guide.txt?ref=v1", "project/link/guide.txt?json&ref=v1"]) {
    const response = await fetch(`${base}/${path}`, { redirect: "manual" });
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  }

  assert.deepEqual(await (await fetch(`${base}/project/vendor?json&ref=v1`)).json(), { path: "project/vendor", kind: "submodule" });
  for (const path of ["project/vendor?ref=v1", "project/vendor/?ref=v1", "project/vendor/?json&ref=v1", "project/vendor/file.txt?ref=v1"]) {
    assert.equal((await fetch(`${base}/${path}`, { redirect: "manual" })).status, 404, path);
  }
});

test("the nearest repository or worktree on disk encloses the path", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const text = async (path: string): Promise<string> => {
    const response = await fetch(`${base}/${path}`);
    assert.equal(response.status, 200, path);
    return response.text();
  };
  assert.equal(await text("project-feature/readme.txt?ref=HEAD"), "feature\n");
  assert.equal(await text("project-feature/readme.txt?ref=main"), "version two\n");
  assert.equal(await text("project/readme.txt?ref=feature"), "feature\n");
  assert.equal(await text(`project/readme.txt?ref=${fixture.feature}`), "feature\n");
  assert.equal(await text("project/readme.txt?ref=HEAD"), "version two\n");
  assert.equal(await text("project/inner/inner.txt?ref=main"), "inner main");
  const inner = await (await fetch(`${base}/project/inner?json&ref=main`)).json() as { path: string; entries: Array<{ path: string }> };
  assert.equal(inner.path, "project/inner");
  assert.deepEqual(inner.entries.map(({ path }) => path), ["project/inner/inner.txt"]);
  assert.equal((await fetch(`${base}/project/inner/inner.txt?ref=v1`)).status, 404);

  for (const path of ["loose.txt?ref=main", "?json&ref=main", "missing/file.txt?ref=main"]) {
    const response = await fetch(`${base}/${path}`);
    assert.equal(response.status, 404, path);
    assert.equal(typeof (await response.json() as { error?: unknown }).error, "string");
  }
});

test("the repository search does not follow a symbolic link on disk", async (context) => {
  const fixture = await makeFixture();
  await symlink("project", join(fixture.root, "alias"));
  const base = await serve(context, fixture.root);
  assert.equal((await fetch(`${base}/alias/readme.txt?ref=main`)).status, 404);
  assert.equal((await fetch(`${base}/alias/readme.txt`)).status, 403);
});

test("a served root that is itself a repository reads at a ref from /", async (context) => {
  const root = await makeRoot();
  await git(root, "init", "-q");
  await writeFiles(root, { "index.html": "<p>home</p>", "a.txt": "a" });
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "home");
  const base = await serve(context, root);
  const listing = await (await fetch(`${base}/?json&ref=main`)).json() as { path: string; entries: Array<{ path: string }> };
  assert.equal(listing.path, "");
  assert.deepEqual(listing.entries.map(({ path }) => path), ["a.txt", "index.html"]);
  const home = await fetch(`${base}/?ref=main`);
  assert.equal(await home.text(), "<p>home</p>");
  assert.equal(home.headers.get("link"), '<index.html?json&ref=main>; rel="describedby"');
});

test("repositories whose git directory is outside the root, and repositories above it, are not used", async (context) => {
  const outside = await mkdtemp(join(tmpdir(), "file-server-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await git(outside, "init", "-q");
  await writeFiles(outside, { "shared.txt": "outside", "served/inside.txt": "inside" });
  await git(outside, "add", "-A");
  await git(outside, "commit", "-q", "-m", "outside");

  const root = await makeRoot();
  await git(outside, "worktree", "add", "-q", "-b", "borrowed", join(root, "borrowed"));
  await writeFiles(root, { "pointer/.git": `gitdir: ${join(outside, ".git")}\n`, "pointer/shared.txt": "pointer" });
  const base = await serve(context, root);
  assert.equal(await (await fetch(`${base}/borrowed/shared.txt`)).text(), "outside");
  for (const path of ["borrowed/shared.txt?ref=main", "borrowed/shared.txt?ref=HEAD", "pointer/shared.txt?ref=main"]) {
    assert.equal((await fetch(`${base}/${path}`)).status, 404, path);
  }

  const subdirectory = await serve(context, join(outside, "served"));
  assert.equal(await (await fetch(`${subdirectory}/inside.txt`)).text(), "inside");
  assert.equal((await fetch(`${subdirectory}/inside.txt?ref=main`)).status, 404);
});

test("unknown refs, non-commit refs, and option-like refs are 404 and run nothing", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const marker = join(fixture.root, "created-by-git");
  for (const ref of ["nope", "main:readme.txt", "main^{tree}", `--output=${marker}`, "-h", "--help", "--version",
    "--git-dir=/", "-c", "--end-of-options", "main..v1", "^main", "main\nv1", " main"]) {
    const response = await fetch(`${base}/project/readme.txt?ref=${encodeURIComponent(ref)}`);
    assert.equal(response.status, 404, JSON.stringify(ref));
    assert.equal(typeof (await response.json() as { error?: unknown }).error, "string");
  }
  assert.equal((await fetch(`${base}/project?json&ref=nope`)).status, 404);
  assert.deepEqual((await readdir(fixture.root)).sort(), ["loose.txt", "project", "project-feature"]);
});

test("malformed ref parameters are 400", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  for (const query of ["?ref", "?ref=", "?json&ref=", "?ref=main&ref=v1", "?ref=main&json&ref=main", "?ref=ma%00in"]) {
    for (const method of ["GET", "HEAD", "OPTIONS", "PUT"]) {
      const response = await rawRequest(base, method, `/project/readme.txt${query}`);
      assert.equal(response.status, 400, `${method} ${query}`);
      if (method !== "HEAD") assert.equal(typeof (JSON.parse(response.body.toString()) as { error?: unknown }).error, "string");
    }
  }
  assert.equal((await rawRequest(base, "GET", "/project/readme.txt?REF=main&Ref=v1")).status, 200);
});

test("mutations with a ref are 405 before any repository lookup and change nothing", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const status = await git(fixture.project, "status", "--porcelain");
  const branches = await git(fixture.project, "for-each-ref");
  for (const path of ["project/readme.txt", "project/notes.md", "loose.txt", "missing.txt", "project/gone/file.txt"]) {
    for (const [method, query, contentType] of [
      ["PUT", "?ref=main", "text/plain"],
      ["PUT", "?json&ref=main", "application/json"],
      ["PATCH", "?ref=main", "application/merge-patch+json"],
      ["PATCH", "?json&ref=main", "application/merge-patch+json"],
      ["DELETE", "?ref=main", undefined],
      ["DELETE", "?json&ref=main", undefined],
      ["POST", "?ref=main", undefined],
    ] as const) {
      const response = await fetch(`${base}/${path}${query}`, {
        method,
        ...(contentType === undefined ? {} : { headers: { "Content-Type": contentType }, body: "{}" }),
      });
      assert.equal(response.status, 405, `${method} ${path}${query}`);
      assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
      assert.equal(response.headers.get("accept-patch"), null);
      assert.deepEqual(await response.json(), { error: "method not allowed" });
    }
  }
  assert.equal(await readFile(join(fixture.project, "readme.txt"), "utf8"), "working copy\n");
  assert.equal(await readFile(join(fixture.project, "notes.md"), "utf8"), "---\nstatus: new\n---\nNew body\n");
  assert.equal(await readFile(join(fixture.root, "loose.txt"), "utf8"), "loose");
  assert.deepEqual((await readdir(fixture.root)).sort(), ["loose.txt", "project", "project-feature"]);
  assert.equal(await git(fixture.project, "status", "--porcelain"), status);
  assert.equal(await git(fixture.project, "for-each-ref"), branches);
});

test("a preflight at a ref offers only reads, whether or not the path exists", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  for (const path of ["project/notes.md?json&ref=main", "project/readme.txt?ref=main", "loose.txt?ref=nope", "project/link?ref=v1"]) {
    const response = await fetch(`${base}/${path}`, {
      method: "OPTIONS",
      headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET" },
    });
    assert.equal(response.status, 204, path);
    assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
    assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type, Range, If-None-Match, If-Modified-Since, If-Range");
    assert.equal(response.headers.get("accept-patch"), null);
  }
});

test("bytes at a ref are the stored blob, without checkout filters", async (context) => {
  const root = await makeRoot();
  await git(root, "init", "-q");
  await writeFiles(root, { ".gitattributes": "*.txt text eol=crlf\n", "lines.txt": "one\ntwo\n" });
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "lines");
  await rm(join(root, "lines.txt"));
  await git(root, "checkout", "--", "lines.txt");
  assert.equal(await readFile(join(root, "lines.txt"), "utf8"), "one\r\ntwo\r\n");
  const base = await serve(context, root);
  assert.equal(await (await fetch(`${base}/lines.txt?ref=main`)).text(), "one\ntwo\n");
  assert.equal((await (await fetch(`${base}/lines.txt?json&ref=main`)).json() as { size: number }).size, 8);
});

test("names a request cannot address are left out of a listing at a ref", async (context) => {
  const root = await makeRoot();
  await git(root, "init", "-q");
  await writeFiles(root, { "plain.txt": "plain", "back\\slash.txt": "backslash", ".dot.txt": "dot" });
  await git(root, "add", "-A");
  const blob = await git(root, "hash-object", "-w", "plain.txt");
  const indexEntry = Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0x62, 0x61, 0x64, 0xff]), Buffer.from("\0")]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["update-index", "-z", "--index-info"], { cwd: root, stdio: ["pipe", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`git update-index exited ${code}`)));
    child.stdin.end(indexEntry);
  });
  await git(root, "commit", "-q", "-m", "names");
  const base = await serve(context, root);
  const listing = await (await fetch(`${base}/?json&ref=main`)).json() as { entries: Array<{ path: string }> };
  assert.deepEqual(listing.entries.map(({ path }) => path), ["plain.txt"]);
});

test("ref requests do not reach the extension hooks", async (context) => {
  const fixture = await makeFixture();
  const calls: string[] = [];
  const base = await serve(context, fixture.root, {
    extension: {
      handle(request) { calls.push(`handle ${request.url}`); return false; },
      listing(request, listing) { calls.push(`listing ${request.url}`); return listing; },
    },
  });
  assert.equal(await (await fetch(`${base}/project/readme.txt?ref=main`)).text(), "version two\n");
  assert.equal((await fetch(`${base}/project?json&ref=main`)).status, 200);
  assert.deepEqual(calls, []);
  assert.equal((await fetch(`${base}/project?json`)).status, 200);
  assert.deepEqual(calls, ["handle /project?json", "listing /project?json"]);
});

test("a ref request is 500 when git cannot run", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const empty = await makeRoot();
  const path = process.env.PATH;
  process.env.PATH = empty;
  context.after(() => { process.env.PATH = path; });
  const response = await fetch(`${base}/project/readme.txt?ref=main`);
  assert.equal(response.status, 500);
  assert.equal(typeof (await response.json() as { error?: unknown }).error, "string");
  assert.equal(await (await fetch(`${base}/project/readme.txt`)).text(), "working copy\n");
});

test("WebSocket upgrades ignore ref, and commits signal only working-tree changes", async (context) => {
  const fixture = await makeFixture();
  const base = await serve(context, fixture.root);
  const socket = await openSocket(base, "/project/?ref=main");
  context.after(() => socket.close());
  await git(fixture.project, "commit", "-q", "--allow-empty", "-m", "empty");
  await git(fixture.project, "branch", "-f", "feature-two", "v1");
  await expectNoEvent(socket, 300);
});
