import assert from "node:assert/strict";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { rawRequest, startFixture } from "./helpers.ts";
import type { FileServerConformanceFactory } from "./types.js";

export function defineDirectoriesConformance(factory: FileServerConformanceFactory): void {
  test("file-server conformance: JSON directory listings have full entry descriptions", async (context) => {
    const running = await startFixture(context, factory, {
      ".hidden": "hidden",
      "notes/Z.txt": "zed",
      "notes/a.txt": "a",
      "notes/b.txt": "bb",
      "notes/café.txt": "coffee",
    });
    await utimes(join(running.root, "notes", "a.txt"), new Date("2026-01-02T03:04:05Z"), new Date("2026-01-02T03:04:05Z"));
    await mkdir(join(running.root, "notes", "archive"));
    await symlink("archive", join(running.root, "notes", "latest"));

    const response = await fetch(`${running.baseUrl}/notes/?json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    for (const header of ["etag", "last-modified", "accept-ranges", "link"]) {
      assert.equal(response.headers.get(header), null, header);
    }
    const body = await response.text();
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body)));
    const listing = JSON.parse(body) as {
      path: string;
      kind: string;
      entries: Array<{ path: string; kind: string; contentType?: string; size?: number; modified?: string }>;
    };
    assert.equal(listing.path, "notes");
    assert.equal(listing.kind, "dir");
    assert.deepEqual(listing.entries.map(({ path }) => path), [
      "notes/Z.txt", "notes/a.txt", "notes/archive", "notes/b.txt", "notes/café.txt", "notes/latest",
    ]);
    assert.deepEqual(listing.entries.find(({ path }) => path === "notes/archive"), { path: "notes/archive", kind: "dir" });
    assert.deepEqual(listing.entries.find(({ path }) => path === "notes/latest"), { path: "notes/latest", kind: "symlink" });
    assert.deepEqual(listing.entries.find(({ path }) => path === "notes/a.txt"), {
      path: "notes/a.txt",
      kind: "file",
      contentType: "text/plain; charset=utf-8",
      size: 1,
      modified: "2026-01-02T03:04:05.000Z",
    });
    assert.deepEqual(await (await fetch(`${running.baseUrl}/notes?json`)).json(), listing);
    assert.deepEqual(await (await fetch(`${running.baseUrl}/notes/a.txt?json`)).json(), listing.entries.find(({ path }) => path === "notes/a.txt"));
    assert.deepEqual(await (await fetch(`${running.baseUrl}/notes/latest?json`)).json(), listing.entries.find(({ path }) => path === "notes/latest"));
    const root = await (await fetch(`${running.baseUrl}/?json`)).json() as { path: string; kind: string; entries: Array<{ path: string }> };
    assert.equal(root.path, "");
    assert.equal(root.kind, "dir");
    assert.deepEqual(root.entries.map(({ path }) => path), ["notes"]);

    await writeFile(join(running.root, "notes", ".nested"), "hidden");
    await writeFile(join(running.root, "notes", "back\\slash"), "hidden");
    const invalidName = Buffer.concat([Buffer.from(`${running.root}/notes/invalid-`), Buffer.from([0xff])]);
    await writeFile(invalidName, "hidden");
    const filtered = await (await fetch(`${running.baseUrl}/notes/?json`)).json() as { entries: Array<{ path: string }> };
    assert.deepEqual(filtered.entries.map(({ path }) => path), [
      "notes/Z.txt", "notes/a.txt", "notes/archive", "notes/b.txt", "notes/café.txt", "notes/latest",
    ]);

    const conditional = await fetch(`${running.baseUrl}/notes/?json`, {
      headers: { range: "bytes=0-1", "if-none-match": "*", "if-modified-since": "Tue, 05 Mar 2030 00:00:00 GMT" },
    });
    assert.equal(conditional.status, 200);
    assert.equal(conditional.headers.get("content-range"), null);
    assert.equal(conditional.headers.get("accept-ranges"), null);
    assert.deepEqual(await conditional.json(), filtered);

    const rawGet = await rawRequest(running.baseUrl, "GET", "/notes/?json");
    const rawHead = await rawRequest(running.baseUrl, "HEAD", "/notes/?json");
    assert.equal(rawHead.status, 200);
    assert.equal(rawHead.headers["content-type"], rawGet.headers["content-type"]);
    assert.equal(rawHead.headers["content-length"], String(rawGet.body.length));
    assert.equal(rawHead.body.length, 0);

    const bomName = "\uFEFFbom.txt";
    await writeFile(join(running.root, "notes", bomName), "bom");
    const withBom = await (await fetch(`${running.baseUrl}/notes/?json`)).json() as { entries: Array<{ path: string }> };
    assert.equal(withBom.entries.some(({ path }) => path === `notes/${bomName}`), true);
    assert.equal(await (await fetch(`${running.baseUrl}/notes/%EF%BB%BFbom.txt`)).text(), "bom");
  });

  test("file-server conformance: directory URLs redirect or serve index.html", async (context) => {
    const running = await startFixture(context, factory, {
      "index.html": "root index",
      "pages/index.html": "page index",
      "plain/child.txt": "child",
      "with space/index.html": "space index",
      "nonregular/index.html/child.txt": "child",
      "linked/target.html": "target",
    });
    await symlink("target.html", join(running.root, "linked", "index.html"));
    const root = await fetch(`${running.baseUrl}/`);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(root.headers.get("link"), '<index.html?json>; rel="describedby"');
    assert.equal(await root.text(), "root index");
    const index = await fetch(`${running.baseUrl}/pages/`, { headers: { range: "bytes=0-3" } });
    assert.equal(index.status, 206);
    assert.equal(index.headers.get("link"), '<index.html?json>; rel="describedby"');
    assert.equal(await index.text(), "page");
    const indexHead = await fetch(`${running.baseUrl}/pages/`, { method: "HEAD" });
    assert.equal(indexHead.status, 200);
    assert.equal(indexHead.headers.get("link"), '<index.html?json>; rel="describedby"');
    assert.equal(await indexHead.text(), "");
    const etag = (await fetch(`${running.baseUrl}/pages/`)).headers.get("etag");
    assert(etag);
    const cached = await fetch(`${running.baseUrl}/pages/`, { headers: { "if-none-match": etag } });
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get("link"), '<index.html?json>; rel="describedby"');

    for (const [path, location] of [
      ["/pages", "pages/"],
      ["/with%20space?view=one%20two&flag", "with%20space/?view=one%20two&flag"],
      ["/plain?other=1", "plain/?other=1"],
    ] as const) {
      const redirected = await fetch(`${running.baseUrl}${path}`, { redirect: "manual" });
      assert.equal(redirected.status, 307, path);
      assert.equal(redirected.headers.get("location"), location, path);
      const redirectedHead = await fetch(`${running.baseUrl}${path}`, { method: "HEAD", redirect: "manual" });
      assert.equal(redirectedHead.status, 307, path);
      assert.equal(redirectedHead.headers.get("location"), location, path);
    }
    for (const path of ["/plain/", "/plain/?other=1"]) {
      const missingIndex = await fetch(`${running.baseUrl}${path}`);
      assert.equal(missingIndex.status, 404, path);
      assert.equal(missingIndex.headers.get("content-type"), "application/json; charset=utf-8", path);
      assert.match(String((await missingIndex.json() as { error: string }).error), /\?json/, path);
      assert.equal((await fetch(`${running.baseUrl}${path}`, { method: "HEAD" })).status, 404, path);
    }
    const nonregular = await fetch(`${running.baseUrl}/nonregular/`);
    assert.equal(nonregular.status, 404);
    assert.match(String((await nonregular.json() as { error: string }).error), /\?json/);
    assert.equal((await fetch(`${running.baseUrl}/linked/`)).status, 403);
    assert.equal((await fetch(`${running.baseUrl}/plain/`, { method: "OPTIONS" })).status, 204);
    assert.equal((await (await fetch(`${running.baseUrl}/pages?json`)).json() as { entries: unknown[] }).entries.length, 1);
  });
}
