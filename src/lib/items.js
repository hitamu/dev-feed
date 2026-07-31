import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_PATH = resolve(process.env.MATCHA_DB ?? 'matcha.db');
const CONFIG_PATH = resolve(process.env.MATCHA_CONFIG ?? 'matcha.config.yaml');

/**
 * Feeds whose items link elsewhere than the feed host, so the host of an item
 * cannot be matched against matcha.config.yaml. Maps feed_title to feed host.
 */
const FEED_HOST_BY_TITLE = {
  'Hacker News: Best': 'hnrss.org',
  Lobsters: 'lobste.rs',
  'GitHub All Languages Daily Trending': 'mshibanami.github.io',
  'Paul Graham: Essays': 'aaronsw.com',
  'Dwarkesh Podcast': 'dwarkeshpatel.com',
  'manager.dev': 'newsletter.manager.dev',
};

/** Host of a feed or item URL, with the subreddit kept so r/* feeds differ. */
function feedKey(url) {
  const noScheme = url.replace(/^\w+:\/\//, '');
  const slash = noScheme.indexOf('/');
  const host = (slash === -1 ? noScheme : noScheme.slice(0, slash))
    .toLowerCase()
    .replace(/^www\./, '');
  if (host.endsWith('reddit.com')) {
    const sub = noScheme.match(/\/r\/([^/]+)/);
    if (sub) return `${host}/r/${sub[1].toLowerCase()}`;
  }
  return host;
}

/**
 * Groups pinned to the top of every day, in this order. Groups left out follow,
 * ordered by their best-ranked source. Sources inside a group always keep the
 * matcha.config.yaml order.
 */
const GROUP_ORDER = [
  'Blogs & Newsletters',
  'Lobsters',
  'Open Source Projects',
  'GitHub Trending',
];

// Feeds missing from the config sort after every listed feed. A finite value
// keeps `a.rank - b.rank` usable (Infinity - Infinity is NaN).
const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Priority per feed, taken from the order of `feeds` then `summary_feeds` in
 * matcha.config.yaml. Feeds no longer listed there sort last.
 */
function feedRanks() {
  if (!existsSync(CONFIG_PATH)) return new Map();

  const lists = { feeds: [], summary_feeds: [] };
  let list = null;
  for (const line of readFileSync(CONFIG_PATH, 'utf8').split('\n')) {
    const head = line.match(/^(feeds|summary_feeds):/);
    if (head) {
      list = lists[head[1]];
    } else if (list && /^\s+-\s/.test(line)) {
      // `- http://hnrss.org/best 30` — the trailing number is an item limit.
      list.push(line.trim().slice(1).trim().split(/\s+/)[0]);
    } else if (line.trim() !== '') {
      list = null;
    }
  }

  // summary_feeds first: summarized sources show above the raw ones.
  const ranks = new Map();
  for (const url of [...lists.summary_feeds, ...lists.feeds]) {
    const k = feedKey(url);
    if (!ranks.has(k)) ranks.set(k, ranks.size);
  }
  return ranks;
}

// matcha.db stores no feed URL, so groups are derived from feed_title first
// (aggregator feeds link to external hosts) and the item host second.
function groupOf(feedTitle, url) {
  if (/^Hacker News/.test(feedTitle)) return 'Hacker News';
  if (feedTitle === 'Lobsters') return 'Lobsters';
  if (/Trending/.test(feedTitle)) return 'GitHub Trending';

  const host = feedKey(url);
  if (host.startsWith('reddit.com')) return 'Reddit';
  if (host === 'dev.to') return 'DEV Community';
  if (host === 'opensourceprojects.dev') return 'Open Source Projects';

  if (!feedTitle) return 'Other';
  return 'Blogs & Newsletters';
}

function readRows() {
  if (!existsSync(DB_PATH)) return [];

  const ranks = feedRanks();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const cols = new Set(
      db.prepare('PRAGMA table_info(seen)').all().map((c) => c.name)
    );
    if (!cols.has('url')) return [];

    // Fork schemas may lack columns added by later migrations.
    const select = ['url', 'date', 'title', 'feed_title', 'summary']
      .map((c) => (cols.has(c) ? c : `NULL AS ${c}`))
      .join(', ');

    const rows = db
      .prepare(`SELECT ${select} FROM seen ORDER BY date DESC, rowid DESC`)
      .all();

    // Link blogs (Daring Fireball, Lobsters…) point at other hosts, so a feed
    // is ranked by the config feed its items hit most often, not per item.
    const hits = new Map();
    for (const r of rows) {
      // Legacy rows predating the feed_title column share no feed identity.
      if (!r.feed_title) continue;
      const rank = ranks.get(feedKey(r.url));
      if (rank === undefined) continue;
      const perFeed = hits.get(r.feed_title ?? '') ?? new Map();
      perFeed.set(rank, (perFeed.get(rank) ?? 0) + 1);
      hits.set(r.feed_title ?? '', perFeed);
    }

    const rankOf = (feedTitle) => {
      const override = FEED_HOST_BY_TITLE[feedTitle];
      if (override) return ranks.get(override) ?? UNRANKED;
      const perFeed = hits.get(feedTitle);
      if (!perFeed) return UNRANKED;
      return [...perFeed].sort((a, b) => b[1] - a[1])[0][0];
    };

    return rows.map((r) => {
      const feedTitle = r.feed_title ?? '';
      return {
        url: r.url,
        date: r.date ?? '',
        title: r.title || r.url,
        source: feedTitle || feedKey(r.url),
        group: groupOf(feedTitle, r.url),
        rank: rankOf(feedTitle),
        summary: r.summary ?? '',
      };
    });
  } finally {
    db.close();
  }
}

let cache;

function allItems() {
  cache ??= readRows();
  return cache;
}

/** Dates newest first. One page of the feed = one date. */
export function days() {
  return [...new Set(allItems().map((i) => i.date))];
}

/**
 * Items of one date as date > group > source > items.
 * Groups and sources follow the feed order of matcha.config.yaml; feeds absent
 * from it keep first-seen order (newest first) at the end.
 */
export function dayTree(date) {
  const groups = new Map();
  for (const item of allItems()) {
    if (item.date !== date) continue;
    if (!groups.has(item.group)) groups.set(item.group, new Map());
    const sources = groups.get(item.group);
    if (!sources.has(item.source)) {
      sources.set(item.source, { source: item.source, rank: item.rank, items: [] });
    }
    sources.get(item.source).items.push(item);
  }

  const pinned = (group) => {
    const i = GROUP_ORDER.indexOf(group);
    return i === -1 ? GROUP_ORDER.length : i;
  };

  return [...groups]
    .map(([group, sources]) => ({
      group,
      sources: [...sources.values()].sort((a, b) => a.rank - b.rank),
      rank: Math.min(...[...sources.values()].map((s) => s.rank)),
    }))
    .sort((a, b) => pinned(a.group) - pinned(b.group) || a.rank - b.rank);
}

export function totalItems() {
  return allItems().length;
}
