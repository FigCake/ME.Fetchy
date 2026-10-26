/*! Fetchy 0.7.3 — extension installer for Marinara Engine 2.5.x (External Extension).
 * Installs other External Extensions from a GitHub URL through Marinara's API.
 * Never executes downloaded code. Source: https://github.com/FigCake/ME.Fetchy
 * License: MIT */
"use strict";
(() => {
  // src/manifest.ts
  var CAPABILITY_ORDER = ["read_active_characters", "read_active_persona", "full_page_access"];
  var FULL_PAGE_ACCESS = "full_page_access";
  var LIMITS = {
    nameLength: 200,
    versionLength: 64,
    descriptionLength: 2e3,
    cssBytes: 256 * 1024,
    /** Marinara's zip import refuses larger text entries; the same cap keeps a download bounded. */
    textFileBytes: 2 * 1024 * 1024,
    /** Paths one manifest may name across jsPaths / cssPaths / serverJsPaths. */
    filesPerManifest: 40
  };
  var ManifestError = class extends Error {
    constructor(problem) {
      super(`manifest: ${problem.code}`);
      this.problem = problem;
      this.name = "ManifestError";
    }
    problem;
  };
  var KNOWN_KINDS = ["marinara.personal-extension", "marinara.personal-server-extension", "marinara.extension", "marinara.server-extension"];
  var isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  function entries(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (!isRecord(parsed)) return [];
    for (const key of ["extensions", "personalExtensions"]) {
      const value = parsed[key];
      if (Array.isArray(value)) return value;
    }
    return [parsed];
  }
  function configOf(entry) {
    if (!isRecord(entry)) return null;
    const manifest = isRecord(entry.manifest) ? entry.manifest : entry;
    if (typeof manifest.type === "string" && manifest.version === 1) return manifest;
    if (isRecord(manifest.config)) return manifest.config;
    if (typeof manifest.kind === "string" && isRecord(manifest.data)) return manifest.data;
    return manifest;
  }
  function kindOf(entry) {
    if (!isRecord(entry)) return "";
    const manifest = isRecord(entry.manifest) ? entry.manifest : entry;
    return typeof manifest.kind === "string" ? manifest.kind.toLowerCase() : "";
  }
  function nameOf(entry) {
    const config = configOf(entry);
    return config && typeof config.name === "string" ? config.name.trim() : "";
  }
  function normalizeVersion(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return { version: String(value), dropped: null };
    if (typeof value !== "string") return { version: null, dropped: value == null ? null : String(value) };
    const trimmed = value.trim();
    if (!trimmed) return { version: null, dropped: null };
    return trimmed.length <= LIMITS.versionLength ? { version: trimmed, dropped: null } : { version: null, dropped: trimmed };
  }
  function normalizeCapabilities(value) {
    if (!Array.isArray(value)) return { capabilities: [], unknown: [] };
    const requested = new Set(value.map(String));
    const capabilities = CAPABILITY_ORDER.filter((c) => requested.has(c));
    const unknown = [...requested].filter((c) => !CAPABILITY_ORDER.includes(c));
    return { capabilities, unknown };
  }
  var utf8 = new TextEncoder();
  var utf8Length = (text) => utf8.encode(text).byteLength;
  async function readPaths(value, role, read, files) {
    if (value == null) return null;
    const paths = (Array.isArray(value) ? value : [value]).filter((p) => typeof p === "string" && p.trim() !== "");
    const parts = [];
    if (files.length + paths.length > LIMITS.filesPerManifest) throw new ManifestError({ code: "too-many-files", count: files.length + paths.length });
    for (const path of paths) {
      const text = await read(path);
      if (text == null) throw new ManifestError({ code: "file-missing", path });
      const bytes = utf8Length(text);
      if (bytes > LIMITS.textFileBytes) throw new ManifestError({ code: "file-too-large", path, bytes });
      files.push({ path, role, bytes });
      parts.push(text);
    }
    return parts.length ? parts.join("\n\n") : null;
  }
  function inline(value, role, files) {
    if (typeof value !== "string") return null;
    files.push({ path: `(inline ${role})`, role, bytes: utf8Length(value) });
    return value;
  }
  async function normalizeManifest(parsed, read) {
    const all = entries(parsed);
    if (all.length === 0) throw new ManifestError({ code: "no-entries" });
    if (all.length > 1) throw new ManifestError({ code: "multiple-entries", names: all.map(nameOf) });
    const entry = all[0];
    const config = configOf(entry);
    if (!config) throw new ManifestError({ code: "not-an-object" });
    const kind = kindOf(entry);
    const warnings = [];
    const files = [];
    if (kind && !KNOWN_KINDS.includes(kind)) warnings.push({ code: "unknown-kind", kind });
    const name = typeof config.name === "string" ? config.name.trim() : "";
    if (!name) throw new ManifestError({ code: "name-missing" });
    if (name.length > LIMITS.nameLength) throw new ManifestError({ code: "name-too-long", length: name.length });
    const { version, dropped } = normalizeVersion(config.version);
    if (dropped !== null) warnings.push({ code: "version-dropped", value: dropped });
    const description = typeof config.description === "string" ? config.description : "";
    if (description.length > LIMITS.descriptionLength) {
      throw new ManifestError({ code: "description-too-long", length: description.length });
    }
    const runtime = typeof config.runtime === "string" && config.runtime.toLowerCase() === "server" || kind === "marinara.server-extension" || kind === "marinara.personal-server-extension" ? "server" : "client";
    if (runtime === "server") {
      const serverJs = await readPaths(config.serverJsPath ?? config.serverJsPaths ?? config.jsPath ?? config.jsPaths, "serverJs", read, files) ?? inline(config.serverJs ?? config.js, "serverJs", files);
      if (!serverJs?.trim()) throw new ManifestError({ code: "server-no-code" });
      return {
        kind,
        warnings,
        files,
        draft: { name, version, description, runtime, capabilities: [], css: null, js: null, serverJs }
      };
    }
    const css = await readPaths(config.cssPath ?? config.cssPaths, "css", read, files) ?? inline(config.css, "css", files);
    const js = await readPaths(config.jsPath ?? config.jsPaths, "js", read, files) ?? inline(config.js, "js", files);
    if (!css?.trim() && !js?.trim()) throw new ManifestError({ code: "no-code" });
    if (css !== null) {
      const bytes = utf8Length(css);
      if (bytes > LIMITS.cssBytes) throw new ManifestError({ code: "css-too-large", bytes });
    }
    const { capabilities, unknown } = normalizeCapabilities(config.capabilities);
    if (unknown.length) warnings.push({ code: "unknown-capabilities", values: unknown });
    if (kind === "marinara.extension" && !Object.prototype.hasOwnProperty.call(config, "capabilities")) {
      if (!capabilities.includes(FULL_PAGE_ACCESS)) capabilities.push(FULL_PAGE_ACCESS);
      warnings.push({ code: "legacy-kind-full-page" });
    }
    return {
      kind,
      warnings,
      files,
      draft: { name, version, description, runtime, capabilities, css, js, serverJs: null }
    };
  }
  function apiPayload(draft) {
    return draft.runtime === "server" ? { name: draft.name, version: draft.version, description: draft.description, runtime: "server", capabilities: [], serverJs: draft.serverJs } : { name: draft.name, version: draft.version, description: draft.description, runtime: "client", capabilities: draft.capabilities, css: draft.css, js: draft.js };
  }

  // src/engine-api.ts
  var EngineApiError = class extends Error {
    constructor(code, status, message, existingId = null) {
      super(message);
      this.code = code;
      this.status = status;
      this.existingId = existingId;
      this.name = "EngineApiError";
    }
    code;
    status;
    existingId;
  };
  var ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  async function errorFrom(response) {
    let payload = null;
    let text = "";
    try {
      text = await response.text();
      payload = JSON.parse(text);
    } catch {
    }
    const record = payload && typeof payload === "object" ? payload : {};
    const message = [record.error, record.message].filter((v) => typeof v === "string").join(" ") || text || `HTTP ${response.status}`;
    const existingId = typeof record.id === "string" ? record.id : null;
    const status = response.status;
    const lower = message.toLowerCase();
    let code = "http";
    if (status === 409 && existingId) code = "name-exists";
    else if (status === 404) code = "not-found";
    else if (status === 400) code = "validation";
    else if (status === 421) code = "untrusted-host";
    else if (status === 403) {
      if (lower.includes("enable_external_extensions") || lower.includes("danger zone") || lower.includes("two-step")) code = "gates-closed";
      else if (lower.includes("csrf")) code = "csrf";
      else code = "privileged";
    }
    return new EngineApiError(code, status, message, existingId);
  }
  function createEngineClient(options) {
    const base = (options.baseUrl ?? "").replace(/\/$/, "") + "/api/personal-extensions";
    async function request(method, path, body) {
      const headers = new Headers();
      headers.set("Accept", "application/json");
      if (method !== "GET") {
        headers.set("x-marinara-csrf", "1");
        if (body !== void 0) headers.set("Content-Type", "application/json");
      }
      const secret = options.adminSecret();
      if (secret) headers.set("X-Admin-Secret", secret);
      let response;
      try {
        response = await options.fetch(base + path, {
          method,
          headers,
          body: body === void 0 ? void 0 : JSON.stringify(body),
          cache: "no-store",
          credentials: "same-origin"
        });
      } catch (e) {
        throw new EngineApiError("network", 0, e instanceof Error ? e.message : String(e));
      }
      if (!response.ok) throw await errorFrom(response);
      return response;
    }
    const idPath = (id) => {
      if (!ID_PATTERN.test(id)) throw new EngineApiError("not-found", 404, `Not a Marinara extension id: ${id}`);
      return `/${encodeURIComponent(id)}`;
    };
    return {
      async policy() {
        return (await request("GET", "/policy")).json();
      },
      async list() {
        const value = await (await request("GET", "")).json();
        return Array.isArray(value) ? value : [];
      },
      async create(draft) {
        return (await request("POST", "", apiPayload(draft))).json();
      },
      async update(id, draft) {
        return (await request("PATCH", idPath(id), apiPayload(draft))).json();
      },
      async approve(id, contentHash, fullPageAccess) {
        if (!/^sha256:[a-f0-9]{64}$/.test(contentHash)) throw new EngineApiError("validation", 400, `Not a content hash: ${contentHash}`);
        const body = { contentHash, acknowledgeSandboxedCode: true };
        if (fullPageAccess) body.acknowledgeFullPageAccess = true;
        return (await request("POST", `${idPath(id)}/approve`, body)).json();
      },
      async disable(id) {
        return (await request("PATCH", idPath(id), { enabled: false })).json();
      },
      async rollback(id, contentHash) {
        if (!/^sha256:[a-f0-9]{64}$/.test(contentHash)) throw new EngineApiError("validation", 400, `Not a content hash: ${contentHash}`);
        return (await request("POST", `${idPath(id)}/rollback`, { contentHash })).json();
      },
      async remove(id) {
        await request("DELETE", idPath(id));
      }
    };
  }

  // src/host.ts
  var ADMIN_SECRET_STORAGE_KEY = "marinara_admin_secret";
  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  function readAdminSecret(storage) {
    try {
      const value = storage?.getItem(ADMIN_SECRET_STORAGE_KEY)?.trim();
      return value ? value : null;
    } catch {
      return null;
    }
  }
  function hostFromMarinara(api, fallbackName = "Fetchy") {
    const m = api ?? {};
    const id = typeof m.extension?.id === "string" ? m.extension.id : typeof m.extensionId === "string" ? m.extensionId : null;
    const name = typeof m.extension?.name === "string" ? m.extension.name : typeof m.extensionName === "string" ? m.extensionName : fallbackName;
    const prefix = `[${name}]`;
    const log2 = {
      debug: (...a) => (m.log?.debug ?? console.debug)(...m.log?.debug ? a : [prefix, ...a]),
      info: (...a) => (m.log?.info ?? console.info)(...m.log?.info ? a : [prefix, ...a]),
      warn: (...a) => (m.log?.warn ?? console.warn)(...m.log?.warn ? a : [prefix, ...a]),
      error: (...a) => (m.log?.error ?? console.error)(...m.log?.error ? a : [prefix, ...a])
    };
    const pageFetch = (input, init) => (m.fetch ?? window.fetch)(input, init);
    const cleanups = [];
    return {
      extensionId: id,
      extensionName: name,
      log: log2,
      fetch: pageFetch,
      storage: {
        async get() {
          if (!m.storage?.get) return {};
          return asRecord(await m.storage.get());
        },
        async patch(value) {
          if (!m.storage?.patch) throw new Error("marinara.storage is unavailable");
          return asRecord(await m.storage.patch(value));
        }
      },
      onCleanup(fn) {
        if (m.onCleanup) m.onCleanup(fn);
        else cleanups.push(fn);
      },
      adminSecret: () => readAdminSecret(typeof localStorage === "undefined" ? null : localStorage)
    };
  }

  // src/sources.ts
  var STORAGE_KEY = "sources";
  var SCHEMA_KEY = "schemaVersion";
  var SCHEMA_VERSION = 1;
  var isRecord2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  var str = (v) => typeof v === "string" ? v : null;
  function parseSource(value) {
    if (!isRecord2(value)) return null;
    if (value.kind === "github-repo" && typeof value.owner === "string" && typeof value.repo === "string") {
      return { kind: "github-repo", owner: value.owner, repo: value.repo, ref: str(value.ref), path: str(value.path) ?? "" };
    }
    if ((value.kind === "manifest-url" || value.kind === "zip-url") && typeof value.url === "string") {
      return { kind: value.kind, url: value.url };
    }
    return null;
  }
  var UPDATE_STATES = ["up-to-date", "update", "older", "changed", "unknown"];
  function parseLatest(value) {
    if (!isRecord2(value) || typeof value.hash !== "string" || typeof value.checkedAt !== "string") return null;
    const state = UPDATE_STATES.includes(value.state) ? value.state : "unknown";
    return { version: str(value.version), hash: value.hash, state, checkedAt: value.checkedAt };
  }
  function parseRecord(value) {
    if (!isRecord2(value)) return null;
    const source = parseSource(value.source);
    const id = str(value.id), extensionId = str(value.extensionId), name = str(value.name), installedHash = str(value.installedHash);
    if (!source || !id || !extensionId || !name || !installedHash) return null;
    return {
      id,
      source,
      name,
      extensionId,
      installedHash,
      input: str(value.input) ?? "",
      ref: str(value.ref),
      installedVersion: str(value.installedVersion),
      installedAt: str(value.installedAt) ?? "",
      lastCheckedAt: str(value.lastCheckedAt),
      latest: parseLatest(value.latest),
      lastError: str(value.lastError),
      autoApprove: value.autoApprove === true
    };
  }
  function newRecordId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  var SourcesStore = class {
    constructor(storage) {
      this.storage = storage;
    }
    storage;
    async load() {
      const data = await this.storage.get();
      const list = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
      return list.map(parseRecord).filter((r) => r !== null);
    }
    async save(records) {
      await this.storage.patch({ [SCHEMA_KEY]: SCHEMA_VERSION, [STORAGE_KEY]: records });
    }
    /** Inserts or replaces by installer id; a record for the same Marinara extension id is replaced too. */
    async upsert(record) {
      const records = (await this.load()).filter((r) => r.id !== record.id && r.extensionId !== record.extensionId);
      records.push(record);
      await this.save(records);
      return records;
    }
    async remove(id) {
      const records = (await this.load()).filter((r) => r.id !== id);
      await this.save(records);
      return records;
    }
  };

  // src/anchor.ts
  var SECTION_ID = "settings-section-external-extensions";
  var ANCHOR_BUTTON_ID = "me-fetchy-settings-button";
  var BUTTON_STYLE = [
    "display:flex",
    "min-height:2.75rem",
    "align-items:center",
    "justify-content:center",
    "gap:0.375rem",
    "width:100%",
    "border-radius:0.5rem",
    "border:1px solid var(--border, #444)",
    "background:var(--secondary, #2d2d3a)",
    "color:var(--foreground, inherit)",
    "padding:0 0.75rem",
    "font:inherit",
    "font-size:0.75rem",
    "cursor:pointer"
  ].join(";");
  function findImportButtonRow(section) {
    const firstButton = section.querySelector("button");
    return firstButton?.parentElement ?? section;
  }
  function mountAnchor(doc, label, onOpen) {
    const button = doc.createElement("button");
    button.type = "button";
    button.id = ANCHOR_BUTTON_ID;
    button.setAttribute("aria-haspopup", "dialog");
    button.textContent = label;
    button.addEventListener("click", onOpen);
    let scheduled = false;
    const place = () => {
      scheduled = false;
      const section = doc.getElementById(SECTION_ID);
      if (!section) {
        button.remove();
        return;
      }
      const row = findImportButtonRow(section);
      const neighbour = [...row.querySelectorAll("button")].find((b) => b !== button && b.className);
      if (neighbour) {
        if (button.className !== neighbour.className) button.className = neighbour.className;
        if (button.hasAttribute("style")) button.removeAttribute("style");
      } else if (!button.hasAttribute("style")) {
        button.setAttribute("style", BUTTON_STYLE);
      }
      if (button.parentElement !== row) row.appendChild(button);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16))(place);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(doc.body, { childList: true, subtree: true });
    place();
    return {
      get attached() {
        return button.isConnected;
      },
      destroy() {
        observer.disconnect();
        button.remove();
      }
    };
  }

  // src/audit.ts
  var AUDIT_LIMIT = 200;
  var KEY = "log";
  var isRecord3 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  var str2 = (v) => typeof v === "string" ? v : null;
  function parseSide(v) {
    if (!isRecord3(v)) return null;
    return { version: str2(v.version), hash: str2(v.hash), capabilities: Array.isArray(v.capabilities) ? v.capabilities.map(String) : [] };
  }
  function parseEntry(v) {
    if (!isRecord3(v) || typeof v.at !== "string" || typeof v.action !== "string" || typeof v.name !== "string") return null;
    return {
      at: v.at,
      action: v.action,
      name: v.name,
      result: v.result === "failed" || v.result === "refused" ? v.result : "ok",
      extensionId: str2(v.extensionId),
      source: str2(v.source),
      ref: str2(v.ref),
      from: parseSide(v.from),
      to: parseSide(v.to),
      detail: str2(v.detail)
    };
  }
  function scrub(text) {
    return text.replace(/x-admin-secret\s*[:=]\s*\S+/gi, "x-admin-secret: [redacted]").replace(/(authorization|token|secret|password)\s*[:=]\s*\S+/gi, "$1: [redacted]").slice(0, 300);
  }
  var AuditLog = class {
    constructor(storage, now = () => /* @__PURE__ */ new Date()) {
      this.storage = storage;
      this.now = now;
    }
    storage;
    now;
    async list() {
      const data = await this.storage.get();
      const raw = Array.isArray(data[KEY]) ? data[KEY] : [];
      return raw.map(parseEntry).filter((e) => e !== null);
    }
    /** Appends an entry (newest first) and drops the oldest beyond the limit. */
    async record(entry) {
      const full = { ...entry, at: entry.at ?? this.now().toISOString(), detail: entry.detail ? scrub(entry.detail) : null };
      const list = [full, ...await this.list()].slice(0, AUDIT_LIMIT);
      await this.storage.patch({ [KEY]: list });
      return full;
    }
    async clear() {
      await this.storage.patch({ [KEY]: [] });
    }
    /** Tab-separated text for export; one entry per line, newest first. */
    static format(entries2) {
      const side2 = (s) => s ? `v${s.version ?? "?"} ${s.hash ?? "-"} [${s.capabilities.join(",")}]` : "-";
      return [
        "at	action	result	extension	name	source	from	to	detail",
        ...entries2.map((e) => [e.at, e.action, e.result, e.extensionId ?? "-", e.name, e.source ? `${e.source}${e.ref ? `@${e.ref}` : ""}` : "-", side2(e.from), side2(e.to), e.detail ?? ""].join("	"))
      ].join("\n");
    }
  };

  // src/github.ts
  var SourceUrlError = class extends Error {
    constructor(reason, message) {
      super(message);
      this.reason = reason;
      this.name = "SourceUrlError";
    }
    reason;
  };
  var MANIFEST_NAMES = ["manifest.json", "marinara-extension.json", "marinara-extensions.json", "marinara-personal-extensions.json"];
  var MANIFEST_FILENAMES = MANIFEST_NAMES;
  var SEGMENT = /^[A-Za-z0-9_.-]+$/;
  function cleanPath(path) {
    return path.split("/").map((s) => s.trim()).filter((s) => s && s !== "." && s !== "..").join("/");
  }
  function stripManifestFilename(path) {
    const parts = cleanPath(path).split("/").filter(Boolean);
    const last = parts[parts.length - 1]?.toLowerCase();
    if (last && MANIFEST_NAMES.includes(last)) parts.pop();
    return parts.join("/");
  }
  function splitRef(text) {
    const at = text.lastIndexOf("@");
    if (at <= 0) return { body: text, ref: null };
    const ref = text.slice(at + 1).trim();
    return ref ? { body: text.slice(0, at), ref } : { body: text, ref: null };
  }
  function repoSource(owner, repo, ref, path) {
    if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
      throw new SourceUrlError("bad-github-path", `Not a GitHub owner/repo: ${owner}/${repo}`);
    }
    return { kind: "github-repo", owner, repo: repo.replace(/\.git$/i, ""), ref, path: stripManifestFilename(path) };
  }
  function fileSource(url) {
    const lower = url.pathname.toLowerCase();
    if (lower.endsWith(".zip")) return { kind: "zip-url", url: url.href };
    if (lower.endsWith(".json")) return { kind: "manifest-url", url: url.href };
    return null;
  }
  function parseSourceUrl(input) {
    const text = input.trim();
    if (!text) throw new SourceUrlError("empty", "Enter a URL");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const { body, ref } = splitRef(text);
      const parts = cleanPath(body).split("/").filter(Boolean);
      if (parts.length < 2) throw new SourceUrlError("unsupported", `Not a URL or owner/repo: ${text}`);
      const [owner, repo, ...rest] = parts;
      return repoSource(owner, repo, ref, rest.join("/"));
    }
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new SourceUrlError("unsupported", `Not a valid URL: ${text}`);
    }
    if (url.protocol !== "https:") throw new SourceUrlError("not-https", "Only https:// URLs are supported");
    const host = url.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") {
      const { body, ref: atRef } = splitRef(url.pathname);
      const parts = cleanPath(body).split("/").filter(Boolean);
      if (parts.length < 2) throw new SourceUrlError("bad-github-path", "A GitHub URL needs /owner/repo");
      const [owner, repo, mode, ref, ...rest] = parts;
      if (mode === "tree" || mode === "blob" || mode === "raw") {
        if (!ref) throw new SourceUrlError("bad-github-path", `A /${mode}/ URL needs a branch`);
        return repoSource(owner, repo, ref, rest.join("/"));
      }
      if (mode) throw new SourceUrlError("bad-github-path", `Unsupported GitHub URL (use the repository or a /tree/<branch>/ folder): ${text}`);
      return repoSource(owner, repo, atRef, "");
    }
    if (host === "raw.githubusercontent.com") {
      const parts = cleanPath(url.pathname).split("/").filter(Boolean);
      if (parts.length < 3) throw new SourceUrlError("bad-github-path", "A raw URL needs /owner/repo/branch/…");
      const [owner, repo, ...rest] = parts;
      let ref;
      if (rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags") && rest[2]) {
        ref = rest.splice(0, 3).join("/");
      } else {
        ref = rest.shift();
      }
      const file2 = fileSource(url);
      if (file2) return file2;
      return repoSource(owner, repo, ref, rest.join("/"));
    }
    const file = fileSource(url);
    if (file) return file;
    throw new SourceUrlError("unsupported", `Unsupported URL (use a GitHub repository, a manifest.json URL or a .zip URL): ${text}`);
  }
  function rawFileUrl(owner, repo, ref, path) {
    const encodedPath = cleanPath(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
    return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodedRef}/${encodedPath}`;
  }
  function directoryOf(fileUrl) {
    const url = new URL(fileUrl);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/[^/]*$/, "");
    return url.href;
  }
  function browseUrl(source, ref = null) {
    if (source.kind !== "github-repo") return source.url;
    const branch = ref ?? source.ref;
    const base = `https://github.com/${source.owner}/${source.repo}`;
    if (!branch) return base;
    return source.path ? `${base}/tree/${branch}/${source.path}` : `${base}/tree/${branch}`;
  }
  function describeSource(source) {
    if (source.kind !== "github-repo") return source.url;
    const at = source.ref ? `@${source.ref}` : "";
    return source.path ? `${source.owner}/${source.repo}/${source.path}${at}` : `${source.owner}/${source.repo}${at}`;
  }
  var normalizePath = cleanPath;

  // src/zip.ts
  var ZipError = class extends Error {
    constructor(message) {
      super(`zip: ${message}`);
      this.name = "ZipError";
    }
  };
  var fail = (why) => {
    throw new ZipError(why);
  };
  var MAX_ZIP_BYTES = 32 * 1024 * 1024;
  var MAX_ENTRIES = 8192;
  var EOCD = 101010256;
  var CENTRAL = 33639248;
  var LOCAL = 67324752;
  async function listZip(bytes) {
    if (bytes.byteLength > MAX_ZIP_BYTES) fail(`archive is larger than ${MAX_ZIP_BYTES} bytes`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let p2 = bytes.byteLength - 22; p2 >= Math.max(0, bytes.byteLength - 22 - 65535); p2--) {
      if (view.getUint32(p2, true) === EOCD) {
        eocd = p2;
        break;
      }
    }
    if (eocd < 0) fail("not a zip file");
    const count = view.getUint16(eocd + 10, true);
    const dirSize = view.getUint32(eocd + 12, true);
    const dirOffset = view.getUint32(eocd + 16, true);
    if (count > MAX_ENTRIES) fail("too many entries");
    if (dirOffset + dirSize > bytes.byteLength) fail("central directory out of range");
    const names = new TextDecoder();
    const entries2 = /* @__PURE__ */ new Map();
    let p = dirOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== CENTRAL) fail("bad central directory");
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const compressed = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const offset = view.getUint32(p + 42, true);
      if (p + 46 + nameLen > bytes.byteLength) fail("bad central directory");
      const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/").replace(/^\/+/, "");
      if (offset + 30 + compressed > bytes.byteLength) fail(`${name} lies past the end of the file`);
      if (name && !name.endsWith("/")) {
        if (entries2.has(name)) fail(`duplicate entry ${name}`);
        if (/^(\.\.?)(\/|$)|\/\.\.(\/|$)/.test(name)) fail(`unsafe entry name ${name}`);
        entries2.set(name, { name, method, compressed, size, crc, offset });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries2;
  }
  async function readZipEntry(bytes, entry, maxBytes) {
    if (entry.size > maxBytes) fail(`${entry.name} is too large (${entry.size} bytes)`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(entry.offset, true) !== LOCAL) fail(`bad local header for ${entry.name}`);
    const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
    if (start + entry.compressed > bytes.byteLength) fail(`${entry.name} lies past the end of the file`);
    const data = bytes.subarray(start, start + entry.compressed);
    let out;
    if (entry.method === 0) {
      if (entry.compressed !== entry.size) fail(`${entry.name}: stored size mismatch`);
      out = data.slice();
    } else if (entry.method === 8) {
      out = await inflate(data, entry);
    } else {
      return fail(`unsupported compression ${entry.method} for ${entry.name}`);
    }
    if (crc32(out) !== entry.crc) fail(`${entry.name} is corrupt (CRC mismatch)`);
    return out;
  }
  async function inflate(data, entry) {
    const out = new Uint8Array(entry.size);
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    let n = 0;
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (n + value.length > out.length) fail(`${entry.name} inflates past its stated size`);
        out.set(value, n);
        n += value.length;
      }
    } catch (e) {
      void reader.cancel().catch(() => {
      });
      if (e instanceof ZipError) throw e;
      fail(`${entry.name} is corrupt (${e instanceof Error ? e.message : String(e)})`);
    }
    if (n !== out.length) fail(`${entry.name} is shorter than its stated size`);
    return out;
  }
  var CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(data) {
    let c = 4294967295;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ c >>> 8;
    return (c ^ 4294967295) >>> 0;
  }

  // src/fetch-package.ts
  var FetchError = class extends Error {
    constructor(code, message, url, status = 0, tried = []) {
      super(message);
      this.code = code;
      this.url = url;
      this.status = status;
      this.tried = tried;
      this.name = "FetchError";
    }
    code;
    url;
    status;
    tried;
  };
  var DEFAULT_TIMEOUT_MS = 25e3;
  var DEFAULT_BUDGET_BYTES = 16 * 1024 * 1024;
  var README_NAMES = ["README-ko.md", "README.ko.md", "README_ko.md", "README-KO.md", "README.md", "readme.md", "README.txt"];
  var DEFAULT_BRANCHES = ["main", "master"];
  var MAX_README_BYTES = 200 * 1024;
  var Budget = class {
    constructor(limit) {
      this.limit = limit;
    }
    limit;
    used = 0;
    add(bytes, url) {
      this.used += bytes;
      if (this.used > this.limit) throw new FetchError("too-large", `package exceeds ${this.limit} bytes`, url);
    }
  };
  function withCacheBust(url, options) {
    if (!options.freshest) return url;
    const parsed = new URL(url);
    if (parsed.hostname !== "raw.githubusercontent.com") return url;
    parsed.searchParams.set("_", String((options.now ?? Date.now)()));
    return parsed.href;
  }
  async function fetchResponse(url, options, accept = "text/plain, application/json, */*") {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS) : null;
    let response;
    try {
      response = await options.fetch(withCacheBust(url, options), {
        cache: "no-store",
        redirect: "follow",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { Accept: accept },
        signal: controller?.signal
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new FetchError("timeout", `no answer within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`, url);
      throw new FetchError("network", e instanceof Error ? e.message : String(e), url);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (response.status === 404) return null;
    if ((response.status === 403 || response.status === 429) && new URL(url).hostname === "api.github.com") {
      throw new FetchError("rate-limited", `GitHub API ${response.status}`, url, response.status);
    }
    if (!response.ok) throw new FetchError("http", `HTTP ${response.status}`, url, response.status);
    return response;
  }
  async function fetchBytes(url, options, maxBytes, budget, accept) {
    const response = await fetchResponse(url, options, accept);
    if (!response) return null;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new FetchError("too-large", `${declared} bytes`, url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new FetchError("too-large", `${bytes.byteLength} bytes`, url);
    budget.add(bytes.byteLength, url);
    return bytes;
  }
  async function fetchText(url, options, maxBytes, budget) {
    const bytes = await fetchBytes(url, options, maxBytes, budget);
    return bytes === null ? null : new TextDecoder("utf-8").decode(bytes);
  }
  function parseJson(text, url) {
    try {
      return JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (e) {
      throw new FetchError("bad-json", e instanceof Error ? e.message : String(e), url);
    }
  }
  async function readme(read) {
    const seen = /* @__PURE__ */ new Set();
    for (const name of README_NAMES) {
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      try {
        const text = await read(name);
        if (text != null && text.trim()) return { path: name, text };
      } catch {
      }
    }
    return null;
  }
  async function defaultBranch(owner, repo, options, budget) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    try {
      const text = await fetchText(url, { ...options, freshest: false }, 256 * 1024, budget);
      if (text == null) return null;
      const info = JSON.parse(text);
      return typeof info.default_branch === "string" && info.default_branch ? info.default_branch : null;
    } catch {
      return null;
    }
  }
  async function readConsistently(manifestUrl, manifestText, reread, read) {
    let text = manifestText;
    for (let attempt = 0; attempt < 2; attempt++) {
      const manifest = parseJson(text, manifestUrl);
      const normalized = await normalizeManifest(manifest, read);
      const again = await reread();
      if (again === null) throw new FetchError("source-changed", "the manifest disappeared during the download", manifestUrl);
      if (again === text) return { manifest, normalized, manifestText: text };
      text = again;
    }
    throw new FetchError("source-changed", "the manifest kept changing during the download", manifestUrl);
  }
  async function fromGithub(source, options) {
    const budget = new Budget(options.budgetBytes ?? DEFAULT_BUDGET_BYTES);
    const dir = normalizePath(source.path);
    const tried = [];
    const candidates = source.ref ? [source.ref] : [...DEFAULT_BRANCHES];
    for (let i = 0; i < candidates.length; i++) {
      const ref = candidates[i];
      tried.push(ref);
      for (const filename of MANIFEST_FILENAMES) {
        const manifestUrl = rawFileUrl(source.owner, source.repo, ref, dir ? `${dir}/${filename}` : filename);
        const readManifest = () => fetchText(manifestUrl, options, LIMITS.textFileBytes, budget);
        const text = await readManifest();
        if (text == null) continue;
        const read = async (path) => {
          const clean = normalizePath(path);
          if (!clean) return null;
          for (const candidate of dir ? [`${dir}/${clean}`, clean] : [clean]) {
            const found = await fetchText(rawFileUrl(source.owner, source.repo, ref, candidate), options, LIMITS.textFileBytes, budget);
            if (found != null) return found;
          }
          return null;
        };
        const { manifest, normalized } = await readConsistently(manifestUrl, text, readManifest, read);
        return {
          source,
          ref,
          manifestUrl,
          manifest,
          normalized,
          browseUrl: browseUrl(source, ref),
          readme: await readme((name) => fetchText(rawFileUrl(source.owner, source.repo, ref, dir ? `${dir}/${name}` : name), options, MAX_README_BYTES, budget)),
          downloadedBytes: budget.used
        };
      }
      if (!source.ref && i === candidates.length - 1 && candidates.length === DEFAULT_BRANCHES.length) {
        const branch = await defaultBranch(source.owner, source.repo, options, budget);
        if (branch && !candidates.includes(branch)) candidates.push(branch);
      }
    }
    const where = dir ? `${source.owner}/${source.repo}/${dir}` : `${source.owner}/${source.repo}`;
    throw new FetchError("manifest-not-found", `No manifest.json in ${where} (tried ${tried.join(", ")})`, browseUrl(source), 404, tried);
  }
  async function fromManifestUrl(source, options) {
    const budget = new Budget(options.budgetBytes ?? DEFAULT_BUDGET_BYTES);
    const readManifest = () => fetchText(source.url, options, LIMITS.textFileBytes, budget);
    const text = await readManifest();
    if (text == null) throw new FetchError("manifest-not-found", `HTTP 404`, source.url, 404);
    const base = directoryOf(source.url);
    const resolve = (path) => new URL(normalizePath(path), base).href;
    const read = async (path) => normalizePath(path) ? fetchText(resolve(path), options, LIMITS.textFileBytes, budget) : null;
    const { manifest, normalized } = await readConsistently(source.url, text, readManifest, read);
    return {
      source,
      ref: null,
      manifestUrl: source.url,
      manifest,
      normalized,
      browseUrl: source.url,
      readme: await readme((name) => fetchText(resolve(name), options, MAX_README_BYTES, budget)),
      downloadedBytes: budget.used
    };
  }
  function pickManifestEntry(entries2) {
    const candidates = [...entries2.values()].filter((e) => MANIFEST_FILENAMES.includes(e.name.split("/").pop()?.toLowerCase() ?? ""));
    if (candidates.length === 0) throw new FetchError("manifest-not-found", "The zip contains no manifest.json", "", 0);
    const depth = (e) => e.name.split("/").length;
    const rootNamed = (e) => (e.name.split("/").pop()?.toLowerCase() ?? "") !== "manifest.json";
    candidates.sort((a, b) => depth(a) - depth(b) || Number(rootNamed(b)) - Number(rootNamed(a)) || a.name.localeCompare(b.name));
    return candidates[0];
  }
  async function fromZip(source, options) {
    const budget = new Budget(Math.max(options.budgetBytes ?? DEFAULT_BUDGET_BYTES, MAX_ZIP_BYTES));
    const bytes = await fetchBytes(source.url, options, MAX_ZIP_BYTES, budget, "application/zip, application/octet-stream, */*");
    if (!bytes) throw new FetchError("manifest-not-found", "HTTP 404", source.url, 404);
    let entries2;
    let manifestEntry;
    try {
      entries2 = await listZip(bytes);
      manifestEntry = pickManifestEntry(entries2);
    } catch (e) {
      if (e instanceof FetchError) throw e;
      throw new FetchError("bad-zip", e instanceof Error ? e.message : String(e), source.url);
    }
    const byLowerName = new Map([...entries2.values()].map((e) => [e.name.toLowerCase(), e]));
    const dir = manifestEntry.name.includes("/") ? manifestEntry.name.replace(/\/[^/]*$/, "") : "";
    const decoder = new TextDecoder("utf-8");
    const readEntry = async (entry, maxBytes) => {
      try {
        return decoder.decode(await readZipEntry(bytes, entry, maxBytes));
      } catch (e) {
        throw new FetchError("bad-zip", e instanceof Error ? e.message : String(e), source.url);
      }
    };
    const lookup = (path) => {
      const clean = normalizePath(path);
      if (!clean) return null;
      for (const candidate of dir ? [`${dir}/${clean}`, clean] : [clean]) {
        const entry = byLowerName.get(candidate.toLowerCase());
        if (entry) return entry;
      }
      return null;
    };
    const read = async (path) => {
      const entry = lookup(path);
      return entry ? readEntry(entry, LIMITS.textFileBytes) : null;
    };
    const manifestUrl = `${source.url}!/${manifestEntry.name}`;
    const manifest = parseJson(await readEntry(manifestEntry, LIMITS.textFileBytes), manifestUrl);
    const normalized = await normalizeManifest(manifest, read);
    return {
      source,
      ref: null,
      manifest,
      normalized,
      manifestUrl,
      browseUrl: source.url,
      readme: await readme(async (name) => {
        const entry = lookup(name);
        return entry ? readEntry(entry, MAX_README_BYTES) : null;
      }),
      downloadedBytes: budget.used
    };
  }
  async function fetchPackage(source, options) {
    switch (source.kind) {
      case "github-repo":
        return fromGithub(source, options);
      case "manifest-url":
        return fromManifestUrl(source, options);
      case "zip-url":
        return fromZip(source, options);
    }
  }

  // src/sha256.ts
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var rotr = (x, n) => x >>> n | x << 32 - n;
  function sha256Bytes(data) {
    const bitLength = data.byteLength * 8;
    const paddedLength = Math.ceil((data.byteLength + 9) / 64) * 64;
    const block = new Uint8Array(paddedLength);
    block.set(data);
    block[data.byteLength] = 128;
    const view = new DataView(block.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296));
    view.setUint32(paddedLength - 4, bitLength >>> 0);
    const h = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
      for (let t = 16; t < 64; t++) {
        const w15 = w[t - 15], w2 = w[t - 2];
        const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ w15 >>> 3;
        const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ w2 >>> 10;
        w[t] = w[t - 16] + s0 + w[t - 7] + s1 >>> 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3];
      let e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let t = 0; t < 64; t++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = e & f ^ ~e & g;
        const temp1 = hh + S1 + ch + K[t] + w[t] >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = a & b ^ a & c ^ b & c;
        const temp2 = S0 + maj >>> 0;
        hh = g;
        g = f;
        f = e;
        e = d + temp1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2 >>> 0;
      }
      h[0] = h[0] + a;
      h[1] = h[1] + b;
      h[2] = h[2] + c;
      h[3] = h[3] + d;
      h[4] = h[4] + e;
      h[5] = h[5] + f;
      h[6] = h[6] + g;
      h[7] = h[7] + hh;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
    return out;
  }
  var toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  function digestBackend() {
    return typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function" ? "webcrypto" : "javascript";
  }
  async function digestHex(data, backend = digestBackend()) {
    if (backend === "webcrypto") {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      try {
        return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)));
      } catch {
      }
    }
    return toHex(sha256Bytes(data));
  }

  // src/hash.ts
  var encoder = new TextEncoder();
  async function sha256Hex(text) {
    return digestHex(typeof text === "string" ? encoder.encode(text) : text);
  }
  function engineHashPayload(draft) {
    const payload = draft.runtime === "server" ? ["server", "", "", draft.serverJs ?? ""] : ["client", draft.css ?? "", draft.js ?? "", ""];
    const capabilities = draft.runtime === "server" ? [] : CAPABILITY_ORDER.filter((c) => draft.capabilities.includes(c));
    if (capabilities.length > 0) payload.push(capabilities);
    return JSON.stringify(payload);
  }
  async function engineContentHash(draft) {
    return `sha256:${await sha256Hex(engineHashPayload(draft))}`;
  }

  // src/diff.ts
  var CODE_ROLES = ["css", "js", "serverJs"];
  var encoder2 = new TextEncoder();
  var splitLines = (text) => text.split(/\r?\n/);
  function lineDelta(before, after) {
    const counts = /* @__PURE__ */ new Map();
    for (const line of splitLines(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
    let added = 0;
    for (const line of splitLines(after)) {
      const n = counts.get(line) ?? 0;
      if (n > 0) counts.set(line, n - 1);
      else added++;
    }
    let removed = 0;
    for (const n of counts.values()) removed += n;
    return { added, removed };
  }
  async function side(text) {
    if (text === null) return null;
    return { bytes: encoder2.encode(text).byteLength, lines: text ? splitLines(text).length : 0, sha256: await sha256Hex(text) };
  }
  async function compareCode(before, after) {
    const changes = [];
    for (const role of CODE_ROLES) {
      const a = before?.[role] ?? null;
      const b = after[role] ?? null;
      if (a === null && b === null) continue;
      const [beforeSide, afterSide] = await Promise.all([side(a), side(b)]);
      const changed = (beforeSide?.sha256 ?? null) !== (afterSide?.sha256 ?? null);
      const delta = changed ? lineDelta(a ?? "", b ?? "") : { added: 0, removed: 0 };
      changes.push({ role, before: beforeSide, after: afterSide, ...delta, changed });
    }
    return changes;
  }

  // src/version.ts
  function numericParts(value) {
    if (!value) return null;
    const normalized = value.trim().replace(/^v/i, "");
    if (!/^\d+(?:\.\d+)*$/.test(normalized)) return null;
    return normalized.split(".").map((part) => Number.parseInt(part, 10));
  }
  function compareVersions(left, right) {
    const a = numericParts(left), b = numericParts(right);
    if (!a || !b) return null;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const delta = (a[i] ?? 0) - (b[i] ?? 0);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    }
    return 0;
  }
  function updateState(installed, latest) {
    const cmp = compareVersions(latest.version, installed.version);
    if (cmp === 1) return "update";
    if (cmp === -1) return "older";
    if (installed.hash && latest.hash) return installed.hash === latest.hash ? "up-to-date" : "changed";
    if (cmp === 0) return "up-to-date";
    return "unknown";
  }

  // src/installer.ts
  async function autoApprove(previous, before, after, draft, deps) {
    if (!previous?.autoApprove && !deps.approveNow) return { approved: false, notApproved: "off", approveError: null };
    if (!before.enabled) return { approved: false, notApproved: "was-off", approveError: null };
    const grew = draft.capabilities.filter((c) => !before.capabilities.includes(c));
    if (grew.length) {
      await log(deps, { action: "approve", result: "refused", extensionId: after.id, name: after.name, source: previous?.input ?? null, ref: previous?.ref ?? null, from: sideOf(before), to: sideOf(after), detail: `capabilities grew: ${grew.join(", ")}; manual approval required` });
      return { approved: false, notApproved: "capabilities-grew", approveError: null };
    }
    try {
      const approved = await deps.client.approve(after.id, after.contentHash, draft.capabilities.includes(FULL_PAGE_ACCESS));
      await log(deps, { action: "approve", result: "ok", extensionId: after.id, name: after.name, source: previous?.input ?? null, ref: previous?.ref ?? null, from: sideOf(before), to: sideOf(approved), detail: previous?.autoApprove ? "auto re-approval (user opt-in)" : "kept on (bulk update, user choice)" });
      return { approved: approved.enabled && approved.approvedHash === after.contentHash, notApproved: null, approveError: null };
    } catch (e) {
      await log(deps, { action: "approve", result: "failed", extensionId: after.id, name: after.name, source: previous?.input ?? null, ref: previous?.ref ?? null, from: sideOf(before), to: sideOf(after), detail: e instanceof Error ? e.message : String(e) });
      return { approved: false, notApproved: "failed", approveError: e instanceof Error ? e.message : String(e) };
    }
  }
  var NO_APPROVAL = { approved: false, notApproved: null, approveError: null };
  var InstallError = class extends Error {
    constructor(problem, message) {
      super(message);
      this.problem = problem;
      this.name = "InstallError";
    }
    problem;
  };
  var sameSource = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  var sideOf = (x, hash) => x ? { version: x.version, hash: hash ?? x.contentHash ?? null, capabilities: [...x.capabilities] } : null;
  async function log(deps, entry) {
    try {
      await deps.audit?.record(entry);
    } catch {
    }
  }
  var sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  var nowOf = (deps) => (deps.now ?? (() => /* @__PURE__ */ new Date()))();
  async function digest(draft, files) {
    const textFor = (role) => (role === "js" ? draft.js : role === "css" ? draft.css : draft.serverJs) ?? "";
    const byRole = /* @__PURE__ */ new Map();
    for (const file of files) {
      if (!byRole.has(file.role)) byRole.set(file.role, await sha256Hex(textFor(file.role)));
    }
    return files.map((file) => ({ ...file, sha256: byRole.get(file.role) ?? "" }));
  }
  async function engineView(client, draft, contentHash, tracked, extensionId) {
    let list;
    try {
      list = await client.list();
    } catch (e) {
      return { view: null, error: e instanceof EngineApiError ? e : new EngineApiError("http", 0, String(e)) };
    }
    const record = (extensionId ? list.find((x) => x.id === extensionId) : null) ?? (tracked ? list.find((x) => x.id === tracked.extensionId) : null) ?? list.find((x) => sameName(x.name, draft.name)) ?? null;
    if (!record) return { view: null, error: null };
    return {
      error: null,
      view: {
        record,
        sameCode: record.contentHash === contentHash,
        editedInMarinara: tracked !== null && tracked.extensionId === record.id && tracked.installedHash !== record.contentHash,
        runtimeDiffers: record.runtime !== draft.runtime,
        nameDiffers: !sameName(record.name, draft.name),
        capabilitiesAdded: draft.capabilities.filter((c) => !record.capabilities.includes(c)),
        capabilitiesRemoved: record.capabilities.filter((c) => !draft.capabilities.includes(c)),
        changes: await compareCode(record, draft)
      }
    };
  }
  async function prepare(input, deps, options = {}) {
    const source = parseSourceUrl(input);
    const pkg = await fetchPackage(source, { fetch: deps.fetch, freshest: options.freshest });
    const draft = pkg.normalized.draft;
    const contentHash = await engineContentHash(draft);
    const records = await deps.store.load();
    const tracked = (options.extensionId ? records.find((r) => r.extensionId === options.extensionId) : null) ?? records.find((r) => sameSource(r.source, source)) ?? records.find((r) => sameName(r.name, draft.name)) ?? null;
    const { view, error } = await engineView(deps.client, draft, contentHash, tracked, options.extensionId ?? null);
    return {
      input: input.trim(),
      source,
      pkg,
      draft,
      contentHash,
      files: await digest(draft, pkg.normalized.files),
      fullPageAccess: draft.capabilities.includes(FULL_PAGE_ACCESS),
      tracked,
      engine: view,
      engineListError: error
    };
  }
  function recordFrom(prepared, extension, previous, now, installedHash) {
    const iso = now.toISOString();
    const state = installedHash === prepared.contentHash ? "up-to-date" : updateState({ version: extension.version, hash: installedHash }, { version: prepared.draft.version, hash: prepared.contentHash });
    return {
      id: previous?.id ?? newRecordId(),
      input: prepared.input,
      source: prepared.source,
      ref: prepared.pkg.ref,
      name: extension.name,
      extensionId: extension.id,
      installedVersion: extension.version ?? null,
      installedHash,
      installedAt: iso,
      lastCheckedAt: iso,
      latest: { version: prepared.draft.version, hash: prepared.contentHash, state, checkedAt: iso },
      lastError: null,
      autoApprove: previous?.autoApprove === true
    };
  }
  async function verifyAnswer(prepared, extension, codeChanged) {
    if (extension.contentHash !== prepared.contentHash) {
      throw new InstallError("unexpected-result", `Marinara stored ${extension.contentHash}, expected ${prepared.contentHash}`);
    }
    if (codeChanged && extension.enabled) {
      throw new InstallError("unexpected-result", "Marinara reports the extension as still enabled after a code change");
    }
  }
  async function install(prepared, deps, mode) {
    const action = mode.kind === "create" ? "install" : mode.kind;
    const base = {
      action,
      extensionId: mode.kind === "create" ? null : mode.extensionId,
      name: prepared.draft.name,
      source: prepared.input,
      ref: prepared.pkg.ref,
      from: sideOf(prepared.engine?.record ?? null),
      to: sideOf({ version: prepared.draft.version, capabilities: prepared.draft.capabilities }, prepared.contentHash)
    };
    try {
      const result = await installUnlogged(prepared, deps, mode);
      if (result.self) return result;
      await log(deps, { ...base, action: result.mode.kind === "create" ? "install" : result.mode.kind, extensionId: result.extension.id, result: "ok", detail: null, to: sideOf(result.extension) });
      return result;
    } catch (e) {
      const refused = e instanceof InstallError;
      await log(deps, { ...base, result: refused ? "refused" : "failed", detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      throw e;
    }
  }
  async function installUnlogged(prepared, deps, mode) {
    const now = nowOf(deps);
    const previous = prepared.tracked ?? (mode.kind !== "create" ? (await deps.store.load()).find((r) => r.extensionId === mode.extensionId) ?? null : null);
    if (mode.kind === "create") {
      const extension2 = await deps.client.create(prepared.draft);
      await verifyAnswer(prepared, extension2, true);
      const record2 = recordFrom(prepared, extension2, previous, now, extension2.contentHash);
      await deps.store.upsert(record2);
      return { record: record2, extension: extension2, mode, codeChanged: true, self: false, ...NO_APPROVAL };
    }
    const current = (await deps.client.list()).find((x) => x.id === mode.extensionId) ?? null;
    if (!current) throw new EngineApiError("not-found", 404, `Marinara has no extension ${mode.extensionId}`);
    if (mode.kind === "link") {
      const record2 = recordFrom(prepared, current, previous, now, current.contentHash);
      await deps.store.upsert(record2);
      return { record: record2, extension: current, mode, codeChanged: false, self: false, ...NO_APPROVAL };
    }
    if (prepared.engine && prepared.engine.record.id === current.id && prepared.engine.record.contentHash !== current.contentHash) {
      throw new InstallError("record-changed", `the extension's code changed since the preview (${prepared.engine.record.contentHash} → ${current.contentHash})`);
    }
    if (current.runtime !== prepared.draft.runtime) {
      throw new InstallError("runtime-changed", `${current.runtime} → ${prepared.draft.runtime}`);
    }
    if (current.contentHash === prepared.contentHash) {
      const record2 = recordFrom(prepared, current, previous, now, current.contentHash);
      await deps.store.upsert(record2);
      return { record: record2, extension: current, mode: { kind: "link", extensionId: current.id }, codeChanged: false, self: false, ...NO_APPROVAL };
    }
    const isSelf = deps.selfId != null && current.id === deps.selfId;
    if (isSelf) {
      const expected = recordFrom(prepared, { ...current, version: prepared.draft.version, contentHash: prepared.contentHash }, previous, now, prepared.contentHash);
      await deps.store.upsert(expected);
      await log(deps, {
        action: "update",
        result: "ok",
        extensionId: current.id,
        name: prepared.draft.name,
        source: prepared.input,
        ref: prepared.pkg.ref,
        from: sideOf(current),
        to: sideOf({ version: prepared.draft.version, capabilities: prepared.draft.capabilities }, prepared.contentHash),
        detail: "self-update: recorded before the PATCH; Fetchy is switched off until the new code is approved"
      });
      let extension2;
      try {
        extension2 = await deps.client.update(current.id, prepared.draft);
      } catch (e) {
        if (previous) await deps.store.upsert(previous);
        else await deps.store.remove(expected.id);
        await log(deps, { action: "update", result: "failed", extensionId: current.id, name: prepared.draft.name, source: prepared.input, ref: prepared.pkg.ref, from: sideOf(current), to: null, detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      await verifyAnswer(prepared, extension2, true);
      const approval2 = await autoApprove(previous, current, extension2, prepared.draft, { client: deps.client, approveNow: deps.approveNow });
      return { record: expected, extension: extension2, mode, codeChanged: true, self: true, ...approval2 };
    }
    const extension = await deps.client.update(current.id, prepared.draft);
    await verifyAnswer(prepared, extension, true);
    const approval = await autoApprove(previous, current, extension, prepared.draft, deps);
    const record = { ...recordFrom(prepared, extension, previous, now, extension.contentHash), autoApprove: previous?.autoApprove === true };
    await deps.store.upsert(record);
    return { record, extension, mode, codeChanged: true, self: false, ...approval };
  }
  function pinned(record) {
    return record.source.kind === "github-repo" && record.ref && !record.source.ref ? { ...record.source, ref: record.ref } : record.source;
  }
  async function checkSource(record, deps) {
    const now = nowOf(deps).toISOString();
    try {
      const pkg = await fetchPackage(pinned(record), { fetch: deps.fetch, freshest: true });
      const hash = await engineContentHash(pkg.normalized.draft);
      const state = updateState(
        { version: record.installedVersion, hash: record.installedHash },
        { version: pkg.normalized.draft.version, hash }
      );
      if (state !== "up-to-date" && (record.latest?.hash !== hash || record.latest?.state !== state)) {
        await log(deps, {
          action: "check",
          result: "ok",
          extensionId: record.extensionId,
          name: record.name,
          source: record.input,
          ref: record.ref,
          from: { version: record.installedVersion, hash: record.installedHash, capabilities: [] },
          to: sideOf({ version: pkg.normalized.draft.version, capabilities: pkg.normalized.draft.capabilities }, hash),
          detail: state
        });
      }
      return { ...record, lastCheckedAt: now, lastError: null, latest: { version: pkg.normalized.draft.version, hash, state, checkedAt: now } };
    } catch (e) {
      return { ...record, lastCheckedAt: now, lastError: e instanceof Error ? e.message : String(e) };
    }
  }
  async function checkAll(deps, options = {}) {
    const records = await deps.store.load();
    const checked = new Array(records.length);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < records.length) {
        const index = next++;
        const result = await checkSource(records[index], deps);
        checked[index] = result;
        options.onProgress?.(++done, records.length, result);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, records.length)) }, worker));
    await deps.store.save(checked);
    return checked;
  }
  async function updateSource(record, deps) {
    const pkg = await fetchPackage(pinned(record), { fetch: deps.fetch, freshest: true });
    const draft = pkg.normalized.draft;
    const contentHash = await engineContentHash(draft);
    const { view, error } = await engineView(deps.client, draft, contentHash, record, record.extensionId);
    const prepared = {
      input: record.input,
      source: record.source,
      pkg,
      draft,
      contentHash,
      files: await digest(draft, pkg.normalized.files),
      fullPageAccess: draft.capabilities.includes(FULL_PAGE_ACCESS),
      tracked: record,
      engine: view,
      engineListError: error
    };
    return install(prepared, deps, { kind: "update", extensionId: record.extensionId });
  }
  async function updateAll(deps, options = {}) {
    const due = (await deps.store.load()).filter((r) => r.latest && (r.latest.state === "update" || r.latest.state === "changed" || r.latest.state === "older"));
    const results = [];
    let done = 0;
    for (const record of due) {
      let result;
      try {
        result = await updateSource(record, { ...deps, approveNow: options.keepEnabled === true });
      } catch (e) {
        result = e instanceof Error ? e : new Error(String(e));
      }
      results.push({ record, result });
      options.onProgress?.(++done, due.length, record, result);
      if (!(result instanceof Error) && result.self) break;
    }
    return results;
  }
  async function rollbackSource(record, contentHash, deps) {
    let extension;
    try {
      extension = await deps.client.rollback(record.extensionId, contentHash);
    } catch (e) {
      await log(deps, { action: "rollback", result: "failed", extensionId: record.extensionId, name: record.name, source: record.input, ref: record.ref, from: { version: record.installedVersion, hash: record.installedHash, capabilities: [] }, to: { version: null, hash: contentHash, capabilities: [] }, detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    await log(deps, { action: "rollback", result: "ok", extensionId: extension.id, name: extension.name, source: record.input, ref: record.ref, from: { version: record.installedVersion, hash: record.installedHash, capabilities: [] }, to: sideOf(extension), detail: null });
    const now = nowOf(deps).toISOString();
    const latest = record.latest ? { ...record.latest, state: updateState({ version: extension.version, hash: extension.contentHash }, { version: record.latest.version, hash: record.latest.hash }) } : null;
    const updated = { ...record, installedVersion: extension.version, installedHash: extension.contentHash, installedAt: now, latest };
    await deps.store.upsert(updated);
    return { record: updated, extension };
  }
  async function forgetSource(record, deps, deleteFromEngine) {
    const entry = { action: deleteFromEngine ? "delete" : "forget", extensionId: record.extensionId, name: record.name, source: record.input, ref: record.ref, from: { version: record.installedVersion, hash: record.installedHash, capabilities: [] }, to: null };
    if (deleteFromEngine) {
      try {
        await deps.client.remove(record.extensionId);
      } catch (e) {
        if (!(e instanceof EngineApiError && e.code === "not-found")) {
          await log(deps, { ...entry, result: "failed", detail: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      }
    }
    await deps.store.remove(record.id);
    await log(deps, { ...entry, result: "ok", detail: null });
  }
  async function reconcile(deps) {
    const records = await deps.store.load();
    if (records.length === 0) return [];
    const list = await deps.client.list();
    const byId = new Map(list.map((x) => [x.id, x]));
    const now = nowOf(deps).toISOString();
    const changed = [];
    const next = records.map((record) => {
      const engine = byId.get(record.extensionId);
      if (!engine) {
        if (record.lastError?.startsWith("missing:")) return record;
        const marked = { ...record, lastError: `missing: Marinara no longer has extension ${record.extensionId}` };
        changed.push(marked);
        return marked;
      }
      if (engine.contentHash !== record.installedHash && record.latest && record.latest.hash === engine.contentHash) {
        const completed = { ...record, installedVersion: engine.version, installedHash: engine.contentHash, installedAt: engine.updatedAt || now, latest: { ...record.latest, state: "up-to-date" }, lastError: null };
        changed.push(completed);
        void log(deps, { action: "update", result: "ok", extensionId: engine.id, name: engine.name, source: record.input, ref: record.ref, from: { version: record.installedVersion, hash: record.installedHash, capabilities: [] }, to: sideOf(engine), detail: "completed after an interrupted update (reconciled on open)" });
        return completed;
      }
      return record;
    });
    if (changed.length) await deps.store.save(next);
    return changed;
  }
  async function setAutoApprove(record, value, deps) {
    const updated = { ...record, autoApprove: value };
    await deps.store.upsert(updated);
    await log(deps, { action: "approve", result: "ok", extensionId: record.extensionId, name: record.name, source: record.input, ref: record.ref, from: null, to: null, detail: value ? "auto re-approval switched on by the user" : "auto re-approval switched off" });
    return updated;
  }
  async function disableExtension(extension, deps) {
    try {
      const result = await deps.client.disable(extension.id);
      await log(deps, { action: "disable", result: "ok", extensionId: extension.id, name: extension.name, source: null, ref: null, from: sideOf(extension), to: sideOf(result), detail: null });
      return result;
    } catch (e) {
      await log(deps, { action: "disable", result: "failed", extensionId: extension.id, name: extension.name, source: null, ref: null, from: sideOf(extension), to: null, detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
  async function deleteExtension(extension, deps) {
    const record = (await deps.store.load()).find((r) => r.extensionId === extension.id);
    if (record) return forgetSource(record, deps, true);
    try {
      await deps.client.remove(extension.id);
    } catch (e) {
      if (!(e instanceof EngineApiError && e.code === "not-found")) {
        await log(deps, { action: "delete", result: "failed", extensionId: extension.id, name: extension.name, source: null, ref: null, from: sideOf(extension), to: null, detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    }
    await log(deps, { action: "delete", result: "ok", extensionId: extension.id, name: extension.name, source: null, ref: null, from: sideOf(extension), to: null, detail: null });
  }
  async function overview(deps) {
    const [list, records] = await Promise.all([deps.client.list(), deps.store.load()]);
    const byExtension = new Map(records.map((r) => [r.extensionId, r]));
    const rows = list.filter((x) => x.source !== "professor_mari").map((extension) => ({ extension, record: byExtension.get(extension.id) ?? null }));
    const known = new Set(list.map((x) => x.id));
    for (const record of records) if (!known.has(record.extensionId)) rows.push({ extension: null, record });
    return rows;
  }
  function exportSources(records) {
    return JSON.stringify({ kind: "me-fetchy.sources", version: 1, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), sources: records }, null, 2);
  }
  async function importSources(json, store) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new SyntaxError("not JSON");
    }
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.sources) ? parsed.sources : null;
    if (!list) throw new SyntaxError("not an exported source list");
    const incoming = list.map(parseRecord).filter((r) => r !== null);
    const existing = await store.load();
    const byExtension = new Map(existing.map((r) => [r.extensionId, r]));
    for (const record of incoming) byExtension.set(record.extensionId, { ...record, id: byExtension.get(record.extensionId)?.id ?? record.id });
    await store.save([...byExtension.values()]);
    return { imported: incoming.length, ignored: list.length - incoming.length };
  }

  // src/errors.ts
  function describeError(error, t, context = {}) {
    if (error instanceof SourceUrlError) {
      return t(`error.url.${error.reason}`, { message: error.message });
    }
    if (error instanceof FetchError) {
      return t(`error.fetch.${error.code}`, { url: error.url, status: error.status, message: error.message });
    }
    if (error instanceof ManifestError) {
      const p = error.problem;
      const params = {};
      for (const [key, value] of Object.entries(p)) {
        if (key === "code") continue;
        params[key] = Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value);
      }
      return t(`error.manifest.${p.code}`, params);
    }
    if (error instanceof InstallError) {
      return t(`error.install.${error.problem}`, { message: error.message });
    }
    if (error instanceof EngineApiError) {
      return t(`error.engine.${error.code}`, { message: error.message, status: error.status, name: context.name ?? "" });
    }
    return t("error.unknown", { message: error instanceof Error ? error.message : String(error) });
  }

  // src/i18n.ts
  var en = {
    "title": "Fetchy",
    "subtitle": "extension installer for Marinara",
    "launcher": "Extensions",
    "launcher.title": "Install Marinara extensions from a GitHub URL",
    "close": "Close",
    "lang.switch": "한국어",
    "security.note": "Fetchy never runs downloaded code; it stores it in Marinara switched off. To turn it on, open Settings → Addons → External Extensions and approve it with Review and Run.",
    "gate.loading": "Checking External Extension gates…",
    "gate.open": "External Extensions are allowed.",
    "gate.env": "External Extensions are locked. Set ENABLE_EXTERNAL_EXTENSIONS=true in the server .env and restart Marinara.",
    "gate.switch": "External Extensions are locked. Turn on “Allow third-party extension imports” in Settings → Addons → External Extensions.",
    "gate.unknown": "Could not read the gate state ({error}).",
    "install.heading": "Install",
    "install.placeholder": "GitHub address (e.g. FigCake/ME.Fetchy)",
    "install.fetch": "Check",
    "install.fetching": "Checking…",
    "install.help": "A repository address, a manifest.json address or a zip address.",
    "preview.heading": "What will be installed",
    "preview.source": "Source",
    "preview.branch": "Branch",
    "preview.name": "Name",
    "preview.version": "Version",
    "preview.description": "Description",
    "preview.runtime": "Runtime",
    "preview.runtime.client": "Browser (client)",
    "preview.runtime.server": "Server",
    "preview.capabilities": "Capabilities",
    "preview.capabilities.none": "none (sandboxed)",
    "preview.files": "Files",
    "preview.hash": "Marinara content hash",
    "preview.hash.hint": "Must match the hash on the Review and Run screen.",
    "preview.readme": "README",
    "preview.none": "—",
    "preview.tracked": "Already tracked: {name} (v{version}). Installing will update that record.",
    "warn.fullPage": "Full page access: this extension can read and change everything on the Marinara page, API keys and chats included. Install it only if you trust the author and have read the code.",
    "warn.server": "Server runtime: the code runs in a sandboxed Node process on the Marinara host. Marinara refuses to approve it without a supported OS sandbox.",
    "warn.legacyKind": 'Legacy package (kind "marinara.extension" without capabilities): Marinara treats it as full page access.',
    "warn.versionDropped": 'The manifest version "{value}" is not a valid version (max 64 characters) and will be stored as empty.',
    "warn.unknownCaps": "Unknown capabilities ignored: {values}",
    "action.install": "Install",
    "action.update": "Update existing extension",
    "action.updateTracked": "Update {name}",
    "action.cancel": "Cancel",
    "action.busy": "Working…",
    "action.open": "Open source",
    "action.check": "Check for updates",
    "action.checkAll": "Check all",
    "result.selfUpdatedOn": "Updated Fetchy and switched it back on.",
    "action.updateAll": "Update all",
    "option.keepEnabled": "Keep updated extensions on",
    "help.keepEnabled": "Whenever an extension that was on gets updated, here or with Update all, approve the new code and switch it back on right away, without reading it. Not applied when the new version asks for new capabilities.",
    "keep.confirm.title": "Keep updated extensions on?",
    "keep.confirm.body": "Fetchy will approve updated code and switch extensions back on without you reading it, for every update made here. Code published by those repositories will then run in your Marinara as soon as you press Update. Versions that ask for new capabilities are never approved this way.",
    "result.updatedAll": "Updated {ok} of {total}.",
    "result.updatedAllOne": "{name}: {text}",
    "result.nothingToUpdate": 'Nothing to update. Press "Check all" first.',
    "action.forget": "Remove",
    "action.forget.listOnly": "Remove from this list only",
    "action.forget.engine": "Also delete from Marinara",
    "action.confirmForget": 'Remove "{name}"?',
    "result.created": "Installed “{name}”. It is off until you approve it: Settings → Addons → External Extensions → Review and Run.",
    "result.updated": "Updated “{name}”. It is off until you approve it again: Settings → Addons → External Extensions → Review and Run.",
    "result.forgotten": 'Removed "{name}" from the list.',
    "result.deleted": 'Deleted "{name}" from Marinara and removed it from the list.',
    "result.nameExists": "Marinara already has “{name}”. Update that extension with this code? It will need approval again.",
    "result.checked": "Checked.",
    "sources.heading": "Installed",
    "sources.empty": "Nothing yet.",
    "sources.installed": "installed",
    "sources.lastCheck": "checked",
    "sources.never": "never",
    "sources.state.up-to-date": "up to date",
    "sources.state.update": "update available: v{version}",
    "sources.state.older": "source publishes an older version (v{version})",
    "sources.state.changed": "code changed at the source (same version)",
    "sources.state.unknown": "not compared",
    "sources.error": "last check failed: {error}",
    "sources.updateNote": "An update switches the extension off again. Approve it again in Settings → Addons → External Extensions.",
    "error.url.empty": "Enter a URL.",
    "error.url.unsupported": "Unsupported URL. Use a GitHub repository URL, owner/repo, a raw manifest.json URL or a .zip URL.",
    "error.url.not-https": "Only https:// URLs can be fetched.",
    "error.url.bad-github-path": "Not a usable GitHub URL: {message}",
    "error.fetch.network": "Could not download {url}. The browser blocked the request (CORS) or the network failed. Only raw.githubusercontent.com (and other hosts that send CORS headers) can be fetched from the browser; github.com pages, release assets and codeload zips cannot.",
    "error.fetch.http": "Download failed with HTTP {status}: {url}",
    "error.fetch.manifest-not-found": "No manifest.json found. {message}. Check the repository, branch and folder; the manifest must be at the folder root.",
    "error.fetch.too-large": "A file is too large to install ({url}): Marinara accepts at most 2 MiB per text file and 32 MiB per zip.",
    "error.fetch.bad-json": "The manifest is not valid JSON ({url}): {message}",
    "error.fetch.bad-zip": "The zip could not be read: {message}",
    "error.manifest.not-an-object": "The manifest is not an object.",
    "error.manifest.multiple-entries": "This package lists several extensions ({names}). Point the URL at one extension's folder.",
    "error.manifest.no-entries": "The manifest lists no extensions.",
    "error.manifest.name-missing": "The manifest has no name.",
    "error.manifest.name-too-long": "The name is too long ({length} characters, max 200).",
    "error.manifest.description-too-long": "The description is too long ({length} characters, max 2000).",
    "error.manifest.css-too-large": "The CSS is too large ({bytes} bytes, max 262144).",
    "error.manifest.file-too-large": "The file {path} is too large ({bytes} bytes, max 2 MiB).",
    "error.manifest.file-missing": "The manifest names {path}, but that file is not in the package.",
    "error.manifest.no-code": "The manifest names no JavaScript or CSS (jsPath / cssPath / js / css).",
    "error.manifest.server-no-code": "A server extension needs serverJsPath or serverJs.",
    "error.engine.gates-closed": 'Marinara refused the import (403): External Extensions are locked. Both gates must be open: ENABLE_EXTERNAL_EXTENSIONS=true in the server .env (then restart) and the switch "Allow third-party extension imports" in Settings → Addons → External Extensions.',
    "error.engine.privileged": "Marinara refused the request (403): Personal Extension management needs localhost or Admin Access. On a remote Marinara, set ADMIN_SECRET in the server .env and enter the same value under Settings → Admin Access, then try again. ({message})",
    "error.engine.untrusted-host": "Marinara refused the request (421): this hostname is not in its allowed hosts. ({message})",
    "error.engine.csrf": "Marinara rejected the request origin (CSRF). Open Marinara at its configured address. ({message})",
    "error.engine.name-exists": 'An extension named "{name}" already exists in Marinara.',
    "error.engine.not-found": "Marinara no longer has this extension (404). Remove it from the list or install it again.",
    "error.engine.validation": "Marinara rejected the extension (400): {message}",
    "error.engine.network": "Could not reach Marinara's API: {message}",
    "error.engine.http": "Marinara answered HTTP {status}: {message}",
    "error.unknown": "Unexpected error: {message}",
    "badge.jsDigest": "JS SHA-256",
    "badge.jsDigest.title": "This page is not a secure context (plain http), so the hash is computed in JavaScript instead of WebCrypto. The result is identical.",
    "install.linkHint": 'Linking "{name}": enter the URL its code was installed from.',
    "install.cancelLink": "Stop linking",
    "preview.changes": "Changes",
    "preview.changes.none": "Marinara already holds exactly this code. Linking records the source; nothing is sent.",
    "preview.changes.row": "{role}: {before} → {after} ({lines})",
    "preview.changes.new": "new",
    "preview.changes.removed": "removed",
    "preview.changes.same": "unchanged",
    "preview.changes.lines": "+{added} / −{removed} lines",
    "preview.code": "Downloaded code",
    "preview.engine": "In Marinara",
    "preview.engine.record": '"{name}" v{version}, {state}, hash {hash}',
    "preview.engine.enabled": "enabled",
    "preview.engine.disabled": "disabled",
    "preview.engine.unavailable": "Marinara's extension list could not be read ({error}); the comparison with the installed code is skipped.",
    "preview.downloaded": "Downloaded",
    "warn.editedInMarinara": "The code in Marinara differs from what this installer last installed (edited in Marinara's editor or rolled back). Updating overwrites those changes; Marinara keeps the current code as a revision.",
    "warn.runtimeDiffers": "The package runtime ({after}) differs from the installed extension ({before}). It will not be replaced.",
    "warn.nameDiffers": 'The package renames the extension: "{before}" → "{after}".',
    "warn.unknownKind": 'Unknown manifest kind "{kind}"; read as a browser extension.',
    "warn.serverSandbox": "This Marinara has no supported server sandbox ({reason}); a server extension can be stored but not approved.",
    "action.link": "Link without changing code",
    "action.revisions": "Revisions",
    "action.rollback": "Restore",
    "action.export": "Export list",
    "action.import": "Import list",
    "action.copy": "Copy",
    "action.apply": "Apply",
    "action.autoCheck": "Check for updates on open",
    "action.refresh": "Refresh",
    "result.linked": "Linked “{name}”.",
    "result.rolledBack": 'Restored "{name}" to {hash}. Marinara keeps it disabled until you approve that hash again in Settings → Addons → External Extensions.',
    "result.checking": "Checking {done}/{total}…",
    "result.exported": 'Copy the text below and keep it; "Import list" restores it.',
    "result.imported": "Imported {imported} source(s); {ignored} entr(ies) were not valid.",
    "result.copied": "Copied.",
    "revisions.heading": "Revisions kept by Marinara",
    "revisions.none": "Marinara keeps no earlier revision of this extension.",
    "revisions.item": "v{version} · saved {savedAt} · {hash}",
    "untracked.heading": "Not installed through Fetchy",
    "untracked.hint": "Link the GitHub address it came from to update it here.",
    "untracked.none": "None.",
    "untracked.unavailable": "Marinara's list could not be read: {error}",
    "untracked.link": "Link URL…",
    "error.fetch.timeout": "No answer within the time limit ({url}). Try again later.",
    "error.fetch.rate-limited": "GitHub's API refused the request (rate limit for unauthenticated requests, 60 per hour). The installer asks it only for a repository's default branch; name the branch in the URL (owner/repo@branch) to avoid it.",
    "error.fetch.source-changed": "The package changed while it was being downloaded ({url}). Try again in a moment.",
    "error.manifest.too-many-files": "The manifest names too many files ({count}, max 40).",
    "error.install.record-changed": "The extension's code in Marinara changed after the preview. Nothing was sent; fetch again and review the new state.",
    "error.install.runtime-changed": "The package changes the runtime ({message}). An extension is never switched between browser and server; install it as a new extension instead.",
    "error.install.unexpected-result": "Marinara's answer does not match what was sent ({message}). Check the extension in Settings → Addons → External Extensions before approving anything.",
    "error.install.not-linkable": "Linking needs Marinara's extension list, which could not be read.",
    "error.import.invalid": "That is not an exported source list.",
    "anchor.button": "Install from GitHub",
    "anchor.hint": "Shortcut: Alt+Shift+F",
    "option.floating": "Floating button",
    "warn.capabilitiesAdded": "MORE AUTHORITY REQUESTED: this version asks for {values}, which the installed extension does not have. Marinara will require a fresh approval of the new hash; read the code before you approve.",
    "warn.capabilitiesRemoved": "This version drops the capabilities {values}.",
    "warn.sameVersionChanged": "The source changed its code without changing the version ({version}). Treat it like a new release: review the changes before updating.",
    "log.heading": "Change log",
    "log.empty": "Nothing recorded yet.",
    "log.show": "Change log",
    "log.hide": "Hide log",
    "log.export": "Copy as text",
    "log.clear": "Clear log",
    "log.entry": "{at} · {action} · {result} · {name}",
    "log.reconciled": "Completed {count} update(s) that finished in Marinara while the panel was closed.",
    "log.missing": "Marinara no longer has this extension.",
    "items.heading": "Extensions",
    "items.empty": "No external extensions.",
    "items.unavailable": "Marinara's extension list could not be read ({error}). Only Fetchy's own records are shown.",
    "item.notFromFetchy": "Not installed through Fetchy",
    "item.approveHint": "Off until approved: Settings → Addons → External Extensions → Review and Run.",
    "badge.enabled": "on",
    "badge.disabled": "off",
    "badge.needsApproval": "needs approval",
    "action.code": "Code",
    "action.disable": "Switch off",
    "action.delete": "Delete",
    "action.confirmDelete": "Delete “{name}” from Marinara?",
    "action.reinstall": "Install again",
    "result.disabled": "Switched “{name}” off.",
    "action.more": "More",
    "action.less": "Less",
    "prefs.heading": "Options",
    "help.install": "A GitHub repository (FigCake/ME.Fetchy, or a /tree/branch/folder link), a manifest.json address, or a zip address. Fetchy downloads the files, shows what they are, and stores them in Marinara switched off. You switch them on under Settings → Addons → External Extensions (Review and Run).",
    "help.items": "Every External Extension in Marinara. Ones installed through Fetchy can be checked for updates; others can be linked to the GitHub address they came from. An update always switches the extension off until you approve the new code.",
    "help.autoCheck": "Only checks for updates when this panel opens. Never installs anything by itself.",
    "help.floating": "Also shows a Fetchy button at the bottom right of every page.",
    "help.autoApprove": "After an update, approve the new code and switch the extension back on without reading it. Not applied when the new version asks for new capabilities, or if the extension was off.",
    "help.log": "What Fetchy did, with versions and hashes before and after.",
    "help.transfer": "The list of sources as text, to move to another browser or Marinara.",
    "result.updatedAndOn": "Updated “{name}” and switched it back on.",
    "result.notApproved.capabilities-grew": "Updated “{name}”, but it stays off: this version asks for new capabilities, so auto re-approval did not apply. Review it in Settings → Addons → External Extensions → Review and Run. New hash: {hash}",
    "result.notApproved.failed": "Updated “{name}”, but re-approval failed ({error}). It stays off until you approve it in Settings → Addons → External Extensions. New hash: {hash}",
    "auto.label": "Auto re-approve after updates",
    "auto.badge": "auto re-approve",
    "auto.confirm.title": "Switch on auto re-approval for “{name}”?",
    "auto.confirm.body": "After every update of this extension, Fetchy will approve the new code and switch it back on without you reading it. Code published at {source} will then run in your Marinara as soon as you press Update. Fetchy still refuses when a version asks for new capabilities, and never applies this to an extension that was off.",
    "auto.ack.code": "I understand that updated code from this source will run without my review.",
    "auto.ack.fullPage": "I understand this extension has full page access: it can read and change everything in Marinara, including API keys and chats.",
    "auto.confirm.on": "Switch on",
    "auto.on": "Auto re-approval is on for “{name}”.",
    "auto.off": "Auto re-approval is off for “{name}”.",
    "result.selfUpdated": "Updated Fetchy. It is off until you approve it again: Settings → Addons → External Extensions → Review and Run."
  };
  var ko = {
    "title": "Fetchy",
    "subtitle": "Marinara 확장 설치기",
    "launcher": "확장 설치",
    "launcher.title": "GitHub URL로 Marinara 확장을 설치합니다",
    "close": "닫기",
    "lang.switch": "English",
    "security.note": "Fetchy는 내려받은 코드를 실행하지 않고 Marinara에 꺼진 채로 넣어 둡니다. 켜려면 설정 → 애드온 → 외부 확장에서 Review and Run을 눌러 직접 승인하세요.",
    "gate.loading": "외부 확장 게이트 상태 확인 중…",
    "gate.open": "외부 확장 설치가 허용되어 있습니다.",
    "gate.env": "외부 확장이 잠겨 있습니다. 서버 .env에 ENABLE_EXTERNAL_EXTENSIONS=true 를 넣고 Marinara를 다시 시작하세요.",
    "gate.switch": "외부 확장이 잠겨 있습니다. 설정 → 애드온 → 외부 확장에서 “Allow third-party extension imports”를 켜세요.",
    "gate.unknown": "게이트 상태를 읽을 수 없습니다 ({error}).",
    "install.heading": "설치",
    "install.placeholder": "GitHub 주소 (예: FigCake/ME.Fetchy)",
    "install.fetch": "확인",
    "install.fetching": "확인 중…",
    "install.help": "저장소 주소, manifest.json 주소, zip 주소 중 하나를 넣으세요.",
    "preview.heading": "설치할 내용",
    "preview.source": "소스",
    "preview.branch": "브랜치",
    "preview.name": "이름",
    "preview.version": "버전",
    "preview.description": "설명",
    "preview.runtime": "런타임",
    "preview.runtime.client": "브라우저 (client)",
    "preview.runtime.server": "서버",
    "preview.capabilities": "권한(capabilities)",
    "preview.capabilities.none": "없음 (샌드박스)",
    "preview.files": "파일",
    "preview.hash": "Marinara 콘텐츠 해시",
    "preview.hash.hint": "승인 화면(Review and Run)의 해시와 같아야 합니다.",
    "preview.readme": "README",
    "preview.none": "—",
    "preview.tracked": "이미 추적 중: {name} (v{version}). 설치하면 그 항목이 업데이트됩니다.",
    "warn.fullPage": "전체 페이지 접근 권한: 이 확장은 Marinara 페이지의 모든 것(API 키, 채팅 포함)을 읽고 바꿀 수 있습니다. 제작자를 믿고 코드를 봤을 때만 설치하세요.",
    "warn.server": "서버 런타임: 코드가 Marinara 호스트의 샌드박스 Node 프로세스에서 실행됩니다. 지원되는 OS 샌드박스가 없으면 Marinara가 승인을 거부합니다.",
    "warn.legacyKind": '구형 패키지(kind "marinara.extension", capabilities 없음): Marinara는 이를 전체 페이지 접근으로 취급합니다.',
    "warn.versionDropped": '매니페스트 버전 "{value}"은 올바른 버전이 아니어서(64자 초과) 비워서 저장됩니다.',
    "warn.unknownCaps": "알 수 없는 권한은 무시됩니다: {values}",
    "action.install": "설치",
    "action.update": "기존 확장 업데이트",
    "action.updateTracked": "{name} 업데이트",
    "action.cancel": "취소",
    "action.busy": "처리 중…",
    "action.open": "소스 열기",
    "action.check": "업데이트 확인",
    "action.checkAll": "모두 확인",
    "result.selfUpdatedOn": "Fetchy 업데이트하고 다시 켰습니다.",
    "action.updateAll": "모두 업데이트",
    "option.keepEnabled": "업데이트한 확장 켜 두기",
    "help.keepEnabled": "켜져 있던 확장을 업데이트하면(개별이든 “모두 업데이트”든) 새 코드를 읽지 않고 승인해 바로 다시 켭니다. 새 권한을 요구하는 버전에는 적용하지 않습니다.",
    "keep.confirm.title": "업데이트한 확장을 켜 둘까요?",
    "keep.confirm.body": "여기서 하는 모든 업데이트에서 Fetchy가 업데이트된 코드를 읽어 보지 않고 승인해 다시 켭니다. 즉 그 저장소들에 올라온 코드가 업데이트를 누르는 순간 내 Marinara에서 실행됩니다. 새 권한을 요구하는 버전은 이 방식으로 승인하지 않습니다.",
    "result.updatedAll": "{total}개 중 {ok}개 업데이트했습니다.",
    "result.updatedAllOne": "{name}: {text}",
    "result.nothingToUpdate": "업데이트할 것이 없습니다. 먼저 “모두 확인”을 누르세요.",
    "action.forget": "제거",
    "action.forget.listOnly": "목록에서만 제거",
    "action.forget.engine": "Marinara에서도 삭제",
    "action.confirmForget": '"{name}"을(를) 제거할까요?',
    "result.created": "“{name}” 설치했습니다. 승인하면 켜집니다: 설정 → 애드온 → 외부 확장 → Review and Run.",
    "result.updated": "“{name}” 업데이트했습니다. 다시 승인하면 켜집니다: 설정 → 애드온 → 외부 확장 → Review and Run.",
    "result.forgotten": '"{name}"을(를) 목록에서 제거했습니다.',
    "result.deleted": '"{name}"을(를) Marinara에서 삭제하고 목록에서 제거했습니다.',
    "result.nameExists": "Marinara에 “{name}”이 이미 있습니다. 그 확장을 이 코드로 업데이트할까요? 다시 승인해야 합니다.",
    "result.checked": "확인했습니다.",
    "sources.heading": "설치한 확장",
    "sources.empty": "아직 없습니다.",
    "sources.installed": "설치 버전",
    "sources.lastCheck": "마지막 확인",
    "sources.never": "없음",
    "sources.state.up-to-date": "최신",
    "sources.state.update": "업데이트 있음: v{version}",
    "sources.state.older": "소스가 더 낮은 버전을 배포 중 (v{version})",
    "sources.state.changed": "소스의 코드가 바뀜 (버전은 동일)",
    "sources.state.unknown": "비교되지 않음",
    "sources.error": "마지막 확인 실패: {error}",
    "sources.updateNote": "업데이트하면 다시 꺼집니다. 설정 → 애드온 → 외부 확장에서 다시 승인하세요.",
    "error.url.empty": "URL을 입력하세요.",
    "error.url.unsupported": "지원하지 않는 URL입니다. GitHub 저장소 URL, owner/repo, raw manifest.json URL 또는 .zip URL을 사용하세요.",
    "error.url.not-https": "https:// URL만 불러올 수 있습니다.",
    "error.url.bad-github-path": "사용할 수 없는 GitHub URL입니다: {message}",
    "error.fetch.network": "{url} 을(를) 내려받을 수 없습니다. 브라우저가 요청을 차단했거나(CORS) 네트워크 오류입니다. 브라우저에서는 raw.githubusercontent.com(및 CORS 헤더를 보내는 호스트)만 불러올 수 있고, github.com 페이지·릴리스 에셋·codeload zip은 불러올 수 없습니다.",
    "error.fetch.http": "다운로드 실패 HTTP {status}: {url}",
    "error.fetch.manifest-not-found": "manifest.json을 찾지 못했습니다. {message}. 저장소·브랜치·폴더를 확인하세요. 매니페스트는 폴더 최상위에 있어야 합니다.",
    "error.fetch.too-large": "설치하기엔 파일이 너무 큽니다 ({url}): Marinara는 텍스트 파일당 2 MiB, zip은 32 MiB까지 받습니다.",
    "error.fetch.bad-json": "매니페스트가 올바른 JSON이 아닙니다 ({url}): {message}",
    "error.fetch.bad-zip": "zip을 읽을 수 없습니다: {message}",
    "error.manifest.not-an-object": "매니페스트가 객체가 아닙니다.",
    "error.manifest.multiple-entries": "이 패키지에는 확장이 여러 개 있습니다 ({names}). 확장 하나의 폴더 URL을 입력하세요.",
    "error.manifest.no-entries": "매니페스트에 확장이 없습니다.",
    "error.manifest.name-missing": "매니페스트에 이름이 없습니다.",
    "error.manifest.name-too-long": "이름이 너무 깁니다 ({length}자, 최대 200).",
    "error.manifest.description-too-long": "설명이 너무 깁니다 ({length}자, 최대 2000).",
    "error.manifest.css-too-large": "CSS가 너무 큽니다 ({bytes}바이트, 최대 262144).",
    "error.manifest.file-too-large": "파일 {path}이(가) 너무 큽니다 ({bytes}바이트, 최대 2 MiB).",
    "error.manifest.file-missing": "매니페스트가 {path}을(를) 가리키지만 패키지에 그 파일이 없습니다.",
    "error.manifest.no-code": "매니페스트에 JavaScript나 CSS가 없습니다 (jsPath / cssPath / js / css).",
    "error.manifest.server-no-code": "서버 확장에는 serverJsPath 또는 serverJs가 필요합니다.",
    "error.engine.gates-closed": "Marinara가 가져오기를 거부했습니다 (403): 외부 확장이 잠겨 있습니다. 두 게이트를 모두 열어야 합니다: 서버 .env의 ENABLE_EXTERNAL_EXTENSIONS=true (후 재시작) 그리고 설정 → 애드온 → 외부 확장의 “Allow third-party extension imports” 스위치.",
    "error.engine.privileged": "Marinara가 요청을 거부했습니다 (403): 개인 확장 관리는 localhost 또는 Admin Access가 필요합니다. 원격 Marinara라면 서버 .env에 ADMIN_SECRET을 설정하고 설정 → Admin Access에 같은 값을 입력한 뒤 다시 시도하세요. ({message})",
    "error.engine.untrusted-host": "Marinara가 요청을 거부했습니다 (421): 이 호스트 이름이 허용 목록에 없습니다. ({message})",
    "error.engine.csrf": "Marinara가 요청 출처를 거부했습니다 (CSRF). 설정된 주소로 Marinara를 여세요. ({message})",
    "error.engine.name-exists": 'Marinara에 "{name}"이라는 확장이 이미 있습니다.',
    "error.engine.not-found": "Marinara에 이 확장이 더 이상 없습니다 (404). 목록에서 제거하거나 다시 설치하세요.",
    "error.engine.validation": "Marinara가 확장을 거부했습니다 (400): {message}",
    "error.engine.network": "Marinara API에 연결할 수 없습니다: {message}",
    "error.engine.http": "Marinara 응답 HTTP {status}: {message}",
    "error.unknown": "예상치 못한 오류: {message}",
    "badge.jsDigest": "JS SHA-256",
    "badge.jsDigest.title": "이 페이지는 보안 컨텍스트가 아니어서(일반 http) WebCrypto 대신 JavaScript로 해시를 계산합니다. 결과는 같습니다.",
    "install.linkHint": '"{name}" 연결 중: 이 확장의 코드를 받아온 URL을 입력하세요.',
    "install.cancelLink": "연결 중단",
    "preview.changes": "변경 사항",
    "preview.changes.none": "Marinara에 이미 정확히 같은 코드가 있습니다. 연결하면 소스만 기록하고 아무것도 보내지 않습니다.",
    "preview.changes.row": "{role}: {before} → {after} ({lines})",
    "preview.changes.new": "새 파일",
    "preview.changes.removed": "삭제됨",
    "preview.changes.same": "변경 없음",
    "preview.changes.lines": "+{added} / −{removed} 줄",
    "preview.code": "내려받은 코드",
    "preview.engine": "Marinara의 현재 상태",
    "preview.engine.record": '"{name}" v{version}, {state}, 해시 {hash}',
    "preview.engine.enabled": "실행 중",
    "preview.engine.disabled": "비활성",
    "preview.engine.unavailable": "Marinara의 확장 목록을 읽을 수 없어({error}) 설치된 코드와의 비교는 생략합니다.",
    "preview.downloaded": "다운로드",
    "warn.editedInMarinara": "Marinara에 있는 코드가 이 설치기가 마지막으로 설치한 것과 다릅니다(Marinara 편집기에서 수정했거나 되돌렸음). 업데이트하면 그 변경이 덮어써지며, 현재 코드는 Marinara가 리비전으로 보관합니다.",
    "warn.runtimeDiffers": "패키지의 런타임({after})이 설치된 확장({before})과 다릅니다. 교체하지 않습니다.",
    "warn.nameDiffers": '패키지가 확장 이름을 바꿉니다: "{before}" → "{after}".',
    "warn.unknownKind": '알 수 없는 매니페스트 kind "{kind}"; 브라우저 확장으로 읽습니다.',
    "warn.serverSandbox": "이 Marinara에는 지원되는 서버 샌드박스가 없어({reason}) 서버 확장을 저장할 수는 있지만 승인할 수 없습니다.",
    "action.link": "코드 변경 없이 연결",
    "action.revisions": "리비전",
    "action.rollback": "되돌리기",
    "action.export": "목록 내보내기",
    "action.import": "목록 가져오기",
    "action.copy": "복사",
    "action.apply": "적용",
    "action.autoCheck": "열 때 업데이트 확인",
    "action.refresh": "새로고침",
    "result.linked": "“{name}” 연결했습니다.",
    "result.rolledBack": '"{name}"을(를) {hash} 로 되돌렸습니다. 설정 → 애드온 → 외부 확장에서 그 해시를 다시 승인할 때까지 Marinara는 비활성 상태로 둡니다.',
    "result.checking": "확인 중 {done}/{total}…",
    "result.exported": "아래 텍스트를 복사해 보관하세요. “목록 가져오기”로 복원할 수 있습니다.",
    "result.imported": "{imported}개 소스를 가져왔습니다. 올바르지 않은 항목 {ignored}개는 무시했습니다.",
    "result.copied": "복사했습니다.",
    "revisions.heading": "Marinara가 보관한 리비전",
    "revisions.none": "Marinara에 이 확장의 이전 리비전이 없습니다.",
    "revisions.item": "v{version} · {savedAt} 저장 · {hash}",
    "untracked.heading": "Fetchy로 설치하지 않은 확장",
    "untracked.hint": "받아온 GitHub 주소를 연결하면 여기서 업데이트할 수 있습니다.",
    "untracked.none": "없습니다.",
    "untracked.unavailable": "Marinara의 목록을 읽을 수 없습니다: {error}",
    "untracked.link": "URL 연결…",
    "error.fetch.timeout": "제한 시간 안에 응답이 없습니다 ({url}). 잠시 후 다시 시도하세요.",
    "error.fetch.rate-limited": "GitHub API가 요청을 거부했습니다 (비인증 요청 한도, 시간당 60회). 설치기는 저장소의 기본 브랜치를 알아낼 때만 API를 쓰므로, URL에 브랜치를 적으면(owner/repo@branch) 피할 수 있습니다.",
    "error.fetch.source-changed": "다운로드 중에 패키지가 바뀌었습니다 ({url}). 잠시 후 다시 시도하세요.",
    "error.manifest.too-many-files": "매니페스트가 가리키는 파일이 너무 많습니다 ({count}개, 최대 40).",
    "error.install.record-changed": "미리보기 이후 Marinara의 확장 코드가 바뀌었습니다. 아무것도 보내지 않았습니다. 다시 불러와서 새 상태를 확인하세요.",
    "error.install.runtime-changed": "패키지가 런타임을 바꿉니다 ({message}). 확장을 브라우저↔서버로 전환하지 않습니다. 새 확장으로 설치하세요.",
    "error.install.unexpected-result": "Marinara의 응답이 보낸 내용과 다릅니다 ({message}). 승인 전에 설정 → 애드온 → 외부 확장에서 확장을 확인하세요.",
    "error.install.not-linkable": "연결에는 Marinara의 확장 목록이 필요한데 읽을 수 없습니다.",
    "error.import.invalid": "내보낸 소스 목록이 아닙니다.",
    "anchor.button": "GitHub에서 설치",
    "anchor.hint": "단축키: Alt+Shift+F",
    "option.floating": "플로팅 버튼",
    "warn.capabilitiesAdded": "권한 추가 요청: 이 버전은 설치된 확장에 없는 {values} 권한을 요구합니다. Marinara가 새 해시의 승인을 다시 요구하며, 승인 전에 코드를 읽어 보세요.",
    "warn.capabilitiesRemoved": "이 버전은 {values} 권한을 더 쓰지 않습니다.",
    "warn.sameVersionChanged": "소스가 버전({version})은 그대로 둔 채 코드만 바꿨습니다. 새 릴리스처럼 다루고, 업데이트 전에 변경 사항을 확인하세요.",
    "log.heading": "변경 기록",
    "log.empty": "아직 기록이 없습니다.",
    "log.show": "변경 기록",
    "log.hide": "기록 닫기",
    "log.export": "텍스트로 복사",
    "log.clear": "기록 지우기",
    "log.entry": "{at} · {action} · {result} · {name}",
    "log.reconciled": "패널이 닫힌 사이 Marinara에서 끝난 업데이트 {count}건을 기록에 반영했습니다.",
    "log.missing": "Marinara에 이 확장이 더 이상 없습니다.",
    "items.heading": "확장",
    "items.empty": "외부 확장이 없습니다.",
    "items.unavailable": "Marinara의 확장 목록을 읽을 수 없습니다 ({error}). Fetchy 기록만 보입니다.",
    "item.notFromFetchy": "Fetchy로 설치하지 않음",
    "item.approveHint": "승인하면 켜집니다: 설정 → 애드온 → 외부 확장 → Review and Run.",
    "badge.enabled": "켜짐",
    "badge.disabled": "꺼짐",
    "badge.needsApproval": "승인 필요",
    "action.code": "코드",
    "action.disable": "끄기",
    "action.delete": "삭제",
    "action.confirmDelete": "“{name}”을(를) Marinara에서 삭제할까요?",
    "action.reinstall": "다시 설치",
    "result.disabled": "“{name}”을(를) 껐습니다.",
    "action.more": "더보기",
    "action.less": "접기",
    "prefs.heading": "옵션",
    "help.install": "GitHub 저장소(FigCake/ME.Fetchy 처럼, 또는 /tree/브랜치/폴더 링크), manifest.json 주소, zip 주소. Fetchy가 파일을 받아 내용을 보여 주고 Marinara에 꺼진 상태로 넣습니다. 켜는 것은 설정 → 애드온 → 외부 확장(Review and Run)에서 합니다.",
    "help.items": "Marinara의 외부 확장 전부입니다. Fetchy로 설치한 것은 업데이트를 확인할 수 있고, 아닌 것은 받아온 GitHub 주소를 연결하면 됩니다. 업데이트하면 새 코드를 승인할 때까지 확장이 꺼집니다.",
    "help.autoCheck": "이 패널을 열 때 업데이트가 있는지만 봅니다. 혼자 설치하지는 않습니다.",
    "help.floating": "모든 페이지 오른쪽 아래에도 Fetchy 버튼을 둡니다.",
    "help.autoApprove": "업데이트 뒤 새 코드를 읽지 않고 승인해 다시 켭니다. 새 권한을 요구하는 버전이나 꺼져 있던 확장에는 적용하지 않습니다.",
    "help.log": "Fetchy가 한 일을 버전·해시 전후와 함께 기록합니다.",
    "help.transfer": "소스 목록을 글로 뽑아 다른 브라우저나 Marinara로 옮깁니다.",
    "result.updatedAndOn": "“{name}” 업데이트하고 다시 켰습니다.",
    "result.notApproved.capabilities-grew": "“{name}” 업데이트했지만 꺼진 채로 둡니다. 이 버전은 새 권한을 요구해서 자동 승인을 적용하지 않았습니다. 설정 → 애드온 → 외부 확장 → Review and Run에서 직접 확인하세요. 새 해시: {hash}",
    "result.notApproved.failed": "“{name}” 업데이트했지만 다시 승인하지 못했습니다 ({error}). 설정 → 애드온 → 외부 확장에서 승인할 때까지 꺼져 있습니다. 새 해시: {hash}",
    "auto.label": "업데이트 후 자동 승인",
    "auto.badge": "자동 승인",
    "auto.confirm.title": "“{name}”의 자동 승인을 켤까요?",
    "auto.confirm.body": "이 확장을 업데이트할 때마다 Fetchy가 새 코드를 읽어 보지 않고 승인해 다시 켭니다. 즉 {source} 에 올라온 코드가 업데이트 버튼을 누르는 순간 내 Marinara에서 실행됩니다. 새 권한을 요구하는 버전은 자동 승인하지 않고, 꺼져 있던 확장에는 적용하지 않습니다.",
    "auto.ack.code": "이 소스의 업데이트된 코드가 내 검토 없이 실행된다는 것을 이해합니다.",
    "auto.ack.fullPage": "이 확장은 전체 페이지 접근 권한이 있어 Marinara의 모든 것(API 키, 채팅 포함)을 읽고 바꿀 수 있다는 것을 이해합니다.",
    "auto.confirm.on": "켜기",
    "auto.on": "“{name}”의 자동 승인을 켰습니다.",
    "auto.off": "“{name}”의 자동 승인을 껐습니다.",
    "result.selfUpdated": "Fetchy 업데이트했습니다. 다시 승인하면 켜집니다: 설정 → 애드온 → 외부 확장 → Review and Run."
  };
  function detectLang(language) {
    return language?.toLowerCase().startsWith("ko") ? "ko" : "en";
  }
  function createTranslator(initial) {
    let lang = initial;
    const t = (key, params = {}) => {
      const template = (lang === "ko" ? ko[key] : void 0) ?? en[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_, name) => name in params ? String(params[name]) : `{${name}}`);
    };
    return {
      t,
      get lang() {
        return lang;
      },
      set lang(next) {
        lang = next;
      }
    };
  }

  // src/ui.ts
  var HOST_ELEMENT_ID = "me-fetchy";
  var STYLE = `
/* Marinara's own theme variables reach the shadow tree (custom properties cross
   the boundary), so colours, borders and the accent follow whatever theme the
   user picked. Fallbacks are a neutral dark set for a page without them.
   Where the theme offers nothing (status tints), pale pastel washes, no borders. */
:host { all: initial; font: inherit; display: block; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483000; }
*, *::before, *::after { box-sizing: border-box; }
.root {
  --fg: var(--foreground, #e6e6ee); --bg: var(--background, #1b1b22); --muted: var(--muted-foreground, #9a9aa8);
  --line: var(--border, rgba(128,128,128,.28)); --soft: var(--secondary, rgba(128,128,128,.14)); --accent: var(--primary, #6b63d8);
  --accent-fg: var(--primary-foreground, #ffffff); --hover: var(--accent, rgba(128,128,128,.22));
  --wash-ok: rgba(110, 200, 150, .16); --wash-warn: rgba(240, 190, 100, .18); --wash-bad: rgba(240, 130, 130, .16); --wash-info: rgba(130, 150, 240, .14);
  font-family: inherit; font-size: 13px; line-height: 1.55; color: var(--fg);
  word-break: keep-all; overflow-wrap: break-word; letter-spacing: normal; text-align: left; white-space: normal;
}
.launcher {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  font: 600 13px/1 inherit; font-family: inherit; color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 999px; padding: 10px 14px;
  box-shadow: 0 2px 10px rgba(0,0,0,.25); cursor: pointer; white-space: nowrap;
}
.launcher:hover, .launcher:focus { opacity: .9; outline: none; }
.launcher[hidden] { display: none; }
.backdrop { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 2147483001; background: rgba(0,0,0,.45); overflow: auto; padding: 24px 12px; }
.backdrop[hidden] { display: none; }
.panel {
  position: relative; margin: 0 auto; width: 100%; max-width: 720px;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 14px;
  padding: 18px 20px 20px;
}
@media (max-width: 640px) { .backdrop { padding: 0; } .panel { max-width: none; min-height: 100%; border-radius: 0; border: 0; padding: 14px 14px 18px; } }
h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.3; }
h2 .ver { font-weight: 400; color: var(--muted); font-size: 12px; margin-left: 8px; }
h3 { margin: 20px 0 8px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
header .tools { display: flex; gap: 4px; }
button { font: inherit; font-size: 12px; line-height: 1.3; color: var(--fg); background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; cursor: pointer; white-space: nowrap; }
button:hover:not(:disabled) { background: var(--hover); }
button:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button.danger { color: var(--fg); }
button.small { padding: 4px 9px; font-size: 12px; }
header .tools button { background: transparent; border-color: transparent; color: var(--muted); }
header .tools button:hover { color: var(--fg); background: var(--soft); }
input[type=text], textarea { font: inherit; font-size: 13px; color: var(--fg); background: var(--soft); border: 1px solid transparent; border-radius: 8px; padding: 8px 10px; width: 100%; }
input[type=text]:focus, textarea:focus { outline: none; border-color: var(--accent); }
input::placeholder, textarea::placeholder { color: var(--muted); opacity: .8; }
textarea { min-height: 90px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.4; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row input { flex: 1 1 200px; min-width: 0; }
.between { justify-content: space-between; }
.muted { color: var(--muted); font-size: 12px; }
.note { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
.badge { display: inline-block; font-size: 11px; line-height: 1.5; padding: 0 8px; border-radius: 999px; background: var(--soft); color: var(--muted); margin-right: 4px; white-space: nowrap; }
.badge.on { background: var(--wash-ok); color: var(--fg); }
.badge.off { background: var(--soft); }
.badge.approve { background: var(--wash-warn); color: var(--fg); }
.badge.loud { background: var(--wash-bad); color: var(--fg); }
.msg { margin: 8px 0 0; padding: 9px 12px; border-radius: 10px; white-space: pre-wrap; background: var(--soft); }
.msg.ok { background: var(--wash-ok); }
.msg.err { background: var(--wash-bad); }
.msg.warn { background: var(--wash-warn); }
.msg.loud { background: var(--wash-bad); font-weight: 600; }
.gate { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
.gate.bad { color: var(--fg); }
dl { display: block; margin: 8px 0; }
dl > div { display: flex; gap: 12px; padding: 4px 0; }
dt { flex: 0 0 110px; color: var(--muted); } dd { flex: 1 1 auto; margin: 0; min-width: 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: var(--soft); padding: 1px 5px; border-radius: 5px; word-break: break-all; }
details { margin-top: 8px; } summary { cursor: pointer; color: var(--muted); }
details.fold details.fold { margin-top: 12px; }
pre { max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-all; background: var(--soft); padding: 10px 12px; border-radius: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; margin: 6px 0 0; }
ul.files, ul.changes, ul.revisions { margin: 4px 0 0; padding-left: 18px; }
ul.items { list-style: none; margin: 0; padding: 0; }
ul.items > li { padding: 12px 0; border-top: 1px solid var(--line); }
ul.items > li:first-child { border-top: 0; }
.name { font-weight: 600; font-size: 14px; }
.line { margin-top: 3px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
.state.update, .state.changed, .state.older { color: var(--fg); } .state.up-to-date { color: var(--muted); }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
label.toggle { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); cursor: pointer; white-space: nowrap; }
label.toggle input { accent-color: var(--accent); }
.help { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; background: var(--soft); color: var(--muted); font-size: 10px; font-weight: 700; line-height: 1; margin-left: 5px; cursor: help; vertical-align: middle; user-select: none; }
.help:hover, .help:focus { color: var(--fg); outline: none; }
summary.row { list-style: none; } summary.row::-webkit-details-marker { display: none; }
ul.log { list-style: none; margin: 4px 0 0; padding: 0; font-size: 12px; } ul.log li { border-top: 1px solid var(--line); padding: 4px 0; color: var(--muted); }
ul.log .refused, ul.log .failed { color: var(--fg); }
.preview, .items, .install { margin-top: 4px; }
footer { margin-top: 20px; }
`;
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === void 0 || value === false) continue;
      if (typeof value === "function") node.addEventListener(key.replace(/^on/, "").toLowerCase(), value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, value);
    }
    append(node, children);
    return node;
  }
  function append(node, children) {
    for (const child of children) {
      if (child === null || child === void 0 || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
  }
  function fragment(...children) {
    const node = document.createDocumentFragment();
    append(node, children);
    return node;
  }
  function drow(term, ...detail) {
    if (detail.every((d) => d === null || d === void 0 || d === false)) return null;
    return el("div", {}, el("dt", {}, term), el("dd", {}, ...detail));
  }
  function help(text) {
    return el("span", { class: "help", tabindex: "0", role: "img", "aria-label": text, title: text }, "?");
  }
  var formatBytes = (n) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
  var formatDate = (iso) => iso ? new Date(iso).toLocaleString() : null;
  var shortHash = (hash) => `${hash.slice(0, 23)}…`;
  function mountPanel(options) {
    const doc = options.document ?? document;
    const { host, client, store } = options;
    const deps = { fetch: host.fetch, client, store, selfId: host.extensionId };
    const i18n = createTranslator(detectLang(options.language ?? (typeof navigator !== "undefined" ? navigator.language : void 0)));
    const t = (key, params) => i18n.t(key, params);
    let isOpen = false;
    let busy = false;
    let policy = null;
    let policyError = null;
    let prepared = null;
    let pendingExistingId = null;
    let linking = null;
    let revisionsFor = null;
    let records = [];
    let rows = null;
    let rowsError = null;
    let codeFor = null;
    let deleting = null;
    let autoFor = null;
    const expanded = /* @__PURE__ */ new Set();
    let keepEnabled = false;
    let keepFor = null;
    let installMessage = null;
    let sourcesMessage = null;
    let urlInput = "";
    let transfer = null;
    let autoCheck = false;
    let floating = false;
    const folds = /* @__PURE__ */ new Set();
    let logEntries = [];
    let reconcileMessage = null;
    let retired = false;
    const jsDigest = digestBackend() === "javascript";
    const audit = new AuditLog(host.storage);
    deps.audit = audit;
    const hostElement = el("div", { id: HOST_ELEMENT_ID });
    const root = hostElement.attachShadow({ mode: "open" });
    const wrapper = el("div", { class: "root" });
    wrapper.append(el("style", {}, STYLE));
    const launcher = el("button", { class: "launcher", type: "button", hidden: true, "aria-haspopup": "dialog", "aria-expanded": "false", title: t("launcher.title"), onClick: () => toggle() }, t("launcher"));
    const panel = el("div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": t("title"), tabindex: "-1" });
    const backdrop = el("div", { class: "backdrop", hidden: true, onClick: (e) => {
      if (e.target === backdrop) close();
    } }, panel);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    wrapper.append(launcher, backdrop);
    root.append(wrapper);
    doc.body.append(hostElement);
    const anchor = mountAnchor(doc, t("anchor.button"), () => open());
    const onShortcut = (e) => {
      if (e.altKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        toggle();
      }
    };
    doc.addEventListener("keydown", onShortcut);
    const guard = async (fn) => {
      if (busy || retired) return;
      busy = true;
      render();
      try {
        await fn();
      } finally {
        busy = false;
        render();
      }
    };
    async function loadPolicy() {
      try {
        policy = await client.policy();
        policyError = null;
      } catch (e) {
        policy = null;
        policyError = describeError(e, t);
      }
    }
    async function loadRecords() {
      try {
        records = await store.load();
      } catch (e) {
        records = [];
        sourcesMessage = { kind: "err", text: describeError(e, t) };
      }
    }
    async function reconcileRecords() {
      try {
        const changed = await reconcile(deps);
        if (changed.some((r) => !r.lastError)) reconcileMessage = { kind: "ok", text: t("log.reconciled", { count: changed.filter((r) => !r.lastError).length }) };
        if (changed.length) records = await store.load();
      } catch {
      }
    }
    async function loadLog() {
      try {
        logEntries = await audit.list();
      } catch {
        logEntries = [];
      }
    }
    async function loadRows() {
      try {
        rows = await overview(deps);
        rowsError = null;
      } catch (e) {
        rows = null;
        rowsError = describeError(e, t);
      }
    }
    const onFetch = () => guard(async () => {
      prepared = null;
      pendingExistingId = null;
      installMessage = null;
      try {
        prepared = await prepare(urlInput, deps, { extensionId: linking?.id ?? null });
      } catch (e) {
        installMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const afterChange = async () => {
      await Promise.all([loadRecords(), loadRows(), loadLog()]);
    };
    function resultMessage(result) {
      const params = { name: result.extension.name, hash: result.extension.contentHash, error: result.approveError ?? "" };
      if (result.self) return { kind: "ok", text: t(result.approved ? "result.selfUpdatedOn" : "result.selfUpdated", params) };
      if (result.mode.kind === "create") return { kind: "ok", text: t("result.created", params) };
      if (!result.codeChanged) return { kind: "ok", text: t("result.linked", params) };
      if (result.approved) return { kind: "ok", text: t("result.updatedAndOn", params) };
      if (result.notApproved === "capabilities-grew") return { kind: "warn", text: t("result.notApproved.capabilities-grew", params) };
      if (result.notApproved === "failed") return { kind: "err", text: t("result.notApproved.failed", params) };
      return { kind: "ok", text: t("result.updated", params) };
    }
    const onAutoApprove = (record, value) => guard(async () => {
      autoFor = null;
      sourcesMessage = null;
      try {
        await setAutoApprove(record, value, deps);
        sourcesMessage = { kind: "ok", text: t(value ? "auto.on" : "auto.off", { name: record.name }) };
        await afterChange();
      } catch (e) {
        sourcesMessage = { kind: "err", text: describeError(e, t, { name: record.name }) };
      }
    });
    const onInstall = (mode) => guard(async () => {
      if (!prepared) return;
      const name = prepared.draft.name;
      try {
        const result = await install(prepared, { ...deps, approveNow: keepEnabled }, mode);
        installMessage = resultMessage(result);
        prepared = null;
        pendingExistingId = null;
        linking = null;
        urlInput = "";
        if (result.self) {
          retired = true;
          return;
        }
        await afterChange();
      } catch (e) {
        if (e instanceof EngineApiError && e.code === "name-exists" && e.existingId) {
          pendingExistingId = e.existingId;
          installMessage = { kind: "warn", text: t("result.nameExists", { name }) };
        } else {
          installMessage = { kind: "err", text: describeError(e, t, { name }) };
        }
      }
    });
    const onCheckAll = () => guard(async () => {
      sourcesMessage = null;
      try {
        records = await checkAll(deps, {
          onProgress: (done, total) => {
            sourcesMessage = { kind: "ok", text: t("result.checking", { done, total }) };
            render();
          }
        });
        sourcesMessage = { kind: "ok", text: t("result.checked", { count: records.length }) };
        await loadRows();
      } catch (e) {
        sourcesMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const onCheckOne = (record) => guard(async () => {
      sourcesMessage = null;
      const checked = await checkSource(record, deps);
      records = records.map((r) => r.id === record.id ? checked : r);
      try {
        await store.save(records);
        await loadRows();
      } catch (e) {
        sourcesMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const onUpdate = (record) => guard(async () => {
      sourcesMessage = null;
      try {
        const result = await updateSource(record, { ...deps, approveNow: keepEnabled });
        sourcesMessage = resultMessage(result);
        if (result.self) {
          retired = true;
          return;
        }
        await afterChange();
      } catch (e) {
        sourcesMessage = { kind: "err", text: describeError(e, t, { name: record.name }) };
      }
    });
    const recordFor = (extension, record) => record ?? {
      id: `engine:${extension.id}`,
      input: "",
      source: { kind: "manifest-url", url: "" },
      ref: null,
      name: extension.name,
      extensionId: extension.id,
      installedVersion: extension.version,
      installedHash: extension.contentHash,
      installedAt: extension.installedAt,
      lastCheckedAt: null,
      latest: null,
      lastError: null
    };
    const onRevisions = (extension) => guard(async () => {
      sourcesMessage = null;
      try {
        revisionsFor = { id: extension.id, list: extension.revisions ?? (await deps.client.list()).find((x) => x.id === extension.id)?.revisions ?? [] };
      } catch (e) {
        sourcesMessage = { kind: "err", text: describeError(e, t, { name: extension.name }) };
      }
    });
    const onRollback = (extension, record, revision) => guard(async () => {
      sourcesMessage = null;
      revisionsFor = null;
      try {
        const stub = recordFor(extension, record);
        if (record) {
          const result = await rollbackSource(record, revision.contentHash, deps);
          sourcesMessage = { kind: "ok", text: t("result.rolledBack", { name: result.extension.name, hash: result.extension.contentHash }) };
        } else {
          const result = await deps.client.rollback(stub.extensionId, revision.contentHash);
          sourcesMessage = { kind: "ok", text: t("result.rolledBack", { name: result.name, hash: result.contentHash }) };
        }
        await afterChange();
      } catch (e) {
        sourcesMessage = { kind: "err", text: describeError(e, t, { name: extension.name }) };
      }
    });
    const onDisable = (extension) => guard(async () => {
      sourcesMessage = null;
      try {
        await disableExtension(extension, deps);
        sourcesMessage = { kind: "ok", text: t("result.disabled", { name: extension.name }) };
        await afterChange();
      } catch (e) {
        sourcesMessage = { kind: "err", text: describeError(e, t, { name: extension.name }) };
      }
    });
    const onDelete = (extension) => guard(async () => {
      deleting = null;
      sourcesMessage = null;
      try {
        await deleteExtension(extension, deps);
        sourcesMessage = { kind: "ok", text: t("result.deleted", { name: extension.name }) };
        await afterChange();
      } catch (e) {
        sourcesMessage = { kind: "err", text: describeError(e, t, { name: extension.name }) };
      }
    });
    const onForget = (record, deleteFromEngine) => guard(async () => {
      sourcesMessage = null;
      try {
        await forgetSource(record, deps, deleteFromEngine);
        sourcesMessage = { kind: "ok", text: t(deleteFromEngine ? "result.deleted" : "result.forgotten", { name: record.name }) };
        await afterChange();
      } catch (e) {
        sourcesMessage = { kind: "err", text: describeError(e, t, { name: record.name }) };
      }
    });
    const onImport = (text) => guard(async () => {
      sourcesMessage = null;
      try {
        const result = await importSources(text, store);
        sourcesMessage = { kind: "ok", text: t("result.imported", result) };
        transfer = null;
        await afterChange();
      } catch (e) {
        sourcesMessage = { kind: "err", text: e instanceof SyntaxError ? t("error.import.invalid") : describeError(e, t) };
      }
    });
    const onRefresh = () => guard(async () => {
      sourcesMessage = null;
      await afterChange();
    });
    const onUpdateAll = () => guard(async () => {
      sourcesMessage = null;
      const results = await updateAll(deps, {
        keepEnabled,
        onProgress: (done, total) => {
          sourcesMessage = { kind: "ok", text: t("result.checking", { done, total }) };
          render();
        }
      });
      if (results.length === 0) {
        sourcesMessage = { kind: "warn", text: t("result.nothingToUpdate") };
        return;
      }
      const lines = results.map(({ record, result }) => t("result.updatedAllOne", { name: record.name, text: result instanceof Error ? describeError(result, t, { name: record.name }) : resultMessage(result).text }));
      const ok = results.filter((r) => !(r.result instanceof Error)).length;
      const selfDone = results.some((r) => !(r.result instanceof Error) && r.result.self);
      sourcesMessage = { kind: ok === results.length ? "ok" : "warn", text: [t("result.updatedAll", { ok, total: results.length }), ...lines].join("\n") };
      if (selfDone) {
        retired = true;
        return;
      }
      await afterChange();
    });
    const setKeepEnabled = (value) => {
      keepEnabled = value;
      keepFor = null;
      void host.storage.patch({ keepEnabled }).catch(() => {
      });
      render();
    };
    const startLink = (extension) => {
      linking = extension;
      prepared = null;
      pendingExistingId = null;
      installMessage = null;
      urlInput = "";
      render();
      panel.querySelector("input.url")?.focus();
    };
    const switchLang = () => {
      i18n.lang = i18n.lang === "ko" ? "en" : "ko";
      void host.storage.patch({ lang: i18n.lang }).catch(() => {
      });
      launcher.textContent = t("launcher");
      launcher.title = t("launcher.title");
      render();
    };
    const setAutoCheck = (value) => {
      autoCheck = value;
      void host.storage.patch({ autoCheck }).catch(() => {
      });
      render();
    };
    const setFloating = (value) => {
      floating = value;
      launcher.hidden = !floating;
      void host.storage.patch({ floating }).catch(() => {
      });
      render();
    };
    const message = (m) => m ? el("div", { class: `msg ${m.kind}`, role: m.kind === "err" ? "alert" : "status" }, m.text) : null;
    function gateLine() {
      if (policyError) return el("p", { class: "msg warn" }, t("gate.unknown", { error: policyError }));
      if (!policy || policy.externalExtensionsEnabled) return null;
      return el("p", { class: "msg warn" }, policy.externalExtensionsEnvEnabled ? t("gate.switch") : t("gate.env"));
    }
    function changesBlock(p) {
      const view = p.engine;
      if (!view) return null;
      if (view.sameCode) return el("div", { class: "msg ok" }, t("preview.changes.none"));
      const sideText = (s, other) => s ? formatBytes(s.bytes) : t(`preview.changes.${other}`);
      return el("ul", { class: "changes" }, ...view.changes.map((c) => el(
        "li",
        {},
        t("preview.changes.row", {
          role: c.role,
          before: sideText(c.before, "new"),
          after: sideText(c.after, "removed"),
          lines: c.changed ? t("preview.changes.lines", { added: c.added, removed: c.removed }) : t("preview.changes.same")
        })
      )));
    }
    function previewSection(p) {
      const d = p.draft;
      const view = p.engine;
      const warnings = [];
      if (p.fullPageAccess) warnings.push(el("div", { class: "msg loud", role: "alert" }, t("warn.fullPage")));
      if (d.runtime === "server") {
        warnings.push(el("div", { class: "msg warn" }, t("warn.server")));
        if (policy && !policy.serverSandboxAvailable) warnings.push(el("div", { class: "msg warn" }, t("warn.serverSandbox", { reason: policy.serverSandboxReason ?? "" })));
      }
      for (const w of p.pkg.normalized.warnings) {
        if (w.code === "legacy-kind-full-page") warnings.push(el("div", { class: "msg warn" }, t("warn.legacyKind")));
        if (w.code === "version-dropped") warnings.push(el("div", { class: "msg warn" }, t("warn.versionDropped", { value: w.value })));
        if (w.code === "unknown-capabilities") warnings.push(el("div", { class: "msg warn" }, t("warn.unknownCaps", { values: w.values.join(", ") })));
        if (w.code === "unknown-kind") warnings.push(el("div", { class: "msg warn" }, t("warn.unknownKind", { kind: w.kind })));
      }
      if (view?.capabilitiesAdded.length) warnings.push(el("div", { class: "msg loud", role: "alert" }, t("warn.capabilitiesAdded", { values: view.capabilitiesAdded.join(", ") })));
      if (view?.capabilitiesRemoved.length) warnings.push(el("div", { class: "msg warn" }, t("warn.capabilitiesRemoved", { values: view.capabilitiesRemoved.join(", ") })));
      if (view && !view.sameCode && view.record.version !== null && view.record.version === d.version) warnings.push(el("div", { class: "msg warn" }, t("warn.sameVersionChanged", { version: d.version ?? "" })));
      if (view?.editedInMarinara && !view.sameCode) warnings.push(el("div", { class: "msg warn" }, t("warn.editedInMarinara")));
      if (view?.runtimeDiffers) warnings.push(el("div", { class: "msg err", role: "alert" }, t("warn.runtimeDiffers", { before: view.record.runtime, after: d.runtime })));
      if (view?.nameDiffers && !view.sameCode) warnings.push(el("div", { class: "msg warn" }, t("warn.nameDiffers", { before: view.record.name, after: d.name })));
      if (!view && p.engineListError) warnings.push(el("p", { class: "note" }, t("preview.engine.unavailable", { error: describeError(p.engineListError, t) })));
      const link = el("a", { href: p.pkg.browseUrl, target: "_blank", rel: "noopener noreferrer" }, describeSource(p.source));
      const files = el("ul", { class: "files" }, ...p.files.map((f) => el("li", {}, `${f.role}: ${f.path} (${formatBytes(f.bytes)}) `, el("code", {}, `sha256 ${f.sha256.slice(0, 16)}…`))));
      const code = el(
        "details",
        {},
        el("summary", {}, t("preview.code")),
        ...["css", "js", "serverJs"].filter((role) => d[role] !== null).map((role) => el("details", {}, el("summary", {}, `${role} (${formatBytes(new TextEncoder().encode(d[role] ?? "").byteLength)})`), el("pre", { class: `code-${role}` }, d[role] ?? "")))
      );
      const targetId = pendingExistingId ?? linking?.id ?? view?.record.id ?? p.tracked?.extensionId ?? null;
      const buttons = [];
      const busyLabel = busy ? t("action.busy") : null;
      if (view?.runtimeDiffers) {
      } else if (targetId && view?.sameCode) {
        buttons.push(el("button", { class: "primary", type: "button", disabled: busy, onClick: () => onInstall({ kind: "link", extensionId: targetId }) }, busyLabel ?? t("action.link")));
      } else if (targetId) {
        const label = pendingExistingId ? t("action.update") : t("action.updateTracked", { name: view?.record.name ?? p.tracked?.name ?? linking?.name ?? "" });
        buttons.push(el("button", { class: "primary", type: "button", disabled: busy, onClick: () => onInstall({ kind: "update", extensionId: targetId }) }, busyLabel ?? label));
        if (view && !view.sameCode && !pendingExistingId) {
          buttons.push(el("button", { type: "button", disabled: busy, onClick: () => onInstall({ kind: "link", extensionId: targetId }) }, t("action.link")));
        }
      } else {
        buttons.push(el("button", { class: "primary", type: "button", disabled: busy, onClick: () => onInstall({ kind: "create" }) }, busyLabel ?? t("action.install")));
      }
      buttons.push(el("button", { type: "button", disabled: busy, onClick: () => {
        prepared = null;
        pendingExistingId = null;
        installMessage = null;
        render();
      } }, t("action.cancel")));
      return el(
        "section",
        { class: "preview" },
        el("h3", {}, t("preview.heading")),
        ...warnings,
        p.tracked && !pendingExistingId && !view ? el("p", { class: "note" }, t("preview.tracked", { name: p.tracked.name, version: p.tracked.installedVersion ?? "?" })) : null,
        el(
          "dl",
          {},
          drow(t("preview.source"), link),
          p.pkg.ref ? drow(t("preview.branch"), p.pkg.ref) : null,
          drow(t("preview.name"), d.name),
          drow(t("preview.version"), d.version ?? t("preview.none")),
          drow(t("preview.description"), d.description || t("preview.none")),
          drow(t("preview.runtime"), t(d.runtime === "server" ? "preview.runtime.server" : "preview.runtime.client")),
          drow(t("preview.capabilities"), d.capabilities.length ? d.capabilities.join(", ") : t("preview.capabilities.none")),
          drow(t("preview.files"), files),
          drow(t("preview.downloaded"), formatBytes(p.pkg.downloadedBytes)),
          drow(t("preview.hash"), el("code", { class: "hash" }, p.contentHash), el("div", { class: "muted" }, t("preview.hash.hint"))),
          view ? drow(t("preview.engine"), t("preview.engine.record", { name: view.record.name, version: view.record.version ?? "?", state: t(view.record.enabled ? "preview.engine.enabled" : "preview.engine.disabled"), hash: shortHash(view.record.contentHash) })) : null,
          view ? drow(t("preview.changes"), changesBlock(p)) : null
        ),
        code,
        p.pkg.readme ? el("details", { class: "readme" }, el("summary", {}, `${t("preview.readme")} (${p.pkg.readme.path})`), el("pre", { class: "readme" }, p.pkg.readme.text)) : null,
        el("div", { class: "row", style: "margin-top:10px" }, ...buttons)
      );
    }
    function revisionsBlock(extension, record) {
      if (!revisionsFor || revisionsFor.id !== extension.id) return null;
      const list = revisionsFor.list;
      return el(
        "div",
        { class: "revisions-box line" },
        el("div", { class: "muted" }, t("revisions.heading")),
        list.length === 0 ? el("p", { class: "muted" }, t("revisions.none")) : el("ul", { class: "revisions" }, ...list.map((rev) => el(
          "li",
          {},
          t("revisions.item", { version: rev.version ?? "?", savedAt: formatDate(rev.savedAt) ?? rev.savedAt, hash: shortHash(rev.contentHash) }),
          " ",
          el("button", { class: "small", type: "button", disabled: busy, onClick: () => onRollback(extension, record, rev) }, t("action.rollback"))
        ))),
        el("button", { class: "small", type: "button", onClick: () => {
          revisionsFor = null;
          render();
        } }, t("close"))
      );
    }
    function codeBlock(extension) {
      if (codeFor !== extension.id) return null;
      const roles = ["css", "js", "serverJs"].filter((role) => extension[role]);
      return el(
        "div",
        { class: "line" },
        ...roles.map((role) => el("details", { open: true }, el("summary", {}, `${role} (${formatBytes(new TextEncoder().encode(extension[role] ?? "").byteLength)})`), el("pre", { class: `code-${role}` }, extension[role] ?? ""))),
        el("button", { class: "small", type: "button", onClick: () => {
          codeFor = null;
          render();
        } }, t("close"))
      );
    }
    function badges(x) {
      const list = [];
      if (x.enabled) list.push(el("span", { class: "badge on" }, t("badge.enabled")));
      else if (x.approvedHash === null) list.push(el("span", { class: "badge approve" }, t("badge.needsApproval")));
      else list.push(el("span", { class: "badge off" }, t("badge.disabled")));
      if (x.capabilities.includes("full_page_access")) list.push(el("span", { class: "badge loud" }, "full_page_access"));
      if (x.runtime === "server") list.push(el("span", { class: "badge" }, t("preview.runtime.server")));
      if (x.id === host.extensionId) list.push(el("span", { class: "badge" }, "Fetchy"));
      return list;
    }
    function autoApproveConfirm(record, extension) {
      if (!autoFor || autoFor.id !== record.id) return null;
      const state = autoFor;
      const fullPage = extension.capabilities.includes("full_page_access");
      const ready2 = state.code && (!fullPage || state.fullPage);
      return el(
        "div",
        { class: "msg loud auto-confirm" },
        el("div", {}, t("auto.confirm.title", { name: record.name })),
        el("p", { class: "line", style: "font-weight:400" }, t("auto.confirm.body", { source: describeSource(record.source) })),
        el("label", { class: "toggle", style: "white-space:normal;color:inherit" }, el("input", { type: "checkbox", class: "ack-code", onChange: (e) => {
          state.code = e.target.checked;
          render();
        } }), t("auto.ack.code")),
        fullPage ? el("label", { class: "toggle", style: "white-space:normal;color:inherit" }, el("input", { type: "checkbox", class: "ack-full-page", onChange: (e) => {
          state.fullPage = e.target.checked;
          render();
        } }), t("auto.ack.fullPage")) : null,
        el(
          "div",
          { class: "actions" },
          el("button", { class: "small primary", type: "button", disabled: busy || !ready2, onClick: () => onAutoApprove(record, true) }, t("auto.confirm.on")),
          el("button", { class: "small", type: "button", onClick: () => {
            autoFor = null;
            render();
          } }, t("action.cancel"))
        )
      );
    }
    function itemRow(extension, record) {
      const key = extension?.id ?? `record:${record?.id ?? ""}`;
      const open2 = expanded.has(key);
      const name = extension?.name ?? record?.name ?? "?";
      const version = extension?.version ?? record?.installedVersion ?? null;
      const needsUpdate = !!record?.latest && (record.latest.state === "update" || record.latest.state === "changed" || record.latest.state === "older");
      const toggleMore = () => {
        if (open2) expanded.delete(key);
        else expanded.add(key);
        render();
      };
      const primary = [];
      if (record && extension) {
        primary.push(el("button", { class: "small", type: "button", disabled: busy, onClick: () => onCheckOne(record) }, t("action.check")));
        if (needsUpdate) primary.push(el("button", { class: "small primary", type: "button", disabled: busy, onClick: () => onUpdate(record) }, t("action.update")));
      }
      if (extension && !record) primary.push(el("button", { class: "small", type: "button", disabled: busy, onClick: () => startLink(extension) }, t("untracked.link")));
      if (record && !extension) primary.push(el("button", { class: "small", type: "button", disabled: busy, onClick: () => {
        urlInput = record.input;
        prepared = null;
        render();
        void onFetch();
      } }, t("action.reinstall")));
      primary.push(el("button", { class: "small", type: "button", onClick: toggleMore }, open2 ? t("action.less") : t("action.more")));
      const more = [];
      if (open2) {
        if (record && extension) {
          more.push(el("button", { class: "small", type: "button", disabled: busy, onClick: () => onUpdate(record) }, t("action.update")));
          more.push(el("a", { href: browseUrl(record.source, record.ref), target: "_blank", rel: "noopener noreferrer" }, el("button", { class: "small", type: "button" }, t("action.open"))));
        }
        if (extension) {
          more.push(el("button", { class: "small", type: "button", disabled: busy, onClick: () => {
            codeFor = codeFor === extension.id ? null : extension.id;
            render();
          } }, t("action.code")));
          more.push(el("button", { class: "small", type: "button", disabled: busy, onClick: () => onRevisions(extension) }, t("action.revisions")));
          if (extension.enabled && extension.id !== host.extensionId) more.push(el("button", { class: "small", type: "button", disabled: busy, onClick: () => onDisable(extension) }, t("action.disable")));
          if (extension.id !== host.extensionId) more.push(el("button", { class: "small", type: "button", disabled: busy, onClick: () => {
            deleting = extension.id;
            render();
          } }, t("action.delete")));
        }
        if (record) more.push(el("button", { class: "small", type: "button", disabled: busy, onClick: () => onForget(record, false) }, t("action.forget.listOnly")));
        if (record && extension) {
          more.push(el("label", { class: "toggle" }, el("input", {
            type: "checkbox",
            class: "auto-approve",
            checked: record.autoApprove === true,
            disabled: busy,
            onChange: (e) => {
              const on = e.target.checked;
              if (!on) {
                void onAutoApprove(record, false);
                return;
              }
              autoFor = { id: record.id, code: false, fullPage: false };
              render();
            }
          }), t("auto.label"), help(t("help.autoApprove"))));
        }
      }
      const confirm = extension && deleting === extension.id ? el(
        "div",
        { class: "actions" },
        el("span", {}, t("action.confirmDelete", { name })),
        el("button", { class: "small primary", type: "button", disabled: busy, onClick: () => onDelete(extension) }, t("action.delete")),
        el("button", { class: "small", type: "button", onClick: () => {
          deleting = null;
          render();
        } }, t("action.cancel"))
      ) : null;
      const sourceText = record ? describeSource(record.source) + (record.ref && !(record.source.kind === "github-repo" && record.source.ref) ? ` @${record.ref}` : "") : null;
      const stateText = record?.lastError ? t("sources.error", { error: record.lastError }) : record?.latest && record.latest.state !== "up-to-date" ? t(`sources.state.${record.latest.state}`, { version: record.latest.version ?? "?" }) : null;
      return el(
        "li",
        { "data-extension": extension?.id ?? "", "data-record": record?.id ?? "" },
        el(
          "div",
          { class: "row between" },
          el(
            "div",
            {},
            el("span", { class: "name" }, name),
            " ",
            el("span", { class: "muted" }, `v${version ?? "?"}`),
            " ",
            ...extension ? badges(extension) : [el("span", { class: "badge loud" }, t("log.missing"))],
            record?.autoApprove ? el("span", { class: "badge approve" }, t("auto.badge")) : null
          ),
          el("div", { class: "row" }, ...primary)
        ),
        sourceText || stateText ? el("div", { class: "muted line" }, sourceText ?? "", sourceText && stateText ? " · " : "", stateText ? el("span", { class: `state ${record?.latest?.state ?? ""}` }, stateText) : null) : null,
        extension && extension.approvedHash === null && !extension.enabled ? el("div", { class: "muted line" }, t("item.approveHint")) : null,
        open2 ? el(
          "div",
          { class: "muted line" },
          el("code", {}, extension?.contentHash ?? record?.installedHash ?? ""),
          extension ? ` · ${formatDate(extension.updatedAt) ?? ""}` : "",
          record?.lastCheckedAt ? ` · ${t("sources.lastCheck")} ${formatDate(record.lastCheckedAt)}` : "",
          record ? null : ` · ${t("item.notFromFetchy")}`
        ) : null,
        open2 && !confirm ? el("div", { class: "actions" }, ...more) : null,
        confirm,
        record && extension ? autoApproveConfirm(record, extension) : null,
        extension ? revisionsBlock(extension, record) : null,
        extension ? codeBlock(extension) : null
      );
    }
    function itemsSection() {
      const list = rows ?? records.map((record) => ({ extension: null, record }));
      const sorted = [...list].sort((a, b) => (a.extension?.name ?? a.record?.name ?? "").localeCompare(b.extension?.name ?? b.record?.name ?? ""));
      return el(
        "section",
        { class: "items" },
        el(
          "div",
          { class: "row between" },
          el("h3", {}, t("items.heading"), help(t("help.items"))),
          el(
            "div",
            { class: "row" },
            el("button", { class: "small", type: "button", disabled: busy || records.length === 0, onClick: onCheckAll }, t("action.checkAll")),
            el("button", { class: "small primary", type: "button", disabled: busy || !records.some((r) => r.latest && r.latest.state !== "up-to-date" && r.latest.state !== "unknown"), onClick: onUpdateAll }, t("action.updateAll")),
            el("label", { class: "toggle" }, el("input", {
              type: "checkbox",
              class: "keep-enabled",
              checked: keepEnabled,
              disabled: busy,
              onChange: (e) => {
                const on = e.target.checked;
                if (!on) {
                  setKeepEnabled(false);
                  return;
                }
                keepFor = { code: false };
                render();
              }
            }), t("option.keepEnabled"), help(t("help.keepEnabled"))),
            el("button", { class: "small", type: "button", disabled: busy, onClick: onRefresh }, t("action.refresh"))
          )
        ),
        keepFor ? el(
          "div",
          { class: "msg loud keep-confirm" },
          el("div", {}, t("keep.confirm.title")),
          el("p", { class: "line", style: "font-weight:400" }, t("keep.confirm.body")),
          el("label", { class: "toggle", style: "white-space:normal;color:inherit" }, el("input", { type: "checkbox", class: "ack-code", onChange: (e) => {
            if (keepFor) keepFor.code = e.target.checked;
            render();
          } }), t("auto.ack.code")),
          el(
            "div",
            { class: "actions" },
            el("button", { class: "small primary", type: "button", disabled: !keepFor.code, onClick: () => setKeepEnabled(true) }, t("auto.confirm.on")),
            el("button", { class: "small", type: "button", onClick: () => {
              keepFor = null;
              render();
            } }, t("action.cancel"))
          )
        ) : null,
        rowsError ? el("p", { class: "msg warn" }, t("items.unavailable", { error: rowsError })) : null,
        sorted.length === 0 ? el("p", { class: "muted" }, t("items.empty")) : el("ul", { class: "items" }, ...sorted.map((r) => itemRow(r.extension, r.record))),
        message(reconcileMessage),
        message(sourcesMessage),
        fold(
          "prefs",
          [t("prefs.heading")],
          el(
            "div",
            { class: "actions" },
            el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: autoCheck, onChange: (e) => setAutoCheck(e.target.checked) }), t("action.autoCheck"), help(t("help.autoCheck"))),
            el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: floating, onChange: (e) => setFloating(e.target.checked) }), t("option.floating"), help(t("help.floating"))),
            el("button", { class: "small", type: "button", disabled: records.length === 0, onClick: () => {
              transfer = { kind: "export", text: exportSources(records) };
              render();
            } }, t("action.export")),
            el("button", { class: "small", type: "button", onClick: () => {
              transfer = { kind: "import", text: "" };
              render();
            } }, t("action.import")),
            help(t("help.transfer")),
            el("span", { class: "muted" }, t("anchor.hint"))
          ),
          transferBlock(),
          logBlock()
        )
      );
    }
    function transferBlock() {
      if (!transfer) return null;
      if (transfer.kind === "export") {
        const area2 = el("textarea", { readonly: true, "aria-label": t("action.export") }, transfer.text);
        return el(
          "div",
          { class: "transfer" },
          el("p", { class: "note" }, t("result.exported")),
          area2,
          el(
            "div",
            { class: "row" },
            el("button", { class: "small", type: "button", onClick: () => {
              area2.select();
              void navigator.clipboard?.writeText(area2.value).then(() => {
                sourcesMessage = { kind: "ok", text: t("result.copied") };
                render();
              }).catch(() => {
              });
            } }, t("action.copy")),
            el("button", { class: "small", type: "button", onClick: () => {
              transfer = null;
              render();
            } }, t("close"))
          )
        );
      }
      const area = el("textarea", { placeholder: '{ "kind": "me-fetchy.sources", … }', "aria-label": t("action.import") }, transfer.text);
      area.addEventListener("input", () => {
        if (transfer?.kind === "import") transfer.text = area.value;
      });
      return el(
        "div",
        { class: "transfer" },
        area,
        el(
          "div",
          { class: "row" },
          el("button", { class: "small primary", type: "button", disabled: busy, onClick: () => onImport(area.value) }, t("action.apply")),
          el("button", { class: "small", type: "button", onClick: () => {
            transfer = null;
            render();
          } }, t("action.cancel"))
        )
      );
    }
    function fold(key, summary, ...body) {
      const node = el("details", { class: `fold ${key}`, open: folds.has(key) }, el("summary", {}, ...summary), ...body);
      node.addEventListener("toggle", () => {
        if (node.open) folds.add(key);
        else folds.delete(key);
      });
      return node;
    }
    function logBlock() {
      const fmt = (e) => `${new Date(e.at).toLocaleString()} · ${e.action} · ${e.result} · ${e.name}` + (e.from || e.to ? ` · v${e.from?.version ?? "-"} → v${e.to?.version ?? "-"}` : "") + (e.detail ? ` · ${e.detail}` : "");
      return fold(
        "log",
        [t("log.heading"), help(t("help.log"))],
        el(
          "div",
          { class: "actions" },
          el("button", { class: "small", type: "button", disabled: logEntries.length === 0, onClick: () => {
            void navigator.clipboard?.writeText(AuditLog.format(logEntries)).then(() => {
              sourcesMessage = { kind: "ok", text: t("result.copied") };
              render();
            }).catch(() => {
            });
          } }, t("log.export")),
          el("button", { class: "small", type: "button", disabled: logEntries.length === 0, onClick: () => guard(async () => {
            await audit.clear();
            await loadLog();
          }) }, t("log.clear"))
        ),
        logEntries.length === 0 ? el("p", { class: "muted" }, t("log.empty")) : el("ul", { class: "log" }, ...logEntries.map((e) => el("li", { class: e.result }, fmt(e))))
      );
    }
    function render() {
      backdrop.hidden = !isOpen;
      launcher.setAttribute("aria-expanded", String(isOpen));
      panel.replaceChildren(fragment(
        el(
          "header",
          {},
          el(
            "h2",
            {},
            t("title"),
            el("span", { class: "ver" }, `v${options.version}`),
            jsDigest ? el("span", { class: "badge digest", title: t("badge.jsDigest.title") }, t("badge.jsDigest")) : null
          ),
          el(
            "div",
            { class: "tools" },
            el("button", { class: "small", type: "button", onClick: switchLang }, t("lang.switch")),
            el("button", { class: "small", type: "button", "aria-label": t("close"), onClick: () => close() }, "✕")
          )
        ),
        gateLine(),
        el(
          "section",
          { class: "install" },
          el("h3", {}, t("install.heading"), help(t("help.install"))),
          linking ? el(
            "div",
            { class: "msg warn" },
            t("install.linkHint", { name: linking.name }),
            " ",
            el("button", { class: "small", type: "button", onClick: () => {
              linking = null;
              prepared = null;
              render();
            } }, t("install.cancelLink"))
          ) : null,
          el(
            "form",
            { class: "row", onSubmit: (e) => {
              e.preventDefault();
              void onFetch();
            } },
            el("input", {
              type: "text",
              class: "url",
              "aria-label": t("install.heading"),
              placeholder: t("install.placeholder"),
              value: urlInput,
              disabled: busy,
              autocomplete: "off",
              spellcheck: "false",
              onInput: (e) => {
                urlInput = e.target.value;
              }
            }),
            el("button", { class: "primary", type: "submit", disabled: busy }, busy && !prepared ? t("install.fetching") : t("install.fetch"))
          ),
          message(installMessage)
        ),
        prepared ? previewSection(prepared) : null,
        itemsSection()
      ));
    }
    function open() {
      isOpen = true;
      render();
      panel.focus();
      void Promise.all([loadPolicy(), loadRows(), loadLog(), reconcileRecords()]).then(() => {
        render();
        if (autoCheck && records.length && !busy) void onCheckAll();
      });
    }
    function close() {
      isOpen = false;
      reconcileMessage = null;
      render();
      if (floating) launcher.focus();
    }
    function toggle() {
      if (isOpen) close();
      else open();
    }
    const ready = (async () => {
      try {
        const data = await host.storage.get();
        if (data.lang === "ko" || data.lang === "en") i18n.lang = data.lang;
        autoCheck = data.autoCheck === true;
        floating = data.floating === true;
        keepEnabled = data.keepEnabled === true;
        launcher.hidden = !floating;
      } catch {
      }
      launcher.textContent = t("launcher");
      launcher.title = t("launcher.title");
      await Promise.all([loadPolicy(), loadRecords()]);
      render();
    })();
    render();
    return {
      root,
      hostElement,
      open,
      close,
      toggle,
      ready,
      get anchored() {
        return anchor.attached;
      },
      destroy() {
        anchor.destroy();
        doc.removeEventListener("keydown", onShortcut);
        hostElement.remove();
      }
    };
  }

  // src/index.ts
  var VERSION = true ? "0.7.3" : "0.0.0";
  function boot() {
    const api = typeof marinara !== "undefined" ? marinara : void 0;
    const host = hostFromMarinara(api);
    if (!api) host.log.warn("running without the Marinara full-page API; storage is unavailable");
    document.getElementById(HOST_ELEMENT_ID)?.remove();
    const client = createEngineClient({ fetch: host.fetch, adminSecret: host.adminSecret });
    const store = new SourcesStore(host.storage);
    const panel = mountPanel({ host, client, store, version: VERSION });
    host.onCleanup(() => panel.destroy());
    host.log.info(`Fetchy ${VERSION} ready`);
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
