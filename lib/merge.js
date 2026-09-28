// Fields the user owns (plus `gift`). Discogs never overwrites these.
const USER_FIELDS = ['paid', 'shipping', 'sold', 'bundleId'];

export const hasUserData = (item) => item.gift === true || USER_FIELDS.some((key) => item[key] != null);

/**
 * Folds a complete, freshly fetched collection into the stored data.
 * Only call this with a full fetch: records missing from `remoteItems` are
 * treated as gone. Gone records that carry prices or a bundle are kept and
 * flagged, so selling a record (and removing it on Discogs) loses nothing.
 */
export function mergeCollection(data, remoteItems) {
  const seen = new Set();
  let added = 0;
  let removed = 0;

  for (const remote of remoteItems) {
    if (seen.has(remote.instanceId)) continue;
    seen.add(remote.instanceId);
    const previous = Object.hasOwn(data.items, remote.instanceId) ? data.items[remote.instanceId] : null;
    if (!previous?.inCollection) added++;
    data.items[remote.instanceId] = {
      ...remote,
      paid: previous?.paid ?? null,
      shipping: previous?.shipping ?? null,
      sold: previous?.sold ?? null,
      bundleId: previous?.bundleId ?? null,
      gift: previous?.gift === true,
      inCollection: true,
    };
  }

  for (const [id, item] of Object.entries(data.items)) {
    if (seen.has(id)) continue;
    if (item.inCollection) removed++;
    if (hasUserData(item)) item.inCollection = false;
    else delete data.items[id];
  }

  return { added, removed, total: seen.size };
}
