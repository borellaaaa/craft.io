/**
 * CRAFT.IO — Backend Server
 * Node.js + WebSocket + SQLite
 * Gerencia: jogadores, inventário (64 stack), classes/níveis, mundo, chat
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ══════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'game.db');
const TICK_RATE = 20; // 20 ticks/s
const MAX_STACK = 64;
const WORLD_SEED = 42;

// ══════════════════════════════════════════
// CLASSES DE PERSONAGEM
// kills necessários para subir de nível
// ══════════════════════════════════════════
const CLASSES = [
  { id: 0, name: 'Aldeão',     icon: '🧑', kills: 0,   maxHp: 80,  damage: 3,  speed: 2.8, defense: 0,  color: '#a0a0a0', desc: 'O início da jornada' },
  { id: 1, name: 'Escudeiro',  icon: '🛡', kills: 5,   maxHp: 100, damage: 5,  speed: 3.0, defense: 3,  color: '#6a9aff', desc: 'Aprendiz de guerreiro' },
  { id: 2, name: 'Arqueiro',   icon: '🏹', kills: 15,  maxHp: 110, damage: 8,  speed: 3.5, defense: 2,  color: '#6aff6a', desc: 'Mestre das flechas' },
  { id: 3, name: 'Guerreiro',  icon: '⚔', kills: 30,  maxHp: 140, damage: 13, speed: 3.2, defense: 7,  color: '#ffaa00', desc: 'Lutador experiente' },
  { id: 4, name: 'Cavaleiro',  icon: '🗡', kills: 55,  maxHp: 170, damage: 17, speed: 2.9, defense: 12, color: '#ff6a00', desc: 'Protetor das terras' },
  { id: 5, name: 'Paladino',   icon: '✨', kills: 90,  maxHp: 200, damage: 22, speed: 3.0, defense: 18, color: '#ffff00', desc: 'Luz nas trevas' },
  { id: 6, name: 'Assassino',  icon: '🗡', kills: 140, maxHp: 160, damage: 30, speed: 4.5, defense: 10, color: '#aa00ff', desc: 'Sombra veloz e letal' },
  { id: 7, name: 'Mago',       icon: '🔮', kills: 200, maxHp: 180, damage: 35, speed: 3.3, defense: 8,  color: '#00e5ff', desc: 'Domina as arcanas' },
  { id: 8, name: 'Arquimago',  icon: '⚡', kills: 280, maxHp: 220, damage: 45, speed: 3.5, defense: 15, color: '#ff00ff', desc: 'Poder quase divino' },
  { id: 9, name: 'Lendário',   icon: '👑', kills: 400, maxHp: 300, damage: 60, speed: 4.0, defense: 25, color: '#f0c040', desc: 'O MÁXIMO poder!' },
];

function getClassForKills(kills) {
  let cls = CLASSES[0];
  for (const c of CLASSES) {
    if (kills >= c.kills) cls = c;
    else break;
  }
  return cls;
}

// ══════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    x REAL DEFAULT 0,
    y REAL DEFAULT 0,
    hp REAL DEFAULT 80,
    hunger REAL DEFAULT 100,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    kills INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    class_id INTEGER DEFAULT 0,
    last_seen INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS inventory (
    player_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (player_id, slot),
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS hotbar (
    player_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    item_id TEXT,
    PRIMARY KEY (player_id, slot),
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS buildings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    wx INTEGER NOT NULL,
    wy INTEGER NOT NULL,
    placed_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inv_player ON inventory(player_id);
  CREATE INDEX IF NOT EXISTS idx_build_pos ON buildings(wx, wy);
`);

// Prepared statements
const stmts = {
  getPlayer:     db.prepare('SELECT * FROM players WHERE id = ?'),
  upsertPlayer:  db.prepare(`INSERT INTO players (id,name,x,y,hp,hunger,xp,level,kills,deaths,class_id,last_seen)
                              VALUES (@id,@name,@x,@y,@hp,@hunger,@xp,@level,@kills,@deaths,@class_id,@last_seen)
                              ON CONFLICT(id) DO UPDATE SET name=excluded.name,x=excluded.x,y=excluded.y,
                              hp=excluded.hp,hunger=excluded.hunger,xp=excluded.xp,level=excluded.level,
                              kills=excluded.kills,deaths=excluded.deaths,class_id=excluded.class_id,last_seen=excluded.last_seen`),
  getInventory:  db.prepare('SELECT slot, item_id, count FROM inventory WHERE player_id = ? ORDER BY slot'),
  setSlot:       db.prepare('INSERT OR REPLACE INTO inventory (player_id,slot,item_id,count) VALUES (?,?,?,?)'),
  clearSlot:     db.prepare('DELETE FROM inventory WHERE player_id = ? AND slot = ?'),
  clearInv:      db.prepare('DELETE FROM inventory WHERE player_id = ?'),
  getHotbar:     db.prepare('SELECT slot, item_id FROM hotbar WHERE player_id = ? ORDER BY slot'),
  setHotbarSlot: db.prepare('INSERT OR REPLACE INTO hotbar (player_id,slot,item_id) VALUES (?,?,?)'),
  getBuildings:  db.prepare('SELECT * FROM buildings WHERE wx BETWEEN ? AND ? AND wy BETWEEN ? AND ?'),
  addBuilding:   db.prepare('INSERT INTO buildings (player_id,item_id,wx,wy) VALUES (?,?,?,?)'),
  delBuilding:   db.prepare('DELETE FROM buildings WHERE wx = ? AND wy = ?'),
  listPlayers:   db.prepare('SELECT id,name,kills,level,class_id FROM players WHERE last_seen > ? ORDER BY kills DESC LIMIT 20'),
};

// ══════════════════════════════════════════
// INVENTORY LOGIC (server side)
// ══════════════════════════════════════════
const INV_SIZE = 36;

function loadInventory(playerId) {
  const rows = stmts.getInventory.all(playerId);
  const inv = {}; // slot -> {item_id, count}
  for (const r of rows) inv[r.slot] = { item_id: r.item_id, count: r.count };
  return inv;
}

function saveInventory(playerId, inv) {
  const delAll = db.prepare('DELETE FROM inventory WHERE player_id = ?');
  const ins    = db.prepare('INSERT INTO inventory (player_id,slot,item_id,count) VALUES (?,?,?,?)');
  const tx = db.transaction(() => {
    delAll.run(playerId);
    for (const [slot, data] of Object.entries(inv)) {
      if (data && data.count > 0) ins.run(playerId, parseInt(slot), data.item_id, data.count);
    }
  });
  tx();
}

/**
 * Adiciona items ao inventário respeitando stack de 64.
 * Retorna {success, remaining}
 */
function inventoryAdd(inv, itemId, count) {
  let remaining = count;
  // 1) Tenta empilhar em slots existentes com mesmo item
  for (let s = 0; s < INV_SIZE && remaining > 0; s++) {
    if (inv[s] && inv[s].item_id === itemId && inv[s].count < MAX_STACK) {
      const space = MAX_STACK - inv[s].count;
      const add = Math.min(space, remaining);
      inv[s].count += add;
      remaining -= add;
    }
  }
  // 2) Abre novos slots
  for (let s = 0; s < INV_SIZE && remaining > 0; s++) {
    if (!inv[s]) {
      const add = Math.min(MAX_STACK, remaining);
      inv[s] = { item_id: itemId, count: add };
      remaining -= add;
    }
  }
  return { success: remaining === 0, remaining };
}

/**
 * Remove items do inventário. Retorna quantidade realmente removida.
 */
function inventoryRemove(inv, itemId, count) {
  let toRemove = count;
  for (let s = 0; s < INV_SIZE && toRemove > 0; s++) {
    if (inv[s] && inv[s].item_id === itemId) {
      const remove = Math.min(inv[s].count, toRemove);
      inv[s].count -= remove;
      toRemove -= remove;
      if (inv[s].count === 0) delete inv[s];
    }
  }
  return count - toRemove;
}

function inventoryCount(inv, itemId) {
  let total = 0;
  for (const s of Object.values(inv)) {
    if (s && s.item_id === itemId) total += s.count;
  }
  return total;
}

// ══════════════════════════════════════════
// SERVER HTTP (serve o frontend)
// ══════════════════════════════════════════

// Procura o index.html em vários locais possíveis
function findClientDir() {
  const candidates = [
    path.join(__dirname, '..', 'client'),   // estrutura server/ + client/
    path.join(__dirname, 'client'),          // tudo na mesma pasta
    path.join(__dirname, '..'),              // index.html na raiz
    __dirname,                               // index.html junto com server.js
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      console.log(`[HTTP] Servindo frontend de: ${dir}`);
      return dir;
    }
  }
  console.warn('[HTTP] AVISO: index.html não encontrado! Coloque-o na pasta client/');
  return path.join(__dirname, '..', 'client');
}

const CLIENT_DIR = findClientDir();

const server = http.createServer((req, res) => {
  // Remove query string e normaliza
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // Segurança: impede path traversal (ex: ../../etc/passwd)
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(CLIENT_DIR, safePath);

  // Garante que está dentro do CLIENT_DIR
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
    '.json': 'application/json',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Qualquer rota não encontrada → serve o index.html (SPA fallback)
      fs.readFile(path.join(CLIENT_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('index.html não encontrado. Verifique a estrutura de pastas.'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ══════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════
const wss = new WebSocket.Server({ server });

// Mapa de sockets: id -> { ws, player, inv, hotbar, lastPos }
const clients = new Map();

function broadcast(data, exceptId = null) {
  const msg = JSON.stringify(data);
  for (const [id, cl] of clients) {
    if (id !== exceptId && cl.ws.readyState === WebSocket.OPEN) {
      cl.ws.send(msg);
    }
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ─── Gera ID único ───
let idCounter = Date.now();
function genId() { return 'p' + (idCounter++).toString(36); }

// ══════════════════════════════════════════
// HANDLERS DE MENSAGEM
// ══════════════════════════════════════════
function handleJoin(ws, { name }) {
  const id = genId();
  const existing = null; // poderia buscar por nome se quiser persistência de conta

  const classData = CLASSES[0];
  const player = {
    id, name: name.substring(0, 18).trim() || 'Guerreiro',
    x: (Math.random() - 0.5) * 2000,
    y: (Math.random() - 0.5) * 2000,
    hp: classData.maxHp, maxHp: classData.maxHp,
    hunger: 100, xp: 0, level: 1,
    kills: 0, deaths: 0,
    class_id: 0,
    last_seen: Math.floor(Date.now() / 1000),
  };

  // Salva no DB
  stmts.upsertPlayer.run(player);

  // Inventário inicial
  const inv = {};
  inventoryAdd(inv, 'oak_log', 5);
  inventoryAdd(inv, 'stone', 3);
  inventoryAdd(inv, 'coal_ore', 2);
  inventoryAdd(inv, 'apple', 3);
  saveInventory(id, inv);

  // Hotbar inicial
  const hotbar = Array(10).fill(null);
  hotbar[1] = 'oak_log';
  hotbar[2] = 'stone';

  clients.set(id, { ws, player, inv, hotbar, lastSave: Date.now() });

  // Envia state inicial
  send(ws, {
    type: 'init',
    id,
    player,
    inv: invToArray(inv),
    hotbar,
    classes: CLASSES,
    onlineCount: clients.size,
  });

  // Envia lista de outros jogadores online
  const others = [];
  for (const [oid, cl] of clients) {
    if (oid !== id) others.push(publicPlayer(cl.player));
  }
  send(ws, { type: 'players_init', players: others });

  // Anuncia entrada
  broadcast({ type: 'player_join', player: publicPlayer(player) }, id);
  broadcast({ type: 'chat', name: 'SISTEMA', msg: `⚔ ${player.name} entrou no servidor!`, sys: true });

  console.log(`[JOIN] ${player.name} (${id}) | Online: ${clients.size}`);
  return id;
}

function handleMove(clientData, { x, y }) {
  const p = clientData.player;
  // Valida movimento (anti-cheat básico: max distância por tick)
  const dx = x - p.x, dy = y - p.y;
  const maxDist = 12;
  if (Math.hypot(dx, dy) > maxDist) {
    // Teleporte suspeito — ignora
    return;
  }
  p.x = x; p.y = y;
  // Broadcast posição (comprimido — só manda para quem estiver próximo futuramente)
  broadcast({ type: 'player_move', id: clientData.player.id, x, y });
}

function handleHarvest(clientData, { objKey, loot, lootCount }) {
  const { player, inv } = clientData;
  // Valida loot (server define a lógica real — aqui confiamos no cliente com validação mínima)
  // Em produção full, o servidor calcularia o objeto pelo chunk seed
  const count = Math.min(Math.max(1, parseInt(lootCount) || 1), 12);
  const itemId = String(loot).replace(/[^a-z_]/g, '');
  if (!itemId) return;

  const result = inventoryAdd(inv, itemId, count);
  clientData.inv = inv;

  send(clientData.ws, {
    type: 'inv_update',
    inv: invToArray(inv),
    notification: `+${count} ${itemId}`,
  });
}

function handleCraft(clientData, { recipeId }) {
  const { player, inv } = clientData;
  const rec = RECIPES[recipeId];
  if (!rec) return send(clientData.ws, { type: 'error', msg: 'Receita inválida' });

  // Checa ingredientes
  for (const [iid, n] of Object.entries(rec.req)) {
    if (inventoryCount(inv, iid) < n) {
      return send(clientData.ws, { type: 'error', msg: `Sem ${iid}` });
    }
  }
  // Remove ingredientes
  for (const [iid, n] of Object.entries(rec.req)) inventoryRemove(inv, iid, n);
  // Adiciona resultado
  for (const [iid, n] of Object.entries(rec.gives)) inventoryAdd(inv, iid, n);

  player.xp += 10;
  clientData.inv = inv;
  send(clientData.ws, {
    type: 'craft_ok',
    recipeId,
    inv: invToArray(inv),
    xp: player.xp,
    notification: `⚒ Craftou: ${rec.name}`,
  });
}

function handleAttack(attackerData, { targetId }) {
  const attacker = attackerData.player;
  const target = clients.get(targetId);
  if (!target) return;

  const atkClass = CLASSES[attacker.class_id] || CLASSES[0];
  const defClass = CLASSES[target.player.class_id] || CLASSES[0];
  const rawDmg = atkClass.damage;
  const def = defClass.defense;
  const dmg = Math.max(1, rawDmg - def);

  target.player.hp -= dmg;

  // Notifica ambos
  send(attackerData.ws, { type: 'attack_ok', targetId, dmg });
  send(target.ws, { type: 'take_damage', from: attacker.id, fromName: attacker.name, dmg });

  // Morte
  if (target.player.hp <= 0) {
    handleKill(attackerData, target);
  }
}

function handleKill(killerData, victimData) {
  const killer = killerData.player;
  const victim = victimData.player;

  victim.hp = 0;
  victim.deaths++;
  killer.kills++;
  killer.xp += 50;

  // ── SISTEMA DE CLASSE POR KILLS ──
  const prevKillerClass = killer.class_id;
  const newKillerClass = getClassForKills(killer.kills);

  // Se a vítima era de nível maior → killer sobe para a classe da vítima
  if (victim.class_id > killer.class_id) {
    killer.class_id = victim.class_id;
  } else {
    killer.class_id = newKillerClass.id;
  }

  // Atualiza stats se mudou de classe
  if (killer.class_id !== prevKillerClass) {
    const nc = CLASSES[killer.class_id];
    killer.maxHp = nc.maxHp;
    killer.hp = Math.min(killer.hp + 40, nc.maxHp); // recupera HP ao subir
    broadcast({
      type: 'chat',
      name: 'SISTEMA',
      msg: `🌟 ${killer.name} evoluiu para ${nc.icon} ${nc.name}!`,
      sys: true,
    });
  }

  // Vítima reseta para spawn (mas mantém kills e classe)
  victim.x = (Math.random() - 0.5) * 2000;
  victim.y = (Math.random() - 0.5) * 2000;
  victim.hp = (CLASSES[victim.class_id] || CLASSES[0]).maxHp;
  victim.hunger = 100;

  // Salva ambos
  stmts.upsertPlayer.run({ ...killer, last_seen: Math.floor(Date.now() / 1000) });
  stmts.upsertPlayer.run({ ...victim, last_seen: Math.floor(Date.now() / 1000) });

  // Notificações
  send(killerData.ws, {
    type: 'kill_confirm',
    victimName: victim.name,
    kills: killer.kills,
    xp: killer.xp,
    class_id: killer.class_id,
    maxHp: killer.maxHp,
    hp: killer.hp,
    notification: `⚔ Eliminou ${victim.name}! Kills: ${killer.kills}`,
  });

  send(victimData.ws, {
    type: 'you_died',
    killerName: killer.name,
    x: victim.x,
    y: victim.y,
    hp: victim.hp,
  });

  broadcast({
    type: 'chat',
    name: 'SISTEMA',
    msg: `💀 ${killer.name} eliminou ${victim.name}!`,
    pvp: true,
  });

  broadcast({ type: 'player_update', player: publicPlayer(killer) });
  broadcast({ type: 'player_update', player: publicPlayer(victim) });
}

function handleChat(clientData, { msg }) {
  const clean = String(msg).substring(0, 100).trim();
  if (!clean) return;
  broadcast({
    type: 'chat',
    name: clientData.player.name,
    id: clientData.player.id,
    msg: clean,
  });
}

function handleHotbar(clientData, { hotbar }) {
  if (!Array.isArray(hotbar) || hotbar.length !== 10) return;
  clientData.hotbar = hotbar.map(x => (typeof x === 'string' ? x.substring(0, 40) : null));
}

function handleBuild(clientData, { itemId, wx, wy }) {
  const { player, inv } = clientData;
  if (inventoryCount(inv, itemId) < 1) return send(clientData.ws, { type: 'error', msg: 'Sem item' });
  inventoryRemove(inv, itemId, 1);
  stmts.addBuilding.run(player.id, itemId, wx, wy);
  send(clientData.ws, { type: 'inv_update', inv: invToArray(inv) });
  broadcast({ type: 'building_placed', itemId, wx, wy, playerId: player.id });
}

function handleEat(clientData, { itemId, hunger, hpGain }) {
  const { player, inv } = clientData;
  if (inventoryCount(inv, itemId) < 1) return;
  inventoryRemove(inv, itemId, 1);
  player.hunger = Math.min(100, player.hunger + (parseInt(hunger) || 0));
  if (hpGain) player.hp = Math.min(player.maxHp, player.hp + parseInt(hpGain));
  send(clientData.ws, {
    type: 'stats_update',
    hp: player.hp,
    hunger: player.hunger,
    inv: invToArray(inv),
  });
}

function handleDisconnect(id) {
  const cl = clients.get(id);
  if (!cl) return;
  // Salva tudo
  stmts.upsertPlayer.run({ ...cl.player, last_seen: Math.floor(Date.now() / 1000) });
  saveInventory(id, cl.inv);
  clients.delete(id);
  broadcast({ type: 'player_leave', id });
  broadcast({ type: 'chat', name: 'SISTEMA', msg: `${cl.player.name} saiu do servidor`, sys: true });
  console.log(`[LEAVE] ${cl.player.name} | Online: ${clients.size}`);
}

// ══════════════════════════════════════════
// WEBSOCKET CONNECTION
// ══════════════════════════════════════════
wss.on('connection', (ws, req) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // Antes de estar logado, só aceita JOIN
    if (!playerId) {
      if (data.type === 'join') {
        playerId = handleJoin(ws, data);
      }
      return;
    }

    const cl = clients.get(playerId);
    if (!cl) return;

    switch (data.type) {
      case 'move':    handleMove(cl, data); break;
      case 'harvest': handleHarvest(cl, data); break;
      case 'craft':   handleCraft(cl, data); break;
      case 'attack':  handleAttack(cl, data); break;
      case 'chat':    handleChat(cl, data); break;
      case 'hotbar':  handleHotbar(cl, data); break;
      case 'build':   handleBuild(cl, data); break;
      case 'eat':     handleEat(cl, data); break;
      case 'ping':    send(ws, { type: 'pong', t: data.t }); break;
    }
  });

  ws.on('close', () => { if (playerId) handleDisconnect(playerId); });
  ws.on('error', (e) => { console.error('[WS ERROR]', e.message); if (playerId) handleDisconnect(playerId); });
});

// ══════════════════════════════════════════
// GAME TICK (server tick 20/s)
// ══════════════════════════════════════════
let tickCount = 0;
setInterval(() => {
  tickCount++;

  for (const [id, cl] of clients) {
    const p = cl.player;

    // Fome a cada 15s
    if (tickCount % (TICK_RATE * 15) === 0) {
      p.hunger = Math.max(0, p.hunger - 1);
      if (p.hunger === 0) p.hp = Math.max(0, p.hp - 2);
      if (p.hp <= 0) {
        // morreu de fome
        p.deaths++;
        p.x = (Math.random() - 0.5) * 2000;
        p.y = (Math.random() - 0.5) * 2000;
        p.hp = (CLASSES[p.class_id] || CLASSES[0]).maxHp;
        p.hunger = 100;
        send(cl.ws, { type: 'you_died', killerName: 'Fome', x: p.x, y: p.y, hp: p.hp });
      }
      send(cl.ws, { type: 'stats_update', hp: p.hp, hunger: p.hunger });
    }

    // Regen HP a cada 8s se fome > 60
    if (tickCount % (TICK_RATE * 8) === 0 && p.hunger > 60 && p.hp < p.maxHp) {
      p.hp = Math.min(p.maxHp, p.hp + 1);
      send(cl.ws, { type: 'stats_update', hp: p.hp, hunger: p.hunger });
    }

    // Auto-save a cada 30s
    if (tickCount % (TICK_RATE * 30) === 0) {
      stmts.upsertPlayer.run({ ...p, last_seen: Math.floor(Date.now() / 1000) });
      saveInventory(id, cl.inv);
    }
  }

  // Leaderboard a cada 10s
  if (tickCount % (TICK_RATE * 10) === 0) {
    const lb = stmts.listPlayers.all(Math.floor(Date.now() / 1000) - 3600);
    broadcast({ type: 'leaderboard', data: lb });
  }

  // Online count a cada 5s
  if (tickCount % (TICK_RATE * 5) === 0) {
    broadcast({ type: 'online_count', count: clients.size });
  }

}, 1000 / TICK_RATE);

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════
function publicPlayer(p) {
  return {
    id: p.id, name: p.name, x: p.x, y: p.y,
    hp: p.hp, maxHp: p.maxHp, kills: p.kills,
    level: p.level, class_id: p.class_id,
  };
}

function invToArray(inv) {
  const arr = [];
  for (let s = 0; s < INV_SIZE; s++) {
    arr.push(inv[s] || null);
  }
  return arr;
}

// ══════════════════════════════════════════
// RECEITAS (espelho do frontend, validadas server-side)
// ══════════════════════════════════════════
const RECIPES = {
  stick:            { name:'Graveto',         req:{planks:2},           gives:{stick:4} },
  planks:           { name:'Tábuas',           req:{oak_log:1},          gives:{planks:4} },
  crafting_table:   { name:'Mesa de Craft',    req:{planks:4},           gives:{crafting_table:1} },
  wooden_pickaxe:   { name:'Picareta Madeira', req:{oak_log:3},          gives:{wooden_pickaxe:1} },
  wooden_axe:       { name:'Machado Madeira',  req:{oak_log:3},          gives:{wooden_axe:1} },
  wooden_sword:     { name:'Espada Madeira',   req:{oak_log:2},          gives:{wooden_sword:1} },
  wooden_shovel:    { name:'Pá Madeira',       req:{oak_log:2},          gives:{wooden_shovel:1} },
  wooden_hoe:       { name:'Enxada Madeira',   req:{oak_log:2},          gives:{wooden_hoe:1} },
  stone_pickaxe:    { name:'Picareta Pedra',   req:{cobblestone:3,oak_log:2}, gives:{stone_pickaxe:1} },
  stone_axe:        { name:'Machado Pedra',    req:{cobblestone:3,oak_log:2}, gives:{stone_axe:1} },
  stone_sword:      { name:'Espada Pedra',     req:{cobblestone:2,oak_log:1}, gives:{stone_sword:1} },
  stone_shovel:     { name:'Pá Pedra',         req:{cobblestone:2,oak_log:1}, gives:{stone_shovel:1} },
  iron_pickaxe:     { name:'Picareta Ferro',   req:{iron_ingot:3,oak_log:2},  gives:{iron_pickaxe:1} },
  iron_sword:       { name:'Espada Ferro',     req:{iron_ingot:2,oak_log:1},  gives:{iron_sword:1} },
  iron_axe:         { name:'Machado Ferro',    req:{iron_ingot:3,oak_log:2},  gives:{iron_axe:1} },
  iron_helmet:      { name:'Elmo Ferro',       req:{iron_ingot:5},       gives:{iron_helmet:1} },
  iron_chestplate:  { name:'Peitoral Ferro',   req:{iron_ingot:8},       gives:{iron_chestplate:1} },
  iron_leggings:    { name:'Calças Ferro',     req:{iron_ingot:7},       gives:{iron_leggings:1} },
  iron_boots:       { name:'Botas Ferro',      req:{iron_ingot:4},       gives:{iron_boots:1} },
  gold_sword:       { name:'Espada Ouro',      req:{gold_ingot:2,oak_log:1},  gives:{gold_sword:1} },
  gold_pickaxe:     { name:'Picareta Ouro',    req:{gold_ingot:3,oak_log:2},  gives:{gold_pickaxe:1} },
  diamond_pickaxe:  { name:'Picareta Diamante',req:{diamond_ore:3,oak_log:2}, gives:{diamond_pickaxe:1} },
  diamond_sword:    { name:'Espada Diamante',  req:{diamond_ore:2,oak_log:1}, gives:{diamond_sword:1} },
  diamond_helmet:   { name:'Elmo Diamante',    req:{diamond_ore:5},      gives:{diamond_helmet:1} },
  diamond_chestplate:{ name:'Peitoral Diamante',req:{diamond_ore:8},     gives:{diamond_chestplate:1} },
  netherite_sword:  { name:'Espada Netherita', req:{diamond_sword:1,netherite_ingot:1}, gives:{netherite_sword:1} },
  netherite_pickaxe:{ name:'Picareta Netherita',req:{diamond_pickaxe:1,netherite_ingot:1}, gives:{netherite_pickaxe:1} },
  bow:              { name:'Arco',             req:{oak_log:3,string:3}, gives:{bow:1} },
  arrow:            { name:'Flechas x16',      req:{flint:1,oak_log:1,feather:1}, gives:{arrow:16} },
  torch:            { name:'Tocha x4',         req:{coal_ore:1,oak_log:1}, gives:{torch:4} },
  furnace:          { name:'Fornalha',         req:{cobblestone:8},      gives:{furnace:1} },
  chest:            { name:'Baú',              req:{planks:8},           gives:{chest:1} },
  stone_wall:       { name:'Parede de Pedra',  req:{cobblestone:6},      gives:{stone_wall:6} },
  glass:            { name:'Vidro x4',         req:{sand:4},             gives:{glass:4} },
  door:             { name:'Porta x2',         req:{planks:6},           gives:{door:2} },
  bread:            { name:'Pão',              req:{wheat:3},            gives:{bread:1} },
  golden_apple:     { name:'Maçã Dourada',     req:{apple:1,gold_ingot:8}, gives:{golden_apple:1} },
  bucket:           { name:'Balde',            req:{iron_ingot:3},       gives:{bucket:1} },
  shield:           { name:'Escudo',           req:{planks:6,iron_ingot:1}, gives:{shield:1} },
  compass:          { name:'Bússola',          req:{iron_ingot:4,redstone_ore:1}, gives:{compass:1} },
  fishing_rod:      { name:'Vara de Pescar',   req:{oak_log:3,string:2}, gives:{fishing_rod:1} },
  bowl:             { name:'Tigela x4',        req:{planks:3},           gives:{bowl:4} },
  mushroom_stew:    { name:'Ensopado Cogumelo',req:{red_mushroom:1,brown_mushroom:1,bowl:1}, gives:{mushroom_stew:1} },
  book:             { name:'Livro',            req:{leather:1,sugar:3,feather:1}, gives:{book:1} },
  ladder:           { name:'Escada x4',        req:{oak_log:7},          gives:{ladder:4} },
  bed:              { name:'Cama',             req:{planks:3,wool:3},    gives:{bed:1} },
};

// ══════════════════════════════════════════
// START
// ══════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`\n🌍 CRAFT.IO Server rodando na porta ${PORT}`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   → WebSocket: ws://localhost:${PORT}`);
  console.log(`   → DB: ${DB_PATH}\n`);
});
