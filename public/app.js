// Leo's Game Hub 正式前端：原生 JS + /sdk/game-hub.js，hash 路由（无需 SPA_FALLBACK）。
import { createClient, ApiError } from '/sdk/game-hub.js';

const client = createClient();
const root = document.getElementById('app');

// ── 工具 ────────────────────────────────────────────────────────────────
class Raw { constructor(s) { this.s = s; } }
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v).replace(/[&<>"']/g, c => ESC[c]);
const flat = v => v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(flat).join('') : esc(v);
const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? flat(vals[i]) : ''), ''));
const when = (cond, fn) => (cond ? fn() : '');

const pad = n => String(n).padStart(2, '0');
const M = 60000, H = 3600000;
const relTime = iso => {
  const d = Date.now() - Date.parse(iso);
  if (d < M) return '刚刚';
  if (d < H) return Math.round(d / M) + ' 分钟前';
  if (d < 24 * H) return Math.floor(d / H) + ' 小时前';
  return Math.floor(d / (24 * H)) + ' 天前';
};
const absTime = (iso, dateOnly) => {
  const x = new Date(iso), day = x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  return dateOnly ? day : day + ' ' + pad(x.getHours()) + ':' + pad(x.getMinutes());
};
const size = b => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB');
const bytesLimit = b => (b >= 1048576 && b % 1048576 === 0 ? b / 1048576 + ' MiB' : b >= 1024 ? Math.round(b / 1024) + ' KiB' : b + ' B');
const errMsg = e => (e instanceof ApiError ? e.message : '网络连接失败，请稍后重试');

// 没有封面的作品用标题首字做占位封面，配色按 slug 固定。
const PALETTE = [
  ['#1d2a2e', '#c9d6cf'], ['#2b2413', '#e8c35a'], ['#26151a', '#e07a6a'], ['#d9d2c1', '#1b1a17'], ['#13161f', '#8fa3d6'],
  ['#1f1b16', '#d9a066'], ['#1a2415', '#a6d46b'], ['#0f1424', '#e8e2c8'], ['#2a2a26', '#ece5d3'], ['#120f0e', '#e5482c'],
];
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// ── 状态 ────────────────────────────────────────────────────────────────
const S = {
  booted: false, games: [], gamesErr: null, gamesLoading: true,
  user: null, saves: [], savesLoading: false,
  route: { name: 'home' }, sel: null, q: '', tag: '全部',
  auth: { open: false, mode: 'login', after: null, user: '', name: '', pw: '', err: {}, busy: false },
  fullscreen: false, drawer: false, needsReload: false, frameLoading: true, frameKey: 0, refreshing: false,
  modal: null, toast: null,
  set: { name: '', old: '', nw: '', nw2: '', err: {}, busy: '' },
  vw: window.innerWidth,
};

const allGames = () => S.games;
const findGame = slug => S.games.find(g => g.slug === slug) || null;
const filtered = () => {
  const q = S.q.trim().toLowerCase(), tag = S.tag;
  return S.games.filter(g => (tag === '全部' || g.tags.includes(tag)) &&
    (!q || g.title.toLowerCase().includes(q) || g.description.toLowerCase().includes(q) || g.tags.some(t => t.toLowerCase().includes(q))));
};
const savesFor = slug => (S.user ? S.saves.filter(x => x.slug === slug).sort((a, b) => (a.slot < b.slot ? -1 : 1)) : []);

function vm(g) {
  const idx = S.games.indexOf(g), [bg, fg] = PALETTE[hash(g.slug) % PALETTE.length], saves = savesFor(g.slug);
  const title = g.title || g.slug, first = [...title][0] || '?';
  return {
    g, slug: g.slug, title, desc: g.description, tagText: g.tags.join(' · '),
    no: 'No.' + pad(idx + 1), cover: g.coverUrl, bg, fg, glyph: /[a-z]/i.test(first) ? first.toUpperCase() : first,
    rel: g.currentReleaseId ? g.currentReleaseId.slice(0, 8) : '—', updated: absTime(g.updatedAt, true),
    maxSlots: g.saveCapabilities.maxSlots, maxBytes: g.saveCapabilities.maxBytes, saves,
  };
}

// ── 数据 ────────────────────────────────────────────────────────────────
async function loadGames() {
  S.gamesLoading = true; S.gamesErr = null; render();
  try {
    const items = [];
    for (let page = 1; ; page++) {
      const r = await client.games.list({ page, pageSize: 100 });
      items.push(...r.items);
      if (!r.items.length || items.length >= r.total) break;
    }
    S.games = items;
    if (!findGame(S.sel)) S.sel = items[0]?.slug ?? null;
  } catch (e) { S.gamesErr = errMsg(e); }
  S.gamesLoading = false; render();
}
async function loadSaves() {
  if (!S.user) { S.saves = []; return; }
  S.savesLoading = true; render();
  try {
    const items = [];
    for (let page = 1; ; page++) {
      const r = await client.saves.listAll(page, 100);
      items.push(...r.items);
      if (!r.items.length || items.length >= r.total) break;
    }
    if (S.user) S.saves = items;
  } catch (e) { if (S.user) toast(errMsg(e)); }
  S.savesLoading = false; render();
}
let authProbe = false;
client.onAuthChange(user => {
  // 会话过期（接口返回 401）时 SDK 会通知这里；登录/退出流程也会触发，这里只做同步。
  if (authProbe || (S.user?.id ?? null) === (user?.id ?? null)) return;
  S.user = user; if (!user) { S.saves = []; S.needsReload = false; if (S.route.name === 'profile') go({ name: 'home' }); } render();
});

// ── 路由 ────────────────────────────────────────────────────────────────
function parseHash() {
  const dec = p => { try { return decodeURIComponent(p); } catch { return p; } };
  const [a = '', b = ''] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').map(dec);
  if (a === 'games' && b) return { name: 'detail', slug: b };
  if (a === 'play' && b) return { name: 'play', slug: b };
  if (a === 'me') return { name: 'profile', tab: b === 'settings' ? 'settings' : 'saves' };
  return { name: 'home' };
}
const href = r => r.name === 'detail' ? '#/games/' + encodeURIComponent(r.slug)
  : r.name === 'play' ? '#/play/' + encodeURIComponent(r.slug)
  : r.name === 'profile' ? (r.tab === 'settings' ? '#/me/settings' : '#/me') : '#/';
function go(r, opts = {}) {
  const h = href(r);
  S.fullscreen = !!opts.fs;
  if (location.hash === h || (h === '#/' && !location.hash)) { onRoute(); return; }
  location.hash = h;
}
function onRoute() {
  const prev = S.route, r = parseHash();
  if (r.name === 'profile' && !S.user) {
    history.replaceState(null, '', '#/');
    S.route = { name: 'home' }; openAuth('login', r); render(); return;
  }
  if (prev.name !== r.name || prev.slug !== r.slug) {
    S.drawer = false; S.needsReload = false;
    if (r.name !== 'play') S.fullscreen = false; else { S.frameLoading = true; S.frameKey++; }
    if (r.name !== 'profile' || prev.name !== 'profile') window.scrollTo(0, 0);
  }
  if (r.slug) S.sel = r.slug;
  if (r.name === 'profile' && (prev.name !== 'profile' || prev.tab !== r.tab) && r.tab === 'settings') S.set = { name: S.user.displayName, old: '', nw: '', nw2: '', err: {}, busy: '' };
  S.route = r;
  syncBrowserFullscreen();
  render();
}
window.addEventListener('hashchange', onRoute);

// ── 动作 ────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) { clearTimeout(toastTimer); S.toast = msg; render(); toastTimer = setTimeout(() => { S.toast = null; render(); }, 2600); }
function openAuth(mode, after) { Object.assign(S.auth, { open: true, mode: mode || 'login', after: after || null, err: {}, pw: '', busy: false }); render(); setTimeout(() => root.querySelector('#a-user')?.focus(), 0); }
function closeAuth() { S.auth.open = false; render(); }

async function submitAuth() {
  const a = S.auth, err = {}, u = a.user.trim(), reg = a.mode === 'register';
  if (reg) {
    if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) err.user = '用户名需为 3–20 位字母、数字或下划线';
    if ([...a.name.trim()].length > 24) err.name = '昵称最多 24 个字符';
    if (a.pw.length < 8 || a.pw.length > 128) err.pw = '密码需为 8–128 个字符';
  } else {
    if (!u) err.user = '请输入用户名';
    if (!a.pw) err.pw = '请输入密码';
  }
  a.err = err;
  if (Object.keys(err).length) return render();
  a.busy = true; render();
  try {
    const name = a.name.trim();
    const user = reg ? await client.auth.register({ username: u, password: a.pw, ...(name ? { displayName: name } : {}) })
      : await client.auth.login({ username: u, password: a.pw });
    finishAuth(user, reg ? '注册成功，已自动登录' : '欢迎回来，' + user.displayName);
  } catch (e) {
    a.busy = false;
    if (e instanceof ApiError && e.code === 'USERNAME_TAKEN') a.err = { user: e.message };
    else a.err = { form: errMsg(e) };
    render();
  }
}
function finishAuth(user, msg) {
  const after = S.auth.after;
  Object.assign(S.auth, { open: false, busy: false, pw: '', name: '' });
  S.user = user; S.needsReload = S.route.name === 'play';
  loadSaves();
  toast(msg);
  if (after) go(after);
}
async function logout(all) {
  try { await (all ? client.auth.logoutAll() : client.auth.logout()); }
  catch (e) { S.modal = null; return toast(errMsg(e)); }
  S.user = null; S.saves = []; S.modal = null; S.needsReload = false;
  toast(all ? '所有设备都已退出登录' : '已退出登录');
  if (S.route.name === 'profile') go({ name: 'home' });
}
function askDelete(slug, slot) {
  const x = S.saves.find(y => y.slug === slug && y.slot === slot); if (!x) return;
  S.modal = { title: '删除存档「' + x.slot + '」？', body: '《' + (findGame(slug)?.title || x.gameTitle) + '》· 修订 #' + x.revision + ' · ' + relTime(x.updatedAt) + '。删除后无法恢复，游戏里也将读不到这个存档。', confirm: '删除存档', danger: true, run: () => doDelete(x) };
  render();
}
async function doDelete(x) {
  try {
    await client.saves.remove(x.slug, x.slot, x.revision);
    S.saves = S.saves.filter(y => !(y.slug === x.slug && y.slot === x.slot));
    S.modal = null; toast('已删除存档「' + x.slot + '」');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'SAVE_CONFLICT') {
      const cur = Number(e.details?.currentRevision ?? 0);
      S.modal = cur > 0
        ? { title: '存档已在其他设备更新', body: '云端当前是修订 #' + cur + '，而这里显示的是 #' + x.revision + '。为避免误删新进度，请重新读取后再决定。', confirm: '重新读取', danger: false, run: () => reread('已重新读取 · 修订 #' + cur) }
        : { title: '存档已在其他设备删除', body: '云端已经没有「' + x.slot + '」这个存档了。重新读取后列表会同步。', confirm: '重新读取', danger: false, run: () => reread('已重新读取') };
      render();
    } else if (e instanceof ApiError && e.code === 'SAVE_NOT_FOUND') { S.modal = null; await reread('这个存档已不存在，列表已刷新'); }
    else { S.modal = null; toast(errMsg(e)); }
  }
}
async function reread(msg) { S.modal = null; await loadSaves(); toast(msg); }
async function saveName() {
  const n = S.set.name.trim();
  if (!n || [...n].length > 24) { S.set.err = { name: '昵称需为 1–24 个字符' }; return render(); }
  if (n === S.user.displayName) return;
  S.set.busy = 'name'; render();
  try { S.user = await client.auth.updateProfile(n); S.set.err = {}; toast('昵称已更新'); }
  catch (e) { S.set.err = { name: errMsg(e) }; }
  S.set.busy = ''; render();
}
async function changePw() {
  const s = S.set, err = {};
  if (!s.old) err.old = '请输入原密码';
  if (s.nw.length < 8 || s.nw.length > 128) err.nw = '新密码需为 8–128 个字符';
  else if (s.nw !== s.nw2) err.nw2 = '两次输入的新密码不一致';
  s.err = err;
  if (Object.keys(err).length) return render();
  s.busy = 'pw'; render();
  // 原密码错误也返回 401，SDK 会把它当作已退出；这里暂停同步，随后用 auth.me() 核实会话是否真的失效。
  authProbe = true;
  let unauthorized = false;
  try { await client.auth.changePassword(s.old, s.nw); Object.assign(s, { old: '', nw: '', nw2: '', err: {} }); toast('密码已修改，其他设备已退出登录'); }
  catch (e) {
    unauthorized = e instanceof ApiError && e.status === 401;
    s.err = e instanceof ApiError && e.code === 'INVALID_CREDENTIALS' ? { old: e.message } : { nw: errMsg(e) };
  }
  finally { authProbe = false; }
  s.busy = ''; render();
  if (unauthorized && !(await client.auth.me().catch(() => S.user)) && S.user) {
    S.user = null; S.saves = []; toast('登录已失效，请重新登录'); go({ name: 'home' });
  }
}
function play(slug, fs) { go({ name: 'play', slug }, { fs }); }
function toggleFs() { S.fullscreen = !S.fullscreen; syncBrowserFullscreen(); render(); }
function syncBrowserFullscreen() {
  const want = S.fullscreen && S.route.name === 'play';
  if (want && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (!want && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.fullscreen) { S.fullscreen = false; render(); } });
function reloadGame() { S.needsReload = false; S.frameLoading = true; S.frameKey++; render(); }
async function refreshSaves() { S.refreshing = true; render(); await loadSaves(); S.refreshing = false; toast('云存档已刷新'); }

const actions = {
  login: () => openAuth('login'),
  goSaves: () => (S.user ? go({ name: 'profile', tab: 'saves' }) : openAuth('login', { name: 'profile', tab: 'saves' })),
  play: slug => play(slug),
  playFs: slug => { document.documentElement.requestFullscreen?.().catch(() => {}); play(slug, true); },
  exitPlay: () => go({ name: 'detail', slug: S.route.slug }),
  drawer: () => { S.drawer = !S.drawer; render(); if (S.drawer && S.user) loadSaves(); },
  fs: toggleFs, reload: reloadGame, refresh: refreshSaves,
  tag: t => { S.tag = t; render(); },
  clear: () => { S.q = ''; S.tag = '全部'; render(); },
  retryGames: loadGames,
  closeAuth, authMode: m => { S.auth.mode = m; S.auth.err = {}; render(); },
  logout: () => logout(false),
  logoutAll: () => { S.modal = { title: '退出所有设备？', body: '包括这台设备在内，所有登录都会失效，之后需要重新登录。云存档不受影响。', confirm: '全部退出', danger: true, run: () => logout(true) }; render(); },
  del: arg => { const i = arg.indexOf('/'); askDelete(arg.slice(0, i), arg.slice(i + 1)); },
  mConfirm: async () => { const m = S.modal; if (!m || m.busy) return; m.busy = true; render(); await m.run(); if (S.modal === m) { m.busy = false; render(); } },
  mCancel: () => { S.modal = null; render(); },
  saveName, changePw,
  stop: () => {},
};
const inputs = {
  q: v => { S.q = v; },
  'a.user': v => { S.auth.user = v; }, 'a.name': v => { S.auth.name = v; }, 'a.pw': v => { S.auth.pw = v; },
  's.name': v => { S.set.name = v; }, 's.old': v => { S.set.old = v; }, 's.nw': v => { S.set.nw = v; }, 's.nw2': v => { S.set.nw2 = v; },
};

root.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el || !root.contains(el)) return;
  if (el.dataset.act === 'stop') return;
  e.preventDefault();
  actions[el.dataset.act]?.(el.dataset.arg);
});
root.addEventListener('input', e => { const f = e.target.dataset?.input; if (f && inputs[f]) { inputs[f](e.target.value); render(); } });
root.addEventListener('submit', e => { e.preventDefault(); if (e.target.dataset.submit === 'auth' && !S.auth.busy) submitAuth(); });
root.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-hover-sel]');
  if (el && S.sel !== el.dataset.hoverSel) { S.sel = el.dataset.hoverSel; render(); }
});
// 封面加载失败时露出下面的占位字
root.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);
root.addEventListener('load', e => { if (e.target.tagName === 'IFRAME' && S.frameLoading) { S.frameLoading = false; render(); } }, true);
window.addEventListener('resize', () => { if (S.vw !== window.innerWidth) { S.vw = window.innerWidth; render(); } });

// ── 键盘 ────────────────────────────────────────────────────────────────
function move(key) {
  const list = filtered(); if (!list.length) return;
  const cur = Math.max(0, list.findIndex(g => g.slug === S.sel)); let next = cur;
  const grid = root.querySelector('#grid');
  if (key === 'ArrowRight') next = Math.min(list.length - 1, cur + 1);
  else if (key === 'ArrowLeft') next = Math.max(0, cur - 1);
  else {
    if (!grid) return;
    const rects = [...grid.querySelectorAll('[data-idx]')].map(el => el.getBoundingClientRect()), r = rects[cur]; if (!r) return;
    const cx = r.left + r.width / 2, down = key === 'ArrowDown';
    const cand = rects.map((q, i) => ({ i, q })).filter(o => (down ? o.q.top > r.top + 4 : o.q.top < r.top - 4)); if (!cand.length) return;
    const rowTop = down ? Math.min(...cand.map(o => o.q.top)) : Math.max(...cand.map(o => o.q.top));
    const rowC = cand.filter(o => Math.abs(o.q.top - rowTop) < 4).sort((a, b) => Math.abs(a.q.left + a.q.width / 2 - cx) - Math.abs(b.q.left + b.q.width / 2 - cx));
    next = rowC[0].i;
  }
  S.sel = list[next].slug; render();
  const el = grid && grid.querySelector('[data-idx="' + next + '"]');
  if (el) {
    const b = el.getBoundingClientRect();
    if (b.bottom > window.innerHeight - 56) window.scrollBy({ top: b.bottom - window.innerHeight + 96, behavior: 'smooth' });
    else if (b.top < 80) window.scrollBy({ top: b.top - 110, behavior: 'smooth' });
  }
}
window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target, tag = t && t.tagName, typing = tag === 'INPUT' || tag === 'TEXTAREA', r = S.route;
  if (e.key === 'Escape') {
    if (S.modal) { S.modal = null; return render(); }
    if (S.auth.open) return closeAuth();
    if (S.fullscreen) return toggleFs();
    if (typing) return t.blur();
    if (r.name === 'play') return go({ name: 'detail', slug: r.slug });
    if (r.name === 'detail' || r.name === 'profile') return go({ name: 'home' });
    return;
  }
  if (typing || tag === 'BUTTON' || S.auth.open || S.modal) return;
  if (r.name === 'home') {
    if (e.key === '/') { e.preventDefault(); root.querySelector('#q')?.focus(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); return move(e.key); }
    if (e.key === 'Enter') { e.preventDefault(); const list = filtered(), g = list.find(x => x.slug === S.sel) || list[0]; if (g) play(g.slug); }
  } else if (r.name === 'detail' && e.key === 'Enter' && findGame(r.slug)) { e.preventDefault(); play(r.slug); }
  else if (r.name === 'play' && (e.key === 'f' || e.key === 'F')) toggleFs();
});

// ── 视图片段 ────────────────────────────────────────────────────────────
const kbd = (k, cls = '') => html`<span class="kbd ${cls}">${k}</span>`;
const tri = (cls = '') => html`<span class="tri ${cls}"></span>`;
const meter = (n, max, cls) => html`<div class="meter ${cls}">${Array.from({ length: Math.min(max, 20) }, (_, i) => html`<i class="${i < n ? 'on' : ''}"></i>`)}</div>`;
const cover = (v, glyphSize, label) => html`
  <div class="glyph serif" style="color:${v.fg};font-size:${glyphSize}">${v.glyph}</div>
  ${when(label, () => html`<div class="cover-slug mono" style="color:${v.fg}">${v.slug.toUpperCase()}</div>`)}
  ${when(v.cover, () => html`<img src="${v.cover}" alt="${v.title}" loading="lazy">`)}`;
const avatar = (cls = '') => html`<span class="avatar serif ${cls}">${S.user ? [...S.user.displayName][0].toUpperCase() : ''}</span>`;
const blink = html`<span class="blink">_</span>`;

function header() {
  const home = S.route.name !== 'profile';
  return html`
<header class="hdr" data-key="hdr">
  <a class="brand" href="#/"><i class="sq"></i><span class="mono">LEO'S GAME HUB</span></a>
  <nav class="nav">
    <a class="nav-i ${home ? 'on' : ''}" href="#/">游戏库</a>
    <a class="nav-i ${home ? '' : 'on'}" href="#/me" data-act="goSaves">我的存档</a>
  </nav>
  <div class="flex1"></div>
  ${S.user
    ? html`<a class="hdr-user" href="#/me">${avatar()}<span>${S.user.displayName}</span><i class="dot ok"></i></a>`
    : html`<div class="hdr-guest"><span class="mono">游客</span><button class="btn btn-line" data-act="login">登录 / 注册</button></div>`}
</header>`;
}

function homeView() {
  const all = allGames(), list = filtered(), selG = list.find(g => g.slug === S.sel) || list[0];
  const tc = new Map(); all.forEach(g => g.tags.forEach(t => tc.set(t, (tc.get(t) || 0) + 1)));
  const chips = [['全部', all.length], ...[...tc].sort((a, b) => b[1] - a[1])];
  const p = selG && vm(selG);
  let body;
  if (S.gamesLoading && !all.length) body = html`<div class="empty mono muted">LOADING${blink}</div>`;
  else if (S.gamesErr) body = html`<div class="empty"><div class="empty-t serif">目录加载失败</div><div class="empty-s">${S.gamesErr}</div><button class="btn btn-line" data-act="retryGames">重试</button></div>`;
  else if (!all.length) body = html`<div class="empty"><div class="empty-t serif">还没有上架的作品</div><div class="empty-s">作品发布后会出现在这里。</div></div>`;
  else if (!list.length) body = html`<div class="empty"><div class="empty-t serif">没有找到匹配的作品</div><div class="empty-s">换个关键词，或清除筛选看看全部作品。</div><button class="btn btn-line" data-act="clear">清除筛选</button></div>`;
  else body = html`<div class="grid" id="grid">${list.map((g, i) => {
    const v = vm(g), on = selG && g.slug === selG.slug;
    return html`<a class="card ${on ? 'on' : ''}" href="${href({ name: 'detail', slug: g.slug })}" data-idx="${i}" data-hover-sel="${g.slug}" data-key="c-${g.slug}">
      <div class="cover" style="background:${v.bg}">${cover(v, '72px', true)}
        ${when(v.saves.length, () => html`<div class="badge mono">存档 ${v.saves.length}</div>`)}</div>
      <div class="card-meta">
        <div class="card-line mono"><span>${v.no}</span><span class="ell">${v.tagText}</span></div>
        <div class="card-title-row">${when(on, () => tri())}<div class="card-title">${v.title}</div></div>
      </div></a>`;
  })}</div>`;
  return html`
<main class="page home" data-key="home">
  <div class="home-top">
    <div class="home-intro">
      <div class="eyebrow mono">SELECT GAME — 共 ${all.length} 款作品</div>
      <h1 class="h-hero serif">选择你的下一局</h1>
      <p class="lede">Leo 独立制作的全部作品。游客可以直接开玩；登录后，进度会写进云存档，换台设备也能继续。</p>
    </div>
    <label class="search"><span class="mono">搜索</span><input id="q" data-input="q" value="${S.q}" placeholder="作品名、简介或标签" autocomplete="off">${kbd('/')}</label>
  </div>
  <div class="chips">${chips.map(([t, n]) => html`<button class="chip ${S.tag === t ? 'on' : ''}" data-act="tag" data-arg="${t}"><span>${t}</span><span class="mono chip-n">${n}</span></button>`)}</div>
  <div class="home-body">
    <div class="flex1 minw0">${body}</div>
    ${when(S.vw >= 1180 && p, () => html`
    <aside class="preview">
      <div class="cover" style="background:${p.bg}">${cover(p, '110px')}</div>
      <div class="card-line mono wide"><span>${p.no} / ${pad(all.length)}</span><span>${p.tagText}</span></div>
      <div class="preview-title serif">${p.title}</div>
      <p class="preview-desc">${p.desc}</p>
      ${when(S.user, () => html`<div class="preview-saves"><div class="muted2 fs12">我的存档</div>${meter(p.saves.length, p.maxSlots, 'bar')}<div class="mono fs12">${p.saves.length} / ${p.maxSlots}</div></div>`)}
      <div class="row gap10">
        <button class="btn btn-play big flex1" data-act="play" data-arg="${p.slug}"><span class="row gap10">${tri('dark')}开始游戏</span>${kbd('Enter', 'dark')}</button>
        <a class="btn btn-ghost big" href="${href({ name: 'detail', slug: p.slug })}">详情</a>
      </div>
    </aside>`)}
  </div>
</main>
<div class="statusbar mono" data-key="status">
  <div class="sb-i">${kbd('← ↑ ↓ →')}<span>选择</span></div>
  <div class="sb-i">${kbd('Enter')}<span>开始</span></div>
  <div class="sb-i">${kbd('/')}<span>搜索</span></div>
  <div class="flex1"></div>
  <div class="sb-i"><i class="dot ${S.user ? 'ok' : 'off'}"></i><span>${S.user ? S.user.displayName + ' · 云存档已连接' : '游客 · 云存档未启用'}</span></div>
</div>`;
}

function saveCards(d) {
  return html`<div class="save-grid">${d.saves.map(x => html`
    <div class="save-card">
      <div class="between base"><div class="mono fs16 b">${x.slot}</div><div class="mono fs12 muted2">修订 #${x.revision}</div></div>
      <div class="col gap2"><div class="fs15">${relTime(x.updatedAt)}</div><div class="mono fs12 muted">${absTime(x.updatedAt)}</div></div>
      <div class="between center save-foot"><div class="mono fs12 muted">${size(x.sizeBytes)} · 格式 v${x.schemaVersion}</div><button class="link-del" data-act="del" data-arg="${x.slug}/${x.slot}">删除</button></div>
    </div>`)}</div>`;
}

function missingView(msg) {
  return html`<main class="page detail" data-key="missing">
  <a class="back mono" href="#/"><span>← 返回游戏库</span>${kbd('Esc')}</a>
  <div class="empty">${S.gamesLoading ? html`<div class="mono muted">LOADING${blink}</div>` : html`<div class="empty-t serif">${msg}</div><div class="empty-s">这个作品可能已经下架，已有的云存档仍保留在「我的存档」里。</div><a class="btn btn-line" href="#/">去游戏库</a>`}</div>
</main>`;
}

function detailView() {
  const g = findGame(S.route.slug);
  if (!g) return missingView('没有找到这个作品');
  const d = vm(g);
  return html`
<main class="page detail" data-key="detail-${d.slug}">
  <a class="back mono" href="#/"><span>← 返回游戏库</span>${kbd('Esc')}</a>
  <section class="d-top">
    <div class="d-cover cover" style="background:${d.bg}">${cover(d, '180px')}</div>
    <div class="d-info">
      <div class="mono fs12 muted ls1">${d.no} · ${d.tagText}</div>
      <h1 class="h-detail serif">${d.title}</h1>
      <p class="d-desc">${d.desc}</p>
      <div class="row wrap gap12 mt6">
        <button class="btn btn-play huge" data-act="play" data-arg="${d.slug}">${tri('dark big')}<span>开始游戏</span>${kbd('Enter', 'dark')}</button>
        <button class="btn btn-ghost huge fs15" data-act="playFs" data-arg="${d.slug}">全屏开始</button>
      </div>
      ${when(!S.user, () => html`<div class="fs13 muted2">游客可以直接游玩，但进度不会保存。<a class="ulink" href="#" data-act="login">登录 / 注册</a></div>`)}
      <div class="facts">
        <div class="fact"><div>当前版本</div><div class="mono">${d.rel}</div></div>
        <div class="fact"><div>发布于</div><div class="mono">${d.updated}</div></div>
        <div class="fact"><div>云存档位</div><div class="mono">最多 ${d.maxSlots} 个</div></div>
        <div class="fact"><div>单个存档</div><div class="mono">最大 ${bytesLimit(d.maxBytes)}</div></div>
      </div>
    </div>
  </section>
  <section class="d-saves">
    <div class="between wrap endish gap16">
      <div class="col gap8"><div class="eyebrow mono">CLOUD SAVES</div><h2 class="h2 serif">我的存档</h2></div>
      ${when(S.user, () => html`<div class="row center gap14">${meter(d.saves.length, d.maxSlots, 'sq14')}<div class="mono fs13">${d.saves.length} / ${d.maxSlots} 存档位</div></div>`)}
    </div>
    ${S.user
      ? (d.saves.length ? saveCards(d) : html`<div class="dashed">${S.savesLoading ? html`<span class="mono">LOADING${blink}</span>` : '还没有存档。在游戏里保存一次，进度就会出现在这里。'}</div>`)
      : html`<div class="cta-box"><div class="col gap6"><div class="fs16 b">登录后，这里会列出你在本作的云存档</div><div class="fs14 muted2">每款游戏最多 ${d.maxSlots} 个存档位，换设备登录即可继续。</div></div><button class="btn btn-light" data-act="login">登录 / 注册</button></div>`}
    ${when(S.user, () => html`<div class="fs12 muted">存档由游戏内的保存操作生成，这里可以查看和删除。</div>`)}
  </section>
</main>`;
}

function playView() {
  const g = findGame(S.route.slug);
  if (!g) return missingView('没有找到这个作品');
  const d = vm(g), fs = S.fullscreen;
  return html`
<div class="play" data-key="play-${d.slug}">
  <div class="play-bar" data-key="bar">
    <button class="btn-bar" data-act="exitPlay"><span>← 退出</span>${kbd('Esc', 'sm')}</button>
    <div class="play-title"><div class="serif ell fs18">${d.title}</div><div class="mono fs11 muted nowrap">版本 ${d.rel}</div></div>
    <div class="flex1"></div>
    <button class="btn-bar ${S.drawer ? 'active' : ''}" data-act="drawer"><span>云存档</span>${when(S.user, () => html`<span class="mono fs11 okc">${d.saves.length}</span>`)}</button>
    <button class="btn-bar" data-act="fs"><span>全屏</span>${kbd('F', 'sm')}</button>
    ${S.user ? html`<div class="row center gap8 pl4">${avatar()}<div class="fs13">${S.user.displayName}</div></div>`
      : html`<button class="btn-bar accent" data-act="login">登录</button>`}
  </div>
  ${when(!S.user, () => html`<div class="strip guest" data-key="strip-guest"><i class="dot acc"></i><span>游客模式：这一局的进度不会被保存。</span><a class="ulink" href="#" data-act="login">登录后启用云存档</a></div>`)}
  ${when(S.needsReload && S.user, () => html`<div class="strip reload" data-key="strip-reload"><i class="dot ok"></i><span>已登录为 ${S.user.displayName}。游戏需要重新载入才能连接云存档。</span><button class="btn-reload" data-act="reload">重新载入游戏</button></div>`)}
  <div class="play-body" data-key="body">
    <div class="stage ${fs ? 'fs' : ''}" data-key="stage">
      <div class="screen">
        <iframe data-key="frame-${S.frameKey}" src="${g.launchUrl}" title="${d.title}" allow="fullscreen; autoplay; gamepad"></iframe>
        ${when(S.frameLoading, () => html`<div class="loading mono" data-key="loading">LOADING${blink}</div>`)}
      </div>
      ${when(fs, () => html`<button class="btn-exitfs" data-act="fs" data-key="exitfs"><span>退出全屏</span>${kbd('Esc', 'sm')}</button>`)}
    </div>
    ${when(S.drawer && !fs, () => html`
    <aside class="drawer" data-key="drawer">
      <div class="drawer-head">
        <div class="between center gap12">
          <div class="row base gap10"><div class="serif fs20">云存档</div>${when(S.user, () => html`<div class="mono fs12 muted2">${d.saves.length} / ${d.maxSlots}</div>`)}</div>
          ${when(S.user, () => html`<button class="btn-sm" data-act="refresh">${S.refreshing ? '刷新中…' : '刷新'}</button>`)}
        </div>
        ${when(S.user, () => meter(d.saves.length, d.maxSlots, 'bar'))}
      </div>
      <div class="drawer-list">
        ${S.user
          ? (d.saves.length ? d.saves.map(x => html`<div class="drawer-item">
              <div class="between base"><div class="mono fs14 b">${x.slot}</div><div class="mono fs11 muted2">修订 #${x.revision}</div></div>
              <div class="between base gap8"><div class="fs13">${relTime(x.updatedAt)}</div><div class="mono fs11 muted">${size(x.sizeBytes)}</div></div></div>`)
            : html`<div class="fs13 lh17 muted2">本作还没有云存档。在游戏里保存一次后点「刷新」。</div>`)
          : html`<div class="col gap14"><div class="fs14 lh17 body2">登录后，游戏里的每次保存都会同步到这里。</div><button class="btn btn-light h40" data-act="login">登录 / 注册</button></div>`}
      </div>
      <div class="drawer-foot">存档由游戏内的保存操作生成，删除请到个人中心。</div>
    </aside>`)}
  </div>
</div>`;
}

function profileView() {
  const u = S.user, tab = S.route.tab;
  const sorted = [...S.saves].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), order = [];
  sorted.forEach(x => { if (!order.includes(x.slug)) order.push(x.slug); });
  const groups = order.map(slug => {
    const g = findGame(slug), first = sorted.find(x => x.slug === slug);
    // 已下架作品不在目录里，但存档仍保留，照样列出供查看和删除。
    const v = g ? vm(g) : { ...vm({ slug, title: first.gameTitle, description: '', tags: [], coverUrl: null, currentReleaseId: null, updatedAt: first.updatedAt, saveCapabilities: { maxSlots: 10, maxBytes: 0 } }), no: '已下架' };
    return { v, live: !!g };
  });
  const cols = html`<div>存档位</div><div>更新时间</div><div>修订</div><div>大小</div><div></div>`;
  const s = S.set, nameDirty = s.name.trim() !== u.displayName;
  const field = (label, key, val, err, ac) => html`<label class="col gap6"><span class="fs13 muted2">${label}</span><input class="inp" type="password" data-input="${key}" value="${val}" autocomplete="${ac}">${when(err, () => html`<span class="err">${err}</span>`)}</label>`;
  return html`
<main class="page profile" data-key="profile">
  <section class="p-head">
    ${avatar('xl')}
    <div class="flex1 minw0 col gap8">
      <div class="eyebrow mono">PLAYER PROFILE</div>
      <div class="serif p-name">${u.displayName}</div>
      <div class="mono fs12 muted">@${u.username} · 加入于 ${absTime(u.createdAt, true)}</div>
    </div>
    <button class="btn btn-ghost h40 fs13" data-act="logout">退出登录</button>
  </section>
  <div class="tabs">
    <a class="tab ${tab === 'saves' ? 'on' : ''}" href="#/me">我的存档<span class="mono fs12 muted">${S.saves.length}</span></a>
    <a class="tab ${tab === 'settings' ? 'on' : ''}" href="#/me/settings">账号设置</a>
  </div>
  ${tab === 'saves' ? (groups.length ? html`<div class="col gap24">${groups.map(({ v, live }) => html`
    <section class="group" data-key="g-${v.slug}">
      <div class="group-head">
        <div class="group-cover cover" style="background:${v.bg}">${cover(v, '30px')}</div>
        <div class="group-t col gap4"><div class="fs18 b">${v.title}</div><div class="mono fs11 muted ls06">${v.no}${v.tagText ? ' · ' + v.tagText : ''}</div></div>
        <div class="row center gap10">${meter(v.saves.length, v.maxSlots, 'sq10')}<div class="mono fs12">${v.saves.length} / ${v.maxSlots}</div></div>
        ${live ? html`<button class="link-play" data-act="play" data-arg="${v.slug}">开始游戏 →</button>` : html`<div class="fs13 muted">已下架</div>`}
      </div>
      <div class="trow thead mono">${cols}</div>
      ${v.saves.map(x => html`<div class="trow">
        <div class="mono fs14 b">${x.slot}</div>
        <div class="row wrap base gap412"><span class="fs14">${relTime(x.updatedAt)}</span><span class="mono fs11 muted">${absTime(x.updatedAt)}</span></div>
        <div class="mono fs13 body2">#${x.revision}</div>
        <div class="mono fs13 body2">${size(x.sizeBytes)}</div>
        <button class="link-del right" data-act="del" data-arg="${x.slug}/${x.slot}">删除</button>
      </div>`)}
    </section>`)}</div>`
    : html`<div class="empty tall">${S.savesLoading ? html`<div class="mono muted">LOADING${blink}</div>` : html`
      <div class="empty-t serif fs30">还没有云存档</div>
      <div class="empty-s narrow">在任意一款游戏里保存一次，进度就会出现在这里。</div>
      <a class="btn btn-play h44 fs14" href="#/">去游戏库</a>`}</div>`)
  : html`<div class="col">
    <section class="set-row">
      <div class="set-l"><div class="fs16 b">昵称</div><div class="fs13 lh16 muted2">1–24 个字符，可以用中文。</div></div>
      <div class="set-r col gap8">
        <div class="row gap10"><input class="inp flex1 minw0" data-input="s.name" value="${s.name}" maxlength="24"><button class="btn h44 fs14 b ${nameDirty ? 'btn-play' : 'btn-off'}" data-act="saveName">${s.busy === 'name' ? '保存中…' : '保存'}</button></div>
        ${when(s.err.name, () => html`<div class="err">${s.err.name}</div>`)}
      </div>
    </section>
    <section class="set-row">
      <div class="set-l"><div class="fs16 b">用户名</div><div class="fs13 lh16 muted2">用于登录，注册后不可修改。</div></div>
      <div class="set-r mono fs15 h44 row center">${u.username}</div>
    </section>
    <section class="set-row">
      <div class="set-l"><div class="fs16 b">修改密码</div><div class="fs13 lh16 muted2">修改成功后，其他设备上的登录会失效。</div></div>
      <div class="set-r col gap14">
        ${field('原密码', 's.old', s.old, s.err.old, 'current-password')}
        ${field('新密码 · 8–128 个字符', 's.nw', s.nw, s.err.nw, 'new-password')}
        ${field('确认新密码', 's.nw2', s.nw2, s.err.nw2, 'new-password')}
        <button class="btn btn-light h44 fs14 self-start" data-act="changePw">${s.busy === 'pw' ? '提交中…' : '修改密码'}</button>
      </div>
    </section>
    <section class="set-row last">
      <div class="set-l"><div class="fs16 b">登录设备</div><div class="fs13 lh16 muted2">在公共电脑上登录过？可以让所有设备的登录一起失效。</div></div>
      <div class="set-r"><button class="btn btn-danger h44 fs14" data-act="logoutAll">退出所有设备</button></div>
    </section>
  </div>`}
</main>`;
}

function authView() {
  const a = S.auth, isLogin = a.mode === 'login', err = a.err;
  return html`
<div class="auth" data-key="auth" role="dialog" aria-modal="true" aria-label="${isLogin ? '登录' : '注册'}">
  ${when(S.vw >= 960, () => html`
  <div class="auth-art">
    <div class="auth-p1 mono">P1</div>
    <div class="brand rel"><i class="sq"></i><span class="mono">LEO'S GAME HUB</span></div>
    <div class="rel col gap20 mw560">
      <div class="eyebrow mono">${isLogin ? 'PLAYER LOGIN' : 'NEW PLAYER'}</div>
      <h1 class="h-auth serif">${isLogin ? '读取玩家档案' : '登记新玩家'}</h1>
      <p class="auth-lede">${isLogin ? '登录后，你在每款游戏里的进度都会保存到云端。换一台设备，从上次停下的地方继续。' : '注册后自动登录。每款游戏都有多个云存档位，只需要用户名和密码。'}</p>
    </div>
    <div class="rel mono fs11 muted ls06">游客也能直接游玩，只是进度不会保存。</div>
  </div>`)}
  <div class="auth-panel">
    <div class="row end"><button class="btn-bar dim" data-act="closeAuth"><span>以游客身份继续</span>${kbd('Esc', 'sm')}</button></div>
    <form class="auth-form" data-submit="auth" novalidate>
      <div class="auth-tabs">
        <button type="button" class="tab ${isLogin ? 'on' : ''}" data-act="authMode" data-arg="login">登录</button>
        <button type="button" class="tab ${isLogin ? '' : 'on'}" data-act="authMode" data-arg="register">注册</button>
      </div>
      <label class="col gap8">
        <div class="lbl"><span>用户名</span>${when(!isLogin, () => html`<span class="mono fs11 muted">3–20 位字母 / 数字 / 下划线</span>`)}</div>
        <input id="a-user" class="inp big mono ${err.user ? 'bad' : ''}" data-input="a.user" value="${a.user}" autocomplete="username" maxlength="20" autocapitalize="off" spellcheck="false">
        ${when(err.user, () => html`<div class="err">${err.user}</div>`)}
      </label>
      ${when(!isLogin, () => html`<label class="col gap8">
        <div class="lbl"><span>昵称（可选）</span><span class="mono fs11 muted">1–24 个字符，可用中文</span></div>
        <input class="inp big ${err.name ? 'bad' : ''}" data-input="a.name" value="${a.name}" maxlength="24">
        ${when(err.name, () => html`<div class="err">${err.name}</div>`)}
      </label>`)}
      <label class="col gap8">
        <div class="lbl"><span>密码</span>${when(!isLogin, () => html`<span class="mono fs11 muted">8–128 个字符</span>`)}</div>
        <input id="a-pw" class="inp big ${err.pw ? 'bad' : ''}" type="password" data-input="a.pw" value="${a.pw}" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
        ${when(err.pw, () => html`<div class="err">${err.pw}</div>`)}
      </label>
      ${when(err.form, () => html`<div class="form-err"><i class="dot acc"></i><span>${err.form}</span></div>`)}
      <button type="submit" class="btn btn-play submit">${a.busy ? '验证中…' : isLogin ? '登录' : '注册并登录'}</button>
      ${when(isLogin, () => html`<div class="col gap10 fs12 lh16 muted"><div>忘记密码？本站没有邮箱找回，请联系 Leo 重置。</div></div>`)}
    </form>
  </div>
</div>`;
}

function modalView() {
  const m = S.modal;
  return html`<div class="scrim" data-key="modal" data-act="mCancel">
  <div class="modal" data-act="stop" role="alertdialog" aria-modal="true">
    <div class="modal-t serif">${m.title}</div>
    <div class="modal-b">${m.body}</div>
    <div class="row end gap10 mt8">
      <button class="btn btn-ghost h42 fs14" data-act="mCancel">取消</button>
      <button class="btn h42 fs14 b ${m.danger ? 'btn-play' : 'btn-light'}" data-act="mConfirm">${m.busy ? '处理中…' : m.confirm}</button>
    </div>
  </div>
</div>`;
}

function view() {
  const r = S.route;
  return html`<div class="app">
  ${when(r.name !== 'play', header)}
  ${r.name === 'home' ? homeView() : r.name === 'detail' ? detailView() : r.name === 'play' ? playView() : r.name === 'profile' && S.user ? profileView() : ''}
  ${when(S.auth.open, authView)}
  ${when(S.modal, modalView)}
  ${when(S.toast, () => html`<div class="toast" data-key="toast" role="status"><i class="dot acc"></i><span>${S.toast}</span></div>`)}
</div>`;
}

function titleFor() {
  const r = S.route, g = r.slug && findGame(r.slug);
  if (r.name === 'detail' && g) return g.title + " · Leo's Game Hub";
  if (r.name === 'play' && g) return '▶ ' + g.title + " · Leo's Game Hub";
  if (r.name === 'profile') return (r.tab === 'settings' ? '账号设置' : '我的存档') + " · Leo's Game Hub";
  return "Leo's Game Hub";
}

// ── 渲染：模板字符串 + 带 key 的 DOM 协调（保留焦点，iframe 不重载）──────────
const keyOf = n => (n.nodeType === 1 ? n.getAttribute('data-key') : null);
const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);
function morph(from, to) {
  if (from.nodeType !== 1) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) {
    if (name === 'class' && from.tagName === 'IMG' && from.classList.contains('broken') && from.getAttribute('src') === to.getAttribute('src')) continue;
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  if (from.tagName === 'INPUT') { const v = to.getAttribute('value') ?? ''; if (from.value !== v) from.value = v; return; }
  if (from.tagName === 'IFRAME') return;
  morphChildren(from, to);
}
function morphChildren(parent, next) {
  const olds = [...parent.childNodes], news = [...next.childNodes], keyed = new Map(), used = new Set(), pairs = [];
  olds.forEach(n => { const k = keyOf(n); if (k) keyed.set(k, n); });
  let u = 0;
  for (const nk of news) {
    const k = keyOf(nk); let match = null;
    if (k) { const c = keyed.get(k); if (c && same(c, nk)) match = c; }
    else {
      for (let i = u; i < olds.length; i++) {
        const o = olds[i];
        if (!keyOf(o) && !used.has(o) && same(o, nk)) { match = o; u = i + 1; break; }
      }
    }
    if (match) used.add(match);
    pairs.push([nk, match]);
  }
  olds.forEach(o => { if (!used.has(o)) o.remove(); });
  let cursor = parent.firstChild;
  for (const [nk, match] of pairs) {
    if (match) {
      if (match !== cursor) parent.insertBefore(match, cursor); else cursor = cursor.nextSibling;
      morph(match, nk);
    } else parent.insertBefore(nk, cursor);
  }
}
let queued = false;
function render() {
  if (!S.booted || queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const t = document.createElement('template');
    t.innerHTML = view().s;
    morphChildren(root, t.content);
    document.title = titleFor();
    document.body.classList.toggle('lock', S.auth.open || !!S.modal || S.route.name === 'play');
  });
}

// ── 启动 ────────────────────────────────────────────────────────────────
(async () => {
  try { S.user = await client.auth.me(); } catch { S.user = null; }
  S.booted = true;
  onRoute();
  await Promise.all([loadGames(), loadSaves()]);
})();
