const API = 'https://api.discogs.com';
const USER_AGENT = 'Crate/1.0 (personal collection ledger)';
const PER_PAGE = 100;
const MAX_PAGES = 500;

export class DiscogsError extends Error {
  constructor(message, options) {
    super(message, options);
    this.status = 502;
    this.expose = true;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(pathname, token) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${pathname}`, {
        headers: {
          Authorization: `Discogs token=${token}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.discogs.v2.discogs+json',
        },
        // Never carry the token anywhere Discogs didn't ask for.
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new DiscogsError('Could not reach Discogs. Check your connection and try again.', { cause: err });
    }

    // Discogs allows 60 requests a minute; back off and retry when we hit it.
    if (res.status === 429 && attempt <= 4) {
      await sleep(attempt * 5_000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new DiscogsError('Discogs rejected the token. Check DISCOGS_TOKEN in .env.');
    }
    if (!res.ok) throw new DiscogsError(`Discogs returned an error (${res.status}). Try again in a minute.`);

    const remaining = res.headers.get('x-discogs-ratelimit-remaining');
    if (remaining !== null && Number(remaining) < 5) await sleep(3_000);
    return res.json();
  }
}

/** Fetches the whole collection. Throws rather than returning a partial list. */
export async function fetchCollection(token) {
  const identity = await get('/oauth/identity', token);
  const username = identity?.username;
  if (typeof username !== 'string' || !username || username.length > 100) {
    throw new DiscogsError('Discogs returned an unexpected account.');
  }
  const user = encodeURIComponent(username);

  const profile = await get(`/users/${user}`, token);
  const currency = /^[A-Z]{3}$/.test(profile?.curr_abbr) ? profile.curr_abbr : 'USD';

  const items = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const data = await get(
      `/users/${user}/collection/folders/0/releases?page=${page}&per_page=${PER_PAGE}&sort=added&sort_order=desc`,
      token,
    );
    if (!Array.isArray(data?.releases)) throw new DiscogsError('Discogs returned an unexpected response.');
    pages = Number(data.pagination?.pages) || 1;
    if (pages > MAX_PAGES) throw new DiscogsError('This collection is larger than Crate can sync.');
    for (const release of data.releases) {
      const item = toItem(release);
      if (item) items.push(item);
    }
  }

  return { username, currency, items };
}

const clean = (value, max = 300) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

/** Maps a Discogs collection entry to the fields Crate stores. Returns null for malformed entries. */
export function toItem(release) {
  if (!Number.isSafeInteger(release?.instance_id) || release.instance_id <= 0) return null;
  const info = release.basic_information ?? {};
  const label = Array.isArray(info.labels) ? info.labels[0] : null;
  return {
    instanceId: String(release.instance_id),
    releaseId: Number.isSafeInteger(info.id) && info.id > 0 ? info.id : null,
    title: clean(info.title) || 'Untitled',
    artist: artistName(info.artists),
    year: Number.isInteger(info.year) && info.year > 0 ? info.year : null,
    format: formatName(info.formats),
    label: clean(label?.name),
    catno: clean(label?.catno, 100),
    thumb: imageUrl(info.thumb) ?? imageUrl(info.cover_image),
    dateAdded:
      typeof release.date_added === 'string' && !Number.isNaN(Date.parse(release.date_added))
        ? release.date_added
        : null,
  };
}

function artistName(artists) {
  if (!Array.isArray(artists)) return '';
  const parts = artists.map((artist, i) => {
    // Discogs disambiguates duplicate names as "Name (2)"; that's noise here.
    const name = clean(artist?.anv || artist?.name).replace(/\s\(\d+\)$/, '');
    if (i === artists.length - 1) return name;
    const join = clean(artist?.join);
    return !join || join === ',' ? `${name}, ` : `${name} ${join} `;
  });
  return clean(parts.join(''));
}

function formatName(formats) {
  const format = Array.isArray(formats) ? formats[0] : null;
  if (!format) return '';
  const qty = Number(format.qty) > 1 ? `${Number(format.qty)}× ` : '';
  const descriptions = Array.isArray(format.descriptions) ? format.descriptions.map((d) => clean(d)).filter(Boolean) : [];
  return clean([`${qty}${clean(format.name)}`, ...descriptions].join(', '));
}

/** Only https images served by Discogs are allowed into the page. */
export function imageUrl(value) {
  try {
    const url = new URL(value);
    const discogs = url.hostname === 'discogs.com' || url.hostname.endsWith('.discogs.com');
    return url.protocol === 'https:' && discogs ? url.href : null;
  } catch {
    return null;
  }
}
