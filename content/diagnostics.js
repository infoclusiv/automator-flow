(function () {
  const scope = window.FlowExtension = window.FlowExtension || {};

  const STEPS = {
    INIT: "INIT",
    VALIDATE_PAGE: "VALIDATE_PAGE",
    FIND_PROMPT_EDITOR: "FIND_PROMPT_EDITOR",
    SET_PROMPT: "SET_PROMPT",
    WAIT_CREATE_ENABLED: "WAIT_CREATE_ENABLED",
    CLICK_CREATE: "CLICK_CREATE",
    WAIT_GENERATED_IMAGES: "WAIT_GENERATED_IMAGES",
    SELECT_IMAGE: "SELECT_IMAGE",
    OPEN_IMAGE_MENU: "OPEN_IMAGE_MENU",
    OPEN_DOWNLOAD_SUBMENU: "OPEN_DOWNLOAD_SUBMENU",
    CLICK_1K_ORIGINAL_SIZE: "CLICK_1K_ORIGINAL_SIZE",
    OPEN_ADD_MEDIA: "OPEN_ADD_MEDIA",
    UPLOAD_REFERENCE_IMAGE: "UPLOAD_REFERENCE_IMAGE",
    ACCEPT_UPLOAD_TOS: "ACCEPT_UPLOAD_TOS",
    ADD_REFERENCE_TO_PROMPT: "ADD_REFERENCE_TO_PROMPT",
    DONE: "DONE"
  };

  const ERROR_CODES = {
    NOT_FLOW_PROJECT_PAGE: "NOT_FLOW_PROJECT_PAGE",
    PROMPT_EMPTY: "PROMPT_EMPTY",
    PROMPT_EDITOR_NOT_FOUND: "PROMPT_EDITOR_NOT_FOUND",
    PROMPT_INSERT_FAILED: "PROMPT_INSERT_FAILED",
    CREATE_BUTTON_NOT_FOUND: "CREATE_BUTTON_NOT_FOUND",
    CREATE_BUTTON_DISABLED_TIMEOUT: "CREATE_BUTTON_DISABLED_TIMEOUT",
    CREATE_CLICK_FAILED: "CREATE_CLICK_FAILED",
    CREATE_TRUSTED_CLICK_FAILED: "CREATE_TRUSTED_CLICK_FAILED",
    CREATE_CLICK_NO_EFFECT: "CREATE_CLICK_NO_EFFECT",
    GENERATION_TIMEOUT: "GENERATION_TIMEOUT",
    NO_NEW_GENERATED_IMAGES: "NO_NEW_GENERATED_IMAGES",
    IMAGE_INDEX_OUT_OF_RANGE: "IMAGE_INDEX_OUT_OF_RANGE",
    IMAGE_CARD_NOT_FOUND: "IMAGE_CARD_NOT_FOUND",
    IMAGE_MORE_MENU_NOT_FOUND: "IMAGE_MORE_MENU_NOT_FOUND",
    IMAGE_ACTION_MORE_BUTTON_NOT_FOUND: "IMAGE_ACTION_MORE_BUTTON_NOT_FOUND",
    IMAGE_SELECTION_CLICK_FAILED: "IMAGE_SELECTION_CLICK_FAILED",
    DOWNLOAD_HOVER_FAILED: "DOWNLOAD_HOVER_FAILED",
    DOWNLOAD_NOT_STARTED: "DOWNLOAD_NOT_STARTED",
    DOWNLOAD_MENU_NOT_FOUND: "DOWNLOAD_MENU_NOT_FOUND",
    ORIGINAL_SIZE_OPTION_NOT_FOUND: "ORIGINAL_SIZE_OPTION_NOT_FOUND",
    DOWNLOAD_CLICK_FAILED: "DOWNLOAD_CLICK_FAILED",
    ADD_MEDIA_BUTTON_NOT_FOUND: "ADD_MEDIA_BUTTON_NOT_FOUND",
    PROMPT_COMPOSER_ADD_BUTTON_NOT_FOUND: "PROMPT_COMPOSER_ADD_BUTTON_NOT_FOUND",
    REFERENCE_PANEL_WITH_ADD_TO_PROMPT_NOT_FOUND: "REFERENCE_PANEL_WITH_ADD_TO_PROMPT_NOT_FOUND",
    UPLOAD_MEDIA_BUTTON_NOT_FOUND: "UPLOAD_MEDIA_BUTTON_NOT_FOUND",
    REFERENCE_UPLOAD_MEDIA_BUTTON_NOT_FOUND: "REFERENCE_UPLOAD_MEDIA_BUTTON_NOT_FOUND",
    REFERENCE_FILE_INPUT_NOT_FOUND: "REFERENCE_FILE_INPUT_NOT_FOUND",
    REFERENCE_IMAGE_PATH_INVALID: "REFERENCE_IMAGE_PATH_INVALID",
    FILE_INPUT_SET_FAILED: "FILE_INPUT_SET_FAILED",
    UPLOAD_TOS_ACCEPT_FAILED: "UPLOAD_TOS_ACCEPT_FAILED",
    UPLOADED_REFERENCE_NOT_FOUND: "UPLOADED_REFERENCE_NOT_FOUND",
    REFERENCE_ASSET_NOT_VISIBLE: "REFERENCE_ASSET_NOT_VISIBLE",
    ADD_TO_PROMPT_BUTTON_NOT_FOUND: "ADD_TO_PROMPT_BUTTON_NOT_FOUND",
    ADD_TO_PROMPT_FAILED: "ADD_TO_PROMPT_FAILED",
    REFERENCE_NOT_ATTACHED: "REFERENCE_NOT_ATTACHED",
    UNEXPECTED_ERROR: "UNEXPECTED_ERROR"
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function createRunDiagnostics(context) {
    return {
      requestId: context.requestId,
      startedAt: nowIso(),
      endedAt: null,
      status: "running",
      promptLength: context.prompt ? context.prompt.length : 0,
      currentUrl: location.href,
      steps: [],
      errors: [],
      domSummary: {}
    };
  }

  function recordStep(diagnostics, step, status, message, details) {
    const entry = {
      time: nowIso(),
      step,
      status,
      message,
      details: details || {}
    };
    diagnostics.steps.push(entry);
    return entry;
  }

  function recordError(diagnostics, errorPayload) {
    diagnostics.errors.push({
      time: nowIso(),
      code: errorPayload.code,
      step: errorPayload.step,
      message: errorPayload.message,
      details: errorPayload.details || {}
    });
  }

  function finalizeDiagnostics(diagnostics, status, domSummary) {
    diagnostics.status = status;
    diagnostics.endedAt = nowIso();
    diagnostics.currentUrl = location.href;
    diagnostics.domSummary = domSummary || diagnostics.domSummary || {};
    return diagnostics;
  }

  function makeError(code, step, message, details) {
    const error = new Error(message);
    error.code = code;
    error.step = step;
    error.details = details || {};
    return error;
  }

  function limitText(value, maxLength) {
    if (!value) {
      return "";
    }

    const text = String(value);
    if (text.length <= maxLength) {
      return text;
    }

    return text.slice(0, maxLength) + "...";
  }

  function describeElement(el) {
    if (!el) {
      return null;
    }

    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(el) : null;

    return {
      tag: el.tagName,
      role: el.getAttribute ? el.getAttribute("role") : null,
      ariaLabel: el.getAttribute ? el.getAttribute("aria-label") : null,
      ariaDisabled: el.getAttribute ? el.getAttribute("aria-disabled") : null,
      disabled: el.getAttribute ? el.getAttribute("disabled") : null,
      type: el.getAttribute ? el.getAttribute("type") : null,
      text: limitText((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(), 240),
      pointerEvents: style ? style.pointerEvents : null,
      cursor: style ? style.cursor : null,
      rect: rect ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        centerX: Math.round(rect.left + rect.width / 2),
        centerY: Math.round(rect.top + rect.height / 2)
      } : null
    };
  }

  scope.Diagnostics = {
    STEPS,
    ERROR_CODES,
    createRunDiagnostics,
    recordStep,
    recordError,
    finalizeDiagnostics,
    makeError,
    describeElement,
    limitText
  };
})();
