/* global chrome, IRCTCUtils */

(function () {
  const {
    IRCTC_URLS,
    sleep,
    humanDelay,
    clearAndType,
    dispatchAllEvents,
    normalizeText,
    serializeDomForGemini,
    callGeminiSelector,
    getStorage,
    setStorage,
    STORAGE_KEYS,
    scoreTrainRecommendation,
    NATIONALITY_DEFAULT
  } = IRCTCUtils;

  const SELECTORS = {
    fromStation: [
      "input[aria-controls='pr_id_1_list']",
      "input[placeholder*='From']",
      "input[formcontrolname='origin']"
    ],
    toStation: [
      "input[aria-controls='pr_id_2_list']",
      "input[placeholder*='To']",
      "input[formcontrolname='destination']"
    ],
    journeyDate: [
      "input[placeholder*='Journey Date']",
      "input[formcontrolname='journeyDate']",
      "input[type='text'][readonly]"
    ],
    classDropdown: [
      "p-dropdown[formcontrolname='journeyClass']",
      "p-dropdown[optionlabel='label']",
      ".train-search-box p-dropdown"
    ],
    quotaDropdown: [
      "p-dropdown[formcontrolname='quota']",
      "p-dropdown[placeholder*='Quota']",
      ".ui-dropdown"
    ],
    searchButton: [
      "button.search_btn",
      "button[label='Find Trains']",
      "button[type='submit']"
    ],
    autocompleteItems: [
      ".ui-autocomplete-panel .ui-autocomplete-items .ui-autocomplete-item",
      ".p-autocomplete-panel .p-autocomplete-items .p-autocomplete-item",
      "li[role='option']"
    ],
    addPassengerButton: [
      "button[aria-label*='Add Passenger']",
      "button span.pi-plus",
      "button:has(.fa-plus)"
    ],
    passengerRows: [
      "app-passenger .passenger-detail-card",
      ".passenger-info",
      ".passenger-list > div"
    ],
    continueButton: [
      "button span:where(:not(script))",
      "button"
    ]
  };

  const contentState = {
    activeConfig: null,
    widgetMounted: false,
    observerStarted: false,
    widgetData: null
  };

  init();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  async function init() {
    mountAssistantWidget();
    await loadWidgetState();
    await notifyPageReady();
    observeUrlChanges();
    if (isTrainListPage(location.href)) {
      await showReadyBadge();
      await maybeGenerateTrainRecommendation();
    }
    if (isPaymentPage(location.href)) {
      await showPaymentToast();
      await reportBookingCompleted();
    }
  }

  function observeUrlChanges() {
    if (contentState.observerStarted) {
      return;
    }
    contentState.observerStarted = true;
    let lastHref = location.href;
    const observer = new MutationObserver(async () => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        mountAssistantWidget();
        await loadWidgetState();
        await notifyPageReady();
        if (isTrainListPage(location.href)) {
          await showReadyBadge();
          await maybeGenerateTrainRecommendation();
        }
        if (isPaymentPage(location.href)) {
          await showPaymentToast();
          await reportBookingCompleted();
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case "BACKGROUND_PAGE_READY":
        return {};
      case "START_PAGE_AUTOMATION":
      case "RUN_AVAILABILITY_PAGE1":
        return runSearchAutomation(message.journeyConfig, message.type === "RUN_AVAILABILITY_PAGE1");
      case "RUN_PAX_AUTOMATION":
        return runPassengerAutomation(message.journeyConfig);
      case "SHOW_READY_BADGE":
        await showReadyBadge();
        await maybeGenerateTrainRecommendation(message.journeyConfig);
        return {};
      case "SCRAPE_AVAILABILITY_RESULTS":
        return scrapeAvailabilityAndSend(message.journeyConfig);
      case "SHOW_PAYMENT_TOAST":
        await showPaymentToast();
        return {};
      default:
        return {};
    }
  }

  async function notifyPageReady() {
    await safeSendRuntimeMessage({
      type: "PAGE_READY",
      payload: {
        url: location.href
      }
    });
  }

  async function runSearchAutomation(journeyConfig, isAvailabilityMode) {
    contentState.activeConfig = journeyConfig;
    await updateStatus("active", isAvailabilityMode ? "Checking availability on IRCTC..." : "Filling journey search form...", [
      { label: "Waiting for search form", state: "active" }
    ]);

    const fromInput = await findElement("From station field", SELECTORS.fromStation);
    const toInput = await findElement("To station field", SELECTORS.toStation);
    const dateInput = await findElement("Journey date field", SELECTORS.journeyDate);
    const searchButton = await findElement("Search Trains button", SELECTORS.searchButton);

    await clearAndType(fromInput, journeyConfig.fromStation);
    await humanDelay();
    await selectAutocompleteOption(journeyConfig.fromStation);

    await clearAndType(toInput, journeyConfig.toStation);
    await humanDelay();
    await selectAutocompleteOption(journeyConfig.toStation);

    await setDateInput(dateInput, journeyConfig.journeyDate);

    if (journeyConfig.journeyClass && journeyConfig.journeyClass !== "All Classes") {
      await trySelectDropdown("Journey class", journeyConfig.journeyClass);
    }

    await trySelectDropdown("Quota", journeyConfig.quota);

    await updateStatus("active", "Search form completed. Submitting train search...", [
      { label: "Search fields filled", state: "complete" },
      { label: "Submitting train search", state: "active" }
    ]);

    await humanDelay(140, 260);
    searchButton.click();
    return { submitted: true };
  }

  async function selectAutocompleteOption(targetValue) {
    const option = await waitForMatchingOption(targetValue);
    if (!option) {
      throw await createUserVisibleError(`Could not match station autocomplete option for "${targetValue}".`);
    }
    option.click();
    await humanDelay();
  }

  async function waitForMatchingOption(targetValue) {
    const wanted = normalizeText(targetValue);
    const timeoutAt = Date.now() + 8000;

    while (Date.now() < timeoutAt) {
      const items = SELECTORS.autocompleteItems.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      const match = items.find((item) => normalizeText(item.textContent).includes(wanted) || wanted.includes(normalizeText(item.textContent)));
      if (match) {
        return match;
      }
      await sleep(200);
    }
    return null;
  }

  async function setDateInput(input, isoDate) {
    if (!input) {
      throw await createUserVisibleError("Journey date field is missing.");
    }
    const displayDate = formatDateForIrctc(isoDate);
    input.removeAttribute("readonly");
    input.focus();
    input.value = displayDate;
    dispatchAllEvents(input);
    await humanDelay();
  }

  function formatDateForIrctc(isoDate) {
    const [year, month, day] = String(isoDate).split("-");
    return `${day}/${month}/${year}`;
  }

  async function trySelectDropdown(purpose, value) {
    const fallbackMap = {
      "Journey class": SELECTORS.classDropdown,
      Quota: SELECTORS.quotaDropdown
    };

    const dropdown = await findElement(`${purpose} dropdown`, fallbackMap[purpose] || []);
    await clickAngularDropdown(dropdown, value, purpose);
  }

  async function clickAngularDropdown(dropdown, value, purpose) {
    const clickTarget = resolveDropdownClickTarget(dropdown);
    clickTarget.click();
    await humanDelay(150, 260);
    const option = await waitForDropdownOption(value);
    if (!option) {
      const currentLabel = getDropdownDisplayedText(dropdown);
      const alreadySelected = matchesDropdownValue(currentLabel, value);

      if (alreadySelected) {
        return;
      }

      if (purpose === "Journey class") {
        await updateStatus("ready", `Could not set ${purpose} to "${value}". Continuing with "${currentLabel || "All Classes"}" so you can choose class manually on the train list.`, [
          { label: "Route details filled", state: "complete" },
          { label: `Using ${currentLabel || "All Classes"} for search`, state: "active" }
        ]);
        return;
      }

      throw await createUserVisibleError(`Could not select ${purpose}: "${value}".`);
    }
    option.click();
    await humanDelay();
  }

  async function waitForDropdownOption(value) {
    const target = normalizeText(value);
    const timeoutAt = Date.now() + 6000;
    while (Date.now() < timeoutAt) {
      const candidates = Array.from(document.querySelectorAll(".p-dropdown-item, .ui-dropdown-item, li[role='option'], span"))
        .filter((node) => matchesDropdownValue(node.textContent, value));
      if (candidates.length) {
        return candidates[0];
      }
      await sleep(180);
    }
    return null;
  }

  function resolveDropdownClickTarget(dropdown) {
    return dropdown.matches(".ui-dropdown, .p-dropdown")
      ? dropdown
      : dropdown.querySelector(".ui-dropdown, .p-dropdown, .ui-dropdown-label-container, [role='listbox'], input[role='listbox']") || dropdown;
  }

  function getDropdownDisplayedText(dropdown) {
    const source = dropdown.matches(".ui-dropdown, .p-dropdown")
      ? dropdown
      : dropdown.querySelector(".ui-dropdown, .p-dropdown, .ui-dropdown-label, [role='listbox']") || dropdown;
    return normalizeText(source.textContent || source.getAttribute("aria-label") || "");
  }

  function matchesDropdownValue(candidateText, requestedValue) {
    const candidate = normalizeText(candidateText);
    const requested = normalizeText(requestedValue);

    if (!candidate || !requested) {
      return false;
    }

    if (candidate.includes(requested) || requested.includes(candidate)) {
      return true;
    }

    const aliasMap = {
      "3a": ["ac 3 tier", "ac 3 tier (3a)", "third ac", "3 tier"],
      "2a": ["ac 2 tier", "ac 2 tier (2a)", "second ac", "2 tier"],
      "1a": ["ac first class", "ac first class (1a)", "first ac"],
      "sl": ["sleeper", "sleeper (sl)"],
      "general": ["general", "gn"],
      "tatkal": ["tatkal", "tk"],
      "premium tatkal": ["premium tatkal", "pt"],
      "ladies": ["ladies", "ld"],
      "senior citizen": ["senior citizen", "ss"]
    };

    const aliases = aliasMap[requested] || [];
    return aliases.some((alias) => candidate.includes(alias));
  }

  async function runPassengerAutomation(journeyConfig) {
    contentState.activeConfig = journeyConfig;
    await updateStatus("active", "Passenger details page detected. Filling passengers...", [
      { label: "Waiting for passenger details page", state: "complete" },
      { label: "Filling passenger cards", state: "active" }
    ]);

    const selectedPassengers = journeyConfig.selectedPassengers || [];
    if (!selectedPassengers.length) {
      throw await createUserVisibleError("No passengers were selected in the extension.");
    }

    for (let index = 0; index < selectedPassengers.length; index += 1) {
      if (index > 0) {
        await ensurePassengerRow(index);
      }
      const row = await getPassengerRow(index);
      await fillPassengerRow(row, selectedPassengers[index], index);
    }

    await fillContactAndPreferences(journeyConfig);

    await updateStatus("active", "Passenger form ready. Waiting for your confirmation...", [
      { label: "Passenger details filled", state: "complete" },
      { label: "Preferences applied", state: "complete" },
      { label: "Awaiting confirmation overlay", state: "active" }
    ]);

    const confirmed = await showConfirmationOverlay(journeyConfig);
    if (!confirmed) {
      await updateStatus("ready", "AutoFill paused for manual edits.", [
        { label: "Passenger details filled", state: "complete" },
        { label: "Paused for manual review", state: "active" }
      ]);
      return { paused: true };
    }

    const continueButton = await findContinueButton();
    continueButton.click();
    await updateStatus("active", "Continuing to payment handoff...", [
      { label: "Passenger details filled", state: "complete" },
      { label: "User confirmed details", state: "complete" },
      { label: "Opening next step", state: "active" }
    ]);
    return { continued: true };
  }

  async function ensurePassengerRow(index) {
    const currentRows = await getPassengerRows();
    if (currentRows[index]) {
      return;
    }
    const addButton = await findButtonByText(/\+?\s*add passenger/i);
    if (!addButton) {
      throw await createUserVisibleError(`Could not add passenger ${index + 1}.`);
    }
    addButton.click();
    await humanDelay(220, 320);
  }

  async function getPassengerRows() {
    const timeoutAt = Date.now() + 8000;
    while (Date.now() < timeoutAt) {
      for (const selector of SELECTORS.passengerRows) {
        const rows = Array.from(document.querySelectorAll(selector));
        if (rows.length) {
          return rows;
        }
      }
      const fallback = Array.from(document.querySelectorAll("input")).filter((input) => /name/i.test(input.getAttribute("placeholder") || ""));
      if (fallback.length) {
        return fallback.map((input) => input.closest("div, form, section") || input.parentElement).filter(Boolean);
      }
      await sleep(220);
    }
    return [];
  }

  async function getPassengerRow(index) {
    const rows = await getPassengerRows();
    if (!rows[index]) {
      throw await createUserVisibleError(`Passenger row ${index + 1} is not available.`);
    }
    return rows[index];
  }

  async function fillPassengerRow(row, passenger, index) {
    const nameInput = await findWithinRow(row, ["input[placeholder*='Name']", "input[name*='name']", "input"]);
    const ageInput = await findWithinRow(row, ["input[placeholder*='Age']", "input[name*='age']", "input[type='number']"]);
    const genderDropdown = await findWithinRow(row, ["p-dropdown[formcontrolname*='gender']", ".ui-dropdown", "p-dropdown"]);
    const nationalityDropdown = await findWithinRow(row, ["p-dropdown[formcontrolname*='nationality']", "p-dropdown", ".ui-dropdown"], { skipIfMissing: true, offset: 1 });
    const berthDropdown = await findWithinRow(row, ["p-dropdown[formcontrolname*='berth']", ".ui-dropdown", "p-dropdown"], { skipIfMissing: true, offset: 2 });

    await clearAndType(nameInput, passenger.fullName);
    await humanDelay();
    await clearAndType(ageInput, String(passenger.age));
    await humanDelay();
    await clickAngularDropdown(genderDropdown, passenger.gender, `Gender for passenger ${index + 1}`);

    if (nationalityDropdown) {
      await clickAngularDropdown(nationalityDropdown, NATIONALITY_DEFAULT, `Nationality for passenger ${index + 1}`);
    }

    if (berthDropdown) {
      await clickAngularDropdown(berthDropdown, passenger.berthPreference, `Berth preference for passenger ${index + 1}`);
    }
  }

  async function fillContactAndPreferences(journeyConfig) {
    const { [STORAGE_KEYS.DEFAULT_PREFERENCES]: defaults = {} } = await getStorage([STORAGE_KEYS.DEFAULT_PREFERENCES]);
    const fallbackMobile = journeyConfig.preferences?.fallbackMobile || defaults.fallbackMobile || "";
    const mobileInput = await findByLabelText(/mobile/i, { skipIfMissing: true });
    if (mobileInput && !mobileInput.value.trim() && fallbackMobile) {
      await clearAndType(mobileInput, fallbackMobile);
    }

    await setCheckboxByLabel(/auto upgrad/i, Boolean(journeyConfig.preferences?.autoUpgrade), true);
    await setCheckboxByLabel(/confirm berth/i, Boolean(journeyConfig.preferences?.onlyConfirmBerths), true);

    if (journeyConfig.preferences?.reservationChoice) {
      const reservationInput = await findByLabelText(/reservation choice|choice/i, { skipIfMissing: true });
      if (reservationInput) {
        if (reservationInput.tagName === "INPUT") {
          await clearAndType(reservationInput, journeyConfig.preferences.reservationChoice);
        } else {
          await clickAngularDropdown(reservationInput, journeyConfig.preferences.reservationChoice, "Reservation Choice");
        }
      }
    }

    if (journeyConfig.preferences?.preferredCoach) {
      const coachInput = await findByLabelText(/preferred coach|coach/i, { skipIfMissing: true });
      if (coachInput) {
        await clearAndType(coachInput, journeyConfig.preferences.preferredCoach);
      }
    }

    await setRadioByLabel(/travel insurance/i, journeyConfig.preferences?.travelInsurance ? "yes" : "no");
    await setPaymentMode(journeyConfig.preferences?.paymentMode);
  }

  async function setCheckboxByLabel(pattern, checked, skipIfMissing = false) {
    const checkbox = await findCheckboxByLabel(pattern, skipIfMissing);
    if (!checkbox) {
      return;
    }
    if (checkbox.checked !== checked) {
      checkbox.click();
      await humanDelay();
    }
  }

  async function setRadioByLabel(groupPattern, expectedValue) {
    const blocks = Array.from(document.querySelectorAll("label, div, section"));
    const block = blocks.find((node) => groupPattern.test(normalizeText(node.textContent)));
    if (!block) {
      return;
    }
    const radio = Array.from(block.querySelectorAll("input[type='radio']")).find((input) => normalizeText(input.value || input.parentElement?.textContent).includes(expectedValue));
    if (radio && !radio.checked) {
      radio.click();
      await humanDelay();
    }
  }

  async function setPaymentMode(mode) {
    if (!mode) {
      return;
    }
    const target = normalizeText(mode);
    const radio = Array.from(document.querySelectorAll("input[type='radio']")).find((input) => {
      const wrapperText = normalizeText(input.closest("label, div, section")?.textContent);
      return wrapperText.includes(target);
    });
    if (radio && !radio.checked) {
      radio.click();
      await humanDelay();
    }
  }

  async function findContinueButton() {
    const byText = await findButtonByText(/continue/i);
    if (byText) {
      return byText;
    }
    throw await createUserVisibleError("Could not find the Continue button.");
  }

  async function scrapeAvailabilityAndSend(journeyConfig) {
    await showReadyBadge("Checking availability results...");
    const results = await scrapeAvailabilityResults();
    await safeSendRuntimeMessage({
      type: "AVAILABILITY_RESULTS",
      payload: {
        alertId: journeyConfig.alertId || null,
        requestId: journeyConfig.id,
        route: `${journeyConfig.fromStation} -> ${journeyConfig.toStation}`,
        results
      }
    });
    return { results };
  }

  async function scrapeAvailabilityResults() {
    await waitForTrainCards();
    const classes = ["SL", "3A", "2A"];
    const results = {
      SL: "Not found",
      "3A": "Not found",
      "2A": "Not found"
    };

    const cardTexts = Array.from(document.querySelectorAll("app-train-list, .train-avl-enq-box, .train-list .train-row, .tbis-div"))
      .map((node) => node.textContent || "")
      .join("\n");

    classes.forEach((className) => {
      const matcher = new RegExp(`${className}[\\s\\S]{0,80}?(AVAILABLE[^\\n]*|AVL[^\\n]*|WL[^\\n]*|RAC[^\\n]*|REGRET[^\\n]*)`, "i");
      const match = cardTexts.match(matcher);
      if (match) {
        results[className] = match[1].trim();
      }
    });

    return results;
  }

  async function maybeGenerateTrainRecommendation(journeyConfig = null) {
    try {
      await waitForTrainCards();
      const activeJourney = journeyConfig || (await getActiveJourneyFromStorage());
      const trains = parseTrainCards();
      const best = scoreTrainRecommendation(trains, activeJourney?.journeyClass || "3A");
      if (!best?.train) {
        return;
      }

      const summary = `Recommended: ${best.train.trainName} (${best.train.trainNumber}) leaving ${best.train.departure}. Best visible availability: ${Object.entries(best.train.availability || {}).map(([key, value]) => `${key} ${value}`).join(", ")}.`;
      await safeSendRuntimeMessage({
        type: "SAVE_RECOMMENDATION",
        payload: {
          summary,
          recommendedTrain: best.train,
          createdAt: new Date().toISOString()
        }
      });
    } catch (error) {
      /* Intentionally soft-fail on recommendation work. */
    }
  }

  function parseTrainCards() {
    const cards = Array.from(document.querySelectorAll("app-train-list, .train-avl-enq-box, .train-list .train-row, .tbis-div"));
    return cards.slice(0, 10).map((card) => {
      const text = card.textContent || "";
      const trainNumber = text.match(/\b\d{5}\b/)?.[0] || "";
      const departure = text.match(/\b\d{2}:\d{2}\b/)?.[0] || "";
      const nameNode = card.querySelector(".train-heading, .train-name, strong, h5");
      const trainName = (nameNode?.textContent || text.split("\n")[0] || "").trim();
      const availability = {};
      ["SL", "3A", "2A", "1A"].forEach((className) => {
        const match = text.match(new RegExp(`${className}[\\s\\S]{0,70}?(AVAILABLE[^\\n]*|AVL[^\\n]*|WL[^\\n]*|RAC[^\\n]*)`, "i"));
        if (match) {
          availability[className] = match[1].trim();
        }
      });
      return {
        trainName,
        trainNumber,
        departure,
        availability
      };
    });
  }

  async function reportBookingCompleted() {
    const trainName = document.querySelector(".train-heading, .train-name, h5")?.textContent?.trim() || "";
    await safeSendRuntimeMessage({
      type: "BOOKING_COMPLETED",
      payload: { trainName }
    });
  }

  async function getActiveJourneyFromStorage() {
    const { [STORAGE_KEYS.ACTIVE_BOOKING]: activeBooking } = await getStorage([STORAGE_KEYS.ACTIVE_BOOKING]);
    return activeBooking?.journeyConfig || null;
  }

  async function waitForTrainCards() {
    const timeoutAt = Date.now() + 12000;
    while (Date.now() < timeoutAt) {
      const cards = document.querySelectorAll("app-train-list, .train-avl-enq-box, .train-list .train-row, .tbis-div");
      if (cards.length) {
        return cards;
      }
      await sleep(250);
    }
    throw new Error("Train list did not render in time");
  }

  async function findElement(purpose, selectors) {
    const timeoutAt = Date.now() + 10000;
    while (Date.now() < timeoutAt) {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && isVisible(element)) {
          return element;
        }
      }
      await sleep(200);
    }
    const geminiRecovered = await findWithGeminiFallback(purpose, selectors);
    if (geminiRecovered) {
      return geminiRecovered;
    }
    throw await createUserVisibleError(`Failed to find ${purpose}.`);
  }

  async function findWithinRow(row, selectors, options = {}) {
    const { skipIfMissing = false, offset = 0 } = options;
    const matches = [];
    selectors.forEach((selector) => {
      matches.push(...Array.from(row.querySelectorAll(selector)));
    });
    const unique = matches.filter((element, index) => matches.indexOf(element) === index);
    if (unique[offset]) {
      return unique[offset];
    }
    if (skipIfMissing) {
      return null;
    }
    throw await createUserVisibleError("A passenger detail field is missing on the page.");
  }

  async function findWithGeminiFallback(purpose, selectors) {
    try {
      const { [STORAGE_KEYS.GEMINI_API_KEY]: geminiApiKey } = await getStorage([STORAGE_KEYS.GEMINI_API_KEY]);
      if (!geminiApiKey) {
        return null;
      }
      const result = await callGeminiSelector({
        apiKey: geminiApiKey,
        purpose,
        url: location.href,
        selectorHints: selectors,
        domSummary: serializeDomForGemini(document)
      });
      if (result?.selector) {
        const element = document.querySelector(result.selector);
        if (element) {
          return element;
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  async function findByLabelText(pattern, options = {}) {
    const { skipIfMissing = false } = options;
    const labels = Array.from(document.querySelectorAll("label"));
    for (const label of labels) {
      if (pattern.test(normalizeText(label.textContent))) {
        const targetId = label.getAttribute("for");
        if (targetId) {
          const linked = document.getElementById(targetId);
          if (linked) {
            return linked;
          }
        }
        const nestedInput = label.querySelector("input, p-dropdown, select, textarea");
        if (nestedInput) {
          return nestedInput;
        }
      }
    }
    if (skipIfMissing) {
      return null;
    }
    throw await createUserVisibleError(`Field matching ${pattern} was not found.`);
  }

  async function findCheckboxByLabel(pattern, skipIfMissing = false) {
    const wrappers = Array.from(document.querySelectorAll("label, div, section"));
    const wrapper = wrappers.find((node) => pattern.test(normalizeText(node.textContent)));
    const checkbox = wrapper?.querySelector("input[type='checkbox']");
    if (checkbox) {
      return checkbox;
    }
    if (skipIfMissing) {
      return null;
    }
    throw await createUserVisibleError(`Checkbox matching ${pattern} was not found.`);
  }

  async function findButtonByText(pattern) {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    return buttons.find((button) => pattern.test(normalizeText(button.textContent))) || null;
  }

  async function createUserVisibleError(message, targetElement = null) {
    if (targetElement) {
      highlightProblem(targetElement);
    }
    await updateStatus("error", message, [
      { label: "Automation paused", state: "error", detail: message }
    ]);
    await safeSendRuntimeMessage({
      type: "SHOW_NOTIFICATION",
      payload: {
        title: "IRCTC AutoFill Assistant",
        message: `AutoFill paused — ${message}`
      }
    });
    alert(`IRCTC AutoFill Assistant: ${message}`);
    return new Error(message);
  }

  function highlightProblem(element) {
    if (!element) {
      return;
    }
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    const previousOutline = element.style.outline;
    element.style.outline = "3px solid #d62839";
    setTimeout(() => {
      element.style.outline = previousOutline;
    }, 4500);
  }

  async function updateStatus(phase, message, steps) {
    await safeSendRuntimeMessage({
      type: "UPDATE_STATUS",
      payload: {
        phase,
        message,
        steps
      }
    });
    updateWidgetStatus(phase, message);
  }

  async function safeSendRuntimeMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return null;
    }
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function mountAssistantWidget() {
    if (document.getElementById("irctc-autofill-widget")) {
      updateWidgetStatus("ready", widgetMessageForPage());
      return;
    }

    const widget = document.createElement("div");
    widget.id = "irctc-autofill-widget";
    widget.innerHTML = `
      <div class="irctc-autofill-card">
        <div class="irctc-autofill-header">
          <strong>IRCTC AutoFill Assistant</strong>
          <button type="button" id="irctc-autofill-minimize" aria-label="Minimize">−</button>
        </div>
        <div class="irctc-autofill-body">
          <p id="irctc-autofill-status">${escapeHtml(widgetMessageForPage())}</p>
          <div class="irctc-autofill-route-grid">
            <label>
              <span>Fav Departure</span>
              <input id="irctc-widget-from" type="text" list="irctc-autofill-stations-list" placeholder="NDLS - New Delhi">
            </label>
            <label>
              <span>Fav Arrival</span>
              <input id="irctc-widget-to" type="text" list="irctc-autofill-stations-list" placeholder="BCT - Mumbai Central">
            </label>
          </div>
          <div class="irctc-autofill-mode-buttons">
            <button type="button" id="irctc-widget-family-btn" class="irctc-widget-chip">Select Family</button>
            <button type="button" id="irctc-widget-single-btn" class="irctc-widget-chip">Select Single Member</button>
          </div>
          <div class="irctc-autofill-route-grid">
            <label>
              <span>Family Group</span>
              <select id="irctc-widget-group"></select>
            </label>
            <label>
              <span>Single Member</span>
              <select id="irctc-widget-passenger"></select>
            </label>
          </div>
          <div class="irctc-autofill-mini-actions">
            <button type="button" id="irctc-widget-save">Save Favorites</button>
            <button type="button" id="irctc-autofill-open-options">Manage Profiles</button>
          </div>
          <div class="irctc-autofill-primary-actions">
            <button type="button" id="irctc-widget-start" class="irctc-widget-start">Start Job</button>
          </div>
        </div>
      </div>
      <datalist id="irctc-autofill-stations-list"></datalist>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #irctc-autofill-widget {
        position: fixed;
        right: 16px;
        top: 86px;
        z-index: 2147483646;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      }
      .irctc-autofill-card {
        width: 340px;
        border-radius: 18px;
        background: linear-gradient(180deg, rgba(26, 35, 126, 0.96), rgba(26, 35, 126, 0.82));
        color: #fff;
        box-shadow: 0 22px 55px rgba(20, 35, 90, 0.28);
        overflow: hidden;
      }
      .irctc-autofill-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 14px;
        font-size: 13px;
      }
      .irctc-autofill-header button,
      .irctc-autofill-mini-actions button {
        border: 0;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.16);
        color: #fff;
        padding: 6px 10px;
        cursor: pointer;
      }
      .irctc-autofill-body {
        padding: 0 14px 14px;
      }
      .irctc-autofill-body p {
        margin: 0 0 10px;
        font-size: 12px;
        line-height: 1.45;
      }
      .irctc-autofill-route-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 10px;
      }
      .irctc-autofill-route-grid label {
        display: block;
      }
      .irctc-autofill-route-grid span {
        display: block;
        margin-bottom: 4px;
        font-size: 11px;
        opacity: 0.82;
      }
      .irctc-autofill-route-grid input,
      .irctc-autofill-route-grid select {
        width: 100%;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        padding: 8px 10px;
        font-size: 12px;
      }
      .irctc-autofill-route-grid input::placeholder {
        color: rgba(255,255,255,0.72);
      }
      .irctc-autofill-mode-buttons {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 10px;
      }
      .irctc-widget-chip {
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        color: #fff;
        padding: 8px 10px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .irctc-widget-chip.active {
        background: rgba(255, 109, 0, 0.88);
        border-color: rgba(255, 109, 0, 1);
      }
      .irctc-autofill-mini-actions {
        display: flex;
        gap: 8px;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .irctc-autofill-primary-actions {
        display: flex;
      }
      .irctc-widget-start {
        width: 100%;
        border: 0;
        border-radius: 12px;
        background: linear-gradient(135deg, #ff6d00, #ff8f3a);
        color: #fff;
        padding: 11px 12px;
        font-size: 14px;
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 12px 24px rgba(255, 109, 0, 0.24);
      }
      #irctc-autofill-widget.minimized .irctc-autofill-body {
        display: none;
      }
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(widget);

    widget.querySelector("#irctc-autofill-minimize").addEventListener("click", () => {
      widget.classList.toggle("minimized");
    });
    widget.querySelector("#irctc-autofill-open-options").addEventListener("click", async () => {
      await safeSendRuntimeMessage({ type: "OPEN_OPTIONS" });
    });
    widget.querySelector("#irctc-widget-save").addEventListener("click", saveWidgetPreferences);
    widget.querySelector("#irctc-widget-start").addEventListener("click", startWidgetBooking);
    widget.querySelector("#irctc-widget-family-btn").addEventListener("click", () => setWidgetMode("family"));
    widget.querySelector("#irctc-widget-single-btn").addEventListener("click", () => setWidgetMode("single"));
    contentState.widgetMounted = true;
  }

  async function loadWidgetState() {
    const response = await safeSendRuntimeMessage({ type: "GET_EXTENSION_STATE" });
    if (!response?.ok) {
      return;
    }

    contentState.widgetData = {
      passengers: response.passengers || [],
      groups: response.groups || [],
      savedStations: response.savedStations || [],
      journeyDraft: response.journeyDraft || null,
      defaultPreferences: response.defaultPreferences || {},
      quickWidgetSettings: response.quickWidgetSettings || {}
    };

    renderWidgetControls();
    updateWidgetStatus("ready", widgetMessageForPage());
  }

  function renderWidgetControls() {
    const widget = document.getElementById("irctc-autofill-widget");
    if (!widget || !contentState.widgetData) {
      return;
    }

    const { passengers, groups, savedStations, journeyDraft, quickWidgetSettings } = contentState.widgetData;
    const fromInput = widget.querySelector("#irctc-widget-from");
    const toInput = widget.querySelector("#irctc-widget-to");
    const groupSelect = widget.querySelector("#irctc-widget-group");
    const passengerSelect = widget.querySelector("#irctc-widget-passenger");
    const stationsList = widget.querySelector("#irctc-autofill-stations-list");

    fromInput.value = quickWidgetSettings.favoriteFromStation || journeyDraft?.fromStation || "";
    toInput.value = quickWidgetSettings.favoriteToStation || journeyDraft?.toStation || "";

    stationsList.innerHTML = "";
    savedStations.forEach((station) => {
      const option = document.createElement("option");
      option.value = station;
      stationsList.appendChild(option);
    });

    groupSelect.innerHTML = "";
    passengerSelect.innerHTML = "";
    appendSelectOption(groupSelect, "", "Choose family group");
    appendSelectOption(passengerSelect, "", "Choose single member");

    groups.forEach((group) => appendSelectOption(groupSelect, group.id, group.name));
    passengers.forEach((passenger) => appendSelectOption(passengerSelect, passenger.id, passenger.fullName));

    groupSelect.value = quickWidgetSettings.favoriteGroupId || groups.find((group) => /family/i.test(group.name))?.id || "";
    passengerSelect.value = quickWidgetSettings.favoritePassengerId || passengers[0]?.id || "";

    setWidgetMode(quickWidgetSettings.selectionMode || "family", { persist: false });
  }

  function appendSelectOption(select, value, label) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

  function setWidgetMode(mode, options = {}) {
    const { persist = true } = options;
    const familyButton = document.getElementById("irctc-widget-family-btn");
    const singleButton = document.getElementById("irctc-widget-single-btn");
    const groupSelect = document.getElementById("irctc-widget-group");
    const passengerSelect = document.getElementById("irctc-widget-passenger");

    familyButton?.classList.toggle("active", mode === "family");
    singleButton?.classList.toggle("active", mode === "single");

    if (groupSelect) {
      groupSelect.disabled = mode !== "family";
      groupSelect.style.opacity = mode === "family" ? "1" : "0.55";
    }
    if (passengerSelect) {
      passengerSelect.disabled = mode !== "single";
      passengerSelect.style.opacity = mode === "single" ? "1" : "0.55";
    }

    if (contentState.widgetData) {
      contentState.widgetData.quickWidgetSettings = {
        ...(contentState.widgetData.quickWidgetSettings || {}),
        selectionMode: mode
      };
    }

    if (persist) {
      saveWidgetPreferences({ silent: true });
    }
  }

  async function saveWidgetPreferences(options = {}) {
    const { silent = false } = options;
    const widget = document.getElementById("irctc-autofill-widget");
    if (!widget || !contentState.widgetData) {
      return;
    }

    const payload = {
      selectionMode: contentState.widgetData.quickWidgetSettings?.selectionMode || "family",
      favoriteFromStation: widget.querySelector("#irctc-widget-from")?.value.trim() || "",
      favoriteToStation: widget.querySelector("#irctc-widget-to")?.value.trim() || "",
      favoriteGroupId: widget.querySelector("#irctc-widget-group")?.value || "",
      favoritePassengerId: widget.querySelector("#irctc-widget-passenger")?.value || ""
    };

    const response = await safeSendRuntimeMessage({
      type: "SAVE_QUICK_WIDGET_SETTINGS",
      payload
    });

    if (response?.ok) {
      contentState.widgetData.quickWidgetSettings = response.quickWidgetSettings || payload;
      contentState.widgetData.savedStations = response.savedStations || contentState.widgetData.savedStations;
      renderWidgetControls();
      if (!silent) {
        updateWidgetStatus("ready", "Favorites saved. Start Job will use these quick settings.");
      }
    }
  }

  async function startWidgetBooking() {
    if (!isSearchPage(location.href)) {
      updateWidgetStatus("error", "Start Job works from the IRCTC search page.");
      return;
    }

    await saveWidgetPreferences({ silent: true });
    const widget = document.getElementById("irctc-autofill-widget");
    const quickSettings = contentState.widgetData?.quickWidgetSettings || {};
    const groups = contentState.widgetData?.groups || [];
    const passengers = contentState.widgetData?.passengers || [];
    const journeyDraft = contentState.widgetData?.journeyDraft || {};
    const defaultPreferences = contentState.widgetData?.defaultPreferences || {};

    const fromStation = widget.querySelector("#irctc-widget-from")?.value.trim() || journeyDraft.fromStation || "";
    const toStation = widget.querySelector("#irctc-widget-to")?.value.trim() || journeyDraft.toStation || "";
    const selectionMode = quickSettings.selectionMode || "family";

    let selectedPassengerIds = [];
    if (selectionMode === "family") {
      const group = groups.find((entry) => entry.id === (widget.querySelector("#irctc-widget-group")?.value || quickSettings.favoriteGroupId));
      selectedPassengerIds = group?.passengerIds || [];
    } else {
      const passengerId = widget.querySelector("#irctc-widget-passenger")?.value || quickSettings.favoritePassengerId;
      selectedPassengerIds = passengerId ? [passengerId] : [];
    }

    selectedPassengerIds = selectedPassengerIds.filter((id) => passengers.some((passenger) => passenger.id === id)).slice(0, 6);

    if (!fromStation || !toStation) {
      updateWidgetStatus("error", "Add favorite departure and arrival before starting.");
      return;
    }

    if (!selectedPassengerIds.length) {
      updateWidgetStatus("error", selectionMode === "family" ? "Choose a family group with passengers." : "Choose a single passenger before starting.");
      return;
    }

    const payload = {
      fromStation,
      toStation,
      journeyDate: journeyDraft.journeyDate || IRCTCUtils.todayISO(),
      journeyClass: journeyDraft.journeyClass || "3A",
      quota: journeyDraft.quota || "General",
      passengerCount: selectedPassengerIds.length,
      selectedPassengerIds,
      preferences: {
        ...defaultPreferences,
        ...(journeyDraft.preferences || {})
      },
      tatkalRushMode: Boolean(journeyDraft.tatkalRushMode)
    };

    await safeSendRuntimeMessage({ type: "SAVE_JOURNEY_DRAFT", payload });
    const response = await safeSendRuntimeMessage({
      type: "START_BOOKING_FLOW",
      payload
    });

    if (response?.ok) {
      updateWidgetStatus("active", `Starting quick booking for ${fromStation} -> ${toStation}...`);
    } else {
      updateWidgetStatus("error", response?.error || "Could not start the booking job.");
    }
  }

  function updateWidgetStatus(phase, message) {
    const status = document.getElementById("irctc-autofill-status");
    if (!status) {
      return;
    }
    status.textContent = message || widgetMessageForPage();
    status.style.color = phase === "error" ? "#ffd7db" : "#ffffff";
  }

  function widgetMessageForPage() {
    if (isSearchPage(location.href)) {
      return "Assistant ready on IRCTC search. Use Start Job here for quick autofill.";
    }
    if (isTrainListPage(location.href)) {
      return "AutoFill is ready — select your train and click Book Now.";
    }
    if (isPaxDetailsPage(location.href)) {
      return "Passenger page detected. AutoFill will fill the form and pause before continuing.";
    }
    if (isPaymentPage(location.href)) {
      return "AutoFill complete — please proceed with payment.";
    }
    return "Assistant is active on IRCTC.";
  }

  async function showReadyBadge(message = "AutoFill is ready — select your train") {
    let badge = document.getElementById("irctc-autofill-ready-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "irctc-autofill-ready-badge";
      badge.style.cssText = [
        "position:fixed",
        "top:228px",
        "right:18px",
        "z-index:2147483645",
        "padding:10px 12px",
        "border-radius:14px",
        "background:#ffffff",
        "color:#1a237e",
        "box-shadow:0 12px 34px rgba(20,35,90,0.18)",
        "font:600 12px/1.35 'Segoe UI',sans-serif"
      ].join(";");
      document.body.appendChild(badge);
    }
    badge.textContent = message;
  }

  async function showPaymentToast() {
    let toast = document.getElementById("irctc-autofill-payment-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "irctc-autofill-payment-toast";
      toast.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:28px",
        "transform:translateX(-50%)",
        "z-index:2147483645",
        "padding:14px 18px",
        "border-radius:16px",
        "background:#1f9d57",
        "color:#fff",
        "font:700 13px/1.35 'Segoe UI',sans-serif",
        "box-shadow:0 18px 42px rgba(31,157,87,0.24)"
      ].join(";");
      document.body.appendChild(toast);
    }
    toast.textContent = "AutoFill complete — please proceed with payment";
    setTimeout(() => toast.remove(), 5000);
  }

  async function showConfirmationOverlay(journeyConfig) {
    return new Promise((resolve) => {
      const existing = document.getElementById("irctc-autofill-confirm-overlay");
      if (existing) {
        existing.remove();
      }

      const overlay = document.createElement("div");
      overlay.id = "irctc-autofill-confirm-overlay";
      overlay.style.cssText = [
        "position:fixed",
        "inset:0",
        "background:rgba(10,18,55,0.62)",
        "z-index:2147483647",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "padding:20px"
      ].join(";");

      const passengerNames = (journeyConfig.selectedPassengers || []).map((passenger) => passenger.fullName).join(", ");
      const panel = document.createElement("div");
      panel.style.cssText = [
        "max-width:520px",
        "width:100%",
        "border-radius:24px",
        "background:#fff",
        "color:#182038",
        "padding:22px",
        "box-shadow:0 28px 70px rgba(20,35,90,0.28)",
        "font:14px/1.5 'Segoe UI',sans-serif"
      ].join(";");
      panel.innerHTML = `
        <h2 style="margin:0 0 10px;color:#1a237e;">Confirm Filled Details</h2>
        <p style="margin:0 0 14px;color:#66718c;">Review the details before the extension clicks Continue.</p>
        <div style="display:grid;gap:10px;background:#f6f8ff;border:1px solid #dbe2ff;border-radius:16px;padding:14px;">
          <div><strong>Route:</strong> ${escapeHtml(journeyConfig.fromStation)} -> ${escapeHtml(journeyConfig.toStation)}</div>
          <div><strong>Date:</strong> ${escapeHtml(journeyConfig.journeyDate)}</div>
          <div><strong>Class / Quota:</strong> ${escapeHtml(`${journeyConfig.journeyClass} / ${journeyConfig.quota}`)}</div>
          <div><strong>Passengers:</strong> ${escapeHtml(passengerNames)}</div>
          <div><strong>Insurance:</strong> ${journeyConfig.preferences?.travelInsurance ? "Yes" : "No"}</div>
          <div><strong>Payment Mode:</strong> ${escapeHtml(journeyConfig.preferences?.paymentMode || "")}</div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
          <button id="irctc-edit-btn" type="button" style="border:0;border-radius:14px;padding:12px 14px;background:#eef2ff;color:#1a237e;font-weight:700;cursor:pointer;">Let Me Edit</button>
          <button id="irctc-confirm-btn" type="button" style="border:0;border-radius:14px;padding:12px 14px;background:#ff6d00;color:#fff;font-weight:700;cursor:pointer;">Confirm & Continue</button>
        </div>
      `;

      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      panel.querySelector("#irctc-edit-btn").addEventListener("click", () => {
        overlay.remove();
        resolve(false);
      });
      panel.querySelector("#irctc-confirm-btn").addEventListener("click", () => {
        overlay.remove();
        resolve(true);
      });
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isSearchPage(url = "") {
    return String(url).includes("/nget/train-search");
  }

  function isTrainListPage(url = "") {
    return String(url).includes("/train-list");
  }

  function isPaxDetailsPage(url = "") {
    return String(url).includes("/pax-details");
  }

  function isPaymentPage(url = "") {
    return String(url).includes("/payment");
  }
})();
