import express from "express";
import {
  fetchMediawikiPlot,
  getArchiveFilm,
  getWikidataFilm,
  listArchivePopular,
  listGutendexPopular,
  listWikidataPopular,
  searchArchiveFilms,
  searchCatalogCross,
  searchGutendexCatalog,
  searchWikidataFilms
} from "./lib/storyDnaCatalog.js";
import {
  addUserFavorite,
  deleteDnaRecord,
  getDnaRecord,
  getDnaRecordsByIds,
  getUserFavorites,
  ingestStoryDna,
  listDnaRecords,
  listUserFavoriteRecords,
  removeUserFavorite,
  setUserFavorites
} from "./lib/storyDnaEngine.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

function userFromReq(req) {
  return String(req.headers["x-story-dna-user"] || req.query.user_id || req.body?.user_id || "").trim();
}

function serviceToken() {
  return String(process.env.STORY_DNA_SERVICE_TOKEN || "").trim();
}

function requestToken(req) {
  const header = String(req.headers["x-story-dna-token"] || "").trim();
  if (header) return header;
  const auth = String(req.headers.authorization || "").trim();
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

function isPublicRead(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (req.path === "/" || req.path === "/health") return true;
  if (req.path.startsWith("/catalog/")) return true;
  if (req.path === "/story-dna") return true;
  if (req.path === "/story-dna/batch") return true;
  if (/^\/story-dna\/[^/]+$/.test(req.path)) return true;
  return false;
}

/** Mutations need STORY_DNA_SERVICE_TOKEN when configured. Catalog/health are public reads. */
app.use((req, res, next) => {
  if (isPublicRead(req)) return next();
  const expected = serviceToken();
  if (!expected) return next();
  if (requestToken(req) !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return next();
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "legacy.movie",
    product_ui: "https://catcut.vip/story-dna",
    health: "/health",
    catalog: ["/catalog/wikidata/popular", "/catalog/archive/popular", "/catalog/gutendex/popular", "/catalog/search"],
    note: "This host is the Story DNA API. Browse/ingest UI is on MiniFilm (catcut.vip/story-dna)."
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "legacy.movie",
    sources: ["wikidata", "archive", "gutendex", "mediawiki"],
    ingest: "id-only wikidata|archive|gutendex",
    service_auth: Boolean(serviceToken()),
    product_ui: "https://catcut.vip/story-dna",
    auth: "public catalog GET; mutations need STORY_DNA_SERVICE_TOKEN; XAI_API_KEY for ingest"
  });
});

app.get("/catalog/search", async (req, res) => {
  try {
    const payload = await searchCatalogCross(req.query.q || req.query.search, {
      limit: Number(req.query.limit || 8)
    });
    res.json({ ok: true, ...payload });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/catalog/wikidata/popular", async (req, res) => {
  try {
    const payload = await listWikidataPopular({
      page: req.query.page,
      category: req.query.category || req.query.decade
    });
    res.json({ ok: true, ...payload });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/catalog/wikidata/search", async (req, res) => {
  try {
    const payload = await searchWikidataFilms(req.query.q || req.query.search, {
      limit: Number(req.query.limit || 12)
    });
    res.json({ ok: true, ...payload });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/catalog/wikidata/:id", async (req, res) => {
  try {
    res.json({ ok: true, item: await getWikidataFilm(req.params.id) });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/catalog/archive/popular", async (req, res) => {
  try {
    res.json({
      ok: true,
      ...(await listArchivePopular({
        page: req.query.page,
        collection: req.query.collection || req.query.category
      }))
    });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/catalog/archive/search", async (req, res) => {
  try {
    res.json({
      ok: true,
      ...(await searchArchiveFilms(req.query.q || req.query.search, {
        page: req.query.page,
        limit: Number(req.query.limit || 20)
      }))
    });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/catalog/archive/:id", async (req, res) => {
  try {
    res.json({ ok: true, item: await getArchiveFilm(req.params.id) });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/catalog/gutendex/popular", async (req, res) => {
  try {
    res.json({
      ok: true,
      ...(await listGutendexPopular({
        page: req.query.page,
        topic: req.query.topic || req.query.category
      }))
    });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/catalog/gutendex/search", async (req, res) => {
  try {
    res.json({ ok: true, ...(await searchGutendexCatalog(req.query.q || req.query.search, { page: req.query.page })) });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/catalog/mediawiki/plot", async (req, res) => {
  try {
    res.json({ ok: true, ...(await fetchMediawikiPlot(req.query.title || req.query.q)) });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/story-dna/ingest", async (req, res) => {
  try {
    const body = { ...(req.body || {}), user_id: userFromReq(req) || req.body?.user_id };
    const result = await ingestStoryDna(body);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error("[story-dna-ingest]", error);
    res.status(Number(error?.status || 500)).json({
      ok: false,
      error: String(error?.message || error)
    });
  }
});

app.get("/story-dna", (_req, res) => {
  try {
    res.json({ ok: true, items: listDnaRecords() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/story-dna/batch", (req, res) => {
  try {
    const raw = String(req.query.ids || "").split(",").map((item) => item.trim()).filter(Boolean);
    res.json({ ok: true, items: getDnaRecordsByIds(raw) });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/story-dna/favorites", (req, res) => {
  try {
    const userId = userFromReq(req);
    const prefs = getUserFavorites(userId);
    res.json({
      ok: true,
      ...prefs,
      items: listUserFavoriteRecords(userId)
    });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.put("/story-dna/favorites", (req, res) => {
  try {
    const userId = userFromReq(req) || req.body?.user_id;
    const prefs = setUserFavorites(userId, req.body?.favorite_ids);
    res.json({ ok: true, ...prefs, items: listUserFavoriteRecords(userId) });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/story-dna/favorites/:id", (req, res) => {
  try {
    const userId = userFromReq(req) || req.body?.user_id;
    const prefs = addUserFavorite(userId, req.params.id);
    res.json({ ok: true, ...prefs, items: listUserFavoriteRecords(userId) });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.delete("/story-dna/favorites/:id", (req, res) => {
  try {
    const userId = userFromReq(req) || req.body?.user_id;
    const prefs = removeUserFavorite(userId, req.params.id);
    res.json({ ok: true, ...prefs, items: listUserFavoriteRecords(userId) });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/story-dna/:id", (req, res) => {
  try {
    res.json({ ok: true, record: getDnaRecord(req.params.id) });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({
      ok: false,
      error: String(error?.message || error)
    });
  }
});

app.delete("/story-dna/:id", (req, res) => {
  try {
    res.json({ ok: true, ...deleteDnaRecord(req.params.id) });
  } catch (error) {
    res.status(Number(error?.status || 500)).json({
      ok: false,
      error: String(error?.message || error)
    });
  }
});

const port = Number(process.env.PORT || 8791);
if (process.env.STORY_DNA_NO_LISTEN !== "1") {
  app.listen(port, () => {
    console.log(`story-dna-engine listening on :${port}`);
  });
}

export default app;
