import { randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink, utimes, type FileHandle } from "node:fs/promises";
import { createServer, STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { Readable, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import express, { type Request, type Response } from "express";
import mimeTypes from "mime-types";
import { WebSocket, WebSocketServer } from "ws";

import { IgnorePatterns } from "./ignore.ts";
import * as markdown from "./parsers/markdown.ts";

const supportedMethods = new Set(["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const byteAllowedMethods = "GET, HEAD, PUT, DELETE, OPTIONS";
const allowedRequestHeaders = "Content-Type, Range, If-None-Match, If-Modified-Since, If-Range";
const exposedResponseHeaders = "ETag, Accept-Ranges, Content-Range, Accept-Patch, Link";
const mergePatchContentType = "application/merge-patch+json";
const jsonContentType = "application/json; charset=utf-8";
const maximumStructuredBytes = 16_777_216;
const defaultFileKeys = new Set(["path", "kind", "contentType", "size", "modified"]);
const readOnlyJsonMethods = "GET, HEAD, OPTIONS";
const writableJsonMethods = "GET, HEAD, PUT, PATCH, OPTIONS";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const watcherDebounceMs = 50;
const watcherSuppressionMs = 1_000;
const defaultPortRangeWidth = 100;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A format-specific reader and optional writer for JSON file descriptions. */
export type FileParser = {
  parse(input: { path: string; bytes: Uint8Array }): Record<string, JsonValue> | Promise<Record<string, JsonValue>>;
  patch?(input: { path: string; bytes?: Uint8Array; changes: Record<string, JsonValue> }): Uint8Array | Promise<Uint8Array>;
};

/** One addressable item in a one-level directory listing. */
export type DirectoryEntry = {
  path: string;
  kind: string;
  [property: string]: JsonValue;
};
/** A JSON description of a directory and its immediate children. */
export type DirectoryListing = { path: string; kind: "dir"; entries: DirectoryEntry[] };
export type FileChangeEvent = { type: "created" | "modified" | "deleted"; path: string };
export type FileServerResource =
  | { readonly type: "missing" }
  | { readonly type: "dir" }
  | { readonly type: "symlink" }
  | { readonly type: "file"; readonly size: number; readonly modified: string };
export type FileServerExtensionContext = {
  readonly path: string;
  readonly segments: readonly string[];
  readonly trailingSlash: boolean;
  readonly resource: Readonly<FileServerResource>;
  readonly inspect: (path: string) => Promise<FileServerResource>;
  readonly list: (path: string) => Promise<DirectoryListing>;
  readonly replace: (path: string, bytes: Uint8Array | Readable) => Promise<"created" | "replaced">;
  readonly remove: (path: string) => Promise<void>;
};
export type FileServerExtension = {
  handle?(request: Request, response: Response, context: FileServerExtensionContext): boolean | Promise<boolean>;
  listing?(
    request: Request,
    listing: DirectoryListing,
    context: FileServerExtensionContext,
  ): DirectoryListing | Promise<DirectoryListing>;
  change?(event: FileChangeEvent): FileChangeEvent | null | Promise<FileChangeEvent | null>;
};
export type FileServerOptions = {
  root: string;
  defaultPort?: number;
  pingIntervalMs?: number;
  /** Patterns in .gitignore syntax; matching paths are hidden exactly like dot-prefixed ones (spec/cli.md#config). */
  ignore?: readonly string[];
  /** Extension-to-parser map; omitted selects the built-in Markdown parser. */
  parsers?: Record<string, FileParser>;
  extension?: FileServerExtension;
};
export type ListenOptions = { host?: string; port?: number };

type ListenState = "new" | "starting" | "listening" | "closed";
type ParsedPath = { segments: string[]; path: string; trailingSlash: boolean };
type InspectedPath = {
  absolutePath: string;
  deepestExistingPath: string;
  missing: boolean;
  stats?: Stats;
};
type ByteRange = { kind: "range"; start: number; end: number } | { kind: "unsatisfiable" } | { kind: "full" };
type PendingWatcherEvent = { event: FileChangeEvent; timer: ReturnType<typeof setTimeout> };
type SuppressedWatcherEvent = {
  event: FileChangeEvent;
  fingerprint?: string;
  timer: ReturnType<typeof setTimeout>;
};
type SuppressedDeletedSubtree = {
  recreatedPaths: Set<string>;
  timer: ReturnType<typeof setTimeout>;
};
type SocketSubscription = { isAlive: boolean };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Serves one filesystem directory over HTTP with a root-wide WebSocket change stream. */
export class FileServer {
  readonly app: express.Express;
  readonly server: Server;
  readonly ready: Promise<void>;

  private resolvedRoot: string | undefined;
  private boundHost: string | undefined;
  private listenState: ListenState = "new";
  private listenCompletion: Promise<void> | undefined;
  private closeCompletion: Promise<void> | undefined;
  private readonly temporaryPaths = new Set<string>();
  private readonly extension: FileServerExtension | undefined;
  private parsers = new Map<string, FileParser>();
  private readonly parsedFileCache = new Map<string, { modifiedMs: number; fields: Promise<Record<string, JsonValue>> }>();
  private readonly defaultPort: number;
  private readonly ignorePatterns: IgnorePatterns;
  private watcher: FSWatcher | undefined;
  private watcherIsReady = false;
  private isClosing = false;
  private backgroundServicesStop: Promise<void> | undefined;
  private readonly webSockets = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<WebSocket, SocketSubscription>();
  private readonly pendingWatcherEvents = new Map<string, PendingWatcherEvent>();
  private readonly suppressedWatcherEvents = new Map<string, SuppressedWatcherEvent>();
  private readonly suppressedDeletedSubtrees = new Map<string, SuppressedDeletedSubtree>();
  private readonly pingTimer: ReturnType<typeof setInterval>;

  constructor({ root, defaultPort = 8765, pingIntervalMs = 30_000, ignore = [], parsers, extension }: FileServerOptions) {
    this.extension = extension;
    this.defaultPort = defaultPort;
    this.ignorePatterns = new IgnorePatterns(ignore);
    this.app = express();
    this.app.disable("x-powered-by");
    this.ready = this.initialize(root, parsers);
    void this.ready.catch(() => {});
    this.app.use(async (request, response) => {
      setCommonCorsHeaders(response);
      try {
        await this.ready;
        await this.handleRequest(request, response);
      } catch (error) {
        if (!response.headersSent) sendMappedError(request, response, error);
        else response.destroy();
      }
    });
    this.server = createServer(this.app);
    this.server.on("connect", (request, socket) => { void this.handleConnect(request, socket); });
    this.server.on("upgrade", (request, socket, head) => { void this.handleUpgrade(request, socket, head); });
    this.pingTimer = setInterval(() => {
      for (const [socket, subscription] of this.sockets) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (!subscription.isAlive) { socket.terminate(); continue; }
        subscription.isAlive = false;
        socket.ping();
      }
    }, pingIntervalMs);
    this.pingTimer.unref();
  }

  /** The URL currently bound, or undefined before listening and after closing. */
  get url(): string | undefined {
    const port = this.port;
    if (port === undefined || this.boundHost === undefined) return undefined;
    const host = this.boundHost.includes(":") && !this.boundHost.startsWith("[") ? `[${this.boundHost}]` : this.boundHost;
    return `http://${host}:${port}`;
  }

  /** The port currently bound, including an operating-system-selected port. */
  get port(): number | undefined {
    const address = this.server.address();
    return address !== null && typeof address === "object" ? address.port : undefined;
  }

  private async initialize(root: string, parserOptions: Record<string, FileParser> | undefined): Promise<void> {
    this.parsers = validateParsers(parserOptions ?? { ".md": markdown });
    const resolvedRoot = await resolveRoot(root);
    this.resolvedRoot = resolvedRoot;
    // Chokidar never watches a path this callback returns true for, and never
    // descends into such a directory. Hidden paths, ignored ones included, are
    // pruned here rather than filtered out of events, so a large ignored tree
    // such as node_modules costs the watcher nothing, and an event can only
    // come from a path that was visible when it was watched; flushWatcherEvent
    // handles one that has since become hidden. Chokidar sometimes asks before
    // it has stats; the path is then judged as a file, which is safe because
    // it asks again with stats before it watches or reads a directory.
    const watcher = chokidar.watch(resolvedRoot, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (path, stats) => isHiddenWatcherPath(resolvedRoot, path)
        || this.ignorePatterns.hides(rootRelativePath(resolvedRoot, path), stats?.isDirectory() === true)
        || stats?.isSymbolicLink() === true
        || (stats !== undefined && !stats.isFile() && !stats.isDirectory()),
    });
    this.watcher = watcher;
    watcher.on("add", (path) => this.handleWatcherChange("created", path));
    watcher.on("addDir", (path) => this.handleWatcherChange("created", path));
    watcher.on("change", (path) => this.handleWatcherChange("modified", path));
    watcher.on("unlink", (path) => this.handleWatcherChange("deleted", path));
    watcher.on("unlinkDir", (path) => this.handleWatcherChange("deleted", path));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      watcher.once("ready", () => { settled = true; this.watcherIsReady = true; resolve(); });
      watcher.on("error", (error) => {
        if (!settled) reject(error);
        else console.error("fileserver watcher error", error);
      });
    });
  }

  /** Starts accepting connections once the configured root is ready. */
  async listen(options: ListenOptions = {}): Promise<this> {
    if (this.listenState !== "new") throw new Error("this FileServer cannot listen again; make a new instance");
    this.listenState = "starting";
    const host = options.host ?? "127.0.0.1";
    const firstPort = options.port ?? this.defaultPort;
    const attempts = options.port === undefined ? defaultPortRangeWidth : 1;
    const completion = (async () => {
      await this.ready;
      for (let offset = 0; offset < attempts; offset += 1) {
        const port = firstPort + offset;
        try {
          await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
              this.server.removeListener("listening", onListening);
              reject(error);
            };
            const onListening = (): void => {
              this.server.removeListener("error", onError);
              resolve();
            };
            this.server.once("error", onError);
            this.server.once("listening", onListening);
            this.server.listen(port, host);
          });
          break;
        } catch (error) {
          if (!hasErrorCode(error, "EADDRINUSE")) throw error;
          if (offset === attempts - 1) {
            if (options.port !== undefined) throw error;
            throw Object.assign(new Error(`ports ${firstPort}-${firstPort + attempts - 1} are already in use`), {
              code: "EADDRINUSE",
            });
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    })();
    this.listenCompletion = completion;
    try {
      await completion;
    } catch (error) {
      this.listenState = "closed";
      await this.stopBackgroundServices();
      throw error;
    }
    this.boundHost = host;
    this.listenState = "listening";
    return this;
  }

  /** Releases the listening socket. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.listenState === "closed") return this.closeCompletion ?? this.backgroundServicesStop;
    if (this.closeCompletion !== undefined) return this.closeCompletion;
    const stateAtClose = this.listenState;
    if (stateAtClose === "new") this.listenState = "closed";
    this.isClosing = true;
    this.closeCompletion = (async () => {
      try {
        if (stateAtClose === "new") await this.ready;
        else await this.listenCompletion;
      } catch { /* Initialization and failed listens may still have resources to release. */ }
      await this.stopBackgroundServices();
      if (this.server.listening) {
        await new Promise<void>((resolve, reject) => {
          this.server.close((error) => error ? reject(error) : resolve());
        });
      }
      this.boundHost = undefined;
      this.listenState = "closed";
    })();
    return this.closeCompletion;
  }

  private async stopBackgroundServices(): Promise<void> {
    if (this.backgroundServicesStop === undefined) {
      this.backgroundServicesStop = (async () => {
        this.isClosing = true;
        clearInterval(this.pingTimer);
        for (const pending of this.pendingWatcherEvents.values()) clearTimeout(pending.timer);
        this.pendingWatcherEvents.clear();
        for (const suppressed of this.suppressedWatcherEvents.values()) clearTimeout(suppressed.timer);
        this.suppressedWatcherEvents.clear();
        for (const suppressed of this.suppressedDeletedSubtrees.values()) clearTimeout(suppressed.timer);
        this.suppressedDeletedSubtrees.clear();
        for (const socket of this.sockets.keys()) socket.terminate();
        this.sockets.clear();
        if (this.watcher !== undefined) await this.watcher.close();
        this.webSockets.close();
      })();
    }
    await this.backgroundServicesStop;
  }

  private async handleRequest(request: Request, response: Response): Promise<void> {
    const parsed = parseRequestPath(request.url);
    if (parsed instanceof HttpError) { sendError(request, response, parsed.status, parsed.message); return; }
    if (await this.isIgnoredPath(parsed)) { sendError(request, response, 404, "not found"); return; }
    const root = this.resolvedRoot as string;
    const inspected = await inspectPath(root, parsed.segments);
    const wantsJson = hasJsonQuery(request.url);
    const parser = this.parserFor(parsed.path);
    const writableJson = wantsJson && !parsed.trailingSlash
      && (inspected.missing || inspected.stats?.isFile() === true)
      && parser?.patch !== undefined;
    const methods = wantsJson ? (writableJson ? writableJsonMethods : readOnlyJsonMethods) : byteAllowedMethods;

    // An exact link has one safe representation. All other requests must be
    // refused before method dispatch, including OPTIONS and unknown methods.
    if (inspected.stats?.isSymbolicLink()
      && !(wantsJson && !parsed.trailingSlash && (request.method === "GET" || request.method === "HEAD"))) {
      sendError(request, response, 403, "forbidden");
      return;
    }

    if (wantsJson) {
      response.set("Allow", methods);
      if (writableJson) response.set("Accept-Patch", mergePatchContentType);
    }

    if (!isSupportedMethod(request.method)) {
      response.set("Allow", methods);
      sendError(request, response, 405, "method not allowed");
      return;
    }
    if (request.method === "OPTIONS") { sendOptions(response, request, methods); return; }

    await ensureConfined(root, inspected.deepestExistingPath);
    if (this.temporaryPaths.has(inspected.absolutePath)) { sendError(request, response, 404, "not found"); return; }
    if (!wantsJson && request.method === "PATCH") {
      response.set("Allow", byteAllowedMethods);
      sendError(request, response, 405, "method not allowed");
      return;
    }
    if (wantsJson && (request.method === "DELETE" || ((request.method === "PUT" || request.method === "PATCH") && !writableJson))) {
      sendError(request, response, 405, "method not allowed");
      return;
    }
    const extensionContext = this.createExtensionContext(parsed, inspected);
    if (this.extension?.handle !== undefined && await runHandleHook(this.extension.handle, request, response, extensionContext)) return;
    if (wantsJson && request.method === "PUT") { await this.putJson(request, response, parsed, inspected, parser as FileParser); return; }
    if (wantsJson && request.method === "PATCH") { await this.patchJson(request, response, parsed, inspected, parser as FileParser); return; }
    if (request.method === "PUT") { await this.put(request, response, parsed, inspected); return; }
    if (request.method === "DELETE") { await this.delete(request, response, parsed, inspected); return; }
    if (inspected.missing || inspected.stats === undefined) {
      sendError(request, response, 404, "not found");
      return;
    }
    if (inspected.stats.isSymbolicLink()) {
      sendJsonDescription(request, response, { path: parsed.path, kind: "symlink" });
      return;
    }
    if (inspected.stats.isFile()) {
      if (parsed.trailingSlash) { sendError(request, response, 404, "not found"); return; }
      if (wantsJson) {
        sendJsonDescription(request, response, await this.describeFile(parsed.path, inspected.absolutePath, inspected.stats));
        return;
      }
      await sendFile(request, response, inspected.absolutePath);
      return;
    }
    if (inspected.stats.isDirectory()) {
      if (wantsJson) {
        let listing = await this.listDirectory(inspected.absolutePath, parsed.path);
        if (this.extension?.listing !== undefined) {
          try { listing = await this.extension.listing(request, listing, extensionContext); }
          catch (error) { throw mapExtensionHookError(error); }
        }
        if (!isDirectoryListing(listing, parsed.path)) throw new Error("extension returned an invalid directory listing");
        sendJsonDescription(request, response, listing);
        return;
      }
      if (!parsed.trailingSlash) {
        const name = parsed.segments.at(-1) as string;
        const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
        response.set("Location", `${encodeURIComponent(name)}/${query}`);
        response.status(307).end();
        return;
      }
      await this.sendDirectoryIndex(request, response, parsed);
      return;
    }
    sendError(request, response, 404, "not found");
  }

  private parserFor(path: string): FileParser | undefined {
    return this.parsers.get(extname(path).toLowerCase());
  }

  private async describeFile(path: string, absolutePath: string, stats: Stats): Promise<DirectoryEntry> {
    const defaults = fileDescription(path, absolutePath, stats);
    const parser = this.parserFor(path);
    if (parser === undefined) return defaults;
    let cached = this.parsedFileCache.get(path);
    if (cached === undefined || cached.modifiedMs !== stats.mtimeMs) {
      const fields = (async () => {
        const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { return await parseFields(parser, path, await handle.readFile()); }
        finally { await handle.close().catch(() => undefined); }
      })();
      cached = { modifiedMs: stats.mtimeMs, fields };
      this.parsedFileCache.set(path, cached);
    }
    return { ...defaults, ...await cached.fields };
  }

  private async listDirectory(absolutePath: string, path: string): Promise<DirectoryListing> {
    return readDirectoryListing(absolutePath, path, this.temporaryPaths, this.ignorePatterns,
      (entryPath, entryAbsolutePath, stats) => this.describeFile(entryPath, entryAbsolutePath, stats));
  }

  private async sendDirectoryIndex(request: Request, response: Response, directory: ParsedPath): Promise<void> {
    const segments = [...directory.segments, "index.html"];
    const parsed: ParsedPath = { segments, path: segments.join("/"), trailingSlash: false };
    const missingIndex = (): void => sendError(request, response, 404, "add ?json to list the directory");
    if (await this.isIgnoredPath(parsed)) { missingIndex(); return; }
    const inspected = await inspectPath(this.resolvedRoot as string, segments);
    if (inspected.stats?.isSymbolicLink()) { sendError(request, response, 403, "forbidden"); return; }
    await ensureConfined(this.resolvedRoot as string, inspected.deepestExistingPath);
    if (this.temporaryPaths.has(inspected.absolutePath) || inspected.missing || inspected.stats?.isFile() !== true) {
      missingIndex();
      return;
    }
    await sendFile(request, response, inspected.absolutePath);
  }

  private async put(request: Request, response: Response, parsed: ParsedPath, inspected: InspectedPath): Promise<void> {
    if (parsed.trailingSlash) { sendError(request, response, 409, "cannot write a directory path"); return; }
    if (inspected.stats?.isDirectory()) { sendError(request, response, 409, "cannot replace a directory"); return; }
    const createOnly = request.get("If-None-Match")?.trim() === "*";
    if (createOnly && !inspected.missing) { sendError(request, response, 412, "file already exists"); return; }
    const result = await this.replacePath(
      inspected.absolutePath,
      inspected.stats,
      parsed.path,
      request,
      createOnly,
    );
    response.status(result.result === "created" ? 201 : 204).end();
  }

  private async putJson(request: Request, response: Response, parsed: ParsedPath, inspected: InspectedPath, parser: FileParser): Promise<void> {
    if (inspected.stats?.isDirectory()) { sendError(request, response, 409, "cannot replace a directory"); return; }
    const createOnly = request.get("If-None-Match")?.trim() === "*";
    if (createOnly && !inspected.missing) { sendError(request, response, 412, "file already exists"); return; }
    const document = await this.readStructuredBody(request, response, "application/json");
    if (document === undefined) return;
    const changes = Object.fromEntries(Object.entries(document).filter(([key]) => !defaultFileKeys.has(key)));
    const bytes = await patchBytes(parser, { path: parsed.path, changes });
    if (bytes.length > maximumStructuredBytes) { sendError(request, response, 413, "result is too large"); return; }
    const fields = await parseFields(parser, parsed.path, bytes);
    if (Object.hasOwn(fields, "parseError")) throw new HttpError(500, "parser could not read its output");
    const written = await this.replacePath(inspected.absolutePath, inspected.stats, parsed.path, Readable.from([bytes]), createOnly);
    this.parsedFileCache.set(parsed.path, { modifiedMs: written.stats.mtimeMs, fields: Promise.resolve(fields) });
    sendJsonDescription(request, response,
      { ...fileDescription(parsed.path, inspected.absolutePath, written.stats), ...fields },
      written.result === "created" ? 201 : 200);
  }

  private async patchJson(request: Request, response: Response, parsed: ParsedPath, inspected: InspectedPath, parser: FileParser): Promise<void> {
    if (inspected.missing || inspected.stats === undefined) { sendError(request, response, 404, "not found"); return; }
    if (!inspected.stats.isFile()) { sendError(request, response, 409, "cannot edit a directory"); return; }
    if (inspected.stats.size > maximumStructuredBytes) { sendError(request, response, 415, "target is too large to edit"); return; }
    const changes = await this.readStructuredBody(request, response, mergePatchContentType);
    if (changes === undefined) return;
    if (Object.keys(changes).some((key) => defaultFileKeys.has(key))) {
      sendError(request, response, 422, "default fields cannot be changed"); return;
    }
    if (Object.keys(changes).length === 0) {
      sendJsonDescription(request, response, await this.describeFile(parsed.path, inspected.absolutePath, inspected.stats));
      return;
    }

    const handle = await open(inspected.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let stats: Stats;
    let sourceBytes: Buffer;
    try {
      stats = await handle.stat();
      if (stats.size > maximumStructuredBytes) { sendError(request, response, 415, "target is too large to edit"); return; }
      sourceBytes = await readHandleAtMost(handle, maximumStructuredBytes + 1);
      if (sourceBytes.length > maximumStructuredBytes) { sendError(request, response, 415, "target is too large to edit"); return; }
    } finally {
      await handle.close().catch(() => undefined);
    }
    const bytes = await patchBytes(parser, { path: parsed.path, bytes: sourceBytes, changes });
    if (bytes.length > maximumStructuredBytes) { sendError(request, response, 413, "result is too large"); return; }
    const fields = await parseFields(parser, parsed.path, bytes);
    if (Object.hasOwn(fields, "parseError")) throw new HttpError(500, "parser could not read its output");
    const writtenStats = await writeAtomically(inspected.absolutePath, Readable.from([bytes]),
      stats.mode & 0o7777, stats.mtime.getTime(), this.temporaryPaths);
    await this.publishMutation({ type: "modified", path: parsed.path }, inspected.absolutePath);
    this.parsedFileCache.set(parsed.path, { modifiedMs: writtenStats.mtimeMs, fields: Promise.resolve(fields) });
    sendJsonDescription(request, response,
      { ...fileDescription(parsed.path, inspected.absolutePath, writtenStats), ...fields });
  }

  private async readStructuredBody(request: Request, response: Response, contentType: string): Promise<Record<string, JsonValue> | undefined> {
    if (!matchesContentType(request.get("Content-Type"), contentType)) {
      sendError(request, response, 415, "unsupported media type"); return undefined;
    }
    const declaredLength = request.headers["content-length"];
    if (typeof declaredLength === "string" && Number(declaredLength) > maximumStructuredBytes) {
      rejectOversizedRequestBody(request, response); return undefined;
    }
    let body: Buffer;
    try { body = await readLimitedBody(request, maximumStructuredBytes); }
    catch (error) {
      if (error instanceof HttpError && error.status === 413) { rejectOversizedRequestBody(request, response); return undefined; }
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(utf8Decoder.decode(body)); }
    catch { sendError(request, response, 400, "malformed JSON body"); return undefined; }
    if (!isJsonObject(value)) { sendError(request, response, 400, "JSON body must be an object"); return undefined; }
    return value as Record<string, JsonValue>;
  }

  private async delete(request: Request, response: Response, parsed: ParsedPath, inspected: InspectedPath): Promise<void> {
    if (parsed.segments.length === 0) { sendError(request, response, 409, "cannot delete the root"); return; }
    if (inspected.missing || inspected.stats === undefined) { sendError(request, response, 404, "not found"); return; }
    if (parsed.trailingSlash && inspected.stats.isFile()) { sendError(request, response, 404, "not found"); return; }
    await this.removePath(inspected.absolutePath, inspected.stats, parsed.path);
    response.status(204).end();
  }

  private createExtensionContext(parsed: ParsedPath, inspected: InspectedPath): FileServerExtensionContext {
    const resource = Object.freeze(resourceFromInspection(inspected));
    const segments = Object.freeze([...parsed.segments]);
    return Object.freeze({
      path: parsed.path,
      segments,
      trailingSlash: parsed.trailingSlash,
      resource,
      inspect: (path: string) => runContextOperation(async () => {
        const resolved = await this.resolveContextPath(path, true);
        if (resolved.parsed.trailingSlash && resolved.inspected.stats?.isFile()) throw new HttpError(404, "not found");
        return resourceFromInspection(resolved.inspected);
      }),
      list: (path: string) => runContextOperation(async () => {
        const resolved = await this.resolveContextPath(path);
        if (resolved.inspected.missing || resolved.inspected.stats?.isDirectory() !== true) throw new HttpError(404, "not found");
        return this.listDirectory(resolved.inspected.absolutePath, resolved.parsed.path);
      }),
      replace: (path: string, bytes: Uint8Array | Readable) => runContextOperation(async () => {
        const parsedPath = await this.parseContextTarget(path);
        if (parsedPath.segments.length === 0 || parsedPath.trailingSlash) throw new HttpError(409, "cannot write a directory path");
        const resolved = await this.resolveParsedPath(parsedPath);
        if (resolved.inspected.stats?.isDirectory()) throw new HttpError(409, "cannot replace a directory");
        const source = bytes instanceof Readable ? bytes : Readable.from([bytes]);
        return (await this.replacePath(
          resolved.inspected.absolutePath,
          resolved.inspected.stats,
          parsedPath.path,
          source,
        )).result;
      }),
      remove: (path: string) => runContextOperation(async () => {
        const parsedPath = await this.parseContextTarget(path);
        if (parsedPath.segments.length === 0) throw new HttpError(409, "cannot delete the root");
        const resolved = await this.resolveParsedPath(parsedPath);
        if (resolved.inspected.missing || resolved.inspected.stats === undefined) throw new HttpError(404, "not found");
        if (parsedPath.trailingSlash && resolved.inspected.stats.isFile()) throw new HttpError(404, "not found");
        await this.removePath(resolved.inspected.absolutePath, resolved.inspected.stats, parsedPath.path);
      }),
    });
  }

  private async replacePath(
    absolutePath: string,
    stats: Stats | undefined,
    path: string,
    source: Readable,
    createOnly = false,
  ): Promise<{ result: "created" | "replaced"; stats: Stats }> {
    const existingFileStats = stats?.isFile() === true ? stats : undefined;
    try { await mkdir(dirname(absolutePath), { recursive: true }); }
    catch (error) {
      if (hasErrorCode(error, "EEXIST")) throw new HttpError(404, "not found");
      throw error;
    }
    const writtenStats = await writeAtomically(
      absolutePath,
      source,
      existingFileStats === undefined ? undefined : existingFileStats.mode & 0o7777,
      existingFileStats?.mtime.getTime(),
      this.temporaryPaths,
      createOnly,
    );
    const result = existingFileStats === undefined ? "created" : "replaced";
    await this.publishMutation({ type: result === "created" ? "created" : "modified", path }, absolutePath);
    return { result, stats: writtenStats };
  }

  private async removePath(absolutePath: string, stats: Stats, path: string): Promise<void> {
    const isDirectory = stats.isDirectory();
    const subtreeSuppression = isDirectory ? this.suppressDeletedSubtree(absolutePath) : undefined;
    try { await rm(absolutePath, { recursive: isDirectory }); }
    catch (error) {
      if (subtreeSuppression !== undefined) this.cancelDeletedSubtreeSuppression(absolutePath, subtreeSuppression);
      throw error;
    }
    if (subtreeSuppression !== undefined) {
      this.cancelDeletedSubtreeSuppression(absolutePath, subtreeSuppression);
      this.suppressDeletedSubtree(absolutePath);
    }
    await this.publishMutation({ type: "deleted", path }, absolutePath);
  }

  private async resolveContextPath(path: string, allowExactSymlink = false): Promise<{ parsed: ParsedPath; inspected: InspectedPath }> {
    return this.resolveParsedPath(await this.parseContextTarget(path), allowExactSymlink);
  }

  /** Parses an extension context path, hiding an ignored path exactly as a request is hidden. */
  private async parseContextTarget(path: string): Promise<ParsedPath> {
    const parsed = parseContextPath(path);
    if (await this.isIgnoredPath(parsed)) throw new HttpError(404, "not found");
    return parsed;
  }

  /**
   * Whether an ignore pattern hides a parsed path. The path is judged as what
   * it is on disk, because a pattern ending in `/` matches only directories.
   * The disk is consulted only when that changes the answer, so most requests
   * cost no extra filesystem call.
   *
   * The look never follows a symbolic link: a path through one counts as no
   * directory, as does a missing path or one that cannot be examined. Following
   * a link would let a 404 or 403 answer reveal whether a directory exists
   * wherever the link points, outside the root. A request that is not hidden
   * goes on to the path checks, which refuse the link or report the failure.
   */
  private async isIgnoredPath(parsed: ParsedPath): Promise<boolean> {
    const { asFile, asDirectory } = this.ignorePatterns.hidesRequested(parsed.path);
    if (asFile === asDirectory) return asFile;
    let isDirectory = false;
    try { isDirectory = (await inspectPath(this.resolvedRoot as string, parsed.segments)).stats?.isDirectory() === true; }
    catch { /* A link on the way, a special object, or a filesystem failure: no directory. */ }
    return isDirectory ? asDirectory : asFile;
  }

  private async resolveParsedPath(parsed: ParsedPath, allowExactSymlink = false): Promise<{ parsed: ParsedPath; inspected: InspectedPath }> {
    const root = this.resolvedRoot as string;
    const inspected = await inspectPath(root, parsed.segments);
    if (inspected.stats?.isSymbolicLink() && (!allowExactSymlink || parsed.trailingSlash)) throw new HttpError(403, "forbidden");
    await ensureConfined(root, inspected.deepestExistingPath);
    if (this.temporaryPaths.has(inspected.absolutePath)) throw new HttpError(404, "not found");
    return { parsed, inspected };
  }

  private async publishMutation(event: FileChangeEvent, absolutePath: string): Promise<void> {
    this.parsedFileCache.delete(event.path);
    if (event.type !== "deleted") this.advanceDeletedSuppressions(absolutePath);
    await this.suppressWatcherEvent(event, absolutePath);
    if (event.type === "created") {
      const root = this.resolvedRoot as string;
      for (let parent = dirname(absolutePath); parent !== root; parent = dirname(parent)) {
        const path = watcherEventPath(root, parent);
        if (path === undefined) break;
        await this.suppressWatcherEvent({ type: "created", path }, parent);
      }
    }
    await this.publishChange(event);
  }

  private async suppressWatcherEvent(event: FileChangeEvent, absolutePath: string): Promise<void> {
    this.cancelPendingWatcherEvent(absolutePath);
    const previous = this.suppressedWatcherEvents.get(absolutePath);
    if (previous !== undefined) clearTimeout(previous.timer);
    const fingerprint = event.type === "deleted" ? undefined : await watcherFingerprint(absolutePath);
    const timer = setTimeout(() => this.suppressedWatcherEvents.delete(absolutePath), watcherSuppressionMs);
    timer.unref();
    this.suppressedWatcherEvents.set(absolutePath, { event, fingerprint, timer });
  }

  private async publishChange(originalEvent: FileChangeEvent): Promise<void> {
    const preservedEvent = { ...originalEvent };
    let event: FileChangeEvent | null = preservedEvent;
    if (this.extension?.change !== undefined) {
      try {
        event = await this.extension.change({ ...preservedEvent });
        if (event !== null && !isFileChangeEvent(event)) throw new Error("extension returned an invalid change event");
      } catch (error) {
        console.error("fileserver change extension error", error);
        event = preservedEvent;
      }
    }
    if (event === null || this.isClosing) return;
    const message = JSON.stringify(event);
    for (const socket of this.sockets.keys()) if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }

  private handleWatcherChange(type: FileChangeEvent["type"], absolutePath: string): void {
    if (!this.watcherIsReady || this.isClosing) return;
    const path = watcherEventPath(this.resolvedRoot as string, absolutePath);
    if (path === undefined) return;
    const previous = this.pendingWatcherEvents.get(absolutePath);
    if (previous !== undefined) clearTimeout(previous.timer);
    const pending: PendingWatcherEvent = {
      event: { type: coalesceWatcherEvent(previous?.event.type, type), path },
      timer: setTimeout(() => { void this.flushWatcherEvent(absolutePath, pending); }, watcherDebounceMs),
    };
    pending.timer.unref();
    this.pendingWatcherEvents.set(absolutePath, pending);
  }

  private async flushWatcherEvent(absolutePath: string, pending: PendingWatcherEvent): Promise<void> {
    try {
      if (this.pendingWatcherEvents.get(absolutePath) !== pending) return;
      this.pendingWatcherEvents.delete(absolutePath);
      let event = pending.event;
      let fingerprint: string | undefined;
      if (event.type !== "deleted") {
        const parsed = parseContextPath(event.path);
        const resolved = await this.resolveParsedPath(parsed);
        const { stats } = resolved.inspected;
        // A path that is now hidden has gone as far as clients can tell. The
        // watcher only reports paths that were visible, but one can become
        // hidden by changing type: a watched file replaced by a directory
        // that a pattern ending in `/` hides can still report a change.
        if (resolved.inspected.missing || stats === undefined || this.ignorePatterns.hides(event.path, stats.isDirectory())) {
          event = { type: "deleted", path: event.path };
        } else {
          this.clearDeletedSuppressions(absolutePath);
          fingerprint = watcherFingerprintFromStats(stats);
        }
      }
      if (event.type === "deleted" && this.isDeletedSubtreeSuppressed(absolutePath)) return;
      const suppressed = this.suppressedWatcherEvents.get(absolutePath);
      if (suppressed !== undefined
        && suppressed.event.type === event.type
        && (event.type === "deleted" || suppressed.fingerprint === fingerprint)) {
        clearTimeout(suppressed.timer);
        this.suppressedWatcherEvents.delete(absolutePath);
        return;
      }
      await this.publishChange(event);
    } catch (error) {
      const mapped = mapError(error);
      if (mapped.status === 500) console.error("fileserver watcher event error", error);
    }
  }

  private cancelPendingWatcherEvent(absolutePath: string): void {
    const pending = this.pendingWatcherEvents.get(absolutePath);
    if (pending !== undefined) clearTimeout(pending.timer);
    this.pendingWatcherEvents.delete(absolutePath);
  }

  private suppressDeletedSubtree(absolutePath: string): SuppressedDeletedSubtree {
    const previous = this.suppressedDeletedSubtrees.get(absolutePath);
    if (previous !== undefined) clearTimeout(previous.timer);
    let suppressed: SuppressedDeletedSubtree;
    const timer = setTimeout(() => {
      if (this.suppressedDeletedSubtrees.get(absolutePath) === suppressed) {
        this.suppressedDeletedSubtrees.delete(absolutePath);
      }
    }, watcherSuppressionMs);
    timer.unref();
    suppressed = { recreatedPaths: new Set(), timer };
    this.suppressedDeletedSubtrees.set(absolutePath, suppressed);
    return suppressed;
  }

  private cancelDeletedSubtreeSuppression(absolutePath: string, suppressed: SuppressedDeletedSubtree): void {
    if (this.suppressedDeletedSubtrees.get(absolutePath) !== suppressed) return;
    clearTimeout(suppressed.timer);
    this.suppressedDeletedSubtrees.delete(absolutePath);
  }

  private isDeletedSubtreeSuppressed(absolutePath: string): boolean {
    for (const [subtree, suppressed] of this.suppressedDeletedSubtrees) {
      if (isSameOrDescendant(subtree, absolutePath) && !suppressed.recreatedPaths.has(absolutePath)) return true;
    }
    return false;
  }

  private advanceDeletedSuppressions(absolutePath: string): void {
    for (const [subtree, suppressed] of this.suppressedDeletedSubtrees) {
      if (!isSameOrDescendant(subtree, absolutePath)) continue;
      for (let recreatedPath = absolutePath; isSameOrDescendant(subtree, recreatedPath); recreatedPath = dirname(recreatedPath)) {
        suppressed.recreatedPaths.add(recreatedPath);
        const pending = this.pendingWatcherEvents.get(recreatedPath);
        if (pending?.event.type === "deleted") {
          clearTimeout(pending.timer);
          this.pendingWatcherEvents.delete(recreatedPath);
        }
        const exactSuppression = this.suppressedWatcherEvents.get(recreatedPath);
        if (exactSuppression?.event.type === "deleted") {
          clearTimeout(exactSuppression.timer);
          this.suppressedWatcherEvents.delete(recreatedPath);
        }
        if (recreatedPath === subtree) break;
      }
    }
  }

  private clearDeletedSuppressions(absolutePath: string): void {
    for (const [subtree, suppressed] of this.suppressedDeletedSubtrees) {
      if (isSameOrDescendant(subtree, absolutePath)) {
        for (const [pendingPath, pending] of this.pendingWatcherEvents) {
          if (pending.event.type === "deleted"
            && isSameOrDescendant(subtree, pendingPath)
            && !suppressed.recreatedPaths.has(pendingPath)) {
            clearTimeout(pending.timer);
            this.pendingWatcherEvents.delete(pendingPath);
          }
        }
        this.cancelDeletedSubtreeSuppression(subtree, suppressed);
      }
    }
    for (const [deletedPath, suppressed] of this.suppressedWatcherEvents) {
      if (suppressed.event.type !== "deleted") continue;
      if (isSameOrDescendant(deletedPath, absolutePath)) {
        clearTimeout(suppressed.timer);
        this.suppressedWatcherEvents.delete(deletedPath);
      }
    }
  }

  /** Accepts or refuses a WebSocket upgrade using a mount-relative request target. */
  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    requestTarget = request.url ?? "",
  ): Promise<void> {
    try {
      await this.ready;
      const parsed = parseRequestPath(requestTarget);
      if (parsed instanceof HttpError) throw parsed;
      if (await this.isIgnoredPath(parsed)) throw new HttpError(404, "not found");
      const root = this.resolvedRoot as string;
      const inspected = await inspectPath(root, parsed.segments);
      if (inspected.stats?.isSymbolicLink()) throw new HttpError(403, "forbidden");
      await ensureConfined(root, inspected.deepestExistingPath);
      if (this.temporaryPaths.has(inspected.absolutePath)) throw new HttpError(404, "not found");
      if (!parsed.trailingSlash || inspected.missing || inspected.stats?.isDirectory() !== true) {
        throw new HttpError(404, "not found");
      }
      if (!isWebSocketUpgrade(request)) throw new HttpError(400, "invalid WebSocket upgrade");
      if (this.isClosing) throw new Error("file server is closed");
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        const subscription = { isAlive: true };
        this.sockets.set(webSocket, subscription);
        webSocket.on("pong", () => { subscription.isAlive = true; });
        webSocket.on("error", () => { /* Protocol errors close only this subscription. */ });
        webSocket.once("close", () => this.sockets.delete(webSocket));
        this.webSockets.emit("connection", webSocket, request);
      });
    } catch (error) {
      const mapped = mapError(error);
      await sendUpgradeError(socket, mapped.status, mapped.message);
    }
  }

  private async handleConnect(request: IncomingMessage, socket: Duplex): Promise<void> {
    try {
      const parsed = parseRequestPath(request.url ?? "");
      if (parsed instanceof HttpError) { sendConnectError(socket, parsed.status, parsed.message); return; }
      await this.ready;
      if (await this.isIgnoredPath(parsed)) { sendConnectError(socket, 404, "not found"); return; }
      const inspected = await inspectPath(this.resolvedRoot as string, parsed.segments);
      if (inspected.stats?.isSymbolicLink()) throw new HttpError(403, "forbidden");
      sendConnectError(socket, 405, "method not allowed");
    } catch (error) {
      const mapped = mapError(error);
      sendConnectError(socket, mapped.status, mapped.message);
    }
  }
}

async function runHandleHook(
  hook: NonNullable<FileServerExtension["handle"]>,
  request: Request,
  response: Response,
  context: FileServerExtensionContext,
): Promise<boolean> {
  const statusCode = response.statusCode;
  const headers = response.getHeaders();
  let handled: boolean;
  try { handled = await hook(request, response, context); }
  catch (error) { throw mapExtensionHookError(error); }
  if (typeof handled !== "boolean") throw new Error("extension handle hook did not return a boolean");
  if (handled) {
    if (!response.writableEnded) throw new Error("extension handle hook returned true without ending the response");
    return true;
  }
  if (response.headersSent || response.writableEnded || response.statusCode !== statusCode || !sameHeaders(headers, response.getHeaders())) {
    throw new Error("extension handle hook changed the response before delegating");
  }
  return false;
}

async function runContextOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw mapError(error); }
}

function mapExtensionHookError(error: unknown): HttpError {
  return error instanceof HttpError ? error : new HttpError(500, "internal server error");
}

function sameHeaders(
  left: ReturnType<Response["getHeaders"]>,
  right: ReturnType<Response["getHeaders"]>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      return leftValue.length === rightValue.length && leftValue.every((value, index) => value === rightValue[index]);
    }
    return leftValue === rightValue;
  });
}

function resourceFromInspection(inspected: InspectedPath): FileServerResource {
  if (inspected.missing || inspected.stats === undefined) return { type: "missing" };
  if (inspected.stats.isDirectory()) return { type: "dir" };
  if (inspected.stats.isSymbolicLink()) return { type: "symlink" };
  return { type: "file", size: inspected.stats.size, modified: inspected.stats.mtime.toISOString() };
}

function isDirectoryListing(value: unknown, expectedPath: string): value is DirectoryListing {
  if (!isJsonObject(value) || typeof value.path !== "string" || value.kind !== "dir" || !Array.isArray(value.entries)) return false;
  if (value.path !== expectedPath) return false;
  if (!hasExactKeys(value, ["path", "kind", "entries"])) return false;
  if (value.path.startsWith("/") || value.path.endsWith("/")) return false;
  let segments: string[];
  try { segments = parseContextPath(value.path).segments; }
  catch { return false; }
  return value.entries.every((entry) => isDirectoryEntry(entry, segments));
}

function isDirectoryEntry(entry: unknown, parentSegments: readonly string[]): entry is DirectoryEntry {
  if (!isJsonObject(entry) || typeof entry.path !== "string" || typeof entry.kind !== "string") return false;
  if (!isJsonValue(entry)) return false;
  let segments: string[];
  try { segments = parseContextPath(entry.path).segments; }
  catch { return false; }
  if (segments.length !== parentSegments.length + 1 || !parentSegments.every((segment, index) => segments[index] === segment)) return false;
  if (entry.kind === "dir" || entry.kind === "symlink") return hasExactKeys(entry, ["path", "kind"]);
  if (entry.kind !== "file") return true;
  if (!["path", "kind", "contentType", "size", "modified"].every((key) => Object.hasOwn(entry, key))) return false;
  if (typeof entry.contentType !== "string") return false;
  if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) return false;
  if (typeof entry.modified !== "string") return false;
  const modified = new Date(entry.modified);
  return Number.isFinite(modified.getTime()) && modified.toISOString() === entry.modified;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isFileChangeEvent(value: unknown): value is FileChangeEvent {
  if (!isJsonObject(value) || Object.keys(value).length !== 2) return false;
  if (value.type !== "created" && value.type !== "modified" && value.type !== "deleted") return false;
  if (typeof value.path !== "string" || value.path.length === 0 || value.path.startsWith("/") || value.path.endsWith("/")) return false;
  try { parseContextPath(value.path); return true; }
  catch { return false; }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

function isHiddenWatcherPath(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === "") return false;
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) return true;
  return pathFromRoot.split(sep).some((segment) => segment.startsWith(".") || segment.includes("\\"));
}

function watcherEventPath(root: string, absolutePath: string): string | undefined {
  if (isHiddenWatcherPath(root, absolutePath)) return undefined;
  const path = rootRelativePath(root, absolutePath);
  return path.length === 0 ? undefined : path;
}

/** The path relative to the root with `/` between segments, as protocol paths are written; empty for the root. */
function rootRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

async function watcherFingerprint(path: string): Promise<string | undefined> {
  try { return watcherFingerprintFromStats(await lstat(path)); }
  catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return undefined;
    throw error;
  }
}

function watcherFingerprintFromStats(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function isWebSocketUpgrade(request: IncomingMessage): boolean {
  const connection = request.headers.connection?.split(",").some((token) => token.trim().toLowerCase() === "upgrade") === true;
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  return request.method === "GET"
    && connection
    && request.headers.upgrade?.toLowerCase() === "websocket"
    && typeof key === "string"
    && /^[+/0-9A-Za-z]{22}==$/.test(key)
    && (version === "8" || version === "13");
}

async function resolveRoot(root: string): Promise<string> {
  const resolvedRoot = await realpath(root);
  const rootStats = await stat(resolvedRoot);
  if (!rootStats.isDirectory()) throw new Error(`${root} is not a directory`);
  return resolvedRoot;
}

function parseRequestPath(url: string): ParsedPath | HttpError {
  const rawPath = url.split("?", 1)[0] ?? "";
  if (!rawPath.startsWith("/")) return new HttpError(400, "invalid path");
  if (rawPath === "/") return { segments: [], path: "", trailingSlash: true };

  const trailingSlash = rawPath.endsWith("/");
  const rawSegments = rawPath.slice(1).split("/");
  if (trailingSlash) rawSegments.pop();
  if (rawSegments.some((segment) => segment.length === 0)) return new HttpError(400, "invalid path");

  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    let segment: string;
    try { segment = decodeURIComponent(rawSegment); }
    catch { return new HttpError(400, "invalid path"); }
    if (segment.includes("\0") || segment.includes("\\") || segment.includes("/")) return new HttpError(400, "invalid path");
    if (segment.startsWith(".")) return new HttpError(404, "not found");
    segments.push(segment);
  }
  return { segments, path: segments.join("/"), trailingSlash };
}

function hasJsonQuery(url: string): boolean {
  const queryStart = url.indexOf("?");
  return queryStart !== -1 && new URLSearchParams(url.slice(queryStart + 1)).has("json");
}

function parseContextPath(path: string): ParsedPath {
  if (!isWellFormedString(path)) throw new HttpError(400, "invalid path");
  if (path.startsWith("/")) throw new HttpError(400, "invalid path");
  if (path === "") return { segments: [], path: "", trailingSlash: false };
  const trailingSlash = path.endsWith("/");
  const segments = path.split("/");
  if (trailingSlash) segments.pop();
  if (segments.some((segment) => segment.length === 0 || segment.includes("\0") || segment.includes("\\"))) {
    throw new HttpError(400, "invalid path");
  }
  if (segments.some((segment) => segment.startsWith("."))) throw new HttpError(404, "not found");
  return { segments, path: segments.join("/"), trailingSlash };
}

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

async function inspectPath(root: string, segments: readonly string[]): Promise<InspectedPath> {
  const absolutePath = join(root, ...segments);
  let currentPath = root;
  let deepestExistingPath = root;
  let currentStats: Stats | undefined;

  if (segments.length === 0) {
    currentStats = await lstat(root);
    if (currentStats.isSymbolicLink()) {
      // The configured root was resolved at startup. If a local process later
      // replaces that path with a link outside the root, report the canonical
      // escape as 404 before treating it as an ordinary link request.
      await ensureConfined(root, root);
      throw new HttpError(403, "forbidden");
    }
    return { absolutePath, deepestExistingPath, missing: false, stats: currentStats };
  }

  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    try {
      currentStats = await lstat(currentPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
        return { absolutePath, deepestExistingPath, missing: true };
      }
      throw error;
    }
    if (currentStats.isSymbolicLink()) {
      if (index !== segments.length - 1) throw new HttpError(403, "forbidden");
      return { absolutePath, deepestExistingPath, missing: false, stats: currentStats };
    }
    if (!currentStats.isFile() && !currentStats.isDirectory()) throw new HttpError(404, "not found");
    deepestExistingPath = currentPath;
  }
  return { absolutePath, deepestExistingPath, missing: false, stats: currentStats };
}

async function ensureConfined(root: string, deepestExistingPath: string): Promise<void> {
  const canonicalPath = await realpath(deepestExistingPath);
  const pathFromRoot = relative(root, canonicalPath);
  if (pathFromRoot === "") return;
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new HttpError(404, "not found");
  }
}

async function sendFile(request: Request, response: Response, path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) { sendError(request, response, 404, "not found"); return; }
    const metadata = fileMetadata(path, fileStats);
    const ifNoneMatch = request.get("If-None-Match");
    if (ifNoneMatch !== undefined) {
      if (etagListMatches(ifNoneMatch, metadata.etag)) { sendNotModified(response, metadata); return; }
    } else {
      const ifModifiedSince = request.get("If-Modified-Since");
      if (ifModifiedSince !== undefined && isNotModifiedSince(ifModifiedSince, fileStats.mtimeMs)) {
        sendNotModified(response, metadata);
        return;
      }
    }

    if (request.method === "HEAD") {
      setFileHeaders(response, metadata, fileStats.size);
      response.status(200).end();
      return;
    }

    let range: ByteRange = { kind: "full" };
    const rangeHeader = request.get("Range");
    if (rangeHeader !== undefined && ifRangeMatches(request.get("If-Range"), fileStats.mtimeMs)) {
      range = parseRange(rangeHeader, fileStats.size);
    }
    if (range.kind === "unsatisfiable") {
      response.set({
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${fileStats.size}`,
        "ETag": metadata.etag,
        "Last-Modified": metadata.lastModified,
      });
      sendError(request, response, 416, "range not satisfiable");
      return;
    }
    if (range.kind === "range") {
      setFileHeaders(response, metadata, range.end - range.start + 1);
      response.set("Content-Range", `bytes ${range.start}-${range.end}/${fileStats.size}`);
      response.status(206);
      await streamFile(handle, response, range.start, range.end);
      return;
    }

    setFileHeaders(response, metadata, fileStats.size);
    response.status(200);
    await streamFile(handle, response);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function fileMetadata(path: string, fileStats: Stats): { contentType: string; etag: string; lastModified: string; link: string } {
  const lookedUpType = mimeTypes.lookup(path) || "application/octet-stream";
  const lowerType = lookedUpType.toLowerCase();
  const contentType = lowerType.startsWith("text/") || lowerType === "application/json" || lowerType.endsWith("+json")
    ? `${lookedUpType}; charset=utf-8`
    : lookedUpType;
  return {
    contentType,
    etag: `W/"${fileStats.size.toString(16)}-${fileStats.mtime.getTime().toString(16)}"`,
    lastModified: fileStats.mtime.toUTCString(),
    link: `<${encodeURIComponent(basename(path))}?json>; rel="describedby"`,
  };
}

function fileDescription(path: string, absolutePath: string, fileStats: Stats): DirectoryEntry {
  return {
    path,
    kind: "file",
    contentType: fileMetadata(absolutePath, fileStats).contentType,
    size: fileStats.size,
    modified: fileStats.mtime.toISOString(),
  };
}

function setFileHeaders(
  response: Response,
  metadata: { contentType: string; etag: string; lastModified: string; link: string },
  contentLength: number,
): void {
  response.set({
    "Content-Type": metadata.contentType,
    "Content-Length": String(contentLength),
    "Last-Modified": metadata.lastModified,
    "ETag": metadata.etag,
    "Accept-Ranges": "bytes",
    "Link": metadata.link,
  });
}

function sendNotModified(response: Response, metadata: { etag: string; lastModified: string; link: string }): void {
  response.set({ "ETag": metadata.etag, "Last-Modified": metadata.lastModified, "Link": metadata.link });
  response.status(304).end();
}

function etagListMatches(header: string, currentEtag: string): boolean {
  if (header.trim() === "*") return true;
  const currentOpaqueTag = weakOpaqueTag(currentEtag);
  return splitEntityTags(header).some((candidate) => weakOpaqueTag(candidate) === currentOpaqueTag);
}

function splitEntityTags(header: string): string[] {
  const tags: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      tags.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  tags.push(header.slice(start).trim());
  return tags;
}

function weakOpaqueTag(tag: string): string | undefined {
  const withoutWeakPrefix = tag.startsWith("W/") ? tag.slice(2) : tag;
  return /^"[^"\r\n]*"$/.test(withoutWeakPrefix) ? withoutWeakPrefix : undefined;
}

function isNotModifiedSince(header: string, modificationTime: number): boolean {
  const date = Date.parse(header);
  return Number.isFinite(date) && Math.floor(modificationTime / 1_000) <= Math.floor(date / 1_000);
}

function ifRangeMatches(header: string | undefined, modificationTime: number): boolean {
  if (header === undefined) return true;
  const trimmedHeader = header.trim();
  if (trimmedHeader.startsWith('"') || trimmedHeader.startsWith("W/\"")) return false;
  const date = Date.parse(header);
  return Number.isFinite(date) && Math.floor(date / 1_000) === Math.floor(modificationTime / 1_000);
}

function parseRange(header: string, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (match === null || (match[1] === "" && match[2] === "")) return { kind: "full" };
  const first = match[1] ?? "";
  const second = match[2] ?? "";
  if (first !== "" && second !== "" && Number(first) > Number(second)) return { kind: "full" };
  if (size === 0) return { kind: "unsatisfiable" };

  if (first === "") {
    const suffixLength = Number(second);
    if (suffixLength === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isFinite(start) || start >= size) return { kind: "unsatisfiable" };
  const requestedEnd = second === "" ? size - 1 : Number(second);
  const end = Number.isFinite(requestedEnd) ? Math.min(requestedEnd, size - 1) : size - 1;
  return { kind: "range", start, end };
}

async function streamFile(handle: FileHandle, response: Response, start?: number, end?: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = handle.createReadStream(start === undefined ? undefined : { start, end });
    let settled = false;
    const settleAfterClose = (): void => {
      if (settled) return;
      if (stream.closed) { settled = true; resolve(); }
      else stream.once("close", () => { if (!settled) { settled = true; resolve(); } });
    };
    stream.once("error", (error) => {
      if (settled) return;
      if (response.headersSent) { response.destroy(); settleAfterClose(); }
      else { settled = true; reject(error); }
    });
    response.once("finish", settleAfterClose);
    response.once("close", () => {
      if (!settled) stream.destroy();
      settleAfterClose();
    });
    stream.pipe(response);
  });
}

function sendJsonDescription(request: Request, response: Response, description: DirectoryListing | DirectoryEntry, status = 200): void {
  const body = Buffer.from(JSON.stringify(description));
  response.set({ "Content-Type": jsonContentType, "Content-Length": String(body.length) });
  response.status(status);
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

async function readDirectoryListing(
  absolutePath: string,
  path: string,
  temporaryPaths: ReadonlySet<string>,
  ignorePatterns: IgnorePatterns,
  describeFile: (path: string, absolutePath: string, stats: Stats) => Promise<DirectoryEntry>,
): Promise<DirectoryListing> {
  return { path, kind: "dir", entries: await readDirectoryEntries(absolutePath, path, temporaryPaths, ignorePatterns, describeFile) };
}

async function readDirectoryEntries(
  absolutePath: string,
  path: string,
  temporaryPaths: ReadonlySet<string>,
  ignorePatterns: IgnorePatterns,
  describeFile: (path: string, absolutePath: string, stats: Stats) => Promise<DirectoryEntry>,
): Promise<DirectoryEntry[]> {
  const directoryEntries = await readdir(absolutePath, { withFileTypes: true, encoding: "buffer" });
  const entries: DirectoryEntry[] = [];
  for (const directoryEntry of directoryEntries) {
    const name = decodeDirectoryName(directoryEntry);
    if (name === undefined || name.startsWith(".") || name.includes("\\")) continue;
    if (temporaryPaths.has(join(absolutePath, name))) continue;
    const entryPath = path === "" ? name : `${path}/${name}`;
    if (ignorePatterns.hides(entryPath, directoryEntry.isDirectory())) continue;
    if (directoryEntry.isSymbolicLink()) { entries.push({ path: entryPath, kind: "symlink" }); continue; }
    if (directoryEntry.isDirectory()) { entries.push({ path: entryPath, kind: "dir" }); continue; }
    if (!directoryEntry.isFile()) continue;
    try {
      const fileStats = await stat(join(absolutePath, name));
      if (fileStats.isFile()) entries.push(await describeFile(entryPath, join(absolutePath, name), fileStats));
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) throw error;
    }
  }
  const lastSegment = (entry: DirectoryEntry): string => entry.path.slice(entry.path.lastIndexOf("/") + 1);
  entries.sort((left, right) => lastSegment(left) < lastSegment(right) ? -1 : lastSegment(left) > lastSegment(right) ? 1 : 0);
  return entries;
}

function decodeDirectoryName(directoryEntry: Dirent<Buffer>): string | undefined {
  try { return utf8Decoder.decode(directoryEntry.name); }
  catch { return undefined; }
}

async function writeAtomically(
  path: string,
  source: Readable,
  mode: number | undefined,
  previousModified: number | undefined,
  temporaryPaths: Set<string>,
  createOnly = false,
): Promise<Stats> {
  let temporaryPath: string;
  let handle;
  while (true) {
    temporaryPath = join(dirname(path), `.fileserver-${randomUUID()}.tmp`);
    try { handle = await open(temporaryPath, "wx"); break; }
    catch (error) {
      if (hasErrorCode(error, "EEXIST")) continue;
      throw error;
    }
  }
  let committed = false;
  let handleClosed = false;
  temporaryPaths.add(temporaryPath);
  try {
    await pipeline(source, handle.createWriteStream());
    handleClosed = true;
    if (mode !== undefined) await chmod(temporaryPath, mode);
    if (previousModified !== undefined && (await stat(temporaryPath)).mtime.getTime() === previousModified) {
      const changedTime = new Date(previousModified + 1);
      await utimes(temporaryPath, changedTime, changedTime);
    }
    const writtenStats = await stat(temporaryPath);
    if (createOnly) {
      try { await link(temporaryPath, path); }
      catch (error) {
        if (hasErrorCode(error, "EEXIST")) throw new HttpError(412, "file already exists");
        throw error;
      }
      committed = true;
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, path);
      committed = true;
    }
    return writtenStats;
  } finally {
    if (!handleClosed) await handle.close().catch(() => undefined);
    if (!committed) await unlink(temporaryPath).catch(() => undefined);
    temporaryPaths.delete(temporaryPath);
  }
}

function validateParsers(options: Record<string, FileParser>): Map<string, FileParser> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error("parsers must be an object");
  const parsers = new Map<string, FileParser>();
  for (const [extension, parser] of Object.entries(options)) {
    if (!/^\.[^./\\]+$/.test(extension)) throw new Error(`invalid parser extension: ${extension}`);
    const key = extension.toLowerCase();
    if (parsers.has(key)) throw new Error(`duplicate parser extension: ${extension}`);
    if (parser === null || typeof parser !== "object" || typeof parser.parse !== "function"
      || (parser.patch !== undefined && typeof parser.patch !== "function")) {
      throw new Error(`invalid parser for ${extension}`);
    }
    parsers.set(key, parser);
  }
  return parsers;
}

async function parseFields(parser: FileParser, path: string, bytes: Uint8Array): Promise<Record<string, JsonValue>> {
  try {
    const fields: unknown = await parser.parse({ path, bytes });
    if (!isParserJsonObject(fields) || !isParserJsonValue(fields)
      || Object.keys(fields).some((key) => defaultFileKeys.has(key) || key === "parseError")) {
      throw new Error("invalid parser description");
    }
    return structuredClone(fields) as Record<string, JsonValue>;
  } catch {
    return { parseError: "file could not be parsed" };
  }
}

async function patchBytes(
  parser: FileParser,
  input: { path: string; bytes?: Uint8Array; changes: Record<string, JsonValue> },
): Promise<Uint8Array> {
  let bytes: unknown;
  try { bytes = await (parser.patch as NonNullable<FileParser["patch"]>)(input); }
  catch (error) { throw new HttpError(422, error instanceof Error ? error.message : String(error)); }
  if (!(bytes instanceof Uint8Array)) throw new HttpError(500, "parser did not return bytes");
  return bytes;
}

function matchesContentType(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\s*(?:;\\s*charset\\s*=\\s*utf-8\\s*)?$`, "i").test(actual);
}

function isParserJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isJsonObject(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isParserJsonValue(value: unknown, visited = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (visited.has(value)) return false;
  if (!Array.isArray(value) && !isParserJsonObject(value)) return false;
  visited.add(value);
  const valid = Object.values(value).every((entry) => isParserJsonValue(entry, visited));
  visited.delete(value);
  return valid;
}

async function readLimitedBody(request: Request, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const onData = (value: Buffer): void => {
      size += value.length;
      if (size > maximumBytes) {
        cleanup();
        request.pause();
        reject(new HttpError(413, "request body is too large"));
      } else chunks.push(value);
    };
    const onEnd = (): void => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAborted = (): void => { cleanup(); reject(new Error("request aborted")); };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function rejectOversizedRequestBody(request: Request, response: Response): void {
  request.pause();
  response.shouldKeepAlive = false;
  response.set("Connection", "close");
  response.once("finish", () => setImmediate(() => request.destroy()));
  sendError(request, response, 413, "request body is too large");
}

async function readHandleAtMost(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < maximumBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes - size));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    size += bytesRead;
  }
  return Buffer.concat(chunks, size);
}

function isSupportedMethod(method: string): boolean {
  return supportedMethods.has(method);
}

function coalesceWatcherEvent(
  previous: FileChangeEvent["type"] | undefined,
  current: FileChangeEvent["type"],
): FileChangeEvent["type"] {
  if (current === "deleted") return "deleted";
  if (previous === undefined) return current;
  if (previous === "created" || previous === "deleted") return "created";
  return "modified";
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

function setCommonCorsHeaders(response: Response): void {
  response.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": exposedResponseHeaders,
  });
}

function sendConnectError(socket: Duplex, status: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ error: message }));
  const headers = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`,
    ...(status === 405 ? [`Allow: ${byteAllowedMethods}`] : []),
    "Access-Control-Allow-Origin: *",
    `Access-Control-Expose-Headers: ${exposedResponseHeaders}`,
    `Content-Type: ${jsonContentType}`,
    `Content-Length: ${body.length}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  socket.end(Buffer.concat([Buffer.from(headers), body]));
}

async function sendUpgradeError(socket: Duplex, status: number, message: string): Promise<void> {
  if (socket.closed) return;
  const body = Buffer.from(JSON.stringify({ error: message }));
  const headers = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`,
    `Content-Type: ${jsonContentType}`,
    `Content-Length: ${body.length}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  await new Promise<void>((resolve) => {
    let settled = false;
    const close = (): void => {
      if (settled) return;
      settled = true;
      socket.removeListener("finish", finish);
      socket.removeListener("close", close);
      socket.removeListener("error", fail);
      resolve();
    };
    const finish = (): void => {
      socket.destroy();
    };
    const fail = (): void => {
      socket.destroy();
    };
    socket.once("finish", finish);
    socket.once("close", close);
    socket.once("error", fail);
    if (!socket.destroyed) socket.end(Buffer.concat([Buffer.from(headers), body]));
    if (socket.closed) close();
    else if (socket.writableFinished) finish();
  });
}

function sendOptions(response: Response, request: Request, methods: string): void {
  response.set({
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": allowedRequestHeaders,
    "Access-Control-Max-Age": "86400",
  });
  response.set("Allow", methods);
  if (request.get("Access-Control-Request-Private-Network") === "true") {
    response.set("Access-Control-Allow-Private-Network", "true");
  }
  response.status(204).end();
}

function sendMappedError(request: Request, response: Response, error: unknown): void {
  const mapped = mapError(error);
  sendError(request, response, mapped.status, mapped.message);
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return new HttpError(404, "not found");
  if (hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM") || hasErrorCode(error, "ELOOP")) {
    return new HttpError(403, "forbidden");
  }
  return new HttpError(500, "internal server error");
}

function sendError(request: Request, response: Response, status: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ error: message }));
  response.set({ "Content-Type": jsonContentType, "Content-Length": String(body.length) });
  response.status(status);
  if (request.method === "HEAD") response.end();
  else response.end(body);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
