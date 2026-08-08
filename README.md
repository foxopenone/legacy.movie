# legacy.movie

Open-source **Story DNA** engine: pull public film/book metadata by ID, extract a 10-field structure card, and serve batch lookups for writers/tools.

This repository is intentionally **standalone**. It does not include any film-production SaaS, job queues, billing, or private product code.

## What it does

- Catalog browse/search: Wikidata (films), Internet Archive (hosted films), Gutendex (public-domain books), MediaWiki plot enrichment
- Ingest by public ID only (`wikidata-Q…` / `archive-{identifier}` / `gutendex-{id}`), with dedupe
- Extract a fixed 10-field DNA card via Grok (`XAI_API_KEY`)
- Per-user favorites (client-supplied `user_id` / `X-Story-Dna-User`)
- Batch fetch by DNA ids

## 10 DNA fields

High Concept, Core Conflict, Protagonist Goal, Protagonist Flaw, Villain Goal, Inciting Incident, Midpoint Twist, Climax, Emotional Arc, Visual DNA.

## Quick start

```bash
npm install
cp .env.example .env
# fill XAI_API_KEY; set STORY_DNA_SERVICE_TOKEN for any public deploy
npm start
```

Health: `GET /health`

## Production auth

If `STORY_DNA_SERVICE_TOKEN` is set, every route except `/health` requires:

- `X-Story-Dna-Token: <token>` or
- `Authorization: Bearer <token>`

Do not expose ingest/favorites/delete without a token on a public host.

## Attribution

Film entities: [Wikidata](https://www.wikidata.org/) and [Internet Archive](https://archive.org/). Plot text may come from Wikipedia via the MediaWiki API. Books: Project Gutenberg via Gutendex.

## License

MIT
