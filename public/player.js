const playerState = {
  gameCode: "",
  playerId: "",
  playerName: "",
  room: null,
  selectedAnswer: null,
  lastEventId: 0,
  pollingActive: false,
};

const playerElements = {
  joinForm: document.getElementById("joinForm"),
  playerSummary: document.getElementById("playerSummary"),
  playerSummaryName: document.getElementById("playerSummaryName"),
  playerSummaryCode: document.getElementById("playerSummaryCode"),
  questionTitle: document.getElementById("questionTitle"),
  questionMeta: document.getElementById("questionMeta"),
  answerOptions: document.getElementById("answerOptions"),
  leaderboard: document.getElementById("leaderboard"),
  activityLog: document.getElementById("activityLog"),
  timerValue: document.getElementById("timerValue"),
  connectionStatus: document.getElementById("connectionStatus"),
};

function renderPlayerQuestion(room) {
  playerElements.answerOptions.innerHTML = "";

  if (!room?.currentQuestion) {
    playerElements.questionTitle.textContent = "Aguardando entrada na sala";
    playerElements.questionMeta.textContent = "Quando o anfitriao iniciar, a pergunta aparece aqui.";
    return;
  }

  playerElements.questionTitle.textContent = room.currentQuestion.text;
  playerElements.questionMeta.textContent = `Pergunta ${room.questionIndex + 1} de ${room.totalQuestions}`;

  room.currentQuestion.options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-btn";
    button.textContent = option;
    button.disabled = !playerState.playerId || room.state !== "playing";

    if (playerState.selectedAnswer === index) {
      button.classList.add("selected");
    }

    button.addEventListener("click", async () => {
      try {
        await quizShared.api("/answer", {
          gameCode: playerState.gameCode,
          playerId: playerState.playerId,
          answerIndex: index,
        });
        playerState.selectedAnswer = index;
        renderPlayerQuestion(playerState.room);
        quizShared.logActivity(playerElements.activityLog, `Respondeste: ${option}`);
      } catch (error) {
        alert(error.message);
      }
    });

    playerElements.answerOptions.appendChild(button);
  });
}

function renderPlayerRoom(room) {
  playerState.room = room;
  if (!room) {
    return;
  }

  if (room.state !== "playing") {
    playerState.selectedAnswer = null;
  }

  quizShared.renderLeaderboard(playerElements.leaderboard, room);
  renderPlayerQuestion(room);
}

function handlePlayerEvent(event) {
  playerState.lastEventId = Math.max(playerState.lastEventId, event.id);

  if (event.payload?.room) {
    renderPlayerRoom(event.payload.room);
  }

  switch (event.type) {
    case "player-joined":
      if (event.payload.player.id === playerState.playerId) {
        quizShared.logActivity(playerElements.activityLog, "Entraste na sala.");
      }
      break;
    case "question-started":
      playerState.selectedAnswer = null;
      quizShared.logActivity(playerElements.activityLog, "Nova pergunta iniciada.");
      break;
    case "question-ended":
      quizShared.logActivity(
        playerElements.activityLog,
        `Tempo terminou. Resposta correta: ${event.payload.correctAnswer}`
      );
      break;
    case "game-finished":
      quizShared.logActivity(playerElements.activityLog, "Jogo terminado.");
      break;
    default:
      break;
  }
}

async function pollPlayerUpdates() {
  if (!playerState.gameCode || playerState.pollingActive) {
    return;
  }

  playerState.pollingActive = true;
  quizShared.updateConnectionStatus(playerElements.connectionStatus, "Ligado. A escutar atualizacoes...");

  while (playerState.gameCode) {
    try {
      const response = await fetch(
        `/updates?gameCode=${encodeURIComponent(playerState.gameCode)}&since=${playerState.lastEventId}`
      );
      const data = await response.json();
      (data.events || []).forEach(handlePlayerEvent);
      quizShared.updateConnectionStatus(playerElements.connectionStatus, "Ligado. A escutar atualizacoes...");
    } catch (error) {
      quizShared.updateConnectionStatus(
        playerElements.connectionStatus,
        "Falha na ligacao. A tentar novamente..."
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  playerState.pollingActive = false;
}

playerElements.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const gameCode = document.getElementById("joinGameCode").value.trim().toUpperCase();
    const name = document.getElementById("playerName").value.trim();
    const data = await quizShared.api("/join", { gameCode, name });
    playerState.gameCode = gameCode;
    playerState.playerId = data.playerId;
    playerState.playerName = name;
    localStorage.setItem("quiz-player-game-code", gameCode);
    localStorage.setItem("quiz-player-name", name);
    playerElements.playerSummary.classList.remove("hidden");
    playerElements.playerSummaryName.textContent = name;
    playerElements.playerSummaryCode.textContent = gameCode;
    renderPlayerRoom(data.room);
    quizShared.logActivity(playerElements.activityLog, `Entraste na sala ${gameCode}.`);
    pollPlayerUpdates();
  } catch (error) {
    alert(error.message);
  }
});

const savedCode = localStorage.getItem("quiz-player-game-code");
const savedName = localStorage.getItem("quiz-player-name");
if (savedCode) {
  document.getElementById("joinGameCode").value = savedCode;
}
if (savedName) {
  document.getElementById("playerName").value = savedName;
}

quizShared.startTimerLoop(() => playerState.room?.deadlineAt, playerElements.timerValue);
