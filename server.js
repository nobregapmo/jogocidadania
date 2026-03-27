const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const QUESTIONS_FILE = path.join(DATA_DIR, "questions.json");
const DATABASE_FILE = path.join(DATA_DIR, "game.db");
const LONG_POLL_TIMEOUT_MS = 25000;
const QUESTION_TIME_MS = 15000;

const rooms = new Map();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadQuestions() {
  const raw = fs.readFileSync(QUESTIONS_FILE, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("O ficheiro de perguntas tem de conter uma lista com pelo menos uma pergunta.");
  }

  return data.map((question, index) => {
    if (
      typeof question.text !== "string" ||
      !Array.isArray(question.options) ||
      question.options.length < 2 ||
      !Number.isInteger(question.correctIndex) ||
      question.correctIndex < 0 ||
      question.correctIndex >= question.options.length
    ) {
      throw new Error(`Pergunta invalida no indice ${index}.`);
    }

    return {
      id: question.id || index + 1,
      text: question.text,
      options: question.options,
      correctIndex: question.correctIndex,
    };
  });
}

ensureDataDir();
const quizQuestions = loadQuestions();
const db = new DatabaseSync(DATABASE_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    game_code TEXT PRIMARY KEY,
    host_name TEXT NOT NULL,
    state TEXT NOT NULL,
    current_question_index INTEGER NOT NULL,
    total_questions INTEGER NOT NULL,
    deadline_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_code TEXT NOT NULL,
    name TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    answered_current INTEGER NOT NULL DEFAULT 0,
    current_answer INTEGER,
    joined_at INTEGER NOT NULL,
    UNIQUE(game_code, name),
    FOREIGN KEY (game_code) REFERENCES rooms(game_code)
  );
`);

const statements = {
  roomByCode: db.prepare(`
    SELECT game_code, host_name, state, current_question_index, total_questions, deadline_at, created_at, updated_at
    FROM rooms
    WHERE game_code = ?
  `),
  insertRoom: db.prepare(`
    INSERT INTO rooms (game_code, host_name, state, current_question_index, total_questions, deadline_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateRoom: db.prepare(`
    UPDATE rooms
    SET host_name = ?, state = ?, current_question_index = ?, total_questions = ?, deadline_at = ?, updated_at = ?
    WHERE game_code = ?
  `),
  insertPlayer: db.prepare(`
    INSERT INTO players (game_code, name, score, answered_current, current_answer, joined_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  updatePlayer: db.prepare(`
    UPDATE players
    SET name = ?, score = ?, answered_current = ?, current_answer = ?
    WHERE id = ?
  `),
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1_000_000) {
        reject(new Error("Pedido demasiado grande."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("JSON invalido."));
      }
    });

    req.on("error", reject);
  });
}

function now() {
  return Date.now();
}

function createGameCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code) || statements.roomByCode.get(code));

  return code;
}

function validateName(name) {
  const clean = String(name || "").trim().slice(0, 20);
  if (!clean) {
    throw new Error("Nome obrigatorio.");
  }
  return clean;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    answeredCurrent: player.answeredCurrent,
  };
}

function getLeaderboard(room) {
  return Array.from(room.players.values())
    .map(publicPlayer)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "pt"));
}

function getCurrentQuestion(room) {
  return room.currentQuestionIndex >= 0 ? room.questions[room.currentQuestionIndex] : null;
}

function getRoomState(room) {
  const currentQuestion = getCurrentQuestion(room);

  return {
    gameCode: room.gameCode,
    state: room.state,
    hostName: room.hostName,
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    currentQuestion: currentQuestion
      ? {
          id: currentQuestion.id,
          text: currentQuestion.text,
          options: currentQuestion.options,
        }
      : null,
    deadlineAt: room.deadlineAt,
    leaderboard: getLeaderboard(room),
  };
}

function persistRoom(room) {
  const timestamp = now();
  const existing = statements.roomByCode.get(room.gameCode);

  if (!existing) {
    statements.insertRoom.run(
      room.gameCode,
      room.hostName,
      room.state,
      room.currentQuestionIndex,
      room.questions.length,
      room.deadlineAt,
      timestamp,
      timestamp
    );
    return;
  }

  statements.updateRoom.run(
    room.hostName,
    room.state,
    room.currentQuestionIndex,
    room.questions.length,
    room.deadlineAt,
    timestamp,
    room.gameCode
  );
}

function persistPlayer(player) {
  statements.updatePlayer.run(
    player.name,
    player.score,
    player.answeredCurrent ? 1 : 0,
    player.currentAnswer,
    Number(player.id)
  );
}

function persistPlayers(room) {
  room.players.forEach((player) => persistPlayer(player));
}

function emitEvent(room, type, payload = {}) {
  room.lastEventId += 1;

  const event = {
    id: room.lastEventId,
    type,
    createdAt: now(),
    payload,
  };

  room.events.push(event);

  const pending = room.pendingPolls.splice(0);
  pending.forEach(({ res, timeout }) => {
    clearTimeout(timeout);
    sendJson(res, 200, { events: [event], serverTime: now() });
  });
}

function ensureRoom(gameCode) {
  const room = rooms.get(String(gameCode || "").toUpperCase());
  if (!room) {
    throw new Error("Sala nao encontrada.");
  }
  return room;
}

function questionSummary(question) {
  return {
    id: question.id,
    text: question.text,
    options: question.options,
  };
}

function createRoom(hostName) {
  const gameCode = createGameCode();
  const room = {
    gameCode,
    hostName,
    state: "lobby",
    questions: quizQuestions,
    currentQuestionIndex: -1,
    deadlineAt: null,
    questionTimer: null,
    players: new Map(),
    lastEventId: 0,
    events: [],
    pendingPolls: [],
  };

  rooms.set(gameCode, room);
  persistRoom(room);
  emitEvent(room, "room-created", { room: getRoomState(room) });
  return room;
}

function startQuestion(room) {
  room.currentQuestionIndex += 1;

  if (room.currentQuestionIndex >= room.questions.length) {
    room.state = "finished";
    room.deadlineAt = null;
    room.questionTimer = null;
    persistRoom(room);
    emitEvent(room, "game-finished", {
      room: getRoomState(room),
      leaderboard: getLeaderboard(room),
    });
    return;
  }

  room.state = "playing";
  room.deadlineAt = now() + QUESTION_TIME_MS;

  room.players.forEach((player) => {
    player.answeredCurrent = false;
    player.currentAnswer = null;
  });

  persistRoom(room);
  persistPlayers(room);

  const question = room.questions[room.currentQuestionIndex];
  emitEvent(room, "question-started", {
    room: getRoomState(room),
    question: questionSummary(question),
    deadlineAt: room.deadlineAt,
  });

  room.questionTimer = setTimeout(() => finishQuestion(room), QUESTION_TIME_MS);
}

function finishQuestion(room) {
  if (room.state !== "playing") {
    return;
  }

  const question = room.questions[room.currentQuestionIndex];
  room.deadlineAt = null;
  room.questionTimer = null;
  room.state = room.currentQuestionIndex === room.questions.length - 1 ? "finished" : "revealing";
  persistRoom(room);

  emitEvent(room, "question-ended", {
    room: getRoomState(room),
    correctIndex: question.correctIndex,
    correctAnswer: question.options[question.correctIndex],
    leaderboard: getLeaderboard(room),
  });

  if (room.state === "finished") {
    emitEvent(room, "game-finished", {
      room: getRoomState(room),
      leaderboard: getLeaderboard(room),
    });
  }
}

function resolveStaticPath(pathname) {
  if (pathname === "/") {
    return "/index.html";
  }
  if (pathname === "/host") {
    return "/host.html";
  }
  if (pathname === "/player") {
    return "/player.html";
  }
  return pathname.startsWith("/public/") ? pathname.replace("/public", "") : pathname;
}

function serveStatic(res, pathname) {
  const safePath = resolveStaticPath(pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Acesso negado.");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Ficheiro nao encontrado.");
      return;
    }

    const ext = path.extname(filePath);
    const contentType =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
      }[ext] || "application/octet-stream";

    sendText(res, 200, data, contentType);
  });
}

function handleCreateRoom(res, body) {
  const hostName = validateName(body.hostName || "Host");
  const room = createRoom(hostName);

  sendJson(res, 201, {
    gameCode: room.gameCode,
    room: getRoomState(room),
  });
}

function handleJoin(res, body) {
  const room = ensureRoom(body.gameCode);
  if (room.state !== "lobby") {
    throw new Error("O jogo ja comecou.");
  }

  const name = validateName(body.name);
  const duplicate = Array.from(room.players.values()).find((player) => player.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    throw new Error("Ja existe um jogador com esse nome.");
  }

  const info = statements.insertPlayer.run(room.gameCode, name, 0, 0, null, now());
  const player = {
    id: String(info.lastInsertRowid),
    name,
    score: 0,
    answeredCurrent: false,
    currentAnswer: null,
  };

  room.players.set(player.id, player);
  emitEvent(room, "player-joined", {
    player: publicPlayer(player),
    room: getRoomState(room),
  });

  sendJson(res, 201, {
    playerId: player.id,
    room: getRoomState(room),
  });
}

function handleStart(res, body) {
  const room = ensureRoom(body.gameCode);
  if (room.state !== "lobby") {
    throw new Error("O jogo ja foi iniciado.");
  }
  if (room.players.size === 0) {
    throw new Error("Precisas de pelo menos um jogador para comecar.");
  }

  startQuestion(room);
  sendJson(res, 200, { room: getRoomState(room) });
}

function handleNext(res, body) {
  const room = ensureRoom(body.gameCode);
  if (room.state !== "revealing") {
    throw new Error("Ainda nao podes avancar.");
  }

  startQuestion(room);
  sendJson(res, 200, { room: getRoomState(room) });
}

function handleAnswer(res, body) {
  const room = ensureRoom(body.gameCode);
  if (room.state !== "playing") {
    throw new Error("Nao ha pergunta ativa neste momento.");
  }

  const player = room.players.get(String(body.playerId || ""));
  if (!player) {
    throw new Error("Jogador nao encontrado.");
  }
  if (player.answeredCurrent) {
    throw new Error("Ja respondeste a esta pergunta.");
  }

  const answerIndex = Number(body.answerIndex);
  const question = room.questions[room.currentQuestionIndex];
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= question.options.length) {
    throw new Error("Resposta invalida.");
  }

  player.answeredCurrent = true;
  player.currentAnswer = answerIndex;

  if (answerIndex === question.correctIndex) {
    const remainingMs = Math.max(0, room.deadlineAt - now());
    const bonus = Math.ceil(remainingMs / 1000);
    player.score += 10 + bonus;
  }

  persistPlayer(player);
  emitEvent(room, "player-answered", {
    playerId: player.id,
    room: getRoomState(room),
  });

  sendJson(res, 200, {
    ok: true,
    answered: true,
    room: getRoomState(room),
  });
}

function handleUpdates(req, res, searchParams) {
  const room = ensureRoom(searchParams.get("gameCode"));
  const since = Number(searchParams.get("since") || 0);
  const events = room.events.filter((event) => event.id > since);

  if (events.length > 0) {
    sendJson(res, 200, { events, serverTime: now() });
    return;
  }

  const timeout = setTimeout(() => {
    room.pendingPolls = room.pendingPolls.filter((poll) => poll.res !== res);
    sendJson(res, 200, { events: [], serverTime: now() });
  }, LONG_POLL_TIMEOUT_MS);

  room.pendingPolls.push({ res, timeout });

  req.on("close", () => {
    clearTimeout(timeout);
    room.pendingPolls = room.pendingPolls.filter((poll) => poll.res !== res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (
      req.method === "GET" &&
      (
        pathname === "/" ||
        pathname === "/host" ||
        pathname === "/player" ||
        pathname.startsWith("/public/") ||
        pathname.endsWith(".js") ||
        pathname.endsWith(".css") ||
        pathname.endsWith(".html")
      )
    ) {
      serveStatic(res, pathname);
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/state") {
      const room = ensureRoom(url.searchParams.get("gameCode"));
      sendJson(res, 200, { room: getRoomState(room) });
      return;
    }

    if (req.method === "GET" && pathname === "/updates") {
      handleUpdates(req, res, url.searchParams);
      return;
    }

    if (req.method === "POST") {
      const body = await parseBody(req);

      if (pathname === "/create-room") {
        handleCreateRoom(res, body);
        return;
      }
      if (pathname === "/join") {
        handleJoin(res, body);
        return;
      }
      if (pathname === "/start") {
        handleStart(res, body);
        return;
      }
      if (pathname === "/next-question") {
        handleNext(res, body);
        return;
      }
      if (pathname === "/answer") {
        handleAnswer(res, body);
        return;
      }
    }

    sendText(res, 404, "Rota nao encontrada.");
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Erro inesperado." });
  }
});

server.listen(PORT, () => {
  console.log(`Servidor em http://localhost:${PORT}`);
});
