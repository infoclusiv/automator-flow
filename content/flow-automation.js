(function () {
  const scope = window.FlowExtension = window.FlowExtension || {};
  const Diagnostics = scope.Diagnostics;
  const DomUtils = scope.DomUtils;
  const FlowSelectors = scope.FlowSelectors;

  const FLOW_PAGE_REGEX = /^https:\/\/labs\.google\/fx\/tools\/flow\/project\/.+/i;

  function normalizePromptComparison(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function buildDomSummary() {
    const promptEditor = FlowSelectors.findPromptEditor();
    const createButton = FlowSelectors.findCreateButton();
    const images = FlowSelectors.findGeneratedImages();
    const menuItems = DomUtils.queryVisibleAll('[role="menuitem"], button[role="menuitem"]');

    return {
      promptEditorFound: Boolean(promptEditor),
      createButtonFound: Boolean(createButton),
      generatedImagesCount: images.length,
      mediaIds: images
        .map(function (img) {
          return DomUtils.getMediaIdFromUrl(img.getAttribute("src") || "");
        })
        .filter(Boolean),
      visibleMenuItems: menuItems.map(Diagnostics.describeElement).slice(0, 12),
      bodyTextPreview: Diagnostics.limitText((document.body.innerText || "").replace(/\s+/g, " ").trim(), 1500),
      currentUrl: location.href
    };
  }

  function createAutomationContext(config) {
    const diagnostics = Diagnostics.createRunDiagnostics({
      requestId: config.requestId,
      prompt: config.prompt
    });

    async function emitProgress(step, status, message, details) {
      Diagnostics.recordStep(diagnostics, step, status, message, details);
      await chrome.runtime.sendMessage({
        type: "FLOW_PROGRESS",
        requestId: config.requestId,
        payload: {
          step,
          status,
          message,
          details: details || {}
        }
      });
    }

    async function throwStructuredError(code, step, message, details) {
      const diagnosticsPayload = Diagnostics.finalizeDiagnostics(diagnostics, "error", buildDomSummary());
      const payload = {
        code,
        step,
        message,
        details: details || {},
        diagnostics: diagnosticsPayload
      };

      Diagnostics.recordError(diagnostics, payload);

      await chrome.runtime.sendMessage({
        type: "FLOW_ERROR",
        requestId: config.requestId,
        payload
      });

      throw Diagnostics.makeError(code, step, message, details);
    }

    return {
      config,
      diagnostics,
      emitProgress,
      throwStructuredError
    };
  }

  async function validatePage(ctx) {
    await ctx.emitProgress(Diagnostics.STEPS.VALIDATE_PAGE, "running", "Validando pagina activa...");
    const isFlowProjectPage = FLOW_PAGE_REGEX.test(location.href);
    const details = {
      url: location.href,
      isFlowProjectPage
    };

    if (!isFlowProjectPage) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.NOT_FLOW_PROJECT_PAGE,
        Diagnostics.STEPS.VALIDATE_PAGE,
        "Abre primero un proyecto de Google Flow.",
        details
      );
    }

    await ctx.emitProgress(Diagnostics.STEPS.VALIDATE_PAGE, "success", "Pagina de Flow detectada.", details);
  }

  async function setPrompt(ctx, prompt) {
    await ctx.emitProgress(Diagnostics.STEPS.FIND_PROMPT_EDITOR, "running", "Buscando editor de prompt...");
    const editor = FlowSelectors.findPromptEditor();
    if (!editor) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.PROMPT_EDITOR_NOT_FOUND,
        Diagnostics.STEPS.FIND_PROMPT_EDITOR,
        "No encontre el editor de prompt de Flow.",
        { selector: FlowSelectors.SELECTORS.promptEditor }
      );
    }

    await ctx.emitProgress(Diagnostics.STEPS.FIND_PROMPT_EDITOR, "success", "Editor encontrado.", {
      selector: FlowSelectors.SELECTORS.promptEditor,
      editor: Diagnostics.describeElement(editor)
    });

    await ctx.emitProgress(Diagnostics.STEPS.SET_PROMPT, "running", "Insertando prompt...");
    DomUtils.scrollIntoViewCentered(editor);
    await DomUtils.clickElement(editor);
    editor.focus();
    await DomUtils.sleep(80);

    DomUtils.selectAllTextInElement(editor);
    try {
      document.execCommand("delete", false);
    } catch (error) {
      editor.textContent = "";
    }

    let execSucceeded = false;
    try {
      execSucceeded = document.execCommand("insertText", false, prompt);
    } catch (error) {
      execSucceeded = false;
    }

    if (!execSucceeded) {
      editor.textContent = prompt;
      DomUtils.dispatchInputEvents(editor, "insertText", prompt);
    } else {
      DomUtils.dispatchInputEvents(editor, "insertText", prompt);
    }

    await DomUtils.sleep(150);

    const editorTextAfterInsert = normalizePromptComparison(editor.innerText || editor.textContent || "");
    const expectedText = normalizePromptComparison(prompt);

    if (!editorTextAfterInsert || editorTextAfterInsert.indexOf(expectedText) === -1) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.PROMPT_INSERT_FAILED,
        Diagnostics.STEPS.SET_PROMPT,
        "No pude confirmar que el prompt quedo insertado en el editor.",
        {
          promptLength: prompt.length,
          editorTextAfterInsert,
          expectedText
        }
      );
    }

    await ctx.emitProgress(Diagnostics.STEPS.SET_PROMPT, "success", "Prompt insertado.", {
      promptLength: prompt.length,
      editorTextAfterInsert
    });

    return editor;
  }

  async function waitForCreateEnabled(ctx, timeoutMs) {
    await ctx.emitProgress(Diagnostics.STEPS.WAIT_CREATE_ENABLED, "running", "Esperando que Create se habilite...");
    const startedAt = Date.now();
    let lastAriaDisabled = null;
    let lastDisabled = null;

    try {
      const button = await DomUtils.waitFor(function () {
        const candidate = FlowSelectors.findCreateButton();
        if (!candidate) {
          return false;
        }

        lastAriaDisabled = candidate.getAttribute("aria-disabled");
        lastDisabled = candidate.getAttribute("disabled");
        const isEnabled = lastDisabled === null && lastAriaDisabled !== "true";
        if (isEnabled) {
          return candidate;
        }

        return false;
      }, {
        timeoutMs: timeoutMs || 10000,
        intervalMs: 250,
        description: "enabled Create button"
      });

      await ctx.emitProgress(Diagnostics.STEPS.WAIT_CREATE_ENABLED, "success", "Create habilitado.", {
        createButtonFound: true,
        ariaDisabled: button.getAttribute("aria-disabled"),
        disabled: button.getAttribute("disabled"),
        durationMs: Date.now() - startedAt
      });

      return button;
    } catch (error) {
      const existingButton = FlowSelectors.findCreateButton();
      const code = existingButton ? Diagnostics.ERROR_CODES.CREATE_BUTTON_DISABLED_TIMEOUT : Diagnostics.ERROR_CODES.CREATE_BUTTON_NOT_FOUND;
      const message = existingButton
        ? "El boton Create no se habilito despues de insertar el prompt."
        : "No encontre el boton Create.";

      await ctx.throwStructuredError(code, Diagnostics.STEPS.WAIT_CREATE_ENABLED, message, {
        createButtonFound: Boolean(existingButton),
        ariaDisabled: lastAriaDisabled,
        disabled: lastDisabled,
        durationMs: Date.now() - startedAt
      });
    }
  }

  function getViewportInfo() {
    const visualViewport = window.visualViewport ? {
      width: Math.round(window.visualViewport.width),
      height: Math.round(window.visualViewport.height),
      offsetLeft: Math.round(window.visualViewport.offsetLeft || 0),
      offsetTop: Math.round(window.visualViewport.offsetTop || 0),
      scale: window.visualViewport.scale || 1
    } : null;

    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: Math.round(window.scrollX || 0),
      scrollY: Math.round(window.scrollY || 0),
      visualViewport
    };
  }

  function getElementRect(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left),
      centerX: Math.round(rect.left + rect.width / 2),
      centerY: Math.round(rect.top + rect.height / 2)
    };
  }

  function isPointInViewport(x, y) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    return x >= 0 && y >= 0 && x < viewportWidth && y < viewportHeight;
  }

  function buildCandidatePoints(el) {
    const rect = el.getBoundingClientRect();
    const specs = [
      [0.5, 0.5],
      [0.5, 0.4],
      [0.5, 0.6],
      [0.35, 0.5],
      [0.65, 0.5],
      [0.25, 0.5],
      [0.75, 0.5]
    ];

    return specs.map(function (spec) {
      return {
        x: Math.round(rect.left + rect.width * spec[0]),
        y: Math.round(rect.top + rect.height * spec[1]),
        ratioX: spec[0],
        ratioY: spec[1]
      };
    });
  }

  function describePointHit(button, point) {
    if (!point || !isPointInViewport(point.x, point.y)) {
      return {
        point,
        pointInViewport: false,
        elementAtPoint: null,
        elementAtPointIsCreateButton: false
      };
    }

    const elementAtPoint = document.elementFromPoint(point.x, point.y);
    return {
      point,
      pointInViewport: true,
      elementAtPoint: Diagnostics.describeElement(elementAtPoint),
      elementAtPointIsCreateButton: Boolean(elementAtPoint && (elementAtPoint === button || button.contains(elementAtPoint)))
    };
  }

  function getBestCreateClickTarget(preferredButton) {
    const candidates = [];
    const seen = new Set();

    function addCandidate(button) {
      if (!button || seen.has(button)) {
        return;
      }
      seen.add(button);
      candidates.push(button);
    }

    addCandidate(preferredButton);
    FlowSelectors.findCreateButtons().forEach(addCandidate);

    const inspected = candidates.map(function (button) {
      const rect = getElementRect(button);
      const points = buildCandidatePoints(button).map(function (point) {
        return describePointHit(button, point);
      });
      const hit = points.find(function (item) {
        return item.elementAtPointIsCreateButton;
      }) || null;

      return {
        button,
        buttonDescription: Diagnostics.describeElement(button),
        rect,
        points,
        hit,
        inViewport: FlowSelectors.isInViewport ? FlowSelectors.isInViewport(button) : true
      };
    });

    const usable = inspected.find(function (item) {
      return item.hit && item.hit.elementAtPointIsCreateButton;
    });

    if (usable) {
      return {
        ok: true,
        button: usable.button,
        point: usable.hit.point,
        rect: usable.rect,
        elementAtPoint: usable.hit.elementAtPoint,
        elementAtPointIsCreateButton: true,
        inspected: inspected.map(function (item) {
          return {
            button: item.buttonDescription,
            rect: item.rect,
            inViewport: item.inViewport,
            usablePoint: item.hit ? item.hit.point : null,
            elementAtUsablePoint: item.hit ? item.hit.elementAtPoint : null,
            points: item.points
          };
        })
      };
    }

    return {
      ok: false,
      button: candidates[0] || null,
      point: inspected[0] && inspected[0].points[0] ? inspected[0].points[0].point : null,
      rect: inspected[0] ? inspected[0].rect : null,
      elementAtPoint: inspected[0] && inspected[0].points[0] ? inspected[0].points[0].elementAtPoint : null,
      elementAtPointIsCreateButton: false,
      inspected: inspected.map(function (item) {
        return {
          button: item.buttonDescription,
          rect: item.rect,
          inViewport: item.inViewport,
          usablePoint: item.hit ? item.hit.point : null,
          elementAtUsablePoint: item.hit ? item.hit.elementAtPoint : null,
          points: item.points
        };
      })
    };
  }

  function makeTargetKey(target) {
    if (!target || !target.point || !target.rect) {
      return "missing";
    }

    return [
      target.point.x,
      target.point.y,
      target.rect.x,
      target.rect.y,
      target.rect.width,
      target.rect.height,
      window.innerWidth || document.documentElement.clientWidth || 0,
      window.innerHeight || document.documentElement.clientHeight || 0
    ].join(":");
  }

  function summarizeFreshSample(target) {
    if (!target) {
      return null;
    }

    return {
      ok: Boolean(target.ok),
      point: target.point || null,
      rect: target.rect || null,
      elementAtPoint: target.elementAtPoint || null,
      elementAtPointIsCreateButton: Boolean(target.elementAtPointIsCreateButton),
      viewport: getViewportInfo(),
      inspected: target.inspected || []
    };
  }

  function waitForAnimationFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        resolve();
      });
    });
  }

  async function waitForLayoutFrames(frameCount) {
    const count = Math.max(1, Number(frameCount) || 1);
    for (let index = 0; index < count; index += 1) {
      await waitForAnimationFrame();
    }
  }

  async function waitForFreshStableCreateClickTarget(options) {
    const startedAt = Date.now();
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 4000;
    const intervalMs = options && options.intervalMs ? options.intervalMs : 90;
    const requiredStableSamples = options && options.requiredStableSamples ? options.requiredStableSamples : 4;
    const samples = [];
    let lastKey = null;
    let stableCount = 0;
    let lastTarget = null;

    // Let Flow finish any immediate reflow caused by prompt insertion, focus,
    // debugger attach, browser resizing, or floating prompt bar movement.
    await waitForLayoutFrames(2);

    while (Date.now() - startedAt < timeoutMs) {
      // Critical rule: always locate the button again immediately before taking
      // a coordinate sample. Never trust a button reference or rectangle captured
      // before a scroll, resize, focus change, debugger attach, or layout shift.
      const freshButton = FlowSelectors.findCreateButton();
      const target = getBestCreateClickTarget(freshButton);
      lastTarget = target;

      const sample = {
        time: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        key: target && target.ok ? makeTargetKey(target) : "not-hittable",
        target: summarizeFreshSample(target)
      };
      samples.push(sample);

      if (target && target.ok) {
        if (sample.key === lastKey) {
          stableCount += 1;
        } else {
          lastKey = sample.key;
          stableCount = 1;
        }

        if (stableCount >= requiredStableSamples) {
          // One final fresh re-read after stability is reached. This is the
          // actual coordinate that will be sent to chrome.debugger.
          await waitForLayoutFrames(1);
          const finalButton = FlowSelectors.findCreateButton();
          const finalTarget = getBestCreateClickTarget(finalButton);
          const finalKey = finalTarget && finalTarget.ok ? makeTargetKey(finalTarget) : "not-hittable";

          if (finalTarget && finalTarget.ok && finalKey === sample.key) {
            finalTarget.freshCoordinatePolicy = "requery-button-before-each-sample-and-final-reread-before-click";
            finalTarget.stableSamples = stableCount;
            finalTarget.requiredStableSamples = requiredStableSamples;
            finalTarget.durationMs = Date.now() - startedAt;
            finalTarget.samples = samples.slice(-12);
            finalTarget.finalKey = finalKey;
            finalTarget.viewport = getViewportInfo();
            return finalTarget;
          }

          samples.push({
            time: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt,
            key: finalKey,
            rejectedFinalReread: true,
            target: summarizeFreshSample(finalTarget)
          });

          lastKey = finalKey;
          stableCount = finalTarget && finalTarget.ok ? 1 : 0;
        }
      } else {
        stableCount = 0;
        lastKey = null;
      }

      await DomUtils.sleep(intervalMs);
    }

    if (lastTarget) {
      lastTarget.freshCoordinatePolicy = "failed-to-find-stable-fresh-coordinate";
      lastTarget.stableSamples = stableCount;
      lastTarget.requiredStableSamples = requiredStableSamples;
      lastTarget.durationMs = Date.now() - startedAt;
      lastTarget.samples = samples.slice(-20);
      lastTarget.viewport = getViewportInfo();
    }

    return lastTarget;
  }

  async function prepareDebuggerForFreshCoordinates() {
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_DEBUGGER_PREPARE",
      payload: {
        settleMs: 250,
        reason: "prepare-before-fresh-create-coordinate-measurement",
        viewport: getViewportInfo()
      }
    });

    if (!response || !response.ok) {
      const error = new Error(response && response.error && response.error.message ? response.error.message : "Debugger prepare failed.");
      error.code = response && response.error && response.error.code ? response.error.code : "DEBUGGER_PREPARE_FAILED";
      error.details = response && response.error && response.error.details ? response.error.details : { response };
      throw error;
    }

    return response;
  }

  async function releaseDebuggerAfterFailedMeasurement(reason) {
    try {
      await chrome.runtime.sendMessage({
        type: "FLOW_DEBUGGER_RELEASE",
        payload: {
          reason: reason || "release-after-failed-fresh-coordinate-measurement"
        }
      });
    } catch (error) {
      // Best effort only. The real failure is reported by the caller.
    }
  }

  function findStopButton() {
    return DomUtils.findVisibleByText("button,[role='button']", /(?:stop\s*)?Stop/i)[0] || null;
  }

  function getPromptEditorText() {
    const editor = FlowSelectors.findPromptEditor();
    return normalizePromptComparison(editor ? (editor.innerText || editor.textContent || "") : "");
  }

  function collectCreateEffectSignals(prompt, beforeMediaIds) {
    const createButton = FlowSelectors.findCreateButton();
    const stopButton = findStopButton();
    const editorText = getPromptEditorText();
    const bodyText = normalizePromptComparison(document.body.innerText || "");
    const currentMediaIds = FlowSelectors.getCurrentGeneratedMediaIds();
    const beforeSet = new Set(beforeMediaIds || []);
    const newMediaIds = currentMediaIds.filter(function (mediaId) {
      return !beforeSet.has(mediaId);
    });

    const promptStillInEditor = prompt ? editorText.indexOf(normalizePromptComparison(prompt)) !== -1 : false;
    const editorLooksCleared = !promptStillInEditor && (
      !editorText ||
      /what do you want to create\?/i.test(editorText)
    );

    const signals = {
      stopButtonFound: Boolean(stopButton),
      createButtonFound: Boolean(createButton),
      createButton: Diagnostics.describeElement(createButton),
      stopButton: Diagnostics.describeElement(stopButton),
      editorText,
      promptStillInEditor,
      editorLooksCleared,
      currentMediaIds,
      newMediaIds,
      bodyHasStop: /\bstop\b/i.test(bodyText),
      bodyHasGeneratingSignal: /(?:stop|generating|creating|thinking|cancel)/i.test(bodyText)
    };

    signals.started = Boolean(
      signals.stopButtonFound ||
      signals.editorLooksCleared ||
      signals.newMediaIds.length ||
      (!signals.createButtonFound && signals.bodyHasGeneratingSignal)
    );

    return signals;
  }

  async function waitForCreateEffect(prompt, beforeMediaIds, timeoutMs) {
    const startedAt = Date.now();
    let lastSignals = null;

    while (Date.now() - startedAt < (timeoutMs || 5000)) {
      lastSignals = collectCreateEffectSignals(prompt, beforeMediaIds);

      if (lastSignals.started) {
        lastSignals.durationMs = Date.now() - startedAt;
        return lastSignals;
      }

      await DomUtils.sleep(250);
    }

    lastSignals = collectCreateEffectSignals(prompt, beforeMediaIds);
    lastSignals.durationMs = Date.now() - startedAt;
    return lastSignals;
  }

  async function requestDebuggerClick() {
    const prepareResponse = await prepareDebuggerForFreshCoordinates();

    // Recompute fresh coordinates only AFTER debugger attach / bringToFront.
    // This avoids stale coordinates when Chrome or Flow shifts the viewport.
    const target = await waitForFreshStableCreateClickTarget({
      timeoutMs: 4500,
      intervalMs: 90,
      requiredStableSamples: 4
    });

    if (!target || !target.ok || !target.point) {
      await releaseDebuggerAfterFailedMeasurement("stable-create-coordinate-not-found");
      const error = new Error("No stable fresh viewport coordinate was found for the Create button.");
      error.code = "CREATE_CLICK_TARGET_UNSTABLE";
      error.details = {
        prepareResponse,
        target,
        viewport: getViewportInfo()
      };
      throw error;
    }

    // Absolute final check immediately before sending the click.
    const finalTarget = getBestCreateClickTarget(FlowSelectors.findCreateButton());
    if (!finalTarget || !finalTarget.ok || makeTargetKey(finalTarget) !== makeTargetKey(target)) {
      await releaseDebuggerAfterFailedMeasurement("fresh-coordinate-changed-before-click");
      const error = new Error("Create button coordinates changed immediately before click.");
      error.code = "CREATE_CLICK_TARGET_CHANGED_BEFORE_CLICK";
      error.details = {
        prepareResponse,
        stableTarget: target,
        finalTarget,
        stableKey: makeTargetKey(target),
        finalKey: makeTargetKey(finalTarget),
        viewport: getViewportInfo()
      };
      throw error;
    }

    const response = await chrome.runtime.sendMessage({
      type: "FLOW_DEBUGGER_CLICK",
      payload: {
        x: finalTarget.point.x,
        y: finalTarget.point.y,
        delayMs: 120,
        prepared: true,
        skipBringToFront: true,
        detachAfterClick: true,
        targetElement: Diagnostics.describeElement(finalTarget.button),
        elementAtPoint: finalTarget.elementAtPoint,
        viewport: getViewportInfo(),
        freshCoordinatePolicy: "prepared-debugger-then-requery-stable-final-coordinate"
      }
    });

    await DomUtils.sleep(200);
    const postClickTarget = getBestCreateClickTarget(FlowSelectors.findCreateButton());

    return {
      response,
      prepareResponse,
      point: finalTarget.point,
      target,
      preClickTarget: finalTarget,
      postClickTarget,
      elementAtPoint: finalTarget.elementAtPoint,
      elementAtPointIsCreateButton: finalTarget.elementAtPointIsCreateButton,
      viewport: getViewportInfo(),
      freshCoordinatePolicy: "prepared-debugger-then-requery-stable-final-coordinate"
    };
  }

  async function clickCreate(ctx, createButton, prompt) {
    await ctx.emitProgress(Diagnostics.STEPS.CLICK_CREATE, "running", "Haciendo click real en Create...");
    const beforeMediaIds = FlowSelectors.getCurrentGeneratedMediaIds();
    const attempts = [];
    const beforeState = {
      beforeMediaIds,
      createButton: Diagnostics.describeElement(createButton),
      editorText: getPromptEditorText()
    };

    let lastSignals = null;

    try {
      const debuggerAttempt = await requestDebuggerClick();
      attempts.push({
        method: "chrome.debugger/Input.dispatchMouseEvent",
        ok: Boolean(debuggerAttempt.response && debuggerAttempt.response.ok),
        response: debuggerAttempt.response,
        point: debuggerAttempt.point,
        elementAtPoint: debuggerAttempt.elementAtPoint,
        elementAtPointIsCreateButton: debuggerAttempt.elementAtPointIsCreateButton,
        target: debuggerAttempt.target,
        preClickTarget: debuggerAttempt.preClickTarget,
        postClickTarget: debuggerAttempt.postClickTarget,
        viewport: debuggerAttempt.viewport
      });

      lastSignals = await waitForCreateEffect(prompt, beforeMediaIds, 5000);

      if (lastSignals.started) {
        await ctx.emitProgress(Diagnostics.STEPS.CLICK_CREATE, "success", "Create activado con click real.", {
          beforeState,
          attempts,
          effectSignals: lastSignals
        });

        return beforeMediaIds;
      }
    } catch (error) {
      attempts.push({
        method: "chrome.debugger/Input.dispatchMouseEvent",
        ok: false,
        error: {
          message: error && error.message ? error.message : String(error),
          code: error && error.code ? error.code : null,
          details: error && error.details ? error.details : {}
        }
      });
    }

    // Diagnostic fallback only. The probe confirmed that Google Flow ignores this
    // path in the current UI, but keeping it helps identify permission or debugger
    // failures separately from DOM selector issues.
    try {
      const fallbackButton = FlowSelectors.findCreateButton() || createButton;
      await DomUtils.clickElement(fallbackButton);
      attempts.push({
        method: "dom-dispatchEvent-and-element-click",
        ok: true,
        createButton: Diagnostics.describeElement(fallbackButton)
      });

      lastSignals = await waitForCreateEffect(prompt, beforeMediaIds, 3000);

      if (lastSignals.started) {
        await ctx.emitProgress(Diagnostics.STEPS.CLICK_CREATE, "success", "Create activado con fallback DOM.", {
          beforeState,
          attempts,
          effectSignals: lastSignals
        });

        return beforeMediaIds;
      }
    } catch (error) {
      attempts.push({
        method: "dom-dispatchEvent-and-element-click",
        ok: false,
        error: {
          message: error && error.message ? error.message : String(error),
          code: error && error.code ? error.code : null,
          details: error && error.details ? error.details : {}
        }
      });
    }

    await ctx.throwStructuredError(
      Diagnostics.ERROR_CODES.CREATE_CLICK_NO_EFFECT,
      Diagnostics.STEPS.CLICK_CREATE,
      "El click sobre Create se ejecuto, pero Google Flow no inicio la generacion.",
      {
        cause: "No aparecio Stop, no se limpio el editor, no hubo nuevos mediaIds y no se detecto cambio de estado despues del click.",
        beforeState,
        attempts,
        lastSignals: lastSignals || collectCreateEffectSignals(prompt, beforeMediaIds),
        domSummary: buildDomSummary()
      }
    );
  }

  async function waitForNewGeneratedImages(ctx, beforeMediaIds, options) {
    await ctx.emitProgress(Diagnostics.STEPS.WAIT_GENERATED_IMAGES, "running", "Esperando imagenes generadas...");
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 120000;
    const stableMs = options && options.stableMs ? options.stableMs : 2000;
    const startedAt = Date.now();
    const beforeSet = new Set(beforeMediaIds || []);

    return new Promise(function (resolve, reject) {
      let settled = false;
      let stableTimer = null;

      function collectNewImages() {
        return FlowSelectors.findGeneratedImages()
          .map(function (img) {
            const src = img.getAttribute("src") || "";
            const mediaId = DomUtils.getMediaIdFromUrl(src);
            if (!mediaId || beforeSet.has(mediaId)) {
              return null;
            }

            const rect = img.getBoundingClientRect();
            return {
              element: img,
              mediaId,
              src,
              alt: img.getAttribute("alt") || "",
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              }
            };
          })
          .filter(Boolean);
      }

      async function completeSuccess(images) {
        if (settled) {
          return;
        }
        settled = true;
        observer.disconnect();
        clearTimeout(timeoutHandle);
        clearInterval(intervalHandle);
        if (stableTimer) {
          clearTimeout(stableTimer);
        }

        await ctx.emitProgress(Diagnostics.STEPS.WAIT_GENERATED_IMAGES, "success", "Imagenes nuevas detectadas.", {
          beforeMediaIds,
          newImagesFound: images.length,
          newMediaIds: images.map(function (item) { return item.mediaId; }),
          durationMs: Date.now() - startedAt
        });
        resolve(images);
      }

      async function completeFailure(code, message, details) {
        if (settled) {
          return;
        }
        settled = true;
        observer.disconnect();
        clearTimeout(timeoutHandle);
        clearInterval(intervalHandle);
        if (stableTimer) {
          clearTimeout(stableTimer);
        }

        try {
          await ctx.throwStructuredError(code, Diagnostics.STEPS.WAIT_GENERATED_IMAGES, message, details);
        } catch (error) {
          reject(error);
        }
      }

      function scheduleIfStable(images) {
        if (!images.length) {
          return;
        }

        if (stableTimer) {
          clearTimeout(stableTimer);
        }

        stableTimer = setTimeout(function () {
          completeSuccess(images);
        }, stableMs);
      }

      function inspect() {
        const images = collectNewImages();
        if (images.length) {
          scheduleIfStable(images);
        }
      }

      const observer = new MutationObserver(inspect);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "style", "class", "aria-hidden"]
      });

      const intervalHandle = setInterval(inspect, 500);
      const timeoutHandle = setTimeout(function () {
        const currentImages = collectNewImages();
        const code = currentImages.length ? Diagnostics.ERROR_CODES.NO_NEW_GENERATED_IMAGES : Diagnostics.ERROR_CODES.GENERATION_TIMEOUT;
        const message = currentImages.length
          ? "Se detectaron cambios, pero no pude confirmar imagenes nuevas estables."
          : "La generacion no produjo imagenes nuevas dentro del tiempo esperado.";

        completeFailure(code, message, {
          beforeMediaIds,
          currentMediaIds: FlowSelectors.getCurrentGeneratedMediaIds(),
          createEffectSignals: collectCreateEffectSignals(null, beforeMediaIds),
          durationMs: Date.now() - startedAt
        });
      }, timeoutMs);

      inspect();
    });
  }


  function describePointHitForElement(targetElement, point) {
    if (!point || !isPointInViewport(point.x, point.y)) {
      return {
        point,
        pointInViewport: false,
        elementAtPoint: null,
        elementAtPointIsTarget: false
      };
    }

    const elementAtPoint = document.elementFromPoint(point.x, point.y);
    return {
      point,
      pointInViewport: true,
      elementAtPoint: Diagnostics.describeElement(elementAtPoint),
      elementAtPointIsTarget: Boolean(elementAtPoint && (elementAtPoint === targetElement || targetElement.contains(elementAtPoint)))
    };
  }

  function getBestElementClickTarget(targetElement) {
    if (!targetElement) {
      return {
        ok: false,
        element: null,
        point: null,
        rect: null,
        elementAtPoint: null,
        elementAtPointIsTarget: false,
        inspected: []
      };
    }

    const rect = getElementRect(targetElement);
    const points = buildCandidatePoints(targetElement).map(function (point) {
      return describePointHitForElement(targetElement, point);
    });
    const hit = points.find(function (item) {
      return item.elementAtPointIsTarget;
    }) || null;

    return {
      ok: Boolean(hit),
      element: targetElement,
      point: hit ? hit.point : (points[0] ? points[0].point : null),
      rect,
      elementAtPoint: hit ? hit.elementAtPoint : (points[0] ? points[0].elementAtPoint : null),
      elementAtPointIsTarget: Boolean(hit),
      inspected: [{
        element: Diagnostics.describeElement(targetElement),
        rect,
        usablePoint: hit ? hit.point : null,
        elementAtUsablePoint: hit ? hit.elementAtPoint : null,
        points
      }]
    };
  }

  function summarizeElementTarget(target) {
    if (!target) {
      return null;
    }

    return {
      ok: Boolean(target.ok),
      point: target.point || null,
      rect: target.rect || null,
      element: Diagnostics.describeElement(target.element),
      elementAtPoint: target.elementAtPoint || null,
      elementAtPointIsTarget: Boolean(target.elementAtPointIsTarget),
      viewport: getViewportInfo(),
      inspected: target.inspected || []
    };
  }

  async function waitForFreshStableElementClickTarget(resolveElement, options) {
    const startedAt = Date.now();
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 4000;
    const intervalMs = options && options.intervalMs ? options.intervalMs : 90;
    const requiredStableSamples = options && options.requiredStableSamples ? options.requiredStableSamples : 3;
    const label = options && options.label ? options.label : "element";
    const samples = [];
    let lastKey = null;
    let stableCount = 0;
    let lastTarget = null;

    await waitForLayoutFrames(2);

    while (Date.now() - startedAt < timeoutMs) {
      const freshElement = resolveElement();
      const target = getBestElementClickTarget(freshElement);
      lastTarget = target;
      const sampleKey = target && target.ok ? makeTargetKey(target) : "not-hittable";

      samples.push({
        time: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        label,
        key: sampleKey,
        target: summarizeElementTarget(target)
      });

      if (target && target.ok) {
        if (sampleKey === lastKey) {
          stableCount += 1;
        } else {
          lastKey = sampleKey;
          stableCount = 1;
        }

        if (stableCount >= requiredStableSamples) {
          await waitForLayoutFrames(1);
          const finalElement = resolveElement();
          const finalTarget = getBestElementClickTarget(finalElement);
          const finalKey = finalTarget && finalTarget.ok ? makeTargetKey(finalTarget) : "not-hittable";

          if (finalTarget && finalTarget.ok && finalKey === sampleKey) {
            finalTarget.freshCoordinatePolicy = "requery-element-before-each-sample-and-final-reread-before-action";
            finalTarget.label = label;
            finalTarget.stableSamples = stableCount;
            finalTarget.requiredStableSamples = requiredStableSamples;
            finalTarget.durationMs = Date.now() - startedAt;
            finalTarget.samples = samples.slice(-12);
            finalTarget.finalKey = finalKey;
            finalTarget.viewport = getViewportInfo();
            return finalTarget;
          }

          samples.push({
            time: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt,
            label,
            key: finalKey,
            rejectedFinalReread: true,
            target: summarizeElementTarget(finalTarget)
          });

          lastKey = finalKey;
          stableCount = finalTarget && finalTarget.ok ? 1 : 0;
        }
      } else {
        stableCount = 0;
        lastKey = null;
      }

      await DomUtils.sleep(intervalMs);
    }

    if (lastTarget) {
      lastTarget.freshCoordinatePolicy = "failed-to-find-stable-fresh-element-coordinate";
      lastTarget.label = label;
      lastTarget.stableSamples = stableCount;
      lastTarget.requiredStableSamples = requiredStableSamples;
      lastTarget.durationMs = Date.now() - startedAt;
      lastTarget.samples = samples.slice(-20);
      lastTarget.viewport = getViewportInfo();
    }

    return lastTarget;
  }

  async function prepareDebuggerForReason(reason, settleMs) {
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_DEBUGGER_PREPARE",
      payload: {
        settleMs: typeof settleMs === "number" ? settleMs : 250,
        reason: reason || "prepare-before-fresh-coordinate-measurement",
        viewport: getViewportInfo()
      }
    });

    if (!response || !response.ok) {
      const error = new Error(response && response.error && response.error.message ? response.error.message : "Debugger prepare failed.");
      error.code = response && response.error && response.error.code ? response.error.code : "DEBUGGER_PREPARE_FAILED";
      error.details = response && response.error && response.error.details ? response.error.details : { response };
      throw error;
    }

    return response;
  }

  async function sendDebuggerMouseMoveToTarget(target, details) {
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_DEBUGGER_MOUSE_MOVE",
      payload: {
        x: target.point.x,
        y: target.point.y,
        prepared: true,
        skipBringToFront: true,
        keepAttached: true,
        detachAfterMove: false,
        settleMs: details && details.settleMs ? details.settleMs : 120,
        targetElement: Diagnostics.describeElement(target.element),
        elementAtPoint: target.elementAtPoint,
        viewport: getViewportInfo(),
        label: details && details.label ? details.label : target.label || null
      }
    });

    return {
      response,
      point: target.point,
      target,
      viewport: getViewportInfo()
    };
  }

  async function sendDebuggerClickToTarget(target, details) {
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_DEBUGGER_CLICK",
      payload: {
        x: target.point.x,
        y: target.point.y,
        delayMs: details && details.delayMs ? details.delayMs : 120,
        prepared: true,
        skipBringToFront: true,
        detachAfterClick: Boolean(details && details.detachAfterClick === true),
        targetElement: Diagnostics.describeElement(target.element),
        elementAtPoint: target.elementAtPoint,
        viewport: getViewportInfo(),
        label: details && details.label ? details.label : target.label || null
      }
    });

    return {
      response,
      point: target.point,
      target,
      viewport: getViewportInfo()
    };
  }

  async function searchDownloadsSince(startedAfter, limit) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "FLOW_DOWNLOADS_SEARCH",
        payload: {
          startedAfter,
          limit: limit || 10
        }
      });

      return response || null;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "DOWNLOADS_SEARCH_MESSAGE_FAILED",
          message: error && error.message ? error.message : String(error)
        }
      };
    }
  }

  async function waitForElement(resolveElement, options) {
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 8000;
    const intervalMs = options && options.intervalMs ? options.intervalMs : 200;
    const startedAt = Date.now();
    let last = null;

    while (Date.now() - startedAt < timeoutMs) {
      last = resolveElement();
      if (last) {
        return {
          element: last,
          durationMs: Date.now() - startedAt
        };
      }

      await DomUtils.sleep(intervalMs);
    }

    return {
      element: null,
      durationMs: Date.now() - startedAt
    };
  }

  async function revealImageActions(ctx, target) {
    const imageElement = target.element;
    const card = FlowSelectors.findImageCardForImage(imageElement) || imageElement;

    const imageTarget = await waitForFreshStableElementClickTarget(function () {
      return imageElement;
    }, {
      timeoutMs: 3500,
      intervalMs: 90,
      requiredStableSamples: 3,
      label: "generated-image"
    });

    const actionAttempts = [];

    if (imageTarget && imageTarget.ok) {
      const moveResult = await sendDebuggerMouseMoveToTarget(imageTarget, {
        label: "hover-generated-image",
        settleMs: 250
      });
      actionAttempts.push({
        type: "move-image",
        ok: Boolean(moveResult.response && moveResult.response.ok),
        result: moveResult
      });
    }

    await DomUtils.sleep(350);

    let moreButton = FlowSelectors.findImageActionMoreButton() || FlowSelectors.findMoreButtonForImageCard(card);
    if (moreButton) {
      return {
        moreButton,
        card,
        actionAttempts
      };
    }

    // Fallback: some Flow layouts expose the image action bar only after selecting/opening the image.
    if (imageTarget && imageTarget.ok) {
      const clickResult = await sendDebuggerClickToTarget(imageTarget, {
        label: "select-generated-image",
        delayMs: 120,
        detachAfterClick: false
      });
      actionAttempts.push({
        type: "click-image",
        ok: Boolean(clickResult.response && clickResult.response.ok),
        result: clickResult
      });

      await DomUtils.sleep(900);
      moreButton = FlowSelectors.findImageActionMoreButton() || FlowSelectors.findMoreButtonForImageCard(card);
    }

    return {
      moreButton,
      card,
      actionAttempts
    };
  }

  async function downloadImage1K(ctx, images, options) {
    const imageIndex = options && typeof options.imageIndex === "number" ? options.imageIndex : 0;
    const target = images[imageIndex];
    const debugAttempts = [];

    await ctx.emitProgress(Diagnostics.STEPS.SELECT_IMAGE, "running", "Seleccionando imagen generada...");
    if (!target) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.IMAGE_INDEX_OUT_OF_RANGE,
        Diagnostics.STEPS.SELECT_IMAGE,
        "No existe una imagen nueva en el indice solicitado.",
        {
          imageIndex,
          imagesFound: images.length
        }
      );
    }

    await ctx.emitProgress(Diagnostics.STEPS.SELECT_IMAGE, "success", "Imagen seleccionada.", {
      imageIndex,
      selectedMediaId: target.mediaId,
      image: Diagnostics.describeElement(target.element)
    });

    let debuggerPrepared = false;

    try {
      const prepareResponse = await prepareDebuggerForReason("download-generated-image-1k", 250);
      debuggerPrepared = true;
      debugAttempts.push({
        step: "prepare-debugger",
        ok: Boolean(prepareResponse && prepareResponse.ok),
        response: prepareResponse
      });

      await ctx.emitProgress(Diagnostics.STEPS.OPEN_IMAGE_MENU, "running", "Revelando acciones de imagen y buscando More...");
      const revealResult = await revealImageActions(ctx, target);
      debugAttempts.push({
        step: "reveal-image-actions",
        ok: Boolean(revealResult && revealResult.moreButton),
        card: Diagnostics.describeElement(revealResult && revealResult.card),
        actionAttempts: revealResult ? revealResult.actionAttempts : []
      });

      if (!revealResult || !revealResult.moreButton) {
        await releaseDebuggerAfterFailedMeasurement("image-action-more-not-found");
        debuggerPrepared = false;

        await ctx.throwStructuredError(
          Diagnostics.ERROR_CODES.IMAGE_ACTION_MORE_BUTTON_NOT_FOUND || Diagnostics.ERROR_CODES.IMAGE_MORE_MENU_NOT_FOUND,
          Diagnostics.STEPS.OPEN_IMAGE_MENU,
          "No encontre el boton More correcto de la imagen generada.",
          {
            selectedMediaId: target.mediaId,
            image: Diagnostics.describeElement(target.element),
            debugAttempts,
            domSummary: buildDomSummary()
          }
        );
      }

      const moreTarget = await waitForFreshStableElementClickTarget(function () {
        return FlowSelectors.findImageActionMoreButton() || FlowSelectors.findMoreButtonForImageCard(revealResult.card);
      }, {
        timeoutMs: 4500,
        intervalMs: 90,
        requiredStableSamples: 3,
        label: "image-more-button"
      });

      if (!moreTarget || !moreTarget.ok) {
        await releaseDebuggerAfterFailedMeasurement("image-more-coordinate-not-stable");
        debuggerPrepared = false;

        await ctx.throwStructuredError(
          Diagnostics.ERROR_CODES.IMAGE_MORE_MENU_NOT_FOUND,
          Diagnostics.STEPS.OPEN_IMAGE_MENU,
          "No pude obtener coordenadas frescas y estables para el boton More de la imagen.",
          {
            selectedMediaId: target.mediaId,
            moreTarget,
            debugAttempts
          }
        );
      }

      const moreClick = await sendDebuggerClickToTarget(moreTarget, {
        label: "click-image-more",
        delayMs: 120,
        detachAfterClick: false
      });
      debugAttempts.push({
        step: "click-image-more",
        ok: Boolean(moreClick.response && moreClick.response.ok),
        result: moreClick
      });

      await ctx.emitProgress(Diagnostics.STEPS.OPEN_IMAGE_MENU, "success", "Menu More de imagen abierto.", {
        selectedMediaId: target.mediaId,
        moreButtonTarget: summarizeElementTarget(moreTarget),
        debugAttempts: debugAttempts.slice(-4)
      });

      await ctx.emitProgress(Diagnostics.STEPS.OPEN_DOWNLOAD_SUBMENU, "running", "Buscando item Download en el menu de imagen...");
      const downloadWait = await waitForElement(function () {
        return FlowSelectors.findDownloadMenuItem();
      }, {
        timeoutMs: 8000,
        intervalMs: 200
      });

      if (!downloadWait.element) {
        await releaseDebuggerAfterFailedMeasurement("download-menu-item-not-found");
        debuggerPrepared = false;

        await ctx.throwStructuredError(
          Diagnostics.ERROR_CODES.DOWNLOAD_MENU_NOT_FOUND,
          Diagnostics.STEPS.OPEN_DOWNLOAD_SUBMENU,
          "No encontre el item Download despues de abrir el menu More de la imagen.",
          {
            selectedMediaId: target.mediaId,
            durationMs: downloadWait.durationMs,
            debugAttempts,
            domSummary: buildDomSummary()
          }
        );
      }

      const downloadTarget = await waitForFreshStableElementClickTarget(function () {
        return FlowSelectors.findDownloadMenuItem();
      }, {
        timeoutMs: 4500,
        intervalMs: 90,
        requiredStableSamples: 3,
        label: "download-menu-item"
      });

      if (!downloadTarget || !downloadTarget.ok) {
        await releaseDebuggerAfterFailedMeasurement("download-menu-coordinate-not-stable");
        debuggerPrepared = false;

        await ctx.throwStructuredError(
          Diagnostics.ERROR_CODES.DOWNLOAD_HOVER_FAILED || Diagnostics.ERROR_CODES.DOWNLOAD_MENU_NOT_FOUND,
          Diagnostics.STEPS.OPEN_DOWNLOAD_SUBMENU,
          "No pude obtener coordenadas frescas y estables para hacer hover sobre Download.",
          {
            selectedMediaId: target.mediaId,
            downloadTarget,
            debugAttempts
          }
        );
      }

      const downloadHover = await sendDebuggerMouseMoveToTarget(downloadTarget, {
        label: "hover-download-menu-item",
        settleMs: 700
      });
      debugAttempts.push({
        step: "hover-download-menu-item",
        ok: Boolean(downloadHover.response && downloadHover.response.ok),
        result: downloadHover
      });

      await ctx.emitProgress(Diagnostics.STEPS.OPEN_DOWNLOAD_SUBMENU, "success", "Submenu Download abierto o solicitado por hover.", {
        selectedMediaId: target.mediaId,
        downloadTarget: summarizeElementTarget(downloadTarget),
        debugAttempts: debugAttempts.slice(-5)
      });

      await ctx.emitProgress(Diagnostics.STEPS.CLICK_1K_ORIGINAL_SIZE, "running", "Buscando 1K Original size...");
      const originalSizeWait = await waitForElement(function () {
        return FlowSelectors.findOriginalSizeOption();
      }, {
        timeoutMs: 8000,
        intervalMs: 200
      });

      if (!originalSizeWait.element) {
        await releaseDebuggerAfterFailedMeasurement("original-size-option-not-found");
        debuggerPrepared = false;

        await ctx.throwStructuredError(
          Diagnostics.ERROR_CODES.ORIGINAL_SIZE_OPTION_NOT_FOUND,
          Diagnostics.STEPS.CLICK_1K_ORIGINAL_SIZE,
          "No encontre la opcion 1K Original size despues de hacer hover en Download.",
          {
            selectedMediaId: target.mediaId,
            durationMs: originalSizeWait.durationMs,
            debugAttempts,
            domSummary: buildDomSummary()
          }
        );
      }

      const originalSizeTarget = await waitForFreshStableElementClickTarget(function () {
        return FlowSelectors.findOriginalSizeOption();
      }, {
        timeoutMs: 4500,
        intervalMs: 90,
        requiredStableSamples: 3,
        label: "1k-original-size-option"
      });

      if (!originalSizeTarget || !originalSizeTarget.ok) {
        await releaseDebuggerAfterFailedMeasurement("original-size-coordinate-not-stable");
        debuggerPrepared = false;

        await ctx.throwStructuredError(
          Diagnostics.ERROR_CODES.ORIGINAL_SIZE_OPTION_NOT_FOUND,
          Diagnostics.STEPS.CLICK_1K_ORIGINAL_SIZE,
          "No pude obtener coordenadas frescas y estables para 1K Original size.",
          {
            selectedMediaId: target.mediaId,
            originalSizeTarget,
            debugAttempts
          }
        );
      }

      const downloadStartedAfter = new Date().toISOString();
      const originalClick = await sendDebuggerClickToTarget(originalSizeTarget, {
        label: "click-1k-original-size",
        delayMs: 140,
        detachAfterClick: true
      });
      debuggerPrepared = false;

      debugAttempts.push({
        step: "click-1k-original-size",
        ok: Boolean(originalClick.response && originalClick.response.ok),
        result: originalClick,
        downloadStartedAfter
      });

      await DomUtils.sleep((options && options.downloadTimeoutMs) || 3500);

      const downloadsSearch = await searchDownloadsSince(downloadStartedAfter, 10);
      const downloadItems = downloadsSearch && downloadsSearch.payload && downloadsSearch.payload.items
        ? downloadsSearch.payload.items
        : [];

      const matchingDownloads = downloadItems.filter(function (item) {
        const text = [
          item.filename || "",
          item.url || "",
          item.finalUrl || "",
          item.mime || ""
        ].join(" ");
        return /image|png|jpeg|jpg|webp|media|getMediaUrlRedirect|google|flow/i.test(text);
      });

      await ctx.emitProgress(Diagnostics.STEPS.CLICK_1K_ORIGINAL_SIZE, "success", "Click real en 1K Original size ejecutado.", {
        selectedMediaId: target.mediaId,
        moreButtonFound: true,
        downloadMenuFound: true,
        originalSizeFound: true,
        clicked: true,
        originalSizeTarget: summarizeElementTarget(originalSizeTarget),
        downloadsSearch,
        matchingDownloads,
        downloadConfirmed: matchingDownloads.length > 0,
        debugAttempts: debugAttempts.slice(-8)
      });

      return {
        element: target.element,
        mediaId: target.mediaId,
        downloadStartedAfter,
        downloadsSearch,
        matchingDownloads,
        downloadConfirmed: matchingDownloads.length > 0
      };
    } catch (error) {
      if (debuggerPrepared) {
        await releaseDebuggerAfterFailedMeasurement("download-flow-error");
      }

      if (error && error.step) {
        throw error;
      }

      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.DOWNLOAD_CLICK_FAILED,
        Diagnostics.STEPS.CLICK_1K_ORIGINAL_SIZE,
        "Fallo el flujo de descarga automatica 1K.",
        {
          selectedMediaId: target.mediaId,
          message: error && error.message ? error.message : String(error),
          code: error && error.code ? error.code : null,
          details: error && error.details ? error.details : {},
          debugAttempts,
          domSummary: buildDomSummary()
        }
      );
    }
  }

  async function runGenerateAndDownload(config) {
    const prompt = String(config.prompt || "").trim();
    const ctx = createAutomationContext(config);

    await ctx.emitProgress(Diagnostics.STEPS.INIT, "running", "Iniciando automatizacion...");

    if (!prompt) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.PROMPT_EMPTY,
        Diagnostics.STEPS.INIT,
        "El prompt esta vacio.",
        { promptLength: 0 }
      );
    }

    await validatePage(ctx);
    await setPrompt(ctx, prompt);
    const createButton = await waitForCreateEnabled(ctx, config.options.createEnabledTimeoutMs);
    const beforeMediaIds = await clickCreate(ctx, createButton, prompt);
    const newImages = await waitForNewGeneratedImages(ctx, beforeMediaIds, {
      timeoutMs: config.options.generationTimeoutMs,
      stableMs: 2000
    });
    const selectedImage = await downloadImage1K(ctx, newImages, config.options);

    const diagnostics = Diagnostics.finalizeDiagnostics(ctx.diagnostics, "success", buildDomSummary());
    const resultPayload = {
      status: "success",
      prompt,
      imagesFound: newImages.length,
      selectedImageIndex: config.options.imageIndex || 0,
      selectedMediaId: selectedImage.mediaId,
      downloadAction: "clicked_1k_original_size",
      downloadConfirmed: Boolean(selectedImage.downloadConfirmed),
      matchingDownloads: selectedImage.matchingDownloads || [],
      durationMs: new Date(diagnostics.endedAt).getTime() - new Date(diagnostics.startedAt).getTime(),
      diagnostics
    };

    await ctx.emitProgress(Diagnostics.STEPS.DONE, "success", "Flujo completado.");
    await chrome.runtime.sendMessage({
      type: "FLOW_RESULT",
      requestId: config.requestId,
      payload: resultPayload
    });

    return resultPayload;
  }

  scope.FlowAutomation = {
    FLOW_PAGE_REGEX,
    runGenerateAndDownload,
    buildDomSummary
  };
})();
