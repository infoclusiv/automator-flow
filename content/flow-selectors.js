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
    isInViewport,
    isCenterPointInteractable,
    getCenterPoint
  };
})();
