(function () {
  function api(path, payload) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Pedido falhou.");
      }
      return data;
    });
  }

  function updateConnectionStatus(element, text) {
    if (element) {
      element.textContent = text;
    }
  }

  function logActivity(listElement, message) {
    if (!listElement) {
      return;
    }

    const item = document.createElement("li");
    item.textContent = `${new Date().toLocaleTimeString("pt-PT")} - ${message}`;
    listElement.prepend(item);
  }

  function renderLeaderboard(listElement, room) {
    if (!listElement) {
      return;
    }

    listElement.innerHTML = "";
    (room?.leaderboard || []).forEach((player) => {
      const item = document.createElement("li");
      item.textContent = `${player.name} - ${player.score} pts`;
      listElement.appendChild(item);
    });
  }

  function startTimerLoop(getDeadlineAt, timerElement) {
    setInterval(() => {
      const deadlineAt = getDeadlineAt();
      if (!deadlineAt) {
        timerElement.textContent = "--";
        return;
      }

      const seconds = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
      timerElement.textContent = `${seconds}s`;
    }, 250);
  }

  window.quizShared = {
    api,
    logActivity,
    renderLeaderboard,
    startTimerLoop,
    updateConnectionStatus,
  };
})();
