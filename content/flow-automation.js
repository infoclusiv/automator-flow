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

  function getElementClickPoint(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        centerX: Math.round(rect.left + rect.width / 2),
        centerY: Math.round(rect.top + rect.height / 2)
      }
    };
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

  async function requestDebuggerClick(createButton) {
    DomUtils.scrollIntoViewCentered(createButton);
    await DomUtils.sleep(150);

    const point = getElementClickPoint(createButton);
    const elementAtPoint = document.elementFromPoint(point.x, point.y);
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_DEBUGGER_CLICK",
      payload: {
        x: point.x,
        y: point.y,
        delayMs: 90,
        targetElement: Diagnostics.describeElement(createButton),
        elementAtPoint: Diagnostics.describeElement(elementAtPoint)
      }
    });

    return {
      response,
      point,
      elementAtPoint: Diagnostics.describeElement(elementAtPoint),
      elementAtPointIsCreateButton: Boolean(elementAtPoint && (elementAtPoint === createButton || createButton.contains(elementAtPoint)))
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
      const debuggerAttempt = await requestDebuggerClick(createButton);
      attempts.push({
        method: "chrome.debugger/Input.dispatchMouseEvent",
        ok: Boolean(debuggerAttempt.response && debuggerAttempt.response.ok),
        response: debuggerAttempt.response,
        point: debuggerAttempt.point,
        elementAtPoint: debuggerAttempt.elementAtPoint,
        elementAtPointIsCreateButton: debuggerAttempt.elementAtPointIsCreateButton
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

  async function downloadImage1K(ctx, images, options) {
    const imageIndex = options && typeof options.imageIndex === "number" ? options.imageIndex : 0;
    const target = images[imageIndex];

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
      selectedMediaId: target.mediaId
    });

    const imageElement = target.element;
    const card = FlowSelectors.findImageCardForImage(imageElement);
    if (!card) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.IMAGE_CARD_NOT_FOUND,
        Diagnostics.STEPS.OPEN_IMAGE_MENU,
        "No pude identificar la tarjeta contenedora de la imagen.",
        {
          selectedMediaId: target.mediaId,
          image: Diagnostics.describeElement(imageElement)
        }
      );
    }

    await ctx.emitProgress(Diagnostics.STEPS.OPEN_IMAGE_MENU, "running", "Abriendo menu More...");
    await DomUtils.hoverElement(card);
    await DomUtils.hoverElement(imageElement);
    await DomUtils.sleep(250);

    const moreButton = FlowSelectors.findMoreButtonForImageCard(card);
    if (!moreButton) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.IMAGE_MORE_MENU_NOT_FOUND,
        Diagnostics.STEPS.OPEN_IMAGE_MENU,
        "No encontre el boton More para la imagen seleccionada.",
        {
          selectedMediaId: target.mediaId,
          card: Diagnostics.describeElement(card)
        }
      );
    }

    await DomUtils.clickElement(moreButton);
    await ctx.emitProgress(Diagnostics.STEPS.OPEN_IMAGE_MENU, "success", "Menu More abierto.", {
      selectedMediaId: target.mediaId,
      moreButtonFound: true
    });

    await ctx.emitProgress(Diagnostics.STEPS.OPEN_DOWNLOAD_SUBMENU, "running", "Abriendo submenu Download...");
    const downloadMenuItem = await DomUtils.waitFor(function () {
      return FlowSelectors.findDownloadMenuItem();
    }, {
      timeoutMs: 10000,
      intervalMs: 200,
      description: "download menu item"
    }).catch(function () {
      return null;
    });

    if (!downloadMenuItem) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.DOWNLOAD_MENU_NOT_FOUND,
        Diagnostics.STEPS.OPEN_DOWNLOAD_SUBMENU,
        "No encontre el submenu Download.",
        {
          selectedMediaId: target.mediaId
        }
      );
    }

    await DomUtils.hoverElement(downloadMenuItem);
    downloadMenuItem.focus();
    await DomUtils.sleep(250);

    await ctx.emitProgress(Diagnostics.STEPS.OPEN_DOWNLOAD_SUBMENU, "success", "Submenu Download abierto.", {
      downloadMenuFound: true,
      selectedMediaId: target.mediaId
    });

    await ctx.emitProgress(Diagnostics.STEPS.CLICK_1K_ORIGINAL_SIZE, "running", "Haciendo click en 1K Original size...");
    const originalSizeOption = await DomUtils.waitFor(function () {
      return FlowSelectors.findOriginalSizeOption();
    }, {
      timeoutMs: 10000,
      intervalMs: 200,
      description: "1K Original size menu item"
    }).catch(function () {
      return null;
    });

    if (!originalSizeOption) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.ORIGINAL_SIZE_OPTION_NOT_FOUND,
        Diagnostics.STEPS.CLICK_1K_ORIGINAL_SIZE,
        "No encontre la opcion 1K Original size.",
        {
          selectedMediaId: target.mediaId
        }
      );
    }

    try {
      await DomUtils.clickElement(originalSizeOption.closest("[role='menuitem']") || originalSizeOption);
      await DomUtils.sleep((options && options.downloadTimeoutMs) || 3000);
    } catch (error) {
      await ctx.throwStructuredError(
        Diagnostics.ERROR_CODES.DOWNLOAD_CLICK_FAILED,
        Diagnostics.STEPS.CLICK_1K_ORIGINAL_SIZE,
        "No pude activar la descarga 1K.",
        {
          selectedMediaId: target.mediaId,
          originalSizeOption: Diagnostics.describeElement(originalSizeOption)
        }
      );
    }

    await ctx.emitProgress(Diagnostics.STEPS.CLICK_1K_ORIGINAL_SIZE, "success", "Descarga 1K iniciada.", {
      selectedMediaId: target.mediaId,
      moreButtonFound: true,
      downloadMenuFound: true,
      originalSizeFound: true,
      clicked: true
    });

    return target;
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
