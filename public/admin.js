// /admin: review community boards and manage tags.
// All text from the database goes in with textContent (via h()), never as HTML.

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'onclick' || k === 'onchange' || k === 'oninput') el[k] = v;
    else if (k === 'disabled' || k === 'checked') el[k] = true;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false).map((x) => (typeof x === 'number' ? String(x) : x)));
  return el;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false));
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const MAX_TAGS = 3;

// JSON API. referrerPolicy 'same-origin' makes the browser send the Origin header the server checks.
async function api(path, body) {
  const opts = { credentials: 'same-origin', referrerPolicy: 'same-origin', headers: {} };
  if (body !== undefined) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch('/admin/api/' + path, opts); } catch { throw new Error('Couldn\'t reach the server. Check your connection.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') { loggedOut(); throw new Error(data.error || 'Please log in again.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

let msgTimer = null;
function say(text, bad = false) {
  const el = $('aMsg');
  el.textContent = text;
  el.classList.toggle('bad', bad);
  show('aMsg', true);
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => show('aMsg', false), bad ? 8000 : 4000);
}
// Runs an action, shows its error (if any), then reloads the current tab.
async function run(fn, done) {
  try { await fn(); if (done) say(done); await load(); } catch (err) { say(err.message, true); }
}

// ---- Login ----
function loggedOut() {
  show('aApp', false);
  show('aLogout', false);
  show('aLogin', true);
  $('aPin').focus();
}
$('aLogin').onsubmit = async (e) => {
  e.preventDefault();
  $('aLoginMsg').textContent = '';
  try {
    await api('login', { pin: $('aPin').value });
    $('aPin').value = '';
    start();
  } catch (err) { $('aLoginMsg').textContent = err.message; }
};
$('aLogout').onclick = async () => { await api('logout', {}).catch(() => {}); loggedOut(); };

// ---- Tabs ----
let tab = 'pending';
let tags = []; // [{ id, name, emoji, boards, approved }]
const tagName = (id) => { const t = tags.find((x) => x.id === id); return t ? `${t.emoji} ${t.name}`.trim() : '?'; };
document.querySelectorAll('.a-tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; load(); }));

async function load() {
  document.querySelectorAll('.a-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  try {
    tags = (await api('tags')).tags;
    const view = $('aView');
    if (tab === 'pending') fill(view, await pendingView());
    else if (tab === 'approved') fill(view, await approvedView());
    else fill(view, tagsView());
  } catch (err) { say(err.message, true); }
}

async function start() {
  show('aLogin', false);
  show('aApp', true);
  show('aLogout', true);
  await load();
}

// Tag checkboxes (max 3). `chosen` is a Set of tag ids that the boxes keep up to date.
function tagPicker(chosen) {
  const boxes = tags.map((t) => [t.id, h('input', { type: 'checkbox', checked: chosen.has(t.id) })]);
  const limit = () => boxes.forEach(([id, cb]) => (cb.disabled = !chosen.has(id) && chosen.size >= MAX_TAGS));
  boxes.forEach(([id, cb]) => (cb.onchange = () => { cb.checked ? chosen.add(id) : chosen.delete(id); limit(); }));
  limit();
  const el = h('div', { class: 'a-tags' }, boxes.map(([id, cb]) => h('label', { class: 'a-tag' }, cb, tagName(id))));
  // Ticks a tag; false when 3 are already ticked.
  el.tick = (id) => {
    if (!chosen.has(id) && chosen.size >= MAX_TAGS) return false;
    chosen.add(id);
    const box = boxes.find(([x]) => x === id);
    if (box) box[1].checked = true;
    limit();
    return true;
  };
  return el;
}

// ---- Review queue ----
async function pendingView() {
  const { boards } = await api('pending');
  document.querySelector('[data-tab="pending"]').textContent = `Review queue (${boards.length})`;
  if (!boards.length) return h('p', { class: 'muted' }, 'Nothing waiting for review. 🎉');
  return boards.map(reviewCard);
}

function reviewCard(b) {
  const chosen = new Set(b.tag_ids);
  let clearSuggested = false;
  let picker = tagPicker(chosen);
  const madeBy = h('input', { maxlength: 30, value: b.made_by || '', placeholder: 'Anonymous' });
  const kid = h('input', { type: 'checkbox', checked: b.kid_friendly });
  const reason = h('input', { maxlength: 200, placeholder: 'Reason (optional, for your records)' });

  // The suggested tag: link to an existing tag, create it, or ignore it.
  let suggestBox = null;
  if (b.suggested_tag) {
    const pick = h('select', {}, tags.map((t) => h('option', { value: t.id }, tagName(t.id))));
    const newName = h('input', { maxlength: 24, value: b.suggested_tag });
    const newEmoji = h('input', { maxlength: 8, placeholder: '🏷️', class: 'a-emoji' });
    const done = (text) => { clearSuggested = true; fill(suggestBox, h('span', { class: 'muted' }, text)); };
    suggestBox = h('div', { class: 'a-suggest' },
      h('div', {}, 'Suggested new tag: ', h('b', {}, b.suggested_tag)),
      h('div', { class: 'a-row' }, pick, h('button', { class: 'secondary', onclick: () => {
        const id = Number(pick.value);
        if (!picker.tick(id)) return say(`Untick a tag first (max ${MAX_TAGS}).`, true);
        done(`Linked to ${tagName(id)} (saved when you approve).`);
      } }, 'Link to existing tag')),
      h('div', { class: 'a-row' }, newEmoji, newName, h('button', { class: 'secondary', onclick: async () => {
        if (chosen.size >= MAX_TAGS) return say(`Untick a tag first (max ${MAX_TAGS}), so the new tag can be ticked.`, true);
        try {
          const res = await api('tags', { name: newName.value, emoji: newEmoji.value });
          tags = (await api('tags')).tags;
          const fresh = tagPicker(chosen);
          picker.replaceWith(fresh);
          picker = fresh;
          fresh.tick(res.id);
          done(`Created ${tagName(res.id)} and ticked it.`);
        } catch (err) { say(err.message, true); }
      } }, 'Create as new tag')),
      h('button', { class: 'secondary', onclick: () => done('Ignored.') }, 'Ignore'));
  }

  const approve = async () => {
    await run(async () => {
      await api(`packs/${b.id}`, { tags: [...chosen], madeBy: madeBy.value, kidFriendly: kid.checked, ...(clearSuggested ? { suggestedTag: null } : {}) });
      await api(`packs/${b.id}/approve`, {});
    }, `Approved “${b.name}”.`);
  };
  const reject = async () => {
    if (!confirm(`Reject “${b.name}”?`)) return;
    await run(() => api(`packs/${b.id}/reject`, { reason: reason.value }), `Rejected “${b.name}”.`);
  };

  return h('article', { class: 'a-card a-board' },
    h('h3', {}, `${b.emoji} ${b.name}`.trim()),
    h('div', { class: 'muted' }, `Submitted ${when(b.created_at)}`),
    htmlFlag(b),
    h('div', { class: 'a-grid' },
      h('label', {}, 'Made by'), madeBy,
      h('label', {}, 'Kid-friendly'), h('label', { class: 'a-check' }, kid, '👨‍👩‍👧 Suits children')),
    h('div', { class: 'a-label' }, `Tags (1–${MAX_TAGS})`), picker, suggestBox,
    preview(b),
    h('div', { class: 'a-row a-actions' },
      h('button', { onclick: approve }, '✅ Approve'),
      reason,
      h('button', { class: 'danger', onclick: reject }, '✕ Reject')));
}

// Every category, then every question with its answer, bonus and fun fact. ⚠️ marks "verify".
function preview(b) {
  const verify = b.boards.reduce((n, bd) => n + bd.categories.reduce((m, c) => m + c.questions.filter((q) => q.verify).length, 0), 0);
  const box = h('details', { class: 'a-preview', open: '' },
    h('summary', {}, `Full preview${verify ? ` · ⚠️ ${verify} to verify` : ''}`),
    b.teams?.length ? h('div', { class: 'muted' }, 'Teams: ' + b.teams.join(', ')) : null,
    b.boards.map((bd, bi) => [
      h('h4', {}, `Board ${bi + 1}: ${bd.name}`),
      bd.categories.map((c) => h('div', { class: 'a-cat' },
        h('div', { class: 'a-cat-name' }, c.name), c.note ? h('div', { class: 'muted' }, c.note) : null,
        h('ol', {}, c.questions.map((q) => h('li', { class: q.verify ? 'a-verify' : null },
          h('div', {}, h('b', {}, `${q.value} `), q.verify ? '⚠️ ' : '', q.question, ' → ', h('b', {}, q.answer)),
          q.bonus ? h('div', { class: 'muted' }, `⭐ Bonus: ${q.bonus}`) : null,
          q.funFact ? h('div', { class: 'muted' }, `💡 ${q.funFact}`) : null))))),
    ]),
    b.sparkle ? sparklePreview(b.sparkle) : h('div', { class: 'muted' }, 'No Sparkle deck (uses the party deck).'));
  return box;
}

function sparklePreview(s) {
  const lists = [['Draw easy', s.draw?.easy], ['Draw medium', s.draw?.medium], ['Draw tricky', s.draw?.tricky], ['Charades', s.charades], ['Mimic', s.mimic]];
  return [h('h4', {}, '✨ Sparkle deck'), lists.filter(([, l]) => l?.length).map(([label, l]) => h('div', {}, h('b', {}, `${label}: `), l.join(' · ')))];
}

// ---- Approved boards ----
// ⚠️ when HTML-looking tags were found in a board (they're removed when it's shared or played).
const htmlFlag = (b) => (b.html_flag ? h('div', { class: 'a-flag', role: 'note' }, '⚠️ HTML tags were removed from this board. Check the text still reads right.') : null);

async function approvedView() {
  const { boards } = await api('approved');
  if (!boards.length) return h('p', { class: 'muted' }, 'No approved boards yet.');
  return boards.map((b) => {
    const row = h('article', { class: `a-card a-listed ${b.status === 'archived' ? 'a-archived' : ''}` });
    const view = () => fill(row,
      h('div', { class: 'a-row a-spread' },
        h('h3', {}, `${b.emoji} ${b.name}`.trim(), b.status === 'archived' ? h('span', { class: 'a-badge' }, 'Archived') : null),
        h('div', { class: 'a-row' },
          h('button', { class: 'secondary', onclick: edit }, 'Edit'),
          b.status === 'approved'
            ? h('button', { class: 'secondary', onclick: () => run(() => api(`packs/${b.id}/archive`, {}), 'Archived. It\'s hidden from Community.') }, 'Archive')
            : h('button', { class: 'secondary', onclick: () => run(() => api(`packs/${b.id}/unarchive`, {}), 'Back in Community.') }, 'Unarchive'))),
      h('div', { class: 'muted' }, [b.tag_ids.map(tagName).join(', ') || 'No tags', b.made_by ? `Made by ${b.made_by}` : 'Anonymous',
        `Played ${b.play_count} time${b.play_count === 1 ? '' : 's'}`, b.kid_friendly ? '👨‍👩‍👧 Kid-friendly' : null].filter(Boolean).join(' · ')),
      htmlFlag(b));
    const edit = () => {
      const chosen = new Set(b.tag_ids);
      const madeBy = h('input', { maxlength: 30, value: b.made_by || '', placeholder: 'Anonymous' });
      const kid = h('input', { type: 'checkbox', checked: b.kid_friendly });
      fill(row, h('h3', {}, `${b.emoji} ${b.name}`.trim()),
        h('div', { class: 'a-grid' }, h('label', {}, 'Made by'), madeBy, h('label', {}, 'Kid-friendly'), h('label', { class: 'a-check' }, kid, '👨‍👩‍👧 Suits children')),
        h('div', { class: 'a-label' }, 'Tags'), tagPicker(chosen),
        h('div', { class: 'a-row' },
          h('button', { onclick: () => {
            if (!chosen.size) return say('Tick at least 1 tag.', true);
            run(() => api(`packs/${b.id}`, { tags: [...chosen], madeBy: madeBy.value, kidFriendly: kid.checked }), 'Saved.');
          } }, 'Save'),
          h('button', { class: 'secondary', onclick: view }, 'Cancel')));
    };
    view();
    return row;
  });
}

// ---- Tags ----
function tagsView() {
  const name = h('input', { maxlength: 24, placeholder: 'New tag name' });
  const emoji = h('input', { maxlength: 8, placeholder: '🏷️', class: 'a-emoji' });
  const add = h('form', { class: 'a-card a-row' }, emoji, name, h('button', { type: 'submit' }, 'Add tag'));
  add.onsubmit = (e) => { e.preventDefault(); run(() => api('tags', { name: name.value, emoji: emoji.value }), 'Tag added.'); };

  return [add, h('div', { class: 'a-card' }, tags.map((t) => {
    const n = h('input', { maxlength: 24, value: t.name });
    const em = h('input', { maxlength: 8, value: t.emoji, class: 'a-emoji' });
    const into = h('select', {}, h('option', { value: '' }, 'Merge into…'), tags.filter((x) => x.id !== t.id).map((x) => h('option', { value: x.id }, tagName(x.id))));
    return h('div', { class: 'a-tagrow' },
      em, n,
      h('button', { class: 'secondary', onclick: () => run(() => api(`tags/${t.id}`, { name: n.value, emoji: em.value }), 'Tag saved.') }, 'Save'),
      h('span', { class: 'muted a-count' }, `${t.boards} board${t.boards === 1 ? '' : 's'} (${t.approved} live)`),
      into,
      h('button', { class: 'secondary', onclick: () => {
        if (!into.value) return say('Pick the tag to merge into.', true);
        const target = Number(into.value);
        if (!confirm(`Move every board from ${tagName(t.id)} to ${tagName(target)} and delete ${t.name}?`)) return;
        run(() => api(`tags/${t.id}/merge`, { into: target }), 'Merged.');
      } }, 'Merge'),
      h('button', { class: 'danger', disabled: t.boards > 0, title: t.boards ? 'In use: merge it instead' : null, onclick: () => {
        if (confirm(`Delete the tag ${t.name}?`)) run(() => api(`tags/${t.id}/delete`, {}), 'Tag deleted.');
      } }, 'Delete'));
  }))];
}

// ---- Start ----
(async () => {
  let s;
  try { s = await api('session'); } catch (err) { $('aNotice').textContent = err.message; return show('aNotice', true); }
  if (!s.hasDb || !s.hasPin) {
    $('aNotice').textContent = !s.hasDb
      ? 'Community boards are off: the server has no database. Set DATABASE_URL (see the README).'
      : 'Set ADMIN_PIN on the server to use this page (see the README).';
    show('aNotice', true);
    if (!s.hasPin) return;
  }
  if (s.loggedIn) start(); else loggedOut();
})();
