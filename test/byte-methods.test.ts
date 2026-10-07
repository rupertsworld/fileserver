/** Byte-address method eligibility and headers, exercised through the HTTP server. */
import assert from "node:assert/strict";
import { readFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { FileServer } from "../src/server.ts";
import { makeRoot, rawRequest } from "./helpers.ts";

const byteAllow = "GET, HEAD, PUT, DELETE, OPTIONS";

test("PATCH on every byte address returns 405 before the extension handle hook", async (context) => {
  const root = await makeRoot({ "note.txt": "original", "folder/child.txt": "child" });
  let handled = 0;
  const server = await new FileServer({
    root,
    extension: { handle() { handled += 1; return false; } },
  }).listen({ port: 0 });
  context.after(() => server.close());

  for (const path of ["/note.txt", "/missing.txt", "/folder", "/folder/", "/"]) {
    const response = await rawRequest(server.url as string, "PATCH", path);
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.allow, byteAllow, path);
    assert.equal(response.headers["accept-patch"], undefined, path);
    assert.equal(typeof JSON.parse(response.body.toString()).error, "string", path);
  }
  assert.equal(handled, 0);
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "original");
});

test("byte PATCH follows URL, hidden-path, symlink, and confinement checks before 405", async (context) => {
  const root = await makeRoot({ "note.txt": "inside", ".hidden.txt": "hidden" });
  await symlink("note.txt", join(root, "alias.txt"));
  const outside = await makeRoot({ "note.txt": "outside" });
  const server = await new FileServer({ root }).listen({ port: 0 });
  context.after(() => server.close());

  assert.equal((await rawRequest(server.url as string, "PATCH", "/bad//path")).status, 400);
  assert.equal((await rawRequest(server.url as string, "PATCH", "/.hidden.txt")).status, 404);
  assert.equal((await rawRequest(server.url as string, "PATCH", "/alias.txt")).status, 403);

  const movedRoot = `${root}-moved`;
  await rename(root, movedRoot);
  await symlink(outside, root);
  context.after(async () => {
    await rm(root, { force: true });
    await rm(movedRoot, { recursive: true, force: true });
  });
  assert.equal((await rawRequest(server.url as string, "PATCH", "/note.txt")).status, 404);
  assert.equal(await readFile(join(outside, "note.txt"), "utf8"), "outside");
});

test("byte responses and preflights never advertise PATCH or Accept-Patch", async (context) => {
  const root = await makeRoot({ "note.txt": "old", "bad.txt": "bad" });
  const server = await new FileServer({
    root,
    extension: {
      handle(request, response, requestContext) {
        if (requestContext.path !== "bad.txt" || request.method !== "PUT") return false;
        response.status(415).json({ error: "unsupported media type" });
        return true;
      },
    },
  }).listen({ port: 0 });
  context.after(() => server.close());
  const baseUrl = server.url as string;

  for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PATCH"]) {
    const response = await rawRequest(baseUrl, method, "/note.txt");
    assert.equal(response.headers["accept-patch"], undefined, method);
    if (method === "OPTIONS") {
      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-methods"], byteAllow);
    }
    if (method === "POST" || method === "PATCH") {
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, byteAllow);
    }
  }

  const put = await fetch(`${baseUrl}/note.txt`, { method: "PUT", body: "new" });
  assert.equal(put.status, 204);
  assert.equal(put.headers.get("accept-patch"), null);
  const unsupportedMedia = await fetch(`${baseUrl}/bad.txt`, { method: "PUT", body: "new" });
  assert.equal(unsupportedMedia.status, 415);
  assert.equal(unsupportedMedia.headers.get("accept-patch"), null);
  assert.equal(await readFile(join(root, "bad.txt"), "utf8"), "bad");
});
