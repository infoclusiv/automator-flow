(function () {
  const scope = window.FlowExtension = window.FlowExtension || {};
  const DomUtils = scope.DomUtils;

  const SELECTORS = {
    promptEditor: '[role="textbox"][data-slate-editor="true"]',
    button: "button",
    generatedImages: 'img[alt="Generated image"]',
    menuItems: '[role="menuitem"], button[role="menuitem"], [role="menu"] [tabindex]'
  };

  function textOf(el) {
    return DomUtils.getVisibleText(el).replace(/\s+/g, " ").trim();
  }

  function findPromptEditor() {
    return DomUtils.queryVisibleAll(SELECTORS.promptEditor).find(function (el) {
      return el.isContentEditable || el.getAttribute("contenteditable") === "true";
    }) || null;
  }

  function isInViewport(el) {
    if (!el || !(el instanceof Element)) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

    return rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewportWidth &&
      rect.top < viewportHeight;
  }

  function getCenterPoint(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
  }

  function isCenterPointInteractable(el) {
    if (!el || !isInViewport(el)) {
      return false;
    }

    const point = getCenterPoint(el);
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

    if (point.x < 0 || point.y < 0 || point.x >= viewportWidth || point.y >= viewportHeight) {
      return false;
    }

    const elementAtPoint = document.elementFromPoint(point.x, point.y);
    return Boolean(elementAtPoint && (elementAtPoint === el || el.contains(elementAtPoint)));
  }

  function findCreateButtons() {
    return DomUtils.findVisibleByText(SELECTORS.button, /Create/i).filter(function (button) {
      return /arrow_forward\s*Create/i.test(textOf(button));
    });
  }

  function scoreCreateButton(button) {
    const rect = button.getBoundingClientRect();
    let score = 0;

    if (button.getAttribute("disabled") === null && button.getAttribute("aria-disabled") !== "true") {
      score += 1000;
    }

    if (isInViewport(button)) {
      score += 500;
    }

    if (isCenterPointInteractable(button)) {
      score += 1000;
    }

    // The prompt submit button normally sits near the bottom/right of the prompt editor area.
    score += Math.max(0, Math.round(rect.left / 10));
    score += Math.max(0, Math.round(rect.top / 20));

    return score;
  }

  function findCreateButton() {
    const buttons = findCreateButtons();
    if (!buttons.length) {
      return null;
    }

    return buttons
      .slice()
      .sort(function (a, b) {
        return scoreCreateButton(b) - scoreCreateButton(a);
      })[0] || null;
  }

  function findGeneratedImages() {
    return DomUtils.queryVisibleAll(SELECTORS.generatedImages).filter(function (img) {
      const src = img.getAttribute("src") || "";
      return src.indexOf("media.getMediaUrlRedirect?name=") !== -1;
    });
  }

  function getCurrentGeneratedMediaIds() {
    return findGeneratedImages()
      .map(function (img) {
        return DomUtils.getMediaIdFromUrl(img.getAttribute("src") || "");
      })
      .filter(Boolean);
  }

  function findImageCardForImage(img) {
    if (!img) {
      return null;
    }

    let best = null;
    let current = img;

    for (let depth = 0; current && depth < 10; depth += 1) {
      current = current.parentElement;
      if (!current) {
        break;
      }

      const hasImage = current.querySelector('img[alt="Generated image"]');
      if (!hasImage) {
        continue;
      }

      const rect = current.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 120) {
        continue;
      }

      // Keep climbing so the returned node is more likely to include overlays/actions,
      // not just the anchor around the image.
      best = current;

      const buttons = current.querySelectorAll("button,[role='button']");
      if (buttons && buttons.length) {
        return current;
      }
    }

    return best;
  }

  function findNearestImageContainerForMediaId(mediaId) {
    if (!mediaId) {
      return null;
    }

    const image = findGeneratedImages().find(function (img) {
      return DomUtils.getMediaIdFromUrl(img.getAttribute("src") || "") === mediaId;
    });

    return image ? findImageCardForImage(image) : null;
  }

  function findMoreButtonForImageCard(card) {
    if (!card) {
      return null;
    }

    const withinCard = Array.from(card.querySelectorAll("button,[role='button']")).filter(function (el) {
      const text = textOf(el);
      return DomUtils.isVisible(el) && /(?:more_vert\s*)?More/i.test(text) && !/More options/i.test(text);
    });
    if (withinCard.length) {
      return withinCard[0];
    }

    const cardRect = card.getBoundingClientRect();
    const nearbyButtons = DomUtils.findVisibleByText("button,[role='button']", /(?:more_vert\s*)?More/i)
      .filter(function (button) {
        const text = textOf(button);
        return !/More options/i.test(text);
      });

    return nearbyButtons.find(function (button) {
      const rect = button.getBoundingClientRect();
      const horizontallyAligned = rect.left >= cardRect.left - 80 && rect.right <= cardRect.right + 120;
      const verticallyAligned = rect.top >= cardRect.top - 100 && rect.bottom <= cardRect.bottom + 120;
      return horizontallyAligned && verticallyAligned;
    }) || null;
  }

  function scoreImageActionMoreButton(button) {
    const text = textOf(button);
    const rect = button.getBoundingClientRect();
    let score = 0;

    if (!DomUtils.isVisible(button)) {
      return -999999;
    }

    if (/more_vert\s*More$/i.test(text) || /^More$/i.test(text)) {
      score += 2000;
    }

    if (/More options/i.test(text)) {
      score -= 1500;
    }

    const ancestorText = textOf(button.closest("div,section,article,main") || button);
    if (/Favorite/i.test(ancestorText)) {
      score += 500;
    }
    if (/Reuse prompt/i.test(ancestorText)) {
      score += 500;
    }
    if (/\bimage\b/i.test(ancestorText)) {
      score += 200;
    }

    if (isInViewport(button)) {
      score += 200;
    }

    if (isCenterPointInteractable(button)) {
      score += 500;
    }

    // The image action bar observed in Flow is usually near the right/preview panel.
    score += Math.round(rect.left / 20);
    score += Math.round(rect.top / 50);

    return score;
  }

  function findImageActionMoreButton() {
    const buttons = DomUtils.findVisibleByText("button,[role='button']", /(?:more_vert\s*)?More/i);

    if (!buttons.length) {
      return null;
    }

    return buttons
      .slice()
      .sort(function (a, b) {
        return scoreImageActionMoreButton(b) - scoreImageActionMoreButton(a);
      })[0] || null;
  }

  function getVisibleMenuItems() {
    return DomUtils.queryVisibleAll(SELECTORS.menuItems).filter(function (el) {
      return DomUtils.isVisible(el);
    });
  }

  function findImageDownloadMenu() {
    const menus = DomUtils.queryVisibleAll('[role="menu"]').filter(function (menu) {
      const text = textOf(menu);
      return /Download/i.test(text) &&
        (/Animate/i.test(text) || /Add to prompt/i.test(text) || /Set project cover/i.test(text) || /Move to trash/i.test(text));
    });

    if (menus.length) {
      return menus[0];
    }

    return null;
  }

  function findDownloadMenuItem() {
    const menuItems = getVisibleMenuItems();
    const exact = menuItems.find(function (el) {
      const text = textOf(el);
      return /^(download\s*)?Download$/i.test(text) || /^Download$/i.test(text);
    });

    if (exact) {
      return exact;
    }

    const imageMenu = findImageDownloadMenu();
    if (imageMenu) {
      return Array.from(imageMenu.querySelectorAll(SELECTORS.menuItems)).filter(DomUtils.isVisible).find(function (el) {
        return /Download/i.test(textOf(el));
      }) || null;
    }

    return menuItems.find(function (el) {
      return /(?:download\s*)?Download/i.test(textOf(el));
    }) || null;
  }

  function findOriginalSizeOption() {
    const menuItems = getVisibleMenuItems();
    const direct = menuItems.find(function (el) {
      return /^1K\s*Original size$/i.test(textOf(el));
    });

    if (direct) {
      return direct;
    }

    const fuzzy = menuItems.find(function (el) {
      return /1K\s*Original size/i.test(textOf(el));
    });

    if (fuzzy) {
      return fuzzy;
    }

    const nested = Array.from(document.querySelectorAll("*")).filter(function (el) {
      return DomUtils.isVisible(el) && /^1K\s*Original size$/i.test(textOf(el));
    })[0];

    return nested ? nested.closest("[role='menuitem']") || nested : null;
  }


  function escapeRegexText(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function stripFileExtension(fileName) {
    return String(fileName || "").replace(/\.[^.\\/]+$/, "");
  }

  function findAddMediaButton() {
    const buttons = DomUtils.findVisibleByText("button,[role='button']", /Add Media/i);
    if (!buttons.length) {
      return null;
    }

    return buttons
      .slice()
      .sort(function (a, b) {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        let as = 0;
        let bs = 0;
        if (/^add\s*Add Media$/i.test(textOf(a)) || /Add Media/i.test(textOf(a))) as += 1000;
        if (/^add\s*Add Media$/i.test(textOf(b)) || /Add Media/i.test(textOf(b))) bs += 1000;
        if (isCenterPointInteractable(a)) as += 500;
        if (isCenterPointInteractable(b)) bs += 500;
        as += Math.round(ar.top / 20) + Math.round(ar.left / 20);
        bs += Math.round(br.top / 20) + Math.round(br.left / 20);
        return bs - as;
      })[0] || null;
  }

  function findPromptComposerAddButton() {
    const editor = findPromptEditor();
    if (!editor) {
      return null;
    }

    const editorRect = editor.getBoundingClientRect();
    const buttons = DomUtils.queryVisibleAll("button,[role='button']").filter(function (button) {
      const text = textOf(button);
      if (/arrow_forward\s*Create/i.test(text)) {
        return false;
      }
      if (/Add Media/i.test(text)) {
        return false;
      }
      if (/Upload media/i.test(text)) {
        return false;
      }
      return /add_?2?|add/i.test(text);
    });

    const candidates = buttons.map(function (button) {
      const rect = button.getBoundingClientRect();
      const text = textOf(button);
      const sameComposerRow = rect.top >= editorRect.top - 100 && rect.top <= editorRect.bottom + 110;
      const closeToEditorLeft = rect.left >= editorRect.left - 40 && rect.left <= editorRect.left + 100;
      const closeToEditorBottom = Math.abs((rect.top + rect.height / 2) - (editorRect.bottom + 33)) < 90;
      let score = 0;

      if (sameComposerRow) score += 1000;
      if (closeToEditorLeft) score += 1000;
      if (closeToEditorBottom) score += 500;
      if (/add_?2/i.test(text)) score += 900;
      if (/^add/i.test(text)) score += 250;
      if (rect.width >= 24 && rect.width <= 52 && rect.height >= 24 && rect.height <= 52) score += 450;
      if (isCenterPointInteractable(button)) score += 500;

      // Penalize header/top-bar buttons. The correct reference button is near the prompt composer.
      if (rect.top < Math.max(120, window.innerHeight * 0.35)) score -= 4000;
      if (rect.left > editorRect.right + 30) score -= 1200;

      return {
        element: button,
        score,
        text,
        rect
      };
    }).filter(function (item) {
      return item.score > 0;
    });

    if (!candidates.length) {
      return null;
    }

    return candidates.sort(function (a, b) {
      return b.score - a.score;
    })[0].element || null;
  }

  function findReferencePanelUploadMediaButton() {
    const addToPrompt = findAddToPromptButton();
    const buttons = DomUtils.findVisibleByText("button,[role='button']", /Upload media/i);
    if (!buttons.length) {
      return null;
    }

    const addRect = addToPrompt ? addToPrompt.getBoundingClientRect() : null;
    const candidates = buttons.map(function (button) {
      const rect = button.getBoundingClientRect();
      const text = textOf(button);
      let score = 0;

      if (/^upload\s*Upload media$/i.test(text)) score += 1000;
      if (isCenterPointInteractable(button)) score += 500;
      if (button.getAttribute("role") !== "menuitem") score += 700;
      if (rect.top > window.innerHeight * 0.45) score += 800;

      if (addRect) {
        const sameVerticalBand = Math.abs((rect.top + rect.height / 2) - (addRect.top + addRect.height / 2)) < 140;
        const leftOfAddToPrompt = rect.right <= addRect.right + 80;
        if (sameVerticalBand) score += 1200;
        if (leftOfAddToPrompt) score += 400;
      }

      // The global menu upload item appears near the top and has role=menuitem.
      if (rect.top < Math.max(180, window.innerHeight * 0.25)) score -= 4000;

      return { element: button, score, text, rect };
    }).filter(function (item) {
      return item.score > 0;
    });

    if (!candidates.length) {
      return null;
    }

    return candidates.sort(function (a, b) {
      return b.score - a.score;
    })[0].element || null;
  }

  function isReferencePromptPanelOpen() {
    return Boolean(findAddToPromptButton());
  }


  function findUploadMediaButton() {
    const buttons = DomUtils.findVisibleByText("button,[role='button']", /Upload media/i);
    if (!buttons.length) {
      return null;
    }

    return buttons
      .slice()
      .sort(function (a, b) {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        let as = /^upload\s*Upload media$/i.test(textOf(a)) ? 1000 : 0;
        let bs = /^upload\s*Upload media$/i.test(textOf(b)) ? 1000 : 0;
        if (isCenterPointInteractable(a)) as += 500;
        if (isCenterPointInteractable(b)) bs += 500;
        as += Math.max(0, 2000 - Math.abs(ar.width - 120));
        bs += Math.max(0, 2000 - Math.abs(br.width - 120));
        return bs - as;
      })[0] || null;
  }

  function findReferenceFileInputs() {
    return Array.from(document.querySelectorAll('input[type="file"]')).filter(function (input) {
      const accept = input.getAttribute("accept") || "";
      return /image|video|heic|heif/i.test(accept);
    });
  }

  function findIAgreeButton() {
    return DomUtils.findVisibleByText("button,[role='button']", /^I agree$/i)[0] ||
      DomUtils.findVisibleByText("button,[role='button']", /I agree/i)[0] ||
      null;
  }

  function findAddToPromptButton() {
    const buttons = DomUtils.findVisibleByText("button,[role='button']", /Add to Prompt/i);
    if (!buttons.length) {
      return null;
    }

    return buttons
      .slice()
      .sort(function (a, b) {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        let as = /^Add to Prompt$/i.test(textOf(a)) ? 1000 : 0;
        let bs = /^Add to Prompt$/i.test(textOf(b)) ? 1000 : 0;
        if (a.getAttribute("disabled") === null && a.getAttribute("aria-disabled") !== "true") as += 300;
        if (b.getAttribute("disabled") === null && b.getAttribute("aria-disabled") !== "true") bs += 300;
        if (isCenterPointInteractable(a)) as += 500;
        if (isCenterPointInteractable(b)) bs += 500;
        as += Math.round(ar.width / 10);
        bs += Math.round(br.width / 10);
        return bs - as;
      })[0] || null;
  }

  function expandToAssetTile(el, needle) {
    if (!el) {
      return null;
    }

    const normalizedNeedle = String(needle || "").toLowerCase();
    let current = el;
    let best = el;

    for (let depth = 0; current && depth < 7; depth += 1) {
      const text = textOf(current).toLowerCase();
      if (normalizedNeedle && text.indexOf(normalizedNeedle) === -1) {
        break;
      }

      const rect = current.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (DomUtils.isVisible(current) && area >= 1200 && area <= 260000) {
        best = current;
      }

      current = current.parentElement;
    }

    return best;
  }

  function findUploadedAssetByName(fileName) {
    const rawName = String(fileName || "").trim();
    if (!rawName) {
      return null;
    }

    const baseName = stripFileExtension(rawName);
    const prefixNeedles = [24, 20, 16, 12].map(function (size) {
      return baseName.length >= size ? baseName.slice(0, size) : "";
    });
    const needles = [rawName, baseName].concat(prefixNeedles)
      .map(function (item) { return item.toLowerCase(); })
      .filter(Boolean)
      .filter(function (item, index, arr) { return arr.indexOf(item) === index; });

    const candidates = Array.from(document.querySelectorAll("button,[role='button'],div,span,a,li"))
      .filter(DomUtils.isVisible)
      .map(function (el) {
        const text = textOf(el);
        const lower = text.toLowerCase();
        const matchedNeedle = needles.find(function (needle) {
          return needle && lower.indexOf(needle) !== -1;
        });
        if (!matchedNeedle) {
          return null;
        }

        const tile = expandToAssetTile(el, matchedNeedle) || el;
        const rect = tile.getBoundingClientRect();
        const area = rect.width * rect.height;
        let score = 0;
        if (isInViewport(tile)) score += 500;
        if (isCenterPointInteractable(tile)) score += 700;
        if (/Image/i.test(textOf(tile))) score += 100;
        score += Math.max(0, 200000 - Math.abs(area - 15000));
        score -= Math.max(0, area - 300000);

        return {
          element: tile,
          score,
          text: textOf(tile)
        };
      })
      .filter(Boolean);

    if (!candidates.length) {
      return null;
    }

    return candidates
      .sort(function (a, b) { return b.score - a.score; })[0]
      .element || null;
  }

  function isAddMediaPanelOpen() {
    return Boolean(findUploadMediaButton() || findAddToPromptButton());
  }

  scope.FlowSelectors = {
    SELECTORS,
    findPromptEditor,
    findCreateButtons,
    findCreateButton,
    findGeneratedImages,
    getCurrentGeneratedMediaIds,
    findImageCardForImage,
    findNearestImageContainerForMediaId,
    findMoreButtonForImageCard,
    findImageActionMoreButton,
    findImageDownloadMenu,
    findDownloadMenuItem,
    findOriginalSizeOption,
    findAddMediaButton,
    findPromptComposerAddButton,
    findReferencePanelUploadMediaButton,
    isReferencePromptPanelOpen,
    findUploadMediaButton,
    findReferenceFileInputs,
    findIAgreeButton,
    findAddToPromptButton,
    findUploadedAssetByName,
    isAddMediaPanelOpen,
    isInViewport,
    isCenterPointInteractable,
    getCenterPoint
  };
})();
