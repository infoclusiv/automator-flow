const SESSION_STORAGE_KEY = "flowExtensionSessionState";
const DIAGNOSTICS_STORAGE_KEY = "flowExtensionLastDiagnostics";
const DEBUGGER_PROTOCOL_VERSION = "1.3";

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

function makeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details || {};
  return error;
}

function attachDebugger(target) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, function () {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        const message = lastError.message || String(lastError);

        // If a previous attempt from this extension left the debugger attached,
        // try to keep going. If another debugger owns it, sendCommand will fail
        // and the caller will return a structured diagnostic.
        if (/Another debugger is already attached/i.test(message)) {
          resolve({ attachedNow: false, alreadyAttached: true, warning: message });
          return;
        }

        reject(makeError("DEBUGGER_ATTACH_FAILED", message, { target }));
        return;
      }

      resolve({ attachedNow: true, alreadyAttached: false });
    });
  });
}

function detachDebugger(target) {
  return new Promise(function (resolve) {
    chrome.debugger.detach(target, function () {
      resolve({
        ok: !chrome.runtime.lastError,
        warning: chrome.runtime.lastError ? chrome.runtime.lastError.message : null
      });
    });
  });
}

function sendDebuggerCommand(target, method, params) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.sendCommand(target, method, params || {}, function (result) {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(makeError("DEBUGGER_COMMAND_FAILED", lastError.message || String(lastError), {
          method,
          params
        }));
        return;
      }

      resolve(result || {});
    });
  });
}

function assertFiniteNumber(value, name) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw makeError("INVALID_DEBUGGER_CLICK_COORDINATE", "Invalid debugger click coordinate: " + name, {
      name,
      value
    });
  }

  return numberValue;
}

async function dispatchDebuggerMouseClick(tabId, payload) {
  if (!tabId && tabId !== 0) {
    throw makeError("DEBUGGER_TAB_NOT_FOUND", "No active tab id was available for debugger click.", {
      tabId
    });
  }

  if (!chrome.debugger || typeof chrome.debugger.attach !== "function") {
    throw makeError("DEBUGGER_API_UNAVAILABLE", "chrome.debugger API is unavailable. Check manifest permissions.", {});
  }

  const x = assertFiniteNumber(payload && payload.x, "x");
  const y = assertFiniteNumber(payload && payload.y, "y");
  const delayMs = Math.max(0, Number(payload && payload.delayMs) || 80);
  const target = { tabId };
  const startedAt = Date.now();
  let attachInfo = null;
  let detached = null;

  try {
    attachInfo = await attachDebugger(target);

    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      clickCount: 0
    });

    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });

    await new Promise(function (resolve) {
      setTimeout(resolve, delayMs);
    });

    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });

    return {
      ok: true,
      method: "chrome.debugger/Input.dispatchMouseEvent",
      tabId,
      x,
      y,
      attachInfo,
      durationMs: Date.now() - startedAt
    };
  } finally {
    if (attachInfo && attachInfo.attachedNow) {
      detached = await detachDebugger(target);
    }

    if (detached && !detached.ok) {
      // Do not fail a successful click only because detach emitted a warning.
      console.warn("FLOW_DEBUGGER_DETACH_WARNING", detached.warning);
    }
  }
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

  if (message.type === "FLOW_DEBUGGER_CLICK") {
    const tabId = sender && sender.tab ? sender.tab.id : null;

    dispatchDebuggerMouseClick(tabId, message.payload || {})
      .then(function (result) {
        sendResponse({
          ok: true,
          payload: result
        });
      })
      .catch(function (error) {
        sendResponse({
          ok: false,
          error: {
            code: error && error.code ? error.code : "DEBUGGER_CLICK_FAILED",
            message: error && error.message ? error.message : "Debugger click failed.",
            details: error && error.details ? error.details : {}
          }
        });
      });

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
