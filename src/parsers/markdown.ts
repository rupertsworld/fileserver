/** Parse Markdown frontmatter and edit it without discarding untouched YAML nodes. */
import { Document, isMap, parseDocument, YAMLMap, type Node } from "yaml";

import type { FileParser } from "../server.ts";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type MarkdownDocument = {
  frontmatter: Record<string, JsonValue>;
  body: string;
  document: Document;
  frontmatterError?: string;
};

/** Add Markdown frontmatter and body fields to a file description. */
export const parse: FileParser["parse"] = ({ bytes }) => {
  const markdown = readMarkdown(bytes);
  return {
    frontmatter: markdown.frontmatter,
    body: markdown.body,
    ...(markdown.frontmatterError === undefined ? {} : { frontmatterError: markdown.frontmatterError }),
  };
};

/** Apply a merge patch to an existing Markdown file, or build one for PUT. */
export const patch: NonNullable<FileParser["patch"]> = ({ bytes, changes }) => {
  // An existing empty file still supplies bytes. Only their absence selects
  // whole-file PUT rules, where null fields are invalid rather than removals.
  if (bytes === undefined) return buildMarkdown(changes);
  const markdown = readMarkdown(bytes);
  for (const key of Object.keys(changes)) {
    if (key !== "frontmatter" && key !== "body") throw new Error(`${key} cannot be changed`);
  }
  if (Object.hasOwn(changes, "frontmatter")) {
    const value = changes.frontmatter;
    if (value !== null && !isObject(value)) throw new Error("frontmatter must be an object or null");
    if (value === null) markdown.document.contents = new YAMLMap();
    else mergeMap(markdown.document.contents as YAMLMap, value);
  }
  if (Object.hasOwn(changes, "body")) {
    const value = changes.body;
    if (value !== null && typeof value !== "string") throw new Error("body must be a string or null");
    markdown.body = value ?? "";
  }
  return renderMarkdown(markdown.document, markdown.body);
};

function buildMarkdown(changes: JsonObject): Uint8Array {
  for (const key of Object.keys(changes)) {
    if (key !== "frontmatter" && key !== "body" && key !== "frontmatterError") {
      throw new Error(`${key} cannot be changed`);
    }
  }
  const frontmatter = changes.frontmatter ?? {};
  const body = changes.body ?? "";
  if (!isObject(frontmatter) || changes.frontmatter === null) throw new Error("frontmatter must be an object");
  if (typeof body !== "string" || changes.body === null) throw new Error("body must be a string");
  return renderMarkdown(new Document(frontmatter), body);
}

function readMarkdown(bytes: Uint8Array): MarkdownDocument {
  const source = decoder.decode(bytes);
  const opening = /^---(?:\r?\n|$)/.exec(source);
  if (opening === null) return { frontmatter: {}, body: source, document: new Document({}) };

  const headerStart = opening[0].length;
  const closing = /^---(?:\r?\n|$)/gm;
  closing.lastIndex = headerStart;
  const match = closing.exec(source);
  if (match === null) return malformed(source);

  const header = source.slice(headerStart, match.index);
  const body = source.slice(match.index + match[0].length);
  const document = parseDocument(header) as Document;
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents))) return malformed(source);
  if (document.contents === null) document.contents = new YAMLMap();
  try {
    const frontmatter = document.toJSON() as unknown;
    if (!isObject(frontmatter)) return malformed(source);
    return { frontmatter: frontmatter as Record<string, JsonValue>, body, document };
  } catch {
    return malformed(source);
  }
}

function malformed(source: string): MarkdownDocument {
  return {
    frontmatter: {},
    body: source,
    document: new Document({}),
    frontmatterError: "frontmatter could not be parsed",
  };
}

function mergeMap(target: YAMLMap, changes: JsonObject): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      target.delete(key);
      continue;
    }
    const existing = target.get(key, true) as Node | undefined;
    if (isObject(value) && isMap(existing)) mergeMap(existing, value);
    else target.set(key, value);
  }
}

function renderMarkdown(document: Document, body: string): Uint8Array {
  if (!isMap(document.contents) || document.contents.items.length === 0) return encoder.encode(body);
  return encoder.encode(`---\n${document.toString()}---\n${body}`);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
