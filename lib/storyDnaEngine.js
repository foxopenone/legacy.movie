import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMediawikiPlot, getTmdbMovie } from "./storyDnaCatalog.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STORE_DIR = join(ROOT, "data", "story-dna");
const PROMPT_PATH = join(ROOT, "prompts", "story_dna_extract.txt");
const GUTENDEX_BASE = "https://gutendex.com";

export const DNA_FIELDS = [
  "high_concept",
  "core_conflict",
  "protagonist_goal",
  "protagonist_flaw",
  "villain_goal",
  "inciting_incident",
  "midpoint_twist",
  "climax",
  "emotional_arc",
  "visual_dna"
];

function text(value) {
  return String(value ?? "").trim();
}

function storeDir() {
  return text(process.env.STORY_DNA_STORE_DIR) || DEFAULT_STORE_DIR;
}

function ensureStore() {
  const dir = storeDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function slugId(title, seed) {
  const base = text(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "story";
  const hash = createHash("sha1").update(String(seed || title)).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function loadExtractPrompt() {
  return readFileSync(PROMPT_PATH, "utf8").trim();
}

export function parseJsonObject(raw) {
  const body = text(raw);
  if (!body) throw new Error("DNA extract returned empty content");
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : body;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("DNA extract did not return JSON object");
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DNA extract JSON must be an object");
  }
  return parsed;
}

export function normalizeDna(rawDna) {
  const source = rawDna && typeof rawDna === "object" && !Array.isArray(rawDna) ? rawDna : {};
  const dna = {};
  const missing = [];
  for (const field of DNA_FIELDS) {
    const value = text(source[field]);
    if (!value) missing.push(field);
    else dna[field] = value;
  }
  if (missing.length) {
    throw new Error(`DNA extract missing fields: ${missing.join(", ")}`);
  }
  return dna;
}

async function fetchJson(url, init, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.detail || payload?.error?.message || payload?.message || JSON.stringify(payload);
      const error = new Error(`HTTP ${response.status}: ${detail}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGutendexBook(gutendexId) {
  const id = Number(gutendexId);
  if (!Number.isInteger(id) || id < 1) throw new Error("gutendex_id must be a positive integer");
  return fetchJson(`${GUTENDEX_BASE}/books/${id}`);
}

export async function searchGutendexBooks(query, { limit = 5 } = {}) {
  const q = text(query);
  if (!q) throw new Error("search query is required");
  const payload = await fetchJson(`${GUTENDEX_BASE}/books/?search=${encodeURIComponent(q)}`);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.slice(0, Math.max(1, Math.min(32, Number(limit) || 5)));
}

function pickSynopsisFromBook(book) {
  const summaries = Array.isArray(book?.summaries)
    ? book.summaries.map((item) => text(item)).filter(Boolean)
    : [];
  if (summaries.length) return summaries.join("\n\n");
  const subjects = Array.isArray(book?.subjects) ? book.subjects.filter(Boolean).join("; ") : "";
  if (subjects) return `Subjects: ${subjects}`;
  return "";
}

async function fetchPlainTextSnippet(book, maxChars = 12000) {
  const formats = book?.formats && typeof book.formats === "object" ? book.formats : {};
  const preferred =
    formats["text/plain; charset=utf-8"] ||
    formats["text/plain"] ||
    Object.entries(formats).find(([mime]) => String(mime).startsWith("text/plain"))?.[1];
  if (!preferred) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(preferred, { signal: controller.signal });
    if (!response.ok) return "";
    const body = await response.text();
    return text(body).slice(0, maxChars);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveGutendexSource({ gutendex_id, search } = {}) {
  let book = null;
  if (gutendex_id != null && text(gutendex_id) !== "") {
    book = await fetchGutendexBook(gutendex_id);
  } else if (text(search)) {
    const hits = await searchGutendexBooks(search, { limit: 1 });
    if (!hits.length) throw new Error(`Gutendex found no books for search: ${search}`);
    book = hits[0];
  } else {
    throw new Error("Provide gutendex_id or search");
  }

  let synopsis = pickSynopsisFromBook(book);
  if (!synopsis) {
    synopsis = await fetchPlainTextSnippet(book);
  }
  if (!synopsis) {
    throw new Error(`Gutendex book ${book.id} has no summary or plain-text source`);
  }

  return {
    title: text(book.title) || `gutendex-${book.id}`,
    synopsis,
    source: {
      kind: "gutendex",
      gutendex_id: book.id,
      tmdb_id: null,
      authors: Array.isArray(book.authors) ? book.authors.map((a) => text(a?.name)).filter(Boolean) : [],
      synopsis
    }
  };
}

export async function resolveTmdbSource({ tmdb_id, enrich } = {}, deps = {}) {
  const getMovie = deps.getTmdbMovie || getTmdbMovie;
  const getWiki = deps.fetchMediawikiPlot || fetchMediawikiPlot;
  const movie = await getMovie(tmdb_id);
  let synopsis = text(movie.overview);
  let mediawiki = null;
  const wantWiki = text(enrich).toLowerCase() === "mediawiki" || synopsis.length < 80;
  if (wantWiki) {
    try {
      mediawiki = await getWiki(movie.title);
      if (text(mediawiki?.plot)) {
        synopsis = [synopsis, text(mediawiki.plot)].filter(Boolean).join("\n\n");
      }
    } catch {
      // overview-only when wiki unavailable
    }
  }
  if (!synopsis) {
    throw new Error(`TMDB movie ${movie.id} has no overview or MediaWiki plot`);
  }
  return {
    title: movie.title || `tmdb-${movie.id}`,
    synopsis,
    source: {
      kind: "tmdb",
      tmdb_id: movie.id,
      gutendex_id: null,
      year: movie.year || "",
      poster_url: movie.poster_url || "",
      genres: movie.genres || [],
      mediawiki_title: mediawiki?.title || null,
      synopsis
    }
  };
}

export async function extractDnaWithGrok({ title, synopsis, fetchImpl = fetch } = {}) {
  const apiKey = text(process.env.XAI_API_KEY);
  if (!apiKey) throw new Error("Missing env: XAI_API_KEY");
  const baseUrl = (text(process.env.XAI_API_BASE_URL) || "https://api.x.ai/v1").replace(/\/+$/, "");
  const model = text(process.env.STORY_DNA_MODEL || process.env.AGENTB_GROK_MODEL) || "grok-4.3";
  const system = loadExtractPrompt();
  const user = [
    `Title: ${text(title)}`,
    "",
    "Synopsis:",
    text(synopsis)
  ].join("\n");

  const requestBody = {
    model,
    max_tokens: 1200,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(10000, Number(process.env.STORY_DNA_TIMEOUT_MS || 120000)));
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || JSON.stringify(payload);
      const error = new Error(`Grok/xAI error ${response.status}: ${detail}`);
      error.status = response.status;
      throw error;
    }
    const content = text(payload?.choices?.[0]?.message?.content || payload?.output_text || payload?.text);
    return normalizeDna(parseJsonObject(content));
  } finally {
    clearTimeout(timer);
  }
}

const MAX_FAVORITES = 20;
const MAX_JOB_DNA = 2;
const DEFAULT_PREFS_DIR = join(ROOT, "data", "story-dna-prefs");

function prefsDir() {
  return text(process.env.STORY_DNA_PREFS_DIR) || DEFAULT_PREFS_DIR;
}

function ensurePrefsDir() {
  const dir = prefsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeRecord(record) {
  const source = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  return {
    ...source,
    created_by: text(source.created_by) || null
  };
}

export function stableDnaId(sourceKind, externalId) {
  const kind = text(sourceKind).toLowerCase();
  const id = Number(externalId);
  if ((kind !== "tmdb" && kind !== "gutendex") || !Number.isInteger(id) || id < 1) {
    throw new Error("stableDnaId requires tmdb|gutendex and positive integer id");
  }
  return `${kind}-${id}`;
}

export function saveDnaRecord(record) {
  const dir = ensureStore();
  const normalized = normalizeRecord(record);
  const id = text(normalized?.id);
  if (!id) throw new Error("record.id is required");
  const path = join(dir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function getDnaRecord(id) {
  const key = text(id);
  if (!key) throw new Error("id is required");
  const path = join(ensureStore(), `${key}.json`);
  if (!existsSync(path)) {
    const error = new Error(`DNA not found: ${key}`);
    error.status = 404;
    throw error;
  }
  return normalizeRecord(JSON.parse(readFileSync(path, "utf8")));
}

export function listDnaRecords() {
  const dir = ensureStore();
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const record = normalizeRecord(JSON.parse(readFileSync(join(dir, name), "utf8")));
      return {
        id: record.id || name.replace(/\.json$/i, ""),
        title: record.title || "",
        source_kind: record?.source?.kind || "",
        external_id: record?.source?.tmdb_id || record?.source?.gutendex_id || null,
        created_by: record.created_by || null,
        created_at: record.created_at || ""
      };
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function projectDnaReference(record) {
  const normalized = normalizeRecord(record);
  return {
    id: text(normalized.id),
    title: text(normalized.title),
    dna: normalizeDna(normalized.dna || {})
  };
}

export function getDnaRecordsByIds(ids = []) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((item) => text(item))
    .filter(Boolean);
  const unique = [...new Set(list)].slice(0, MAX_JOB_DNA);
  const items = [];
  for (const id of unique) {
    try {
      items.push(projectDnaReference(getDnaRecord(id)));
    } catch {
      // skip missing
    }
  }
  return items;
}

/** @deprecated global Active removed; kept empty for old callers */
export function listActiveDnaRecords() {
  return [];
}

export function deleteDnaRecord(id) {
  const key = text(id);
  if (!key) throw new Error("id is required");
  const path = join(ensureStore(), `${key}.json`);
  if (!existsSync(path)) {
    const error = new Error(`DNA not found: ${key}`);
    error.status = 404;
    throw error;
  }
  unlinkSync(path);
  return { id: key, deleted: true };
}

function sanitizeUserId(userId) {
  const raw = text(userId);
  if (!raw) {
    const error = new Error("user_id is required");
    error.status = 400;
    throw error;
  }
  const safe = raw.replace(/[^a-zA-Z0-9_@.-]/g, "_").slice(0, 128);
  if (!safe) {
    const error = new Error("user_id is invalid");
    error.status = 400;
    throw error;
  }
  return safe;
}

export function getUserFavorites(userId) {
  const id = sanitizeUserId(userId);
  const path = join(ensurePrefsDir(), `${id}.json`);
  if (!existsSync(path)) {
    return { user_id: id, favorite_ids: [], updated_at: null };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const favorite_ids = (Array.isArray(parsed?.favorite_ids) ? parsed.favorite_ids : [])
    .map((item) => text(item))
    .filter(Boolean)
    .slice(0, MAX_FAVORITES);
  return {
    user_id: id,
    favorite_ids,
    updated_at: text(parsed?.updated_at) || null
  };
}

export function setUserFavorites(userId, favoriteIds = []) {
  const id = sanitizeUserId(userId);
  const favorite_ids = [...new Set((Array.isArray(favoriteIds) ? favoriteIds : []).map((item) => text(item)).filter(Boolean))]
    .slice(0, MAX_FAVORITES);
  const payload = {
    user_id: id,
    favorite_ids,
    updated_at: new Date().toISOString()
  };
  writeFileSync(join(ensurePrefsDir(), `${id}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function addUserFavorite(userId, dnaId) {
  const prefs = getUserFavorites(userId);
  const next = [text(dnaId), ...prefs.favorite_ids.filter((item) => item !== text(dnaId))].filter(Boolean);
  return setUserFavorites(userId, next);
}

export function removeUserFavorite(userId, dnaId) {
  const prefs = getUserFavorites(userId);
  return setUserFavorites(userId, prefs.favorite_ids.filter((item) => item !== text(dnaId)));
}

export function listUserFavoriteRecords(userId) {
  const prefs = getUserFavorites(userId);
  return prefs.favorite_ids.map((id) => {
    try {
      const record = getDnaRecord(id);
      return {
        id: record.id,
        title: record.title,
        source_kind: record?.source?.kind || "",
        created_at: record.created_at || ""
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export async function ingestStoryDna(input = {}, deps = {}) {
  const extract = deps.extractDna || extractDnaWithGrok;
  const resolveGutendex = deps.resolveGutendex || resolveGutendexSource;
  const resolveTmdb = deps.resolveTmdb || resolveTmdbSource;
  const userId = text(input.user_id);
  if (!userId) {
    const error = new Error("user_id is required for ingest");
    error.status = 400;
    throw error;
  }

  const sourceKind = text(input.source).toLowerCase();
  const tmdbId = input.tmdb_id != null ? Number(input.tmdb_id) : null;
  const gutendexId = input.gutendex_id != null ? Number(input.gutendex_id) : null;
  const enrich = input.enrich;

  let kind = sourceKind;
  let externalId = null;
  if (kind === "tmdb" || (tmdbId && !kind)) {
    kind = "tmdb";
    externalId = tmdbId;
  } else if (kind === "gutendex" || (gutendexId && !kind)) {
    kind = "gutendex";
    externalId = gutendexId;
  } else {
    const error = new Error("Ingest requires source tmdb|gutendex and a numeric id (manual text ingest disabled)");
    error.status = 400;
    throw error;
  }
  if (!Number.isInteger(externalId) || externalId < 1) {
    const error = new Error(`${kind}_id must be a positive integer`);
    error.status = 400;
    throw error;
  }

  const dnaId = stableDnaId(kind, externalId);
  let existing = null;
  try {
    existing = getDnaRecord(dnaId);
  } catch {
    existing = null;
  }

  if (existing) {
    const prefs = addUserFavorite(userId, dnaId);
    return {
      record: existing,
      deduped: true,
      favorite_ids: prefs.favorite_ids
    };
  }

  let resolved;
  if (kind === "tmdb") {
    resolved = await resolveTmdb({ tmdb_id: externalId, enrich }, deps);
  } else {
    resolved = await resolveGutendex({ gutendex_id: externalId });
  }

  const dna = await extract({ title: resolved.title, synopsis: resolved.synopsis });
  const record = saveDnaRecord({
    id: dnaId,
    title: resolved.title,
    source: resolved.source,
    dna,
    created_by: sanitizeUserId(userId),
    created_at: new Date().toISOString()
  });
  const prefs = addUserFavorite(userId, dnaId);
  return {
    record,
    deduped: false,
    favorite_ids: prefs.favorite_ids
  };
}

/** @deprecated */
export function patchDnaRecord() {
  const error = new Error("Global Active/Approve patch removed; use favorites and job story_dna_ids");
  error.status = 410;
  throw error;
}
