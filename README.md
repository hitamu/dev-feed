# devfeed

Daily RSS digest as an infinite-scroll static site. [matcha](https://github.com/piqoni/matcha)
fetches feeds and summarizes some of them with an LLM; [Astro](https://astro.build)
renders `matcha.db` into a Solarized Light feed grouped by day.

## How it works

1. `matcha -c matcha.config.yaml` polls every feed, writes new items to the
   `seen` table of `matcha.db` (`url, date, summary, title, feed_title`) and
   summarizes items from `summary_feeds` via the OpenAI-compatible API.
2. At build time [src/lib/items.js](src/lib/items.js) reads that table with
   `node:sqlite` (no dependency) and builds a `date > group > source > items`
   tree.
3. [src/pages/index.astro](src/pages/index.astro) renders the newest day;
   [src/pages/pages/[page].astro](src/pages/pages/[page].astro) emits one static
   HTML partial per older day. An `IntersectionObserver` fetches the next
   partial and appends it — no client-side templating.

## Commands

```bash
npm install
npm run dev
```

```bash
npm run build && npm run preview
```

Build and serve must use the same `BASE_PATH`, otherwise the scroll fetch 404s.
The workflow passes it from `actions/configure-pages`; locally leave it unset.

## Ordering

Sources follow the feed order in `matcha.config.yaml`, `summary_feeds` before
`feeds`. `matcha.db` stores no feed URL, so a feed's rank comes from the config
entry its items link to most often; `FEED_HOST_BY_TITLE` in
[src/lib/items.js](src/lib/items.js) covers feeds that always link elsewhere
(Hacker News, Lobsters, GitHub Trending, …).

Groups are derived from feed title and item host. `GROUP_ORDER` pins these to
the top of every day:

1. Blogs & Newsletters
2. Lobsters
3. Open Source Projects
4. GitHub Trending

Remaining groups follow, ordered by their best-ranked source. Feeds no longer in
the config sort last.

## Deploy

[.github/workflows/daily-digest.yaml](.github/workflows/daily-digest.yaml) runs
daily at 00:00 UTC: run matcha, commit `matcha.db`, build, deploy to GitHub
Pages. Requires the `OPENAI_API_KEY` secret and Settings → Pages → Source =
GitHub Actions.

## Notes

- `seen.date` is the run date, not the publish date, so the first run collapses
  the whole backlog into one day.
- Only `summary_feeds` items carry a summary; the rest are title and link.
- Rows written before matcha added the `title`/`feed_title` columns have neither,
  and land in the `Other` group with the URL as title.
- matcha also writes a markdown file per run; those are gitignored.
