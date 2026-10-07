/** Parser configuration and the shared description path, exercised through HTTP. */
import assert from "node:assert/strict";
import { readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { FileServer } from "../src/server.ts";
import { expectNoEvent, nextEvent, openSocket } from "../src/conformance/helpers.ts";
import { makeRoot, startFileServer } from "./helpers.ts";

const encoder = new TextEncoder();

test("Markdown is the default parser, a supplied map replaces it, and extension matching ignores case", async () => {
  const files = { "note.MD": "---\nstatus: open\n---\nBody\n", "plain.txt": "plain" };
  const defaultServer = await startFileServer(files);
  const defaultNote = await (await fetch(`${defaultServer.baseUrl}/note.MD?json`)).json() as Record<string, unknown>;
  assert.deepEqual(defaultNote.frontmatter, { status: "open" });
  assert.equal(defaultNote.body, "Body\n");
  const defaultPlain = await (await fetch(`${defaultServer.baseUrl}/plain.txt?json`)).json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(defaultPlain), ["path", "kind", "contentType", "size", "modified"]);

  const emptyMap = await startFileServer(files, { parsers: {} });
  const unparsedNote = await (await fetch(`${emptyMap.baseUrl}/note.MD?json`)).json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(unparsedNote), ["path", "kind", "contentType", "size", "modified"]);

  const customMap = await startFileServer(files, {
    parsers: { ".TXT": { parse: ({ bytes }: { bytes: Uint8Array }) => ({ text: new TextDecoder().decode(bytes) }) } },
  });
  const customPlain = await (await fetch(`${customMap.baseUrl}/plain.txt?json`)).json() as Record<string, unknown>;
  assert.equal(customPlain.text, "plain");
  const customNote = await (await fetch(`${customMap.baseUrl}/note.MD?json`)).json() as Record<string, unknown>;
  assert.equal("frontmatter" in customNote, false);
});

test("invalid parser keys and exports reject readiness", async (context) => {
  const root = await makeRoot();
  const validParser = { parse: () => ({ value: 1 }) };
  const invalidMaps: Array<Record<string, unknown>> = [
    { md: validParser },
    { ".": validParser },
    { ".two.dots": validParser },
    { "./slash": validParser },
    { ".back\\slash": validParser },
    { ".MD": validParser, ".md": validParser },
    { ".txt": {} },
    { ".txt": { parse: 1 } },
    { ".txt": { parse: validParser.parse, patch: 1 } },
  ];
  for (const parsers of invalidMaps) {
    const server = new FileServer({ root, parsers: parsers as never });
    context.after(() => server.close());
    await assert.rejects(server.ready, (error: unknown) => error instanceof Error, JSON.stringify(parsers));
  }
});

test("read-only parsers describe files but cannot accept structured mutations", async () => {
  const server = await startFileServer({ "item.ro": "original" }, {
    parsers: { ".ro": { parse: ({ bytes }: { bytes: Uint8Array }) => ({ value: new TextDecoder().decode(bytes) }) } },
  });
  const description = await (await fetch(`${server.baseUrl}/item.ro?json`)).json() as Record<string, unknown>;
  assert.equal(description.value, "original");
  const options = await fetch(`${server.baseUrl}/item.ro?json`, { method: "OPTIONS" });
  assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal(options.headers.get("accept-patch"), null);
  for (const method of ["PUT", "PATCH"] as const) {
    const response = await fetch(`${server.baseUrl}/item.ro?json`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal(response.headers.get("accept-patch"), null);
  }
  const byteWrite = await fetch(`${server.baseUrl}/item.ro`, { method: "PUT", body: "replacement" });
  assert.equal(byteWrite.status, 204);
});

test("parser parse and patch receive one object, accept promises, and preserve unchanged patch keys", async () => {
  const parseCalls: Array<{ path: string; bytes: Uint8Array }> = [];
  const patchCalls: Array<{ path: string; bytes?: Uint8Array; changes: Record<string, unknown> }> = [];
  const parser = {
    async parse(argument: { path: string; bytes: Uint8Array }) {
      parseCalls.push(argument);
      return { text: new TextDecoder().decode(argument.bytes) };
    },
    async patch(argument: { path: string; bytes?: Uint8Array; changes: Record<string, unknown> }) {
      patchCalls.push(argument);
      return encoder.encode(String(argument.changes.text));
    },
  };
  const server = await startFileServer({ "notes/item.foo": "before" }, { parsers: { ".foo": parser } });
  assert.equal((await fetch(`${server.baseUrl}/notes/item.foo?json`)).status, 200);
  assert.equal(parseCalls[0]?.path, "notes/item.foo");
  assert.equal(Buffer.from(parseCalls[0]?.bytes ?? []).toString(), "before");

  const response = await fetch(`${server.baseUrl}/notes/item.foo?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify({ text: "after", other: null }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { text: string }).text, "after");
  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0]?.path, "notes/item.foo");
  assert.equal(Buffer.from(patchCalls[0]?.bytes ?? []).toString(), "before");
  assert.deepEqual(patchCalls[0]?.changes, { text: "after", other: null });
  assert.equal((await readFile(`${server.root}/notes/item.foo`)).toString(), "after");

  const created = await fetch(`${server.baseUrl}/notes/new.foo?json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "ignored", kind: "ignored", size: 999, modified: "ignored", contentType: "ignored", text: "new" }),
  });
  assert.equal(created.status, 201);
  assert.equal(patchCalls.length, 2);
  assert.equal(patchCalls[1]?.path, "notes/new.foo");
  assert.equal(Object.hasOwn(patchCalls[1] ?? {}, "bytes"), false);
  assert.deepEqual(patchCalls[1]?.changes, { text: "new" });
});

test("parser failures fall back to a default description with parseError in reads and listings", async () => {
  const parser = {
    parse({ path }: { path: string }) {
      if (path === "throws.bad") throw new Error("broken parser");
      if (path === "array.bad") return [];
      if (path === "default-key.bad") return { size: 9 };
      return { parseError: "parser reserved this key" };
    },
  };
  const server = await startFileServer({
    "throws.bad": "one",
    "array.bad": "two",
    "default-key.bad": "three",
    "parse-error-key.bad": "four",
  }, { parsers: { ".bad": parser as never } });
  const listing = await (await fetch(`${server.baseUrl}/?json`)).json() as { entries: Array<Record<string, unknown>> };
  for (const entry of listing.entries) {
    assert.deepEqual(Object.keys(entry), ["path", "kind", "contentType", "size", "modified", "parseError"]);
    assert.equal(typeof entry.parseError, "string");
    assert.notEqual(entry.parseError, "");
    assert.deepEqual(await (await fetch(`${server.baseUrl}/${entry.path}?json`)).json(), entry);
  }
});

test("one parse per path and modification time serves both listings and file descriptions", async () => {
  const calls: Array<{ path: string; bytes: string }> = [];
  const parser = {
    async parse({ path, bytes }: { path: string; bytes: Uint8Array }) {
      const text = new TextDecoder().decode(bytes);
      calls.push({ path, bytes: text });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { text };
    },
  };
  const server = await startFileServer({ "one.cache": "first" }, { parsers: { ".cache": parser } });
  const [firstFileResponse, firstListingResponse] = await Promise.all([
    fetch(`${server.baseUrl}/one.cache?json`),
    fetch(`${server.baseUrl}/?json`),
  ]);
  const firstFile = await firstFileResponse.json();
  const firstListing = await firstListingResponse.json() as { entries: unknown[] };
  assert.deepEqual(firstListing.entries, [firstFile]);
  assert.deepEqual(calls, [{ path: "one.cache", bytes: "first" }]);
  assert.deepEqual(await (await fetch(`${server.baseUrl}/one.cache?json`)).json(), firstFile);
  assert.equal(calls.length, 1);

  await writeFile(`${server.root}/one.cache`, "second");
  const nextTime = new Date(Date.now() + 2_000);
  await utimes(`${server.root}/one.cache`, nextTime, nextTime);
  const secondFile = await (await fetch(`${server.baseUrl}/one.cache?json`)).json() as { text: string };
  assert.equal(secondFile.text, "second");
  assert.deepEqual((await (await fetch(`${server.baseUrl}/?json`)).json() as { entries: unknown[] }).entries, [secondFile]);
  assert.deepEqual(calls, [
    { path: "one.cache", bytes: "first" },
    { path: "one.cache", bytes: "second" },
  ]);
});

test("writable structured addresses advertise their methods and merge-patch media type", async () => {
  const server = await startFileServer({ "note.md": "Body\n", "plain.txt": "plain", "folder/child.txt": "child" });
  for (const path of ["note.md", "new.md"]) {
    const options = await fetch(`${server.baseUrl}/${path}?json`, { method: "OPTIONS" });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("allow"), "GET, HEAD, PUT, PATCH, OPTIONS");
    assert.equal(options.headers.get("access-control-allow-methods"), "GET, HEAD, PUT, PATCH, OPTIONS");
    assert.equal(options.headers.get("accept-patch"), "application/merge-patch+json");
  }
  const description = await fetch(`${server.baseUrl}/note.md?json`);
  assert.equal(description.headers.get("accept-patch"), "application/merge-patch+json");
  const refusedDelete = await fetch(`${server.baseUrl}/note.md?json`, { method: "DELETE" });
  assert.equal(refusedDelete.status, 405);
  assert.equal(refusedDelete.headers.get("allow"), "GET, HEAD, PUT, PATCH, OPTIONS");
  assert.equal(refusedDelete.headers.get("accept-patch"), "application/merge-patch+json");

  for (const path of ["plain.txt", "folder/"]) {
    const options = await fetch(`${server.baseUrl}/${path}?json`, { method: "OPTIONS" });
    assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal(options.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
    assert.equal(options.headers.get("accept-patch"), null);
  }
  const byteOptions = await fetch(`${server.baseUrl}/note.md`, { method: "OPTIONS" });
  assert.equal(byteOptions.headers.get("accept-patch"), "application/vnd.telepath.edit+json");
});

test("structured writes validate media types, object bodies, and protected fields", async () => {
  const server = await startFileServer({ "note.md": "Old\n" });
  const requests: Array<{ method: "PUT" | "PATCH"; headers?: Record<string, string>; body: string; status: number }> = [
    { method: "PUT", body: "{}", status: 415 },
    { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "{}", status: 415 },
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}", status: 415 },
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{", status: 400 },
    { method: "PATCH", headers: { "Content-Type": "application/merge-patch+json" }, body: "null", status: 400 },
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: "[]", status: 400 },
    { method: "PATCH", headers: { "Content-Type": "application/merge-patch+json" }, body: "[]", status: 400 },
    { method: "PATCH", headers: { "Content-Type": "application/merge-patch+json" }, body: '{"size":1}', status: 422 },
  ];
  for (const request of requests) {
    const response = await fetch(`${server.baseUrl}/note.md?json`, request);
    assert.equal(response.status, request.status, `${request.method}: ${request.body}`);
    assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
    assert.equal(await readFile(`${server.root}/note.md`, "utf8"), "Old\n");
  }
  const accepted = await fetch(`${server.baseUrl}/note.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "APPLICATION/MERGE-PATCH+JSON; charset=utf-8" },
    body: '{"body":"New\\n"}',
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as { body: string }).body, "New\n");
  assert.equal(accepted.headers.get("content-type"), "application/json; charset=utf-8");
});

test("structured write failures preserve the old file and emit no change signal", async (context) => {
  const parser = {
    parse({ bytes }: { bytes: Uint8Array }) {
      const text = new TextDecoder().decode(bytes);
      if (text === "cannot parse") throw new Error("bad candidate");
      return { text };
    },
    patch({ changes }: { changes: Record<string, unknown> }) {
      if (changes.text === "reject") throw new Error("specific rejection");
      if (changes.text === "invalid result") return "not bytes";
      return encoder.encode(String(changes.text));
    },
  };
  const server = await startFileServer({ "item.foo": "old" }, { parsers: { ".foo": parser as never } });
  const socket = await openSocket(server.baseUrl, "/");
  context.after(() => socket.close());
  for (const [text, status] of [["reject", 422], ["invalid result", 500], ["cannot parse", 500]] as const) {
    const response = await fetch(`${server.baseUrl}/item.foo?json`, {
      method: "PATCH",
      headers: { "Content-Type": "application/merge-patch+json" },
      body: JSON.stringify({ text }),
    });
    assert.equal(response.status, status, text);
    const error = (await response.json() as { error: string }).error;
    if (text === "reject") assert.equal(error, "specific rejection");
    else assert.equal(typeof error, "string");
    assert.equal(await readFile(`${server.root}/item.foo`, "utf8"), "old");
    assert.deepEqual(await readdir(server.root), ["item.foo"]);
  }
  const failedPut = await fetch(`${server.baseUrl}/item.foo?json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: '{"text":"cannot parse"}',
  });
  assert.equal(failedPut.status, 500);
  assert.equal(await readFile(`${server.root}/item.foo`, "utf8"), "old");
  assert.deepEqual(await readdir(server.root), ["item.foo"]);
  await expectNoEvent(socket);
});

test("structured body, source, and output limits reject without writing", async () => {
  const maximum = 16_777_216;
  const parser = {
    parse: () => ({ value: true }),
    patch: () => new Uint8Array(maximum + 1),
  };
  const server = await startFileServer({ "large.md": new Uint8Array(maximum + 1).fill(0x61), "small.foo": "old" }, {
    parsers: { ".foo": parser, ".md": { parse: () => ({ value: true }), patch: () => encoder.encode("new") } },
  });
  const oversizedBody = await fetch(`${server.baseUrl}/small.foo?json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "a".repeat(maximum) }),
  });
  assert.equal(oversizedBody.status, 413);
  const oversizedOutput = await fetch(`${server.baseUrl}/small.foo?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: '{"value":true}',
  });
  assert.equal(oversizedOutput.status, 413);
  const oversizedSource = await fetch(`${server.baseUrl}/large.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: '{"value":true}',
  });
  assert.equal(oversizedSource.status, 415);
  assert.equal(await readFile(`${server.root}/small.foo`, "utf8"), "old");
});

test("Markdown descriptions preserve valid, absent, empty, and malformed frontmatter", async () => {
  const contents: Record<string, string> = {
    "valid.md": "---\r\nstatus: open\r\nitems:\r\n  - one\r\n---\r\nBody\r\n",
    "absent.md": "No header\n\n",
    "empty.md": "---\n---\n",
    "unclosed.md": "---\ntitle: Draft\nBody\n",
    "invalid-yaml.md": "---\nitems: [one\n---\nBody\n",
    "scalar.md": "---\nhello\n---\nBody\n",
  };
  const server = await startFileServer(contents);
  const listing = await (await fetch(`${server.baseUrl}/?json`)).json() as { entries: Array<Record<string, unknown>> };
  for (const [path, source] of Object.entries(contents)) {
    const description = await (await fetch(`${server.baseUrl}/${path}?json`)).json() as Record<string, unknown>;
    assert.deepEqual(listing.entries.find((entry) => entry.path === path), description);
    assert.equal(await (await fetch(`${server.baseUrl}/${path}`)).text(), source);
    assert.equal(description.path, path);
    assert.equal(description.kind, "file");
    assert.equal(description.contentType, "text/markdown; charset=utf-8");
  }
  const byPath = Object.fromEntries(listing.entries.map((entry) => [String(entry.path), entry]));
  assert.deepEqual(byPath["valid.md"]?.frontmatter, { status: "open", items: ["one"] });
  assert.equal(byPath["valid.md"]?.body, "Body\r\n");
  assert.equal("frontmatterError" in (byPath["valid.md"] ?? {}), false);
  assert.deepEqual(byPath["absent.md"]?.frontmatter, {});
  assert.equal(byPath["absent.md"]?.body, "No header\n\n");
  assert.deepEqual(byPath["empty.md"]?.frontmatter, {});
  assert.equal(byPath["empty.md"]?.body, "");
  for (const path of ["unclosed.md", "invalid-yaml.md", "scalar.md"]) {
    assert.deepEqual(byPath[path]?.frontmatter, {}, path);
    assert.equal(byPath[path]?.body, contents[path], path);
    assert.equal(typeof byPath[path]?.frontmatterError, "string", path);
    assert.notEqual(byPath[path]?.frontmatterError, "", path);
  }
});

test("invalid UTF-8 Markdown gives parseError in descriptions, 422 on a structured patch, and 200 on an empty one", async () => {
  const invalidBytes = Buffer.from([0x66, 0x80, 0x6f]);
  const server = await startFileServer({ "broken.md": invalidBytes });
  const description = await (await fetch(`${server.baseUrl}/broken.md?json`)).json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(description), ["path", "kind", "contentType", "size", "modified", "parseError"]);
  assert.equal(typeof description.parseError, "string");
  const listing = await (await fetch(`${server.baseUrl}/?json`)).json() as { entries: unknown[] };
  assert.deepEqual(listing.entries, [description]);
  const response = await fetch(`${server.baseUrl}/broken.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: '{"body":"fixed"}',
  });
  assert.equal(response.status, 422);
  assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
  assert.deepEqual(await readFile(`${server.root}/broken.md`), invalidBytes);
  const empty = await fetch(`${server.baseUrl}/broken.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: "{}",
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), description);
  assert.deepEqual(await readFile(`${server.root}/broken.md`), invalidBytes);
});

test("Markdown merge patches remove null-valued keys, replace arrays, and preserve untouched YAML details", async () => {
  const original = "---\nstatus: open # Removed with this key\nlist:\n  - one\n# Keep this comment\nkeep: 'quoted'\nnested:\n  first: 1\n  second: 2\n---\nOld body.\n";
  const server = await startFileServer({ "note.md": original });
  const response = await fetch(`${server.baseUrl}/note.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify({
      frontmatter: { status: null, list: ["two", "three"], nested: { second: null, third: 3 } },
      body: "New body.\n",
    }),
  });
  assert.equal(response.status, 200);
  const description = await response.json() as Record<string, unknown>;
  assert.deepEqual(description.frontmatter, {
    list: ["two", "three"],
    keep: "quoted",
    nested: { first: 1, third: 3 },
  });
  assert.equal(description.body, "New body.\n");
  const written = await readFile(`${server.root}/note.md`, "utf8");
  assert.match(written, /# Keep this comment/);
  assert.match(written, /keep: 'quoted'/);
  assert.ok(written.indexOf("list:") < written.indexOf("keep:"));
  assert.ok(written.indexOf("keep:") < written.indexOf("nested:"));
  assert.equal(written.endsWith("---\nNew body.\n"), true);

  const bodyOnly = await fetch(`${server.baseUrl}/note.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: '{"body":"Only body changed"}',
  });
  assert.equal(bodyOnly.status, 200);
  assert.deepEqual((await bodyOnly.json() as { frontmatter: unknown }).frontmatter, description.frontmatter);
});

test("Markdown PATCH and PUT distinguish null values even for an empty existing file", async () => {
  const server = await startFileServer({ "empty.md": "", "full.md": "---\ntitle: X\n---\nBody\n" });
  const emptyPatch = await fetch(`${server.baseUrl}/empty.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: '{"frontmatter":null,"body":null}',
  });
  assert.equal(emptyPatch.status, 200);
  assert.deepEqual((await emptyPatch.json() as { frontmatter: unknown; body: string }).frontmatter, {});
  assert.equal(await readFile(`${server.root}/empty.md`, "utf8"), "");

  const removeAll = await fetch(`${server.baseUrl}/full.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: '{"frontmatter":null,"body":null}',
  });
  assert.equal(removeAll.status, 200);
  assert.equal(await readFile(`${server.root}/full.md`, "utf8"), "");
  for (const changes of [{ frontmatter: null }, { body: null }]) {
    const refused = await fetch(`${server.baseUrl}/empty.md?json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    assert.equal(refused.status, 422);
    assert.equal(typeof (await refused.json() as { error: unknown }).error, "string");
  }
});

test("Markdown PUT builds complete files, defaults omitted fields, and ignores frontmatterError", async () => {
  const server = await startFileServer({ "broken.md": "---\nno closing\n" });
  const malformed = await (await fetch(`${server.baseUrl}/broken.md?json`)).json() as Record<string, unknown>;
  assert.equal(typeof malformed.frontmatterError, "string");
  const repaired = await fetch(`${server.baseUrl}/broken.md?json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...malformed, frontmatter: { title: "Repaired" }, body: "Done\n" }),
  });
  assert.equal(repaired.status, 200);
  const repairedDescription = await repaired.json() as Record<string, unknown>;
  assert.deepEqual(repairedDescription.frontmatter, { title: "Repaired" });
  assert.equal(repairedDescription.body, "Done\n");
  assert.equal("frontmatterError" in repairedDescription, false);

  const created = await fetch(`${server.baseUrl}/nested/new.md?json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: '{"frontmatter":{"title":"New"},"body":"Text\\n"}',
  });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json() as { frontmatter: unknown }).frontmatter, { title: "New" });
  assert.equal((await readFile(`${server.root}/nested/new.md`, "utf8")).endsWith("---\nText\n"), true);

  const omitted = await fetch(`${server.baseUrl}/omitted.md?json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(omitted.status, 201);
  const omittedDescription = await omitted.json() as { frontmatter: unknown; body: string };
  assert.deepEqual(omittedDescription.frontmatter, {});
  assert.equal(omittedDescription.body, "");
  assert.equal(await readFile(`${server.root}/omitted.md`, "utf8"), "");
});

test("Markdown rejects unknown and malformed writable fields without changing the file", async () => {
  const server = await startFileServer({ "note.md": "Original\n" });
  const changes: Array<{ method: "PUT" | "PATCH"; body: Record<string, unknown> }> = [
    { method: "PATCH", body: { mystery: true } },
    { method: "PATCH", body: { frontmatterError: "ignored only on PUT" } },
    { method: "PATCH", body: { frontmatter: [] } },
    { method: "PATCH", body: { body: 1 } },
    { method: "PUT", body: { mystery: true } },
    { method: "PUT", body: { frontmatter: [] } },
    { method: "PUT", body: { body: 1 } },
  ];
  for (const change of changes) {
    const response = await fetch(`${server.baseUrl}/note.md?json`, {
      method: change.method,
      headers: { "Content-Type": change.method === "PUT" ? "application/json" : "application/merge-patch+json" },
      body: JSON.stringify(change.body),
    });
    assert.equal(response.status, 422, JSON.stringify(change));
    assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
    assert.equal(await readFile(`${server.root}/note.md`, "utf8"), "Original\n");
  }
});

test("Markdown PATCH repairs malformed frontmatter using the described empty map and whole body", async () => {
  const server = await startFileServer({ "broken.md": "---\nmissing closing\n" });
  const response = await fetch(`${server.baseUrl}/broken.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: '{"frontmatter":{"fixed":true},"body":"Replaced body\\n"}',
  });
  assert.equal(response.status, 200);
  const description = await response.json() as Record<string, unknown>;
  assert.deepEqual(description.frontmatter, { fixed: true });
  assert.equal(description.body, "Replaced body\n");
  assert.equal("frontmatterError" in description, false);
});

test("an empty structured patch preserves the file and emits no signal; writes emit one change", async (context) => {
  const server = await startFileServer({ "note.md": "Old\n" });
  const socket = await openSocket(server.baseUrl, "/");
  context.after(() => socket.close());
  const before = await stat(`${server.root}/note.md`);
  const current = await (await fetch(`${server.baseUrl}/note.md?json`)).json();

  const empty = await fetch(`${server.baseUrl}/note.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: "{}",
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), current);
  assert.equal((await stat(`${server.root}/note.md`)).mtimeMs, before.mtimeMs);
  await expectNoEvent(socket);

  let event = nextEvent(socket);
  const changed = await fetch(`${server.baseUrl}/note.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: '{"body":"Changed\\n"}',
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(await event, { type: "modified", path: "note.md" });
  await expectNoEvent(socket);

  event = nextEvent(socket);
  const created = await fetch(`${server.baseUrl}/new.md?json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: '{"body":"Created\\n"}',
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await event, { type: "created", path: "new.md" });
  await expectNoEvent(socket);

  event = nextEvent(socket);
  const replaced = await fetch(`${server.baseUrl}/new.md?json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: '{"body":"Replaced\\n"}',
  });
  assert.equal(replaced.status, 200);
  assert.equal((await replaced.json() as { body: string }).body, "Replaced\n");
  assert.deepEqual(await event, { type: "modified", path: "new.md" });
  await expectNoEvent(socket);
});

test("structured patch rejects a missing writable file and create-only PUT rejects an existing one first", async () => {
  const server = await startFileServer({ "present.md": "Original\n" });
  const missing = await fetch(`${server.baseUrl}/missing.md?json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: '{"body":"New"}',
  });
  assert.equal(missing.status, 404);
  const refused = await fetch(`${server.baseUrl}/present.md?json`, {
    method: "PUT",
    headers: { "If-None-Match": "*", "Content-Type": "text/plain" },
    body: "invalid structured body",
  });
  assert.equal(refused.status, 412, "the create-only check precedes body validation");
  assert.equal(await readFile(`${server.root}/present.md`, "utf8"), "Original\n");
});

test("two structured create-only PUTs cannot replace one another at commit", async () => {
  let entered = 0;
  let release: (() => void) | undefined;
  const bothEntered = new Promise<void>((resolve) => { release = resolve; });
  const parser = {
    parse: ({ bytes }: { bytes: Uint8Array }) => ({ text: new TextDecoder().decode(bytes) }),
    async patch({ changes }: { changes: Record<string, unknown> }) {
      entered += 1;
      if (entered === 2) release?.();
      await bothEntered;
      return encoder.encode(String(changes.text));
    },
  };
  const server = await startFileServer({}, { parsers: { ".foo": parser } });
  // If requests are inadvertently serialized, release the first after a
  // short wait so this test reports the missing overlap instead of hanging.
  const fallback = setTimeout(() => release?.(), 1_000);
  try {
    const responses = await Promise.all(["first", "second"].map((text) => fetch(`${server.baseUrl}/race.foo?json`, {
      method: "PUT",
      headers: { "If-None-Match": "*", "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })));
    assert.equal(entered, 2);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 412]);
    assert.ok(["first", "second"].includes(await readFile(`${server.root}/race.foo`, "utf8")));
    assert.deepEqual(await readdir(server.root), ["race.foo"]);
  } finally {
    clearTimeout(fallback);
  }
});
