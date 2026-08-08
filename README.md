# legacy.movie

Open-source **Story DNA** engine: pull public film/book metadata by ID, extract a 10-field structure card, and serve batch lookups for writers/tools.

This repository is intentionally **standalone**. It does not include any film-production SaaS, job queues, billing, or private product code.

## What it does

- Catalog browse/search: TMDB (movies), Gutendex (public-domain books), optional MediaWiki plot text
- Ingest by public ID only (`tmdb-{id}` / `gutendex-{id}`), with dedupe
- Extract a fixed 10-field DNA card via Grok (`XAI_API_KEY`)
- Per-user favorites (client-supplied `user_id` / `X-Story-Dna-User`)
- Batch fetch by DNA ids

## 10 DNA fields

High Concept, Core Conflict, Protagonist Goal, Protagonist Flaw, Villain Goal, Inciting Incident, Midpoint Twist, Climax, Emotional Arc, Visual DNA.

## Quick start

```bash
npm install
cp .env.example .env
# fill TMDB_API_KEY, XAI_API_KEY; set STORY_DNA_SERVICE_TOKEN for any public deploy
npm start
```

Health: `GET /health`

## Production auth

If `STORY_DNA_SERVICE_TOKEN` is set, every route except `/health` requires:

- `X-Story-Dna-Token: <token>` or
- `Authorization: Bearer <token>`

Do not expose ingest/favorites/delete without a token on a public host.

## Attribution

Movie data: [TMDB](https://www.themoviedb.org/) (this product uses the TMDB API but is not endorsed or certified by TMDB).

## License

MIT
