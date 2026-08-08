const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE = "https://image.tmdb.org/t/p/w342";
const GUTENDEX_BASE = "https://gutendex.com";
const WIKI_API = "https://en.wikipedia.org/w/api.php";

function text(value) {
  return String(value ?? "").trim();
}

function tmdbKey() {
  const key = text(process.env.TMDB_API_KEY);
  if (!key) {
    const error = new Error("Missing env: TMDB_API_KEY");
    error.status = 503;
    throw error;
  }
  return key;
}

async function fetchJson(url, init, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
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

function posterUrl(path) {
  const p = text(path);
  return p ? `${TMDB_IMAGE}${p.startsWith("/") ? p : `/${p}`}` : "";
}

function projectTmdbMovie(row) {
  const source = row && typeof row === "object" ? row : {};
  const year = text(source.release_date).slice(0, 4);
  return {
    id: Number(source.id) || 0,
    title: text(source.title || source.name),
    year,
    overview: text(source.overview),
    poster_url: posterUrl(source.poster_path),
    vote_average: Number(source.vote_average) || 0,
    genre_ids: Array.isArray(source.genre_ids) ? source.genre_ids : [],
    source_kind: "tmdb"
  };
}

export async function listTmdbPopular({ page = 1, genreId } = {}) {
  const key = tmdbKey();
  const pageNum = Math.max(1, Math.min(500, Number(page) || 1));
  const genre = Number(genreId);
  let url;
  if (Number.isInteger(genre) && genre > 0) {
    url = `${TMDB_BASE}/discover/movie?api_key=${encodeURIComponent(key)}&language=en-US&sort_by=popularity.desc&include_adult=false&page=${pageNum}&with_genres=${genre}`;
  } else {
    url = `${TMDB_BASE}/movie/popular?api_key=${encodeURIComponent(key)}&language=en-US&page=${pageNum}`;
  }
  const payload = await fetchJson(url);
  const results = Array.isArray(payload?.results) ? payload.results.map(projectTmdbMovie) : [];
  return {
    page: Number(payload?.page) || pageNum,
    total_pages: Number(payload?.total_pages) || 1,
    total_results: Number(payload?.total_results) || results.length,
    results
  };
}

export async function searchTmdbMovies(query, { page = 1 } = {}) {
  const q = text(query);
  if (!q) throw new Error("search query is required");
  const key = tmdbKey();
  const pageNum = Math.max(1, Math.min(500, Number(page) || 1));
  const url = `${TMDB_BASE}/search/movie?api_key=${encodeURIComponent(key)}&language=en-US&include_adult=false&page=${pageNum}&query=${encodeURIComponent(q)}`;
  const payload = await fetchJson(url);
  const results = Array.isArray(payload?.results) ? payload.results.map(projectTmdbMovie) : [];
  return {
    page: Number(payload?.page) || pageNum,
    total_pages: Number(payload?.total_pages) || 1,
    total_results: Number(payload?.total_results) || results.length,
    results
  };
}

export async function listTmdbGenres() {
  const key = tmdbKey();
  const payload = await fetchJson(`${TMDB_BASE}/genre/movie/list?api_key=${encodeURIComponent(key)}&language=en-US`);
  const genres = Array.isArray(payload?.genres) ? payload.genres : [];
  return genres.map((item) => ({ id: Number(item.id), name: text(item.name) })).filter((item) => item.id && item.name);
}

export async function getTmdbMovie(tmdbId) {
  const id = Number(tmdbId);
  if (!Number.isInteger(id) || id < 1) throw new Error("tmdb_id must be a positive integer");
  const key = tmdbKey();
  const movie = await fetchJson(`${TMDB_BASE}/movie/${id}?api_key=${encodeURIComponent(key)}&language=en-US`);
  const projected = projectTmdbMovie(movie);
  return {
    ...projected,
    genres: Array.isArray(movie.genres) ? movie.genres.map((g) => text(g?.name)).filter(Boolean) : [],
    runtime: Number(movie.runtime) || 0,
    tagline: text(movie.tagline),
    attribution: "This product uses the TMDB API but is not endorsed or certified by TMDB."
  };
}

export async function fetchMediawikiPlot(title, { maxChars = 8000 } = {}) {
  const q = text(title);
  if (!q) throw new Error("title is required");

  const searchUrl =
    `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
    `&srlimit=1&format=json&origin=*`;
  const searchPayload = await fetchJson(searchUrl, {
    headers: { "Api-User-Agent": "MiniFilmStoryDnaEngine/1.0 (internal DNA research)" }
  });
  const hit = Array.isArray(searchPayload?.query?.search) ? searchPayload.query.search[0] : null;
  const pageTitle = text(hit?.title) || q;

  const extractUrl =
    `${WIKI_API}?action=query&prop=extracts&explaintext=1&exsectionformat=plain` +
    `&titles=${encodeURIComponent(pageTitle)}&format=json&origin=*`;
  const extractPayload = await fetchJson(extractUrl, {
    headers: { "Api-User-Agent": "MiniFilmStoryDnaEngine/1.0 (internal DNA research)" }
  });
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

/** One-shot cross-source search: TMDB + Gutendex in parallel. */
export async function searchCatalogCross(query, { limit = 8 } = {}) {
  const q = text(query);
  if (!q) throw new Error("search query is required");
  const cap = Math.max(1, Math.min(20, Number(limit) || 8));

  const [tmdbSettled, gutendexSettled] = await Promise.allSettled([
    searchTmdbMovies(q, { page: 1 }),
    searchGutendexCatalog(q, { page: 1 })
  ]);

  const movies = tmdbSettled.status === "fulfilled"
    ? (tmdbSettled.value.results || []).slice(0, cap)
    : [];
  const books = gutendexSettled.status === "fulfilled"
    ? (gutendexSettled.value.results || []).slice(0, cap)
    : [];

  const errors = [];
  if (tmdbSettled.status === "rejected") {
    errors.push({ source: "tmdb", error: String(tmdbSettled.reason?.message || tmdbSettled.reason) });
  }
  if (gutendexSettled.status === "rejected") {
    errors.push({ source: "gutendex", error: String(gutendexSettled.reason?.message || gutendexSettled.reason) });
  }

  return {
    query: q,
    groups: {
      tmdb: movies,
      gutendex: books
    },
    results: [...movies, ...books],
    errors,
    attribution: "Powered by TMDB · Project Gutenberg via Gutendex"
  };
}
