const SESSION_STORAGE_KEY = "flowExtensionSessionState";
const DIAGNOSTICS_STORAGE_KEY = "flowExtensionLastDiagnostics";
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const debuggerSessions = new Map();


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

function getTabSession(tabId) {
  return debuggerSessions.get(String(tabId)) || null;
}

function setTabSession(tabId, session) {
  debuggerSessions.set(String(tabId), session);
}

function clearTabSession(tabId) {
  debuggerSessions.delete(String(tabId));
}

async function prepareDebuggerForTab(tabId, payload) {
  if (!tabId && tabId !== 0) {
    throw makeError("DEBUGGER_TAB_NOT_FOUND", "No active tab id was available for debugger prepare.", {
      tabId
    });
  }

  if (!chrome.debugger || typeof chrome.debugger.attach !== "function") {
    throw makeError("DEBUGGER_API_UNAVAILABLE", "chrome.debugger API is unavailable. Check manifest permissions.", {});
  }

  const target = { tabId };
  const startedAt = Date.now();
  const attachInfo = await attachDebugger(target);

  try {
    await sendDebuggerCommand(target, "Page.bringToFront", {});
  } catch (bringToFrontError) {
    console.warn("FLOW_DEBUGGER_BRING_TO_FRONT_WARNING", bringToFrontError && bringToFrontError.message ? bringToFrontError.message : bringToFrontError);
  }

  const settleMs = Math.max(0, Number(payload && payload.settleMs) || 200);
  await new Promise(function (resolve) {
    setTimeout(resolve, settleMs);
  });

  const session = {
    tabId,
    target,
    attachInfo,
    preparedAt: new Date().toISOString(),
    reason: payload && payload.reason ? payload.reason : null
  };
  setTabSession(tabId, session);

  return {
    ok: true,
    method: "chrome.debugger.prepare",
    tabId,
    attachInfo,
    settleMs,
    durationMs: Date.now() - startedAt
  };
}

async function releaseDebuggerForTab(tabId, reason) {
  const session = getTabSession(tabId);
  const target = { tabId };

  if (!session) {
    return {
      ok: true,
      tabId,
      released: false,
      reason: reason || null,
      message: "No prepared debugger session was registered."
    };
  }

  clearTabSession(tabId);

  if (session.attachInfo && session.attachInfo.attachedNow) {
    const detached = await detachDebugger(target);
    return {
      ok: detached.ok,
      tabId,
      released: true,
      reason: reason || null,
      warning: detached.warning || null
    };
  }

  return {
    ok: true,
    tabId,
    released: false,
    reason: reason || null,
    message: "Debugger was already attached before this prepare call."
  };
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
  const preparedSession = payload && payload.prepared ? getTabSession(tabId) : null;
  let attachInfo = preparedSession ? preparedSession.attachInfo : null;
  let attachedForThisClick = false;
  let detached = null;

  try {
    if (!preparedSession) {
      attachInfo = await attachDebugger(target);
      attachedForThisClick = Boolean(attachInfo && attachInfo.attachedNow);

      if (!(payload && payload.skipBringToFront)) {
        try {
          await sendDebuggerCommand(target, "Page.bringToFront", {});
        } catch (bringToFrontError) {
          console.warn("FLOW_DEBUGGER_BRING_TO_FRONT_WARNING", bringToFrontError && bringToFrontError.message ? bringToFrontError.message : bringToFrontError);
        }

        await new Promise(function (resolve) {
          setTimeout(resolve, 80);
        });
      }
    }

    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      clickCount: 0,
      pointerType: "mouse"
    });

    await new Promise(function (resolve) {
      setTimeout(resolve, 35);
    });

    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse"
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
      clickCount: 1,
      pointerType: "mouse"
    });

    return {
      ok: true,
      method: "chrome.debugger/Input.dispatchMouseEvent",
      tabId,
      x,
      y,
      prepared: Boolean(preparedSession),
      attachInfo,
      durationMs: Date.now() - startedAt
    };
  } finally {
    const detachAfterClick = !(payload && payload.detachAfterClick === false);

    if (detachAfterClick) {
      if (preparedSession) {
        clearTabSession(tabId);
        if (preparedSession.attachInfo && preparedSession.attachInfo.attachedNow) {
          detached = await detachDebugger(target);
        }
      } else if (attachedForThisClick) {
        detached = await detachDebugger(target);
      }
    }

    if (detached && !detached.ok) {
      // Do not fail a successful click only because detach emitted a warning.
      console.warn("FLOW_DEBUGGER_DETACH_WARNING", detached.warning);
    }
  }
}

async function dispatchDebuggerMouseMove(tabId, payload) {
  if (!tabId && tabId !== 0) {
    throw makeError("DEBUGGER_TAB_NOT_FOUND", "No active tab id was available for debugger mouse move.", {
      tabId
    });
  }

  if (!chrome.debugger || typeof chrome.debugger.attach !== "function") {
    throw makeError("DEBUGGER_API_UNAVAILABLE", "chrome.debugger API is unavailable. Check manifest permissions.", {});
  }

  const x = assertFiniteNumber(payload && payload.x, "x");
  const y = assertFiniteNumber(payload && payload.y, "y");
  const target = { tabId };
  const startedAt = Date.now();
  const preparedSession = payload && payload.prepared ? getTabSession(tabId) : null;
  let attachInfo = preparedSession ? preparedSession.attachInfo : null;
  let attachedForThisMove = false;
  let detached = null;

  try {
    if (!preparedSession) {
      attachInfo = await attachDebugger(target);
      attachedForThisMove = Boolean(attachInfo && attachInfo.attachedNow);

      if (!(payload && payload.skipBringToFront)) {
        try {
          await sendDebuggerCommand(target, "Page.bringToFront", {});
        } catch (bringToFrontError) {
          console.warn("FLOW_DEBUGGER_BRING_TO_FRONT_WARNING", bringToFrontError && bringToFrontError.message ? bringToFrontError.message : bringToFrontError);
        }

        await new Promise(function (resolve) {
          setTimeout(resolve, 80);
        });
      }
    }

    await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      clickCount: 0,
      pointerType: "mouse"
    });

    const settleMs = Math.max(0, Number(payload && payload.settleMs) || 0);
    if (settleMs) {
      await new Promise(function (resolve) {
        setTimeout(resolve, settleMs);
      });
    }

    return {
      ok: true,
      method: "chrome.debugger/Input.dispatchMouseEvent.mouseMoved",
      tabId,
      x,
      y,
      prepared: Boolean(preparedSession),
      attachInfo,
      durationMs: Date.now() - startedAt
    };
  } finally {
    const detachAfterMove = Boolean(payload && payload.detachAfterMove === true);

    if (detachAfterMove) {
      if (preparedSession) {
        clearTabSession(tabId);
        if (preparedSession.attachInfo && preparedSession.attachInfo.attachedNow) {
          detached = await detachDebugger(target);
        }
      } else if (attachedForThisMove) {
        detached = await detachDebugger(target);
      }
    } else if (!preparedSession && attachedForThisMove && !(payload && payload.keepAttached)) {
      detached = await detachDebugger(target);
    }

    if (detached && !detached.ok) {
      console.warn("FLOW_DEBUGGER_DETACH_WARNING", detached.warning);
    }
  }
}

async function setDebuggerFileInputFiles(tabId, payload) {
  if (!tabId && tabId !== 0) {
    throw makeError("DEBUGGER_TAB_NOT_FOUND", "No active tab id was available for setting file input files.", {
      tabId
    });
  }

  if (!chrome.debugger || typeof chrome.debugger.attach !== "function") {
    throw makeError("DEBUGGER_API_UNAVAILABLE", "chrome.debugger API is unavailable. Check manifest permissions.", {});
  }

  const files = Array.isArray(payload && payload.files)
    ? payload.files.filter(Boolean).map(String)
    : [payload && payload.filePath].filter(Boolean).map(String);

  if (!files.length) {
    throw makeError("FILE_INPUT_FILES_EMPTY", "No local file paths were provided.", {
      payload
    });
  }

  const selector = payload && payload.selector ? String(payload.selector) : 'input[type="file"]';
  const acceptPattern = payload && payload.acceptPattern ? new RegExp(String(payload.acceptPattern), "i") : /image|video|heic|heif/i;
  const target = { tabId };
  const startedAt = Date.now();
  const preparedSession = payload && payload.prepared ? getTabSession(tabId) : null;
  let attachInfo = preparedSession ? preparedSession.attachInfo : null;
  let attachedForThisAction = false;
  let detached = null;

  try {
    if (!preparedSession) {
      attachInfo = await attachDebugger(target);
      attachedForThisAction = Boolean(attachInfo && attachInfo.attachedNow);

      if (!(payload && payload.skipBringToFront)) {
        try {
          await sendDebuggerCommand(target, "Page.bringToFront", {});
        } catch (bringToFrontError) {
          console.warn("FLOW_DEBUGGER_BRING_TO_FRONT_WARNING", bringToFrontError && bringToFrontError.message ? bringToFrontError.message : bringToFrontError);
        }
      }
    }

    try {
      await sendDebuggerCommand(target, "DOM.enable", {});
    } catch (domEnableError) {
      console.warn("FLOW_DEBUGGER_DOM_ENABLE_WARNING", domEnableError && domEnableError.message ? domEnableError.message : domEnableError);
    }

    const documentResult = await sendDebuggerCommand(target, "DOM.getDocument", {
      depth: -1,
      pierce: true
    });

    const rootNodeId = documentResult && documentResult.root ? documentResult.root.nodeId : null;
    if (!rootNodeId) {
      throw makeError("DOM_ROOT_NOT_FOUND", "Could not read the DOM root node through CDP.", {
        documentResult
      });
    }

    const queryResult = await sendDebuggerCommand(target, "DOM.querySelectorAll", {
      nodeId: rootNodeId,
      selector
    });

    const nodeIds = queryResult && Array.isArray(queryResult.nodeIds) ? queryResult.nodeIds : [];
    if (!nodeIds.length) {
      throw makeError("FILE_INPUT_NOT_FOUND", "No file input was found in the page DOM.", {
        selector,
        files
      });
    }

    const candidates = [];
    for (let index = 0; index < nodeIds.length; index += 1) {
      const nodeId = nodeIds[index];
      let attributes = [];
      try {
        const attrResult = await sendDebuggerCommand(target, "DOM.getAttributes", { nodeId });
        attributes = attrResult && Array.isArray(attrResult.attributes) ? attrResult.attributes : [];
      } catch (error) {
        attributes = [];
      }

      const attrMap = {};
      for (let attrIndex = 0; attrIndex < attributes.length; attrIndex += 2) {
        attrMap[attributes[attrIndex]] = attributes[attrIndex + 1] || "";
      }

      const accept = attrMap.accept || "";
      let score = index;
      if (acceptPattern.test(accept)) {
        score += 1000;
      }
      if (/image/i.test(accept)) {
        score += 500;
      }
      if (/video/i.test(accept)) {
        score += 100;
      }
      if (Object.prototype.hasOwnProperty.call(attrMap, "multiple")) {
        score += 25;
      }

      candidates.push({
        nodeId,
        attributes: attrMap,
        score
      });
    }

    candidates.sort(function (a, b) {
      return b.score - a.score;
    });

    const selected = candidates[0];
    await sendDebuggerCommand(target, "DOM.setFileInputFiles", {
      nodeId: selected.nodeId,
      files
    });

    const settleMs = Math.max(0, Number(payload && payload.settleMs) || 500);
    if (settleMs) {
      await new Promise(function (resolve) {
        setTimeout(resolve, settleMs);
      });
    }

    return {
      ok: true,
      method: "chrome.debugger/DOM.setFileInputFiles",
      tabId,
      selector,
      files,
      selected,
      candidates,
      prepared: Boolean(preparedSession),
      attachInfo,
      durationMs: Date.now() - startedAt
    };
  } finally {
    const detachAfterSet = Boolean(payload && payload.detachAfterSet === true);

    if (detachAfterSet) {
      if (preparedSession) {
        clearTabSession(tabId);
        if (preparedSession.attachInfo && preparedSession.attachInfo.attachedNow) {
          detached = await detachDebugger(target);
        }
      } else if (attachedForThisAction) {
        detached = await detachDebugger(target);
      }
    } else if (!preparedSession && attachedForThisAction && !(payload && payload.keepAttached)) {
      detached = await detachDebugger(target);
    }

    if (detached && !detached.ok) {
      console.warn("FLOW_DEBUGGER_DETACH_WARNING", detached.warning);
    }
  }
}

function searchDownloads(payload) {
  return new Promise(function (resolve, reject) {
    if (!chrome.downloads || typeof chrome.downloads.search !== "function") {
      reject(makeError("DOWNLOADS_API_UNAVAILABLE", "chrome.downloads API is unavailable. Check manifest permissions.", {}));
      return;
    }

    const query = {
      limit: Math.max(1, Number(payload && payload.limit) || 10),
      orderBy: ["-startTime"]
    };

    if (payload && payload.startedAfter) {
      query.startedAfter = payload.startedAfter;
    }

    chrome.downloads.search(query, function (items) {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(makeError("DOWNLOADS_SEARCH_FAILED", lastError.message || String(lastError), {
          query
        }));
        return;
      }

      resolve({
        ok: true,
        query,
        items: (items || []).map(function (item) {
          return {
            id: item.id,
            url: item.url,
            finalUrl: item.finalUrl,
            filename: item.filename,
            mime: item.mime,
            state: item.state,
            paused: item.paused,
            danger: item.danger,
            startTime: item.startTime,
            endTime: item.endTime,
            fileSize: item.fileSize,
            totalBytes: item.totalBytes,
            exists: item.exists
          };
        })
      });
    });
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

  if (message.type === "FLOW_DEBUGGER_PREPARE") {
    const tabId = sender && sender.tab ? sender.tab.id : null;

    prepareDebuggerForTab(tabId, message.payload || {})
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
            code: error && error.code ? error.code : "DEBUGGER_PREPARE_FAILED",
            message: error && error.message ? error.message : "Debugger prepare failed.",
            details: error && error.details ? error.details : {}
          }
        });
      });

    return true;
  }

  if (message.type === "FLOW_DEBUGGER_RELEASE") {
    const tabId = sender && sender.tab ? sender.tab.id : null;

    releaseDebuggerForTab(tabId, message.payload && message.payload.reason ? message.payload.reason : null)
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
            code: error && error.code ? error.code : "DEBUGGER_RELEASE_FAILED",
            message: error && error.message ? error.message : "Debugger release failed.",
            details: error && error.details ? error.details : {}
          }
        });
      });

    return true;
  }

  if (message.type === "FLOW_DEBUGGER_MOUSE_MOVE") {
    const tabId = sender && sender.tab ? sender.tab.id : null;

    dispatchDebuggerMouseMove(tabId, message.payload || {})
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
            code: error && error.code ? error.code : "DEBUGGER_MOUSE_MOVE_FAILED",
            message: error && error.message ? error.message : "Debugger mouse move failed.",
            details: error && error.details ? error.details : {}
          }
        });
      });

    return true;
  }


  if (message.type === "FLOW_DEBUGGER_SET_FILE_INPUT_FILES") {
    const tabId = sender && sender.tab ? sender.tab.id : null;

    setDebuggerFileInputFiles(tabId, message.payload || {})
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
            code: error && error.code ? error.code : "FILE_INPUT_SET_FAILED",
            message: error && error.message ? error.message : "Setting file input files failed.",
            details: error && error.details ? error.details : {}
          }
        });
      });

    return true;
  }

  if (message.type === "FLOW_DOWNLOADS_SEARCH") {
    searchDownloads(message.payload || {})
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
            code: error && error.code ? error.code : "DOWNLOADS_SEARCH_FAILED",
            message: error && error.message ? error.message : "Downloads search failed.",
            details: error && error.details ? error.details : {}
          }
        });
      });

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
