const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'campus-forum-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const BOARDS = {
  general: '综合', course: '课程评价', treehole: '树洞', qa: '问答',
  team: '组队搭子', market: '二手', lost: '失物招领', club: '社团活动'
};

const POST_TYPES = {
  normal: '普通帖', course: '课程评价', question: '问答', team: '组队搭子'
};

const SENSITIVE_SEED = [
  '傻逼杯子','法人','烧杯','doi','茶','品茶','做头发','92/95/98','419','加V私聊',
  '懂的来','懂的都懂','可约','上门服务','同城服务','二手空调','捷安特','可骑','yhsq',
  '傻逼','煞笔','sb','脑残','智障','弱智','废物','垃圾','去死','死全家','贱人','婊子',
  '骚货','母狗','舔狗','龟男','普信男','娘炮','死基佬','死肥猪','丑逼','穷鬼','乡巴佬',
  '土狗','狗东西','畜生','杂种','野种','滚出学校','开盒你','人肉你','网暴你','nmsl','cnm',
  '你妈死了','tmd','卧槽他妈的','操你妈','草泥马','狗娘养的','王八蛋','混蛋','滚蛋','废柴',
  'loser','屌丝','人渣','败类','不要脸','变态','死变态','神经病','精神病','孤儿','没妈','杂碎'
];

if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
  db.prepare("INSERT INTO users (username, nickname, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run('admin', '管理员', bcrypt.hashSync('admin123', 10));
}

if (db.prepare('SELECT COUNT(*) AS n FROM sensitive_words').get().n === 0) {
  const stmt = db.prepare('INSERT OR IGNORE INTO sensitive_words (word) VALUES (?)');
  for (const w of SENSITIVE_SEED) stmt.run(w);
}

let wordCache = null;
function sensitiveWords() {
  if (!wordCache) {
    wordCache = db.prepare('SELECT word FROM sensitive_words ORDER BY length(word) DESC')
      .all().map(r => r.word);
  }
  return wordCache;
}

function checkSensitive(text) {
  const low = String(text || '').toLowerCase();
  for (const w of sensitiveWords()) {
    if (low.includes(String(w).toLowerCase())) return w;
  }
  return null;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderContent(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s.replace(/\n/g, '<br>');
}

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
}

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (u.role !== 'admin') return res.status(403).send('无权限');
  next();
}

function isFuture(t) {
  return t && new Date(t).getTime() > Date.now();
}

function requireNotBanned(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (isFuture(u.banned_until)) {
    return res.status(403).send(layout('账号被封禁', u,
      `<div class="card">你的账号已被封禁至 ${escapeHtml(u.banned_until)}，<a href="/appeal">点此申诉</a></div>`));
  }
  next();
}

function requireNotMuted(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (isFuture(u.muted_until)) {
    return res.status(403).send(layout('账号被禁言', u,
      `<div class="card">你已被禁言至 ${escapeHtml(u.muted_until)}</div>`));
  }
  next();
}

function createNotification(userId, type, content, link = '') {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (user_id, type, content, link) VALUES (?, ?, ?, ?)')
    .run(userId, type, content, link);
}

function notifyAdmins(type, content, link = '') {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  for (const a of admins) createNotification(a.id, type, content, link);
}

function awardBadge(userId, code, name) {
  db.prepare('INSERT OR IGNORE INTO badges (user_id, code, name) VALUES (?, ?, ?)')
    .run(userId, code, name);
}

function getBlockedIds(userId) {
  if (!userId) return [];
  return db.prepare('SELECT blocked_id FROM blocks WHERE blocker_id = ?')
    .all(userId).map(r => r.blocked_id);
}

function isBlockedBetween(a, b) {
  if (!a || !b) return false;
  return !!db.prepare(`
    SELECT 1 FROM blocks
    WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
    LIMIT 1
  `).get(a, b, b, a);
}

function friendStatus(me, other) {
  if (!me || !other || me === other) return 'none';
  const row = db.prepare(`
    SELECT * FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?)
       OR (requester_id = ? AND addressee_id = ?)
    LIMIT 1
  `).get(me, other, other, me);
  if (!row) return 'none';
  if (row.status === 'accepted') return 'accepted';
  if (row.status === 'pending' && row.requester_id === me) return 'pending_out';
  if (row.status === 'pending' && row.addressee_id === me) return 'pending_in';
  return 'none';
}

function areFriends(a, b) {
  if (!a || !b || a === b) return false;
  return !!db.prepare(`
    SELECT 1 FROM friendships
    WHERE status = 'accepted'
      AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))
    LIMIT 1
  `).get(a, b, b, a);
}

function parseMentions(text) {
  const set = new Set();
  const re = /@([A-Za-z0-9_\u4e00-\u9fa5]+)/g;
  let m;
  while ((m = re.exec(text || ''))) set.add(m[1]);
  return [...set];
}

function notifyMentions(text, actorId, postId) {
  for (const username of parseMentions(text)) {
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (u && u.id !== actorId) {
      createNotification(u.id, 'mention', `有人在帖子中 @ 了你`, `/post/${postId}`);
    }
  }
}

function layout(title, user, content) {
  let unread = 0;
  let msgUnread = 0;
  if (user) {
    unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(user.id).n;
    msgUnread = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE receiver_id = ? AND is_read = 0')
      .get(user.id).n;
  }
  const nav = user
    ? `<a href="/">首页</a>
       <a href="/?board=course">课程</a>
       <a href="/?board=treehole">树洞</a>
       <a href="/?board=qa">问答</a>
       <a href="/?board=team">组队</a>
       <a href="/notifications">通知(${unread})</a>
       <a href="/friends">好友</a>
       <a href="/messages">私信(${msgUnread})</a>
       <a href="/drafts">草稿</a>
       <a href="/me">${escapeHtml(user.nickname)}</a>
       ${user.role === 'admin' ? '<a href="/admin">管理后台</a>' : ''}
       <a href="/logout">退出</a>`
    : `<a href="/">首页</a><a href="/login">登录</a><a href="/register">注册</a>`;

  let warning = '';
  if (user && isFuture(user.banned_until)) {
    warning = `<div class="card error">账号封禁至 ${escapeHtml(user.banned_until)}，<a href="/appeal">申诉</a></div>`;
  } else if (user && isFuture(user.muted_until)) {
    warning = `<div class="card error">账号禁言至 ${escapeHtml(user.muted_until)}</div>`;
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - 校园论坛</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:920px;margin:0 auto;padding:16px;background:#f6f7fb;color:#222}
nav{display:flex;gap:12px;flex-wrap:wrap;padding:10px 0;border-bottom:1px solid #e3e5ee;margin-bottom:16px}
nav a{color:#3457d5;text-decoration:none}
.card{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.meta,.muted{color:#888;font-size:13px}
.tag{display:inline-block;background:#eef1ff;color:#3457d5;border-radius:6px;padding:1px 8px;font-size:12px;margin-right:6px}
.tag.hot{background:#fff1e6;color:#d46b08}
.tag.ok{background:#e8f7ee;color:#1a7f37}
input,textarea,select,button{font:inherit}
input[type=text],input[type=password],input[type=number],textarea,select{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d8dbe8;border-radius:8px;margin:6px 0 12px}
button,.btn{background:#3457d5;color:#fff;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;text-decoration:none;display:inline-block}
.btn.secondary{background:#eef1ff;color:#3457d5}
.btn.danger{background:#e5484d}
.btn.small{padding:4px 9px;font-size:13px}
.row{display:flex;gap:12px;flex-wrap:wrap}
.row>*{flex:1;min-width:160px}
.error{color:#e5484d}
.stars{color:#f5a623}
blockquote{border-left:3px solid #d8dbe8;margin:6px 0;padding-left:10px;color:#555}
h1,h2,h3{margin:0 0 12px}
.badge{display:inline-block;background:#fff7e6;color:#ad6800;border:1px solid #ffe7ba;border-radius:20px;padding:2px 10px;font-size:12px;margin:2px 4px 2px 0}
.msg{max-width:75%;padding:8px 12px;border-radius:10px;margin:6px 0;background:#fff}
.msg.me{margin-left:auto;background:#eef1ff}
</style>
</head>
<body>
<div style="text-align:center; padding:10px; background:#e8f7ee; color:#1a7f37; font-weight:bold; border-bottom:1px solid #b7ebc6; font-size:15px; margin-bottom: 10px;">
  该论坛由25届16班韩镕泽开发
</div>
<nav>${nav}</nav>
${warning}
${content}
</body>
</html>`;
}

function sendPage(req, res, title, content, status = 200) {
  res.status(status).send(layout(title, currentUser(req), content));
}

function boardName(b) { return BOARDS[b] || b; }
function typeName(t) { return POST_TYPES[t] || t; }

function fetchPosts({ board = '', q = '', sort = 'latest', type = '', user = null }) {
  let sql = `
    SELECT p.*, u.nickname, u.username,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS like_count,
      (SELECT COUNT(*) FROM favorites WHERE post_id = p.id) AS fav_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id AND status = 'approved') AS comment_count
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.status = 'approved'
  `;
  const args = [];
  if (board) { sql += ' AND p.board = ?'; args.push(board); }
  if (type) { sql += ' AND p.post_type = ?'; args.push(type); }
  if (q) {
    sql += ` AND (p.title LIKE ? OR p.content LIKE ? OR p.tags LIKE ?
              OR p.course_name LIKE ? OR p.teacher_name LIKE ?)`;
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  if (sort === 'essence') sql += ' AND p.is_essence = 1';
  sql += ' ORDER BY p.id DESC LIMIT 200';

  let posts = db.prepare(sql).all(...args);
  const blocked = new Set(getBlockedIds(user && user.id));
  posts = posts.filter(p => !blocked.has(p.user_id));

  if (sort === 'hot') {
    posts.sort((a, b) => {
      const score = x => x.like_count * 2 + x.comment_count * 3 + x.view_count;
      return score(b) - score(a) || b.id - a.id;
    });
  } else if (sort === 'essence') {
    posts.sort((a, b) => b.id - a.id);
  } else {
    posts.sort((a, b) => b.id - a.id);
  }
  return posts;
}

function postCard(p) {
  return `<div class="card">
    <div>
      <span class="tag">${escapeHtml(boardName(p.board))}</span>
      <span class="tag">${escapeHtml(typeName(p.post_type))}</span>
      ${p.is_essence ? '<span class="tag hot">精华</span>' : ''}
      ${p.tags ? p.tags.split(',').filter(Boolean).map(t => `<span class="tag">${escapeHtml(t.trim())}</span>`).join('') : ''}
    </div>
    <div style="margin:6px 0"><a href="/post/${p.id}"><b>${escapeHtml(p.title)}</b></a></div>
    <div class="muted">${p.is_anonymous ? '匿名同学' : escapeHtml(p.nickname)} · ${p.created_at} · 浏览 ${p.view_count}</div>
    <div class="muted">👍 ${p.like_count} · 💬 ${p.comment_count} · ⭐ ${p.fav_count}</div>
    <div style="margin-top:6px">${renderContent(p.content).slice(0, 180)}${p.content.length > 180 ? '...' : ''}</div>
  </div>`;
}

app.get('/', (req, res) => {
  const user = currentUser(req);
  const { board = '', q = '', sort = 'latest', type = '' } = req.query;
  const posts = fetchPosts({ board, q, sort, type, user });
  const boardTabs = Object.entries(BOARDS).map(([k, v]) =>
    `<a class="btn ${board === k ? '' : 'secondary'} small" href="/?board=${k}&sort=${sort}">${v}</a>`
  ).join(' ');
  sendPage(req, res, '首页', `
    <h1>校园论坛</h1>
    <div class="card">
      <form method="get" action="/">
        <div class="row">
          <input type="text" name="q" value="${escapeHtml(q)}" placeholder="搜索标题、内容、课程、老师、标签">
          <select name="board">
            <option value="">全部板块</option>
            ${Object.entries(BOARDS).map(([k, v]) => `<option value="${k}" ${board === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          <select name="sort">
            <option value="latest" ${sort === 'latest' ? 'selected' : ''}>最新</option>
            <option value="hot" ${sort === 'hot' ? 'selected' : ''}>热榜</option>
            <option value="essence" ${sort === 'essence' ? 'selected' : ''}>精华</option>
          </select>
          <button type="submit">搜索</button>
        </div>
      </form>
      <div style="margin-top:8px">${boardTabs}</div>
      <div style="margin-top:8px">
        <a class="btn" href="/post/new">发帖</a>
        <a class="btn secondary" href="/post/new?type=question">提问</a>
        <a class="btn secondary" href="/post/new?type=team">组队</a>
        <a class="btn secondary" href="/post/new?type=course">课程评价</a>
      </div>
    </div>
    ${posts.length ? posts.map(postCard).join('') : '<p class="muted">没有帖子。</p>'}
  `);
});

app.get('/register', (req, res) => {
  sendPage(req, res, '注册', `
    <h1>注册</h1>
    <form method="post" action="/register">
      <label>账号（唯一，可用学号或自定义）</label>
      <input type="text" name="username" required>
      <label>昵称</label>
      <input type="text" name="nickname" required>
      <label>密码（至少6位）</label>
      <input type="password" name="password" required minlength="6">
      <button type="submit">注册并登录</button>
    </form>
  `);
});

app.post('/register', (req, res) => {
  const { username, nickname, password } = req.body;
  if (!username || !nickname || !password) return res.status(400).send('参数不完整');
  if (password.length < 6) return res.status(400).send('密码至少6位');
  try {
    const info = db.prepare('INSERT INTO users (username, nickname, password_hash) VALUES (?, ?, ?)')
      .run(username.trim(), nickname.trim(), bcrypt.hashSync(password, 10));
    req.session.userId = info.lastInsertRowid;
    res.redirect('/');
  } catch (e) {
    if (String(e.code).includes('SQLITE_CONSTRAINT')) {
      return res.status(400).send('该账号已注册，请换一个或直接登录');
    }
    throw e;
  }
});

app.get('/login', (req, res) => {
  sendPage(req, res, '登录', `
    <h1>登录</h1>
    <form method="post" action="/login">
      <label>账号</label><input type="text" name="username" required>
      <label>密码</label><input type="password" name="password" required>
      <button type="submit">登录</button>
    </form>
  `);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(400).send('账号或密码错误');
  }
  req.session.userId = user.id;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(PORT, () => {
  console.log(`校园论坛运行在 http://localhost:${PORT}`);
  console.log('默认管理员：admin / admin123');
});