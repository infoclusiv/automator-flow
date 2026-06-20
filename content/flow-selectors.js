(function () {
  const scope = window.FlowExtension = window.FlowExtension || {};
  const DomUtils = scope.DomUtils;

  const SELECTORS = {
    promptEditor: '[role="textbox"][data-slate-editor="true"]',
    button: "button",
    generatedImages: 'img[alt="Generated image"]',
    menuItems: '[role="menuitem"], button[role="menuitem"], [role="menu"] [tabindex]'
  };

  function findPromptEditor() {
    return DomUtils.queryVisibleAll(SELECTORS.promptEditor).find(function (el) {
      return el.isContentEditable || el.getAttribute("contenteditable") === "true";
    }) || null;
  }

  function findCreateButtons() {
    return DomUtils.findVisibleByText(SELECTORS.button, /Create/i).filter(function (button) {
      const text = DomUtils.getVisibleText(button);
      return /arrow_forward\s*Create/i.test(text);
    });
  }

  function findCreateButton() {
    return findCreateButtons()[0] || null;
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

    let current = img;
    for (let depth = 0; current && depth < 8; depth += 1) {
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

      return current;
    }

    return null;
  }

  function findMoreButtonForImageCard(card) {
    if (!card) {
      return null;
    }

    const withinCard = Array.from(card.querySelectorAll("button,[role='button']")).filter(function (el) {
      return DomUtils.isVisible(el) && /(?:more_vert\s*)?More/i.test(DomUtils.getVisibleText(el));
    });
    if (withinCard.length) {
      return withinCard[0];
    }

    const cardRect = card.getBoundingClientRect();
    const nearbyButtons = DomUtils.findVisibleByText("button,[role='button']", /(?:more_vert\s*)?More/i);
    return nearbyButtons.find(function (button) {
      const rect = button.getBoundingClientRect();
      const horizontallyAligned = rect.left >= cardRect.left - 40 && rect.right <= cardRect.right + 80;
      const verticallyAligned = rect.top >= cardRect.top - 40 && rect.bottom <= cardRect.bottom + 80;
      return horizontallyAligned && verticallyAligned;
    }) || null;
  }

  function findDownloadMenuItem() {
    const menuItems = DomUtils.queryVisibleAll(SELECTORS.menuItems);
    return menuItems.find(function (el) {
      return /(?:download\s*)?Download/i.test(DomUtils.getVisibleText(el));
    }) || null;
  }

  function findOriginalSizeOption() {
    const menuItems = DomUtils.queryVisibleAll(SELECTORS.menuItems);
    const direct = menuItems.find(function (el) {
      return /1K\s*Original size/i.test(DomUtils.getVisibleText(el));
    });

    if (direct) {
      return direct;
    }

    const nested = Array.from(document.querySelectorAll("*")).filter(function (el) {
      return DomUtils.isVisible(el) && /1K\s*Original size/i.test(DomUtils.getVisibleText(el));
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
    findMoreButtonForImageCard,
    findDownloadMenuItem,
    findOriginalSizeOption
  };
})();
