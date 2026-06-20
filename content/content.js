(function () {
  const scope = window.FlowExtension = window.FlowExtension || {};
  const FlowAutomation = scope.FlowAutomation;
  const Diagnostics = scope.Diagnostics;

  let isRunning = false;

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === "FLOW_PING") {
      sendResponse({
        ok: true,
        payload: {
          currentUrl: location.href,
          isFlowProjectPage: FlowAutomation.FLOW_PAGE_REGEX.test(location.href)
        }
      });
      return false;
    }

    if (message.type === "FLOW_RUN_GENERATE_AND_DOWNLOAD") {
      if (isRunning) {
        sendResponse({
          ok: false,
          error: {
            code: Diagnostics.ERROR_CODES.UNEXPECTED_ERROR,
            message: "Ya hay una automatizacion en curso."
          }
        });
        return false;
      }

      isRunning = true;
      const requestId = message.requestId || crypto.randomUUID();
      const payload = message.payload || {};

      Promise.resolve()
        .then(function () {
          return FlowAutomation.runGenerateAndDownload({
            requestId,
            prompt: payload.prompt || "",
            options: Object.assign({
              imageIndex: 0,
              downloadResolution: "1K",
              generationTimeoutMs: 120000,
              downloadTimeoutMs: 3000,
              createEnabledTimeoutMs: 10000
            }, payload.options || {})
          });
        })
        .catch(function (error) {
          if (error && error.code) {
            return;
          }

          const diagnostics = scope.FlowAutomation.buildDomSummary();
          chrome.runtime.sendMessage({
            type: "FLOW_ERROR",
            requestId,
            payload: {
              code: Diagnostics.ERROR_CODES.UNEXPECTED_ERROR,
              step: Diagnostics.STEPS.DONE,
              message: error && error.message ? error.message : "Ocurrio un error inesperado.",
              details: {},
              diagnostics: {
                requestId,
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                status: "error",
                promptLength: String(payload.prompt || "").length,
                currentUrl: location.href,
                steps: [],
                errors: [],
                domSummary: diagnostics
              }
            }
          });
        })
        .finally(function () {
          isRunning = false;
        });

      sendResponse({ ok: true, accepted: true, requestId });
      return false;
    }

    return false;
  });
})();
