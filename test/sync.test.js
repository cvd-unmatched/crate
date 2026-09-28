import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageUrl, toItem } from '../lib/discogs.js';
import { mergeCollection } from '../lib/merge.js';

const remote = (id, title = `Record ${id}`) => ({
  instanceId: String(id),
  releaseId: id * 10,
  title,
  artist: 'Artist',
  year: 1999,
  format: 'Vinyl, LP',
  label: 'Label',
  catno: 'CAT1',
  thumb: null,
  dateAdded: '2024-01-01T00:00:00-08:00',
});

test('merge keeps user data when Discogs details change', () => {
  const data = { items: {} };
  mergeCollection(data, [remote(1), remote(2)]);
  Object.assign(data.items['1'], { paid: 1500, bundleId: 'b1' });

  const summary = mergeCollection(data, [remote(1, 'Renamed'), remote(2)]);
  assert.deepEqual(summary, { added: 0, removed: 0, total: 2 });
  assert.equal(data.items['1'].title, 'Renamed');
  assert.equal(data.items['1'].paid, 1500);
  assert.equal(data.items['1'].bundleId, 'b1');
});

test('records that leave the collection keep their prices; untouched ones are dropped', () => {
  const data = { items: {} };
  mergeCollection(data, [remote(1), remote(2), remote(3)]);
  data.items['1'].sold = 2500;

  const summary = mergeCollection(data, [remote(3), remote(4)]);
  assert.deepEqual(summary, { added: 1, removed: 2, total: 2 });
  assert.equal(data.items['1'].inCollection, false);
  assert.equal(data.items['1'].sold, 2500);
  assert.equal(Object.hasOwn(data.items, '2'), false);
  assert.equal(data.items['4'].inCollection, true);

  // Re-adding it on Discogs brings it back with its data intact.
  mergeCollection(data, [remote(1), remote(3), remote(4)]);
  assert.equal(data.items['1'].inCollection, true);
  assert.equal(data.items['1'].sold, 2500);
});

test('gifts survive a sync, even after leaving the collection', () => {
  const data = { items: {} };
  mergeCollection(data, [remote(1), remote(2)]);
  assert.equal(data.items['1'].gift, false);
  data.items['1'].gift = true;

  mergeCollection(data, [remote(1), remote(2)]);
  assert.equal(data.items['1'].gift, true);

  mergeCollection(data, []);
  assert.equal(data.items['1'].inCollection, false);
  assert.equal(Object.hasOwn(data.items, '2'), false);
});

test('where a record came from survives a sync and keeps it around', () => {
  const data = { items: {} };
  mergeCollection(data, [remote(1)]);
  data.items['1'].source = 'rommelmarkt Patershol';
  mergeCollection(data, [remote(1)]);
  assert.equal(data.items['1'].source, 'rommelmarkt Patershol');
  mergeCollection(data, []);
  assert.equal(data.items['1'].inCollection, false);
});

test('toItem maps Discogs fields and drops malformed entries', () => {
  const item = toItem({
    instance_id: 123,
    date_added: '2024-05-01T10:00:00-07:00',
    basic_information: {
      id: 456,
      title: 'Blue\u0000 Lines',
      year: 1991,
      thumb: 'https://i.discogs.com/abc.jpg',
      artists: [
        { name: 'Massive Attack (2)', anv: '', join: '&' },
        { name: 'Horace Andy', anv: '', join: '' },
      ],
      formats: [{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album'] }],
      labels: [{ name: 'Wild Bunch', catno: 'WBRLP 1' }],
    },
  });
  assert.deepEqual(item, {
    instanceId: '123',
    releaseId: 456,
    title: 'Blue Lines',
    artist: 'Massive Attack & Horace Andy',
    year: 1991,
    format: '2× Vinyl, LP, Album',
    label: 'Wild Bunch',
    catno: 'WBRLP 1',
    thumb: 'https://i.discogs.com/abc.jpg',
    dateAdded: '2024-05-01T10:00:00-07:00',
  });
  assert.equal(toItem({ instance_id: 'x' }), null);
  assert.equal(toItem(null), null);
});

test('only https Discogs images are accepted', () => {
  assert.equal(imageUrl('https://i.discogs.com/a.jpg'), 'https://i.discogs.com/a.jpg');
  assert.equal(imageUrl('http://i.discogs.com/a.jpg'), null);
  assert.equal(imageUrl('https://evil.com/a.jpg'), null);
  assert.equal(imageUrl('https://discogs.com.evil.com/a.jpg'), null);
  assert.equal(imageUrl('javascript:alert(1)'), null);
  assert.equal(imageUrl(undefined), null);
});
