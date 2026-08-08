const GUTENDEX_BASE = "https://gutendex.com";
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const ARCHIVE_SEARCH = "https://archive.org/advancedsearch.php";
const ARCHIVE_META = "https://archive.org/metadata";
const USER_AGENT = "legacy.movie/1.0 (https://legacy.movie; Story DNA engine; open-source)";

function text(value) {
  return String(value ?? "").trim();
}

export function normalizeWikidataId(value) {
  const match = text(value).toUpperCase().match(/Q(\d+)/);
  return match ? `Q${match[1]}` : "";
}

/** Archive.org item identifiers: letters, digits, _ . - */
export function normalizeArchiveId(value) {
  const id = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(id)) return "";
  return id;
}

function archiveThumb(identifier) {
  const id = normalizeArchiveId(identifier);
  return id ? `https://archive.org/services/img/${encodeURIComponent(id)}` : "";
}

function stripHtml(value) {
  return text(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function projectArchiveDoc(doc) {
  const source = doc && typeof doc === "object" ? doc : {};
  const id = normalizeArchiveId(source.identifier);
  const description = Array.isArray(source.description)
    ? source.description.map(stripHtml).filter(Boolean).join("\n\n")
    : stripHtml(source.description);
  const creators = Array.isArray(source.creator)
    ? source.creator.map((item) => text(item)).filter(Boolean)
    : text(source.creator) ? [text(source.creator)] : [];
  return {
    id,
    title: text(source.title) || id,
    year: text(source.year || source.date).slice(0, 4),
    overview: description.slice(0, 1200),
    poster_url: archiveThumb(id),
    authors: creators,
    source_kind: "archive"
  };
}

async function fetchJson(url, init, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(init?.headers || {})
      },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.status_message || payload?.detail || payload?.error?.message || payload?.message || JSON.stringify(payload);
      const error = new Error(`HTTP ${response.status}: ${detail}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function commonsThumb(filename) {
  const name = text(filename).replace(/^File:/i, "");
  if (!name) return "";
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=342`;
}

function claimMainsnak(entity, property) {
  const claims = entity?.claims?.[property];
  if (!Array.isArray(claims) || !claims.length) return null;
  return claims[0]?.mainsnak || null;
}

function claimYear(entity) {
  const snak = claimMainsnak(entity, "P577");
  const time = text(snak?.datavalue?.value?.time);
  const match = time.match(/([+-]?\d{1,4})/);
  return match ? String(Math.abs(Number(match[1]))) : "";
}

function claimImage(entity) {
  const snak = claimMainsnak(entity, "P18");
  return commonsThumb(snak?.datavalue?.value);
}

function claimGenreIds(entity) {
  const claims = Array.isArray(entity?.claims?.P136) ? entity.claims.P136 : [];
  return claims
    .map((claim) => normalizeWikidataId(claim?.mainsnak?.datavalue?.value?.id))
    .filter(Boolean);
}

function projectWikidataFilm(entity, { genreLabels = {} } = {}) {
  const id = normalizeWikidataId(entity?.id);
  const title = text(entity?.labels?.en?.value) || id;
  const overview = text(entity?.descriptions?.en?.value);
  const genreIds = claimGenreIds(entity);
  return {
    id,
    title,
    year: claimYear(entity),
    overview,
    poster_url: claimImage(entity),
    genres: genreIds.map((gid) => genreLabels[gid] || gid).filter(Boolean),
    genre_ids: genreIds,
    enwiki_title: text(entity?.sitelinks?.enwiki?.title),
    source_kind: "wikidata"
  };
}

async function sparqlSelect(query) {
  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;
  const payload = await fetchJson(url, {
    headers: {
      accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT
    }
  }, 60000);
  return Array.isArray(payload?.results?.bindings) ? payload.results.bindings : [];
}

export async function listWikidataPopular({ page = 1 } = {}) {
  const pageNum = Math.max(1, Math.min(50, Number(page) || 1));
  const pageSize = 20;
  const offset = (pageNum - 1) * pageSize;
  const query = `
SELECT ?item ?itemLabel ?year ?image ?desc WHERE {
  ?item wdt:P31/wdt:P279* wd:Q11424.
  ?item wikibase:sitelinks ?links.
  OPTIONAL { ?item wdt:P577 ?date. BIND(YEAR(?date) AS ?year) }
  OPTIONAL { ?item wdt:P18 ?image. }
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?links)
LIMIT ${pageSize}
OFFSET ${offset}
`.trim();
  const rows = await sparqlSelect(query);
  const results = rows.map((row) => {
    const id = normalizeWikidataId(row?.item?.value);
    const image = text(row?.image?.value);
    const file = image.includes("Special:FilePath/")
      ? decodeURIComponent(image.split("Special:FilePath/")[1] || "")
      : image.replace(/^.*\//, "");
    return {
      id,
      title: text(row?.itemLabel?.value) || id,
      year: text(row?.year?.value),
      overview: text(row?.desc?.value),
      poster_url: image
        ? (image.includes("wiki/Special:FilePath") ? `${image}${image.includes("?") ? "&" : "?"}width=342` : commonsThumb(file))
        : "",
      source_kind: "wikidata"
    };
  }).filter((item) => item.id);

  return {
    page: pageNum,
    total_pages: pageNum + (results.length === pageSize ? 1 : 0),
    total_results: results.length,
    results,
    attribution: "Film data from Wikidata"
  };
}

const FILM_INSTANCE_IDS = new Set([
  "Q11424", // film
  "Q24869", // feature film
  "Q202866", // animated film
  "Q506240", // television film
  "Q229390", // 3D film
  "Q226730", // silent film
  "Q1535153", // short film
  "Q1361932", // drama film (sometimes used as instance)
]);

function isFilmEntity(entity) {
  const claims = Array.isArray(entity?.claims?.P31) ? entity.claims.P31 : [];
  return claims.some((claim) => FILM_INSTANCE_IDS.has(normalizeWikidataId(claim?.mainsnak?.datavalue?.value?.id)));
}

export async function searchWikidataFilms(query, { limit = 12 } = {}) {
  const q = text(query);
  if (!q) throw new Error("search query is required");
  const cap = Math.max(1, Math.min(30, Number(limit) || 12));

  // Prefer SPARQL EntitySearch constrained to films.
  const sparql = `
SELECT DISTINCT ?item ?itemLabel ?year ?image ?desc WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "EntitySearch".
    bd:serviceParam wikibase:endpoint "www.wikidata.org".
    bd:serviceParam mwapi:search "${q.replace(/"/g, "")}".
    bd:serviceParam mwapi:language "en".
    bd:serviceParam wikibase:limit ${Math.max(cap * 3, 20)}.
    ?item wikibase:apiOutputItem mwapi:item.
  }
  ?item wdt:P31/wdt:P279* wd:Q11424.
  OPTIONAL { ?item wdt:P577 ?date. BIND(YEAR(?date) AS ?year) }
  OPTIONAL { ?item wdt:P18 ?image. }
  OPTIONAL { ?item schema:description ?desc. FILTER(LANG(?desc) = "en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT ${cap}
`.trim();

  try {
    const rows = await sparqlSelect(sparql);
    const results = rows.map((row) => {
      const id = normalizeWikidataId(row?.item?.value);
      const image = text(row?.image?.value);
      return {
        id,
        title: text(row?.itemLabel?.value) || id,
        year: text(row?.year?.value),
        overview: text(row?.desc?.value),
        poster_url: image
          ? (image.includes("Special:FilePath")
            ? `${image}${image.includes("?") ? "&" : "?"}width=342`
            : commonsThumb(image.replace(/^.*\//, "")))
          : "",
        source_kind: "wikidata"
      };
    }).filter((item) => item.id);
    if (results.length) {
      return {
        page: 1,
        total_pages: 1,
        total_results: results.length,
        results,
        attribution: "Film data from Wikidata"
      };
    }
  } catch {
    // fall through to wbsearchentities + film filter
  }

  const url =
    `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(q)}` +
    `&language=en&uselang=en&type=item&limit=${Math.min(50, cap * 4)}&format=json&origin=*`;
  const payload = await fetchJson(url);
  const hits = Array.isArray(payload?.search) ? payload.search : [];
  const ids = hits.map((hit) => normalizeWikidataId(hit?.id)).filter(Boolean);
  if (!ids.length) {
    return { page: 1, total_pages: 1, total_results: 0, results: [], attribution: "Film data from Wikidata" };
  }
  const entities = await getWikidataEntities(ids);
  const results = ids
    .map((id) => entities[id])
    .filter((entity) => entity && !entity.missing && isFilmEntity(entity))
    .map((entity) => projectWikidataFilm(entity))
    .filter((item) => item.id && item.title)
    .slice(0, cap);
  return {
    page: 1,
    total_pages: 1,
    total_results: results.length,
    results,
    attribution: "Film data from Wikidata"
  };
}

export async function getWikidataEntities(ids = []) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(normalizeWikidataId).filter(Boolean))].slice(0, 50);
  if (!list.length) return {};
  const url =
    `${WIKIDATA_API}?action=wbgetentities&ids=${encodeURIComponent(list.join("|"))}` +
    `&props=labels|descriptions|claims|sitelinks&languages=en&format=json&origin=*`;
  const payload = await fetchJson(url);
  return payload?.entities && typeof payload.entities === "object" ? payload.entities : {};
}

export async function getWikidataFilm(wikidataId) {
  const id = normalizeWikidataId(wikidataId);
  if (!id) throw new Error("wikidata_id must look like Q123");
  const entities = await getWikidataEntities([id]);
  const entity = entities[id];
  if (!entity || entity.missing) {
    const error = new Error(`Wikidata item not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const genreIds = claimGenreIds(entity);
  let genreLabels = {};
  if (genreIds.length) {
    const genreEntities = await getWikidataEntities(genreIds.slice(0, 12));
    genreLabels = Object.fromEntries(
      Object.entries(genreEntities).map(([gid, item]) => [gid, text(item?.labels?.en?.value) || gid])
    );
  }
  return {
    ...projectWikidataFilm(entity, { genreLabels }),
    attribution: "Film data from Wikidata"
  };
}

export async function fetchMediawikiPlot(title, { maxChars = 8000 } = {}) {
  const q = text(title);
  if (!q) throw new Error("title is required");

  const searchUrl =
    `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
    `&srlimit=1&format=json&origin=*`;
  const searchPayload = await fetchJson(searchUrl);
  const hit = Array.isArray(searchPayload?.query?.search) ? searchPayload.query.search[0] : null;
  const pageTitle = text(hit?.title) || q;

  const extractUrl =
    `${WIKI_API}?action=query&prop=extracts&explaintext=1&exsectionformat=plain` +
    `&titles=${encodeURIComponent(pageTitle)}&format=json&origin=*`;
  const extractPayload = await fetchJson(extractUrl);
  const pages = extractPayload?.query?.pages && typeof extractPayload.query.pages === "object"
    ? Object.values(extractPayload.query.pages)
    : [];
  const page = pages[0] || {};
  const extract = text(page.extract);
  if (!extract) {
    const error = new Error(`MediaWiki found no plot text for: ${pageTitle}`);
    error.status = 404;
    throw error;
  }
  return {
    title: text(page.title) || pageTitle,
    pageid: page.pageid || null,
    plot: extract.slice(0, Math.max(500, Number(maxChars) || 8000)),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent((text(page.title) || pageTitle).replace(/ /g, "_"))}`,
    source_kind: "mediawiki"
  };
}

function projectGutendexBook(book) {
  const source = book && typeof book === "object" ? book : {};
  const formats = source.formats && typeof source.formats === "object" ? source.formats : {};
  const summaries = Array.isArray(source.summaries)
    ? source.summaries.map((item) => text(item)).filter(Boolean)
    : [];
  return {
    id: Number(source.id) || 0,
    title: text(source.title),
    authors: Array.isArray(source.authors) ? source.authors.map((a) => text(a?.name)).filter(Boolean) : [],
    overview: summaries[0] || "",
    poster_url: text(formats["image/jpeg"]),
    download_count: Number(source.download_count) || 0,
    has_summary: summaries.length > 0,
    languages: Array.isArray(source.languages) ? source.languages : [],
    source_kind: "gutendex"
  };
}

export async function listGutendexPopular({ page = 1 } = {}) {
  const pageNum = Math.max(1, Math.min(100, Number(page) || 1));
  const payload = await fetchJson(`${GUTENDEX_BASE}/books/?sort=popular&page=${pageNum}`);
  const results = Array.isArray(payload?.results) ? payload.results.map(projectGutendexBook) : [];
  const count = Number(payload?.count) || results.length;
  const pageSize = 32;
  return {
    page: pageNum,
    total_pages: Math.max(1, Math.ceil(count / pageSize)),
    total_results: count,
    next: payload?.next || null,
    results
  };
}

export async function searchGutendexCatalog(query, { page = 1 } = {}) {
  const q = text(query);
  if (!q) throw new Error("search query is required");
  const pageNum = Math.max(1, Math.min(100, Number(page) || 1));
  const payload = await fetchJson(
    `${GUTENDEX_BASE}/books/?search=${encodeURIComponent(q)}&page=${pageNum}`
  );
  const results = Array.isArray(payload?.results) ? payload.results.map(projectGutendexBook) : [];
  const count = Number(payload?.count) || results.length;
  return {
    page: pageNum,
    total_pages: Math.max(1, Math.ceil(count / 32)),
    total_results: count,
    results
  };
}

export async function listArchivePopular({ page = 1 } = {}) {
  const pageNum = Math.max(1, Math.min(200, Number(page) || 1));
  const rows = 20;
  const q = "(collection:(feature_films OR classic_movies OR publicdomain) AND mediatype:movies)";
  const url =
    `${ARCHIVE_SEARCH}?q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=date&fl[]=description&fl[]=creator` +
    `&sort[]=downloads+desc&rows=${rows}&page=${pageNum}&output=json`;
  const payload = await fetchJson(url);
  const docs = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
  const total = Number(payload?.response?.numFound) || docs.length;
  const results = docs.map(projectArchiveDoc).filter((item) => item.id);
  return {
    page: pageNum,
    total_pages: Math.max(1, Math.ceil(total / rows)),
    total_results: total,
    results,
    attribution: "Films from the Internet Archive"
  };
}

export async function searchArchiveFilms(query, { page = 1, limit = 20 } = {}) {
  const q = text(query);
  if (!q) throw new Error("search query is required");
  const pageNum = Math.max(1, Math.min(200, Number(page) || 1));
  const rows = Math.max(1, Math.min(50, Number(limit) || 20));
  const lucene =
    `mediatype:movies AND (` +
    `title:(${q}) OR description:(${q}) OR creator:(${q})` +
    `)`;
  const url =
    `${ARCHIVE_SEARCH}?q=${encodeURIComponent(lucene)}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=date&fl[]=description&fl[]=creator` +
    `&sort[]=downloads+desc&rows=${rows}&page=${pageNum}&output=json`;
  const payload = await fetchJson(url);
  const docs = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
  const total = Number(payload?.response?.numFound) || docs.length;
  const results = docs.map(projectArchiveDoc).filter((item) => item.id);
  return {
    page: pageNum,
    total_pages: Math.max(1, Math.ceil(total / rows)),
    total_results: total,
    results,
    attribution: "Films from the Internet Archive"
  };
}

export async function getArchiveFilm(archiveId) {
  const id = normalizeArchiveId(archiveId);
  if (!id) throw new Error("archive_id is invalid");
  const payload = await fetchJson(`${ARCHIVE_META}/${encodeURIComponent(id)}`);
  const meta = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  if (!normalizeArchiveId(meta.identifier || id)) {
    const error = new Error(`Archive.org item not found: ${id}`);
    error.status = 404;
    throw error;
  }
  const projected = projectArchiveDoc({
    identifier: meta.identifier || id,
    title: meta.title,
    year: meta.year || meta.date,
    description: meta.description,
    creator: meta.creator
  });
  if (!projected.overview) {
    // still allow ingest if title exists; MediaWiki can enrich
  }
  return {
    ...projected,
    url: `https://archive.org/details/${encodeURIComponent(projected.id)}`,
    attribution: "Films from the Internet Archive"
  };
}

/** Cross-source search: Wikidata + Archive.org films + Gutendex books. */
export async function searchCatalogCross(query, { limit = 8 } = {}) {
  const q = text(query);
  if (!q) throw new Error("search query is required");
  const cap = Math.max(1, Math.min(20, Number(limit) || 8));

  const [wikidataSettled, archiveSettled, gutendexSettled] = await Promise.allSettled([
    searchWikidataFilms(q, { limit: cap }),
    searchArchiveFilms(q, { page: 1, limit: cap }),
    searchGutendexCatalog(q, { page: 1 })
  ]);

  const wikidata = wikidataSettled.status === "fulfilled"
    ? (wikidataSettled.value.results || []).slice(0, cap)
    : [];
  const archive = archiveSettled.status === "fulfilled"
    ? (archiveSettled.value.results || []).slice(0, cap)
    : [];
  const books = gutendexSettled.status === "fulfilled"
    ? (gutendexSettled.value.results || []).slice(0, cap)
    : [];

  const errors = [];
  if (wikidataSettled.status === "rejected") {
    errors.push({ source: "wikidata", error: String(wikidataSettled.reason?.message || wikidataSettled.reason) });
  }
  if (archiveSettled.status === "rejected") {
    errors.push({ source: "archive", error: String(archiveSettled.reason?.message || archiveSettled.reason) });
  }
  if (gutendexSettled.status === "rejected") {
    errors.push({ source: "gutendex", error: String(gutendexSettled.reason?.message || gutendexSettled.reason) });
  }

  return {
    query: q,
    groups: {
      wikidata,
      archive,
      gutendex: books
    },
    results: [...wikidata, ...archive, ...books],
    errors,
    attribution: "Wikidata · Internet Archive · Project Gutenberg via Gutendex"
  };
}
