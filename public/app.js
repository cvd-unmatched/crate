import { computeLedger, paidOf, parseMoney, splitEvenly } from './ledger.js';

// Every piece of Discogs or user text reaches the page through textContent or
// text nodes (see h()), never innerHTML.

const $ = (selector) => document.querySelector(selector);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const EMPTY = '–';

const state = {
  configured: false,
  username: null,
  lastSyncedAt: null,
  items: new Map(),
  bundles: new Map(),
  selected: new Set(),
  view: 'records',
  filter: 'all',
  sort: 'added',
  query: '',
};

const rows = new Map();
const bundleCards = new Map();
let ledger = computeLedger([], new Map());
let bundleShape = null;
const suggestionKeys = {};
let lastChecked = null;
let fmt;

const FILTERS = {
  all: () => true,
  unpriced: (item) => paidOf(item) == null,
  bundled: (item) => state.bundles.has(item.bundleId),
  sold: (item) => item.sold != null,
};

const SORTS = {
  added: (a, b) => rows.get(b.instanceId).added - rows.get(a.instanceId).added,
  artist: (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title),
  title: (a, b) => collator.compare(a.title, b.title) || collator.compare(a.artist, b.artist),
  cost: (a, b) => (ledger.rows.get(b.instanceId).cost ?? -1) - (ledger.rows.get(a.instanceId).cost ?? -1),
  profit: (a, b) => (ledger.rows.get(b.instanceId).profit ?? -1e15) - (ledger.rows.get(a.instanceId).profit ?? -1e15),
};

/* ---------- helpers ---------- */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function setCurrency(code) {
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
  fmt = {
    money,
    signed: new Intl.NumberFormat(undefined, { style: 'currency', currency: code, signDisplay: 'exceptZero' }),
    plain: new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }),
    symbol: money.formatToParts(0).find((part) => part.type === 'currency')?.value ?? code,
  };
}

const formatMoney = (cents) => (cents == null ? EMPTY : fmt.money.format(cents / 100));
const formatPlain = (cents) => (cents == null ? '' : fmt.plain.format(cents / 100));
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const tone = (cents) => String(Math.sign(cents ?? 0));

function splitLabel(total, n) {
  const parts = splitEvenly(total, n);
  if (!parts.length) return '';
  const low = Math.min(...parts);
  const high = Math.max(...parts);
  return low === high ? formatMoney(low) : `${formatMoney(low)} to ${formatMoney(high)}`;
}

function isDiscogsImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'discogs.com' || url.hostname.endsWith('.discogs.com'));
  } catch {
    return false;
  }
}

function ago(date) {
  const seconds = (date - Date.now()) / 1000;
  if (seconds > -45) return 'just now';
  const units = [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2629800], ['year', 31557600]];
  let [unit, size] = units[0];
  for (const [u, s] of units) if (-seconds >= s) [unit, size] = [u, s];
  return relative.format(Math.round(seconds / size), unit);
}

/** Swaps a label with a short blur so the change reads as one element morphing. */
function swapText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (reduceMotion.matches) return;
  el.animate([{ filter: 'blur(2px)', opacity: 0.4 }, { filter: 'blur(0)', opacity: 1 }], { duration: 200, easing: 'ease-out' });
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Can’t reach the Crate server. Is it still running?');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

/* ---------- toasts ---------- */

const toastDismissers = new WeakMap();

function toast(message, kind = 'info') {
  const list = $('#toasts');
  const el = h('li', { class: 'toast', 'data-kind': kind }, message);
  let remaining = kind === 'error' ? 6000 : 4000;
  let timer = 0;
  let startedAt = 0;
  let running = false;

  const start = () => {
    if (running || document.hidden) return;
    running = true;
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  const pause = () => {
    if (!running) return;
    running = false;
    clearTimeout(timer);
    remaining -= Date.now() - startedAt;
  };
  // Timers pause while the tab is hidden or the pointer rests on the toast.
  const onVisibility = () => (document.hidden ? pause() : start());
  function dismiss() {
    pause();
    document.removeEventListener('visibilitychange', onVisibility);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }

  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', start);
  document.addEventListener('visibilitychange', onVisibility);
  toastDismissers.set(el, dismiss);
  list.append(el);
  const live = [...list.children].filter((child) => !child.classList.contains('leaving'));
  if (live.length > 3) toastDismissers.get(live[0])?.();
  start();
}

/* ---------- money inputs ---------- */

function moneyInput(label, field, onCommit) {
  const input = h('input', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: EMPTY,
    'aria-label': label,
    'data-field': field,
  });
  const el = h('label', { class: 'money' }, h('span', { class: 'currency', 'aria-hidden': 'true' }, fmt.symbol), input);
  let committed = null;
  const show = () => {
    input.value = formatPlain(committed);
  };

  input.addEventListener('blur', () => {
    const value = parseMoney(input.value);
    if (Number.isNaN(value)) {
      toast(`“${input.value.trim().slice(0, 24)}” isn’t an amount. Try something like 12.50.`, 'error');
      show();
      return;
    }
    const changed = value !== committed;
    committed = value;
    show();
    if (changed) onCommit(value);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      show();
      input.blur();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      advance(input, field, event.shiftKey);
    }
  });

  return {
    el,
    input,
    set(value) {
      committed = value ?? null;
      if (document.activeElement !== input) show();
    },
  };
}

/** Spreadsheet-style: blurring saves, then focus moves to the same field on the next (or previous) record. */
function advance(input, field, backwards) {
  const next = nextField(input, field, backwards ? 'previousElementSibling' : 'nextElementSibling');
  input.blur();
  next?.focus();
  next?.select();
}

function nextField(input, field, direction) {
  let row = input.closest('.row')?.[direction];
  while (row) {
    const candidate = row.querySelector(`input[data-field="${field}"]`);
    if (candidate && candidate.offsetParent !== null) return candidate;
    row = row[direction];
  }
  return null;
}

/* ---------- records ---------- */

function cover(url, size) {
  const box = h('span', { class: 'cover' });
  if (isDiscogsImage(url)) {
    const img = h('img', {
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      width: size,
      height: size,
      onload: () => img.classList.add('loaded'),
      src: url,
    });
    box.append(img);
  }
  return box;
}

function releaseLink(item) {
  if (!Number.isSafeInteger(item.releaseId)) return item.title;
  return h(
    'a',
    { href: `https://www.discogs.com/release/${item.releaseId}`, target: '_blank', rel: 'noopener noreferrer' },
    item.title,
  );
}

const cell = (label, ...content) => h('div', { class: 'cell' }, h('span', { class: 'cell-label' }, label), ...content);

function createRow(item) {
  const id = item.instanceId;
  const check = h('input', { type: 'checkbox', 'aria-label': `Select ${item.title}` });
  check.addEventListener('click', (event) => select(id, check.checked, event.shiftKey));

  const paid = moneyInput(`Paid for ${item.title}`, 'paid', (value) => saveItem(id, { paid: value }));
  const gift = h(
    'button',
    {
      type: 'button',
      class: 'gift',
      'aria-pressed': 'false',
      'aria-label': `${item.title} was a gift`,
      onclick: () => saveItem(id, { gift: !state.items.get(id).gift }),
    },
    icon('gift'),
    h('span', { class: 'gift-label' }, 'Gift'),
  );
  const shipping = moneyInput(`Shipping for ${item.title}`, 'shipping', (value) => saveItem(id, { shipping: value }));
  const sold = moneyInput(`Sold ${item.title} for`, 'sold', (value) => saveItem(id, { sold: value }));
  const source = h('input', {
    class: 'source',
    type: 'text',
    list: 'places',
    maxlength: '80',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Where did you get it?',
    'aria-label': `Where you got ${item.title}`,
    'data-field': 'source',
  });
  const sourceIcon = icon('pin');
  source.addEventListener('blur', () => {
    const value = source.value.trim();
    source.value = value;
    if (value !== (state.items.get(id).source ?? '')) saveItem(id, { source: value || null });
  });
  source.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      source.value = state.items.get(id).source ?? '';
      source.blur();
    } else if (event.key === 'Enter') {
      // Wait a tick so picking a suggestion with Enter fills the field before we move on.
      setTimeout(() => advance(source, 'source', event.shiftKey));
    }
  });
  const share = h('span', { class: 'amount' });
  const chip = h('button', { type: 'button', class: 'chip', onclick: () => showBundle(state.items.get(id).bundleId) });
  const bundled = h('span', { class: 'bundled' }, share, chip);
  const cost = h('span', { class: 'amount strong' });
  const profit = h('span', { class: 'amount' });

  const el = h(
    'li',
    { class: 'row', 'data-id': id },
    h('label', { class: 'row-check' }, check),
    cover(item.thumb, 44),
    h(
      'div',
      { class: 'meta' },
      h('p', { class: 'title' }, releaseLink(item)),
      h('p', { class: 'sub' }, [item.artist, item.year, item.format].filter(Boolean).join(' · ')),
      h(
        'div',
        { class: 'meta-line' },
        h('label', { class: 'source-field' }, sourceIcon, source),
        item.inCollection ? null : h('span', { class: 'tag' }, 'No longer on Discogs'),
      ),
    ),
    h(
      'div',
      { class: 'cells' },
      cell('Paid', h('div', { class: 'paid' }, gift, paid.el)),
      cell('Shipping', shipping.el, bundled),
      cell('Cost', cost),
      cell('Sold', sold.el),
      cell('Profit', profit),
    ),
  );

  return {
    el,
    check,
    paid,
    gift,
    shipping,
    sold,
    source,
    sourceIcon,
    share,
    chip,
    bundled,
    cost,
    profit,
    text: [item.title, item.artist, item.label, item.catno, item.year].join(' ').toLocaleLowerCase(),
    added: Date.parse(item.dateAdded) || 0,
  };
}

function patchRow(row, item) {
  const { ship, cost, profit } = ledger.rows.get(item.instanceId);
  const bundle = state.bundles.get(item.bundleId);
  row.paid.set(item.paid);
  row.paid.el.hidden = Boolean(item.gift);
  row.gift.setAttribute('aria-pressed', String(Boolean(item.gift)));
  row.gift.title = item.gift ? 'Gift. Click to enter a price instead' : 'Mark as a gift';
  row.sold.set(item.sold);
  if (document.activeElement !== row.source) row.source.value = item.source ?? '';
  // For a gift, "where did you get it" becomes "who gave it to you".
  const gift = Boolean(item.gift);
  row.sourceIcon.firstChild.setAttribute('href', gift ? '#i-user' : '#i-pin');
  row.source.placeholder = gift ? 'Who gave it to you?' : 'Where did you get it?';
  row.source.setAttribute('aria-label', gift ? `Who gave you ${item.title}` : `Where you got ${item.title}`);
  row.source.setAttribute('list', gift ? 'givers' : 'places');
  row.shipping.set(item.shipping);
  row.shipping.el.hidden = Boolean(bundle);
  row.bundled.hidden = !bundle;
  if (bundle) {
    row.share.textContent = formatMoney(ship);
    row.chip.textContent = bundle.name;
    row.chip.title = `Part of “${bundle.name}”. Open bundle`;
  }
  row.cost.textContent = formatMoney(cost);
  row.profit.textContent = profit == null ? EMPTY : fmt.signed.format(profit / 100);
  row.profit.dataset.tone = tone(profit);
}

function renderRecords({ animate = false } = {}) {
  const query = state.query.trim().toLocaleLowerCase();
  const matches = [...state.items.values()].filter(
    (item) =>
      FILTERS[state.filter](item) &&
      (!query || `${rows.get(item.instanceId).text} ${item.source ?? ''}`.toLocaleLowerCase().includes(query)),
  );
  matches.sort(SORTS[state.sort]);

  const fragment = document.createDocumentFragment();
  matches.forEach((item, i) => {
    const { el } = rows.get(item.instanceId);
    if (animate && i < 14) {
      el.style.setProperty('--i', i);
      el.classList.add('enter');
      el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
    }
    fragment.append(el);
  });
  $('#records').replaceChildren(fragment);
  $('#records-table').hidden = matches.length === 0;
  $('#records-empty').hidden = matches.length > 0;
}

async function saveItem(id, patch) {
  const item = state.items.get(id);
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, item[key]]));
  Object.assign(item, patch);
  recompute();
  try {
    await api('PATCH', `/api/items/${encodeURIComponent(id)}`, patch);
  } catch (err) {
    Object.assign(item, previous);
    recompute();
    toast(`Couldn’t save: ${err.message}`, 'error');
  }
}

/* ---------- selection ---------- */

function select(id, checked, range) {
  const ids = range && lastChecked ? visibleRange(lastChecked, id) : [id];
  for (const each of ids) {
    if (checked) state.selected.add(each);
    else state.selected.delete(each);
  }
  lastChecked = id;
  renderSelection();
}

function visibleRange(from, to) {
  const ids = [...$('#records').children].map((el) => el.dataset.id);
  const a = ids.indexOf(from);
  const b = ids.indexOf(to);
  if (a === -1 || b === -1) return [to];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

function clearSelection() {
  state.selected.clear();
  lastChecked = null;
  renderSelection();
}

function renderSelection() {
  for (const [id, row] of rows) {
    const on = state.selected.has(id);
    row.check.checked = on;
    row.el.classList.toggle('is-selected', on);
  }

  const count = state.selected.size;
  const open = count > 0 && state.view === 'records';
  const bar = $('#actionbar');
  bar.toggleAttribute('data-open', open);
  bar.inert = !open;
  if (!count) return;

  $('#selection-count').textContent = `${count} selected`;
  const add = $('#selection-add');
  add.replaceChildren(
    h('option', { value: '' }, 'Add to bundle…'),
    ...[...state.bundles.values()].map((bundle) => h('option', { value: bundle.id }, bundle.name)),
  );
  add.parentElement.hidden = state.bundles.size === 0;
  $('#selection-unbundle').hidden = ![...state.selected].some((id) => state.bundles.has(state.items.get(id)?.bundleId));
}

async function assignBundle(ids, bundleId) {
  try {
    const { items } = await api('POST', '/api/items/bundle', { itemIds: ids, bundleId });
    for (const item of items) state.items.set(item.instanceId, item);
    state.selected.clear();
    recompute();
    toast(
      bundleId
        ? `Added ${plural(ids.length, 'record')} to ${state.bundles.get(bundleId).name}`
        : `Removed ${plural(ids.length, 'record')} from bundles`,
      'success',
    );
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- new bundle dialog ---------- */

function openBundleDialog() {
  const ids = [...state.selected];
  const moving = ids.filter((id) => state.bundles.has(state.items.get(id)?.bundleId)).length;
  $('#bundle-name').value = '';
  $('#bundle-shipping').value = '';
  $('#bundle-currency').textContent = fmt.symbol;
  $('#bundle-count').textContent = `the ${plural(ids.length, 'selected record')}`;
  $('#bundle-move').hidden = moving === 0;
  $('#bundle-move').textContent = `${plural(moving, 'record')} will move out of ${moving === 1 ? 'its' : 'their'} current bundle.`;
  updatePreview();
  $('#bundle-dialog').showModal();
}

function updatePreview() {
  const cents = parseMoney($('#bundle-shipping').value);
  const out = $('#bundle-preview');
  if (Number.isNaN(cents)) {
    out.textContent = 'Enter an amount like 8.50';
    out.dataset.kind = 'error';
    return;
  }
  delete out.dataset.kind;
  out.textContent = `${splitLabel(cents ?? 0, state.selected.size)} shipping per record`;
}

async function createBundle(event) {
  event.preventDefault();
  const shipping = parseMoney($('#bundle-shipping').value);
  if (Number.isNaN(shipping)) {
    $('#bundle-shipping').focus();
    return;
  }
  const submit = $('#bundle-submit');
  submit.disabled = true;
  try {
    const ids = [...state.selected];
    const { bundle, items } = await api('POST', '/api/bundles', {
      name: $('#bundle-name').value,
      shipping: shipping ?? 0,
      itemIds: ids,
    });
    state.bundles.set(bundle.id, bundle);
    for (const item of items) state.items.set(item.instanceId, item);
    state.selected.clear();
    $('#bundle-dialog').close();
    recompute();
    toast(`Bundled ${plural(ids.length, 'record')} as ${bundle.name}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

/* ---------- bundles view ---------- */

function renderBundles() {
  // Rebuild only when bundles or their members change; otherwise patch numbers in place
  // so focus and in-progress typing survive.
  const shape = [...ledger.bundles].map(([id, totals]) => `${id}:${totals.items.map((i) => i.instanceId)}`).join('|');
  if (shape !== bundleShape) {
    bundleShape = shape;
    bundleCards.clear();
    const list = [...state.bundles.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    $('#bundle-list').replaceChildren(
      ...list.map((bundle) => {
        const card = createBundleCard(bundle);
        bundleCards.set(bundle.id, card);
        return card.el;
      }),
    );
  }
  for (const [id, card] of bundleCards) patchBundle(card, state.bundles.get(id), ledger.bundles.get(id));
  $('#bundles-empty').hidden = state.bundles.size > 0;
}

function createBundleCard(bundle) {
  const id = bundle.id;
  const totals = ledger.bundles.get(id);

  const name = h('input', { class: 'bundle-name', 'aria-label': 'Bundle name', maxlength: '80', autocomplete: 'off' });
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') name.blur();
    if (event.key === 'Escape') {
      name.value = state.bundles.get(id).name;
      name.blur();
    }
  });
  name.addEventListener('blur', () => {
    const value = name.value.trim();
    const current = state.bundles.get(id);
    if (!value) name.value = current.name;
    else if (value !== current.name) saveBundle(id, { name: value });
  });

  const del = h('button', { type: 'button', class: 'btn ghost danger' }, 'Delete');
  let confirmTimer = 0;
  del.addEventListener('click', () => {
    if (del.dataset.confirm) {
      clearTimeout(confirmTimer);
      deleteBundle(id);
      return;
    }
    del.dataset.confirm = 'true';
    swapText(del, 'Confirm delete');
    confirmTimer = setTimeout(() => {
      delete del.dataset.confirm;
      swapText(del, 'Delete');
    }, 3000);
  });

  const shipping = moneyInput(`Shipping for ${bundle.name}`, 'bundle-shipping', (value) =>
    saveBundle(id, { shipping: value ?? 0 }),
  );
  const perRecord = h('span', { class: 'per-record' });
  const lines = totals.items.map((item) => {
    const paid = h('span', { class: 'amount' });
    const share = h('span', { class: 'amount muted' });
    const el = h(
      'li',
      { class: 'bundle-item' },
      cover(item.thumb, 36),
      h('div', { class: 'meta' }, h('p', { class: 'title' }, item.title), h('p', { class: 'sub' }, item.artist)),
      paid,
      share,
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': `Remove ${item.title} from this bundle`,
          onclick: () => assignBundle([item.instanceId], null),
        },
        icon('x'),
      ),
    );
    return { id: item.instanceId, el, paid, share };
  });
  const summary = h('div', { class: 'bundle-sum' });

  const el = h(
    'li',
    { class: 'bundle', tabindex: '-1', 'aria-label': bundle.name },
    h('div', { class: 'bundle-head' }, name, del),
    h('div', { class: 'bundle-ship' }, h('span', { class: 'field-label' }, 'Shipping'), shipping.el, perRecord),
    lines.length
      ? h('ul', { class: 'bundle-items' }, lines.map((line) => line.el))
      : h('p', { class: 'bundle-empty' }, 'No records in this bundle yet, so its shipping isn’t counted anywhere.'),
    summary,
  );
  el.addEventListener('animationend', () => el.classList.remove('flash'));

  return { el, name, shipping, perRecord, lines, summary };
}

function patchBundle(card, bundle, totals) {
  if (document.activeElement !== card.name) card.name.value = bundle.name;
  card.el.setAttribute('aria-label', bundle.name);
  card.shipping.set(bundle.shipping);
  const n = totals.items.length;
  card.perRecord.textContent = n ? `${splitLabel(bundle.shipping, n)} each across ${plural(n, 'record')}` : '';
  for (const line of card.lines) {
    const item = state.items.get(line.id);
    line.paid.textContent = item?.gift ? 'Gift' : formatMoney(item?.paid);
    line.paid.classList.toggle('is-gift', Boolean(item?.gift));
    line.share.textContent = `+ ${formatMoney(ledger.rows.get(line.id)?.ship ?? 0)}`;
  }
  const unpriced = totals.unpriced ? ` (${totals.unpriced} unpriced)` : '';
  card.summary.replaceChildren(
    h('span', null, `Records ${formatMoney(totals.records)}${unpriced}`),
    h('span', null, `Shipping ${formatMoney(totals.shipping)}`),
    h('strong', null, `Total ${formatMoney(totals.records + totals.shipping)}`),
  );
}

async function saveBundle(id, patch) {
  const bundle = state.bundles.get(id);
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, bundle[key]]));
  Object.assign(bundle, patch);
  recompute();
  try {
    await api('PATCH', `/api/bundles/${encodeURIComponent(id)}`, patch);
  } catch (err) {
    Object.assign(bundle, previous);
    recompute();
    toast(`Couldn’t save: ${err.message}`, 'error');
  }
}

async function deleteBundle(id) {
  const { name } = state.bundles.get(id);
  try {
    const { items } = await api('DELETE', `/api/bundles/${encodeURIComponent(id)}`);
    state.bundles.delete(id);
    for (const item of items) state.items.set(item.instanceId, item);
    recompute();
    toast(`Deleted ${name}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function showBundle(id) {
  setView('bundles');
  const card = bundleCards.get(id);
  if (!card) return;
  card.el.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  card.el.focus({ preventScroll: true });
  card.el.classList.remove('flash');
  void card.el.offsetWidth; // restart the highlight if it's already playing
  card.el.classList.add('flash');
}

/* ---------- page ---------- */

function setView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const active = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  $('#records-view').hidden = view !== 'records';
  $('#bundles-view').hidden = view !== 'bundles';
  renderSelection();
}

function setFilter(filter) {
  state.filter = filter;
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  }
  renderRecords();
}

function renderStats() {
  const t = ledger.totals;
  $('#stat-spent').textContent = formatMoney(t.spent);
  const gifts = t.gifts ? ` · ${plural(t.gifts, 'gift')}` : '';
  $('#stat-spent-sub').textContent = `${formatMoney(t.records)} records + ${formatMoney(t.shipping)} shipping${gifts}`;
  $('#stat-owned').textContent = t.owned.toLocaleString();
  $('#stat-unpriced').textContent = t.unpriced ? `${t.unpriced.toLocaleString()} without a price` : 'Every record priced';
  $('#stat-unpriced').disabled = t.unpriced === 0;
  $('#stat-sold').textContent = formatMoney(t.sold);
  $('#stat-sold-sub').textContent = `${plural(t.soldCount, 'record')} sold`;
  $('#stat-profit').textContent = t.profitCount ? fmt.signed.format(t.profit / 100) : EMPTY;
  $('#stat-profit').dataset.tone = tone(t.profitCount ? t.profit : 0);
  $('#stat-profit-sub').textContent = t.profitCount
    ? `Across ${plural(t.profitCount, 'sold record')}`
    : 'Add a sold price to see it';
}

function renderCounts() {
  const items = [...state.items.values()];
  for (const [key, test] of Object.entries(FILTERS)) {
    $(`[data-filter="${key}"] .count`).textContent = items.filter(test).length.toLocaleString();
  }
  $('#count-records').textContent = items.length.toLocaleString();
  $('#count-bundles').textContent = state.bundles.size ? state.bundles.size.toLocaleString() : '';
}

/** Feeds the suggestions, most used first: places for bought records, people for gifts. */
function renderSuggestions() {
  const lists = { places: new Map(), givers: new Map() };
  for (const { source, gift } of state.items.values()) {
    if (!source) continue;
    const counts = gift ? lists.givers : lists.places;
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  for (const [id, counts] of Object.entries(lists)) {
    const values = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || collator.compare(a, b));
    const key = values.join('\n');
    if (key === suggestionKeys[id]) continue;
    suggestionKeys[id] = key;
    $(`#${id}`).replaceChildren(...values.map((value) => h('option', { value })));
  }
}

function renderSynced() {
  const el = $('#synced');
  if (!state.lastSyncedAt) {
    el.textContent = '';
    return;
  }
  const then = new Date(state.lastSyncedAt);
  el.dateTime = state.lastSyncedAt;
  el.title = then.toLocaleString();
  el.textContent = `Synced ${ago(then)}`;
}

function recompute() {
  ledger = computeLedger([...state.items.values()], state.bundles);
  for (const [id, row] of rows) patchRow(row, state.items.get(id));
  renderStats();
  renderCounts();
  renderSuggestions();
  renderBundles();
  renderSelection();
}

function applyState(data, { animate = false } = {}) {
  state.configured = data.configured;
  state.username = data.username;
  state.lastSyncedAt = data.lastSyncedAt;
  state.items = new Map(data.items.map((item) => [item.instanceId, item]));
  state.bundles = new Map(data.bundles.map((bundle) => [bundle.id, bundle]));
  for (const id of state.selected) if (!state.items.has(id)) state.selected.delete(id);
  setCurrency(data.currency ?? 'USD');

  rows.clear();
  for (const item of state.items.values()) rows.set(item.instanceId, createRow(item));
  bundleShape = null;

  const ready = Boolean(state.configured && state.lastSyncedAt);
  $('#setup').hidden = state.configured;
  $('#welcome').hidden = !state.configured || Boolean(state.lastSyncedAt);
  $('#app').hidden = !ready;
  $('#refresh').hidden = !ready;
  $('#who').textContent = state.username ? `@${state.username}` : '';
  $('#version').textContent = data.version === 'dev' ? 'dev' : `v${data.version}`;
  renderSynced();

  recompute();
  renderRecords({ animate });
}

async function sync() {
  const refresh = $('#refresh');
  if (refresh.getAttribute('aria-busy') === 'true') return;
  const firstImport = !state.lastSyncedAt;
  for (const button of [refresh, $('#import')]) button.setAttribute('aria-busy', 'true');
  swapText($('#refresh-label'), 'Syncing');
  swapText($('#import-label'), 'Importing…');
  try {
    const data = await api('POST', '/api/sync');
    applyState(data, { animate: true });
    const { added, removed, total } = data.summary;
    const changes = [added && `${added} new`, removed && `${removed} removed`].filter(Boolean).join(' · ');
    toast(
      firstImport ? `Imported ${plural(total, 'record')}` : changes || `Up to date · ${plural(total, 'record')}`,
      'success',
    );
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    for (const button of [refresh, $('#import')]) button.removeAttribute('aria-busy');
    swapText($('#refresh-label'), 'Refresh');
    swapText($('#import-label'), 'Import from Discogs');
  }
}

function wire() {
  $('#refresh').addEventListener('click', sync);
  $('#import').addEventListener('click', sync);

  $('#search').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderRecords();
  });
  $('#sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderRecords();
  });
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => setFilter(button.dataset.filter));
  }
  $('#reset-filters').addEventListener('click', () => {
    state.query = '';
    $('#search').value = '';
    setFilter('all');
  });
  $('#stat-unpriced').addEventListener('click', () => {
    setView('records');
    setFilter('unpriced');
  });

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      setView(next.dataset.view);
    });
  }

  $('#selection-new').addEventListener('click', openBundleDialog);
  $('#selection-clear').addEventListener('click', clearSelection);
  $('#selection-unbundle').addEventListener('click', () => {
    const ids = [...state.selected].filter((id) => state.bundles.has(state.items.get(id)?.bundleId));
    assignBundle(ids, null);
  });
  $('#selection-add').addEventListener('change', (event) => {
    const bundleId = event.target.value;
    event.target.value = '';
    if (bundleId) assignBundle([...state.selected], bundleId);
  });

  $('#bundle-form').addEventListener('submit', createBundle);
  $('#bundle-shipping').addEventListener('input', updatePreview);
  $('#bundle-cancel').addEventListener('click', () => $('#bundle-dialog').close());

  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest?.('input:not([type="checkbox"]), select, textarea');
    if (typing || $('#bundle-dialog').open || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/' && !$('#app').hidden) {
      event.preventDefault();
      setView('records');
      $('#search').focus();
    } else if (event.key === 'Escape' && state.selected.size) {
      clearSelection();
    }
  });

  setInterval(renderSynced, 30_000);
}

async function init() {
  wire();
  try {
    applyState(await api('GET', '/api/state'), { animate: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

init();
