/** Wire checks for the built-in Markdown parser and structured file addresses. */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  beginUpload,
  expectNoEvent,
  nextEvent,
  openSocket,
  rawRequest,
  startFixture,
  waitForTemporaryName,
} from "./helpers.ts";
import type { FileServerConformanceFactory } from "./types.js";

const mergePatchType = "application/merge-patch+json";
const writableMethods = "GET, HEAD, PUT, PATCH, OPTIONS";
const readOnlyMethods = "GET, HEAD, OPTIONS";

/** Register wire tests for parsed descriptions and structured file writes. */
export function defineParsersConformance(factory: FileServerConformanceFactory): void {
  test("file-server conformance: Markdown descriptions preserve bytes and match listing entries", async (context) => {
    const valid = "---\nstatus: open\nitems: [one, two]\n---\nWork\r\n";
    const malformed = "---\nstatus: [\nNo closing delimiter\n";
    const invalid = Uint8Array.from([0xff, 0xfe, 0x61]);
    const running = await startFixture(context, factory, {
      "notes/valid.md": valid,
      "notes/plain.MD": "No header\n",
      "notes/empty.md": "---\n---\nAfter\n",
      "notes/malformed.md": malformed,
      "notes/yaml-error.md": "---\nlist: [\n---\nbody",
      "notes/not-map.md": "---\n- one\n---\nbody",
      "notes/invalid.md": invalid,
      "notes/other.txt": "plain",
    });

    const listing = await (await fetch(`${running.baseUrl}/notes/?json`)).json() as {
      entries: Array<Record<string, unknown>>;
    };
    for (const entry of listing.entries) {
      const path = String(entry.path).split("/").map(encodeURIComponent).join("/");
      assert.deepEqual(await (await fetch(`${running.baseUrl}/${path}?json`)).json(), entry, path);
    }

    const byPath = (path: string): Record<string, unknown> => {
      const entry = listing.entries.find((candidate) => candidate.path === path);
      assert(entry, path);
      return entry;
    };
    assert.deepEqual(byPath("notes/valid.md").frontmatter, { status: "open", items: ["one", "two"] });
    assert.equal(byPath("notes/valid.md").body, "Work\r\n");
    assert.equal(byPath("notes/valid.md").frontmatterError, undefined);
    assert.deepEqual(byPath("notes/plain.MD").frontmatter, {});
    assert.equal(byPath("notes/plain.MD").body, "No header\n");
    assert.deepEqual(byPath("notes/empty.md").frontmatter, {});
    assert.equal(byPath("notes/empty.md").body, "After\n");
    assert.deepEqual(byPath("notes/malformed.md").frontmatter, {});
    assert.equal(byPath("notes/malformed.md").body, malformed);
    assert.equal(typeof byPath("notes/malformed.md").frontmatterError, "string");
    for (const path of ["notes/yaml-error.md", "notes/not-map.md"]) {
      assert.deepEqual(byPath(path).frontmatter, {}, path);
      assert.equal(typeof byPath(path).frontmatterError, "string", path);
    }
    assert.equal(byPath("notes/yaml-error.md").body, "---\nlist: [\n---\nbody");
    assert.equal(byPath("notes/not-map.md").body, "---\n- one\n---\nbody");
    assert.equal(typeof byPath("notes/invalid.md").parseError, "string");
    assert.equal(byPath("notes/invalid.md").frontmatter, undefined);
    assert.equal(byPath("notes/invalid.md").body, undefined);
    assert.deepEqual(Object.keys(byPath("notes/other.txt")).sort(), [
      "contentType", "kind", "modified", "path", "size",
    ]);
    assert.equal(await (await fetch(`${running.baseUrl}/notes/valid.md`)).text(), valid);
    assert.deepEqual(Buffer.from(await (await fetch(`${running.baseUrl}/notes/invalid.md`)).arrayBuffer()), Buffer.from(invalid));
  });

  test("file-server conformance: structured method lists and media types depend on parser eligibility", async (context) => {
    const running = await startFixture(context, factory, { "editable.md": "body", "plain.txt": "body" });
    for (const [path, allowed, acceptPatch] of [
      ["/editable.md?json", writableMethods, mergePatchType],
      ["/new.MD?json", writableMethods, mergePatchType],
      ["/plain.txt?json", readOnlyMethods, null],
      ["/missing.txt?json", readOnlyMethods, null],
      ["/?json", readOnlyMethods, null],
    ] as const) {
      const preflight = await fetch(`${running.baseUrl}${path}`, { method: "OPTIONS" });
      assert.equal(preflight.status, 204, path);
      assert.equal(preflight.headers.get("allow"), allowed, path);
      assert.equal(preflight.headers.get("access-control-allow-methods"), allowed, path);
      assert.equal(preflight.headers.get("accept-patch"), acceptPatch, path);
      assert.equal(await preflight.text(), "", path);
      const unsupported = await fetch(`${running.baseUrl}${path}`, { method: "POST" });
      assert.equal(unsupported.status, 405, path);
      assert.equal(unsupported.headers.get("allow"), allowed, path);
      assert.equal(unsupported.headers.get("accept-patch"), acceptPatch, path);
    }
    const described = await fetch(`${running.baseUrl}/editable.md?json`);
    assert.equal(described.headers.get("accept-patch"), mergePatchType);
    assert.equal((await fetch(`${running.baseUrl}/plain.txt?json`)).headers.get("accept-patch"), null);
    for (const [path, method] of [
      ["/editable.md?json", "DELETE"],
      ["/plain.txt?json", "PUT"],
      ["/plain.txt?json", "PATCH"],
    ] as const) {
      const refused = await fetch(`${running.baseUrl}${path}`, { method });
      assert.equal(refused.status, 405, `${method} ${path}`);
      assert.equal(refused.headers.get("allow"), path.includes("editable") ? writableMethods : readOnlyMethods);
    }
    assert.equal((await fetch(`${running.baseUrl}/missing.md?json`, {
      method: "PATCH", headers: { "content-type": mergePatchType }, body: "{}",
    })).status, 404);
  });

  test("file-server conformance: structured Markdown writes merge, replace, and publish changes", async (context) => {
    const original = "---\n# keep comment\ntitle: Old\ntags: [one, two]\nremove: gone\nkeep: \"quoted\" # keep inline\ndetails:\n  owner: Ana\n  retained: yes\n---\nOld body\n";
    const running = await startFixture(context, factory, {
      "notes/existing.md": original,
      "notes/malformed.md": "---\nnot closed\n",
    });
    const socket = await openSocket(running.baseUrl, "/");
    context.after(() => socket.close());

    const before = await stat(join(running.root, "notes", "existing.md"));
    const empty = await fetch(`${running.baseUrl}/notes/existing.md?json`, {
      method: "PATCH", headers: { "content-type": mergePatchType }, body: "{}",
    });
    assert.equal(empty.status, 200);
    assert.equal((await empty.json() as { body: string }).body, "Old body\n");
    assert.equal(await readFile(join(running.root, "notes", "existing.md"), "utf8"), original);
    assert.equal((await stat(join(running.root, "notes", "existing.md"))).mtimeMs, before.mtimeMs);
    await expectNoEvent(socket);

    let event = nextEvent(socket);
    const patched = await fetch(`${running.baseUrl}/notes/existing.md?json`, {
      method: "PATCH",
      headers: { "content-type": "Application/Merge-Patch+Json; charset=utf-8" },
      body: JSON.stringify({
        frontmatter: { title: "New", tags: ["three"], remove: null, details: { owner: "Bea" } },
        body: "New body\n",
      }),
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(patched.headers.get("accept-patch"), mergePatchType);
    assert.deepEqual(await event, { type: "modified", path: "notes/existing.md" });
    const patchedWire = await patched.text();
    assert.equal(patched.headers.get("content-length"), String(Buffer.byteLength(patchedWire)));
    const patchedDescription = JSON.parse(patchedWire) as { frontmatter: Record<string, unknown>; body: string };
    assert.deepEqual(patchedDescription.frontmatter, {
      title: "New", tags: ["three"], keep: "quoted", details: { owner: "Bea", retained: "yes" },
    });
    assert.equal(patchedDescription.body, "New body\n");
    const patchedBytes = await readFile(join(running.root, "notes", "existing.md"), "utf8");
    assert.match(patchedBytes, /# keep comment/);
    assert.match(patchedBytes, /keep: "quoted" # keep inline/);
    assert(patchedBytes.indexOf("title:") < patchedBytes.indexOf("tags:"));
    assert(patchedBytes.indexOf("tags:") < patchedBytes.indexOf("keep:"));
    assert(!patchedBytes.includes("remove:"));
    await expectNoEvent(socket);

    event = nextEvent(socket);
    const bodyOnly = await fetch(`${running.baseUrl}/notes/existing.md?json`, {
      method: "PATCH", headers: { "content-type": mergePatchType }, body: '{"body":"Only body changed"}',
    });
    assert.equal(bodyOnly.status, 200);
    assert.deepEqual(await event, { type: "modified", path: "notes/existing.md" });
    assert.deepEqual((await bodyOnly.json() as { frontmatter: unknown }).frontmatter, patchedDescription.frontmatter);
    await expectNoEvent(socket);

    event = nextEvent(socket);
    const clear = await fetch(`${running.baseUrl}/notes/existing.md?json`, {
      method: "PATCH", headers: { "content-type": mergePatchType },
      body: JSON.stringify({ frontmatter: null, body: null }),
    });
    assert.equal(clear.status, 200);
    assert.deepEqual(await event, { type: "modified", path: "notes/existing.md" });
    const clearedDescription = await clear.json() as { frontmatter: unknown; body: unknown };
    assert.deepEqual(clearedDescription.frontmatter, {});
    assert.equal(clearedDescription.body, "");
    assert.equal(await readFile(join(running.root, "notes", "existing.md"), "utf8"), "");
    await expectNoEvent(socket);

    event = nextEvent(socket);
    const replaced = await fetch(`${running.baseUrl}/notes/existing.md?json`, {
      method: "PUT", headers: { "content-type": "Application/Json; charset=utf-8" },
      body: JSON.stringify({
        path: "wrong.md", kind: "dir", contentType: "wrong", size: 999, modified: "wrong",
        frontmatter: { phase: "done" }, body: "Replacement\n", frontmatterError: "stale",
      }),
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await event, { type: "modified", path: "notes/existing.md" });
    const replacedDescription = await replaced.json() as Record<string, unknown>;
    assert.equal(replacedDescription.path, "notes/existing.md");
    assert.equal(replacedDescription.kind, "file");
    assert.deepEqual(replacedDescription.frontmatter, { phase: "done" });
    assert.equal(replacedDescription.body, "Replacement\n");
    assert.equal(replacedDescription.frontmatterError, undefined);
    await expectNoEvent(socket);

    event = nextEvent(socket);
    const created = await fetch(`${running.baseUrl}/notes/new.md?json`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "New\n" }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await event, { type: "created", path: "notes/new.md" });
    assert.deepEqual((await created.json() as { frontmatter: unknown; body: unknown }), {
      path: "notes/new.md", kind: "file", contentType: "text/markdown; charset=utf-8",
      size: 4, modified: (await stat(join(running.root, "notes", "new.md"))).mtime.toISOString(),
      frontmatter: {}, body: "New\n",
    });
    assert.equal(await readFile(join(running.root, "notes", "new.md"), "utf8"), "New\n");
    await expectNoEvent(socket);

    event = nextEvent(socket);
    const repaired = await fetch(`${running.baseUrl}/notes/malformed.md?json`, {
      method: "PATCH", headers: { "content-type": mergePatchType }, body: JSON.stringify({ body: "Fixed\n" }),
    });
    assert.equal(repaired.status, 200);
    assert.deepEqual(await event, { type: "modified", path: "notes/malformed.md" });
    const repairedDescription = await repaired.json() as Record<string, unknown>;
    assert.deepEqual(repairedDescription.frontmatter, {});
    assert.equal(repairedDescription.body, "Fixed\n");
    assert.equal(repairedDescription.frontmatterError, undefined);
    assert.equal(await readFile(join(running.root, "notes", "malformed.md"), "utf8"), "Fixed\n");
    await expectNoEvent(socket);
  });

  test("file-server conformance: failed structured writes leave files intact and publish nothing", async (context) => {
    const invalid = Uint8Array.from([0xff, 0xfe, 0x61]);
    const running = await startFixture(context, factory, {
      "existing.md": "Original\n", "invalid.md": invalid,
    });
    const socket = await openSocket(running.baseUrl, "/");
    context.after(() => socket.close());
    const cases: Array<{ method: "PUT" | "PATCH"; path?: string; contentType?: string; body: string; status: number }> = [
      { method: "PUT", contentType: mergePatchType, body: "{}", status: 415 },
      { method: "PATCH", contentType: "application/json", body: "{}", status: 415 },
      { method: "PUT", contentType: "application/json", body: "{", status: 400 },
      { method: "PATCH", contentType: mergePatchType, body: "{", status: 400 },
      { method: "PUT", contentType: "application/json", body: "[]", status: 400 },
      { method: "PATCH", contentType: mergePatchType, body: "null", status: 400 },
      { method: "PATCH", contentType: mergePatchType, body: '{"path":"other.md"}', status: 422 },
      { method: "PATCH", contentType: mergePatchType, body: '{"frontmatterError":"ignored"}', status: 422 },
      { method: "PATCH", contentType: mergePatchType, body: '{"unknown":true}', status: 422 },
      { method: "PATCH", contentType: mergePatchType, body: '{"frontmatter":[]}', status: 422 },
      { method: "PATCH", contentType: mergePatchType, body: '{"body":12}', status: 422 },
      { method: "PUT", contentType: "application/json", body: '{"frontmatter":null}', status: 422 },
      { method: "PUT", contentType: "application/json", body: '{"body":null}', status: 422 },
      { method: "PUT", contentType: "application/json", body: '{"unknown":true}', status: 422 },
      { method: "PATCH", path: "/invalid.md?json", contentType: mergePatchType, body: '{"body":"fixed"}', status: 422 },
    ];
    for (const { method, path = "/existing.md?json", contentType, body, status } of cases) {
      const response = await fetch(`${running.baseUrl}${path}`, {
        method, headers: contentType === undefined ? {} : { "content-type": contentType }, body,
      });
      assert.equal(response.status, status, `${method} ${path}: ${body}`);
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
    }
    for (const method of ["PUT", "PATCH"] as const) {
      const missingMedia = await rawRequest(running.baseUrl, method, "/existing.md?json", {}, Buffer.from("{}"));
      assert.equal(missingMedia.status, 415, method);
    }
    assert.equal(await readFile(join(running.root, "existing.md"), "utf8"), "Original\n");
    assert.deepEqual(await readFile(join(running.root, "invalid.md")), Buffer.from(invalid));
    await expectNoEvent(socket);
  });

  test("file-server conformance: structured limits reject large bodies, targets, and output", async (context) => {
    const limit = 16 * 1024 * 1024;
    const almostFull = "x".repeat(limit - 5);
    const running = await startFixture(context, factory, {
      "large.md": "x".repeat(limit + 1), "almost.md": almostFull, "small.md": "small",
    });
    const tooLargeBody = await fetch(`${running.baseUrl}/small.md?json`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "y".repeat(limit) }),
    });
    assert.equal(tooLargeBody.status, 413);
    const tooLargeTarget = await fetch(`${running.baseUrl}/large.md?json`, {
      method: "PATCH", headers: { "content-type": mergePatchType }, body: '{"body":"new"}',
    });
    assert.equal(tooLargeTarget.status, 415);
    const tooLargeOutput = await fetch(`${running.baseUrl}/almost.md?json`, {
      method: "PATCH", headers: { "content-type": mergePatchType }, body: '{"frontmatter":{"a":1}}',
    });
    assert.equal(tooLargeOutput.status, 413);
    assert.equal(await readFile(join(running.root, "small.md"), "utf8"), "small");
    assert.equal((await stat(join(running.root, "large.md"))).size, limit + 1);
    assert.equal(await readFile(join(running.root, "almost.md"), "utf8"), almostFull);
  });

  test("file-server conformance: create-only PUT protects byte and structured files at commit", async (context) => {
    const running = await startFixture(context, factory, { "existing.txt": "old", "existing.md": "old" });
    const socket = await openSocket(running.baseUrl, "/");
    context.after(() => socket.close());
    const byteRefusal = await fetch(`${running.baseUrl}/existing.txt`, {
      method: "PUT", headers: { "if-none-match": "*" }, body: "new",
    });
    assert.equal(byteRefusal.status, 412);
    assert.equal(typeof (await byteRefusal.json() as { error: unknown }).error, "string");
    assert.equal(await readFile(join(running.root, "existing.txt"), "utf8"), "old");
    const structuredRefusal = await fetch(`${running.baseUrl}/existing.md?json`, {
      method: "PUT", headers: { "if-none-match": "*", "content-type": "text/plain" }, body: "invalid",
    });
    assert.equal(structuredRefusal.status, 412, "precondition precedes body validation");
    assert.equal(typeof (await structuredRefusal.json() as { error: unknown }).error, "string");
    assert.equal(await readFile(join(running.root, "existing.md"), "utf8"), "old");
    await expectNoEvent(socket);
    socket.close();
    assert.equal((await fetch(`${running.baseUrl}/existing.txt`, {
      method: "PUT", headers: { "if-none-match": '"stale"' }, body: "replaced",
    })).status, 204);
    assert.equal((await fetch(`${running.baseUrl}/existing.md?json`, {
      method: "PUT", headers: { "if-none-match": '"stale"', "content-type": "application/json" },
      body: '{"body":"replaced"}',
    })).status, 200);
    assert.equal(await readFile(join(running.root, "existing.txt"), "utf8"), "replaced");
    assert.equal(await readFile(join(running.root, "existing.md"), "utf8"), "replaced");

    const created = await fetch(`${running.baseUrl}/created.md?json`, {
      method: "PUT", headers: { "if-none-match": "*", "content-type": "application/json" },
      body: '{"body":"created"}',
    });
    assert.equal(created.status, 201);
    assert.equal((await fetch(`${running.baseUrl}/created.md?json`, {
      method: "PUT", headers: { "if-none-match": "*", "content-type": "application/json" },
      body: '{"body":"replacement"}',
    })).status, 412);
    assert.equal(await readFile(join(running.root, "created.md"), "utf8"), "created");

    const upload = beginUpload(running.baseUrl, "/race.txt", 8, { "if-none-match": "*" });
    upload.request.write("slow");
    await waitForTemporaryName(running.root, ["existing.txt", "existing.md", "created.md"]);
    const winner = await fetch(`${running.baseUrl}/race.txt`, {
      method: "PUT", headers: { "if-none-match": "*" }, body: "winner",
    });
    assert.equal(winner.status, 201);
    upload.request.end("last");
    assert.equal((await upload.response).status, 412);
    assert.equal(await readFile(join(running.root, "race.txt"), "utf8"), "winner");
  });
}
