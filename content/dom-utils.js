(function () {
  const scope = window.FlowExtension = window.FlowExtension || {};

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    if (style.opacity === "0") {
      return false;
    }

    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getVisibleText(el) {
    if (!el) {
      return "";
    }

    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  async function waitFor(conditionFn, options) {
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 10000;
    const intervalMs = options && options.intervalMs ? options.intervalMs : 250;
    const description = options && options.description ? options.description : "condition";
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const result = await conditionFn();
      if (result) {
        return result;
      }
      await sleep(intervalMs);
    }

    const error = new Error("Timed out waiting for " + description);
    error.code = "WAIT_FOR_TIMEOUT";
    error.details = {
      description,
      timeoutMs
    };
    throw error;
  }

  function queryVisibleAll(selector, root) {
    const base = root || document;
    return Array.from(base.querySelectorAll(selector)).filter(isVisible);
  }

  function findVisibleByText(selector, regex, root) {
    return queryVisibleAll(selector, root).filter(function (el) {
      return regex.test(getVisibleText(el));
    });
  }

  function scrollIntoViewCentered(el) {
    if (!el || typeof el.scrollIntoView !== "function") {
      return;
    }

    el.scrollIntoView({
      behavior: "auto",
      block: "center",
      inline: "center"
    });
  }

  function dispatchMouseSequence(el) {
    const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const eventName of events) {
      el.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      }));
    }
  }

  async function clickElement(el) {
    if (!el) {
      return false;
    }

    scrollIntoViewCentered(el);
    await sleep(80);

    try {
      dispatchMouseSequence(el);
    } catch (error) {
      if (typeof el.click === "function") {
        el.click();
      }
    }

    if (typeof el.click === "function") {
      el.click();
    }

    return true;
  }

  async function hoverElement(el) {
    if (!el) {
      return false;
    }

    scrollIntoViewCentered(el);
    await sleep(50);

    const rect = el.getBoundingClientRect();
    const clientX = rect.left + Math.max(4, rect.width / 2);
    const clientY = rect.top + Math.max(4, rect.height / 2);
    const events = ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"];

    for (const eventName of events) {
      el.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        view: window
      }));
    }

    return true;
  }

  function selectAllTextInElement(el) {
    if (!el) {
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function dispatchInputEvents(el, inputType, data) {
    try {
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: inputType || "insertText",
        data: data || null
      }));
    } catch (error) {
      el.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
    }

    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: inputType || "insertText",
        data: data || null
      }));
    } catch (error) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function getMediaIdFromUrl(url) {
    if (!url) {
      return null;
    }

    const match = String(url).match(/media\.getMediaUrlRedirect\?name=([^&]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  }

  scope.DomUtils = {
    sleep,
    isVisible,
    getVisibleText,
    waitFor,
    queryVisibleAll,
    findVisibleByText,
    scrollIntoViewCentered,
    dispatchMouseSequence,
    clickElement,
    hoverElement,
    selectAllTextInElement,
    dispatchInputEvents,
    getMediaIdFromUrl
  };
})();
