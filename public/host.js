const hostState = {
  gameCode: "",
  room: null,
  lastEventId: 0,
  pollingActive: false,
};

const hostElements = {
  createRoomForm: document.getElementById("createRoomForm"),
  hostControls: document.getElementById("hostControls"),
  hostGameCode: document.getElementById("hostGameCode"),
  roomState: document.getElementById("roomState"),
  startGameBtn: document.getElementById("startGameBtn"),
  nextQuestionBtn: document.getElementById("nextQuestionBtn"),
  questionTitle: document.getElementById("questionTitle"),
  questionMeta: document.getElementById("questionMeta"),
  leaderboard: document.getElementById("leaderboard"),
  activityLog: document.getElementById("activityLog"),
  timerValue: document.getElementById("timerValue"),
  connectionStatus: document.getElementById("connectionStatus"),
};

function renderHostRoom(room) {
  hostState.room = room;
  if (!room) {
    return;
  }

  hostElements.roomState.textContent = room.state;
  quizShared.renderLeaderboard(hostElements.leaderboard, room);

  hostElements.questionTitle.textContent = room.currentQuestion
    ? room.currentQuestion.text
    : "Aguardando criacao da sala";
  hostElements.questionMeta.textContent = room.currentQuestion
    ? `Pergunta ${room.questionIndex + 1} de ${room.totalQuestions}`
    : "Partilha o codigo com os jogadores para comecarem a entrar.";

  hostElements.startGameBtn.disabled = room.state !== "lobby" || room.leaderboard.length === 0;
  hostElements.nextQuestionBtn.classList.toggle("hidden", room.state !== "revealing");
  hostElements.nextQuestionBtn.disabled = room.state !== "revealing";
}

function handleHostEvent(event) {
  hostState.lastEventId = Math.max(hostState.lastEventId, event.id);

  if (event.payload?.room) {
    renderHostRoom(event.payload.room);
  }

  switch (event.type) {
    case "room-created":
      quizShared.logActivity(hostElements.activityLog, "Sala criada.");
      break;
    case "player-joined":
      quizShared.logActivity(hostElements.activityLog, `${event.payload.player.name} entrou na sala.`);
      break;
    case "question-started":
      quizShared.logActivity(hostElements.activityLog, "Nova pergunta iniciada.");
      break;
    case "question-ended":
      quizShared.logActivity(
        hostElements.activityLog,
        `Pergunta terminada. Resposta correta: ${event.payload.correctAnswer}`
      );
      break;
    case "game-finished":
      quizShared.logActivity(hostElements.activityLog, "Jogo terminado.");
      break;
    default:
      break;
  }
}

async function pollHostUpdates() {
  if (!hostState.gameCode || hostState.pollingActive) {
    return;
  }

  hostState.pollingActive = true;
  quizShared.updateConnectionStatus(hostElements.connectionStatus, "Ligado. A escutar atualizacoes...");

  while (hostState.gameCode) {
    try {
      const response = await fetch(
        `/updates?gameCode=${encodeURIComponent(hostState.gameCode)}&since=${hostState.lastEventId}`
      );
      const data = await response.json();
      (data.events || []).forEach(handleHostEvent);
      quizShared.updateConnectionStatus(hostElements.connectionStatus, "Ligado. A escutar atualizacoes...");
    } catch (error) {
      quizShared.updateConnectionStatus(
        hostElements.connectionStatus,
        "Falha na ligacao. A tentar novamente..."
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  hostState.pollingActive = false;
}

hostElements.createRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const hostName = document.getElementById("hostName").value.trim();
    const data = await quizShared.api("/create-room", { hostName });
    hostState.gameCode = data.gameCode;
    hostElements.hostControls.classList.remove("hidden");
    hostElements.hostGameCode.textContent = data.gameCode;
    localStorage.setItem("quiz-host-game-code", data.gameCode);
    renderHostRoom(data.room);
    quizShared.logActivity(hostElements.activityLog, `Sala ${data.gameCode} pronta para receber jogadores.`);
    pollHostUpdates();
  } catch (error) {
    alert(error.message);
  }
});

hostElements.startGameBtn.addEventListener("click", async () => {
  try {
    await quizShared.api("/start", { gameCode: hostState.gameCode });
    quizShared.logActivity(hostElements.activityLog, "Jogo iniciado pelo anfitriao.");
  } catch (error) {
    alert(error.message);
  }
});

hostElements.nextQuestionBtn.addEventListener("click", async () => {
  try {
    await quizShared.api("/next-question", { gameCode: hostState.gameCode });
    quizShared.logActivity(hostElements.activityLog, "Pergunta seguinte enviada.");
  } catch (error) {
    alert(error.message);
  }
});

quizShared.startTimerLoop(() => hostState.room?.deadlineAt, hostElements.timerValue);
