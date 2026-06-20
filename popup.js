(function () {
  const FLOW_PAGE_REGEX = /^https:\/\/labs\.google\/fx\/tools\/flow\/project\/.+/i;
  const MESSAGE_TYPES = {
    ping: "FLOW_PING",
    run: "FLOW_RUN_GENERATE_AND_DOWNLOAD",
    progress: "FLOW_PROGRESS",
    result: "FLOW_RESULT",
    error: "FLOW_ERROR",
    popupInit: "FLOW_POPUP_INIT",
    getLastDiagnostics: "FLOW_GET_LAST_DIAGNOSTICS"
  };

  const promptInput = document.getElementById("promptInput");
  const runButton = document.getElementById("runButton");
  const copyDiagnosticsButton = document.getElementById("copyDiagnosticsButton");
  const flowBadge = document.getElementById("flowBadge");
  const requestBadge = document.getElementById("requestBadge");
  const statusMessage = document.getElementById("statusMessage");
  const logList = document.getElementById("logList");

  let activeTabId = null;
  let activeRequestId = null;
  let logs = [];

  function setFlowBadge(text, tone) {
    flowBadge.textContent = text;
    flowBadge.className = "badge " + tone;
  }

  function setRequestBadge(text) {
    requestBadge.textContent = text;
  }

  function setStatus(text) {
    statusMessage.textContent = text;
  }

  function appendLog(step, status, message) {
    const item = { step, status, message };
    logs = [item].concat(logs).slice(0, 40);
    renderLogs();
  }

  function renderLogs() {
    logList.textContent = "";
    if (!logs.length) {
      const empty = document.createElement("p");
      empty.className = "log-message";
      empty.textContent = "Todavia no hay eventos.";
      logList.appendChild(empty);
      return;
    }

    for (const item of logs) {
      const wrapper = document.createElement("article");
      wrapper.className = "log-item";

      const head = document.createElement("div");
      head.className = "log-head";

      const step = document.createElement("span");
      step.className = "log-step";
      step.textContent = item.step;

      const status = document.createElement("span");
      status.className = "log-status";
      status.textContent = item.status;

      const message = document.createElement("p");
      message.className = "log-message";
      message.textContent = item.message;

      head.appendChild(step);
      head.appendChild(status);
      wrapper.appendChild(head);
      wrapper.appendChild(message);
      logList.appendChild(wrapper);
    }
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  async function initializePopupState() {
    renderLogs();
    copyDiagnosticsButton.disabled = true;
    setStatus("Buscando una pestana activa de Google Flow...");

    const tab = await getActiveTab();
    if (!tab || typeof tab.id !== "number") {
      setFlowBadge("Sin pestana", "error");
      setStatus("No encontre una pestana activa para conectar la extension.");
      runButton.disabled = true;
      return;
    }

    activeTabId = tab.id;
    const url = tab.url || "";

    if (!FLOW_PAGE_REGEX.test(url)) {
      setFlowBadge("Fuera de Flow", "error");
      setStatus("Abre primero un proyecto de Google Flow.");
      runButton.disabled = true;
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(activeTabId, { type: MESSAGE_TYPES.ping });
      if (!response || !response.ok) {
        throw new Error("CONTENT_SCRIPT_NOT_READY");
      }

      const pageDetected = Boolean(response.payload && response.payload.isFlowProjectPage);
      setFlowBadge(pageDetected ? "Flow detectado" : "Flow no detectado", pageDetected ? "success" : "error");
      setStatus(pageDetected ? "Listo para enviar un prompt." : "La pestana activa no coincide con un proyecto de Flow.");
      runButton.disabled = !pageDetected;
    } catch (error) {
      setFlowBadge("Content no listo", "error");
      setStatus("La extension no pudo hablar con el content script. Recarga la pagina de Flow.");
      runButton.disabled = false;
    }

    try {
      const state = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.popupInit });
      hydrateFromStoredState(state);
    } catch (error) {
      appendLog("INIT", "warning", "No pude leer el ultimo estado guardado.");
    }
  }

  function hydrateFromStoredState(state) {
    if (!state || !state.session) {
      return;
    }

    const session = state.session;
    if (!Array.isArray(session.logs) || !session.logs.length) {
      return;
    }

    logs = session.logs.slice().reverse().map(function (entry) {
      return {
        step: entry.step || "INIT",
        status: entry.status || "pending",
        message: entry.message || ""
      };
    });
    renderLogs();

    if (session.requestId) {
      setRequestBadge(session.requestId.slice(0, 8));
      copyDiagnosticsButton.disabled = false;
    }
  }

  async function runFlowAutomation() {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      setStatus("Escribe un prompt antes de lanzar la automatizacion.");
      appendLog("INIT", "error", "PROMPT_EMPTY");
      return;
    }

    if (typeof activeTabId !== "number") {
      setStatus("No hay una pestana activa conectada.");
      appendLog("VALIDATE_PAGE", "error", "NO_ACTIVE_TAB");
      return;
    }

    activeRequestId = crypto.randomUUID();
    logs = [];
    renderLogs();
    setRequestBadge(activeRequestId.slice(0, 8));
    copyDiagnosticsButton.disabled = true;
    setStatus("Enviando solicitud al content script...");
    appendLog("INIT", "running", "Solicitud creada.");

    const message = {
      type: MESSAGE_TYPES.run,
      requestId: activeRequestId,
      payload: {
        prompt,
        options: {
          imageIndex: 0,
          downloadResolution: "1K",
          generationTimeoutMs: 120000,
          downloadTimeoutMs: 30000,
          createEnabledTimeoutMs: 10000
        }
      }
    };

    try {
      const response = await chrome.tabs.sendMessage(activeTabId, message);
      if (!response || !response.ok) {
        throw new Error((response && response.error && response.error.code) || "CONTENT_SCRIPT_NOT_READY");
      }
      setStatus("Automatizacion en curso...");
      setFlowBadge("Ejecutando", "running");
    } catch (error) {
      setFlowBadge("Error", "error");
      setStatus("No pude iniciar la automatizacion. Recarga la pagina de Flow y prueba de nuevo.");
      appendLog("INIT", "error", error.message || "MESSAGE_TIMEOUT");
    }
  }

  async function copyDiagnostics() {
    try {
      const state = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.getLastDiagnostics });
      const diagnostics = state && state.diagnostics ? state.diagnostics : null;
      if (!diagnostics) {
        setStatus("Todavia no hay diagnostico para copiar.");
        return;
      }

      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setStatus("Diagnostico copiado al portapapeles.");
      appendLog("DONE", "success", "Diagnostico copiado.");
    } catch (error) {
      setStatus("No pude copiar el diagnostico.");
      appendLog("DONE", "error", error.message || "COPY_DIAGNOSTICS_FAILED");
    }
  }

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || !message.type) {
      return;
    }

    if (activeRequestId && message.requestId && message.requestId !== activeRequestId) {
      return;
    }

    if (message.type === MESSAGE_TYPES.progress) {
      const payload = message.payload || {};
      setStatus(payload.message || "Automatizacion en curso...");
      appendLog(payload.step || "INIT", payload.status || "running", payload.message || "");
      copyDiagnosticsButton.disabled = false;
      return;
    }

    if (message.type === MESSAGE_TYPES.result) {
      const payload = message.payload || {};
      setFlowBadge("Completado", "success");
      setStatus("Generacion y descarga iniciadas correctamente.");
      appendLog("DONE", payload.status || "success", "Imagen seleccionada: " + (payload.selectedMediaId || "sin mediaId"));
      copyDiagnosticsButton.disabled = false;
      return;
    }

    if (message.type === MESSAGE_TYPES.error) {
      const payload = message.payload || {};
      setFlowBadge("Error", "error");
      setStatus(payload.message || "La automatizacion fallo.");
      appendLog(payload.step || "UNEXPECTED_ERROR", "error", payload.code || "UNEXPECTED_ERROR");
      copyDiagnosticsButton.disabled = false;
    }
  });

  runButton.addEventListener("click", runFlowAutomation);
  copyDiagnosticsButton.addEventListener("click", copyDiagnostics);

  initializePopupState();
})();
