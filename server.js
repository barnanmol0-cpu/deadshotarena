const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const ROOT = __dirname;
const WORLD = { width: 1600, height: 900 };
const WALLS = [
  { x: 150, y: 120, w: 220, h: 48 },
  { x: 500, y: 230, w: 90, h: 220 },
  { x: 760, y: 100, w: 200, h: 52 },
  { x: 710, y: 420, w: 260, h: 52 },
  { x: 1180, y: 180, w: 100, h: 260 },
  { x: 260, y: 520, w: 340, h: 52 },
  { x: 1040, y: 610, w: 320, h: 52 },
  { x: 1320, y: 460, w: 160, h: 200 },
  { x: 850, y: 750, w: 260, h: 52 },
];
const TEAM_COLORS = { red: '#ff6e7e', blue: '#69c5ff' };
const WEAPONS = {
  ranger: { name: 'Ranger 9', mode: 'Auto', damage: 18, speed: 540, fireRate: 0.12, recoil: 0.22, spread: 0.05 },
  pulse: { name: 'Pulse R', mode: 'Burst', damage: 26, speed: 620, fireRate: 0.22, recoil: 0.34, spread: 0.08 },
  viper: { name: 'Viper', mode: 'Burst', damage: 34, speed: 680, fireRate: 0.28, recoil: 0.46, spread: 0.12 },
};
const MATCH_RULES = {
  lobbyCountdown: 4,
  roundDuration: 90,
  roundIntermission: 4,
  targetWins: 2,
};
const COLORS = ['#77e6ff', '#8ef7a4', '#f7d57f', '#ff9e7a', '#ff7878', '#b2a8ff'];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createId(prefix = 'p') {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

function canMoveTo(x, y, radius) {
  for (const wall of WALLS) {
    const insideX = x + radius > wall.x && x - radius < wall.x + wall.w;
    const insideY = y + radius > wall.y && y - radius < wall.y + wall.h;
    if (insideX && insideY) {
      return false;
    }
  }
  return true;
}

function getSpawnForTeam(team) {
  const blue = team === 'blue';
  const x = blue ? WORLD.width - 220 : 220;
  const y = 180 + Math.random() * (WORLD.height - 360);
  return { x, y };
}

function getTeamLabel(team) {
  if (team === 'blue') return 'Blue';
  if (team === 'red') return 'Red';
  return 'Lobby';
}

class GameServer {
  constructor() {
    this.players = new Map();
    this.bullets = [];
    this.connections = new Map();
    this.queue = [];
    this.killFeed = [];
    this.matches = new Map();
    this.nextPlayerId = 1;
    this.lastTick = Date.now();
    this.maxPlayers = 24;
    this.matchSize = 8;
    setInterval(() => this.tick(), 1000 / 60);
  }

  addClient(socket) {
    this.connections.set(socket, { socket, playerId: null });
  }

  removeClient(socket) {
    const connection = this.connections.get(socket);
    if (!connection || !connection.playerId) {
      this.connections.delete(socket);
      return;
    }

    const playerId = connection.playerId;
    const player = this.players.get(playerId);
    const queueIndex = this.queue.indexOf(playerId);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);

    if (player && player.matchId) {
      const match = this.matches.get(player.matchId);
      if (match) {
        match.teams.red = match.teams.red.filter((id) => id !== playerId);
        match.teams.blue = match.teams.blue.filter((id) => id !== playerId);
      }
      player.matchId = null;
      player.team = null;
      player.queued = false;
    }

    this.players.delete(playerId);
    this.connections.delete(socket);
  }

  addPlayer(socket, name) {
    const connection = this.connections.get(socket);
    if (!connection) return;
    if (connection.playerId && this.players.has(connection.playerId)) {
      this.players.delete(connection.playerId);
    }

    if (this.players.size >= this.maxPlayers) {
      this.sendSocket(socket, JSON.stringify({ type: 'server-full' }));
      return;
    }

    const playerId = `player-${this.nextPlayerId++}`;
    const player = {
      id: playerId,
      name: (name || 'player').slice(0, 12),
      color: COLORS[(this.nextPlayerId - 1) % COLORS.length],
      x: 220,
      y: 220,
      radius: 16,
      speed: 240,
      angle: 0,
      health: 100,
      maxHealth: 100,
      score: 0,
      kills: 0,
      deaths: 0,
      fireCooldown: 0,
      team: null,
      matchId: null,
      queued: false,
      weapon: 'ranger',
      input: {
        up: false,
        down: false,
        left: false,
        right: false,
        aimX: WORLD.width / 2,
        aimY: WORLD.height / 2,
        shoot: false,
      },
      bot: false,
    };

    this.players.set(playerId, player);
    connection.playerId = playerId;
    this.queuePlayer(playerId);
    this.sendSocket(socket, JSON.stringify({ type: 'joined', playerId }));
    this.broadcastSnapshot();
  }

  queuePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.matchId) return;
    if (!this.queue.includes(playerId)) {
      this.queue.push(playerId);
      player.queued = true;
    }

    if (this.queue.length >= 1) {
      this.startMatchIfNeeded();
    }
  }

  createBotForMatch(team, nameSeed) {
    const botId = `bot-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const bot = {
      id: botId,
      name: `${nameSeed}-${Math.floor(Math.random() * 90 + 10)}`,
      color: TEAM_COLORS[team] || '#77e6ff',
      x: 220,
      y: 220,
      radius: 16,
      speed: 220,
      angle: 0,
      health: 100,
      maxHealth: 100,
      score: 0,
      kills: 0,
      deaths: 0,
      fireCooldown: 0,
      team,
      matchId: null,
      queued: false,
      weapon: 'ranger',
      input: {
        up: false,
        down: false,
        left: false,
        right: false,
        aimX: WORLD.width / 2,
        aimY: WORLD.height / 2,
        shoot: false,
      },
      bot: true,
    };

    const spawn = getSpawnForTeam(team);
    bot.x = spawn.x;
    bot.y = spawn.y;
    this.players.set(botId, bot);
    return botId;
  }

  startMatchIfNeeded() {
    if (this.queue.length < 1) return;
    const matchSize = Math.min(this.matchSize, Math.max(2, this.queue.length));
    const participants = this.queue.splice(0, this.queue.length);
    const matchId = `match-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const match = {
      id: matchId,
      phase: 'countdown',
      round: 1,
      countdown: MATCH_RULES.lobbyCountdown,
      roundWinner: null,
      winner: null,
      timeLeft: MATCH_RULES.roundDuration,
      score: { red: 0, blue: 0 },
      roundWins: { red: 0, blue: 0 },
      teamKills: { red: 0, blue: 0 },
      teams: { red: [], blue: [] },
      summary: 'Match starting',
    };

    while (participants.length < matchSize) {
      const team = participants.length % 2 === 0 ? 'red' : 'blue';
      const botId = this.createBotForMatch(team, team === 'red' ? 'redbot' : 'bluebot');
      participants.push(botId);
    }

    participants.forEach((id, index) => {
      const player = this.players.get(id);
      if (!player) return;
      const team = index % 2 === 0 ? 'red' : 'blue';
      player.team = team;
      player.matchId = matchId;
      player.queued = false;
      player.score = 0;
      player.kills = 0;
      player.deaths = 0;
      player.health = 100;
      player.fireCooldown = 0;
      player.input.shoot = false;
      if (!player.bot) {
        const spawn = getSpawnForTeam(team);
        player.x = spawn.x;
        player.y = spawn.y;
      }
      match.teams[team].push(id);
    });

    this.matches.set(matchId, match);
    this.pushKillFeed(`Match ${match.round} starting in ${MATCH_RULES.lobbyCountdown}s`);
    this.broadcastSnapshot();
  }

  resetRoundState(match) {
    match.teamKills = { red: 0, blue: 0 };
    match.timeLeft = MATCH_RULES.roundDuration;
    match.summary = `Round ${match.round} is live`;

    for (const teamName of ['red', 'blue']) {
      for (const playerId of match.teams[teamName] || []) {
        const player = this.players.get(playerId);
        if (!player) continue;
        const spawn = getSpawnForTeam(teamName);
        player.x = spawn.x;
        player.y = spawn.y;
        player.health = player.maxHealth;
        player.fireCooldown = 0;
        player.input.shoot = false;
      }
    }
  }

  finishRound(match, winnerTeam) {
    if (!winnerTeam || winnerTeam === 'draw') {
      match.summary = 'Round tie';
    } else {
      match.roundWinner = winnerTeam;
      match.roundWins[winnerTeam] += 1;
      match.score[winnerTeam] += 1;
      match.summary = `${getTeamLabel(winnerTeam)} win round ${match.round}`;
      this.pushKillFeed(`${getTeamLabel(winnerTeam)} take round ${match.round}`);
    }

    const targetReached = match.roundWins.red >= MATCH_RULES.targetWins || match.roundWins.blue >= MATCH_RULES.targetWins;
    if (targetReached) {
      match.phase = 'finished';
      match.winner = match.roundWins.red >= MATCH_RULES.targetWins ? 'red' : 'blue';
      match.countdown = 8;
      match.summary = `${getTeamLabel(match.winner)} win the match`;
      this.pushKillFeed(`${getTeamLabel(match.winner)} win the match`);
      return;
    }

    match.phase = 'round_end';
    match.countdown = MATCH_RULES.roundIntermission;
    match.round += 1;
  }

  finalizeMatch(matchId) {
    const match = this.matches.get(matchId);
    if (!match) return;

    const playerIds = [...match.teams.red, ...match.teams.blue];
    for (const playerId of playerIds) {
      const player = this.players.get(playerId);
      if (!player) continue;
      player.matchId = null;
      player.team = null;
      player.queued = false;
      this.queuePlayer(playerId);
    }
    this.matches.delete(matchId);
  }

  updatePlayerInput(playerId, input) {
    const player = this.players.get(playerId);
    if (!player || !player.matchId) return;
    const match = this.matches.get(player.matchId);
    if (!match || match.phase !== 'live') return;

    player.input = {
      ...player.input,
      ...input,
      aimX: Number.isFinite(input.aimX) ? input.aimX : WORLD.width / 2,
      aimY: Number.isFinite(input.aimY) ? input.aimY : WORLD.height / 2,
    };

    if (input.weapon) {
      player.weapon = input.weapon;
    }
  }

  spawnBullet(ownerId, x, y, targetX, targetY) {
    const owner = this.players.get(ownerId);
    if (!owner || !owner.matchId) return;

    const weapon = WEAPONS[owner.weapon] || WEAPONS.ranger;
    const spread = ((Math.random() - 0.5) * weapon.spread) || 0;
    const angle = Math.atan2(targetY - y, targetX - x) + spread;

    this.bullets.push({
      id: createId('b'),
      ownerId,
      x,
      y,
      vx: Math.cos(angle) * weapon.speed,
      vy: Math.sin(angle) * weapon.speed,
      radius: 4,
      damage: weapon.damage,
      life: 1.6,
      team: owner.team,
    });
  }

  pushKillFeed(text) {
    this.killFeed.unshift({ text, time: Date.now() });
    this.killFeed = this.killFeed.slice(0, 6);
  }

  respawnPlayer(player) {
    const team = player.team || 'red';
    const spawn = getSpawnForTeam(team);
    player.x = spawn.x;
    player.y = spawn.y;
    player.health = player.maxHealth;
    player.input.shoot = false;
    player.fireCooldown = 0;
  }

  tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000 || 1 / 60;
    this.lastTick = now;

    for (const match of this.matches.values()) {
      if (match.phase === 'countdown') {
        match.countdown = Math.max(0, match.countdown - dt);
        match.summary = `Starting in ${Math.ceil(match.countdown)}`;
        if (match.countdown <= 0) {
          match.phase = 'live';
          match.countdown = 0;
          match.timeLeft = MATCH_RULES.roundDuration;
          match.teamKills = { red: 0, blue: 0 };
          match.summary = 'Round live';
        }
      }

      if (match.phase === 'live') {
        match.timeLeft = Math.max(0, match.timeLeft - dt);
        if (match.timeLeft <= 0) {
          const redKills = match.teamKills.red || 0;
          const blueKills = match.teamKills.blue || 0;
          const winner = redKills === blueKills ? 'draw' : redKills > blueKills ? 'red' : 'blue';
          if (winner === 'draw') {
            match.summary = 'Round tied';
            this.pushKillFeed('Round tied — both squads held their ground');
          } else {
            this.finishRound(match, winner);
          }
        }
      }

      if (match.phase === 'round_end' || match.phase === 'finished') {
        match.countdown = Math.max(0, (match.countdown || 0) - dt);
        if (match.countdown <= 0) {
          if (match.phase === 'finished') {
            this.finalizeMatch(match.id);
          } else {
            match.phase = 'countdown';
            match.countdown = MATCH_RULES.lobbyCountdown;
            match.roundWinner = null;
            match.summary = `Round ${match.round} starting`;
            this.resetRoundState(match);
          }
        }
      }
    }

    for (const player of this.players.values()) {
      if (!player.matchId) continue;
      const match = this.matches.get(player.matchId);
      if (!match || match.phase !== 'live') {
        player.input.shoot = false;
        continue;
      }

      const input = player.input || { up: false, down: false, left: false, right: false, aimX: WORLD.width / 2, aimY: WORLD.height / 2, shoot: false };
      let dx = 0;
      let dy = 0;

      if (input.up) dy -= 1;
      if (input.down) dy += 1;
      if (input.left) dx -= 1;
      if (input.right) dx += 1;

      if (dx || dy) {
        const magnitude = Math.hypot(dx, dy) || 1;
        dx = (dx / magnitude) * player.speed;
        dy = (dy / magnitude) * player.speed;
      }

      const nextX = player.x + dx * dt;
      const nextY = player.y + dy * dt;
      if (canMoveTo(nextX, player.y, player.radius)) {
        player.x = clamp(nextX, player.radius, WORLD.width - player.radius);
      }
      if (canMoveTo(player.x, nextY, player.radius)) {
        player.y = clamp(nextY, player.radius, WORLD.height - player.radius);
      }

      player.angle = Math.atan2((input.aimY || player.y) - player.y, (input.aimX || player.x) - player.x);
      player.fireCooldown = Math.max(0, (player.fireCooldown || 0) - dt);

      if (input.shoot && player.fireCooldown <= 0) {
        const weapon = WEAPONS[player.weapon] || WEAPONS.ranger;
        this.spawnBullet(player.id, player.x, player.y, input.aimX, input.aimY);
        player.fireCooldown = weapon.fireRate;
      }
    }

    for (let i = this.bullets.length - 1; i >= 0; i -= 1) {
      const bullet = this.bullets[i];
      bullet.x += bullet.vx * dt;
      bullet.y += bullet.vy * dt;
      bullet.life -= dt;

      if (
        bullet.life <= 0 ||
        bullet.x < 0 ||
        bullet.x > WORLD.width ||
        bullet.y < 0 ||
        bullet.y > WORLD.height
      ) {
        this.bullets.splice(i, 1);
        continue;
      }

      let hitWall = false;
      for (const wall of WALLS) {
        const insideX = bullet.x > wall.x && bullet.x < wall.x + wall.w;
        const insideY = bullet.y > wall.y && bullet.y < wall.y + wall.h;
        if (insideX && insideY) {
          hitWall = true;
          break;
        }
      }
      if (hitWall) {
        this.bullets.splice(i, 1);
        continue;
      }

      let hitPlayer = false;
      for (const other of this.players.values()) {
        if (!other.matchId || other.id === bullet.ownerId || other.team === bullet.team) continue;
        const match = this.matches.get(other.matchId);
        if (!match || match.phase !== 'live') continue;
        const hitDistance = Math.hypot(other.x - bullet.x, other.y - bullet.y);
        if (hitDistance < other.radius + bullet.radius) {
          other.health = clamp(other.health - bullet.damage, 0, other.maxHealth);
          const shooter = this.players.get(bullet.ownerId);
          this.bullets.splice(i, 1);

          if (shooter && other.health <= 0) {
            shooter.score += 100;
            shooter.kills += 1;
            other.deaths += 1;
            if (shooter.team && match.teamKills[shooter.team] !== undefined) {
              match.teamKills[shooter.team] = (match.teamKills[shooter.team] || 0) + 1;
            }
            if (match.teamKills.red >= 7 || match.teamKills.blue >= 7) {
              this.finishRound(match, match.teamKills.red >= 7 ? 'red' : 'blue');
            }
            this.pushKillFeed(`${shooter.name} eliminated ${other.name}`);
            this.respawnPlayer(other);
          }

          hitPlayer = true;
          break;
        }
      }

      if (hitPlayer) continue;
    }

    for (const player of this.players.values()) {
      if (player.matchId && player.health <= 0) {
        this.respawnPlayer(player);
      }
    }

    this.broadcastSnapshot();
  }

  sendSocket(socket, message) {
    if (!socket || socket.destroyed) return;
    const payload = Buffer.from(message, 'utf8');
    const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
    header[0] = 0x81;

    if (payload.length < 126) {
      header[1] = payload.length;
    } else if (payload.length < 65536) {
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header[1] = 127;
      header.writeBigUInt32BE(0, 2);
      header.writeBigUInt64BE(BigInt(payload.length), 6);
    }

    socket.write(Buffer.concat([header, payload]));
  }

  broadcastSnapshot() {
    const activeMatch = [...this.matches.values()][0] || null;
    const data = {
      type: 'snapshot',
      phase: activeMatch ? activeMatch.phase : 'lobby',
      queueSize: this.queue.length,
      match: activeMatch ? {
        id: activeMatch.id,
        phase: activeMatch.phase,
        round: activeMatch.round,
        countdown: activeMatch.countdown,
        timeLeft: activeMatch.timeLeft,
        score: activeMatch.score,
        roundWins: activeMatch.roundWins,
        winner: activeMatch.winner,
        roundWinner: activeMatch.roundWinner,
        summary: activeMatch.summary,
        teams: activeMatch.teams,
      } : null,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        angle: player.angle,
        health: player.health,
        maxHealth: player.maxHealth,
        score: player.score,
        kills: player.kills,
        color: player.color,
        radius: player.radius,
        team: player.team,
        bot: player.bot,
        matchId: player.matchId,
        weapon: player.weapon,
      })),
      bullets: this.bullets.map((bullet) => ({
        id: bullet.id,
        x: bullet.x,
        y: bullet.y,
        radius: bullet.radius,
        damage: bullet.damage,
        ownerId: bullet.ownerId,
      })),
      killFeed: this.killFeed,
    };

    const message = JSON.stringify(data);
    for (const connection of this.connections.values()) {
      this.sendSocket(connection.socket, message);
    }
  }
}

const game = new GameServer();

function serveStaticFile(req, res) {
  let requestPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  requestPath = decodeURIComponent(requestPath);
  const safePath = path.normalize(path.join(ROOT, requestPath));

  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(safePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const extension = path.extname(safePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };

    res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleIncomingMessage(socket, message) {
  try {
    const parsed = JSON.parse(message);
    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.type === 'join') {
      game.addPlayer(socket, parsed.name || 'player');
      return;
    }

    if (parsed.type === 'queue') {
      const playerId = game.connections.get(socket)?.playerId;
      if (playerId) {
        game.queuePlayer(playerId);
      }
      return;
    }

    if (parsed.type === 'input' && socket && game.connections.has(socket)) {
      const playerId = game.connections.get(socket).playerId;
      if (playerId) {
        game.updatePlayerInput(playerId, parsed.input || {});
      }
    }
  } catch (error) {
    console.error('Message parse error:', error.message);
  }
}

const server = http.createServer((req, res) => {
  if (req.headers.upgrade === 'websocket') {
    res.writeHead(426, { 'Upgrade': 'websocket' });
    res.end();
    return;
  }
  serveStaticFile(req, res);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const hash = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${hash}`,
    '',
    '',
  ].join('\r\n'));

  game.addClient(socket);

  socket.on('data', (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const first = chunk[offset];
      const second = chunk[offset + 1];
      const opcode = first & 0x0F;
      const masked = (second & 0x80) === 0x80;
      let payloadLength = second & 0x7F;
      offset += 2;

      if (payloadLength === 126) {
        payloadLength = chunk.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        payloadLength = Number(chunk.readBigUInt64BE(offset));
        offset += 8;
      }

      let mask = null;
      if (masked) {
        mask = chunk.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = chunk.subarray(offset, offset + payloadLength);
      offset += payloadLength;

      if (!payload.length) continue;

      let message = payload;
      if (mask) {
        message = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) {
          message[i] = payload[i] ^ mask[i % 4];
        }
      }

      if (opcode === 0x8) {
        socket.destroy();
        game.removeClient(socket);
        return;
      }

      if (opcode === 0x1) {
        handleIncomingMessage(socket, message.toString('utf8'));
      }
    }
  });

  socket.on('close', () => {
    game.removeClient(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Deadshot multiplayer server running at http://localhost:${PORT}`);
});
