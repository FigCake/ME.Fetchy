/*! Fetchy 0.9.0 — extension installer for Marinara Engine 2.5.x (External Extension).
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
  var utf8Length = (text2) => utf8.encode(text2).byteLength;
  async function readPaths(value, role, read, files) {
    if (value == null) return null;
    const paths = (Array.isArray(value) ? value : [value]).filter((p) => typeof p === "string" && p.trim() !== "");
    const parts = [];
    if (files.length + paths.length > LIMITS.filesPerManifest) throw new ManifestError({ code: "too-many-files", count: files.length + paths.length });
    for (const path of paths) {
      const text2 = await read(path);
      if (text2 == null) throw new ManifestError({ code: "file-missing", path });
      const bytes = utf8Length(text2);
      if (bytes > LIMITS.textFileBytes) throw new ManifestError({ code: "file-too-large", path, bytes });
      files.push({ path, role, bytes });
      parts.push(text2);
    }
    return parts.length ? parts.join("\n\n") : null;
  }
  function inline(value, role, files) {
    if (typeof value !== "string") return null;
    files.push({ path: `(inline ${role})`, role, bytes: utf8Length(value) });
    return value;
  }
  async function normalizeManifest(parsed, read) {
    const entry = singleEntry(parsed);
    const config = configOf(entry);
    if (!config) throw new ManifestError({ code: "not-an-object" });
    const kind = kindOf(entry);
    const warnings = [];
    const files = [];
    if (kind && !KNOWN_KINDS.includes(kind)) warnings.push({ code: "unknown-kind", kind });
    const name = checkedName(config);
    const { version, dropped } = normalizeVersion(config.version);
    if (dropped !== null) warnings.push({ code: "version-dropped", value: dropped });
    const description = checkedDescription(config);
    const about = { name, version, description };
    const draft = runtimeOf(config, kind) === "server" ? await serverDraft(about, config, read, files) : await clientDraft(about, config, kind, read, files, warnings);
    return { kind, warnings, files, draft };
  }
  function singleEntry(parsed) {
    const all = entries(parsed);
    if (all.length === 0) throw new ManifestError({ code: "no-entries" });
    if (all.length > 1) throw new ManifestError({ code: "multiple-entries", names: all.map(nameOf) });
    return all[0];
  }
  function checkedName(config) {
    const name = typeof config.name === "string" ? config.name.trim() : "";
    if (!name) throw new ManifestError({ code: "name-missing" });
    if (name.length > LIMITS.nameLength) throw new ManifestError({ code: "name-too-long", length: name.length });
    return name;
  }
  function checkedDescription(config) {
    const description = typeof config.description === "string" ? config.description : "";
    if (description.length > LIMITS.descriptionLength) {
      throw new ManifestError({ code: "description-too-long", length: description.length });
    }
    return description;
  }
  function runtimeOf(config, kind) {
    return typeof config.runtime === "string" && config.runtime.toLowerCase() === "server" || kind === "marinara.server-extension" || kind === "marinara.personal-server-extension" ? "server" : "client";
  }
  async function serverDraft(about, config, read, files) {
    const serverJs = await readPaths(config.serverJsPath ?? config.serverJsPaths ?? config.jsPath ?? config.jsPaths, "serverJs", read, files) ?? inline(config.serverJs ?? config.js, "serverJs", files);
    if (!serverJs?.trim()) throw new ManifestError({ code: "server-no-code" });
    return { ...about, runtime: "server", capabilities: [], css: null, js: null, serverJs };
  }
  async function clientDraft(about, config, kind, read, files, warnings) {
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
    return { ...about, runtime: "client", capabilities, css, js, serverJs: null };
  }
  function apiPayload(draft) {
    return draft.runtime === "server" ? { name: draft.name, version: draft.version, description: draft.description, runtime: "server", capabilities: [], serverJs: draft.serverJs } : { name: draft.name, version: draft.version, description: draft.description, runtime: "client", capabilities: draft.capabilities, css: draft.css, js: draft.js };
  }
  function manifestVersion(parsed) {
    try {
      const config = configOf(singleEntry(parsed));
      return config ? normalizeVersion(config.version).version : null;
    } catch {
      return null;
    }
  }

  // src/engine-api.ts
  var EngineApiError = class extends Error {
    constructor(code, status, message2, existingId = null) {
      super(message2);
      this.code = code;
      this.status = status;
      this.existingId = existingId;
      this.name = "EngineApiError";
    }
    code;
    status;
    existingId;
  };
  var STORAGE_LIMIT_BYTES = 1e6;
  var ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  function canReenable(x) {
    return !x.enabled && x.approvedHash !== null && x.approvedHash === x.contentHash;
  }
  async function errorFrom(response) {
    let payload = null;
    let text2 = "";
    try {
      text2 = await response.text();
      payload = JSON.parse(text2);
    } catch {
    }
    const record = payload && typeof payload === "object" ? payload : {};
    const message2 = [record.error, record.message].filter((v) => typeof v === "string").join(" ") || text2 || `HTTP ${response.status}`;
    const existingId = typeof record.id === "string" ? record.id : null;
    const status = response.status;
    const lower = message2.toLowerCase();
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
    return new EngineApiError(code, status, message2, existingId);
  }
  function storageValue(answer) {
    const value = answer && typeof answer === "object" ? answer.value : void 0;
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    throw new EngineApiError("http", 200, "Marinara answered the storage request in an unexpected shape");
  }
  function createEngineClient(options) {
    const base = (options.baseUrl ?? "").replace(/\/$/, "") + "/api/personal-extensions";
    async function request(method, path, body2) {
      const headers = new Headers();
      headers.set("Accept", "application/json");
      if (method !== "GET") {
        headers.set("x-marinara-csrf", "1");
        if (body2 !== void 0) headers.set("Content-Type", "application/json");
      }
      const secret = options.adminSecret();
      if (secret) headers.set("X-Admin-Secret", secret);
      let response;
      try {
        response = await options.fetch(base + path, {
          method,
          headers,
          body: body2 === void 0 ? void 0 : JSON.stringify(body2),
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
    async function approve(id, contentHash, fullPageAccess) {
      if (!/^sha256:[a-f0-9]{64}$/.test(contentHash)) throw new EngineApiError("validation", 400, `Not a content hash: ${contentHash}`);
      const body2 = { contentHash, acknowledgeSandboxedCode: true };
      if (fullPageAccess) body2.acknowledgeFullPageAccess = true;
      return (await request("POST", `${idPath(id)}/approve`, body2)).json();
    }
    async function list() {
      const value = await (await request("GET", "")).json();
      return Array.isArray(value) ? value : [];
    }
    return {
      async policy() {
        return (await request("GET", "/policy")).json();
      },
      list,
      async create(draft) {
        return (await request("POST", "", apiPayload(draft))).json();
      },
      async update(id, draft) {
        return (await request("PATCH", idPath(id), apiPayload(draft))).json();
      },
      approve,
      async enable(id, contentHash, fullPageAccess) {
        const current = (await list()).find((x) => x.id === id);
        if (!current) throw new EngineApiError("not-found", 404, `Marinara has no extension ${id}`);
        if (current.enabled && current.approvedHash === current.contentHash && current.contentHash === contentHash) return current;
        if (current.contentHash !== contentHash || !canReenable(current)) {
          throw new EngineApiError("needs-approval", 0, `${current.contentHash} is not the approved code; approve it in Marinara`);
        }
        return approve(id, contentHash, fullPageAccess);
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
      },
      async readStorage(id) {
        return storageValue(await (await request("GET", `${idPath(id)}/storage`)).json());
      },
      async patchStorage(id, value) {
        return storageValue(await (await request("PATCH", `${idPath(id)}/storage`, value)).json());
      },
      async clearStorage(id) {
        await request("DELETE", `${idPath(id)}/storage`);
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
    const log3 = {
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
      log: log3,
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
  var COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
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
  function parseRepo(value) {
    if (!isRecord2(value) || typeof value.archived !== "boolean" || typeof value.checkedAt !== "string") return null;
    return { archived: value.archived, pushedAt: str(value.pushedAt), checkedAt: value.checkedAt };
  }
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
    const commit = str(value.installedCommit);
    const repo = parseRepo(value.repo);
    return {
      id,
      source,
      name,
      extensionId,
      installedHash,
      ...commit && COMMIT_SHA.test(commit) ? { installedCommit: commit } : {},
      input: str(value.input) ?? "",
      ref: str(value.ref),
      installedVersion: str(value.installedVersion),
      installedAt: str(value.installedAt) ?? "",
      lastCheckedAt: str(value.lastCheckedAt),
      latest: parseLatest(value.latest),
      lastError: str(value.lastError),
      autoApprove: value.autoApprove === true,
      autoUpdate: value.autoUpdate === true,
      ...repo ? { repo } : {}
    };
  }
  var sameParsedSource = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function mergeImported(existing, incoming) {
    const records = [...existing];
    const byExtension = new Map(records.map((r) => [r.extensionId, r]));
    const ids2 = new Set(records.map((r) => r.id));
    let added = 0, kept = 0, different = 0;
    for (const record of incoming) {
      const current = byExtension.get(record.extensionId);
      if (current) {
        kept++;
        if (!sameParsedSource(current.source, record.source)) different++;
        continue;
      }
      const fresh = {
        ...record,
        // the file's id may belong to another extension here
        id: ids2.has(record.id) ? newRecordId() : record.id,
        lastCheckedAt: null,
        latest: null,
        lastError: null,
        autoApprove: false,
        autoUpdate: false
      };
      records.push(fresh);
      byExtension.set(fresh.extensionId, fresh);
      ids2.add(fresh.id);
      added++;
    }
    return { records, added, kept, different };
  }
  function newRecordId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  var sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function mergeRecord(current, before, after, fromInstall = false) {
    if (fromInstall && current.installedHash !== before.installedHash && after.installedHash === before.installedHash) return current;
    const out = { ...current };
    const was = before;
    const now = after;
    for (const key of /* @__PURE__ */ new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (sameValue(was[key], now[key])) continue;
      if (now[key] === void 0) delete out[key];
      else out[key] = now[key];
    }
    return out;
  }
  function applyChanges(stored, changes) {
    let list = [...stored];
    for (const { before, after, fromInstall } of changes) {
      if (before && after) list = list.map((r) => r.id === before.id ? mergeRecord(r, before, after, fromInstall) : r);
      else if (before) list = list.filter((r) => r.id !== before.id);
      else if (after && !list.some((r) => r.id === after.id || r.extensionId === after.extensionId)) list.push(after);
    }
    return list;
  }
  function changesBetween(before, after, fromInstall = false) {
    const was = new Map(before.map((r) => [r.id, r]));
    const now = new Map(after.map((r) => [r.id, r]));
    const changes = [];
    for (const r of before) {
      const next = now.get(r.id);
      if (!next) changes.push({ before: r, after: null });
      else if (!sameValue(r, next)) changes.push({ before: r, after: next, ...fromInstall ? { fromInstall } : {} });
    }
    for (const r of after) if (!was.has(r.id)) changes.push({ before: null, after: r });
    return changes;
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
    /** Replaces the stored list as given, whatever it holds now. Tests seed with it; Fetchy writes through commit or mutate. */
    async overwrite(records) {
      await this.storage.patch({ [SCHEMA_KEY]: SCHEMA_VERSION, [STORAGE_KEY]: records });
    }
    /** Writes in this tab, one after another: two read-then-write steps never overlap. */
    queue = Promise.resolve();
    /** Reads the list, lets `fn` change it, writes the result and returns it (after any write already under way here). */
    mutate(fn) {
      const run = this.queue.then(async () => {
        const next = fn(await this.load());
        await this.overwrite(next);
        return next;
      });
      this.queue = run.catch(() => {
      });
      return run;
    }
    /** Writes this tab's changes over the list as it is now (applyChanges). */
    async commit(changes) {
      if (changes.length === 0) return this.load();
      return this.mutate((list) => applyChanges(list, changes));
    }
    /** Inserts or replaces by installer id; a record for the same Marinara extension id is replaced too. */
    async upsert(record) {
      return this.mutate((list) => [...list.filter((r) => r.id !== record.id && r.extensionId !== record.extensionId), record]);
    }
    async remove(id) {
      return this.mutate((list) => list.filter((r) => r.id !== id));
    }
  };

  // src/anchor.ts
  var SECTION_ID = "settings-section-external-extensions";
  var ANCHOR_BUTTON_ID = "me-fetchy-settings-button";
  var DOT_STYLE = "display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--primary, #6b63d8);margin-left:6px;vertical-align:middle;flex:0 0 auto";
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
    const dot = doc.createElement("span");
    dot.setAttribute("style", DOT_STYLE);
    dot.setAttribute("role", "img");
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
      setDot(on, dotLabel) {
        if (on) {
          dot.setAttribute("aria-label", dotLabel ?? "");
          button.title = dotLabel ?? "";
          if (dot.parentElement !== button) button.appendChild(dot);
        } else {
          dot.remove();
          button.removeAttribute("title");
        }
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
  function scrub(text2) {
    return text2.replace(/x-admin-secret\s*[:=]\s*\S+/gi, "x-admin-secret: [redacted]").replace(/(authorization|token|secret|password)\s*[:=]\s*\S+/gi, "$1: [redacted]").slice(0, 300);
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
      const side3 = (s) => s ? `v${s.version ?? "?"} ${s.hash ?? "-"} [${s.capabilities.join(",")}]` : "-";
      return [
        "at	action	result	extension	name	source	from	to	detail",
        ...entries2.map((e) => [e.at, e.action, e.result, e.extensionId ?? "-", e.name, e.source ? `${e.source}${e.ref ? `@${e.ref}` : ""}` : "-", side3(e.from), side3(e.to), e.detail ?? ""].join("	"))
      ].join("\n");
    }
  };

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
    "catalog.heading": "FigCake extensions",
    "bundle.button": "Bundle install",
    "bundle.title": "FigCake extensions",
    "bundle.hasUpdate": "Updates for FigCake extensions",
    "catalog.update": "update {version}",
    "organize.heading": "Folders and tags",
    "organize.folders": "Folders",
    "organize.tags": "Tags",
    "organize.add": "Add",
    "organize.newFolder": "New folder",
    "organize.newTag": "New tag",
    "organize.delete": "Delete",
    "organize.noFolder": "No folder",
    "organize.allTags": "All",
    "organize.folder": "Folder",
    "organize.empty": "None yet",
    "preview.details": "Files and sizes",
    "catalog.help": "Installs several of FigCake's extensions at once, one after another, from their GitHub repositories. Each goes into Marinara switched off, as a single install does; an installed one is updated (switched back on at once if it was on and “Keep updated extensions on” is set), one with the same code is only linked.",
    "catalog.installedElsewhere": "same name {version}, installed another way",
    "catalog.willOff": "Updating switches it off until you approve it again in Marinara (unless “Keep updated extensions on” is set).",
    "catalog.staysOn": "Updating keeps it on (“Keep updated extensions on” is set).",
    "catalog.skipped.newer": "{name}: left as it is — the installed version is newer than what its repository publishes. Install {input} from the address box above to see what would change.",
    "catalog.skipped.current": "{name}: already up to date.",
    "catalog.stopped": "{name}: not tried — it would fail for the same reason as the one before.",
    "catalog.reload": "Marinara's own list (Settings → Addons) shows the change after you reload the page.",
    "catalog.installed": "installed {version}",
    "catalog.missing": "not installed",
    "catalog.install": "Install the chosen ({count})",
    "catalog.progress": "Installing {name} ({done}/{total})…",
    "catalog.done": "Done: {ok} of {total}.",
    "catalog.skipped.runtime": "{name}: left as it is — the installed one runs elsewhere (client/server), so it can't be replaced here.",
    "catalog.skipped.edited": "{name}: left as it is — its code was changed in Marinara's editor. Install {input} from the address box above to see what would change.",
    "catalog.skipped.other": "{name}: left as it is — Marinara has an extension of this name that Fetchy didn't install from FigCake's repository (by hand, or from elsewhere). Install {input} from the address box above to see what would change.",
    "catalog.failed": "{name}: {error}",
    "catalog.fullPage": "All of these ask for full page access: each can read and change everything on the Marinara page, API keys and chats included. Install them only if you trust the author.",
    "catalog.unknown": "unknown",
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
    "action.checkAll": "Check all",
    "result.selfUpdatedOn": "Updated Fetchy and switched it back on.",
    "action.updateAll": "Update all",
    "option.keepEnabled": "Keep updated extensions on",
    "help.keepEnabled": "Whenever an extension that was on gets updated, here or with Update all, approve the new code and switch it back on right away, without reading it. Not applied when the new version asks for new capabilities.",
    "keep.confirm.title": "Keep updated extensions on?",
    "keep.confirm.body": "Fetchy will approve updated code and switch extensions back on without you reading it, for every update made here. Code published by those repositories will then run in your Marinara as soon as you press Update (or install the chosen FigCake extensions). Versions that ask for new capabilities are never approved this way.",
    "result.updatedAll": "Updated {ok} of {total}.",
    "result.updatedAllOne": "{name}: {text}",
    "result.nothingToUpdate": 'Nothing to update. Press "Check all" first.',
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
    "result.imported": "Imported {imported} new source(s), with automatic updates and auto re-approval off.",
    "result.importKept": "{kept} already in the list were left as they are.",
    "result.importDifferent": "{different} of them name another address in the file; that address was not used (to follow it, choose Remove → “Remove from this list only”, then install from it).",
    "result.importIgnored": "{ignored} entr(ies) were not valid.",
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
    "error.install.edited": "left as it is — its code was changed in Marinara since Fetchy installed it, so it isn't updated automatically. Update it on its own to replace that code (Marinara keeps the current code as a revision when revisions are kept).",
    "error.import.invalid": "That is not an exported source list.",
    "anchor.button": "Install from GitHub",
    "anchor.hint": "Shortcut: Alt+Shift+F",
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
    "notify.title": "{count} update(s) for your extensions",
    "notify.open": "Open",
    "notify.later": "Later",
    "anchor.hasUpdate": "An update is waiting",
    "self.newVersion": "A new Fetchy is out: {version}.",
    "self.addSource": "Add as a source to update",
    "option.notify": "Update notice",
    "help.notify": "A little after Marinara opens, at most every 6 hours, Fetchy reads each source’s manifest.json (a small file; no code, no GitHub API) and shows a notice when a newer version is out. Each version is noticed once.",
    "changes.heading": "What changed",
    "changes.loading": "Reading the commits…",
    "changes.noBase": "Fetchy doesn’t know which commit this was installed from (installed before 0.9, rolled back, or updated while the panel was closed). See the history on GitHub.",
    "changes.more": "More than {count}: the rest on GitHub.",
    "changes.none": "No commit in this folder since the installed one.",
    "changes.history": "History on GitHub",
    "repo.archived": "archived",
    "repo.archived.title": "Its repository is archived on GitHub: the author no longer works on it. Last push: {date}",
    "repo.stale": "not updated for 6 months",
    "repo.stale.title": "No push to its repository for over 6 months. Last push: {date}",
    "action.diagnostics": "Copy diagnostics",
    "help.diagnostics": "Copies a text for a bug report: Marinara’s and Fetchy’s versions, the gates, the browser, and each extension’s version, state, source and last check, with the latest change log. Never code, stored data or the admin secret (only whether one is set).",
    "result.diagnosticsCopied": "Diagnostics copied. Paste them into your report.",
    "wizard.title": "First-time setup",
    "wizard.stepOf": "{step}/{total} · {name}",
    "wizard.skip": "Skip",
    "wizard.back": "Back",
    "wizard.next": "Next",
    "wizard.finish": "Finish",
    "wizard.again": "Show first-time setup again",
    "wizard.status.heading": "What Marinara allows",
    "wizard.status.intro": "Fetchy can install only what Marinara lets in. A ✗ says what to change.",
    "wizard.status.env": "ENABLE_EXTERNAL_EXTENSIONS=true in the server .env",
    "wizard.status.switch": "“Allow third-party extension imports” is on",
    "wizard.status.admin": "Fetchy may manage extensions (Admin Access)",
    "wizard.status.adminFix": "On a remote Marinara: set ADMIN_SECRET in the server .env, then enter it under Settings → Admin Access, and open this again.",
    "wizard.status.sandbox": "Server extension sandbox",
    "wizard.status.sandboxNote": "Only server-side extensions need it; FigCake’s extensions run in the browser.",
    "wizard.pick.heading": "Pick",
    "wizard.pick.intro": "Tick the FigCake extensions you want. Each goes in switched off; you approve it in Marinara afterwards.",
    "wizard.options.heading": "Options",
    "wizard.install.heading": "Install",
    "wizard.install.none": "Nothing is ticked. Go back to pick, or go on.",
    "wizard.approve.heading": "Approve in Marinara",
    "wizard.approve.how": "Open Settings → Addons → External Extensions, open each one below → Review and Run, read the code and approve it. The hash there must be the one shown here. Then press “Check again”.",
    "wizard.approve.none": "None of FigCake’s extensions is in Marinara yet.",
    "wizard.approve.recheck": "Check again",
    "storage.title": "Stored data",
    "storage.open": "Stored data",
    "help.storage": "What each extension keeps in Marinara (at most 1,000,000 bytes each), measured one after another. Back it up to a file, restore it from one, or clear it. Only an extension that is on can be measured.",
    "storage.measure": "Measure again",
    "storage.measuring": "Measuring…",
    "storage.off": "Can be measured only while it is on.",
    "storage.failed": "Could not be read: {error}",
    "storage.of": "{size} of 1 MB",
    "storage.topKeys": "Biggest keys ({count})",
    "storage.backup": "Back up",
    "storage.restore": "Restore…",
    "storage.clear": "Clear…",
    "storage.backedUp": "Saved “{name}”’s data to a file.",
    "storage.file.not-json": "That file is not JSON.",
    "storage.file.not-a-backup": "That file is not a Fetchy backup.",
    "storage.file.not-in-backup": "That backup holds no data for “{name}”.",
    "storage.file.too-large": "That data is over Marinara’s 1,000,000-byte limit.",
    "storage.restore.title": "Restore {size} into “{name}”?",
    "storage.restore.otherName": "The file was saved from “{from}”, not “{name}”.",
    "storage.restore.otherVersion": "The file was saved from version {from}; this is {version}.",
    "storage.restore.body": "First, its current data is saved to a file. Then it is removed and the file’s data written. Reload the page afterwards.",
    "storage.restore.go": "Save current data and restore",
    "storage.restore.noBackup": "Nothing was changed: the current data could not be saved first ({error}).",
    "storage.restore.failed": "Restoring “{name}” failed: {error}. Its data from before is in the file just saved; restore that file.",
    "storage.restored": "Restored “{name}”’s data.",
    "storage.clear.first": "Clearing removes all of “{name}”’s data. First, it is saved to a file.",
    "storage.clear.backup": "Save to a file and go on",
    "storage.clear.type": "Type “{name}” to clear its data.",
    "storage.clear.go": "Clear",
    "storage.cleared": "Cleared “{name}”’s data. It is in the file just saved.",
    "storage.reloadHint": "An extension reads its data when it starts.",
    "storage.reload": "Reload the page",
    "storage.browser": "In this browser",
    "help.storage.browser": "What this site keeps in the browser itself, grouped by name. Only sizes and names; nothing is changed here.",
    "storage.browser.usage": "In use: {usage} of {quota}",
    "storage.browser.keys": "{count} key(s)",
    "storage.browser.noList": "This browser doesn’t list its databases.",
    "profiles.title": "Switched-on sets",
    "help.profiles": "Save which extensions are on under a name, and switch to that set later: the others go off, and the set’s go back on, only those whose code is the code you approved. Fetchy itself stays on.",
    "profiles.name": "Name of the set",
    "profiles.save": "Save what is on now",
    "profiles.count": "{count} of {max} sets",
    "profiles.size": "{count} on",
    "profiles.apply": "Apply",
    "profiles.none": "No set yet.",
    "profiles.full": "You already have {count} sets: delete one first.",
    "profiles.saved": "Saved “{name}” ({count} on).",
    "switch.willOff": "Will switch off: {names}",
    "switch.willOn": "Will switch back on (the code you approved): {names}",
    "switch.needsApproval": "Left off, they need a new approval in Marinara: {names}",
    "switch.missing": "{count} no longer in Marinara.",
    "switch.nothing": "Nothing to switch.",
    "switch.off": "Switched off: {names}",
    "switch.on": "Switched back on: {names}",
    "switch.failed": "{name}: {error}",
    "switch.reloadHint": "Reload the page to be sure.",
    "bisect.title": "Find a problem extension",
    "help.bisect": "Switches half of the extensions off, then asks whether the problem is still there after a reload, and halves again, until one is left. Fetchy stays on. Automatic updates wait meanwhile. Back as it was any time.",
    "bisect.intro": "Half of what is on now goes off. Reload the page, try what goes wrong, and answer whether it is still there. A few rounds find the one.",
    "bisect.limits": "It finds one extension that causes the problem alone; a problem only two extensions cause together may not be found. Only extensions switched on now take part.",
    "bisect.onNow": "On now ({count}):",
    "bisect.ack": "Some have full page access. I know they are switched back on along the way, with the code I approved.",
    "bisect.start": "Start",
    "bisect.none": "No extension besides Fetchy is on.",
    "bisect.reloadThenAnswer": "Reload the page, then answer here.",
    "bisect.question": "Is the problem still there? ({left} left)",
    "bisect.testing": "On now: {names}",
    "bisect.allOff": "all of them off",
    "bisect.yes": "Yes, still there",
    "bisect.no": "No, it’s gone",
    "bisect.stop": "Stop and put back",
    "bisect.found": "Found it: “{name}” ({steps} rounds).",
    "bisect.notFound": "The problem stayed with all of them off: it doesn’t seem to come from an extension.",
    "bisect.restore": "Put everything back",
    "bisect.restoreWithout": "Put back, leaving “{name}” off",
    "bisect.toast": "Looking for a problem extension: is the problem still there?",
    "bisect.toast.done": "The problem extension search is over.",
    "backup.title": "Full backup",
    "help.backup": "One file with the source list, your folders and tags, and the stored data of the extensions you tick, to move to another browser or Marinara. Restoring brings back the source list like “Import list”.",
    "backup.intro": "Whose stored data goes in (only extensions that are on can be read):",
    "backup.noData": "No extension that is on has data to back up.",
    "backup.save": "Save the backup file",
    "backup.restore": "Restore from a file…",
    "backup.restoreNote": "Restoring adds the sources not in the list yet (automatic switches off), and the folders and tags when you have none. Stored data goes back later: install and switch on the extension, then Stored data → Restore and pick the same file.",
    "backup.saved": "Saved the backup file (stored data of {count}).",
    "backup.unread": "Could not read: {names}",
    "backup.notOne": "That file is not a Fetchy full backup.",
    "backup.dataLater": "The file also holds the data of: {names}. Once each is installed and on, restore it from Stored data → Restore with this file.",
    "conflicts.heading": "Overlaps",
    "conflicts.preview": "Check for possible conflicts",
    "conflicts.installed": "Check for conflicts",
    "conflicts.title": "Conflicts between extensions",
    "help.conflicts": "Fetchy reads the code (never runs it) for names an extension takes on the page: globals, custom elements, element ids, storage keys, commands, shortcuts, !important styles. Two taking the same name conflict; one taking and one only reading is a note. Only extensions with full page access share the page; a match is a hint, so each comes with its line.",
    "conflicts.sandboxed": "Without full page access it runs in its own sandboxed frame: it doesn’t overlap with other extensions.",
    "conflicts.previewFound": "Against {count} installed with full page access: {conflicts} conflict(s), {notes} note(s). Installing is still up to you.",
    "conflicts.previewNone": "No overlap with the {count} installed with full page access.",
    "conflicts.installedFound": "{conflicts} conflict(s), {notes} note(s).",
    "conflicts.installedNone": "No overlap among them.",
    "conflicts.checked": "Checked: {names}",
    "conflicts.skipped": "Left out (no full page access, they don’t share the page): {names}",
    "conflicts.counts": "{conflicts} conflict(s), {notes} note(s)",
    "conflicts.conflict": "conflict",
    "conflicts.note": "note",
    "conflicts.defines": "takes it",
    "conflicts.reads": "reads it",
    "conflicts.copy": "Copy the results",
    "conflicts.copied": "Results copied.",
    "conflicts.kind.global": "global",
    "conflicts.kind.element": "custom element",
    "conflicts.kind.id": "element id",
    "conflicts.kind.storage-key": "storage key",
    "conflicts.kind.database": "database",
    "conflicts.kind.symbol": "shared symbol",
    "conflicts.kind.event": "event",
    "conflicts.kind.shortcut": "shortcut (a guess)",
    "conflicts.kind.fetch": "wraps fetch",
    "conflicts.kind.command": "Dispensa command",
    "conflicts.kind.css": "style !important",
    "lists.heading": "Other recommended lists",
    "help.lists": 'A list someone else publishes as a JSON file (kind "me-fetchy.catalog"). It only gives addresses: each extension still installs alone, through its preview, and you approve it in Marinara.',
    "lists.add": "Add list",
    "lists.refresh": "Read again",
    "lists.preview": "Preview",
    "lists.added": "Added “{name}” ({count} extensions).",
    "lists.error.not-https": "A list’s address must start with https://.",
    "lists.error.not-found": "No file at that address.",
    "lists.error.not-a-list": 'That file is not a recommended list (kind "me-fetchy.catalog").',
    "lists.error.too-many": "You already have {count} lists: delete one first.",
    "copy.byHand.title": "Copy it by hand",
    "copy.byHand.body": "This browser won’t copy from here (Marinara is reached over plain http). The text below is selected: press Ctrl+C (⌘C on a Mac).",
    "action.enable": "Switch on",
    "enable.confirm.title": "Switch “{name}” back on?",
    "enable.confirm.body": "It is the same code you approved before ({hash}). It has full page access: it can read and change everything in Marinara, API keys and chats included.",
    "enable.ack.fullPage": "I know this code gets access to the whole page.",
    "result.enabled": "Switched “{name}” back on. Reload the page to be sure it runs.",
    "error.engine.needs-approval": "“{name}” needs a new approval in Marinara: its code is not the code that was approved. Settings → Addons → External Extensions → Review and Run.",
    "action.checkNow": "Check now",
    "delete.ask": "What should happen to “{name}”?",
    "delete.engine": "Delete from Marinara",
    "delete.unlink": "Only unlink from Fetchy",
    "delete.unlink.note": "Unlinking leaves the extension in Marinara as it is; Fetchy stops checking it for updates. Link it again from its row.",
    "delete.missing": "Marinara no longer has “{name}”. Take it off Fetchy’s list?",
    "delete.fromList": "Take off the list",
    "auto.group": "Automatic",
    "result.rolledBack.autoOff": "Automatic updates for it are now off, so the next one doesn’t undo the rollback.",
    "select.start": "Select",
    "select.done": "Done",
    "select.count": "{count} selected",
    "select.all": "Select all",
    "select.hide": "Hide",
    "select.show": "Show again",
    "select.tag": "Add a tag…",
    "hidden.heading": "Hidden ({count})",
    "hidden.updates": "{count} with an update",
    "action.reinstall": "Install again",
    "result.disabled": "Switched “{name}” off.",
    "action.more": "More",
    "action.less": "Less",
    "prefs.heading": "Options",
    "help.install": "A GitHub repository (FigCake/ME.Fetchy, or a /tree/branch/folder link), a manifest.json address, or a zip address. Fetchy downloads the files, shows what they are, and stores them in Marinara switched off. You switch them on under Settings → Addons → External Extensions (Review and Run).",
    "help.items": "Every External Extension in Marinara. Ones installed through Fetchy can be checked for updates; others can be linked to the GitHub address they came from. An update always switches the extension off until you approve the new code.",
    "help.autoCheck": "Checks every extension for updates when this panel opens, except those checked in the last 30 minutes (“Check all” checks them all now). It installs only those you switched automatic updates on for.",
    "autoUpdate.label": "Update automatically",
    "autoUpdate.badge": "auto update",
    "help.autoUpdate": "Fetchy installs this extension's updates by itself: when Marinara opens (at most every 6 hours) and after a check. Marinara keeps the new code switched off until you approve it, unless auto re-approval or “Keep updated extensions on” is set.",
    "autoUpdate.done": "Automatic updates: {ok} of {total}.",
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
    "catalog.heading": "FigCake 확장",
    "bundle.button": "묶음 설치",
    "bundle.title": "FigCake 확장",
    "bundle.hasUpdate": "FigCake 확장 업데이트 있음",
    "catalog.update": "업데이트 {version}",
    "organize.heading": "폴더와 태그",
    "organize.folders": "폴더",
    "organize.tags": "태그",
    "organize.add": "추가",
    "organize.newFolder": "새 폴더",
    "organize.newTag": "새 태그",
    "organize.delete": "지우기",
    "organize.noFolder": "폴더 없음",
    "organize.allTags": "전체",
    "organize.folder": "폴더",
    "organize.empty": "아직 없음",
    "preview.details": "파일·크기",
    "catalog.help": "FigCake의 확장 여러 개를 GitHub 저장소에서 한 번에, 하나씩 차례로 설치합니다. 하나씩 설치할 때처럼 Marinara에 꺼진 상태로 들어가고, 이미 있는 것은 업데이트(켜져 있었고 “업데이트한 확장 켜 두기”가 켜져 있으면 바로 다시 켜짐), 코드가 같은 것은 연결만 합니다.",
    "catalog.installedElsewhere": "같은 이름 {version}, 다른 방법으로 설치됨",
    "catalog.willOff": "업데이트하면 Marinara에서 다시 승인할 때까지 꺼집니다(“업데이트한 확장 켜 두기”가 켜져 있으면 그대로 켜짐).",
    "catalog.staysOn": "업데이트해도 켜진 채로 둡니다(“업데이트한 확장 켜 두기”가 켜져 있음).",
    "catalog.skipped.newer": "{name}: 그대로 둠 — 설치된 버전이 저장소에 올라온 것보다 새것입니다. 위 주소 칸에서 {input}을(를) 설치하면 무엇이 바뀌는지 먼저 볼 수 있습니다.",
    "catalog.skipped.current": "{name}: 이미 최신입니다.",
    "catalog.stopped": "{name}: 시도하지 않음 — 앞의 것과 같은 이유로 실패할 것이라 건너뛰었습니다.",
    "catalog.reload": "Marinara 자체 목록(설정 → 애드온)에는 페이지를 새로 고친 뒤에 바뀐 것이 보입니다.",
    "catalog.installed": "설치됨 {version}",
    "catalog.missing": "설치 안 됨",
    "catalog.install": "고른 것 설치 ({count})",
    "catalog.progress": "{name} 설치 중 ({done}/{total})…",
    "catalog.done": "끝: {total}개 중 {ok}개.",
    "catalog.skipped.runtime": "{name}: 그대로 둠 — 설치된 것이 다른 곳(클라이언트/서버)에서 돌아가서 여기서 바꿀 수 없습니다.",
    "catalog.skipped.edited": "{name}: 그대로 둠 — Marinara 편집기에서 코드를 고쳤습니다. 위 주소 칸에서 {input}을(를) 설치하면 무엇이 바뀌는지 먼저 볼 수 있습니다.",
    "catalog.skipped.other": "{name}: 그대로 둠 — Fetchy가 FigCake 저장소에서 설치하지 않은 같은 이름의 확장이 있습니다(손으로 설치했거나 다른 곳에서). 위 주소 칸에서 {input}을(를) 설치하면 무엇이 바뀌는지 먼저 볼 수 있습니다.",
    "catalog.failed": "{name}: {error}",
    "catalog.fullPage": "모두 전체 페이지 접근 권한을 씁니다: 각각 Marinara 페이지의 모든 것(API 키, 채팅 포함)을 읽고 바꿀 수 있습니다. 제작자를 믿을 때만 설치하세요.",
    "catalog.unknown": "알 수 없음",
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
    "action.checkAll": "모두 확인",
    "result.selfUpdatedOn": "Fetchy 업데이트하고 다시 켰습니다.",
    "action.updateAll": "모두 업데이트",
    "option.keepEnabled": "업데이트한 확장 켜 두기",
    "help.keepEnabled": "켜져 있던 확장을 업데이트하면(개별이든 “모두 업데이트”든) 새 코드를 읽지 않고 승인해 바로 다시 켭니다. 새 권한을 요구하는 버전에는 적용하지 않습니다.",
    "keep.confirm.title": "업데이트한 확장을 켜 둘까요?",
    "keep.confirm.body": "여기서 하는 모든 업데이트에서 Fetchy가 업데이트된 코드를 읽어 보지 않고 승인해 다시 켭니다. 즉 그 저장소들에 올라온 코드가 업데이트(또는 고른 FigCake 확장 설치)를 누르는 순간 내 Marinara에서 실행됩니다. 새 권한을 요구하는 버전은 이 방식으로 승인하지 않습니다.",
    "result.updatedAll": "{total}개 중 {ok}개 업데이트했습니다.",
    "result.updatedAllOne": "{name}: {text}",
    "result.nothingToUpdate": "업데이트할 것이 없습니다. 먼저 “모두 확인”을 누르세요.",
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
    "result.imported": "새 소스 {imported}개를 가져왔습니다. 자동 업데이트와 자동 승인은 꺼져 있습니다.",
    "result.importKept": "이미 목록에 있는 {kept}개는 그대로 두었습니다.",
    "result.importDifferent": "그중 {different}개는 파일에 다른 주소가 적혀 있지만 그 주소는 쓰지 않았습니다(그 주소를 따르려면 제거 → “목록에서만 제거”를 한 뒤 그 주소에서 설치하세요).",
    "result.importIgnored": "올바르지 않은 항목 {ignored}개는 무시했습니다.",
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
    "error.install.edited": "그대로 둠 — Fetchy가 설치한 뒤 Marinara에서 코드가 바뀌어서 자동으로 업데이트하지 않습니다. 그 코드를 바꾸려면 따로 업데이트하세요(리비전을 보관하도록 설정돼 있으면 Marinara가 현재 코드를 리비전으로 남깁니다).",
    "error.import.invalid": "내보낸 소스 목록이 아닙니다.",
    "anchor.button": "GitHub에서 설치",
    "anchor.hint": "단축키: Alt+Shift+F",
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
    "notify.title": "확장 업데이트 {count}개",
    "notify.open": "열기",
    "notify.later": "나중에",
    "anchor.hasUpdate": "업데이트가 있어요",
    "self.newVersion": "Fetchy 새 판이 나왔어요: {version}.",
    "self.addSource": "출처로 추가해 업데이트",
    "option.notify": "업데이트 알림",
    "help.notify": "Marinara를 열고 조금 뒤, 6시간에 한 번 출처마다 manifest.json(작은 파일, 코드나 GitHub API 아님)만 읽어 새 버전이 있으면 알려 줍니다. 같은 버전은 한 번만 알려요.",
    "changes.heading": "바뀐 내역",
    "changes.loading": "커밋을 읽는 중…",
    "changes.noBase": "Fetchy가 어느 커밋에서 설치했는지 몰라요(0.9 전에 설치했거나, 되돌렸거나, 패널이 닫힌 동안 업데이트됨). GitHub에서 내역을 보세요.",
    "changes.more": "{count}개보다 많아요. 나머지는 GitHub에서.",
    "changes.none": "설치한 커밋 뒤로 이 폴더에 바뀐 커밋이 없어요.",
    "changes.history": "GitHub 내역",
    "repo.archived": "보관됨",
    "repo.archived.title": "GitHub에서 저장소가 보관(archived)됐어요. 작성자가 더 이상 관리하지 않아요. 마지막 push: {date}",
    "repo.stale": "6개월 이상 갱신 없음",
    "repo.stale.title": "저장소에 6개월 넘게 push가 없어요. 마지막 push: {date}",
    "action.diagnostics": "진단 복사",
    "help.diagnostics": "버그 신고에 붙일 글을 복사합니다: Marinara·Fetchy 버전, 관문 상태, 브라우저, 확장마다 버전·상태·출처·마지막 확인, 최근 변경 기록. 코드, 저장 데이터, 관리자 비밀은 넣지 않아요(비밀은 있는지만).",
    "result.diagnosticsCopied": "진단 정보를 복사했어요. 신고 글에 붙여 넣으세요.",
    "wizard.title": "처음 설정",
    "wizard.stepOf": "{step}/{total} · {name}",
    "wizard.skip": "건너뛰기",
    "wizard.back": "이전",
    "wizard.next": "다음",
    "wizard.finish": "끝내기",
    "wizard.again": "처음 설정 다시 보기",
    "wizard.status.heading": "Marinara가 허락하는 것",
    "wizard.status.intro": "Fetchy는 Marinara가 들여 주는 것만 설치할 수 있어요. ✗가 있으면 무엇을 바꿀지 적어 두었어요.",
    "wizard.status.env": "서버 .env의 ENABLE_EXTERNAL_EXTENSIONS=true",
    "wizard.status.switch": "“외부 확장 가져오기 허용”이 켜져 있음",
    "wizard.status.admin": "Fetchy가 확장을 관리할 수 있음(Admin Access)",
    "wizard.status.adminFix": "원격 Marinara라면: 서버 .env에 ADMIN_SECRET을 정하고, 설정 → Admin Access에 그 비밀을 넣은 뒤 다시 열어 주세요.",
    "wizard.status.sandbox": "서버 확장 샌드박스",
    "wizard.status.sandboxNote": "서버에서 도는 확장에만 필요해요. FigCake 확장은 브라우저에서 돌아요.",
    "wizard.pick.heading": "고르기",
    "wizard.pick.intro": "설치할 FigCake 확장을 고르세요. 모두 꺼진 채로 들어가고, Marinara에서 승인해야 켜져요.",
    "wizard.options.heading": "옵션",
    "wizard.install.heading": "설치",
    "wizard.install.none": "고른 것이 없어요. 이전으로 돌아가 고르거나 그냥 넘어가세요.",
    "wizard.approve.heading": "Marinara에서 승인",
    "wizard.approve.how": "설정 → 애드온 → 외부 확장에서 아래 확장을 하나씩 열고 Review and Run으로 코드를 읽고 승인하세요. 그 화면의 해시가 여기 해시와 같아야 해요. 그다음 「다시 확인」을 누르세요.",
    "wizard.approve.none": "Marinara에 아직 FigCake 확장이 없어요.",
    "wizard.approve.recheck": "다시 확인",
    "storage.title": "저장 공간",
    "storage.open": "저장 공간",
    "help.storage": "확장마다 Marinara에 저장한 데이터(확장당 최대 1,000,000바이트)를 하나씩 차례로 잽니다. 파일로 백업하고, 파일에서 복원하고, 비울 수 있어요. 켜져 있는 확장만 잴 수 있어요.",
    "storage.measure": "다시 재기",
    "storage.measuring": "재는 중…",
    "storage.off": "켜져 있을 때만 잴 수 있어요.",
    "storage.failed": "읽지 못했어요: {error}",
    "storage.of": "{size} / 1 MB",
    "storage.topKeys": "큰 키 {count}개",
    "storage.backup": "백업",
    "storage.restore": "복원…",
    "storage.clear": "비우기…",
    "storage.backedUp": "“{name}”의 데이터를 파일로 저장했어요.",
    "storage.file.not-json": "JSON 파일이 아니에요.",
    "storage.file.not-a-backup": "Fetchy 백업 파일이 아니에요.",
    "storage.file.not-in-backup": "이 백업에는 “{name}”의 데이터가 없어요.",
    "storage.file.too-large": "데이터가 Marinara 한도(1,000,000바이트)를 넘어요.",
    "storage.restore.title": "“{name}”에 {size}를 복원할까요?",
    "storage.restore.otherName": "이 파일은 “{name}”이 아니라 “{from}”에서 저장한 거예요.",
    "storage.restore.otherVersion": "이 파일은 버전 {from}에서 저장했어요. 지금은 {version}이에요.",
    "storage.restore.body": "먼저 지금 데이터를 파일로 저장한 뒤, 지우고 파일의 데이터를 넣어요. 끝나면 페이지를 새로고침하세요.",
    "storage.restore.go": "지금 데이터 저장하고 복원",
    "storage.restore.noBackup": "아무것도 바꾸지 않았어요. 지금 데이터를 먼저 저장하지 못했어요({error}).",
    "storage.restore.failed": "“{name}” 복원에 실패했어요: {error}. 전 데이터는 방금 저장한 파일에 있으니 그 파일로 복원하세요.",
    "storage.restored": "“{name}”의 데이터를 복원했어요.",
    "storage.clear.first": "비우면 “{name}”의 데이터가 모두 지워져요. 먼저 파일로 저장해요.",
    "storage.clear.backup": "파일로 저장하고 계속",
    "storage.clear.type": "비우려면 “{name}”을(를) 그대로 입력하세요.",
    "storage.clear.go": "비우기",
    "storage.cleared": "“{name}”의 데이터를 비웠어요. 방금 저장한 파일에 들어 있어요.",
    "storage.reloadHint": "확장은 시작할 때 데이터를 읽어요.",
    "storage.reload": "페이지 새로고침",
    "storage.browser": "이 브라우저 안",
    "help.storage.browser": "이 사이트가 브라우저 자체에 저장한 것을 이름별로 묶어 보여 줘요. 크기와 이름만 보고, 여기서는 아무것도 바꾸지 않아요.",
    "storage.browser.usage": "사용 중: {usage} / {quota}",
    "storage.browser.keys": "키 {count}개",
    "storage.browser.noList": "이 브라우저는 데이터베이스 목록을 알려 주지 않아요.",
    "profiles.title": "켜짐 묶음",
    "help.profiles": "지금 켜진 확장을 이름 붙여 저장하고, 나중에 그 묶음으로 바꿉니다. 묶음에 없는 것은 끄고, 묶음에 있는 것은 승인한 코드 그대로일 때만 다시 켜요. Fetchy는 늘 켜 둬요.",
    "profiles.name": "묶음 이름",
    "profiles.save": "지금 켜진 것 저장",
    "profiles.count": "묶음 {count} / {max}",
    "profiles.size": "{count}개 켜짐",
    "profiles.apply": "적용",
    "profiles.none": "아직 묶음이 없어요.",
    "profiles.full": "묶음이 이미 {count}개예요. 하나를 먼저 지우세요.",
    "profiles.saved": "“{name}”을(를) 저장했어요({count}개 켜짐).",
    "switch.willOff": "끌 것: {names}",
    "switch.willOn": "다시 켤 것(승인한 코드 그대로): {names}",
    "switch.needsApproval": "Marinara에서 다시 승인해야 해서 꺼 둔 것: {names}",
    "switch.missing": "{count}개는 Marinara에 더 이상 없어요.",
    "switch.nothing": "바꿀 것이 없어요.",
    "switch.off": "껐어요: {names}",
    "switch.on": "다시 켰어요: {names}",
    "switch.failed": "{name}: {error}",
    "switch.reloadHint": "페이지를 새로고침하면 확실해요.",
    "bisect.title": "문제 확장 찾기",
    "help.bisect": "켜진 확장의 반을 끄고, 새로고침한 뒤 문제가 남았는지 물어 범위를 반씩 줄여 하나를 찾아요. Fetchy는 켜 두고, 그동안 자동 업데이트는 쉬어요. 언제든 원래대로 되돌릴 수 있어요.",
    "bisect.intro": "지금 켜진 것의 반을 꺼요. 페이지를 새로고침하고 문제가 생기던 일을 해 본 뒤, 문제가 남았는지 답하세요. 몇 번이면 하나를 찾아요.",
    "bisect.limits": "혼자서 문제를 일으키는 확장 하나를 찾아요. 두 확장이 함께 있을 때만 생기는 문제는 못 찾을 수 있어요. 지금 켜진 확장만 대상이에요.",
    "bisect.onNow": "지금 켜진 것({count}개):",
    "bisect.ack": "페이지 전체에 접근하는 확장이 있어요. 찾는 동안 승인한 코드 그대로 다시 켜진다는 것을 알아요.",
    "bisect.start": "시작",
    "bisect.none": "Fetchy 말고 켜진 확장이 없어요.",
    "bisect.reloadThenAnswer": "페이지를 새로고침한 뒤 여기서 답하세요.",
    "bisect.question": "문제가 아직 있나요? (후보 {left}개)",
    "bisect.testing": "지금 켜 둔 것: {names}",
    "bisect.allOff": "모두 꺼 둠",
    "bisect.yes": "네, 아직 있어요",
    "bisect.no": "아니요, 사라졌어요",
    "bisect.stop": "그만두고 되돌리기",
    "bisect.found": "찾았어요: “{name}”({steps}번 만에).",
    "bisect.notFound": "모두 꺼도 문제가 남았어요. 확장 때문은 아닌 것 같아요.",
    "bisect.restore": "원래대로 되돌리기",
    "bisect.restoreWithout": "“{name}”만 끈 채로 되돌리기",
    "bisect.toast": "문제 확장을 찾는 중이에요. 문제가 아직 있나요?",
    "bisect.toast.done": "문제 확장 찾기가 끝났어요.",
    "backup.title": "전체 백업",
    "help.backup": "출처 목록, 폴더와 태그, 고른 확장의 저장 데이터를 파일 하나로 담아 다른 브라우저나 Marinara로 옮겨요. 복원하면 출처 목록을 「목록 가져오기」처럼 되살려요.",
    "backup.intro": "저장 데이터를 담을 확장(켜진 확장만 읽을 수 있어요):",
    "backup.noData": "켜진 확장 중에 백업할 데이터가 있는 것이 없어요.",
    "backup.save": "백업 파일 받기",
    "backup.restore": "파일에서 복원…",
    "backup.restoreNote": "복원하면 목록에 없는 출처만 더하고(자동 스위치는 끔), 폴더와 태그는 지금 없을 때만 가져와요. 저장 데이터는 나중에: 그 확장을 설치해 켠 뒤 저장 공간 → 복원에서 같은 파일을 고르세요.",
    "backup.saved": "백업 파일을 받았어요(저장 데이터 {count}개).",
    "backup.unread": "읽지 못한 것: {names}",
    "backup.notOne": "Fetchy 전체 백업 파일이 아니에요.",
    "backup.dataLater": "이 파일에는 {names}의 데이터도 있어요. 각각 설치해 켠 뒤 저장 공간 → 복원에서 이 파일로 복원하세요.",
    "conflicts.heading": "겹치는 것",
    "conflicts.preview": "충돌 가능성 분석",
    "conflicts.installed": "충돌 존재 분석",
    "conflicts.title": "확장끼리 겹치는 것",
    "help.conflicts": "Fetchy가 코드를 실행하지 않고 글로만 읽어, 확장이 페이지에서 차지하는 이름(전역, 커스텀 요소, 요소 id, 저장 키, 명령, 단축키, !important 스타일)을 찾아요. 둘이 같은 이름을 차지하면 충돌, 한쪽은 차지하고 다른 쪽은 읽기만 하면 참고예요. 페이지를 함께 쓰는 건 full page access 확장뿐이고, 글로 찾은 것이라 근거 줄을 함께 보여 줘요.",
    "conflicts.sandboxed": "full page access가 없어 따로 떨어진 샌드박스에서 돌아요. 다른 확장과 겹치지 않아요.",
    "conflicts.previewFound": "설치된 full page 확장 {count}개와 비교: 충돌 {conflicts}개, 참고 {notes}개. 설치는 막지 않아요.",
    "conflicts.previewNone": "설치된 full page 확장 {count}개와 겹치는 것이 없어요.",
    "conflicts.installedFound": "충돌 {conflicts}개, 참고 {notes}개.",
    "conflicts.installedNone": "서로 겹치는 것이 없어요.",
    "conflicts.checked": "비교한 것: {names}",
    "conflicts.skipped": "뺀 것(full page access가 없어 페이지를 함께 쓰지 않음): {names}",
    "conflicts.counts": "충돌 {conflicts}개, 참고 {notes}개",
    "conflicts.conflict": "충돌",
    "conflicts.note": "참고",
    "conflicts.defines": "차지함",
    "conflicts.reads": "읽기만 함",
    "conflicts.copy": "결과 복사",
    "conflicts.copied": "결과를 복사했어요.",
    "conflicts.kind.global": "전역",
    "conflicts.kind.element": "커스텀 요소",
    "conflicts.kind.id": "요소 id",
    "conflicts.kind.storage-key": "저장 키",
    "conflicts.kind.database": "데이터베이스",
    "conflicts.kind.symbol": "공유 심볼",
    "conflicts.kind.event": "이벤트",
    "conflicts.kind.shortcut": "단축키(어림)",
    "conflicts.kind.fetch": "fetch 감싸기",
    "conflicts.kind.command": "Dispensa 명령",
    "conflicts.kind.css": "스타일 !important",
    "lists.heading": "다른 추천 목록",
    "help.lists": '다른 사람이 JSON 파일(kind "me-fetchy.catalog")로 올린 목록이에요. 주소만 알려 줄 뿐, 설치는 하나씩 미리보기를 보고 하고 Marinara에서 승인해요.',
    "lists.add": "목록 추가",
    "lists.refresh": "다시 읽기",
    "lists.preview": "미리보기",
    "lists.added": "“{name}”을(를) 추가했어요(확장 {count}개).",
    "lists.error.not-https": "목록 주소는 https://로 시작해야 해요.",
    "lists.error.not-found": "그 주소에 파일이 없어요.",
    "lists.error.not-a-list": '추천 목록 파일(kind "me-fetchy.catalog")이 아니에요.',
    "lists.error.too-many": "목록이 이미 {count}개예요. 하나를 먼저 지우세요.",
    "copy.byHand.title": "직접 복사하세요",
    "copy.byHand.body": "이 브라우저는 여기서 자동으로 복사하지 못해요(Marinara가 https가 아닌 주소). 아래 글이 선택되어 있으니 Ctrl+C(Mac은 ⌘C)를 누르세요.",
    "action.enable": "켜기",
    "enable.confirm.title": "“{name}”을(를) 다시 켤까요?",
    "enable.confirm.body": "전에 승인한 그 코드 그대로예요({hash}). 이 확장은 페이지 전체에 접근할 수 있어 API 키와 채팅을 포함한 Marinara의 모든 것을 읽고 바꿀 수 있습니다.",
    "enable.ack.fullPage": "이 코드가 페이지 전체에 접근함을 알아요.",
    "result.enabled": "“{name}”을(를) 다시 켰어요. 페이지를 새로고침하면 확실해요.",
    "error.engine.needs-approval": "“{name}”은(는) Marinara에서 다시 승인해야 해요. 지금 코드가 전에 승인한 코드와 다릅니다. 설정 → 애드온 → 외부 확장 → Review and Run.",
    "action.checkNow": "지금 확인",
    "delete.ask": "“{name}”을(를) 어떻게 할까요?",
    "delete.engine": "Marinara에서 삭제",
    "delete.unlink": "Fetchy 연결만 끊기",
    "delete.unlink.note": "연결만 끊으면 확장은 Marinara에 그대로 남고, Fetchy가 업데이트 확인을 그만둡니다. 그 줄에서 다시 연결할 수 있어요.",
    "delete.missing": "Marinara에 “{name}”이(가) 더 이상 없습니다. Fetchy 목록에서 뺄까요?",
    "delete.fromList": "목록에서 빼기",
    "auto.group": "자동",
    "result.rolledBack.autoOff": "다음 자동 업데이트가 되돌린 것을 다시 올리지 않도록, 이 확장의 자동 업데이트를 껐어요.",
    "select.start": "선택",
    "select.done": "끝내기",
    "select.count": "{count}개 선택",
    "select.all": "전체 선택",
    "select.hide": "숨기기",
    "select.show": "다시 보이기",
    "select.tag": "태그 붙이기…",
    "hidden.heading": "숨긴 확장 {count}개",
    "hidden.updates": "업데이트 {count}개",
    "action.reinstall": "다시 설치",
    "result.disabled": "“{name}”을(를) 껐습니다.",
    "action.more": "더보기",
    "action.less": "접기",
    "prefs.heading": "옵션",
    "help.install": "GitHub 저장소(FigCake/ME.Fetchy 처럼, 또는 /tree/브랜치/폴더 링크), manifest.json 주소, zip 주소. Fetchy가 파일을 받아 내용을 보여 주고 Marinara에 꺼진 상태로 넣습니다. 켜는 것은 설정 → 애드온 → 외부 확장(Review and Run)에서 합니다.",
    "help.items": "Marinara의 외부 확장 전부입니다. Fetchy로 설치한 것은 업데이트를 확인할 수 있고, 아닌 것은 받아온 GitHub 주소를 연결하면 됩니다. 업데이트하면 새 코드를 승인할 때까지 확장이 꺼집니다.",
    "help.autoCheck": "이 패널을 열 때 모든 확장의 업데이트를 확인합니다. 30분 안에 확인한 것은 건너뜁니다(“모두 확인”은 지금 전부 확인). 설치는 자동 업데이트를 켠 확장만 합니다.",
    "autoUpdate.label": "자동 업데이트",
    "autoUpdate.badge": "자동 업데이트",
    "help.autoUpdate": "Fetchy가 이 확장의 업데이트를 알아서 설치합니다: 마리나라를 열 때(최대 6시간에 한 번)와 업데이트 확인 뒤. 새 코드는 마리나라가 승인할 때까지 꺼 둡니다(자동 승인이나 “업데이트한 확장 켜 두기”가 켜져 있으면 다시 켜짐).",
    "autoUpdate.done": "자동 업데이트: {total}개 중 {ok}개.",
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
  async function sha256Hex(text2) {
    return digestHex(typeof text2 === "string" ? encoder.encode(text2) : text2);
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
  var splitLines = (text2) => text2.split(/\r?\n/);
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
  async function side(text2) {
    if (text2 === null) return null;
    return { bytes: encoder2.encode(text2).byteLength, lines: text2 ? splitLines(text2).length : 0, sha256: await sha256Hex(text2) };
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

  // src/github.ts
  var SourceUrlError = class extends Error {
    constructor(reason, message2) {
      super(message2);
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
  function splitRef(text2) {
    const at = text2.lastIndexOf("@");
    if (at <= 0) return { body: text2, ref: null };
    const ref = text2.slice(at + 1).trim();
    return ref ? { body: text2.slice(0, at), ref } : { body: text2, ref: null };
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
    const text2 = input.trim();
    if (!text2) throw new SourceUrlError("empty", "Enter a URL");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text2)) return shorthandSource(text2);
    let url;
    try {
      url = new URL(text2);
    } catch {
      throw new SourceUrlError("unsupported", `Not a valid URL: ${text2}`);
    }
    if (url.protocol !== "https:") throw new SourceUrlError("not-https", "Only https:// URLs are supported");
    const host = url.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") return githubPageSource(url, text2);
    if (host === "raw.githubusercontent.com") return rawSource(url);
    const file = fileSource(url);
    if (file) return file;
    throw new SourceUrlError("unsupported", `Unsupported URL (use a GitHub repository, a manifest.json URL or a .zip URL): ${text2}`);
  }
  function shorthandSource(text2) {
    const { body: body2, ref } = splitRef(text2);
    const parts = cleanPath(body2).split("/").filter(Boolean);
    if (parts.length < 2) throw new SourceUrlError("unsupported", `Not a URL or owner/repo: ${text2}`);
    const [owner, repo, ...rest] = parts;
    return repoSource(owner, repo, ref, rest.join("/"));
  }
  function githubPageSource(url, text2) {
    const { body: body2, ref: atRef } = splitRef(url.pathname);
    const parts = cleanPath(body2).split("/").filter(Boolean);
    if (parts.length < 2) throw new SourceUrlError("bad-github-path", "A GitHub URL needs /owner/repo");
    const [owner, repo, mode, ref, ...rest] = parts;
    if (mode === "tree" || mode === "blob" || mode === "raw") {
      if (!ref) throw new SourceUrlError("bad-github-path", `A /${mode}/ URL needs a branch`);
      return repoSource(owner, repo, ref, rest.join("/"));
    }
    if (mode) throw new SourceUrlError("bad-github-path", `Unsupported GitHub URL (use the repository or a /tree/<branch>/ folder): ${text2}`);
    return repoSource(owner, repo, atRef, "");
  }
  function rawSource(url) {
    const parts = cleanPath(url.pathname).split("/").filter(Boolean);
    if (parts.length < 3) throw new SourceUrlError("bad-github-path", "A raw URL needs /owner/repo/branch/…");
    const [owner, repo, ...rest] = parts;
    let ref;
    if (rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags") && rest[2]) {
      ref = rest.splice(0, 3).join("/");
    } else {
      ref = rest.shift();
    }
    const file = fileSource(url);
    if (file) return file;
    return repoSource(owner, repo, ref, rest.join("/"));
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
    constructor(message2) {
      super(`zip: ${message2}`);
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
    const names2 = new TextDecoder();
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
      const name = names2.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/").replace(/^\/+/, "");
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
    constructor(code, message2, url, status = 0, tried = []) {
      super(message2);
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
  function parseJson(text2, url) {
    try {
      return JSON.parse(text2.replace(/^\uFEFF/, ""));
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
        const text2 = await read(name);
        if (text2 != null && text2.trim()) return { path: name, text: text2 };
      } catch {
      }
    }
    return null;
  }
  async function defaultBranch(owner, repo, options, budget) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    try {
      const text2 = await fetchText(url, { ...options, freshest: false }, 256 * 1024, budget);
      if (text2 == null) return null;
      const info = JSON.parse(text2);
      return typeof info.default_branch === "string" && info.default_branch ? info.default_branch : null;
    } catch {
      return null;
    }
  }
  var COMMIT_SHA2 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  async function commitOf(owner, repo, ref, options, budget) {
    if (COMMIT_SHA2.test(ref)) return ref;
    const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodedRef}`;
    try {
      const bytes = await fetchBytes(url, { ...options, freshest: false }, 1024, budget, "application/vnd.github.sha");
      const sha = bytes === null ? "" : new TextDecoder("utf-8").decode(bytes).trim().toLowerCase();
      return COMMIT_SHA2.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }
  async function readConsistently(manifestUrl, manifestText, reread, read) {
    let text2 = manifestText;
    for (let attempt = 0; attempt < 2; attempt++) {
      const manifest = parseJson(text2, manifestUrl);
      const normalized = await normalizeManifest(manifest, read);
      const again = await reread();
      if (again === null) throw new FetchError("source-changed", "the manifest disappeared during the download", manifestUrl);
      if (again === text2) return { manifest, normalized, manifestText: text2 };
      text2 = again;
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
        const text2 = await readManifest();
        if (text2 == null) continue;
        const readerAt = (at, opts) => async (path) => {
          const clean = normalizePath(path);
          if (!clean) return null;
          for (const candidate of dir ? [`${dir}/${clean}`, clean] : [clean]) {
            const found = await fetchText(rawFileUrl(source.owner, source.repo, at, candidate), opts, LIMITS.textFileBytes, budget);
            if (found != null) return found;
          }
          return null;
        };
        const readmeAt = (at, opts) => options.readme === false ? null : readme((name) => fetchText(rawFileUrl(source.owner, source.repo, at, dir ? `${dir}/${name}` : name), opts, MAX_README_BYTES, budget));
        const done = async (manifest2, normalized2, commit2, at, opts) => ({
          source,
          ref,
          commit: commit2,
          manifestUrl,
          manifest: manifest2,
          normalized: normalized2,
          browseUrl: browseUrl(source, ref),
          readme: await readmeAt(at, opts),
          downloadedBytes: budget.used
        });
        const commit = options.pinCommit ? await commitOf(source.owner, source.repo, ref, options, budget) : null;
        if (commit) {
          const atCommit = { ...options, freshest: false };
          const pinnedText = commit === ref ? text2 : await fetchText(rawFileUrl(source.owner, source.repo, commit, dir ? `${dir}/${filename}` : filename), atCommit, LIMITS.textFileBytes, budget);
          if (pinnedText != null) {
            const manifest2 = parseJson(pinnedText, manifestUrl);
            return done(manifest2, await normalizeManifest(manifest2, readerAt(commit, atCommit)), commit, commit, atCommit);
          }
        }
        const { manifest, normalized } = await readConsistently(manifestUrl, text2, readManifest, readerAt(ref, options));
        return done(manifest, normalized, null, ref, options);
      }
      if (!source.ref && i === candidates.length - 1 && candidates.length === DEFAULT_BRANCHES.length) {
        const branch = await defaultBranch(source.owner, source.repo, options, budget);
        if (branch && !candidates.includes(branch)) candidates.push(branch);
      }
    }
    const where2 = dir ? `${source.owner}/${source.repo}/${dir}` : `${source.owner}/${source.repo}`;
    throw new FetchError("manifest-not-found", `No manifest.json in ${where2} (tried ${tried.join(", ")})`, browseUrl(source), 404, tried);
  }
  async function fromManifestUrl(source, options) {
    const budget = new Budget(options.budgetBytes ?? DEFAULT_BUDGET_BYTES);
    const readManifest = () => fetchText(source.url, options, LIMITS.textFileBytes, budget);
    const text2 = await readManifest();
    if (text2 == null) throw new FetchError("manifest-not-found", `HTTP 404`, source.url, 404);
    const base = directoryOf(source.url);
    const resolve = (path) => new URL(normalizePath(path), base).href;
    const read = async (path) => normalizePath(path) ? fetchText(resolve(path), options, LIMITS.textFileBytes, budget) : null;
    const { manifest, normalized } = await readConsistently(source.url, text2, readManifest, read);
    return {
      source,
      ref: null,
      commit: null,
      manifestUrl: source.url,
      manifest,
      normalized,
      browseUrl: source.url,
      readme: options.readme === false ? null : await readme((name) => fetchText(resolve(name), options, MAX_README_BYTES, budget)),
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
      commit: null,
      manifest,
      normalized,
      manifestUrl,
      browseUrl: source.url,
      readme: options.readme === false ? null : await readme(async (name) => {
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
  async function fetchSmallText(url, options, maxBytes) {
    return fetchText(url, options, maxBytes, new Budget(maxBytes));
  }
  async function fetchManifestVersion(source, ref, options) {
    if (source.kind === "zip-url") return null;
    const urls = source.kind === "manifest-url" ? [source.url] : MANIFEST_FILENAMES.map((name) => {
      const dir = normalizePath(source.path);
      return rawFileUrl(source.owner, source.repo, ref ?? source.ref ?? DEFAULT_BRANCHES[0], dir ? `${dir}/${name}` : name);
    });
    for (const url of urls) {
      const text2 = await fetchSmallText(url, { ...options, freshest: true }, LIMITS.textFileBytes);
      if (text2 == null) continue;
      return manifestVersion(parseJson(text2, url));
    }
    return null;
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
    constructor(problem, message2) {
      super(message2);
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
    const pkg = await fetchPackage(source, { fetch: deps.fetch, freshest: options.freshest, readme: options.readme, pinCommit: true });
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
      // the commit is that of the code Marinara now holds only when it is the downloaded code
      ...installedHash === prepared.contentHash && prepared.pkg.commit ? { installedCommit: prepared.pkg.commit } : {},
      installedAt: iso,
      lastCheckedAt: iso,
      latest: { version: prepared.draft.version, hash: prepared.contentHash, state, checkedAt: iso },
      lastError: null,
      autoApprove: previous?.autoApprove === true,
      autoUpdate: previous?.autoUpdate === true
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
    const stored = await deps.store.load();
    const previous = (prepared.tracked ? stored.find((r) => r.id === prepared.tracked?.id) ?? prepared.tracked : null) ?? (mode.kind !== "create" ? stored.find((r) => r.extensionId === mode.extensionId) ?? null : null);
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
    const record = { ...recordFrom(prepared, extension, previous, now, extension.contentHash), autoApprove: previous?.autoApprove === true, autoUpdate: previous?.autoUpdate === true };
    await deps.store.upsert(record);
    return { record, extension, mode, codeChanged: true, self: false, ...approval };
  }
  function pinned(record) {
    return record.source.kind === "github-repo" && record.ref && !record.source.ref ? { ...record.source, ref: record.ref } : record.source;
  }
  async function checkSource(record, deps) {
    const now = nowOf(deps).toISOString();
    try {
      const pkg = await fetchPackage(pinned(record), { fetch: deps.fetch, freshest: true, readme: false });
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
  function checkedLongAgo(record, now, maxAgeMs) {
    const at = record.lastCheckedAt ? Date.parse(record.lastCheckedAt) : NaN;
    return !Number.isFinite(at) || at > now.getTime() || now.getTime() - at > maxAgeMs;
  }
  async function checkAll(deps, options = {}) {
    const records = await deps.store.load();
    const checked = [...records];
    const todo = records.map((r, index) => ({ r, index })).filter(({ r }) => options.due?.(r) ?? true);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const { r, index } = todo[next++];
        const result = await checkSource(r, deps);
        checked[index] = result;
        options.onProgress?.(++done, todo.length, result);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, todo.length)) }, worker));
    return todo.length ? deps.store.commit(changesBetween(records, checked, true)) : records;
  }
  async function updateSource(record, deps) {
    const pkg = await fetchPackage(pinned(record), { fetch: deps.fetch, freshest: true, readme: false, pinCommit: true });
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
    const autoUpdateOff = record.autoUpdate === true;
    await log(deps, { action: "rollback", result: "ok", extensionId: extension.id, name: extension.name, source: record.input, ref: record.ref, from: { version: record.installedVersion, hash: record.installedHash, capabilities: [] }, to: sideOf(extension), detail: autoUpdateOff ? "automatic updates switched off, so the next one does not undo the rollback" : null });
    const now = nowOf(deps).toISOString();
    const latest = record.latest ? { ...record.latest, state: updateState({ version: extension.version, hash: extension.contentHash }, { version: record.latest.version, hash: record.latest.hash }) } : null;
    const updated = { ...record, installedVersion: extension.version, installedHash: extension.contentHash, installedCommit: void 0, installedAt: now, latest, autoUpdate: false };
    await deps.store.commit([{ before: record, after: updated }]);
    return { record: updated, extension, autoUpdateOff };
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
        const completed = { ...record, installedVersion: engine.version, installedHash: engine.contentHash, installedCommit: void 0, installedAt: engine.updatedAt || now, latest: { ...record.latest, state: "up-to-date" }, lastError: null };
        changed.push(completed);
        void log(deps, { action: "update", result: "ok", extensionId: engine.id, name: engine.name, source: record.input, ref: record.ref, from: { version: record.installedVersion, hash: record.installedHash, capabilities: [] }, to: sideOf(engine), detail: "completed after an interrupted update (reconciled on open)" });
        return completed;
      }
      return record;
    });
    if (changed.length) await deps.store.commit(changesBetween(records, next));
    return changed;
  }
  async function setAutoApprove(record, value, deps) {
    const updated = { ...record, autoApprove: value };
    await deps.store.commit([{ before: record, after: updated }]);
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
  async function enableExtension(extension, deps, acknowledgedFullPage) {
    const fullPage = extension.capabilities.includes(FULL_PAGE_ACCESS);
    if (fullPage && !acknowledgedFullPage) throw new EngineApiError("validation", 0, "full page access was not acknowledged");
    try {
      const result = await deps.client.enable(extension.id, extension.contentHash, fullPage);
      await log(deps, { action: "enable", result: "ok", extensionId: extension.id, name: extension.name, source: null, ref: null, from: sideOf(extension), to: sideOf(result), detail: "switched back on with the code approved before" });
      return result;
    } catch (e) {
      const refused = e instanceof EngineApiError && e.code === "needs-approval";
      await log(deps, { action: "enable", result: refused ? "refused" : "failed", extensionId: extension.id, name: extension.name, source: null, ref: null, from: sideOf(extension), to: null, detail: e instanceof Error ? e.message : String(e) });
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
    const merged = mergeImported(existing, incoming);
    if (merged.added) await store.commit(merged.records.slice(existing.length).map((after) => ({ before: null, after })));
    return { imported: merged.added, kept: merged.kept, different: merged.different, ignored: list.length - incoming.length };
  }
  async function setAutoUpdate(record, value, deps) {
    const updated = { ...record, autoUpdate: value };
    await deps.store.commit([{ before: record, after: updated }]);
    await log(deps, { action: "check", result: "ok", extensionId: record.extensionId, name: record.name, source: record.input, ref: record.ref, from: null, to: null, detail: value ? "automatic updates switched on by the user" : "automatic updates switched off" });
    return updated;
  }
  var hasUpdate = (r) => !!r.latest && (r.latest.state === "update" || r.latest.state === "changed");
  var editedSinceInstall = (record, extension) => extension.contentHash !== record.installedHash && extension.contentHash !== record.latest?.hash;
  async function refuseEdited(record, extension, deps) {
    const error = new InstallError("edited", `Marinara holds ${extension.contentHash}; Fetchy last installed ${record.installedHash}`);
    await log(deps, {
      action: "update",
      result: "refused",
      extensionId: record.extensionId,
      name: record.name,
      source: record.input,
      ref: record.ref,
      from: sideOf(extension),
      to: null,
      detail: `automatic update skipped: ${error.message}`
    });
    return error;
  }
  async function autoUpdate(deps, options) {
    const out = [];
    let engine = null;
    for (const first of await deps.store.load()) {
      if (!first.autoUpdate || first.extensionId === deps.selfId) continue;
      let record = first;
      if (options.check) {
        record = await checkSource(first, deps);
        await deps.store.commit([{ before: first, after: record, fromInstall: true }]);
      }
      if (!hasUpdate(record)) continue;
      try {
        engine ??= new Map((await deps.client.list()).map((x) => [x.id, x]));
        const current = engine.get(record.extensionId);
        if (current && editedSinceInstall(record, current)) throw await refuseEdited(record, current, deps);
        out.push({ record, result: await updateSource(record, deps) });
      } catch (e) {
        out.push({ record, result: e instanceof Error ? e : new Error(String(e)) });
      }
    }
    return out;
  }

  // src/notify.ts
  var NOTIFY_EVERY_MS = 6 * 36e5;
  var NOTIFY_DELAY_MS = 3e4;
  var SELF_REPO = { owner: "FigCake", repo: "ME.Fetchy" };
  var SELF_KEY = "fetchy";
  var followsSelf = (records) => records.some((r) => r.source.kind === "github-repo" && r.source.owner.toLowerCase() === SELF_REPO.owner.toLowerCase() && r.source.repo.toLowerCase() === SELF_REPO.repo.toLowerCase());
  function lookDue(lastAt, now, everyMs = NOTIFY_EVERY_MS) {
    const at = lastAt ? Date.parse(lastAt) : NaN;
    return !Number.isFinite(at) || at > now || now - at >= everyMs;
  }
  async function peekUpdates(records, fetch, running, concurrency = 3) {
    const found = [];
    const jobs = records.map((record) => async () => {
      const version = await fetchManifestVersion(record.source, record.ref, { fetch, readme: false }).catch(() => null);
      if (version && compareVersions(version, record.installedVersion) === 1) found.push({ key: record.id, version });
    });
    if (!followsSelf(records)) {
      jobs.push(async () => {
        const version = await fetchManifestVersion({ kind: "github-repo", ...SELF_REPO, ref: null, path: "" }, "main", { fetch, readme: false }).catch(() => null);
        if (version && compareVersions(version, running) === 1) found.push({ key: SELF_KEY, version });
      });
    }
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) await jobs[next++]();
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
    const order = new Map(records.map((r, i) => [r.id, i]));
    return found.sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
  }
  function unnoticed(found, noticed, records) {
    const byId = new Map(records.map((r) => [r.id, r]));
    return found.filter((p) => noticed[p.key] !== p.version && byId.get(p.key)?.latest?.version !== p.version);
  }
  function rememberNoticed(noticed, shown, records) {
    const keep = /* @__PURE__ */ new Set([...records.map((r) => r.id), SELF_KEY]);
    const out = {};
    for (const [key, version] of Object.entries(noticed)) if (keep.has(key) && key !== "__proto__") out[key] = version;
    for (const p of shown) out[p.key] = p.version;
    return out;
  }
  function parseNoticed(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw)) if (typeof value === "string" && key !== "__proto__") out[key] = value;
    return out;
  }
  function stillNewer(peeked, records, running) {
    const byId = new Map(records.map((r) => [r.id, r]));
    return peeked.filter((p) => p.key === SELF_KEY ? compareVersions(p.version, running) === 1 : compareVersions(p.version, byId.get(p.key)?.installedVersion) === 1);
  }

  // src/organize.ts
  var emptyOrganize = () => ({ folders: [], tags: [], of: {} });
  var NAME_MAX = 40;
  function names(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const x of raw) {
      if (!x || typeof x.id !== "string" || !x.id || out.some((y) => y.id === x.id)) continue;
      const name = typeof x.name === "string" ? x.name.trim().slice(0, NAME_MAX) : "";
      if (name) out.push({ id: x.id, name });
    }
    return out;
  }
  function normalizeOrganize(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const folders = names(r.folders);
    const tags = names(r.tags);
    const folderIds = new Set(folders.map((f) => f.id));
    const tagIds = new Set(tags.map((t) => t.id));
    const of = {};
    for (const [key, v] of Object.entries(r.of && typeof r.of === "object" ? r.of : {})) {
      if (!v || typeof v !== "object" || key === "__proto__") continue;
      const folder = typeof v.folder === "string" && folderIds.has(v.folder) ? v.folder : void 0;
      const list = Array.isArray(v.tags) ? [...new Set(v.tags.filter((t) => typeof t === "string" && tagIds.has(t)))] : [];
      const hidden = v.hidden === true;
      if (folder || list.length || hidden) of[key] = { ...folder ? { folder } : {}, ...list.length ? { tags: list } : {}, ...hidden ? { hidden: true } : {} };
    }
    return { folders, tags, of };
  }
  var counter = 0;
  var newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  function addFolder(o, name) {
    const clean = name.trim().slice(0, NAME_MAX);
    return clean ? { ...o, folders: [...o.folders, { id: newId("f"), name: clean }] } : o;
  }
  function addTag(o, name) {
    const clean = name.trim().slice(0, NAME_MAX);
    if (!clean || o.tags.some((t) => t.name.toLowerCase() === clean.toLowerCase())) return o;
    return { ...o, tags: [...o.tags, { id: newId("t"), name: clean }] };
  }
  function rename(o, kind, id, name) {
    const clean = name.trim().slice(0, NAME_MAX);
    if (!clean) return o;
    return { ...o, [kind]: o[kind].map((x) => x.id === id ? { ...x, name: clean } : x) };
  }
  function remove(o, kind, id) {
    return normalizeOrganize({ ...o, [kind]: o[kind].filter((x) => x.id !== id) });
  }
  function setFolder(o, key, folder) {
    return normalizeOrganize({ ...o, of: { ...o.of, [key]: { ...o.of[key], folder: folder ?? void 0 } } });
  }
  function toggleTag(o, key, tag) {
    const now = o.of[key]?.tags ?? [];
    const tags = now.includes(tag) ? now.filter((t) => t !== tag) : [...now, tag];
    return normalizeOrganize({ ...o, of: { ...o.of, [key]: { ...o.of[key], tags } } });
  }
  function setHidden(o, keys, hidden) {
    const of = { ...o.of };
    for (const key of keys) of[key] = { ...of[key], hidden: hidden ? true : void 0 };
    return normalizeOrganize({ ...o, of });
  }
  function addTagTo(o, keys, tag) {
    const of = { ...o.of };
    for (const key of keys) of[key] = { ...of[key], tags: [...of[key]?.tags ?? [], tag] };
    return normalizeOrganize({ ...o, of });
  }
  var isHidden = (o, key) => o.of[key]?.hidden === true;

  // src/profiles.ts
  var PROFILE_LIMIT = 20;
  var NAME_MAX2 = 40;
  var isRecord4 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  var ids = (v) => Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && !!x))] : [];
  function parseProfiles(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const p of raw) {
      if (!isRecord4(p) || typeof p.id !== "string" || typeof p.name !== "string" || !p.name.trim() || out.some((x) => x.id === p.id)) continue;
      out.push({ id: p.id, name: p.name.trim().slice(0, NAME_MAX2), ids: ids(p.ids), savedAt: typeof p.savedAt === "string" ? p.savedAt : "" });
    }
    return out.slice(0, PROFILE_LIMIT);
  }
  var switchedOn = (extensions, selfId) => extensions.filter((x) => x.enabled && x.id !== selfId).map((x) => x.id);
  function saveProfile(list, name, on, now = /* @__PURE__ */ new Date()) {
    const clean = name.trim().slice(0, NAME_MAX2);
    if (!clean) return null;
    const same = list.find((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (!same && list.length >= PROFILE_LIMIT) return null;
    const profile = { id: same?.id ?? `p-${now.getTime().toString(36)}-${list.length.toString(36)}`, name: clean, ids: [...new Set(on)], savedAt: now.toISOString() };
    return same ? list.map((p) => p.id === same.id ? profile : p) : [...list, profile];
  }
  function planSwitch(wanted, extensions, selfId) {
    const want = new Set(wanted);
    const byId = new Map(extensions.map((x) => [x.id, x]));
    const others = extensions.filter((x) => x.id !== selfId);
    const off = others.filter((x) => x.enabled && !want.has(x.id));
    const wantedOff = others.filter((x) => !x.enabled && want.has(x.id));
    const on = wantedOff.filter(canReenable);
    const needsApproval = wantedOff.filter((x) => !canReenable(x));
    const missing = wanted.filter((id) => !byId.has(id) && id !== selfId);
    return { off, on, needsApproval, missing, fullPage: on.some((x) => x.capabilities.includes(FULL_PAGE_ACCESS)) };
  }
  async function applySwitch(plan, deps, acknowledgedFullPage) {
    const result = { switchedOff: [], switchedOn: [], failed: [] };
    for (const x of plan.off) {
      try {
        await disableExtension(x, deps);
        result.switchedOff.push(x.name);
      } catch (e) {
        result.failed.push({ name: x.name, error: e });
      }
    }
    for (const x of plan.on) {
      try {
        await enableExtension(x, deps, acknowledgedFullPage);
        result.switchedOn.push(x.name);
      } catch (e) {
        result.failed.push({ name: x.name, error: e });
      }
    }
    return result;
  }
  function parseBisect(raw) {
    if (!isRecord4(raw) || typeof raw.startedAt !== "string") return null;
    const found = raw.found === null ? null : typeof raw.found === "string" ? raw.found : void 0;
    return {
      startedAt: raw.startedAt,
      original: ids(raw.original),
      suspects: ids(raw.suspects),
      testing: ids(raw.testing),
      steps: typeof raw.steps === "number" && raw.steps >= 0 ? Math.floor(raw.steps) : 0,
      acknowledged: raw.acknowledged === true,
      ...found !== void 0 ? { found } : {}
    };
  }
  var half = (suspects) => suspects.slice(0, Math.floor(suspects.length / 2));
  function startBisect(on, acknowledged, now = /* @__PURE__ */ new Date()) {
    if (!on.length) return null;
    return { startedAt: now.toISOString(), original: [...on], suspects: [...on], testing: half(on), steps: 0, acknowledged };
  }
  function answerBisect(b, stillThere) {
    if (b.found !== void 0) return b;
    const testing = new Set(b.testing);
    const suspects = stillThere ? b.suspects.filter((id) => testing.has(id)) : b.suspects.filter((id) => !testing.has(id));
    const steps = b.steps + 1;
    if (suspects.length === 0) return { ...b, suspects, testing: [], steps, found: null };
    if (suspects.length === 1) {
      if (!stillThere) return { ...b, suspects, testing: [], steps, found: suspects[0] };
      return { ...b, suspects, testing: [], steps };
    }
    return { ...b, suspects, testing: half(suspects), steps };
  }
  var bisectWanted = (b) => b.found !== void 0 ? b.original : b.testing;

  // src/catalog-lists.ts
  var LIST_KIND = "me-fetchy.catalog";
  var MAX_LISTS = 10;
  var MAX_ENTRIES2 = 50;
  var MAX_BYTES = 256 * 1024;
  var TEXT_MAX = 200;
  var CatalogListError = class extends Error {
    constructor(reason) {
      super(reason);
      this.reason = reason;
      this.name = "CatalogListError";
    }
    reason;
  };
  var text = (v, max = TEXT_MAX) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
  function parseCatalogList(raw, url, now = /* @__PURE__ */ new Date()) {
    if (!raw || typeof raw !== "object" || raw.kind !== LIST_KIND || !Array.isArray(raw.entries)) {
      throw new CatalogListError("not-a-list");
    }
    const r = raw;
    const entries2 = [];
    for (const e of r.entries.slice(0, MAX_ENTRIES2)) {
      if (!e || typeof e !== "object") continue;
      const x = e;
      const name = text(x.name, 80), input = text(x.input, 300);
      if (!name || !input) continue;
      try {
        parseSourceUrl(input);
      } catch {
        continue;
      }
      const en2 = text(x.about?.en), ko2 = text(x.about?.ko);
      entries2.push({ name, input, about: { en: en2 || ko2, ko: ko2 || en2 } });
    }
    return { url, name: text(r.name, 80) || new URL(url).hostname, entries: entries2, fetchedAt: now.toISOString() };
  }
  async function fetchCatalogList(url, options, now = /* @__PURE__ */ new Date()) {
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new CatalogListError("not-https");
    }
    if (parsed.protocol !== "https:") throw new CatalogListError("not-https");
    const body2 = await fetchSmallText(parsed.href, { ...options, freshest: true }, MAX_BYTES);
    if (body2 == null) throw new CatalogListError("not-found");
    let raw;
    try {
      raw = JSON.parse(body2);
    } catch {
      throw new CatalogListError("not-a-list");
    }
    return parseCatalogList(raw, parsed.href, now);
  }
  function parseStoredLists(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const l of raw.slice(0, MAX_LISTS)) {
      if (!l || typeof l !== "object" || typeof l.url !== "string") continue;
      try {
        const list = parseCatalogList({ kind: LIST_KIND, ...l }, l.url);
        out.push({ ...list, fetchedAt: typeof l.fetchedAt === "string" ? l.fetchedAt : list.fetchedAt });
      } catch {
      }
    }
    return out;
  }
  function withList(lists, list) {
    if (lists.some((l) => l.url === list.url)) return lists.map((l) => l.url === list.url ? list : l);
    return lists.length >= MAX_LISTS ? null : [...lists, list];
  }

  // src/catalog.ts
  var CATALOG = [
    { name: "Dispensa", input: "FigCake/ME.Dispensa", about: { en: "Quick Replies (STscript), the Dock, the visualizer and a memo pad", ko: "퀵 리플라이(STscript)·독·비주얼라이저·메모장" } },
    { name: "Fornello", input: "FigCake/ME.Fornello", about: { en: "Runs HTML pages, components and scripts in chat messages", ko: "채팅 속 HTML 페이지·컴포넌트·스크립트 실행" } },
    { name: "Polyglot", input: "FigCake/ME.Polyglot", about: { en: "Language study in your chats: tap translation, a wordbook with reviews, dialogue voice", ko: "채팅으로 언어 공부: 눌러서 번역·단어장과 복습·대사 음성" } }
  ];
  function catalogMode(p) {
    if (p.engineListError) throw p.engineListError;
    const record = p.engine?.record;
    if (!record) return { kind: "create" };
    if (p.engine?.runtimeDiffers) return { skip: "runtime" };
    const ours = p.tracked !== null && p.tracked.extensionId === record.id && sameRepo(p.tracked.source, p);
    if (p.engine?.sameCode) return ours && p.tracked?.installedHash === p.contentHash ? { skip: "current" } : { kind: "link", extensionId: record.id };
    if (p.engine?.editedInMarinara) return { skip: "edited" };
    if (!ours) return { skip: "other" };
    if (compareVersions(p.draft.version, record.version) === -1) return { skip: "newer" };
    return { kind: "update", extensionId: record.id };
  }
  function catalogRepo(entry) {
    const source = parseSourceUrl(entry.input);
    return source.kind === "github-repo" ? { owner: source.owner, repo: source.repo } : { owner: "", repo: "" };
  }
  function isCatalogSource(entry, source) {
    const { owner, repo } = catalogRepo(entry);
    return source.kind === "github-repo" && source.owner.toLowerCase() === owner.toLowerCase() && source.repo.toLowerCase() === repo.toLowerCase();
  }
  function sameRepo(tracked, p) {
    const now = p.source;
    if (tracked.kind !== "github-repo" || now.kind !== "github-repo") return false;
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    return same(tracked.owner, now.owner) && same(tracked.repo, now.repo) && tracked.path === now.path && (tracked.ref === now.ref || now.ref === null && tracked.ref === p.pkg.ref);
  }
  function stopsAll(error) {
    if (error instanceof EngineApiError) return ["gates-closed", "privileged", "untrusted-host", "csrf", "network"].includes(error.code);
    return error instanceof FetchError && (error.code === "network" || error.code === "timeout" || error.code === "rate-limited");
  }
  async function installCatalog(entries2, deps, onProgress) {
    const out = [];
    let stopped = false;
    for (const [i, entry] of entries2.entries()) {
      if (stopped) {
        out.push({ entry, status: "stopped" });
        continue;
      }
      onProgress?.(i, entries2.length, entry);
      try {
        const prepared = await prepare(entry.input, deps, { freshest: true, readme: false });
        const mode = catalogMode(prepared);
        if ("skip" in mode) out.push({ entry, status: "skipped", reason: mode.skip });
        else out.push({ entry, status: "done", result: await install(keepAddress(prepared, mode), deps, mode) });
      } catch (error) {
        out.push({ entry, status: "failed", error });
        stopped = stopsAll(error);
      }
    }
    return out;
  }
  function keepAddress(p, mode) {
    return mode.kind !== "create" && p.tracked && sameRepo(p.tracked.source, p) ? { ...p, input: p.tracked.input, source: p.tracked.source } : p;
  }

  // src/changelog.ts
  var CHANGELOG_LIMIT = 20;
  var MAX_ANSWER_BYTES = 512 * 1024;
  var TITLE_MAX = 120;
  function where(record) {
    const s = record.source;
    if (s.kind !== "github-repo") return null;
    return { owner: s.owner, repo: s.repo, ref: record.ref ?? s.ref ?? "main", path: normalizePath(s.path) };
  }
  function historyUrl(record) {
    const w = where(record);
    if (!w) return null;
    const ref = w.ref.split("/").map(encodeURIComponent).join("/");
    return `https://github.com/${w.owner}/${w.repo}/commits/${ref}${w.path ? `/${w.path.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  }
  var canListChanges = (record) => record.source.kind === "github-repo" && !!record.installedCommit;
  function commitsApiUrl(record) {
    const w = where(record);
    if (!w) return null;
    const query = new URLSearchParams({ sha: w.ref, per_page: String(CHANGELOG_LIMIT) });
    if (w.path) query.set("path", w.path);
    return `https://api.github.com/repos/${encodeURIComponent(w.owner)}/${encodeURIComponent(w.repo)}/commits?${query}`;
  }
  function parseCommits(answer, installedCommit) {
    const commits = [];
    if (!Array.isArray(answer)) return { commits, complete: false };
    for (const item of answer) {
      if (!item || typeof item !== "object") continue;
      const x = item;
      if (typeof x.sha !== "string") continue;
      if (x.sha.toLowerCase() === installedCommit.toLowerCase()) return { commits, complete: true };
      const message2 = typeof x.commit?.message === "string" ? x.commit.message : "";
      const first = message2.split("\n", 1)[0]?.trim() ?? "";
      const date = x.commit?.committer?.date ?? x.commit?.author?.date;
      const url = typeof x.html_url === "string" && x.html_url.startsWith("https://github.com/") ? x.html_url : "";
      commits.push({ sha: x.sha, title: first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first, date: typeof date === "string" ? date : null, url });
    }
    return { commits, complete: false };
  }
  async function changesSince(record, options) {
    const url = commitsApiUrl(record);
    if (!url || !record.installedCommit) throw new FetchError("http", "no commit to count from", url ?? "");
    const text2 = await fetchSmallText(url, { ...options, freshest: false }, MAX_ANSWER_BYTES);
    if (text2 == null) throw new FetchError("http", "HTTP 404", url, 404);
    let answer;
    try {
      answer = JSON.parse(text2);
    } catch (e) {
      throw new FetchError("bad-json", e instanceof Error ? e.message : String(e), url);
    }
    return parseCommits(answer, record.installedCommit);
  }

  // src/conflicts.ts
  var ALLOW = [
    { kind: "global", name: "__dispensa" },
    { kind: "event", name: "dispensa:ready" }
  ];
  var SNIPPET = 120;
  var ID = "[A-Za-z_$][\\w$]*";
  var str3 = (group = 1) => `(['"\`])([^'"\`\\n]{1,200})\\${group}`;
  var STR = str3(1);
  var ASSIGN = "(?:=(?!=)|\\?\\?=|\\|\\|=)";
  function lineIndex(text2) {
    const starts = [0];
    for (let i = text2.indexOf("\n"); i !== -1; i = text2.indexOf("\n", i + 1)) starts.push(i + 1);
    return starts;
  }
  function locate(text2, starts, at) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    const start = starts[lo];
    const end = lo + 1 < starts.length ? starts[lo + 1] - 1 : text2.length;
    const from = end - start <= SNIPPET ? start : Math.max(start, Math.min(at - 40, end - SNIPPET));
    return { line: lo + 1, text: text2.slice(from, Math.min(end, from + SNIPPET)).trim() };
  }
  function scan(text2, re, each) {
    re.lastIndex = 0;
    for (let m = re.exec(text2); m; m = re.exec(text2)) {
      each(m);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  var SCOPE = "(?:window|globalThis|self)";
  var JS_RULES = [
    { kind: "fetch", role: "define", re: new RegExp(`\\b${SCOPE}\\s*\\.\\s*fetch\\s*=(?!=)`, "g"), name: () => "fetch" },
    { kind: "global", role: "define", re: new RegExp(`\\b${SCOPE}\\s*\\.\\s*(${ID})\\s*${ASSIGN}`, "g"), name: (m) => m[1] === "fetch" ? null : m[1] ?? null },
    { kind: "global", role: "define", re: new RegExp(`\\b${SCOPE}\\s*\\[\\s*${STR}\\s*\\]\\s*${ASSIGN}`, "g"), name: (m) => m[2] ?? null },
    { kind: "global", role: "define", re: new RegExp(`Object\\.defineProperty\\(\\s*${SCOPE}\\s*,\\s*${STR}`, "g"), name: (m) => m[2] ?? null },
    // the whole name (no shorter one by backtracking), not followed by an assignment
    { kind: "global", role: "read", re: new RegExp(`\\b${SCOPE}\\s*\\.\\s*(${ID})(?![\\w$])(?!\\s*${ASSIGN})`, "g"), name: (m) => m[1] ?? null },
    { kind: "element", role: "define", re: new RegExp(`customElements\\.define\\(\\s*${STR}`, "g"), name: (m) => m[2] ?? null },
    { kind: "element", role: "read", re: new RegExp(`customElements\\.(?:get|whenDefined)\\(\\s*${STR}`, "g"), name: (m) => m[2] ?? null },
    { kind: "id", role: "define", re: new RegExp(`\\.id\\s*=(?!=)\\s*${STR}`, "g"), name: (m) => m[2] ?? null },
    { kind: "id", role: "define", re: new RegExp(`setAttribute\\(\\s*['"]id['"]\\s*,\\s*${STR}`, "g"), name: (m) => m[2] ?? null },
    { kind: "id", role: "read", re: new RegExp(`getElementById\\(\\s*${STR}`, "g"), name: (m) => m[2] ?? null },
    { kind: "id", role: "read", re: /querySelector(?:All)?\(\s*(['"`])#([A-Za-z][\w-]{0,100})\1/g, name: (m) => m[2] ?? null },
    { kind: "storage-key", role: "define", re: new RegExp(`\\b(local|session)Storage\\.setItem\\(\\s*${str3(2)}`, "g"), name: (m) => `${m[1]}:${m[3]}` },
    { kind: "storage-key", role: "read", re: new RegExp(`\\b(local|session)Storage\\.getItem\\(\\s*${str3(2)}`, "g"), name: (m) => `${m[1]}:${m[3]}` },
    { kind: "database", role: "define", re: new RegExp(`indexedDB\\.open\\(\\s*${STR}`, "g"), name: (m) => m[2] ?? null },
    { kind: "symbol", role: "define", re: new RegExp(`Symbol\\.for\\(\\s*${STR}`, "g"), name: (m) => m[2] ?? null },
    { kind: "event", role: "define", re: new RegExp(`new\\s+CustomEvent\\(\\s*${STR}`, "g"), name: (m) => m[2] ?? null },
    // a custom event listened to (a ':' or '-' in its name; built-in events have neither)
    { kind: "event", role: "read", re: /addEventListener\(\s*(['"`])([\w.]{1,60}[:-][\w:.-]{1,100})\1/g, name: (m) => m[2] ?? null },
    { kind: "command", role: "define", re: new RegExp(`registerCommand\\(\\s*(?:\\{[^{}]{0,300}?\\bname\\s*:\\s*)?${STR}`, "g"), name: (m) => m[2] ?? null }
  ];
  function idProperties(js, add) {
    scan(js, /\bid\s*:\s*(['"`])([A-Za-z][\w-]{0,100})\1/g, (m) => {
      const before = js.slice(Math.max(0, m.index - 300), m.index);
      const made = before.lastIndexOf("createElement");
      const sameStatement = made !== -1 && !before.slice(made).includes(";");
      const helper = /\b[\w$.]+\(\s*(['"`])[a-z][a-z0-9-]*\1\s*,\s*\{[^{};]*$/.test(before);
      if (sameStatement || helper) add(m.index, m[2]);
    });
  }
  var MODIFIERS = ["altKey", "ctrlKey", "metaKey", "shiftKey"];
  function shortcuts(js, add) {
    scan(js, /['"`]keydown['"`]/g, (m) => {
      const body2 = js.slice(m.index, m.index + 700);
      const mods = MODIFIERS.filter((k) => new RegExp(`(?<![!\\w])(?:\\w+\\.)?${k}\\b(?!\\s*===?\\s*false)`).test(body2)).map((k) => k.replace("Key", ""));
      const key = /\.key\s*===?\s*(['"`])(.)\1/.exec(body2)?.[2] ?? /\.code\s*===?\s*(['"`])Key([A-Z])\1/.exec(body2)?.[2];
      if (mods.length && key) add(m.index, `${mods.sort().join("+")}+${key.toUpperCase()}`);
    });
  }
  function cssClaims(css, out) {
    const starts = lineIndex(css);
    const text2 = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    let depth = 0, selectorStart = 0, bodyStart = -1, selector = "";
    for (let i = 0; i < text2.length; i++) {
      const ch = text2[i];
      if (ch === "{") {
        if (depth === 0) {
          selector = text2.slice(selectorStart, i).trim();
          bodyStart = i + 1;
        }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          if (selector && !selector.startsWith("@")) {
            const selectors = selector.split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
            let from = bodyStart;
            while (from < i) {
              const semi = text2.indexOf(";", from);
              const end = semi === -1 || semi > i ? i : semi;
              const decl = text2.slice(from, end);
              const colon = decl.indexOf(":");
              if (colon > 0) {
                const prop = decl.slice(0, colon).trim().toLowerCase();
                const rest = decl.slice(colon + 1).trimEnd();
                const mark = /!\s*important$/i.exec(rest.slice(-24));
                if (mark && /^-{0,2}[a-z][\w-]*$/.test(prop)) {
                  const value = rest.slice(0, rest.length - mark[0].length).trim();
                  const where2 = locate(css, starts, from + decl.search(/\S/));
                  for (const sel of selectors) out.push({ kind: "css", name: `${sel} { ${prop} }`, role: "define", file: "css", line: where2.line, text: where2.text, value });
                }
              }
              from = end + 1;
            }
          }
          selectorStart = i + 1;
        }
        if (depth < 0) depth = 0;
      } else if (ch === ";" && depth === 0) {
        selectorStart = i + 1;
      }
    }
  }
  function claimsOf(code) {
    const out = [];
    const js = code.js ?? "";
    if (js) {
      const starts = lineIndex(js);
      const push = (kind, role, at, name) => {
        const where2 = locate(js, starts, at);
        out.push({ kind, name, role, file: "js", line: where2.line, text: where2.text });
      };
      for (const rule of JS_RULES) scan(js, rule.re, (m) => {
        const name = rule.name(m);
        if (name) push(rule.kind, rule.role, m.index, name);
      });
      idProperties(js, (at, name) => push("id", "define", at, name));
      shortcuts(js, (at, combo) => push("shortcut", "define", at, combo));
    }
    if (code.css) cssClaims(code.css, out);
    return out;
  }
  var COLLIDING = /* @__PURE__ */ new Set(["global", "element", "id", "storage-key", "database", "command", "css"]);
  var allowed = (kind, name) => ALLOW.some((a) => a.kind === kind && a.name === name);
  function compare(a, b) {
    const index = (claims) => {
      const m = /* @__PURE__ */ new Map();
      for (const c of claims) {
        const key = `${c.kind}\0${c.name}`;
        const e = m.get(key) ?? { values: /* @__PURE__ */ new Set() };
        if (c.role === "define" && !e.define) e.define = c;
        if (c.role === "read" && !e.read) e.read = c;
        if (c.value !== void 0) e.values.add(c.value.toLowerCase());
        m.set(key, e);
      }
      return m;
    };
    const left = index(a.claims), right = index(b.claims);
    const out = [];
    for (const [key, l] of left) {
      const r = right.get(key);
      if (!r) continue;
      const [kind, name] = key.split("\0");
      const side3 = (x, c) => ({ extensionId: x.id, name: x.name, claim: c });
      if (l.define && r.define) {
        if (kind === "css") {
          if ([...l.values].every((v) => r.values.has(v)) && [...r.values].every((v) => l.values.has(v))) continue;
        }
        const level = COLLIDING.has(kind) && !allowed(kind, name) ? "conflict" : "note";
        out.push({ kind, name, level, a: side3(a, l.define), b: side3(b, r.define) });
      } else if (l.define && r.read) {
        if (kind !== "shortcut" && kind !== "css") out.push({ kind, name, level: "note", a: side3(a, l.define), b: side3(b, r.read) });
      } else if (l.read && r.define) {
        if (kind !== "shortcut" && kind !== "css") out.push({ kind, name, level: "note", a: side3(b, r.define), b: side3(a, l.read) });
      }
    }
    return out.sort((x, y) => (x.level === y.level ? 0 : x.level === "conflict" ? -1 : 1) || x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name));
  }
  var withClaims = (x) => ({ ...x, claims: claimsOf(x) });
  function conflictsWith(subject, installed) {
    const s = withClaims(subject);
    return installed.flatMap((x) => compare(s, withClaims(x)));
  }
  function conflictsAmong(list) {
    const all = list.map(withClaims);
    const out = [];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) out.push(...compare(all[i], all[j]));
    return out;
  }
  function findingsText(findings) {
    if (!findings.length) return "No overlaps found.";
    return findings.map((f) => [
      `${f.level === "conflict" ? "CONFLICT" : "note"} · ${f.kind} · ${f.name}`,
      `  ${f.a.name} ${f.a.claim.file}:${f.a.claim.line} ${f.a.claim.role} · ${f.a.claim.text}`,
      `  ${f.b.name} ${f.b.claim.file}:${f.b.claim.line} ${f.b.claim.role} · ${f.b.claim.text}`
    ].join("\n")).join("\n");
  }
  function findingsSummary(findings) {
    if (!findings.length) return "Conflict check: no overlaps";
    const lines = ["Conflict check"];
    for (const level of ["conflict", "note"]) {
      const byKind = /* @__PURE__ */ new Map();
      for (const f of findings.filter((x) => x.level === level)) byKind.set(f.kind, [...byKind.get(f.kind) ?? [], `${f.name} (${f.a.name} / ${f.b.name})`]);
      for (const [kind, names2] of byKind) lines.push(`- ${level} ${kind} ×${names2.length}: ${names2.join(", ")}`);
    }
    return lines.join("\n");
  }

  // src/diagnostics.ts
  var DIAGNOSTICS_LOG_ENTRIES = 20;
  function browserOf(userAgent) {
    const pick = (re, name) => {
      const m = re.exec(userAgent);
      return m ? `${name} ${m[1]}` : null;
    };
    return pick(/Edg\/([\d.]+)/, "Edge") ?? pick(/OPR\/([\d.]+)/, "Opera") ?? pick(/Firefox\/([\d.]+)/, "Firefox") ?? pick(/Chrome\/([\d.]+)/, "Chrome") ?? pick(/Version\/([\d.]+).*Safari\//, "Safari") ?? "unknown";
  }
  function isLocalHost(hostname) {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
  }
  function parseHealth(answer) {
    if (!answer || typeof answer !== "object") return null;
    const a = answer;
    const version = typeof a.version === "string" ? a.version : null;
    const commit = typeof a.commit === "string" ? a.commit : typeof a.build?.commit === "string" ? a.build.commit : null;
    return version || commit ? { version, commit } : null;
  }
  var TOKEN_PATTERNS = [
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\bsk-[A-Za-z0-9_-]{16,}\b/g
  ];
  function cleanText(text2, secrets = []) {
    let out = text2;
    for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
    out = out.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1");
    for (const re of TOKEN_PATTERNS) out = out.replace(re, "[redacted]");
    return out.replace(/x-admin-secret\s*[:=]\s*\S+/gi, "x-admin-secret: [redacted]").replace(/(authorization|token|secret|password|api[-_]?key)\s*[:=]\s*\S+/gi, "$1: [redacted]");
  }
  var kib = (n) => n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
  var shortHash = (hash) => hash ? hash.replace(/^sha256:/, "").slice(0, 12) : "-";
  var yes = (b) => b ? "on" : "off";
  function extensionLines(x, r, input) {
    const name = x?.name ?? r?.name ?? "?";
    const state = !x ? "missing in Marinara" : x.enabled ? "on" : x.approvedHash === x.contentHash ? "off (approved)" : "off (needs approval)";
    const head = [
      `- ${name} ${x?.version ?? r?.installedVersion ?? "?"}`,
      x ? x.runtime : null,
      x ? `[${x.capabilities.join(", ")}]` : null,
      state,
      `hash ${shortHash(x?.contentHash ?? r?.installedHash)}`,
      x && x.id === input.selfId ? "this is Fetchy" : null
    ].filter(Boolean).join(" · ");
    const lines = [head];
    if (r) {
      const ref = r.ref && !(r.source.kind === "github-repo" && r.source.ref) ? `@${r.ref}` : "";
      lines.push(`  source ${describeSource(r.source)}${ref} · automatic updates ${yes(r.autoUpdate)} · auto re-approve ${yes(r.autoApprove)}`);
      const check2 = r.latest ? `${r.latest.state}${r.latest.version ? ` ${r.latest.version}` : ""} (${r.latest.checkedAt})` : "never";
      lines.push(`  last check ${check2}${r.lastCheckedAt ? ` · checked ${r.lastCheckedAt}` : ""}`);
      if (r.lastError) lines.push(`  last error ${r.lastError}`);
    } else {
      lines.push("  installed by hand (no source in Fetchy)");
    }
    const bytes = x ? input.storageBytes?.get(x.id) : void 0;
    if (bytes !== void 0) lines.push(`  stored data ${kib(bytes)}`);
    return lines;
  }
  function diagnosticsText(input, secrets = []) {
    const p = input.policy;
    const gates = p ? `env ${yes(p.externalExtensionsEnvEnabled)} · switch ${yes(p.externalExtensionsEnabled)} · server sandbox ${p.serverSandboxAvailable ? p.serverSandboxBackend ?? "yes" : `no${p.serverSandboxReason ? ` (${p.serverSandboxReason})` : ""}`}` : `unknown${input.policyError ? ` (${input.policyError})` : ""}`;
    const lines = [
      `Fetchy diagnostics · ${input.now.toISOString()}`,
      `Fetchy ${input.fetchyVersion} · hashing ${input.jsDigest ? "JavaScript SHA-256 (no WebCrypto)" : "WebCrypto"}`,
      `Marinara ${input.health?.version ?? "unknown"} · commit ${input.health?.commit ?? "unknown"}`,
      `External Extension gates: ${gates}`,
      `Browser ${browserOf(input.userAgent)} · UI ${input.uiLanguage}`,
      `Access ${input.remote ? "remote" : "local"} · admin secret ${input.hasAdminSecret ? "set" : "not set"}`,
      "",
      "Extensions"
    ];
    const records = new Map(input.records.map((r) => [r.extensionId, r]));
    if (input.extensions) {
      for (const x of input.extensions) lines.push(...extensionLines(x, records.get(x.id) ?? null, input));
      const listed = new Set(input.extensions.map((x) => x.id));
      for (const r of input.records) if (!listed.has(r.extensionId)) lines.push(...extensionLines(null, r, input));
      if (!input.extensions.length && !input.records.length) lines.push("- none");
    } else {
      lines.push(`- Marinara's list could not be read${input.listError ? `: ${input.listError}` : ""}`);
      for (const r of input.records) lines.push(...extensionLines(null, r, input));
    }
    for (const section of input.extra ?? []) lines.push("", section);
    const entries2 = input.log.slice(0, DIAGNOSTICS_LOG_ENTRIES).map((e) => ({ ...e, detail: e.detail ? scrub(e.detail) : null }));
    lines.push("", `Change log (latest ${entries2.length})`, entries2.length ? AuditLog.format(entries2) : "- empty");
    return cleanText(lines.join("\n"), secrets);
  }

  // src/storage-view.ts
  var STORAGE_BACKUP_KIND = "me-fetchy.storage";
  var FULL_BACKUP_KIND = "me-fetchy.backup";
  var TOP_KEYS = 5;
  var utf8Bytes = (text2) => new TextEncoder().encode(text2).byteLength;
  var storedBytes = (value) => utf8Bytes(JSON.stringify(value));
  function measure(value) {
    const top = Object.entries(value).map(([key, v]) => ({ key, bytes: utf8Bytes(JSON.stringify(key)) + 1 + utf8Bytes(JSON.stringify(v) ?? "null") })).sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key)).slice(0, TOP_KEYS);
    return { bytes: storedBytes(value), top };
  }
  var measurable = (x) => x.runtime === "client" && x.enabled && x.approvedHash !== null && x.approvedHash === x.contentHash;
  async function measureAll(extensions, client, onEach) {
    const out = /* @__PURE__ */ new Map();
    for (const x of extensions) {
      if (x.runtime !== "client") continue;
      let result;
      if (!measurable(x)) result = { status: "off" };
      else {
        try {
          result = { status: "ok", ...measure(await client.readStorage(x.id)) };
        } catch (e) {
          result = e instanceof EngineApiError && e.code === "not-found" ? { status: "off" } : { status: "failed", error: e };
        }
      }
      out.set(x.id, result);
      onEach?.(x, result);
    }
    return out;
  }
  function storageBackup(x, value, now = /* @__PURE__ */ new Date()) {
    return { kind: STORAGE_BACKUP_KIND, version: 1, extension: { name: x.name, id: x.id, version: x.version }, savedAt: now.toISOString(), value };
  }
  function backupFileName(name, now = /* @__PURE__ */ new Date()) {
    const safe = name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "extension";
    return `${safe}-storage-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  }
  var BackupFileError = class extends Error {
    constructor(reason) {
      super(reason);
      this.reason = reason;
      this.name = "BackupFileError";
    }
    reason;
  };
  var isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  function planRestore(text2, target) {
    let parsed;
    try {
      parsed = JSON.parse(text2);
    } catch {
      throw new BackupFileError("not-json");
    }
    if (!isPlain(parsed)) throw new BackupFileError("not-a-backup");
    let value;
    let from = null;
    if (parsed.kind === STORAGE_BACKUP_KIND) {
      value = parsed.value;
      const ext = isPlain(parsed.extension) ? parsed.extension : {};
      if (typeof ext.name === "string") from = { name: ext.name, version: typeof ext.version === "string" ? ext.version : null };
    } else if (parsed.kind === FULL_BACKUP_KIND && isPlain(parsed.storage)) {
      const key = Object.keys(parsed.storage).find((k) => k.trim().toLowerCase() === target.name.trim().toLowerCase());
      if (!key) throw new BackupFileError("not-in-backup");
      value = parsed.storage[key];
      from = { name: key, version: null };
    } else {
      throw new BackupFileError("not-a-backup");
    }
    if (!isPlain(value)) throw new BackupFileError("not-a-backup");
    const bytes = storedBytes(value);
    if (bytes > STORAGE_LIMIT_BYTES) throw new BackupFileError("too-large");
    const warnings = [];
    if (from && from.name.trim().toLowerCase() !== target.name.trim().toLowerCase()) warnings.push("other-name");
    if (from?.version && target.version && from.version !== target.version) warnings.push("other-version");
    return { value, bytes, from, warnings };
  }
  var side2 = (x) => ({ version: x.version, hash: x.contentHash, capabilities: [...x.capabilities] });
  async function log2(audit, entry) {
    try {
      await audit?.record(entry);
    } catch {
    }
  }
  async function restoreStorage(x, plan, deps) {
    if (deps.selfId === null || x.id === deps.selfId) throw new EngineApiError("validation", 0, "Fetchy’s own data holds its source list and is not restored here; use Import list");
    try {
      await deps.client.clearStorage(x.id);
      await deps.client.patchStorage(x.id, plan.value);
      await log2(deps.audit, { action: "storage-restore", result: "ok", extensionId: x.id, name: x.name, source: null, ref: null, from: side2(x), to: side2(x), detail: `${plan.bytes} bytes` });
    } catch (e) {
      await log2(deps.audit, { action: "storage-restore", result: "failed", extensionId: x.id, name: x.name, source: null, ref: null, from: side2(x), to: null, detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
  async function clearStorage(x, bytes, deps) {
    if (deps.selfId === null || x.id === deps.selfId) throw new EngineApiError("validation", 0, "Fetchy’s own data holds its source list and is not cleared here");
    try {
      await deps.client.clearStorage(x.id);
      await log2(deps.audit, { action: "storage-clear", result: "ok", extensionId: x.id, name: x.name, source: null, ref: null, from: side2(x), to: null, detail: `${bytes} bytes` });
    } catch (e) {
      await log2(deps.audit, { action: "storage-clear", result: "failed", extensionId: x.id, name: x.name, source: null, ref: null, from: side2(x), to: null, detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
  function groupLocalStorage(entries2) {
    const groups = /* @__PURE__ */ new Map();
    for (const [key, value] of entries2) {
      const name = /^marinara/i.test(key) ? "Marinara" : key.includes(":") ? key.slice(0, key.indexOf(":")) || ":" : (/^[\p{L}\p{N}]+/u.exec(key)?.[0] ?? key) || "?";
      const group = groups.get(name) ?? { name, keys: 0, bytes: 0 };
      group.keys++;
      group.bytes += (key.length + value.length) * 2;
      groups.set(name, group);
    }
    return [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  }
  async function browserStorage(win = globalThis) {
    let usage = null, quota = null;
    try {
      const estimate = await win.navigator?.storage?.estimate?.();
      usage = estimate?.usage ?? null;
      quota = estimate?.quota ?? null;
    } catch {
    }
    const entries2 = [];
    try {
      const ls = win.localStorage;
      for (let i = 0; ls && i < ls.length; i++) {
        const key = ls.key(i);
        if (key !== null) entries2.push([key, ls.getItem(key) ?? ""]);
      }
    } catch {
    }
    let databases = null;
    try {
      const list = await win.indexedDB?.databases?.();
      databases = list ? list.map((d) => d.name ?? "?") : null;
    } catch {
    }
    return { usage, quota, local: groupLocalStorage(entries2), databases };
  }

  // src/full-backup.ts
  function fullBackup(records, organize, storage, now = /* @__PURE__ */ new Date()) {
    return { kind: FULL_BACKUP_KIND, version: 1, savedAt: now.toISOString(), sources: [...records], organize, storage: Object.fromEntries(storage) };
  }
  function fullBackupFileName(now = /* @__PURE__ */ new Date()) {
    return `fetchy-backup-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  }
  function readFullBackup(text2) {
    let parsed;
    try {
      parsed = JSON.parse(text2);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || parsed.kind !== FULL_BACKUP_KIND) return null;
    const p = parsed;
    const storage = p.storage && typeof p.storage === "object" && !Array.isArray(p.storage) ? p.storage : {};
    return {
      organize: p.organize ? normalizeOrganize(p.organize) : null,
      storageNames: Object.keys(storage).filter((k) => storage[k] && typeof storage[k] === "object" && !Array.isArray(storage[k]))
    };
  }
  function mergeOrganize(here, from) {
    if (!from || here.folders.length || here.tags.length || Object.keys(here.of).length) return here;
    return from;
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

  // src/repo-status.ts
  var REPO_CHECK_EVERY_MS = 7 * 24 * 36e5;
  var STALE_AFTER_MS = 183 * 24 * 36e5;
  var MAX_ANSWER_BYTES2 = 256 * 1024;
  function repoMark(record, now) {
    if (!record.repo) return null;
    if (record.repo.archived) return "archived";
    const pushed = record.repo.pushedAt ? Date.parse(record.repo.pushedAt) : NaN;
    return Number.isFinite(pushed) && now - pushed > STALE_AFTER_MS ? "stale" : null;
  }
  function repoStatusDue(record, now) {
    if (record.source.kind !== "github-repo") return false;
    const at = record.repo ? Date.parse(record.repo.checkedAt) : NaN;
    return !Number.isFinite(at) || at > now || now - at >= REPO_CHECK_EVERY_MS;
  }
  function parseRepoStatus(answer, checkedAt) {
    if (!answer || typeof answer !== "object") return null;
    const a = answer;
    if (typeof a.archived !== "boolean") return null;
    return { archived: a.archived, pushedAt: typeof a.pushed_at === "string" ? a.pushed_at : null, checkedAt };
  }
  var repoKey = (r) => r.source.kind === "github-repo" ? `${r.source.owner}/${r.source.repo}`.toLowerCase() : "";
  async function lookAtRepos(records, options, now = /* @__PURE__ */ new Date()) {
    const due = records.filter((r) => repoStatusDue(r, now.getTime()));
    const answers = /* @__PURE__ */ new Map();
    for (const record of due) {
      const key = repoKey(record);
      if (answers.has(key) || record.source.kind !== "github-repo") continue;
      const url = `https://api.github.com/repos/${encodeURIComponent(record.source.owner)}/${encodeURIComponent(record.source.repo)}`;
      try {
        const text2 = await fetchSmallText(url, { ...options, freshest: false }, MAX_ANSWER_BYTES2);
        const status = text2 == null ? { archived: false, pushedAt: null, checkedAt: now.toISOString() } : parseRepoStatus(JSON.parse(text2), now.toISOString());
        if (status) answers.set(key, status);
      } catch {
        break;
      }
    }
    return due.flatMap((before) => {
      const repo = answers.get(repoKey(before));
      return repo ? [{ before, after: { ...before, repo }, fromInstall: true }] : [];
    });
  }

  // src/ui/dom.ts
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
  function help(text2) {
    return el("span", { class: "help", tabindex: "0", role: "img", "aria-label": text2, title: text2 }, "?");
  }
  function fold(folds, key, summary, ...body2) {
    const node = el("details", { class: `fold ${key}`, open: folds.has(key) }, el("summary", {}, ...summary), ...body2);
    node.addEventListener("toggle", () => {
      if (node.open) folds.add(key);
      else folds.delete(key);
    });
    return node;
  }
  var message = (m) => m ? el("div", { class: `msg ${m.kind}`, role: m.kind === "err" ? "alert" : "status" }, m.text) : null;
  var checkedOf = (e) => e.target.checked;
  var formatBytes = (n) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
  var formatDate = (iso) => iso ? new Date(iso).toLocaleString() : null;
  var shortHash2 = (hash) => `${hash.slice(0, 23)}…`;
  var textSize = (text2) => formatBytes(new TextEncoder().encode(text2).byteLength);
  function downloadText(filename, text2, type = "application/json") {
    const url = URL.createObjectURL(new Blob([text2], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3e4);
  }

  // src/ui/bundle.ts
  function catalogRow(rows, entry) {
    if (rows === null) return void 0;
    const tracked = rows.find((r) => r.extension && r.record && isCatalogSource(entry, r.record.source));
    if (tracked) return { row: tracked, ours: true };
    const named = rows.find((r) => r.extension && r.extension.name.trim().toLowerCase() === entry.name.toLowerCase());
    return named ? { row: named, ours: false } : null;
  }
  function catalogUpdates(rows) {
    return CATALOG.filter((entry) => {
      const found = catalogRow(rows, entry);
      const state = found?.ours ? found.row.record?.latest?.state : void 0;
      return state === "update" || state === "changed";
    }).length;
  }
  function bundleWindow(v) {
    const { s, t, act } = v;
    if (!s.bundleOpen) return null;
    const back = el(
      "div",
      { class: "pop-back", onClick: (e) => {
        if (e.target === back) act.setBundleOpen(false);
      } },
      el(
        "div",
        { class: "pop catalog", role: "dialog", "aria-modal": "true", "aria-label": t("bundle.title") },
        el(
          "div",
          { class: "pop-head" },
          el("h3", {}, t("bundle.title"), help(t("catalog.help"))),
          el("button", { class: "small", type: "button", "aria-label": t("close"), "data-focus": "bundle-close", onClick: () => act.setBundleOpen(false) }, "✕")
        ),
        el("ul", { class: "catalog-list" }, ...CATALOG.map((entry) => catalogItem(v, entry))),
        el("div", { class: "msg loud" }, t("catalog.fullPage")),
        el(
          "div",
          { class: "actions" },
          el("button", { class: "primary", type: "button", disabled: s.busy || !s.catalogPicked.size, onClick: () => void act.onCatalogInstall() }, t("catalog.install", { count: s.catalogPicked.size }))
        ),
        message(s.catalogMessage),
        ...s.catalogResults.map((m) => message(m)),
        otherLists(v)
      )
    );
    return back;
  }
  function otherLists(v) {
    const { s, t, act, i18n } = v;
    const box = el("input", { type: "text", class: "list-url", "aria-label": t("lists.add"), placeholder: "https://…/catalog.json", "data-focus": "list-url", autocomplete: "off", spellcheck: "false" });
    const add = () => {
      if (box.value.trim()) void act.onAddList(box.value);
    };
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        add();
      }
    });
    return el(
      "details",
      { class: "other-lists", open: s.lists.length > 0 },
      el("summary", {}, t("lists.heading"), help(t("help.lists"))),
      ...s.lists.map((list) => el(
        "div",
        { class: "other-list", "data-list": list.url },
        el(
          "div",
          { class: "row between" },
          el("span", {}, el("span", { class: "name" }, list.name), " ", el("span", { class: "muted" }, new URL(list.url).hostname)),
          el(
            "div",
            { class: "row" },
            el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.onRefreshList(list.url) }, t("lists.refresh")),
            el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.onRemoveList(list.url) }, t("organize.delete"))
          )
        ),
        el("ul", { class: "catalog-list" }, ...list.entries.map((entry) => el(
          "li",
          {},
          el(
            "div",
            { class: "row between" },
            el("span", { class: "name" }, entry.name),
            el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.previewEntry(entry) }, t("lists.preview"))
          ),
          el("div", { class: "line note" }, i18n.lang === "ko" ? entry.about.ko : entry.about.en),
          el("div", { class: "muted" }, entry.input)
        )))
      )),
      el("div", { class: "row", style: "margin-top:8px" }, box, el("button", { class: "small", type: "button", disabled: s.busy, onClick: add }, t("lists.add"))),
      message(s.listMessage)
    );
  }
  function catalogItem(v, entry) {
    const { s, t, act, i18n } = v;
    const box = el("input", { type: "checkbox", "data-focus": `catalog:${entry.name}`, disabled: s.busy, onChange: (e) => act.pickCatalog(entry.name, checkedOf(e)) });
    box.checked = s.catalogPicked.has(entry.name);
    const found = catalogRow(s.rows, entry);
    const ext = found?.row.extension ?? null;
    const willOff = s.catalogPicked.has(entry.name) && found?.ours && ext?.enabled ? el("div", { class: "line note" }, t(s.keepEnabled ? "catalog.staysOn" : "catalog.willOff")) : null;
    return el(
      "li",
      {},
      el("label", { class: "toggle" }, box, el("span", { class: "name" }, entry.name)),
      " ",
      catalogBadge(v, found),
      el("div", { class: "line note" }, i18n.lang === "ko" ? entry.about.ko : entry.about.en),
      willOff
    );
  }
  function catalogBadge({ t }, found) {
    if (found === void 0) return el("span", { class: "badge" }, t("catalog.unknown"));
    const ext = found?.row.extension;
    if (!found || !ext) return el("span", { class: "badge off" }, t("catalog.missing"));
    const state = ext.enabled ? "on" : ext.approvedHash === null ? "approve" : "off";
    const words = t(ext.enabled ? "badge.enabled" : ext.approvedHash === null ? "badge.needsApproval" : "badge.disabled");
    const version = ext.version ?? "";
    const latest = found.ours ? found.row.record?.latest : void 0;
    const update = latest && (latest.state === "update" || latest.state === "changed") ? el("span", { class: "badge approve" }, t("catalog.update", { version: latest.version ?? "?" })) : null;
    return fragment(el("span", { class: `badge ${state}` }, `${t(found.ours ? "catalog.installed" : "catalog.installedElsewhere", { version }).replace(/\s+/g, " ").trim()} · ${words}`), update);
  }

  // src/ui/options.ts
  function optionsFold(v) {
    const { s, t, act } = v;
    return fold(
      s.folds,
      "prefs",
      [t("prefs.heading")],
      el(
        "div",
        { class: "actions" },
        el("label", { class: "toggle" }, el("input", { type: "checkbox", "data-focus": "auto-check", checked: s.autoCheck, onChange: (e) => act.setAutoCheck(checkedOf(e)) }), t("action.autoCheck"), help(t("help.autoCheck"))),
        el("label", { class: "toggle" }, el("input", { type: "checkbox", "data-focus": "notify", checked: s.notify, onChange: (e) => act.setNotify(checkedOf(e)) }), t("option.notify"), help(t("help.notify"))),
        el("label", { class: "toggle" }, el("input", {
          type: "checkbox",
          class: "keep-enabled",
          "data-focus": "keep-enabled",
          checked: s.keepEnabled,
          disabled: s.busy,
          onChange: (e) => {
            if (!checkedOf(e)) {
              act.setKeepEnabled(false);
              return;
            }
            act.set({ keepFor: { code: false } });
          }
        }), t("option.keepEnabled"), help(t("help.keepEnabled"))),
        el("button", { class: "small", type: "button", disabled: s.records.length === 0, onClick: () => act.set({ transfer: { kind: "export", text: exportSources(s.records) } }) }, t("action.export")),
        el("button", { class: "small", type: "button", onClick: () => act.set({ transfer: { kind: "import", text: "" } }) }, t("action.import")),
        help(t("help.transfer")),
        el("button", { class: "small", type: "button", "data-focus": "diagnostics", disabled: s.busy, onClick: act.copyDiagnostics }, t("action.diagnostics")),
        help(t("help.diagnostics")),
        el("button", { class: "small", type: "button", "data-focus": "storage-open", onClick: act.openStorage }, t("storage.open")),
        el("button", { class: "small", type: "button", "data-focus": "backup-open", onClick: () => act.openTools("backup") }, t("backup.title")),
        // both switch extensions off: not without knowing which one is Fetchy
        el("button", { class: "small", type: "button", "data-focus": "profiles-open", disabled: !v.host.extensionId, onClick: () => act.openTools("profiles") }, t("profiles.title")),
        el("button", { class: "small", type: "button", "data-focus": "bisect-open", disabled: !!s.bisect || !v.host.extensionId, onClick: () => act.openTools("bisect") }, t("bisect.title")),
        el("button", { class: "small", type: "button", "data-focus": "wizard-again", onClick: act.openWizard }, t("wizard.again")),
        el("span", { class: "muted" }, t("anchor.hint"))
      ),
      keepConfirm(v),
      transferBlock(v),
      organizeBlock(v),
      logBlock(v)
    );
  }
  function keepConfirm({ s, t, act, render }) {
    const keepFor = s.keepFor;
    if (!keepFor) return null;
    return el(
      "div",
      { class: "msg loud keep-confirm" },
      el("div", {}, t("keep.confirm.title")),
      el("p", { class: "line", style: "font-weight:400" }, t("keep.confirm.body")),
      el("label", { class: "toggle", style: "white-space:normal;color:inherit" }, el("input", { type: "checkbox", class: "ack-code", onChange: (e) => {
        if (s.keepFor) s.keepFor.code = checkedOf(e);
        render();
      } }), t("auto.ack.code")),
      el(
        "div",
        { class: "actions" },
        el("button", { class: "small primary", type: "button", disabled: !keepFor.code, onClick: () => act.setKeepEnabled(true) }, t("auto.confirm.on")),
        el("button", { class: "small", type: "button", onClick: () => act.set({ keepFor: null }) }, t("action.cancel"))
      )
    );
  }
  function transferBlock({ s, t, act }) {
    const transfer = s.transfer;
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
            act.copy(area2.value);
          } }, t("action.copy")),
          el("button", { class: "small", type: "button", onClick: () => act.set({ transfer: null }) }, t("close"))
        )
      );
    }
    const area = el("textarea", { placeholder: '{ "kind": "me-fetchy.sources", … }', "aria-label": t("action.import") }, transfer.text);
    area.addEventListener("input", () => {
      if (s.transfer?.kind === "import") s.transfer.text = area.value;
    });
    return el(
      "div",
      { class: "transfer" },
      area,
      el(
        "div",
        { class: "row" },
        el("button", { class: "small primary", type: "button", disabled: s.busy, onClick: () => act.onImport(area.value) }, t("action.apply")),
        el("button", { class: "small", type: "button", onClick: () => act.set({ transfer: null }) }, t("action.cancel"))
      )
    );
  }
  function organizeBlock({ s, t, act }) {
    const editor = (kind) => {
      const newLabel = t(kind === "folders" ? "organize.newFolder" : "organize.newTag");
      const box = el("input", { type: "text", "data-focus": `org-new:${kind}`, placeholder: newLabel, "aria-label": newLabel });
      const add = () => {
        if (box.value.trim()) act.reorganize(kind === "folders" ? addFolder(s.organize, box.value) : addTag(s.organize, box.value));
      };
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          add();
        }
      });
      return el(
        "div",
        {},
        el("div", { class: "muted" }, t(kind === "folders" ? "organize.folders" : "organize.tags")),
        el(
          "ul",
          { class: "org-list" },
          ...s.organize[kind].map((x) => {
            const name = el("input", { type: "text", value: x.name, "aria-label": x.name, "data-focus": `org:${x.id}` });
            name.addEventListener("change", () => act.reorganize(rename(s.organize, kind, x.id, name.value)));
            return el("li", {}, name, el("button", { class: "small", type: "button", onClick: () => act.reorganize(remove(s.organize, kind, x.id)) }, t("organize.delete")));
          }),
          el("li", {}, box, el("button", { class: "small", type: "button", onClick: add }, t("organize.add")))
        )
      );
    };
    return fold(s.folds, "organize", [t("organize.heading")], editor("folders"), editor("tags"));
  }
  function logBlock({ s, t, act }) {
    const fmt = (e) => `${new Date(e.at).toLocaleString()} · ${e.action} · ${e.result} · ${e.name}` + (e.from || e.to ? ` · v${e.from?.version ?? "-"} → v${e.to?.version ?? "-"}` : "") + (e.detail ? ` · ${e.detail}` : "");
    const empty = s.logEntries.length === 0;
    return fold(
      s.folds,
      "log",
      [t("log.heading"), help(t("help.log"))],
      el(
        "div",
        { class: "actions" },
        el("button", { class: "small", type: "button", disabled: empty, onClick: () => act.copy(AuditLog.format(s.logEntries)) }, t("log.export")),
        el("button", { class: "small", type: "button", disabled: empty, onClick: act.clearLog }, t("log.clear"))
      ),
      empty ? el("p", { class: "muted" }, t("log.empty")) : el("ul", { class: "log" }, ...s.logEntries.map((e) => el("li", { class: e.result }, fmt(e))))
    );
  }

  // src/ui/wizard.ts
  var WIZARD_STEPS = ["status", "pick", "options", "install", "approve"];
  function wizardWindow(v) {
    const { s, t, act } = v;
    if (!s.wizard) return null;
    const step = s.wizard.step;
    const name = WIZARD_STEPS[step] ?? "status";
    const last = step === WIZARD_STEPS.length - 1;
    const back = el(
      "div",
      { class: "pop-back", onClick: (e) => {
        if (e.target === back) act.closeWizard();
      } },
      el(
        "div",
        { class: `pop wizard step-${name}`, role: "dialog", "aria-modal": "true", "aria-label": t("wizard.title") },
        el(
          "div",
          { class: "pop-head" },
          el("h3", {}, t("wizard.title"), " ", el("span", { class: "muted" }, t("wizard.stepOf", { step: step + 1, total: WIZARD_STEPS.length, name: t(`wizard.${name}.heading`) }))),
          el("button", { class: "small", type: "button", "data-focus": "wizard-skip", onClick: act.closeWizard }, t("wizard.skip"))
        ),
        body(v, name),
        el(
          "div",
          { class: "actions wizard-nav" },
          step > 0 ? el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.wizardStep(step - 1) }, t("wizard.back")) : null,
          last ? el("button", { class: "small primary", type: "button", "data-focus": "wizard-finish", disabled: s.busy, onClick: act.closeWizard }, t("wizard.finish")) : el("button", { class: "small primary", type: "button", "data-focus": "wizard-next", disabled: s.busy, onClick: () => act.wizardStep(step + 1) }, t("wizard.next"))
        )
      )
    );
    return back;
  }
  function body(v, name) {
    switch (name) {
      case "status":
        return statusStep(v);
      case "pick":
        return pickStep(v);
      case "options":
        return optionsStep(v);
      case "install":
        return installStep(v);
      case "approve":
        return approveStep(v);
    }
  }
  var check = (ok, text2, fix, optional = false) => {
    const state = ok === null ? "unknown" : ok ? "ok" : optional ? "info" : "bad";
    const mark = { unknown: "?", ok: "✓", info: "–", bad: "✗" }[state];
    return el(
      "li",
      { class: state },
      el("span", { class: "mark", "aria-hidden": "true" }, mark),
      " ",
      text2,
      !ok && fix ? el("div", { class: "note" }, fix) : null
    );
  };
  function statusStep({ s, t }) {
    const p = s.policy;
    const admin = s.rowsErrorCode === "privileged" ? false : s.rows ? true : null;
    return el(
      "div",
      {},
      el("p", { class: "note" }, t("wizard.status.intro")),
      el(
        "ul",
        { class: "wizard-checks" },
        check(p ? p.externalExtensionsEnvEnabled : null, t("wizard.status.env"), t("gate.env")),
        check(p ? p.externalExtensionsEnabled : null, t("wizard.status.switch"), t("gate.switch")),
        check(admin, t("wizard.status.admin"), t("wizard.status.adminFix")),
        check(p ? p.serverSandboxAvailable : null, t("wizard.status.sandbox"), t("wizard.status.sandboxNote"), true)
      ),
      s.policyError ? el("p", { class: "msg warn" }, t("gate.unknown", { error: s.policyError })) : null
    );
  }
  function pickStep(v) {
    const { t } = v;
    return el(
      "div",
      {},
      el("p", { class: "note" }, t("wizard.pick.intro")),
      el("ul", { class: "catalog-list" }, ...CATALOG.map((entry) => catalogItem(v, entry))),
      el("div", { class: "msg loud" }, t("catalog.fullPage"))
    );
  }
  function optionsStep(v) {
    const { s, t, act } = v;
    return el(
      "div",
      {},
      el(
        "div",
        { class: "wizard-options" },
        el("label", { class: "toggle" }, el("input", { type: "checkbox", "data-focus": "wizard-auto-check", checked: s.autoCheck, onChange: (e) => act.setAutoCheck(checkedOf(e)) }), t("action.autoCheck"), help(t("help.autoCheck"))),
        el("label", { class: "toggle" }, el("input", { type: "checkbox", "data-focus": "wizard-notify", checked: s.notify, onChange: (e) => act.setNotify(checkedOf(e)) }), t("option.notify"), help(t("help.notify"))),
        el("label", { class: "toggle" }, el("input", {
          type: "checkbox",
          class: "keep-enabled",
          "data-focus": "wizard-keep",
          checked: s.keepEnabled,
          disabled: s.busy,
          onChange: (e) => {
            if (!checkedOf(e)) {
              act.setKeepEnabled(false);
              return;
            }
            act.set({ keepFor: { code: false } });
          }
        }), t("option.keepEnabled"), help(t("help.keepEnabled")))
      ),
      keepConfirm(v)
    );
  }
  function installStep(v) {
    const { s, t, act } = v;
    const count = s.catalogPicked.size;
    return el(
      "div",
      {},
      count ? el("div", { class: "actions" }, el("button", { class: "primary", type: "button", disabled: s.busy, onClick: () => void act.onCatalogInstall() }, t("catalog.install", { count }))) : el("p", { class: "note" }, t("wizard.install.none")),
      message(s.catalogMessage),
      ...s.catalogResults.map((m) => message(m))
    );
  }
  function approveStep({ s, t, act }) {
    const items = CATALOG.flatMap((entry) => {
      const ext = catalogRow(s.rows, entry)?.row.extension;
      if (!ext) return [];
      const state = ext.enabled ? t("badge.enabled") : ext.approvedHash === null ? t("badge.needsApproval") : t("badge.disabled");
      return [el(
        "li",
        { class: ext.enabled ? "ok" : "wait" },
        el("span", { class: "name" }, ext.name),
        " ",
        el("span", { class: `badge ${ext.enabled ? "on" : "approve"}` }, state),
        ext.enabled ? null : el("div", { class: "line" }, el("code", { class: "hash" }, ext.contentHash))
      )];
    });
    return el(
      "div",
      {},
      el("p", { class: "note" }, t("wizard.approve.how")),
      items.length ? el("ul", { class: "catalog-list wizard-approve" }, ...items) : el("p", { class: "muted" }, t("wizard.approve.none")),
      el("div", { class: "actions" }, el("button", { class: "small", type: "button", disabled: s.busy, onClick: act.onRefresh }, t("wizard.approve.recheck")))
    );
  }

  // src/ui/actions.ts
  function createActions(core) {
    const { s, host, store, deps, audit, t, render, guard } = core;
    async function loadPolicy() {
      try {
        s.policy = await deps.client.policy();
        s.policyError = null;
      } catch (e) {
        s.policy = null;
        s.policyError = describeError(e, t);
      }
    }
    async function loadRecords() {
      try {
        s.records = await store.load();
      } catch (e) {
        s.records = [];
        s.sourcesMessage = { kind: "err", text: describeError(e, t) };
      }
    }
    async function reconcileRecords() {
      try {
        const changed = await reconcile(deps);
        if (changed.some((r) => !r.lastError)) s.reconcileMessage = { kind: "ok", text: t("log.reconciled", { count: changed.filter((r) => !r.lastError).length }) };
        if (changed.length) s.records = await store.load();
      } catch {
      }
    }
    async function loadLog() {
      try {
        s.logEntries = await audit.list();
      } catch {
        s.logEntries = [];
      }
    }
    async function loadRows() {
      try {
        s.rows = await overview(deps);
        s.rowsError = null;
        s.rowsErrorCode = null;
      } catch (e) {
        s.rows = null;
        s.rowsError = describeError(e, t);
        s.rowsErrorCode = e instanceof EngineApiError ? e.code : null;
      }
    }
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
    const updateLines = (results) => results.map(({ record, result }) => t("result.updatedAllOne", { name: record.name, text: result instanceof Error ? describeError(result, t, { name: record.name }) : resultMessage(result).text }));
    const forSources = (name, fn) => guard(async () => {
      s.sourcesMessage = null;
      try {
        await fn();
      } catch (e) {
        s.sourcesMessage = { kind: "err", text: describeError(e, t, { name }) };
      }
    });
    const onFetch = () => guard(async () => {
      s.prepared = null;
      s.pendingExistingId = null;
      s.installMessage = null;
      try {
        s.prepared = await prepare(s.urlInput, deps, { extensionId: s.linking?.id ?? null });
      } catch (e) {
        s.installMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const onInstall = (mode) => guard(async () => {
      if (!s.prepared) return;
      const name = s.prepared.draft.name;
      try {
        const result = await install(s.prepared, { ...deps, approveNow: s.keepEnabled }, mode);
        s.installMessage = resultMessage(result);
        s.prepared = null;
        s.pendingExistingId = null;
        s.linking = null;
        s.urlInput = "";
        if (result.self) {
          s.retired = true;
          return;
        }
        await afterChange();
      } catch (e) {
        if (e instanceof EngineApiError && e.code === "name-exists" && e.existingId) {
          s.pendingExistingId = e.existingId;
          s.installMessage = { kind: "warn", text: t("result.nameExists", { name }) };
        } else {
          s.installMessage = { kind: "err", text: describeError(e, t, { name }) };
        }
      }
    });
    const cancelPreview = () => {
      s.prepared = null;
      s.pendingExistingId = null;
      s.installMessage = null;
      render();
    };
    const startLink = (extension) => {
      s.linking = extension;
      s.prepared = null;
      s.pendingExistingId = null;
      s.installMessage = null;
      s.urlInput = "";
      render();
      core.panel.querySelector("input.url")?.focus();
    };
    const stopLink = () => {
      s.linking = null;
      s.prepared = null;
      render();
    };
    const reinstall = (record) => {
      s.urlInput = record.input;
      s.prepared = null;
      render();
      void onFetch();
    };
    const catalogLine = (o) => o.status === "done" ? resultMessage(o.result) : o.status === "skipped" ? { kind: o.reason === "current" ? "ok" : "warn", text: t(`catalog.skipped.${o.reason}`, { name: o.entry.name, input: o.entry.input }) } : o.status === "stopped" ? { kind: "warn", text: t("catalog.stopped", { name: o.entry.name }) } : { kind: "err", text: t("catalog.failed", { name: o.entry.name, error: describeError(o.error, t, { name: o.entry.name }) }) };
    const onCatalogInstall = () => guard(async () => {
      const chosen = CATALOG.filter((e) => s.catalogPicked.has(e.name));
      if (!chosen.length) return;
      s.catalogResults = [];
      s.catalogRunning = true;
      let outcomes;
      try {
        outcomes = await installCatalog(chosen, { ...deps, approveNow: s.keepEnabled }, (done, total, entry) => {
          s.catalogMessage = { kind: "info", text: t("catalog.progress", { name: entry.name, done: done + 1, total }) };
          render();
        });
      } finally {
        s.catalogRunning = false;
      }
      s.catalogResults = outcomes.map(catalogLine);
      const ok = outcomes.filter((o) => o.status === "done" || o.status === "skipped" && o.reason === "current").length;
      s.catalogMessage = { kind: ok === outcomes.length ? "ok" : "warn", text: t("catalog.done", { ok, total: outcomes.length }) };
      if (outcomes.some((o) => o.status === "done" && o.result.codeChanged)) s.catalogResults.push({ kind: "info", text: t("catalog.reload") });
      s.catalogPicked.clear();
      for (const o of outcomes) if (o.status === "failed" || o.status === "stopped") s.catalogPicked.add(o.entry.name);
      if (s.prepared && chosen.some((e) => e.name.toLowerCase() === s.prepared?.draft.name.trim().toLowerCase())) {
        s.prepared = null;
        s.pendingExistingId = null;
      }
      await afterChange();
    });
    const pickCatalog = (name, on) => {
      if (on) s.catalogPicked.add(name);
      else s.catalogPicked.delete(name);
      render();
    };
    const setBundleOpen = (open) => {
      s.bundleOpen = open;
      render();
    };
    async function checkCatalogQuietly() {
      const stale = (r) => !r.lastCheckedAt || Date.now() - Date.parse(r.lastCheckedAt) > 6 * 36e5;
      const due = s.records.filter((r) => CATALOG.some((e) => isCatalogSource(e, r.source)) && stale(r));
      if (!due.length || s.busy) return;
      try {
        const changes = [];
        for (const record of due) changes.push({ before: record, after: await checkSource(record, deps), fromInstall: true });
        s.records = await store.commit(changes);
        await loadRows();
      } catch {
      }
    }
    const checkRecords = (due) => guard(async () => {
      s.sourcesMessage = null;
      try {
        s.records = await checkAll(deps, {
          due,
          onProgress: (done, total) => {
            s.sourcesMessage = { kind: "ok", text: t("result.checking", { done, total }) };
            render();
          }
        });
        s.sourcesMessage = { kind: "ok", text: t("result.checked", { count: s.records.length }) };
        await loadRows();
      } catch (e) {
        s.sourcesMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const onCheckAll = () => checkRecords();
    const onCheckOne = (record) => guard(async () => {
      s.sourcesMessage = null;
      const checked = await checkSource(record, deps);
      try {
        s.records = await store.commit([{ before: record, after: checked, fromInstall: true }]);
        await loadRows();
      } catch (e) {
        s.sourcesMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const onUpdate = (record) => forSources(record.name, async () => {
      const result = await updateSource(record, { ...deps, approveNow: s.keepEnabled });
      s.sourcesMessage = resultMessage(result);
      if (result.self) {
        s.retired = true;
        return;
      }
      await afterChange();
    });
    const onAutoApprove = (record, value) => guard(async () => {
      s.autoFor = null;
      s.sourcesMessage = null;
      try {
        await setAutoApprove(record, value, deps);
        s.sourcesMessage = { kind: "ok", text: t(value ? "auto.on" : "auto.off", { name: record.name }) };
        await afterChange();
      } catch (e) {
        s.sourcesMessage = { kind: "err", text: describeError(e, t, { name: record.name }) };
      }
    });
    const onAutoUpdate = (record, value) => forSources(record.name, async () => {
      await setAutoUpdate(record, value, deps);
      await afterChange();
    });
    const onRevisions = (extension) => forSources(extension.name, async () => {
      s.revisionsFor = { id: extension.id, list: extension.revisions ?? (await deps.client.list()).find((x) => x.id === extension.id)?.revisions ?? [] };
    });
    const onRollback = (extension, record, revision) => guard(async () => {
      s.sourcesMessage = null;
      s.revisionsFor = null;
      try {
        if (record) {
          const result = await rollbackSource(record, revision.contentHash, deps);
          const text2 = t("result.rolledBack", { name: result.extension.name, hash: result.extension.contentHash });
          s.sourcesMessage = { kind: "ok", text: result.autoUpdateOff ? `${text2}
${t("result.rolledBack.autoOff")}` : text2 };
        } else {
          const result = await deps.client.rollback(extension.id, revision.contentHash);
          s.sourcesMessage = { kind: "ok", text: t("result.rolledBack", { name: result.name, hash: result.contentHash }) };
        }
        await afterChange();
      } catch (e) {
        s.sourcesMessage = { kind: "err", text: describeError(e, t, { name: extension.name }) };
      }
    });
    const onDisable = (extension) => forSources(extension.name, async () => {
      await disableExtension(extension, deps);
      s.sourcesMessage = { kind: "ok", text: t("result.disabled", { name: extension.name }) };
      await afterChange();
    });
    const onEnable = (extension, acknowledged) => forSources(extension.name, async () => {
      s.enableFor = null;
      try {
        await enableExtension(extension, deps, acknowledged);
        s.sourcesMessage = { kind: "ok", text: t("result.enabled", { name: extension.name }) };
      } finally {
        await afterChange();
      }
    });
    const onDelete = (extension) => guard(async () => {
      s.deleting = null;
      s.sourcesMessage = null;
      try {
        await deleteExtension(extension, deps);
        s.sourcesMessage = { kind: "ok", text: t("result.deleted", { name: extension.name }) };
        await afterChange();
      } catch (e) {
        s.sourcesMessage = { kind: "err", text: describeError(e, t, { name: extension.name }) };
      }
    });
    const onForget = (record, deleteFromEngine) => forSources(record.name, async () => {
      s.deleting = null;
      await forgetSource(record, deps, deleteFromEngine);
      s.sourcesMessage = { kind: "ok", text: t(deleteFromEngine ? "result.deleted" : "result.forgotten", { name: record.name }) };
      await afterChange();
    });
    const onRefresh = () => guard(async () => {
      s.sourcesMessage = null;
      await afterChange();
    });
    const onUpdateAll = () => guard(async () => {
      s.sourcesMessage = null;
      const results = await updateAll(deps, {
        keepEnabled: s.keepEnabled,
        onProgress: (done, total) => {
          s.sourcesMessage = { kind: "ok", text: t("result.checking", { done, total }) };
          render();
        }
      });
      if (results.length === 0) {
        s.sourcesMessage = { kind: "warn", text: t("result.nothingToUpdate") };
        return;
      }
      const lines = updateLines(results);
      const ok = results.filter((r) => !(r.result instanceof Error)).length;
      const selfDone = results.some((r) => !(r.result instanceof Error) && r.result.self);
      s.sourcesMessage = { kind: ok === results.length ? "ok" : "warn", text: [t("result.updatedAll", { ok, total: results.length }), ...lines].join("\n") };
      if (selfDone) {
        s.retired = true;
        return;
      }
      await afterChange();
    });
    const runAutoUpdates = (check2) => guard(async () => {
      if (!s.records.some((r) => r.autoUpdate) || s.bisect) return;
      const results = await autoUpdate({ ...deps, approveNow: s.keepEnabled }, { check: check2 });
      await host.storage.patch({ autoUpdatedAt: (/* @__PURE__ */ new Date()).toISOString() }).catch(() => {
      });
      if (!results.length) {
        s.records = await store.load();
        return;
      }
      const ok = results.filter((r) => !(r.result instanceof Error)).length;
      const lines = updateLines(results);
      s.sourcesMessage = { kind: ok === results.length ? "ok" : "warn", text: [t("autoUpdate.done", { ok, total: results.length }), ...lines].join("\n") };
      await afterChange();
    });
    const importSummary = (result) => {
      const r = { ...result };
      return [
        t("result.imported", r),
        r.kept ? t("result.importKept", r) : "",
        r.different ? t("result.importDifferent", r) : "",
        r.ignored ? t("result.importIgnored", r) : ""
      ].filter(Boolean).join(" ");
    };
    const onImport = (text2) => guard(async () => {
      s.sourcesMessage = null;
      try {
        const result = await importSources(text2, store);
        s.sourcesMessage = { kind: result.different || result.ignored ? "warn" : "ok", text: importSummary(result) };
        s.transfer = null;
        await afterChange();
      } catch (e) {
        s.sourcesMessage = { kind: "err", text: e instanceof SyntaxError ? t("error.import.invalid") : describeError(e, t) };
      }
    });
    const copy = (text2, done = t("result.copied")) => {
      const copied = () => {
        s.copyBox = null;
        s.sourcesMessage = { kind: "ok", text: done };
        render();
      };
      const byHand = () => {
        s.copyBox = { text: text2 };
        render();
      };
      const legacy = () => {
        const area = document.createElement("textarea");
        area.value = text2;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
        core.panel.append(area);
        area.select();
        let ok = false;
        try {
          ok = typeof document.execCommand === "function" && document.execCommand("copy");
        } catch {
          ok = false;
        }
        area.remove();
        if (ok) copied();
        else byHand();
      };
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text2).then(copied, legacy);
      else legacy();
    };
    const clearLog = () => guard(async () => {
      await audit.clear();
      await loadLog();
    });
    const setKeepEnabled = (value) => {
      s.keepEnabled = value;
      s.keepFor = null;
      void host.storage.patch({ keepEnabled: s.keepEnabled }).catch(() => {
      });
      render();
    };
    const setAutoCheck = (value) => {
      s.autoCheck = value;
      void host.storage.patch({ autoCheck: s.autoCheck }).catch(() => {
      });
      render();
    };
    const reorganize = (next) => {
      s.organize = next;
      if (s.tagFilter && !s.organize.tags.some((x) => x.id === s.tagFilter)) s.tagFilter = null;
      void host.storage.patch({ organize: s.organize }).catch(() => {
      });
      render();
    };
    const switchLang = () => {
      core.i18n.lang = core.i18n.lang === "ko" ? "en" : "ko";
      void host.storage.patch({ lang: core.i18n.lang }).catch(() => {
      });
      render();
    };
    const set = (patch) => {
      Object.assign(s, patch);
      render();
    };
    const st = s.storage;
    const extensionsInList = () => (s.rows ?? []).flatMap((r) => r.extension ? [r.extension] : []);
    const findExtension = (id) => extensionsInList().find((x) => x.id === id) ?? null;
    const noteSize = (id, m) => {
      st.measured.set(id, m);
      if (m.status === "ok") s.storageBytes.set(id, m.bytes);
      else s.storageBytes.delete(id);
    };
    async function measureStorage() {
      if (st.measuring) return;
      st.measuring = true;
      render();
      try {
        if (!s.rows) await loadRows();
        await measureAll(extensionsInList(), deps.client, (x, m) => {
          noteSize(x.id, m);
          render();
        });
        st.browser = await browserStorage();
      } finally {
        st.measuring = false;
        render();
      }
    }
    const openStorage = () => {
      st.open = true;
      st.message = null;
      st.restore = null;
      st.clear = null;
      render();
      void measureStorage();
    };
    const closeStorage = () => {
      st.open = false;
      st.restore = null;
      st.clear = null;
      render();
    };
    async function saveBackup(x, suffix = "") {
      const value = await deps.client.readStorage(x.id);
      const text2 = JSON.stringify(storageBackup(x, value), null, 2);
      downloadText(backupFileName(`${x.name}${suffix}`), text2);
      const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      return { value, bytes };
    }
    const onBackup = (x) => guard(async () => {
      st.message = null;
      try {
        await saveBackup(x);
        st.message = { kind: "ok", text: t("storage.backedUp", { name: x.name }) };
      } catch (e) {
        st.message = { kind: "err", text: describeError(e, t, { name: x.name }) };
      }
    });
    const onRestoreFile = (x, text2) => {
      st.message = null;
      st.clear = null;
      try {
        st.restore = { id: x.id, plan: planRestore(text2, x) };
      } catch (e) {
        st.restore = null;
        st.message = { kind: "err", text: e instanceof BackupFileError ? t(`storage.file.${e.reason}`, { name: x.name }) : describeError(e, t) };
      }
      render();
    };
    const onRestore = (x) => guard(async () => {
      const plan = st.restore?.id === x.id ? st.restore.plan : null;
      if (!plan) return;
      st.message = null;
      try {
        await saveBackup(x, "-before-restore");
      } catch (e) {
        st.message = { kind: "err", text: t("storage.restore.noBackup", { error: describeError(e, t, { name: x.name }) }) };
        return;
      }
      try {
        await restoreStorage(x, plan, { client: deps.client, audit, selfId: host.extensionId });
        st.restore = null;
        st.reload = true;
        st.message = { kind: "ok", text: t("storage.restored", { name: x.name }) };
      } catch (e) {
        st.message = { kind: "err", text: t("storage.restore.failed", { name: x.name, error: describeError(e, t, { name: x.name }) }) };
      }
      noteSize(x.id, (await measureAll([x], deps.client)).get(x.id) ?? { status: "off" });
    });
    const startClear = (x) => {
      st.message = null;
      st.restore = null;
      st.clear = { id: x.id, step: 1, typed: "" };
      render();
    };
    const onClearBackup = (x) => guard(async () => {
      try {
        await saveBackup(x, "-before-clear");
        if (st.clear?.id === x.id) st.clear = { ...st.clear, step: 2 };
      } catch (e) {
        st.message = { kind: "err", text: describeError(e, t, { name: x.name }) };
      }
    });
    const onClear = (x) => guard(async () => {
      if (st.clear?.id !== x.id || st.clear.step !== 2 || st.clear.typed.trim() !== x.name.trim()) return;
      const before = st.measured.get(x.id);
      try {
        await clearStorage(x, before?.status === "ok" ? before.bytes : 0, { client: deps.client, audit, selfId: host.extensionId });
        st.clear = null;
        st.reload = true;
        st.message = { kind: "ok", text: t("storage.cleared", { name: x.name }) };
      } catch (e) {
        st.message = { kind: "err", text: describeError(e, t, { name: x.name }) };
      }
      noteSize(x.id, (await measureAll([x], deps.client)).get(x.id) ?? { status: "off" });
    });
    const cancelStorageQuestion = () => {
      st.restore = null;
      st.clear = null;
      render();
    };
    const reloadPage = () => {
      try {
        location.reload();
      } catch {
      }
    };
    const openTools = (which) => {
      s.tools = which;
      s.toolsMessage = null;
      s.toolsReload = false;
      s.profilePlan = null;
      s.bisectAck = false;
      render();
      void loadRows().then(() => {
        if (which === "backup") s.backupPicked = new Set(backupCandidates().filter((x) => CATALOG.some((e) => e.name.toLowerCase() === x.name.trim().toLowerCase())).map((x) => x.id));
        render();
      });
    };
    const backupCandidates = () => extensionsInList().filter((x) => measurable(x) && x.id !== host.extensionId);
    const pickBackup = (id, on) => {
      if (on) s.backupPicked.add(id);
      else s.backupPicked.delete(id);
      render();
    };
    const onFullBackup = () => guard(async () => {
      s.toolsMessage = null;
      const data = /* @__PURE__ */ new Map();
      const failed = [];
      for (const x of backupCandidates().filter((c) => s.backupPicked.has(c.id))) {
        try {
          data.set(x.name, await deps.client.readStorage(x.id));
        } catch {
          failed.push(x.name);
        }
      }
      downloadText(fullBackupFileName(), JSON.stringify(fullBackup(await store.load(), s.organize, data), null, 2));
      s.toolsMessage = { kind: failed.length ? "warn" : "ok", text: [t("backup.saved", { count: data.size }), failed.length ? t("backup.unread", { names: failed.join(", ") }) : ""].filter(Boolean).join("\n") };
    });
    const onFullRestore = (text2) => guard(async () => {
      s.toolsMessage = null;
      const extra = readFullBackup(text2);
      if (!extra) {
        s.toolsMessage = { kind: "err", text: t("backup.notOne") };
        return;
      }
      try {
        const result = await importSources(text2, store);
        const organize = mergeOrganize(s.organize, extra.organize);
        if (organize !== s.organize) reorganize(organize);
        s.toolsMessage = { kind: "ok", text: [
          importSummary(result),
          extra.storageNames.length ? t("backup.dataLater", { names: extra.storageNames.join(", ") }) : ""
        ].filter(Boolean).join("\n") };
        await afterChange();
      } catch (e) {
        s.toolsMessage = { kind: "err", text: e instanceof SyntaxError ? t("backup.notOne") : describeError(e, t) };
      }
    });
    const closeTools = () => {
      s.tools = null;
      s.profilePlan = null;
      render();
    };
    const nameOf2 = (id) => s.rows?.find((r) => r.extension?.id === id)?.extension?.name ?? id;
    const saveProfiles = () => host.storage.patch({ profiles: s.profiles }).catch(() => {
    });
    const saveBisect = () => host.storage.patch({ bisect: s.bisect }).catch(() => {
    });
    function switchMessage(result, extra = []) {
      const lines = [
        result.switchedOff.length ? t("switch.off", { names: result.switchedOff.join(", ") }) : "",
        result.switchedOn.length ? t("switch.on", { names: result.switchedOn.join(", ") }) : "",
        ...result.failed.map((f) => t("switch.failed", { name: f.name, error: describeError(f.error, t, { name: f.name }) })),
        ...extra
      ].filter(Boolean);
      s.toolsReload = result.switchedOff.length + result.switchedOn.length > 0;
      return { kind: result.failed.length ? "warn" : "ok", text: lines.join("\n") || t("switch.nothing") };
    }
    const onSaveProfile = (name) => guard(async () => {
      s.toolsMessage = null;
      try {
        const on = switchedOn(await deps.client.list(), host.extensionId);
        const next = saveProfile(s.profiles, name, on);
        if (!next) {
          s.toolsMessage = { kind: "warn", text: t("profiles.full", { count: 20 }) };
          return;
        }
        s.profiles = next;
        await saveProfiles();
        s.toolsMessage = { kind: "ok", text: t("profiles.saved", { name: name.trim(), count: on.length }) };
      } catch (e) {
        s.toolsMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const onDeleteProfile = (id) => {
      s.profiles = s.profiles.filter((p) => p.id !== id);
      if (s.profilePlan?.id === id) s.profilePlan = null;
      void saveProfiles();
      render();
    };
    const onPlanProfile = (id) => guard(async () => {
      const profile = s.profiles.find((p) => p.id === id);
      if (!profile) return;
      s.toolsMessage = null;
      try {
        s.profilePlan = { id, plan: planSwitch(profile.ids, await deps.client.list(), host.extensionId), ack: false };
      } catch (e) {
        s.toolsMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const onApplyProfile = () => guard(async () => {
      const p = s.profilePlan;
      if (!p || p.plan.fullPage && !p.ack) return;
      s.profilePlan = null;
      try {
        const result = await applySwitch(p.plan, { client: deps.client, audit }, p.ack);
        const skipped = [
          p.plan.needsApproval.length ? t("switch.needsApproval", { names: p.plan.needsApproval.map((x) => x.name).join(", ") }) : "",
          p.plan.missing.length ? t("switch.missing", { count: p.plan.missing.length }) : ""
        ];
        s.toolsMessage = switchMessage(result, skipped);
      } catch (e) {
        s.toolsMessage = { kind: "err", text: describeError(e, t) };
      }
      await loadRows();
    });
    async function bisectSwitch(b, extra = []) {
      const plan = planSwitch(bisectWanted(b), await deps.client.list(), host.extensionId);
      const result = await applySwitch(plan, { client: deps.client, audit }, b.acknowledged);
      const skipped = plan.needsApproval.length ? [t("switch.needsApproval", { names: plan.needsApproval.map((x) => x.name).join(", ") })] : [];
      s.toolsMessage = switchMessage(result, [...skipped, ...extra]);
      await loadRows();
    }
    const onStartBisect = () => guard(async () => {
      s.toolsMessage = null;
      try {
        const list = await deps.client.list();
        const on = switchedOn(list, host.extensionId);
        const fullPage = list.some((x) => on.includes(x.id) && x.capabilities.includes("full_page_access"));
        if (fullPage && !s.bisectAck) return;
        const b = startBisect(on, s.bisectAck);
        if (!b) {
          s.toolsMessage = { kind: "warn", text: t("bisect.none") };
          return;
        }
        await bisectSwitch(b, [t("bisect.reloadThenAnswer")]);
        s.bisect = b;
        await saveBisect();
        s.tools = null;
      } catch (e) {
        s.toolsMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const onBisectAnswer = (stillThere) => guard(async () => {
      if (!s.bisect || s.bisect.found !== void 0) return;
      const next = answerBisect(s.bisect, stillThere);
      try {
        if (next.found === void 0) await bisectSwitch(next, [t("bisect.reloadThenAnswer")]);
        else s.toolsMessage = null;
        s.bisect = next;
        await saveBisect();
      } catch (e) {
        s.toolsMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const onBisectRestore = (leaveFoundOff) => guard(async () => {
      const b = s.bisect;
      if (!b) return;
      const wanted = leaveFoundOff && b.found ? b.original.filter((id) => id !== b.found) : b.original;
      try {
        await bisectSwitch({ ...b, found: b.found ?? null, original: wanted });
        s.bisect = null;
        await host.storage.patch({ bisect: null });
      } catch (e) {
        s.toolsMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const saveLists = () => host.storage.patch({ catalogs: s.lists }).catch(() => {
    });
    const listError = (e) => e instanceof CatalogListError ? t(`lists.error.${e.reason}`, { count: MAX_LISTS }) : describeError(e, t);
    const onAddList = (url) => guard(async () => {
      s.listMessage = null;
      try {
        const list = await fetchCatalogList(url, { fetch: host.fetch });
        const next = withList(s.lists, list);
        if (!next) {
          s.listMessage = { kind: "warn", text: t("lists.error.too-many", { count: MAX_LISTS }) };
          return;
        }
        s.lists = next;
        await saveLists();
        s.listMessage = { kind: "ok", text: t("lists.added", { name: list.name, count: list.entries.length }) };
      } catch (e) {
        s.listMessage = { kind: "err", text: listError(e) };
      }
    });
    const onRefreshList = (url) => onAddList(url);
    const onRemoveList = (url) => {
      s.lists = s.lists.filter((l) => l.url !== url);
      void saveLists();
      render();
    };
    const previewEntry = (entry) => {
      if (s.busy) return;
      s.bundleOpen = false;
      s.urlInput = entry.input;
      void onFetch();
    };
    const onPage = (x) => x.runtime === "client" && x.capabilities.includes("full_page_access");
    const codeOf = (x) => ({ id: x.id, name: x.name, js: x.js, css: x.css });
    const analyzePreview = (p) => guard(async () => {
      try {
        const list = await deps.client.list();
        const same = (x) => x.id === p.engine?.record.id || x.name.trim().toLowerCase() === p.draft.name.trim().toLowerCase();
        const installed = list.filter((x) => onPage(x) && !same(x)).map(codeOf);
        const findings = conflictsWith({ id: "new", name: p.draft.name, js: p.draft.js, css: p.draft.css }, installed);
        s.conflictsPreview = { hash: p.contentHash, findings, compared: installed.length };
        s.conflictSummary = findingsSummary(findings);
      } catch (e) {
        s.installMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const analyzeSelected = () => guard(async () => {
      try {
        const list = await deps.client.list();
        const picked = list.filter((x) => s.selected.has(x.id));
        const checked = picked.filter(onPage);
        const findings = conflictsAmong(checked.map(codeOf));
        s.conflictsInstalled = { findings, checked: checked.map((x) => ({ id: x.id, name: x.name })), skipped: picked.filter((x) => !onPage(x)).map((x) => x.name) };
        s.conflictsOpen = true;
        s.conflictSummary = findingsSummary(findings);
      } catch (e) {
        s.sourcesMessage = { kind: "err", text: describeError(e, t) };
      }
    });
    const closeConflicts = () => {
      s.conflictsOpen = false;
      render();
    };
    const copyFindings = (findings) => copy(findingsText(findings), t("conflicts.copied"));
    const openWizard = () => {
      s.wizard = { step: 0 };
      s.bundleOpen = false;
      render();
    };
    const wizardStep = (step) => {
      if (!s.wizard) return;
      s.wizard = { step: Math.max(0, Math.min(WIZARD_STEPS.length - 1, step)) };
      s.keepFor = null;
      if (s.wizard.step === WIZARD_STEPS.length - 1) void loadRows().then(render);
      render();
    };
    const closeWizard = () => {
      s.wizard = null;
      s.keepFor = null;
      void host.storage.patch({ wizardDone: true }).catch(() => {
      });
      render();
    };
    const setNotify = (on) => {
      s.notify = on;
      void host.storage.patch({ notifyUpdates: on }).catch(() => {
      });
      render();
    };
    const openFromToast = () => {
      s.toast = null;
      core.open();
    };
    const dismissToast = () => {
      s.toast = null;
      render();
    };
    const addSelfSource = () => {
      if (s.busy) return;
      s.urlInput = `${SELF_REPO.owner}/${SELF_REPO.repo}`;
      void onFetch();
    };
    async function lookAtReposQuietly() {
      try {
        const changes = await lookAtRepos(s.records, { fetch: host.fetch });
        if (!changes.length) return;
        s.records = await store.commit(changes);
        const byId = new Map(s.records.map((r) => [r.id, r]));
        s.rows = s.rows?.map((row) => row.record ? { ...row, record: byId.get(row.record.id) ?? row.record } : row) ?? null;
        render();
      } catch {
      }
    }
    async function readHealth() {
      try {
        const response = await host.fetch("/api/health", { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
        return response.ok ? parseHealth(await response.json()) : null;
      } catch {
        return null;
      }
    }
    const copyDiagnostics = () => guard(async () => {
      const [health, log3] = await Promise.all([readHealth(), audit.list().catch(() => [])]);
      const secret = host.adminSecret();
      const text2 = diagnosticsText({
        fetchyVersion: core.version,
        health,
        policy: s.policy,
        policyError: s.policyError,
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
        uiLanguage: core.i18n.lang,
        remote: typeof location !== "undefined" && !isLocalHost(location.hostname),
        hasAdminSecret: !!secret,
        jsDigest: digestBackend() === "javascript",
        extensions: s.rows ? s.rows.flatMap((r) => r.extension ? [r.extension] : []) : null,
        listError: s.rowsError,
        records: s.records,
        storageBytes: s.storageBytes,
        log: log3,
        selfId: host.extensionId,
        now: /* @__PURE__ */ new Date(),
        extra: s.conflictSummary ? [s.conflictSummary] : []
      }, secret ? [secret] : []);
      copy(text2, t("result.diagnosticsCopied"));
    });
    const loadChanges = (record) => {
      const key = `${record.id}:${record.installedCommit ?? ""}`;
      const known = s.changes.get(key);
      if (known && known.status !== "failed") return;
      s.changes.set(key, { status: "loading" });
      render();
      void changesSince(record, { fetch: host.fetch }).then((log3) => {
        s.changes.set(key, { status: "done", log: log3 });
      }).catch((e) => {
        s.changes.set(key, { status: "failed", text: describeError(e, t) });
      }).finally(render);
    };
    const setSelecting = (on) => {
      s.selecting = on;
      s.selected = /* @__PURE__ */ new Set();
      render();
    };
    const toggleSelected = (key, on) => {
      if (on) s.selected.add(key);
      else s.selected.delete(key);
      render();
    };
    const selectAll = (keys) => {
      s.selected = keys.every((k) => s.selected.has(k)) ? /* @__PURE__ */ new Set() : new Set(keys);
      render();
    };
    const hideSelected = (hidden) => {
      if (!s.selected.size) return;
      reorganize(setHidden(s.organize, [...s.selected], hidden));
      s.selected = /* @__PURE__ */ new Set();
      render();
    };
    const tagSelected = (tag) => {
      if (!s.selected.size || !tag) return;
      reorganize(addTagTo(s.organize, [...s.selected], tag));
    };
    return {
      loadPolicy,
      loadRecords,
      reconcileRecords,
      loadLog,
      loadRows,
      onFetch,
      onInstall,
      cancelPreview,
      startLink,
      stopLink,
      reinstall,
      onCatalogInstall,
      pickCatalog,
      setBundleOpen,
      checkCatalogQuietly,
      checkRecords,
      onCheckAll,
      onCheckOne,
      onUpdate,
      onAutoApprove,
      onAutoUpdate,
      onRevisions,
      onRollback,
      onDisable,
      onEnable,
      onDelete,
      onForget,
      onRefresh,
      onUpdateAll,
      runAutoUpdates,
      onImport,
      copy,
      clearLog,
      setKeepEnabled,
      setAutoCheck,
      reorganize,
      switchLang,
      set,
      setSelecting,
      toggleSelected,
      selectAll,
      hideSelected,
      tagSelected,
      onAddList,
      onRefreshList,
      onRemoveList,
      previewEntry,
      analyzePreview,
      analyzeSelected,
      closeConflicts,
      copyFindings,
      openWizard,
      wizardStep,
      closeWizard,
      openTools,
      pickBackup,
      backupCandidates,
      onFullBackup,
      onFullRestore,
      closeTools,
      nameOf: nameOf2,
      onSaveProfile,
      onDeleteProfile,
      onPlanProfile,
      onApplyProfile,
      onStartBisect,
      onBisectAnswer,
      onBisectRestore,
      openStorage,
      closeStorage,
      measureStorage,
      findExtension,
      onBackup,
      onRestoreFile,
      onRestore,
      startClear,
      onClearBackup,
      onClear,
      cancelStorageQuestion,
      reloadPage,
      setNotify,
      openFromToast,
      dismissToast,
      addSelfSource,
      loadChanges,
      lookAtReposQuietly,
      copyDiagnostics
    };
  }

  // src/ui/context.ts
  function createState() {
    return {
      busy: false,
      policy: null,
      policyError: null,
      prepared: null,
      pendingExistingId: null,
      linking: null,
      revisionsFor: null,
      records: [],
      rows: null,
      rowsError: null,
      rowsErrorCode: null,
      wizard: null,
      codeFor: null,
      deleting: null,
      enableFor: null,
      autoFor: null,
      expanded: /* @__PURE__ */ new Set(),
      keepEnabled: false,
      keepFor: null,
      installMessage: null,
      catalogPicked: /* @__PURE__ */ new Set(),
      catalogMessage: null,
      catalogResults: [],
      catalogRunning: false,
      sourcesMessage: null,
      urlInput: "",
      transfer: null,
      autoCheck: true,
      notify: true,
      peeked: [],
      toast: null,
      changes: /* @__PURE__ */ new Map(),
      storageBytes: /* @__PURE__ */ new Map(),
      copyBox: null,
      conflictsPreview: null,
      conflictsInstalled: null,
      conflictsOpen: false,
      conflictSummary: null,
      tools: null,
      backupPicked: /* @__PURE__ */ new Set(),
      profiles: [],
      profilePlan: null,
      bisect: null,
      bisectAck: false,
      toolsMessage: null,
      toolsReload: false,
      storage: { open: false, measuring: false, measured: /* @__PURE__ */ new Map(), browser: null, restore: null, clear: null, message: null, reload: false },
      autoUpdatedAt: 0,
      organize: emptyOrganize(),
      tagFilter: null,
      selecting: false,
      selected: /* @__PURE__ */ new Set(),
      lists: [],
      listMessage: null,
      bundleOpen: false,
      folds: /* @__PURE__ */ new Set(),
      logEntries: [],
      reconcileMessage: null,
      retired: false
    };
  }

  // src/ui/changes.ts
  function changesFold(v, record, where2) {
    const { s, t, act } = v;
    const history = historyUrl(record);
    if (!history) return null;
    const foldKey = `changes:${where2}:${record.id}`;
    const link = el("a", { href: history, target: "_blank", rel: "noopener noreferrer" }, t("changes.history"));
    let body2;
    if (!canListChanges(record)) {
      body2 = el("p", { class: "muted line" }, t("changes.noBase"), " ", link);
    } else {
      const state = s.changes.get(`${record.id}:${record.installedCommit ?? ""}`);
      if (!state || state.status === "loading") body2 = el("p", { class: "muted line" }, t("changes.loading"));
      else if (state.status === "failed") body2 = el("p", { class: "muted line" }, state.text, " ", link);
      else {
        const { commits, complete } = state.log;
        body2 = el(
          "div",
          {},
          commits.length ? el("ul", { class: "commits" }, ...commits.map((c) => el(
            "li",
            {},
            c.url ? el("a", { href: c.url, target: "_blank", rel: "noopener noreferrer" }, c.title || c.sha.slice(0, 7)) : c.title,
            c.date ? el("span", { class: "muted" }, ` · ${c.date.slice(0, 10)}`) : null
          ))) : el("p", { class: "muted line" }, t("changes.none")),
          complete ? null : el("p", { class: "muted line" }, t("changes.more", { count: CHANGELOG_LIMIT }), " ", link)
        );
      }
    }
    const node = el("details", { class: "changes-fold", open: s.folds.has(foldKey) }, el("summary", {}, t("changes.heading")), body2);
    node.addEventListener("toggle", () => {
      if (!node.open) {
        s.folds.delete(foldKey);
        return;
      }
      s.folds.add(foldKey);
      if (canListChanges(record)) act.loadChanges(record);
    });
    return node;
  }

  // src/ui/item-row.ts
  function itemRow(v, extension, record) {
    const key = extension?.id ?? `record:${record?.id ?? ""}`;
    const latest = record?.latest?.state;
    const row = {
      extension,
      record,
      key,
      open: v.s.expanded.has(key),
      name: extension?.name ?? record?.name ?? "?",
      needsUpdate: latest === "update" || latest === "changed" || latest === "older"
    };
    const confirm = deleteConfirm(v, row) ?? (extension ? enableConfirm(v, extension) : null);
    return el(
      "li",
      { "data-extension": extension?.id ?? "", "data-record": record?.id ?? "" },
      el("div", { class: "row between" }, el("div", { class: "row title" }, picker(v, row), rowTitle(v, row)), el("div", { class: "row" }, ...primaryActions(v, row))),
      ...rowStatus(v, row),
      record && extension && row.needsUpdate && record.latest?.state !== "older" ? changesFold(v, record, "row") : null,
      ...row.open && !confirm ? moreActions(v, row) : [],
      confirm,
      record && extension ? autoApproveConfirm(v, record, extension) : null,
      extension ? revisionsBlock(v, extension, record) : null,
      extension ? codeBlock(v, extension) : null
    );
  }
  function picker({ s, act }, { key, name }) {
    if (!s.selecting) return null;
    return el("input", {
      type: "checkbox",
      class: "pick",
      "aria-label": name,
      "data-focus": `pick:${key}`,
      checked: s.selected.has(key),
      onChange: (e) => act.toggleSelected(key, checkedOf(e))
    });
  }
  function rowTitle(v, { extension, record, key, name }) {
    const { s, t } = v;
    const version = extension?.version ?? record?.installedVersion ?? null;
    const tagChips = (s.organize.of[key]?.tags ?? []).map((id) => s.organize.tags.find((x) => x.id === id)).filter((x) => !!x).map((x) => el("span", { class: "chip" }, `#${x.name}`));
    return el(
      "div",
      {},
      el("span", { class: "name" }, name),
      " ",
      el("span", { class: "muted" }, `v${version ?? "?"}`),
      " ",
      ...extension ? badges(v, extension) : [el("span", { class: "badge loud" }, t("log.missing"))],
      record?.autoApprove ? el("span", { class: "badge approve" }, t("auto.badge")) : null,
      record?.autoUpdate ? el("span", { class: "badge" }, t("autoUpdate.badge")) : null,
      record ? repoBadge(v, record) : null,
      ...tagChips
    );
  }
  function repoBadge({ t }, record) {
    const mark = repoMark(record, Date.now());
    if (!mark || !record.repo) return null;
    const pushed = record.repo.pushedAt ? formatDate(record.repo.pushedAt) ?? "" : "";
    return el("span", { class: `badge repo ${mark}`, title: t(mark === "archived" ? "repo.archived.title" : "repo.stale.title", { date: pushed }) }, t(mark === "archived" ? "repo.archived" : "repo.stale"));
  }
  function badges({ t, host }, x) {
    const list = [];
    if (x.enabled) list.push(el("span", { class: "badge on" }, t("badge.enabled")));
    else if (x.approvedHash === null) list.push(el("span", { class: "badge approve" }, t("badge.needsApproval")));
    else list.push(el("span", { class: "badge off" }, t("badge.disabled")));
    if (x.capabilities.includes("full_page_access")) list.push(el("span", { class: "badge loud" }, "full_page_access"));
    if (x.runtime === "server") list.push(el("span", { class: "badge" }, t("preview.runtime.server")));
    if (x.id === host.extensionId) list.push(el("span", { class: "badge" }, "Fetchy"));
    return list;
  }
  function primaryActions({ s, t, act, render }, { extension, record, key, open, needsUpdate }) {
    const primary = [];
    if (record && extension && needsUpdate) primary.push(el("button", { class: "small primary", type: "button", disabled: s.busy, onClick: () => act.onUpdate(record) }, t("action.update")));
    if (extension && !record) primary.push(el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.startLink(extension) }, t("untracked.link")));
    if (record && !extension) primary.push(el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.reinstall(record) }, t("action.reinstall")));
    const toggleMore = () => {
      if (open) s.expanded.delete(key);
      else s.expanded.add(key);
      render();
    };
    primary.push(el("button", { class: "small", type: "button", onClick: toggleMore }, open ? t("action.less") : t("action.more")));
    return primary;
  }
  function sourceText(record) {
    if (!record) return null;
    const branch = record.ref && !(record.source.kind === "github-repo" && record.source.ref) ? ` @${record.ref}` : "";
    return describeSource(record.source) + branch;
  }
  function stateText({ t }, record) {
    if (record?.lastError) return t("sources.error", { error: record.lastError });
    const latest = record?.latest;
    if (!latest || latest.state === "up-to-date") return null;
    return t(`sources.state.${latest.state}`, { version: latest.version ?? "?" });
  }
  function sourceLink(record, text2) {
    if (!record || !text2) return null;
    return el("a", { class: "source", href: browseUrl(record.source, record.ref), target: "_blank", rel: "noopener noreferrer" }, text2);
  }
  function hashLine({ t }, extension, record) {
    return el(
      "div",
      { class: "muted line" },
      el("code", {}, extension?.contentHash ?? record?.installedHash ?? ""),
      extension ? ` · ${formatDate(extension.updatedAt) ?? ""}` : "",
      record?.lastCheckedAt ? ` · ${t("sources.lastCheck")} ${formatDate(record.lastCheckedAt)}` : "",
      record ? null : ` · ${t("item.notFromFetchy")}`
    );
  }
  function rowStatus(v, { extension, record, key, open, needsUpdate }) {
    const stateClass = `state ${record?.latest?.state ?? ""}`;
    const source = sourceText(record);
    const state = stateText(v, record);
    const loudState = record?.lastError || needsUpdate ? state : null;
    const loud = loudState ? el("div", { class: "muted line" }, el("span", { class: stateClass }, loudState)) : null;
    if (!open) return [loud];
    const quietState = loudState ? null : state;
    const needsApproval = !!extension && extension.approvedHash === null && !extension.enabled;
    return [
      loud,
      source || quietState ? el("div", { class: "muted line" }, sourceLink(record, source), source && quietState ? " · " : "", quietState ? el("span", { class: stateClass }, quietState) : null) : null,
      needsApproval ? el("div", { class: "muted line" }, v.t("item.approveHint")) : null,
      organizeControls(v, key),
      hashLine(v, extension, record)
    ];
  }
  function organizeControls({ s, t, act }, key) {
    const organize = s.organize;
    if (!organize.folders.length && !organize.tags.length) return null;
    const mine = organize.of[key];
    const folder = organize.folders.length ? el(
      "label",
      { class: "toggle" },
      t("organize.folder"),
      " ",
      el(
        "select",
        { "data-focus": `folder:${key}`, onChange: (e) => act.reorganize(setFolder(s.organize, key, e.target.value || null)) },
        el("option", { value: "", selected: !mine?.folder }, t("organize.noFolder")),
        ...organize.folders.map((f) => el("option", { value: f.id, selected: mine?.folder === f.id }, f.name))
      )
    ) : null;
    const tags = organize.tags.map((x) => el("button", { class: `chip${mine?.tags?.includes(x.id) ? " on" : ""}`, type: "button", "aria-pressed": String(!!mine?.tags?.includes(x.id)), "data-focus": `tag:${key}:${x.id}`, onClick: () => act.reorganize(toggleTag(s.organize, key, x.id)) }, `#${x.name}`));
    return el("div", { class: "actions" }, folder, ...tags);
  }
  function moreActions(v, { extension, record, key }) {
    const { s, t, act, host, render } = v;
    const small = (label, onClick) => el("button", { class: "small", type: "button", disabled: s.busy, onClick }, label);
    const self = !!extension && extension.id === host.extensionId;
    const more = [];
    if (extension) {
      if (extension.enabled && !self) more.push(small(t("action.disable"), () => act.onDisable(extension)));
      else if (canReenable(extension)) {
        more.push(small(t("action.enable"), () => isFullPage(extension) ? act.set({ enableFor: { id: extension.id, ack: false } }) : act.onEnable(extension, false)));
      }
      more.push(small(t("action.code"), () => {
        s.codeFor = s.codeFor === extension.id ? null : extension.id;
        render();
      }));
      more.push(small(t("action.revisions"), () => act.onRevisions(extension)));
    }
    if (record && extension) more.push(small(t("action.checkNow"), () => act.onCheckOne(record)));
    if (!self || record) more.push(small(t("action.delete"), () => act.set({ deleting: key })));
    const switches = record && extension ? autoSwitches(v, record, extension) : [];
    const out = [el("div", { class: "actions" }, ...more)];
    if (switches.length) out.push(el("div", { class: "actions auto-group" }, el("span", { class: "muted" }, t("auto.group")), ...switches));
    return out;
  }
  function autoSwitches({ s, t, act, host, render }, record, extension) {
    const switches = [];
    if (extension.id !== host.extensionId) {
      switches.push(el("label", { class: "toggle" }, el("input", {
        type: "checkbox",
        class: "auto-update",
        "data-focus": `auto-update:${record.id}`,
        checked: record.autoUpdate === true,
        disabled: s.busy,
        onChange: (e) => void act.onAutoUpdate(record, checkedOf(e))
      }), t("autoUpdate.label"), help(t("help.autoUpdate"))));
    }
    switches.push(el("label", { class: "toggle" }, el("input", {
      type: "checkbox",
      class: "auto-approve",
      "data-focus": `auto:${record.id}`,
      checked: record.autoApprove === true,
      disabled: s.busy,
      onChange: (e) => {
        if (!checkedOf(e)) {
          void act.onAutoApprove(record, false);
          return;
        }
        s.autoFor = { id: record.id, code: false, fullPage: false };
        render();
      }
    }), t("auto.label"), help(t("help.autoApprove"))));
    return switches;
  }
  function deleteConfirm({ s, t, act, host }, { extension, record, key, name }) {
    if (s.deleting !== key) return null;
    const button = (label, onClick, primary = false) => el("button", { class: `small${primary ? " primary" : ""}`, type: "button", disabled: s.busy, onClick }, label);
    const cancel = button(t("action.cancel"), () => act.set({ deleting: null }));
    const deletable = extension && extension.id !== host.extensionId ? extension : null;
    if (deletable && !record) {
      return el("div", { class: "actions delete-confirm" }, el("span", {}, t("action.confirmDelete", { name })), button(t("action.delete"), () => act.onDelete(deletable), true), cancel);
    }
    if (!record) return null;
    if (!extension) {
      return el("div", { class: "actions delete-confirm" }, el("span", {}, t("delete.missing", { name })), button(t("delete.fromList"), () => act.onForget(record, false), true), cancel);
    }
    return el(
      "div",
      { class: "delete-confirm" },
      el("div", { class: "line" }, t("delete.ask", { name })),
      el(
        "div",
        { class: "actions" },
        deletable ? button(t("delete.engine"), () => act.onDelete(deletable), true) : null,
        button(t("delete.unlink"), () => act.onForget(record, false)),
        cancel
      ),
      el("p", { class: "note" }, t("delete.unlink.note"))
    );
  }
  var isFullPage = (x) => x.capabilities.includes("full_page_access");
  function enableConfirm({ s, t, act, render }, extension) {
    const state = s.enableFor;
    if (!state || state.id !== extension.id) return null;
    return el(
      "div",
      { class: "msg warn enable-confirm" },
      el("div", { style: "font-weight:600" }, t("enable.confirm.title", { name: extension.name })),
      el("p", { class: "line" }, t("enable.confirm.body", { hash: shortHash2(extension.contentHash) })),
      el(
        "label",
        { class: "toggle", style: "white-space:normal;color:inherit" },
        el("input", { type: "checkbox", class: "ack-full-page", "data-focus": `enable-ack:${extension.id}`, checked: state.ack, onChange: (e) => {
          state.ack = checkedOf(e);
          render();
        } }),
        t("enable.ack.fullPage")
      ),
      el(
        "div",
        { class: "actions" },
        el("button", { class: "small primary", type: "button", disabled: s.busy || !state.ack, onClick: () => act.onEnable(extension, true) }, t("action.enable")),
        el("button", { class: "small", type: "button", onClick: () => act.set({ enableFor: null }) }, t("action.cancel"))
      )
    );
  }
  function autoApproveConfirm({ s, t, act, render }, record, extension) {
    if (!s.autoFor || s.autoFor.id !== record.id) return null;
    const state = s.autoFor;
    const fullPage = extension.capabilities.includes("full_page_access");
    const ready = state.code && (!fullPage || state.fullPage);
    const ack = (cls, label, onTick) => el("label", { class: "toggle", style: "white-space:normal;color:inherit" }, el("input", { type: "checkbox", class: cls, onChange: (e) => {
      onTick(checkedOf(e));
      render();
    } }), label);
    return el(
      "div",
      { class: "msg loud auto-confirm" },
      el("div", {}, t("auto.confirm.title", { name: record.name })),
      el("p", { class: "line", style: "font-weight:400" }, t("auto.confirm.body", { source: describeSource(record.source) })),
      ack("ack-code", t("auto.ack.code"), (on) => {
        state.code = on;
      }),
      fullPage ? ack("ack-full-page", t("auto.ack.fullPage"), (on) => {
        state.fullPage = on;
      }) : null,
      el(
        "div",
        { class: "actions" },
        el("button", { class: "small primary", type: "button", disabled: s.busy || !ready, onClick: () => act.onAutoApprove(record, true) }, t("auto.confirm.on")),
        el("button", { class: "small", type: "button", onClick: () => act.set({ autoFor: null }) }, t("action.cancel"))
      )
    );
  }
  function revisionsBlock({ s, t, act }, extension, record) {
    if (!s.revisionsFor || s.revisionsFor.id !== extension.id) return null;
    const list = s.revisionsFor.list;
    return el(
      "div",
      { class: "revisions-box line" },
      el("div", { class: "muted" }, t("revisions.heading")),
      list.length === 0 ? el("p", { class: "muted" }, t("revisions.none")) : el("ul", { class: "revisions" }, ...list.map((rev) => el(
        "li",
        {},
        t("revisions.item", { version: rev.version ?? "?", savedAt: formatDate(rev.savedAt) ?? rev.savedAt, hash: shortHash2(rev.contentHash) }),
        " ",
        el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.onRollback(extension, record, rev) }, t("action.rollback"))
      ))),
      el("button", { class: "small", type: "button", onClick: () => act.set({ revisionsFor: null }) }, t("close"))
    );
  }
  function codeBlock({ s, t, act }, extension) {
    if (s.codeFor !== extension.id) return null;
    const roles = ["css", "js", "serverJs"].filter((role) => extension[role]);
    return el(
      "div",
      { class: "line" },
      ...roles.map((role) => el("details", { open: true }, el("summary", {}, `${role} (${textSize(extension[role] ?? "")})`), el("pre", { class: `code-${role}` }, extension[role] ?? ""))),
      el("button", { class: "small", type: "button", onClick: () => act.set({ codeFor: null }) }, t("close"))
    );
  }

  // src/ui/items.ts
  var keyOf = (r) => r.extension?.id ?? `record:${r.record?.id ?? ""}`;
  function itemsSection(v) {
    const { s, t } = v;
    const list = s.rows ?? s.records.map((record) => ({ extension: null, record }));
    const filtered = list.filter((r) => !s.tagFilter || s.organize.of[keyOf(r)]?.tags?.includes(s.tagFilter)).sort((a, b) => (a.extension?.name ?? a.record?.name ?? "").localeCompare(b.extension?.name ?? b.record?.name ?? ""));
    const shown = filtered.filter((r) => !isHidden(s.organize, keyOf(r)));
    const hidden = filtered.filter((r) => isHidden(s.organize, keyOf(r)));
    const inSight = () => [...shown, ...s.folds.has("hidden") ? hidden : []].map(keyOf);
    return el(
      "section",
      { class: "items" },
      el(
        "div",
        { class: "row between" },
        el("h3", {}, t("items.heading"), help(t("help.items"))),
        toolbar(v)
      ),
      selectBar(v, inSight),
      tagFilterChips(v),
      s.rowsError ? el("p", { class: "msg warn" }, t("items.unavailable", { error: s.rowsError })) : null,
      list.length === 0 ? el("p", { class: "muted" }, t("items.empty")) : null,
      ...grouped(v, shown),
      hiddenFold(v, hidden),
      message(s.reconcileMessage),
      message(s.sourcesMessage),
      s.sourcesMessage?.kind === "err" ? diagnosticsButton(v) : null,
      optionsFold(v)
    );
  }
  function toolbar({ s, t, act }) {
    const anyUpdate = s.records.some((r) => r.latest && r.latest.state !== "up-to-date" && r.latest.state !== "unknown");
    return el(
      "div",
      { class: "row" },
      el("button", {
        class: `small${s.selecting ? " on" : ""}`,
        type: "button",
        "data-focus": "select",
        "aria-pressed": String(s.selecting),
        onClick: () => act.setSelecting(!s.selecting)
      }, s.selecting ? t("select.done") : t("select.start")),
      el("button", { class: "small", type: "button", disabled: s.busy || s.records.length === 0, onClick: act.onCheckAll }, t("action.checkAll")),
      el("button", { class: "small primary", type: "button", disabled: s.busy || !anyUpdate, onClick: act.onUpdateAll }, t("action.updateAll")),
      el("button", { class: "small", type: "button", disabled: s.busy, title: t("action.refresh"), "aria-label": t("action.refresh"), onClick: act.onRefresh }, "↻")
    );
  }
  function selectBar({ s, t, act }, inSight) {
    if (!s.selecting) return null;
    const picked = [...s.selected];
    const anyHidden = picked.some((k) => isHidden(s.organize, k));
    const anyShown = picked.some((k) => !isHidden(s.organize, k));
    const tagBox = s.organize.tags.length ? el(
      "select",
      { "aria-label": t("select.tag"), disabled: !picked.length, onChange: (e) => act.tagSelected(e.target.value) },
      el("option", { value: "", selected: true }, t("select.tag")),
      ...s.organize.tags.map((x) => el("option", { value: x.id }, `#${x.name}`))
    ) : null;
    return el(
      "div",
      { class: "selectbar", role: "toolbar", "aria-label": t("select.start") },
      el("span", { class: "muted" }, t("select.count", { count: picked.length })),
      el("button", { class: "small", type: "button", disabled: !s.rows?.length && !s.records.length, onClick: () => act.selectAll(inSight()) }, t("select.all")),
      el("button", { class: "small", type: "button", disabled: !anyShown, onClick: () => act.hideSelected(true) }, t("select.hide")),
      el("button", { class: "small", type: "button", disabled: !anyHidden, onClick: () => act.hideSelected(false) }, t("select.show")),
      tagBox,
      el("button", { class: "small", type: "button", "data-focus": "conflicts-selected", disabled: picked.length < 2 || s.busy, onClick: act.analyzeSelected }, t("conflicts.installed"))
    );
  }
  function hiddenFold(v, hidden) {
    const { s, t } = v;
    if (!hidden.length) return null;
    const updates = hidden.filter((r) => r.record && r.extension && hasUpdate(r.record)).length;
    const box = fold(
      s.folds,
      "hidden",
      [t("hidden.heading", { count: hidden.length }), updates ? el("span", { class: "state update" }, " · ", t("hidden.updates", { count: updates })) : null],
      el("ul", { class: "items" }, ...hidden.map((r) => itemRow(v, r.extension, r.record)))
    );
    box.classList.add("folder");
    return box;
  }
  function diagnosticsButton({ s, t, act }) {
    return el("div", { class: "actions" }, el("button", { class: "small", type: "button", disabled: s.busy, onClick: act.copyDiagnostics }, t("action.diagnostics")));
  }
  function tagFilterChips({ s, t, act }) {
    if (!s.organize.tags.length) return null;
    return el(
      "div",
      { class: "chips" },
      el("button", { class: `chip${s.tagFilter ? "" : " on"}`, type: "button", onClick: () => act.set({ tagFilter: null }) }, t("organize.allTags")),
      ...s.organize.tags.map((x) => el("button", {
        class: `chip${s.tagFilter === x.id ? " on" : ""}`,
        type: "button",
        "aria-pressed": String(s.tagFilter === x.id),
        onClick: () => act.set({ tagFilter: s.tagFilter === x.id ? null : x.id })
      }, `#${x.name}`))
    );
  }
  function grouped(v, shown) {
    const { s, t } = v;
    const ul = (items) => el("ul", { class: "items" }, ...items.map((r) => itemRow(v, r.extension, r.record)));
    const folders = s.organize.folders;
    if (!folders.length) return shown.length ? [ul(shown)] : [];
    const groups = [];
    for (const f of folders) {
      const inside = shown.filter((r) => s.organize.of[keyOf(r)]?.folder === f.id);
      const box = fold(s.folds, `folder:${f.id}`, [f.name, el("span", { class: "muted" }, String(inside.length))], inside.length ? ul(inside) : el("p", { class: "muted" }, t("organize.empty")));
      box.classList.add("folder");
      groups.push(box);
    }
    const loose = shown.filter((r) => !folders.some((f) => s.organize.of[keyOf(r)]?.folder === f.id));
    if (loose.length) groups.push(el("h3", {}, t("organize.noFolder")), ul(loose));
    return groups;
  }

  // src/ui/install.ts
  function gateLine({ s, t }) {
    if (s.policyError) return el("p", { class: "msg warn" }, t("gate.unknown", { error: s.policyError }));
    if (!s.policy || s.policy.externalExtensionsEnabled) return null;
    return el("p", { class: "msg warn" }, s.policy.externalExtensionsEnvEnabled ? t("gate.switch") : t("gate.env"));
  }
  function installSection(v) {
    const { s, t, act } = v;
    return el(
      "section",
      { class: "install" },
      el("h3", {}, t("install.heading"), help(t("help.install"))),
      s.linking ? el(
        "div",
        { class: "msg warn" },
        t("install.linkHint", { name: s.linking.name }),
        " ",
        el("button", { class: "small", type: "button", onClick: act.stopLink }, t("install.cancelLink"))
      ) : null,
      el(
        "form",
        { class: "row", onSubmit: (e) => {
          e.preventDefault();
          void act.onFetch();
        } },
        el("input", {
          type: "text",
          class: "url",
          "aria-label": t("install.heading"),
          placeholder: t("install.placeholder"),
          value: s.urlInput,
          disabled: s.busy,
          autocomplete: "off",
          spellcheck: "false",
          onInput: (e) => {
            s.urlInput = e.target.value;
          }
        }),
        el("button", { class: "primary", type: "submit", disabled: s.busy }, s.busy && !s.prepared && !s.catalogRunning ? t("install.fetching") : t("install.fetch"))
      ),
      message(s.installMessage),
      s.installMessage?.kind === "err" ? diagnosticsButton(v) : null
    );
  }

  // src/ui/conflicts.ts
  var kindLabel = (t, kind) => t(`conflicts.kind.${kind}`);
  function findingItem({ t }, f, me) {
    const other = me === null ? `${f.a.name} / ${f.b.name}` : f.a.extensionId === me ? f.b.name : f.a.name;
    const line = (side3) => el(
      "div",
      { class: "line" },
      el("span", { class: "muted" }, `${side3.name} · ${side3.claim.file}:${side3.claim.line} · ${t(side3.claim.role === "define" ? "conflicts.defines" : "conflicts.reads")}`),
      el("pre", { class: "finding-code" }, side3.claim.text)
    );
    return el(
      "li",
      { class: `finding ${f.level}` },
      el(
        "details",
        {},
        el(
          "summary",
          {},
          el("span", { class: `badge ${f.level === "conflict" ? "loud" : ""}` }, t(f.level === "conflict" ? "conflicts.conflict" : "conflicts.note")),
          " ",
          kindLabel(t, f.kind),
          " ",
          el("code", {}, f.name),
          el("span", { class: "muted" }, ` · ${other}`)
        ),
        line(f.a),
        line(f.b)
      )
    );
  }
  function findingsList(v, findings, me) {
    return el("ul", { class: "findings" }, ...findings.map((f) => findingItem(v, f, me)));
  }
  function previewConflicts(v, p) {
    const { s, t, act } = v;
    if (p.draft.runtime !== "client" || !p.fullPageAccess) return el("p", { class: "note" }, t("conflicts.sandboxed"));
    const result = s.conflictsPreview?.hash === p.contentHash ? s.conflictsPreview : null;
    const conflicts = result?.findings.filter((f) => f.level === "conflict").length ?? 0;
    return el(
      "div",
      { class: "conflicts-preview" },
      el(
        "div",
        { class: "row" },
        el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.analyzePreview(p) }, t("conflicts.preview")),
        help(t("help.conflicts"))
      ),
      result ? el(
        "div",
        { class: "line" },
        el("div", { class: conflicts ? "msg err" : "msg ok" }, result.findings.length ? t("conflicts.previewFound", { conflicts, notes: result.findings.length - conflicts, count: result.compared }) : t("conflicts.previewNone", { count: result.compared })),
        result.findings.length ? findingsList(v, result.findings, "new") : null,
        result.findings.length ? el("div", { class: "actions" }, el("button", { class: "small", type: "button", onClick: () => act.copyFindings(result.findings) }, t("conflicts.copy"))) : null
      ) : null
    );
  }
  function conflictsWindow(v) {
    const { s, t, act } = v;
    const r = s.conflictsInstalled;
    if (!r || !s.conflictsOpen) return null;
    const groups = r.checked.map((x) => ({ x, mine: r.findings.filter((f) => f.a.extensionId === x.id || f.b.extensionId === x.id) }));
    const back = el(
      "div",
      { class: "pop-back", onClick: (e) => {
        if (e.target === back) act.closeConflicts();
      } },
      el(
        "div",
        { class: "pop conflicts", role: "dialog", "aria-modal": "true", "aria-label": t("conflicts.title") },
        el(
          "div",
          { class: "pop-head" },
          el("h3", {}, t("conflicts.title"), help(t("help.conflicts"))),
          el("button", { class: "small", type: "button", "aria-label": t("close"), onClick: act.closeConflicts }, "✕")
        ),
        el("p", { class: "note" }, t("conflicts.checked", { names: r.checked.map((x) => x.name).join(", ") })),
        r.skipped.length ? el("p", { class: "note" }, t("conflicts.skipped", { names: r.skipped.join(", ") })) : null,
        message({ kind: r.findings.some((f) => f.level === "conflict") ? "err" : "ok", text: r.findings.length ? t("conflicts.installedFound", { conflicts: r.findings.filter((f) => f.level === "conflict").length, notes: r.findings.filter((f) => f.level === "note").length }) : t("conflicts.installedNone") }),
        ...groups.filter((g) => g.mine.length).map((g) => {
          const c = g.mine.filter((f) => f.level === "conflict").length;
          return el(
            "details",
            { class: "conflict-group", open: c > 0 },
            el("summary", {}, el("span", { class: "name" }, g.x.name), el("span", { class: "muted" }, ` · ${t("conflicts.counts", { conflicts: c, notes: g.mine.length - c })}`)),
            findingsList(v, g.mine, g.x.id)
          );
        }),
        r.findings.length ? el("div", { class: "actions" }, el("button", { class: "small", type: "button", onClick: () => act.copyFindings(r.findings) }, t("conflicts.copy"))) : null
      )
    );
    return back;
  }

  // src/ui/preview.ts
  function previewSection(v, p) {
    const { s, t } = v;
    const d = p.draft;
    const view = p.engine;
    return el(
      "section",
      { class: "preview" },
      el("h3", {}, t("preview.heading")),
      ...previewWarnings(v, p),
      p.tracked && !s.pendingExistingId && !view ? el("p", { class: "note" }, t("preview.tracked", { name: p.tracked.name, version: p.tracked.installedVersion ?? "?" })) : null,
      el(
        "dl",
        {},
        drow(t("preview.name"), d.name, " ", el("span", { class: "muted" }, `v${d.version ?? t("preview.none")}`)),
        drow(t("preview.description"), d.description || t("preview.none")),
        drow(t("preview.capabilities"), d.capabilities.length ? d.capabilities.join(", ") : t("preview.capabilities.none")),
        drow(t("preview.hash"), el("code", { class: "hash" }, p.contentHash), el("div", { class: "muted" }, t("preview.hash.hint"))),
        view ? drow(t("preview.engine"), t("preview.engine.record", { name: view.record.name, version: view.record.version ?? "?", state: t(view.record.enabled ? "preview.engine.enabled" : "preview.engine.disabled"), hash: shortHash2(view.record.contentHash) })) : null,
        view ? drow(t("preview.changes"), changesBlock(v, p)) : null
      ),
      // an update of what Fetchy installed: the commits since
      p.tracked && view && !view.sameCode && p.tracked.extensionId === view.record.id ? changesFold(v, p.tracked, "preview") : null,
      el("dl", { class: "conflicts-row" }, drow(t("conflicts.heading"), previewConflicts(v, p))),
      // where it comes from, what is in it and how big: there when wanted
      packageDetails(v, p),
      codeDetails(v, p),
      p.pkg.readme ? el("details", { class: "readme" }, el("summary", {}, `${t("preview.readme")} (${p.pkg.readme.path})`), el("pre", { class: "readme" }, p.pkg.readme.text)) : null,
      el("div", { class: "row", style: "margin-top:10px" }, ...previewButtons(v, p))
    );
  }
  function previewWarnings(v, p) {
    const warnings = packageWarnings(v, p);
    if (p.engine) warnings.push(...engineWarnings(v, p));
    else if (p.engineListError) warnings.push(el("p", { class: "note" }, v.t("preview.engine.unavailable", { error: describeError(p.engineListError, v.t) })));
    return warnings;
  }
  var warn = (text2) => el("div", { class: "msg warn" }, text2);
  function packageWarnings({ s, t }, p) {
    const warnings = [];
    if (p.fullPageAccess) warnings.push(el("div", { class: "msg loud", role: "alert" }, t("warn.fullPage")));
    if (p.draft.runtime === "server") {
      warnings.push(warn(t("warn.server")));
      if (s.policy && !s.policy.serverSandboxAvailable) warnings.push(warn(t("warn.serverSandbox", { reason: s.policy.serverSandboxReason ?? "" })));
    }
    for (const w of p.pkg.normalized.warnings) {
      if (w.code === "legacy-kind-full-page") warnings.push(warn(t("warn.legacyKind")));
      if (w.code === "version-dropped") warnings.push(warn(t("warn.versionDropped", { value: w.value })));
      if (w.code === "unknown-capabilities") warnings.push(warn(t("warn.unknownCaps", { values: w.values.join(", ") })));
      if (w.code === "unknown-kind") warnings.push(warn(t("warn.unknownKind", { kind: w.kind })));
    }
    return warnings;
  }
  function engineWarnings({ t }, p) {
    const view = p.engine;
    if (!view) return [];
    const d = p.draft;
    const changed = !view.sameCode;
    const warnings = [];
    if (view.capabilitiesAdded.length) warnings.push(el("div", { class: "msg loud", role: "alert" }, t("warn.capabilitiesAdded", { values: view.capabilitiesAdded.join(", ") })));
    if (view.capabilitiesRemoved.length) warnings.push(warn(t("warn.capabilitiesRemoved", { values: view.capabilitiesRemoved.join(", ") })));
    if (changed && view.record.version !== null && view.record.version === d.version) warnings.push(warn(t("warn.sameVersionChanged", { version: d.version ?? "" })));
    if (changed && view.editedInMarinara) warnings.push(warn(t("warn.editedInMarinara")));
    if (view.runtimeDiffers) warnings.push(el("div", { class: "msg err", role: "alert" }, t("warn.runtimeDiffers", { before: view.record.runtime, after: d.runtime })));
    if (changed && view.nameDiffers) warnings.push(warn(t("warn.nameDiffers", { before: view.record.name, after: d.name })));
    return warnings;
  }
  function changesBlock({ t }, p) {
    const view = p.engine;
    if (!view) return null;
    if (view.sameCode) return el("div", { class: "msg ok" }, t("preview.changes.none"));
    const sideText = (side3, other) => side3 ? formatBytes(side3.bytes) : t(`preview.changes.${other}`);
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
  function packageDetails({ t }, p) {
    const link = el("a", { href: p.pkg.browseUrl, target: "_blank", rel: "noopener noreferrer" }, describeSource(p.source));
    const files = el("ul", { class: "files" }, ...p.files.map((f) => el("li", {}, `${f.role}: ${f.path} (${formatBytes(f.bytes)}) `, el("code", {}, `sha256 ${f.sha256.slice(0, 16)}…`))));
    return el(
      "details",
      {},
      el("summary", {}, t("preview.details")),
      el(
        "dl",
        {},
        drow(t("preview.source"), link),
        p.pkg.ref ? drow(t("preview.branch"), p.pkg.ref) : null,
        drow(t("preview.runtime"), t(p.draft.runtime === "server" ? "preview.runtime.server" : "preview.runtime.client")),
        drow(t("preview.files"), files),
        drow(t("preview.downloaded"), formatBytes(p.pkg.downloadedBytes))
      )
    );
  }
  function codeDetails({ t }, p) {
    const d = p.draft;
    return el(
      "details",
      {},
      el("summary", {}, t("preview.code")),
      ...["css", "js", "serverJs"].filter((role) => d[role] !== null).map((role) => el("details", {}, el("summary", {}, `${role} (${textSize(d[role] ?? "")})`), el("pre", { class: `code-${role}` }, d[role] ?? "")))
    );
  }
  function previewButtons(v, p) {
    const { s, t, act } = v;
    const view = p.engine;
    const targetId = previewTarget(v, p);
    const busyLabel = s.busy ? t("action.busy") : null;
    const button = (label, onClick, primary = false) => el("button", { class: primary ? "primary" : void 0, type: "button", disabled: s.busy, onClick }, label);
    const buttons = [];
    if (view?.runtimeDiffers) {
    } else if (targetId && view?.sameCode) {
      buttons.push(button(busyLabel ?? t("action.link"), () => act.onInstall({ kind: "link", extensionId: targetId }), true));
    } else if (targetId) {
      buttons.push(button(busyLabel ?? updateLabel(v, p), () => act.onInstall({ kind: "update", extensionId: targetId }), true));
      if (view && !view.sameCode && !s.pendingExistingId) buttons.push(button(t("action.link"), () => act.onInstall({ kind: "link", extensionId: targetId })));
    } else {
      buttons.push(button(busyLabel ?? t("action.install"), () => act.onInstall({ kind: "create" }), true));
    }
    buttons.push(button(t("action.cancel"), act.cancelPreview));
    return buttons;
  }
  function previewTarget({ s }, p) {
    return s.pendingExistingId ?? s.linking?.id ?? p.engine?.record.id ?? p.tracked?.extensionId ?? null;
  }
  function updateLabel({ s, t }, p) {
    if (s.pendingExistingId) return t("action.update");
    return t("action.updateTracked", { name: p.engine?.record.name ?? p.tracked?.name ?? s.linking?.name ?? "" });
  }

  // src/ui/style.ts
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
.msg.info { background: var(--soft); }
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
ul.items, ul.catalog-list { list-style: none; margin: 0; padding: 0; }
ul.catalog-list > li { padding: 8px 0; border-top: 1px solid var(--line); }
ul.catalog-list > li:first-child { border-top: 0; }
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
.preview, .items, .install, .catalog { margin-top: 4px; }
/* the bundle button: the cake is grey until an update for one of FigCake's extensions is found */
header .tools button.bundle .cake { filter: grayscale(1); opacity: .75; }
header .tools button.bundle.has-update { color: var(--fg); background: var(--wash-warn); }
header .tools button.bundle.has-update .cake { filter: none; opacity: 1; }
header .tools button.bundle .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-left: 5px; vertical-align: middle; }
.pop-back { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 2147483002; background: rgba(0,0,0,.35); display: flex; justify-content: center; align-items: flex-start; padding: 56px 12px; overflow: auto; }
.pop { width: 100%; max-width: 540px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px 16px; }
.pop .pop-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pop .pop-head h3 { margin: 0; }
@media (max-width: 640px) { .pop-back { padding: 0; } .pop { max-width: none; min-height: 100%; border-radius: 0; border: 0; } }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 8px; }
.chip { font-size: 11px; line-height: 1.5; padding: 1px 9px; border-radius: 999px; background: var(--soft); color: var(--muted); border: 1px solid transparent; }
button.chip.on { color: var(--fg); border-color: var(--accent); }
span.chip { margin-right: 4px; }
details.folder > summary { font-weight: 600; color: var(--fg); padding: 6px 0; }
details.folder > summary .muted { font-weight: 400; margin-left: 6px; }
.org-list { list-style: none; margin: 4px 0 8px; padding: 0; }
.org-list li { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
.org-list li input { flex: 1 1 auto; }
select { font: inherit; font-size: 12px; color: var(--fg); background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; }
/* choosing several rows: the bar above the list and a checkbox before each name */
.selectbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 10px; margin: 4px 0 8px; border-radius: 10px; background: var(--wash-info); }
button.small.on { color: var(--fg); border-color: var(--accent); }
.row.title { gap: 0; flex-wrap: nowrap; align-items: flex-start; }
input.pick { margin: 3px 8px 0 0; accent-color: var(--accent); flex: 0 0 auto; }
.auto-group { padding-top: 6px; border-top: 1px dashed var(--line); }
.delete-confirm { margin-top: 8px; }
/* the update notice: a small card at the bottom right (full width on a narrow screen) */
.toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483003; width: min(360px, calc(100vw - 32px)); background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
.toast .actions { margin-top: 8px; }
@media (max-width: 640px) { .toast { left: 12px; right: 12px; bottom: 12px; width: auto; } }
.self-update { margin-top: 10px; }
details.changes-fold { margin-top: 6px; }
ul.commits { margin: 4px 0 0; padding-left: 18px; font-size: 12px; }
ul.commits li { margin-top: 2px; }
.badge.repo.archived { background: var(--wash-warn); color: var(--fg); }
.badge.repo { cursor: help; }
/* the first-time setup guide */
ul.wizard-checks { list-style: none; margin: 8px 0 0; padding: 0; }
ul.wizard-checks li { padding: 6px 0; border-top: 1px solid var(--line); }
ul.wizard-checks li:first-child { border-top: 0; }
ul.wizard-checks .mark { display: inline-block; width: 1.2em; font-weight: 700; }
ul.wizard-checks li.ok .mark { color: var(--accent); } ul.wizard-checks li.bad { color: var(--fg); } ul.wizard-checks li.bad .mark { color: #d9534f; }
.wizard-options { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.wizard-options label.toggle { white-space: normal; }
.wizard-nav { justify-content: flex-end; margin-top: 14px; }
.pop.wizard code.hash { font-size: 11px; }
/* the storage window */
ul.storage-list { list-style: none; margin: 8px 0 0; padding: 0; }
ul.storage-list > li { padding: 10px 0; border-top: 1px solid var(--line); }
ul.storage-list > li:first-child { border-top: 0; }
.meter { height: 6px; border-radius: 999px; background: var(--soft); overflow: hidden; margin: 6px 0 2px; }
.meter > span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
.meter.high > span { background: #d9534f; }
details.top-keys ul, ul.local-groups { margin: 4px 0 0; padding-left: 18px; font-size: 12px; }
.clear-confirm input.clear-name { margin-top: 6px; }
details.browser-storage { margin-top: 14px; }
.bisect-bar { margin-top: 10px; }
.profile-plan { margin-top: 6px; }
/* the conflict check */
ul.findings { list-style: none; margin: 6px 0 0; padding: 0; }
ul.findings li { border-top: 1px solid var(--line); padding: 4px 0; }
ul.findings li:first-child { border-top: 0; }
ul.findings details { margin: 0; } ul.findings summary { color: var(--fg); }
ul.findings li.note summary { color: var(--muted); }
pre.finding-code { max-height: 80px; margin-top: 2px; }
details.conflict-group > summary { color: var(--fg); padding: 6px 0; }
details.other-lists { margin-top: 14px; }
.other-list { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
.pop.copy-box textarea { min-height: 220px; }
.backup-list label.toggle { white-space: normal; }
footer { margin-top: 20px; }
`;

  // src/ui/copy-box.ts
  function copyBoxWindow({ s, t, act }) {
    const box = s.copyBox;
    if (!box) return null;
    const area = el("textarea", { readonly: true, class: "copy-text", "aria-label": t("copy.byHand.title") }, box.text);
    queueMicrotask(() => {
      if (area.isConnected) {
        area.focus();
        area.select();
      }
    });
    const back = el(
      "div",
      { class: "pop-back", onClick: (e) => {
        if (e.target === back) act.set({ copyBox: null });
      } },
      el(
        "div",
        { class: "pop copy-box", role: "dialog", "aria-modal": "true", "aria-label": t("copy.byHand.title") },
        el(
          "div",
          { class: "pop-head" },
          el("h3", {}, t("copy.byHand.title")),
          el("button", { class: "small", type: "button", "aria-label": t("close"), onClick: () => act.set({ copyBox: null }) }, "✕")
        ),
        el("p", { class: "note" }, t("copy.byHand.body")),
        area
      )
    );
    return back;
  }

  // src/ui/storage.ts
  function storageWindow(v) {
    const { s, t, act } = v;
    const st = s.storage;
    if (!st.open) return null;
    const list = (s.rows ?? []).flatMap((r) => r.extension && r.extension.runtime === "client" ? [r.extension] : []);
    const back = el(
      "div",
      { class: "pop-back", onClick: (e) => {
        if (e.target === back) act.closeStorage();
      } },
      el(
        "div",
        { class: "pop storage", role: "dialog", "aria-modal": "true", "aria-label": t("storage.title") },
        el(
          "div",
          { class: "pop-head" },
          el("h3", {}, t("storage.title"), help(t("help.storage"))),
          el(
            "div",
            { class: "row" },
            el("button", { class: "small", type: "button", disabled: st.measuring || s.busy, onClick: () => void act.measureStorage() }, st.measuring ? t("storage.measuring") : t("storage.measure")),
            el("button", { class: "small", type: "button", "aria-label": t("close"), onClick: act.closeStorage }, "✕")
          )
        ),
        message(st.message),
        st.reload ? el("div", { class: "actions" }, el("span", { class: "muted" }, t("storage.reloadHint")), el("button", { class: "small primary", type: "button", onClick: act.reloadPage }, t("storage.reload"))) : null,
        list.length ? el("ul", { class: "storage-list" }, ...list.map((x) => storageItem(v, x))) : el("p", { class: "muted" }, s.rowsError ?? t("items.empty")),
        browserBlock(v)
      )
    );
    return back;
  }
  function storageItem(v, x) {
    const { s, t, act, host } = v;
    const st = s.storage;
    const m = st.measured.get(x.id);
    const self = host.extensionId === null || x.id === host.extensionId;
    const size = !m ? el("div", { class: "muted line" }, st.measuring ? t("storage.measuring") : "—") : m.status === "off" ? el("div", { class: "muted line" }, t("storage.off")) : m.status === "failed" ? el("div", { class: "muted line" }, t("storage.failed", { error: describeError(m.error, t, { name: x.name }) })) : sizeBlock(v, x, m.bytes, m.top);
    const can = m?.status === "ok";
    const file = el("input", {
      type: "file",
      accept: "application/json,.json",
      class: "restore-file",
      hidden: true,
      onChange: (e) => {
        const input = e.target;
        const chosen = input.files?.[0];
        input.value = "";
        if (chosen) void chosen.text().then((text2) => act.onRestoreFile(x, text2));
      }
    });
    return el(
      "li",
      { "data-extension": x.id },
      el(
        "div",
        { class: "row between" },
        el("span", { class: "name" }, x.name),
        el(
          "div",
          { class: "row" },
          el("button", { class: "small", type: "button", disabled: !can || s.busy, onClick: () => act.onBackup(x) }, t("storage.backup")),
          self ? null : el("button", { class: "small", type: "button", disabled: !can || s.busy, onClick: () => file.click() }, t("storage.restore")),
          self ? null : file,
          self ? null : el("button", { class: "small", type: "button", disabled: !can || s.busy, onClick: () => act.startClear(x) }, t("storage.clear"))
        )
      ),
      size,
      restoreConfirm(v, x),
      clearConfirm(v, x)
    );
  }
  function sizeBlock({ t }, x, bytes, top) {
    const share = Math.min(1, bytes / STORAGE_LIMIT_BYTES);
    return el(
      "div",
      { class: "line" },
      el(
        "div",
        { class: `meter${share > 0.8 ? " high" : ""}`, role: "meter", "aria-valuemin": "0", "aria-valuemax": String(STORAGE_LIMIT_BYTES), "aria-valuenow": String(bytes), "aria-label": t("storage.of", { size: formatBytes(bytes) }) },
        el("span", { style: `width:${(share * 100).toFixed(1)}%` })
      ),
      el("div", { class: "muted" }, t("storage.of", { size: formatBytes(bytes) }), ` · ${(share * 100).toFixed(1)}%`),
      top.length ? el(
        "details",
        { class: "top-keys" },
        el("summary", {}, t("storage.topKeys", { count: top.length })),
        el("ul", {}, ...top.map((k) => el("li", {}, el("code", {}, k.key), ` ${formatBytes(k.bytes)}`)))
      ) : null
    );
  }
  function restoreConfirm({ s, t, act }, x) {
    const r = s.storage.restore;
    if (!r || r.id !== x.id) return null;
    const p = r.plan;
    return el(
      "div",
      { class: "msg warn restore-confirm" },
      el("div", { style: "font-weight:600" }, t("storage.restore.title", { name: x.name, size: formatBytes(p.bytes) })),
      p.warnings.includes("other-name") ? el("p", { class: "line" }, t("storage.restore.otherName", { from: p.from?.name ?? "?", name: x.name })) : null,
      p.warnings.includes("other-version") ? el("p", { class: "line" }, t("storage.restore.otherVersion", { from: p.from?.version ?? "?", version: x.version ?? "?" })) : null,
      el("p", { class: "line" }, t("storage.restore.body")),
      el(
        "div",
        { class: "actions" },
        el("button", { class: "small primary", type: "button", disabled: s.busy, onClick: () => act.onRestore(x) }, t("storage.restore.go")),
        el("button", { class: "small", type: "button", onClick: act.cancelStorageQuestion }, t("action.cancel"))
      )
    );
  }
  function clearConfirm({ s, t, act }, x) {
    const c = s.storage.clear;
    if (!c || c.id !== x.id) return null;
    const cancel = el("button", { class: "small", type: "button", onClick: act.cancelStorageQuestion }, t("action.cancel"));
    if (c.step === 1) {
      return el(
        "div",
        { class: "msg warn clear-confirm" },
        el("p", { class: "line" }, t("storage.clear.first", { name: x.name })),
        el("div", { class: "actions" }, el("button", { class: "small primary", type: "button", disabled: s.busy, onClick: () => act.onClearBackup(x) }, t("storage.clear.backup")), cancel)
      );
    }
    const box = el("input", { type: "text", class: "clear-name", "aria-label": t("storage.clear.type", { name: x.name }), placeholder: x.name, value: c.typed, "data-focus": `clear-name:${x.id}`, autocomplete: "off", spellcheck: "false" });
    const go = el("button", { class: "small primary", type: "button", disabled: s.busy || c.typed.trim() !== x.name.trim(), onClick: () => act.onClear(x) }, t("storage.clear.go"));
    box.addEventListener("input", () => {
      c.typed = box.value;
      go.disabled = s.busy || c.typed.trim() !== x.name.trim();
    });
    return el(
      "div",
      { class: "msg loud clear-confirm" },
      el("p", { class: "line", style: "font-weight:400" }, t("storage.clear.type", { name: x.name })),
      box,
      el("div", { class: "actions" }, go, cancel)
    );
  }
  function browserBlock({ s, t }) {
    const b = s.storage.browser;
    if (!b) return null;
    return el(
      "details",
      { class: "browser-storage" },
      el("summary", {}, t("storage.browser"), help(t("help.storage.browser"))),
      b.usage !== null ? el("p", { class: "line" }, t("storage.browser.usage", { usage: formatBytes(b.usage), quota: b.quota !== null ? formatBytes(b.quota) : "?" })) : null,
      el("div", { class: "muted line" }, "localStorage"),
      b.local.length ? el("ul", { class: "local-groups" }, ...b.local.map((g) => el("li", {}, el("code", {}, g.name), ` ${t("storage.browser.keys", { count: g.keys })} · ${formatBytes(g.bytes)}`))) : el("p", { class: "muted" }, t("preview.none")),
      el("div", { class: "muted line" }, "IndexedDB"),
      b.databases === null ? el("p", { class: "muted" }, t("storage.browser.noList")) : b.databases.length ? el("ul", { class: "local-groups" }, ...b.databases.map((n) => el("li", {}, el("code", {}, n)))) : el("p", { class: "muted" }, t("preview.none"))
    );
  }

  // src/ui/tools.ts
  var ackBox = (label, checked, onTick, cls) => el(
    "label",
    { class: "toggle", style: "white-space:normal;color:inherit" },
    el("input", { type: "checkbox", class: cls, checked, onChange: (e) => onTick(checkedOf(e)) }),
    label
  );
  function reloadLine({ s, t, act }) {
    return s.toolsReload ? el("div", { class: "actions" }, el("span", { class: "muted" }, t("switch.reloadHint")), el("button", { class: "small primary", type: "button", onClick: act.reloadPage }, t("storage.reload"))) : null;
  }
  function pop(v, cls, title, helpText, ...body2) {
    const { t, act } = v;
    const back = el(
      "div",
      { class: "pop-back", onClick: (e) => {
        if (e.target === back) act.closeTools();
      } },
      el(
        "div",
        { class: `pop ${cls}`, role: "dialog", "aria-modal": "true", "aria-label": title },
        el(
          "div",
          { class: "pop-head" },
          el("h3", {}, title, help(helpText)),
          el("button", { class: "small", type: "button", "aria-label": t("close"), onClick: act.closeTools }, "✕")
        ),
        ...body2
      )
    );
    return back;
  }
  function toolsWindow(v) {
    if (v.s.tools === "profiles") return profilesWindow(v);
    if (v.s.tools === "bisect") return bisectWindow(v);
    if (v.s.tools === "backup") return backupWindow(v);
    return null;
  }
  function profilesWindow(v) {
    const { s, t, act, render } = v;
    const name = el("input", { type: "text", class: "profile-name", "aria-label": t("profiles.name"), placeholder: t("profiles.name"), "data-focus": "profile-name", maxlength: "40" });
    const save = () => {
      if (name.value.trim()) void act.onSaveProfile(name.value);
    };
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    const plan = s.profilePlan;
    return pop(
      v,
      "profiles",
      t("profiles.title"),
      t("help.profiles"),
      el("div", { class: "row" }, name, el("button", { class: "small primary", type: "button", disabled: s.busy, onClick: save }, t("profiles.save"))),
      el("p", { class: "note" }, t("profiles.count", { count: s.profiles.length, max: PROFILE_LIMIT })),
      s.profiles.length ? el("ul", { class: "catalog-list profile-list" }, ...s.profiles.map((p) => el(
        "li",
        { "data-profile": p.id },
        el(
          "div",
          { class: "row between" },
          el("span", {}, el("span", { class: "name" }, p.name), " ", el("span", { class: "muted" }, t("profiles.size", { count: p.ids.length }))),
          el(
            "div",
            { class: "row" },
            el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.onPlanProfile(p.id) }, t("profiles.apply")),
            el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => act.onDeleteProfile(p.id) }, t("organize.delete"))
          )
        ),
        el("div", { class: "muted line" }, p.ids.map(act.nameOf).join(", ") || t("preview.none")),
        plan?.id === p.id ? el(
          "div",
          { class: "msg warn profile-plan" },
          plan.plan.off.length ? el("div", {}, t("switch.willOff", { names: plan.plan.off.map((x) => x.name).join(", ") })) : null,
          plan.plan.on.length ? el("div", {}, t("switch.willOn", { names: plan.plan.on.map((x) => x.name).join(", ") })) : null,
          plan.plan.needsApproval.length ? el("div", {}, t("switch.needsApproval", { names: plan.plan.needsApproval.map((x) => x.name).join(", ") })) : null,
          plan.plan.missing.length ? el("div", {}, t("switch.missing", { count: plan.plan.missing.length })) : null,
          !plan.plan.off.length && !plan.plan.on.length ? el("div", {}, t("switch.nothing")) : null,
          plan.plan.fullPage ? ackBox(t("enable.ack.fullPage"), plan.ack, (on) => {
            plan.ack = on;
            render();
          }, "ack-full-page") : null,
          el(
            "div",
            { class: "actions" },
            el("button", { class: "small primary", type: "button", disabled: s.busy || plan.plan.fullPage && !plan.ack || !plan.plan.off.length && !plan.plan.on.length, onClick: act.onApplyProfile }, t("profiles.apply")),
            el("button", { class: "small", type: "button", onClick: () => act.set({ profilePlan: null }) }, t("action.cancel"))
          )
        ) : null
      ))) : el("p", { class: "muted" }, t("profiles.none")),
      message(s.toolsMessage),
      reloadLine(v)
    );
  }
  function bisectWindow(v) {
    const { s, t, act, host, render } = v;
    const on = (s.rows ?? []).flatMap((r) => r.extension && r.extension.enabled && r.extension.id !== host.extensionId ? [r.extension] : []);
    const fullPage = on.some((x) => x.capabilities.includes("full_page_access"));
    return pop(
      v,
      "bisect",
      t("bisect.title"),
      t("help.bisect"),
      el("p", { class: "note" }, t("bisect.intro")),
      el("p", { class: "note" }, t("bisect.limits")),
      el("div", { class: "muted line" }, t("bisect.onNow", { count: on.length }), on.length ? ` ${on.map((x) => x.name).join(", ")}` : ""),
      fullPage ? ackBox(t("bisect.ack"), s.bisectAck, (ok) => {
        s.bisectAck = ok;
        render();
      }, "ack-full-page") : null,
      el("div", { class: "actions" }, el("button", { class: "small primary", type: "button", disabled: s.busy || !on.length || fullPage && !s.bisectAck, onClick: act.onStartBisect }, t("bisect.start"))),
      message(s.toolsMessage)
    );
  }
  function backupWindow(v) {
    const { s, t, act } = v;
    const candidates = act.backupCandidates();
    const file = el("input", {
      type: "file",
      accept: "application/json,.json",
      class: "full-restore-file",
      hidden: true,
      onChange: (e) => {
        const input = e.target;
        const chosen = input.files?.[0];
        input.value = "";
        if (chosen) void chosen.text().then((text2) => act.onFullRestore(text2));
      }
    });
    return pop(
      v,
      "backup",
      t("backup.title"),
      t("help.backup"),
      el("p", { class: "note" }, t("backup.intro")),
      candidates.length ? el("ul", { class: "catalog-list backup-list" }, ...candidates.map((x) => el(
        "li",
        {},
        el(
          "label",
          { class: "toggle" },
          el("input", { type: "checkbox", "data-focus": `backup:${x.id}`, checked: s.backupPicked.has(x.id), onChange: (e) => act.pickBackup(x.id, checkedOf(e)) }),
          el("span", { class: "name" }, x.name)
        )
      ))) : el("p", { class: "muted" }, t("backup.noData")),
      el(
        "div",
        { class: "actions" },
        el("button", { class: "small primary", type: "button", disabled: s.busy, onClick: act.onFullBackup }, t("backup.save")),
        el("button", { class: "small", type: "button", disabled: s.busy, onClick: () => file.click() }, t("backup.restore")),
        file
      ),
      el("p", { class: "note" }, t("backup.restoreNote")),
      message(s.toolsMessage)
    );
  }
  function bisectBar(v) {
    const { s, t, act } = v;
    const b = s.bisect;
    if (!b) return null;
    const small = (label, onClick, primary = false) => el("button", { class: `small${primary ? " primary" : ""}`, type: "button", disabled: s.busy, onClick }, label);
    if (b.found !== void 0) {
      const name = b.found ? act.nameOf(b.found) : null;
      return el(
        "div",
        { class: "msg info bisect-bar" },
        el("div", { style: "font-weight:600" }, name ? t("bisect.found", { name, steps: b.steps }) : t("bisect.notFound")),
        el(
          "div",
          { class: "actions" },
          small(t("bisect.restore"), () => act.onBisectRestore(false), !name),
          name ? small(t("bisect.restoreWithout", { name }), () => act.onBisectRestore(true), true) : null
        ),
        message(s.toolsMessage),
        reloadLine(v)
      );
    }
    return el(
      "div",
      { class: "msg warn bisect-bar" },
      el("div", { style: "font-weight:600" }, t("bisect.question", { left: b.suspects.length })),
      el("div", { class: "muted line" }, t("bisect.testing", { names: b.testing.map(act.nameOf).join(", ") || t("bisect.allOff") })),
      el(
        "div",
        { class: "actions" },
        small(t("bisect.yes"), () => act.onBisectAnswer(true), true),
        small(t("bisect.no"), () => act.onBisectAnswer(false), true),
        small(t("bisect.stop"), () => act.onBisectRestore(false))
      ),
      message(s.toolsMessage),
      reloadLine(v)
    );
  }

  // src/ui.ts
  var HOST_ELEMENT_ID = "me-fetchy";
  var OPEN_CHECK_EVERY_MS = 30 * 6e4;
  function mountPanel(options) {
    const doc = options.document ?? document;
    const { host, client, store } = options;
    const deps = { fetch: host.fetch, client, store, selfId: host.extensionId };
    const i18n = createTranslator(detectLang(options.language ?? (typeof navigator !== "undefined" ? navigator.language : void 0)));
    const t = (key, params) => i18n.t(key, params);
    const s = createState();
    let isOpen = false;
    const jsDigest = digestBackend() === "javascript";
    const audit = new AuditLog(host.storage);
    deps.audit = audit;
    const hostElement = el("div", { id: HOST_ELEMENT_ID });
    const root = hostElement.attachShadow({ mode: "open" });
    const wrapper = el("div", { class: "root" });
    wrapper.append(el("style", {}, STYLE));
    const panel = el("div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": t("title"), tabindex: "-1" });
    const backdrop = el("div", { class: "backdrop", hidden: true, onClick: (e) => {
      if (e.target === backdrop) close();
    } }, panel);
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (s.copyBox) act.set({ copyBox: null });
      else if (s.wizard) act.closeWizard();
      else if (s.storage.open) act.closeStorage();
      else if (s.tools) act.closeTools();
      else if (s.conflictsOpen) act.closeConflicts();
      else if (s.bundleOpen) {
        s.bundleOpen = false;
        render();
      } else close();
    });
    let focusKey = null;
    panel.addEventListener("focusin", (e) => {
      focusKey = e.target.dataset?.focus ?? null;
    });
    wrapper.append(backdrop);
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
    const toastSlot = el("div", { class: "toast-slot" });
    wrapper.append(toastSlot);
    const core = {
      s,
      host,
      store,
      deps,
      audit,
      i18n,
      t,
      panel,
      render,
      version: options.version,
      open: () => open(),
      async guard(fn) {
        if (s.busy || s.retired) return;
        s.busy = true;
        render();
        try {
          await fn();
        } finally {
          s.busy = false;
          render();
        }
      }
    };
    const act = createActions(core);
    const view = { ...core, act };
    function render() {
      const key = focusKey;
      renderPanel();
      if (key) [...panel.querySelectorAll("[data-focus]")].find((x) => x.dataset.focus === key)?.focus();
    }
    const pending = () => stillNewer(s.peeked, s.records, options.version);
    function renderPanel() {
      const waiting = pending();
      anchor.setDot(s.records.some(hasUpdate) || waiting.length > 0, t("anchor.hasUpdate"));
      toastSlot.replaceChildren(fragment(toast()));
      backdrop.hidden = !isOpen;
      panel.replaceChildren(fragment(
        header(),
        bisectBar(view),
        selfLine(),
        gateLine(view),
        installSection(view),
        s.prepared ? previewSection(view, s.prepared) : null,
        itemsSection(view),
        bundleWindow(view),
        storageWindow(view),
        toolsWindow(view),
        conflictsWindow(view),
        copyBoxWindow(view),
        wizardWindow(view)
      ));
    }
    function toast() {
      if (isOpen) return null;
      if (s.bisect && !s.toast) {
        return el(
          "div",
          { class: "toast", role: "status" },
          el("div", {}, el("strong", {}, t(s.bisect.found !== void 0 ? "bisect.toast.done" : "bisect.toast"))),
          el("div", { class: "actions" }, el("button", { class: "small primary", type: "button", onClick: () => open() }, t("notify.open")))
        );
      }
      if (!s.toast) return null;
      const names2 = s.toast.map((p) => `${p.key === SELF_KEY ? "Fetchy" : s.records.find((r) => r.id === p.key)?.name ?? "?"} ${p.version}`).join(", ");
      return el(
        "div",
        { class: "toast", role: "status", "aria-live": "polite" },
        el("div", {}, el("strong", {}, t("notify.title", { count: s.toast.length })), " ", el("span", { class: "muted" }, names2)),
        el(
          "div",
          { class: "actions" },
          el("button", { class: "small primary", type: "button", onClick: act.openFromToast }, t("notify.open")),
          el("button", { class: "small", type: "button", onClick: act.dismissToast }, t("notify.later"))
        )
      );
    }
    function selfLine() {
      const self = pending().find((p) => p.key === SELF_KEY);
      if (!self) return null;
      return el(
        "div",
        { class: "msg info self-update row between" },
        el("span", {}, t("self.newVersion", { version: self.version })),
        el("button", { class: "small", type: "button", disabled: s.busy, onClick: act.addSelfSource }, t("self.addSource"))
      );
    }
    function header() {
      const updates = catalogUpdates(s.rows);
      return el(
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
          el("button", {
            class: `small bundle${updates ? " has-update" : ""}`,
            type: "button",
            "data-focus": "bundle",
            title: updates ? t("bundle.hasUpdate") : t("bundle.title"),
            "aria-haspopup": "dialog",
            onClick: () => act.setBundleOpen(true)
          }, el("span", { class: "cake", "aria-hidden": "true" }, "🍰"), " ", t("bundle.button"), updates ? el("span", { class: "dot", role: "img", "aria-label": t("bundle.hasUpdate") }) : null),
          el("button", { class: "small", type: "button", onClick: act.switchLang }, t("lang.switch")),
          el("button", { class: "small", type: "button", "aria-label": t("close"), onClick: () => close() }, "✕")
        )
      );
    }
    function open() {
      isOpen = true;
      s.toast = null;
      render();
      panel.focus();
      void Promise.all([act.loadPolicy(), act.loadRows(), act.loadLog(), act.reconcileRecords()]).then(() => {
        if (!wizardDone && !s.wizard && s.records.length === 0) {
          wizardDone = true;
          act.openWizard();
        }
        render();
        const due = (r) => checkedLongAgo(r, /* @__PURE__ */ new Date(), OPEN_CHECK_EVERY_MS);
        const checks = s.autoCheck && s.records.some(due) && !s.busy ? act.checkRecords(due).then(() => act.runAutoUpdates(false)) : act.checkCatalogQuietly().then(() => render());
        void checks.then(() => act.lookAtReposQuietly());
      });
    }
    function close() {
      isOpen = false;
      s.bundleOpen = false;
      s.reconcileMessage = null;
      s.catalogMessage = null;
      s.catalogResults = [];
      render();
    }
    function toggle() {
      if (isOpen) close();
      else open();
    }
    let notifyCheckedAt = null;
    let wizardDone = false;
    let notifyTimer = null;
    const ready = (async () => {
      try {
        const data = await host.storage.get();
        if (data.lang === "ko" || data.lang === "en") i18n.lang = data.lang;
        s.autoCheck = data.autoCheck !== false;
        s.autoUpdatedAt = typeof data.autoUpdatedAt === "string" ? Date.parse(data.autoUpdatedAt) || 0 : 0;
        s.keepEnabled = data.keepEnabled === true;
        s.organize = normalizeOrganize(data.organize);
        s.notify = data.notifyUpdates !== false;
        wizardDone = data.wizardDone === true;
        s.profiles = parseProfiles(data.profiles);
        s.lists = parseStoredLists(data.catalogs);
        s.bisect = parseBisect(data.bisect);
        s.peeked = parsePeeked(data.peeked);
        notifyCheckedAt = typeof data.notifyCheckedAt === "string" ? data.notifyCheckedAt : null;
      } catch {
      }
      await Promise.all([act.loadPolicy(), act.loadRecords()]);
      render();
      if (s.records.some((r) => r.autoUpdate) && !s.bisect && Date.now() - s.autoUpdatedAt > 6 * 36e5) void act.runAutoUpdates(true);
      if (s.notify && lookDue(notifyCheckedAt, Date.now())) {
        notifyTimer = setTimeout(() => {
          notifyTimer = null;
          void lookForUpdates();
        }, options.notifyDelayMs ?? NOTIFY_DELAY_MS);
      }
    })();
    async function lookForUpdates() {
      if (!s.notify || s.retired) return;
      try {
        const records = await store.load();
        const found = await peekUpdates(records, host.fetch, options.version);
        const data = await host.storage.get();
        const fresh = isOpen ? [] : unnoticed(found, parseNoticed(data.noticed), records);
        s.peeked = found;
        notifyCheckedAt = (/* @__PURE__ */ new Date()).toISOString();
        await host.storage.patch({
          notifyCheckedAt,
          peeked: found,
          ...fresh.length ? { noticed: rememberNoticed(parseNoticed(data.noticed), fresh, records) } : {}
        });
        if (fresh.length) s.toast = fresh;
        render();
      } catch (e) {
        host.log.debug("update notice skipped", e);
      }
    }
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
        if (notifyTimer) clearTimeout(notifyTimer);
        anchor.destroy();
        doc.removeEventListener("keydown", onShortcut);
        hostElement.remove();
      }
    };
  }
  function parsePeeked(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter((p) => !!p && typeof p === "object" && typeof p.key === "string" && typeof p.version === "string");
  }

  // src/index.ts
  var VERSION = true ? "0.9.0" : "0.0.0";
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
