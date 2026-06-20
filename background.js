const SESSION_STORAGE_KEY = "flowExtensionSessionState";
const DIAGNOSTICS_STORAGE_KEY = "flowExtensionLastDiagnostics";

async function setStoredState(partial) {
  const current = await chrome.storage.local.get([SESSION_STORAGE_KEY, DIAGNOSTICS_STORAGE_KEY]);
  const session = Object.assign({}, current[SESSION_STORAGE_KEY] || {}, partial.session || {});
  const payload = {
    [SESSION_STORAGE_KEY]: session
  };

  if (Object.prototype.hasOwnProperty.call(partial, "diagnostics")) {
    payload[DIAGNOSTICS_STORAGE_KEY] = partial.diagnostics;
  }

  await chrome.storage.local.set(payload);
}

async function getStoredState() {
  const data = await chrome.storage.local.get([SESSION_STORAGE_KEY, DIAGNOSTICS_STORAGE_KEY]);
  return {
    session: data[SESSION_STORAGE_KEY] || null,
    diagnostics: data[DIAGNOSTICS_STORAGE_KEY] || null
  };
}

function broadcastMessage(message) {
  chrome.runtime.sendMessage(message).catch(function () {
    return undefined;
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "FLOW_POPUP_INIT") {
    getStoredState().then(sendResponse);
    return true;
  }

  if (message.type === "FLOW_GET_LAST_DIAGNOSTICS") {
    getStoredState().then(sendResponse);
    return true;
  }

  if (message.type === "FLOW_PROGRESS") {
    const payload = message.payload || {};
    const sessionUpdate = {
      requestId: message.requestId,
      status: payload.status,
      lastStep: payload.step,
      lastMessage: payload.message,
      updatedAt: new Date().toISOString(),
      sourceTabId: sender.tab ? sender.tab.id : null
    };

    getStoredState()
      .then(function (state) {
        const existingLogs = state.session && Array.isArray(state.session.logs) ? state.session.logs : [];
        sessionUpdate.logs = existingLogs.concat([
          {
            time: new Date().toISOString(),
            step: payload.step,
            status: payload.status,
            message: payload.message
          }
        ]).slice(-60);

        return setStoredState({ session: sessionUpdate });
      })
      .then(function () {
        broadcastMessage(message);
      });

    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "FLOW_RESULT") {
    const diagnostics = message.payload && message.payload.diagnostics ? message.payload.diagnostics : null;
    const sessionUpdate = {
      requestId: message.requestId,
      status: "success",
      lastStep: "DONE",
      lastMessage: "Automation finished",
      updatedAt: new Date().toISOString(),
      result: message.payload || null
    };

    getStoredState()
      .then(function (state) {
        const existingLogs = state.session && Array.isArray(state.session.logs) ? state.session.logs : [];
        sessionUpdate.logs = existingLogs.concat([
          {
            time: new Date().toISOString(),
            step: "DONE",
            status: "success",
            message: "Automation finished"
          }
        ]).slice(-60);

        return setStoredState({ session: sessionUpdate, diagnostics });
      })
      .then(function () {
        broadcastMessage(message);
      });

    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "FLOW_ERROR") {
    const payload = message.payload || {};
    const sessionUpdate = {
      requestId: message.requestId,
      status: "error",
      lastStep: payload.step || "UNEXPECTED_ERROR",
      lastMessage: payload.message || "Automation failed",
      updatedAt: new Date().toISOString(),
      error: payload
    };

    getStoredState()
      .then(function (state) {
        const existingLogs = state.session && Array.isArray(state.session.logs) ? state.session.logs : [];
        sessionUpdate.logs = existingLogs.concat([
          {
            time: new Date().toISOString(),
            step: payload.step || "UNEXPECTED_ERROR",
            status: "error",
            message: payload.code || "UNEXPECTED_ERROR"
          }
        ]).slice(-60);

        return setStoredState({ session: sessionUpdate, diagnostics: payload.diagnostics || null });
      })
      .then(function () {
        broadcastMessage(message);
      });

    sendResponse({ ok: true });
    return false;
  }

  return false;
});
