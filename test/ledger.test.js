import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeLedger, parseMoney, splitEvenly } from '../public/ledger.js';

test('parseMoney reads the ways people type prices', () => {
  assert.equal(parseMoney('12.50'), 1250);
  assert.equal(parseMoney('12,50'), 1250);
  assert.equal(parseMoney('€ 12,5'), 1250);
  assert.equal(parseMoney('12 €'), 1200);
  assert.equal(parseMoney('1.234,56'), 123456);
  assert.equal(parseMoney('1,234.56'), 123456);
  assert.equal(parseMoney('1 234'), 123400);
  assert.equal(parseMoney('.99'), 99);
  assert.equal(parseMoney('0'), 0);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('   '), null);
});

test('parseMoney rejects anything that is not a positive amount', () => {
  for (const bad of ['abc', '-5', '12a50', '.', ',', '10000001', '1e5']) {
    assert.ok(Number.isNaN(parseMoney(bad)), bad);
  }
});

test('splitEvenly always adds back up to the total', () => {
  assert.deepEqual(splitEvenly(1000, 3), [334, 333, 333]);
  assert.deepEqual(splitEvenly(900, 3), [300, 300, 300]);
  assert.deepEqual(splitEvenly(0, 2), [0, 0]);
  assert.deepEqual(splitEvenly(500, 0), []);
  for (let total = 0; total < 500; total += 37) {
    for (let n = 1; n < 9; n++) assert.equal(splitEvenly(total, n).reduce((a, b) => a + b, 0), total);
  }
});

test('computeLedger splits bundle shipping and keeps it separate from the price', () => {
  const bundles = new Map([['b1', { id: 'b1', name: 'Order', shipping: 1000 }]]);
  const items = [
    { instanceId: '30', paid: 2000, shipping: null, sold: 3000, bundleId: 'b1', inCollection: true },
    { instanceId: '10', paid: 1500, shipping: 999, sold: null, bundleId: 'b1', inCollection: true },
    { instanceId: '20', paid: null, shipping: null, sold: null, bundleId: 'b1', inCollection: true },
    { instanceId: '40', paid: 500, shipping: 450, sold: null, bundleId: null, inCollection: true },
    { instanceId: '50', paid: null, shipping: null, sold: 800, bundleId: null, inCollection: false },
  ];
  const { rows, bundles: bundleTotals, totals } = computeLedger(items, bundles);

  // Leftover cent goes to the lowest instance id, deterministically.
  assert.deepEqual(rows.get('10'), { ship: 334, cost: 1834, profit: null });
  assert.deepEqual(rows.get('20'), { ship: 333, cost: null, profit: null });
  assert.deepEqual(rows.get('30'), { ship: 333, cost: 2333, profit: 667 });
  // Standalone records use their own shipping.
  assert.deepEqual(rows.get('40'), { ship: 450, cost: 950, profit: null });
  // Sold without a known purchase price: no made-up profit.
  assert.deepEqual(rows.get('50'), { ship: 0, cost: null, profit: null });

  assert.equal(bundleTotals.get('b1').records, 3500);
  assert.equal(bundleTotals.get('b1').shipping, 1000);
  assert.equal(bundleTotals.get('b1').unpriced, 1);

  assert.equal(totals.records, 4000);
  assert.equal(totals.shipping, 1450);
  assert.equal(totals.spent, 5450);
  assert.equal(totals.sold, 3800);
  assert.equal(totals.soldCount, 2);
  assert.equal(totals.profit, 667);
  assert.equal(totals.profitCount, 1);
  assert.equal(totals.owned, 4);
  assert.equal(totals.unpriced, 1);
});

test('a gift counts as paid nothing and is not unpriced', () => {
  const items = [
    // An old price stays stored but is ignored while it's marked as a gift.
    { instanceId: '1', paid: 2500, shipping: 300, sold: 1000, bundleId: null, gift: true, inCollection: true },
    { instanceId: '2', paid: null, shipping: null, sold: null, bundleId: null, gift: true, inCollection: true },
  ];
  const { rows, totals } = computeLedger(items, new Map());
  assert.deepEqual(rows.get('1'), { ship: 300, cost: 300, profit: 700 });
  assert.deepEqual(rows.get('2'), { ship: 0, cost: 0, profit: null });
  assert.equal(totals.records, 0);
  assert.equal(totals.unpriced, 0);
  assert.equal(totals.gifts, 2);
});

test('an empty bundle contributes no shipping', () => {
  const bundles = new Map([['b1', { id: 'b1', name: 'Empty', shipping: 800 }]]);
  const { bundles: bundleTotals, totals } = computeLedger([], bundles);
  assert.equal(bundleTotals.get('b1').shipping, 0);
  assert.equal(totals.spent, 0);
});
