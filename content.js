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
      "p-dropdown[placeholder*='Quota']"
      // NOTE: Intentionally NO ".ui-dropdown" fallback — it matches the class dropdown too.
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
    ],
    loginUserId: [
      "input#userId",
      "input[name='userId']",
      "input[placeholder*='User']",
      "input[formcontrolname='userid']"
    ],
    loginPassword: [
      "input#pwd",
      "input[type='password']",
      "input[name='password']"
    ],
    loginNav: [
      "a[href*='login']",
      ".loginText",
      "li.login a"
    ],
    loggedInMarkers: [
      ".user-name-text",
      "a[title='My Account']"
    ]
  };

  const CHECKPOINT_MAX_AGE_MS = 30 * 60 * 1000;
  const CHECKPOINT_STEP_LABELS = {
    STEP_COMPLETED_LOGIN: "Login completed",
    STEP_COMPLETED_SEARCH: "Search submitted",
    STEP_WAITING_TRAIN_SELECT: "Waiting for train selection",
    STEP_COMPLETED_TRAIN_SELECT: "Train selected",
    STEP_COMPLETED_PAX: "Passenger details completed",
    STEP_COMPLETED_PAYMENT: "Payment handoff reached"
  };

  const PROGRESS_STEPS = [
    { id: "login", label: "Login" },
    { id: "search", label: "Search" },
    { id: "train", label: "Select Train" },
    { id: "pax", label: "Passenger Details" },
    { id: "payment", label: "Payment Ready" }
  ];

  const contentState = {
    activeConfig: null,
    widgetMounted: false,
    observerStarted: false,
    widgetData: null,
    trainListHandledForUrl: "",
    resumeBannerVisible: false,
    autoLoginInFlight: false,
    autoOkWatcherStarted: false,
    captchaPaused: false,
    captchaPausedAtStep: null,
    captchaResumeContext: null,
    tatkalPrePositioned: false,
    sessionExpiryPollerStarted: false,
    serverDownPollerStarted: false,
    lastUrlChangeAt: Date.now(),
    progressMessage: "IRCTC AutoFill is ready.",
    progressMinimized: false
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
    startAutoOkWatcher();
    const loginOutcome = await maybeHandleAutoLogin();
    if (loginOutcome?.navigating) {
      return;
    }
    await waitForBlockingPopupToClear();
    await maybeShowResumeBanner();
    await notifyPageReady();
    observeUrlChanges();
    startSessionExpiryWatcher();
    startServerDownWatcher();
    startCaptchaMonitor();
    setTimeout(() => detectServerDown(), 15000);
    await maybeRecoverAfterServerDown();
    if (isTrainListPage(location.href)) {
      await handleTrainListAutomation();
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
        const now = Date.now();
        const timeSinceLast = now - contentState.lastUrlChangeAt;
        contentState.lastUrlChangeAt = now;
        lastHref = location.href;
        await detectSessionExpiry();
        if (contentState.activeConfig && timeSinceLast > 20000) {
          await detectServerDown();
        }
        mountAssistantWidget();
        await loadWidgetState();
        const loginOutcome = await maybeHandleAutoLogin();
        if (loginOutcome?.navigating) {
          return;
        }
        await waitForBlockingPopupToClear();
        await maybeShowResumeBanner();
        await notifyPageReady();
        if (isTrainListPage(location.href)) {
          contentState.trainListHandledForUrl = "";
          await handleTrainListAutomation();
        }
        if (isPaymentPage(location.href)) {
          await showPaymentToast();
          await reportBookingCompleted();
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function startAutoOkWatcher() {
    if (contentState.autoOkWatcherStarted) {
      return;
    }

    contentState.autoOkWatcherStarted = true;
    const observer = new MutationObserver(() => {
      maybeClickBlockingOkButton().catch(() => undefined);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    maybeClickBlockingOkButton().catch(() => undefined);
  }

  function startSessionExpiryWatcher() {
    if (contentState.sessionExpiryPollerStarted) {
      return;
    }
    contentState.sessionExpiryPollerStarted = true;
    setInterval(async () => {
      if (contentState.activeConfig) {
        await detectSessionExpiry();
      }
    }, 5000);
  }

  function startServerDownWatcher() {
    if (contentState.serverDownPollerStarted) {
      return;
    }
    contentState.serverDownPollerStarted = true;
    setInterval(async () => {
      if (contentState.activeConfig && Date.now() - contentState.lastUrlChangeAt > 20000) {
        await detectServerDown();
      }
    }, 10000);
  }

  function startCaptchaMonitor() {
    const observer = new MutationObserver(async () => {
      if (contentState.activeConfig && !contentState.captchaPaused && isCaptchaPresent()) {
        await detectAndHandleCaptcha("STEP_UNKNOWN");
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }

  async function maybeClickBlockingOkButton() {
    const POPUP_PHRASES = [
      "you are booking in",
      "foreign tourist quota",
      "only aadhaar verified users can book tatkal train tickets",
      "confirmation"
    ];

    // Walk up from the body looking for any visible container that holds known popup text.
    const popupContainer = Array.from(
      document.querySelectorAll("[role='dialog'], .ui-dialog, .modal, .ng-trigger, .ui-confirmdialog, p-dialog, p-confirmdialog")
    ).find((element) => {
      if (!isVisible(element)) {
        return false;
      }
      const text = normalizeText(element.textContent || "");
      return POPUP_PHRASES.some((phrase) => text.includes(phrase));
    });

    // Fallback: scan the whole document body for any visible block-level element with popup text.
    const searchRoot = popupContainer || document.body;
    const bodyText = normalizeText(searchRoot?.textContent || "");
    const isPopupContext = POPUP_PHRASES.some((phrase) => bodyText.includes(phrase));

    if (!isPopupContext) {
      return false;
    }

    const buttons = Array.from((popupContainer || document).querySelectorAll("button, input[type='button'], input[type='submit']"))
      .filter((element) => isVisible(element))
      .filter((element) => {
        const label = normalizeText(element.textContent || element.value || "");
        return label === "ok" || label === "okay";
      })
      .filter((element) => !String(element.id || "").startsWith("irctc-"));

    for (const button of buttons) {
      button.click();
      showStatusToast("Confirmation popup closed automatically", "info");
      await humanDelay(180, 280);
      return true;
    }

    return false;
  }

  async function waitForBlockingPopupToClear() {
    const timeoutAt = Date.now() + 12000;
    while (Date.now() < timeoutAt) {
      const clicked = await maybeClickBlockingOkButton();
      if (!hasBlockingConfirmationPopup()) {
        return true;
      }
      if (clicked) {
        await humanDelay(220, 340);
      } else {
        await sleep(220);
      }
    }
    return !hasBlockingConfirmationPopup();
  }

  function hasBlockingConfirmationPopup() {
    return Array.from(document.querySelectorAll("[role='dialog'], .ui-dialog, .modal, .ng-trigger, .ui-confirmdialog, div"))
      .some((element) => {
        if (!isVisible(element)) {
          return false;
        }
        const text = normalizeText(element.textContent || "");
        const isForeignTouristPopup = text.includes("you are booking in") && text.includes("foreign tourist quota");
        const isTatkalAadhaarPopup = text.includes("only aadhaar verified users can book tatkal train tickets");
        return isForeignTouristPopup || isTatkalAadhaarPopup;
      });
  }

  async function detectSessionExpiry() {
    if (!contentState.activeConfig || contentState.autoLoginInFlight) {
      return false;
    }

    const urlExpired = /\/nget\/logout|\/nget\/user\/login/i.test(location.href);
    const bodyText = normalizeText(document.body?.textContent || "");
    const textExpired = /session.*expired|logged.*out|please.*login.*again|your session/i.test(bodyText);
    const loginNavVisible = Array.from(document.querySelectorAll(SELECTORS.loginNav.join(",")))
      .some((element) => element && isVisible(element) && normalizeText(element.textContent || "").includes("login"));

    if (!urlExpired && !textExpired && !loginNavVisible) {
      return false;
    }

    showStatusToast("⚠️ Session expired — re-logging in automatically...", "info");
    const { [STORAGE_KEYS.LOGIN_CREDS]: loginCreds } = await getStorage([STORAGE_KEYS.LOGIN_CREDS]);
    const username = decodeCredential(loginCreds?.ircLogin);
    const password = decodeCredential(loginCreds?.ircPass);
    if (!username || !password) {
      contentState.activeConfig = null;
      showStatusToast("❌ Re-login failed — please login manually", "error", 0);
      return false;
    }

    const loggedIn = await autoLogin(username, password);
    if (!loggedIn) {
      contentState.activeConfig = null;
      showStatusToast("❌ Re-login failed — please login manually", "error", 0);
      return false;
    }

    showStatusToast("✅ Re-logged in — resuming from last checkpoint", "success");
    await resumeBookingFlow();
    return true;
  }

  async function detectServerDown() {
    const titleText = normalizeText(document.title || "");
    const bodyText = normalizeText(document.body?.textContent || "");
    const downTitle = /503|502|service unavailable|maintenance/i.test(titleText);
    const downBody = /service.*unavailable|under.*maintenance|server.*down|temporarily.*unavailable|try.*after.*sometime/i.test(bodyText);
    const appRootMissing = !document.querySelector("app-root, #app");

    if (!downTitle && !downBody && !appRootMissing) {
      return false;
    }

    mountServerDownBanner();
    setServerRecoveryPending(true);
    await safeSendRuntimeMessage({ type: "SERVER_DOWN_NOTIFY" });
    return true;
  }

  let serverDownIntervalId = null;

  function mountServerDownBanner() {
    if (document.getElementById("irctc-server-down-banner")) {
      return;
    }
    const banner = document.createElement("div");
    banner.id = "irctc-server-down-banner";
    banner.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:9999999",
      "background:#4A148C",
      "color:#fff",
      "font:14px/1.45 'Segoe UI',sans-serif",
      "padding:12px 16px",
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "box-shadow:0 10px 28px rgba(20,35,90,0.24)"
    ].join(";");

    banner.innerHTML = `
      <div>
        🔴 IRCTC appears to be down — checking every 30 seconds...
        <span id="irctc-server-down-countdown">Next check in: 30s</span>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;align-items:center;">
        <button id="irctc-server-down-check-now" type="button" style="border:0;border-radius:10px;padding:9px 12px;background:#FF6D00;color:#fff;font-weight:700;cursor:pointer;">Check Now</button>
      </div>
    `;
    document.body.appendChild(banner);
    const refresh = () => runServerDownCheckCycle();
    banner.querySelector("#irctc-server-down-check-now")?.addEventListener("click", refresh);
    runServerDownCheckCycle();
  }

  function unmountServerDownBanner() {
    const banner = document.getElementById("irctc-server-down-banner");
    if (banner) {
      banner.remove();
    }
    if (serverDownIntervalId !== null) {
      clearInterval(serverDownIntervalId);
      serverDownIntervalId = null;
    }
  }

  function runServerDownCheckCycle() {
    let countdown = 30;
    const countdownLabel = document.getElementById("irctc-server-down-countdown");
    if (serverDownIntervalId !== null) {
      clearInterval(serverDownIntervalId);
    }
    if (countdownLabel) {
      countdownLabel.textContent = `Next check in: ${countdown}s`;
    }
    serverDownIntervalId = setInterval(async () => {
      countdown -= 1;
      if (countdownLabel) {
        countdownLabel.textContent = `Next check in: ${countdown}s`;
      }
      if (countdown <= 0) {
        clearInterval(serverDownIntervalId);
        serverDownIntervalId = null;
        await refreshServerPageForHealth();
      }
    }, 1000);
  }

  async function refreshServerPageForHealth() {
    setServerRecoveryPending(true);
    location.reload();
    return;
    
      
        showStatusToast("✅ IRCTC is back online!", "success");
        
  }

  async function maybeRecoverAfterServerDown() {
    if (!getServerRecoveryPending()) {
      return false;
    }

    const stillDown = await detectServerDown();
    if (stillDown) {
      return false;
    }

    clearServerRecoveryPending();
    unmountServerDownBanner();
    showStatusToast("IRCTC is back online!", "success");
    await safeSendRuntimeMessage({ type: "SERVER_BACK_NOTIFY" });
    await resumeBookingFlow();
    return true;
  }

  async function detectAndHandleCaptcha(pausedStep, resumeContext = null) {
    if (contentState.captchaPaused || !isCaptchaPresent()) {
      return false;
    }
    contentState.captchaPaused = true;
    contentState.captchaPausedAtStep = pausedStep || null;
    contentState.captchaResumeContext = resumeContext || null;
    mountCaptchaBanner();
    return true;
  }

  function isCaptchaPresent() {
    const bodyText = normalizeText(document.body?.textContent || "");
    const hasText = /captcha|verify you are human|security check/i.test(bodyText);
    const hasIframe = Array.from(document.querySelectorAll("iframe[src]"))
      .some((frame) => /captcha|recaptcha|hcaptcha/i.test(frame.src || ""));
    const hasImage = Array.from(document.querySelectorAll("img[src]"))
      .some((img) => /captcha/i.test(img.src || ""));
    const hasVisibleCaptchaBlock = Array.from(document.querySelectorAll("div[id*='captcha'], div[class*='captcha']"))
      .some((element) => isVisible(element));
    return hasText || hasIframe || hasImage || hasVisibleCaptchaBlock;
  }

  function mountCaptchaBanner() {
    if (document.getElementById("irctc-captcha-banner")) {
      return;
    }
    const banner = document.createElement("div");
    banner.id = "irctc-captcha-banner";
    banner.style.cssText = [
      "position:fixed",
      `top:${contentState.resumeBannerVisible ? 56 : 0}px`,
      "left:0",
      "right:0",
      "z-index:9999999",
      "background:#B71C1C",
      "color:#fff",
      "font:14px/1.45 'Segoe UI',sans-serif",
      "padding:12px 16px",
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "box-shadow:0 10px 28px rgba(0,0,0,0.24)"
    ].join(";");
    banner.innerHTML = `
      <div>🔐 CAPTCHA detected — please solve it, then click Continue</div>
      <button id="irctc-captcha-continue" type="button" style="border:0;border-radius:10px;padding:9px 12px;background:#FF6D00;color:#fff;font-weight:700;cursor:pointer;">▶ Continue After CAPTCHA</button>
    `;
    document.body.appendChild(banner);
    banner.querySelector("#irctc-captcha-continue")?.addEventListener("click", async () => {
      unmountCaptchaBanner();
      contentState.captchaPaused = false;
      await resumeAfterCaptcha();
    });
  }

  function unmountCaptchaBanner() {
    const banner = document.getElementById("irctc-captcha-banner");
    if (banner) {
      banner.remove();
    }
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case "BACKGROUND_PAGE_READY":
        return await handleBackgroundPageReady(message.url);
      case "TATKAL_PRE_FILL_SEARCH":
        return await handleTatkalPreFillSearch();
      case "START_PAGE_AUTOMATION":
      case "RUN_AVAILABILITY_PAGE1":
        mountProgressOverlay();
        return runSearchAutomation(message.journeyConfig, message.type === "RUN_AVAILABILITY_PAGE1");
      case "RUN_PAX_AUTOMATION":
        mountProgressOverlay();
        return runPassengerAutomation(message.journeyConfig);
      case "SHOW_READY_BADGE":
        await handleTrainListAutomation(message.journeyConfig);
        return {};
      case "RESUME_BOOKING_FLOW":
        mountProgressOverlay();
        return resumeBookingFlow(message.checkpoint || null);
      case "SCRAPE_AVAILABILITY_RESULTS":
        return scrapeAvailabilityAndSend(message.journeyConfig);
      case "SHOW_PAYMENT_TOAST":
        await showPaymentToast();
        return {};
      default:
        return {};
    }
  }

  async function handleBackgroundPageReady(url) {
    if (!url || !contentState.activeConfig) {
      return {};
    }
    if (contentState.tatkalPrePositioned && isSearchPage(url) && contentState.activeConfig.tatkalRushMode) {
      await showStatusToast("⚡ Tatkal pre-positioned — ready to submit at start time", "success");
    }
    return {};
  }

  async function handleTatkalPreFillSearch() {
    const { [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: tatkalRushConfig } = await getStorage([STORAGE_KEYS.TATKAL_RUSH_CONFIG]);
    if (!tatkalRushConfig?.journeyConfig) {
      throw await createUserVisibleError("Tatkal pre-fill config is missing.");
    }
    contentState.activeConfig = tatkalRushConfig.journeyConfig;
    await fillSearchForm(tatkalRushConfig.journeyConfig);
    contentState.tatkalPrePositioned = true;
    showStatusToast(`⚡ Tatkal pre-positioned — form ready. Will search at ${new Date(tatkalRushConfig.scheduledFor).toLocaleTimeString()}`);
    return { prepositioned: true };
  }

  async function notifyPageReady() {
    await safeSendRuntimeMessage({
      type: "PAGE_READY",
      payload: {
        url: location.href
      }
    });
  }

  async function runSearchAutomationImpl(journeyConfig, isAvailabilityMode) {
    contentState.activeConfig = journeyConfig;
    contentState.tatkalPrePositioned = Boolean(contentState.tatkalPrePositioned || journeyConfig?.metadata?.tatkalPrePositioned);
    if (await detectAndHandleCaptcha("STEP_COMPLETED_SEARCH", { action: "search-submit" })) {
      return { pausedByCaptcha: true };
    }
    await waitForBlockingPopupToClear();

    if (contentState.tatkalPrePositioned && journeyConfig.tatkalRushMode && isSearchPage(location.href) && !isAvailabilityMode) {
      const searchButton = await findElement('Search Trains button', SELECTORS.searchButton);
      const { [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: tatkalRushConfig } = await getStorage([STORAGE_KEYS.TATKAL_RUSH_CONFIG]);
      const scheduledTime = tatkalRushConfig?.scheduledFor ? new Date(tatkalRushConfig.scheduledFor).getTime() : 0;

      if (scheduledTime > Date.now() && scheduledTime - Date.now() < 30000) {
        const timeStr = new Date(scheduledTime).toLocaleTimeString();
        await updateStatus('active', '⚡ Waiting for ' + timeStr + ' to click Search...', [
          { label: 'Tatkal pre-positioned', state: 'complete' },
          { label: 'Awaiting ' + timeStr, state: 'active' }
        ]);
        while (Date.now() < scheduledTime) {
          await sleep(50);
        }
      }

      showStatusToast('⚡ Tatkal starting — submitting now!', 'success');
      searchButton.click();
      contentState.tatkalPrePositioned = false;
      if (journeyConfig?.metadata) {
        journeyConfig.metadata.tatkalPrePositioned = false;
      }
      await saveCheckpoint('STEP_COMPLETED_SEARCH', journeyConfig);
      return { submitted: true };
    }

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
    await saveCheckpoint("STEP_COMPLETED_SEARCH", journeyConfig);
    updateProgressOverlay(1, "complete");
    return { submitted: true };
  }

  async function fillSearchForm(journeyConfig) {
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
    return searchButton;
  }

  const runSearchAutomation = (journeyConfig, isAvailabilityMode) => {
    mountProgressOverlay();
    updateProgressOverlay(1, "active");
    return withRetry(() => runSearchAutomationImpl(journeyConfig, isAvailabilityMode), "Search form fill", 3)
      .finally(() => unmountProgressOverlay());
  };

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

    // Use the native setter to bypass Angular's value wrapping,
    // then fire synthetic events so Angular's zone picks up the change.
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, "value"
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(input, displayDate);
    } else {
      input.value = displayDate;
    }

    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur",   { bubbles: true }));
    await humanDelay();

    // Verify Angular picked it up; fall back to character-by-character
    // typing if the value is still wrong.
    if (input.value !== displayDate) {
      await clearAndType(input, displayDate);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur",   { bubbles: true }));
      await humanDelay();
    }
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

    let dropdown;
    try {
      dropdown = await findElement(`${purpose} dropdown`, fallbackMap[purpose] || []);
    } catch (error) {
      if (purpose === "Quota") {
        // Quota dropdown not found — already at correct value or not on this page layout.
        showStatusToast(`Quota field not found — please verify "${value}" is set manually.`, "info");
        return;
      }
      throw error;
    }

    // For quota: read the currently displayed value first.
    // If it already matches what we want, skip clicking entirely.
    if (purpose === "Quota") {
      const currentText = getDropdownDisplayedText(dropdown);
      if (matchesDropdownValue(currentText, value)) {
        return; // Already correct, nothing to do.
      }
    }

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

      if (purpose === "Quota") {
        // Close the open dropdown panel before warning.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        const panel = document.querySelector(".p-dropdown-panel, .ui-dropdown-panel");
        if (panel) {
          panel.style.display = "none";
        }
        showStatusToast(`Quota "${value}" not found — please set it manually.`, "error");
        return;
      }

      throw await createUserVisibleError(`Could not select ${purpose}: "${value}".`);
    }
    option.click();
    await humanDelay();
  }

  async function waitForDropdownOption(value) {
    const timeoutAt = Date.now() + 6000;
    while (Date.now() < timeoutAt) {
      // Intentionally exclude bare 'span' to avoid false matches from nested text
      // inside wrong dropdown items (e.g. "Foreign Tourist" containing "General" as a substring).
      const candidates = Array.from(document.querySelectorAll(".p-dropdown-item, .ui-dropdown-item, li[role='option']"))
        .filter((node) => isVisible(node) && matchesDropdownValue(node.textContent, value));
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
      // Quota aliases — IRCTC shows short codes like GN, TQ, PT, LD, SS in dropdowns
      "general": ["general", "gn", "general quota"],
      "tatkal": ["tatkal", "tq", "tk", "tatkal quota"],
      "premium tatkal": ["premium tatkal", "pt", "premium tatkal quota"],
      "ladies": ["ladies", "ld", "ladies quota"],
      "senior citizen": ["senior citizen", "ss", "senior citizen quota"]
    };

    const aliases = aliasMap[requested] || [];
    // For quota items, do a strict full-text check first to avoid "General" matching inside "Foreign Tourist"
    if (candidate === requested) {
      return true;
    }
    return aliases.some((alias) => candidate === alias || candidate.startsWith(alias + " ") || candidate.endsWith(" " + alias) || candidate === alias);
  }

  async function runPassengerAutomationImpl(journeyConfig) {
    contentState.activeConfig = journeyConfig;
    await waitForBlockingPopupToClear();
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
    if (await detectAndHandleCaptcha("STEP_COMPLETED_PAX", { action: "continue-pax" })) {
      return { pausedByCaptcha: true };
    }
    continueButton.click();
    await saveCheckpoint("STEP_COMPLETED_PAX", journeyConfig);
    updateProgressOverlay(3, "complete");
    await updateStatus("active", "Continuing to payment handoff...", [
      { label: "Passenger details filled", state: "complete" },
      { label: "User confirmed details", state: "complete" },
      { label: "Opening next step", state: "active" }
    ]);
    return { continued: true };
  }

  const runPassengerAutomation = (journeyConfig) => {
    mountProgressOverlay();
    updateProgressOverlay(3, "active");
    return withRetry(() => runPassengerAutomationImpl(journeyConfig), "Passenger details fill", 3)
      .finally(() => unmountProgressOverlay());
  };

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

    const idProofDropdown = await findWithinRow(row, [
      "p-dropdown[formcontrolname*='idProof']",
      "select[name*='idProof']",
      "select[id*='idProof']",
      "select[name*='id']"
    ], { skipIfMissing: true });

    if (idProofDropdown && passenger.idProofType) {
      if (idProofDropdown.tagName === "SELECT") {
        idProofDropdown.value = passenger.idProofType;
        dispatchAllEvents(idProofDropdown);
      } else {
        await clickAngularDropdown(idProofDropdown, passenger.idProofType, `ID proof for passenger ${index + 1}`);
      }
    }

    const idProofNumberInput = await findWithinRow(row, [
      "input[formcontrolname*='idCardNo']",
      "input[formcontrolname*='idcard']",
      "input[name*='idProofNumber']",
      "input[name*='idCard']",
      "input[placeholder*='ID Proof Number']",
      "input[placeholder*='ID Card Number']"
    ], { skipIfMissing: true });

    if (idProofNumberInput && passenger.idProofNumber) {
      await clearAndType(idProofNumberInput, passenger.idProofNumber);
      await humanDelay();
    }

    const seniorCheckbox = await findCheckboxByLabelInRow(row, /senior citizen|senior concession|60\+|60 years|senior/i, true);
    if (seniorCheckbox) {
      const shouldCheck = Boolean(passenger.seniorConcession || passenger.age >= 60);
      if (seniorCheckbox.checked !== shouldCheck) {
        seniorCheckbox.click();
        await humanDelay();
      }
    }

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
    if (mobileInput && fallbackMobile) {
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

  async function handleTrainListAutomation(journeyConfig = null) {
    if (!isTrainListPage(location.href)) {
      return {};
    }

    await waitForBlockingPopupToClear();
    const activeJourney = await getResolvedJourneyConfig(journeyConfig);
    const autoSelectTrain = Boolean(activeJourney?.autoSelectTrain || activeJourney?.metadata?.autoSelectTrain);
    await saveCheckpoint("STEP_WAITING_TRAIN_SELECT", activeJourney);
    mountProgressOverlay();
    updateProgressOverlay(2, "active");

    if (!autoSelectTrain) {
      await showReadyBadge();
      await maybeGenerateTrainRecommendation(activeJourney);
      updateProgressOverlay(2, "active");
      return {};
    }

    if (contentState.trainListHandledForUrl === location.href) {
      return {};
    }

    contentState.trainListHandledForUrl = location.href;
    await autoSelectBestTrain(activeJourney);
    return {};
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
    const journeyConfig = await getResolvedJourneyConfig(contentState.activeConfig);
    await saveCheckpoint("STEP_COMPLETED_PAYMENT", journeyConfig);
    mountProgressOverlay();
    updateProgressOverlay(4, "complete");
    setTimeout(() => unmountProgressOverlay(), 5000);
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

  async function getResolvedJourneyConfig(journeyConfig = null) {
    if (journeyConfig?.autoSelectTrain || journeyConfig?.metadata?.autoSelectTrain) {
      return journeyConfig;
    }

    const activeJourney = journeyConfig || (await getActiveJourneyFromStorage()) || {};
    const { [STORAGE_KEYS.JOURNEY_DRAFT]: journeyDraft } = await getStorage([STORAGE_KEYS.JOURNEY_DRAFT]);

    if (!journeyDraft) {
      return activeJourney;
    }

    return {
      ...journeyDraft,
      ...activeJourney,
      metadata: {
        ...(journeyDraft.metadata || {}),
        ...(activeJourney.metadata || {})
      }
    };
  }

  async function maybeHandleAutoLogin() {
    const currentPage = getCurrentPage();
    if (!["HOME", "LOGIN"].includes(currentPage) || contentState.autoLoginInFlight) {
      return { attempted: false, navigating: false };
    }

    const {
      [STORAGE_KEYS.LOGIN_CREDS]: loginCreds,
      [STORAGE_KEYS.AUTO_LOGIN]: autoLoginEnabled
    } = await getStorage([STORAGE_KEYS.LOGIN_CREDS, STORAGE_KEYS.AUTO_LOGIN]);

    if (!autoLoginEnabled || !loginCreds?.ircLogin || !loginCreds?.ircPass) {
      return { attempted: false, navigating: false };
    }

    if (isLoggedIn()) {
      await saveLoginCheckpointIfNeeded();
      return await maybeContinueArmedBookingAfterLogin();
    }

    contentState.autoLoginInFlight = true;
    try {
      const username = decodeCredential(loginCreds.ircLogin);
      const password = decodeCredential(loginCreds.ircPass);
      if (!username || !password) {
        return { attempted: false, navigating: false };
      }

      const loggedIn = await autoLogin(username, password);
      if (loggedIn) {
        await saveLoginCheckpointIfNeeded();
        return await maybeContinueArmedBookingAfterLogin();
      }
      return { attempted: true, navigating: false };
    } finally {
      contentState.autoLoginInFlight = false;
    }
  }

  async function autoLogin(username, password) {
    showStatusToast("Opening IRCTC login...", "info");
    const loginButton = await findLoginButton();
    if (!loginButton) {
      throw await createUserVisibleError("Could not find the IRCTC login button.");
    }

    loginButton.click();
    await humanDelay(280, 420);

    const userInput = await findElement("IRCTC login user ID", SELECTORS.loginUserId);
    const passwordInput = await findElement("IRCTC login password", SELECTORS.loginPassword);
    await clearAndType(userInput, username);
    await humanDelay();
    await clearAndType(passwordInput, password);
    await humanDelay();

    const submitButton = await findLoginSubmitButton();
    if (!submitButton) {
      throw await createUserVisibleError("Could not find the IRCTC login submit button.");
    }

    submitButton.click();
    await humanDelay(300, 450);

    const success = await waitForLoginSuccess(username);
    if (!success) {
      showStatusToast("❌ Login failed — please login manually", "error");
      return false;
    }

    showStatusToast("✅ Logged in successfully", "success");
    return true;
  }

  async function findLoginButton() {
    for (const selector of SELECTORS.loginNav) {
      const element = document.querySelector(selector);
      if (element && isVisible(element)) {
        return element;
      }
    }

    const textMatch = Array.from(document.querySelectorAll("a, button, [role='button']"))
      .find((element) => isVisible(element) && /login|login\s*\/\s*register/i.test(normalizeText(element.textContent)));
    if (textMatch) {
      return textMatch;
    }

    return findWithGeminiFallback("IRCTC login button", SELECTORS.loginNav);
  }

  async function findLoginSubmitButton() {
    for (const selector of ["button#login", "button[type='submit']", ".loginModal button.search_btn"]) {
      const element = document.querySelector(selector);
      if (element && isVisible(element)) {
        return element;
      }
    }

    const textMatch = Array.from(document.querySelectorAll("button, [role='button']"))
      .find((element) => isVisible(element) && /sign in|login/i.test(normalizeText(element.textContent)));
    if (textMatch) {
      return textMatch;
    }

    return findWithGeminiFallback("IRCTC login submit button", ["button#login", "button[type='submit']", ".loginModal button.search_btn"]);
  }

  async function waitForLoginSuccess(username) {
    const timeoutAt = Date.now() + 15000;
    while (Date.now() < timeoutAt) {
      if (isLoggedIn(username)) {
        return true;
      }
      if (hasLoginErrorVisible()) {
        return false;
      }
      await sleep(250);
    }
    return isLoggedIn(username);
  }

  function isLoggedIn(username = "") {
    const markerFound = SELECTORS.loggedInMarkers.some((selector) => {
      const element = document.querySelector(selector);
      return element && isVisible(element);
    });
    if (markerFound) {
      return true;
    }

    const pageText = normalizeText(document.body?.textContent || "");
    return pageText.includes("my account") || pageText.includes("welcome") || (username && pageText.includes(normalizeText(username)));
  }

  function hasLoginErrorVisible() {
    return Array.from(document.querySelectorAll(".ui-message-error, .error, .loginError, [role='alert'], .toast-message"))
      .some((element) => isVisible(element) && /invalid|incorrect|failed|captcha|error/i.test(normalizeText(element.textContent)));
  }

  async function saveLoginCheckpointIfNeeded() {
    const { [STORAGE_KEYS.ACTIVE_BOOKING]: activeBooking } = await getStorage([STORAGE_KEYS.ACTIVE_BOOKING]);
    const journeyConfig = activeBooking?.journeyConfig || null;
    if (journeyConfig?.fromStation && journeyConfig?.toStation) {
      await saveCheckpoint("STEP_COMPLETED_LOGIN", journeyConfig);
    }
  }

  async function maybeContinueArmedBookingAfterLogin() {
    const { [STORAGE_KEYS.ACTIVE_BOOKING]: activeBooking } = await getStorage([STORAGE_KEYS.ACTIVE_BOOKING]);
    if (!activeBooking?.journeyConfig) {
      return { attempted: true, navigating: false };
    }
    if (["HOME", "LOGIN"].includes(getCurrentPage())) {
      location.assign(IRCTC_URLS.SEARCH);
      return { attempted: true, navigating: true };
    }
    return { attempted: true, navigating: false };
  }

  async function saveCheckpoint(step, journeyConfig) {
    if (!journeyConfig?.fromStation || !journeyConfig?.toStation) {
      return;
    }

    await setStorage({
      [STORAGE_KEYS.BOOKING_CHECKPOINT]: {
        step,
        journeyConfig,
        timestamp: new Date().toISOString(),
        pageUrl: location.href
      }
    });

    mountProgressOverlay();
    updateProgressFromCheckpoint(step);

    if (step === "STEP_COMPLETED_PAYMENT") {
      setTimeout(() => {
        setStorage({ [STORAGE_KEYS.BOOKING_CHECKPOINT]: null });
      }, 60000);
    }
  }

  async function getValidCheckpoint() {
    const { [STORAGE_KEYS.BOOKING_CHECKPOINT]: checkpoint } = await getStorage([STORAGE_KEYS.BOOKING_CHECKPOINT]);
    if (!checkpoint?.timestamp) {
      return null;
    }

    if (Date.now() - new Date(checkpoint.timestamp).getTime() > CHECKPOINT_MAX_AGE_MS) {
      await clearCheckpoint();
      return null;
    }

    return checkpoint;
  }

  async function clearCheckpoint() {
    await setStorage({ [STORAGE_KEYS.BOOKING_CHECKPOINT]: null });
  }

  async function maybeShowResumeBanner() {
    const checkpoint = await getValidCheckpoint();
    const existing = document.getElementById("irctc-autofill-resume-banner");

    if (!checkpoint) {
      existing?.remove();
      contentState.resumeBannerVisible = false;
      return;
    }

    if (existing || contentState.resumeBannerVisible) {
      return;
    }

    const banner = document.createElement("div");
    banner.id = "irctc-autofill-resume-banner";
    banner.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:9999998",
      "background:#1A237E",
      "color:#fff",
      "font:14px/1.45 'Segoe UI',sans-serif",
      "padding:12px 16px",
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "box-shadow:0 10px 28px rgba(20,35,90,0.24)",
      "transform:translateY(-100%)",
      "transition:transform 180ms ease"
    ].join(";");

    banner.innerHTML = `
      <div>🔄 Interrupted booking detected — ${escapeHtml(checkpoint.journeyConfig.fromStation)} → ${escapeHtml(checkpoint.journeyConfig.toStation)} on ${escapeHtml(checkpoint.journeyConfig.journeyDate)} | Last step: ${escapeHtml(getCheckpointStepLabel(checkpoint.step))}</div>
      <div style="display:flex;gap:8px;flex-shrink:0;">
        <button id="irctc-resume-continue" type="button" style="border:0;border-radius:10px;padding:9px 12px;background:#FF6D00;color:#fff;font-weight:700;cursor:pointer;">▶ Continue</button>
        <button id="irctc-resume-dismiss" type="button" style="border:1px solid rgba(255,255,255,0.55);border-radius:10px;padding:9px 12px;background:transparent;color:#fff;font-weight:700;cursor:pointer;">✕ Dismiss</button>
      </div>
    `;

    document.body.appendChild(banner);
    requestAnimationFrame(() => {
      banner.style.transform = "translateY(0)";
    });

    banner.querySelector("#irctc-resume-continue").addEventListener("click", async () => {
      await resumeBookingFlow(checkpoint);
    });
    banner.querySelector("#irctc-resume-dismiss").addEventListener("click", async () => {
      await clearCheckpoint();
      banner.remove();
      contentState.resumeBannerVisible = false;
    });

    contentState.resumeBannerVisible = true;
  }

  async function resumeBookingFlow(checkpoint = null) {
    const activeCheckpoint = checkpoint || (await getValidCheckpoint());
    if (!activeCheckpoint?.journeyConfig) {
      showStatusToast("No recent booking checkpoint was found.", "error");
      return { resumed: false };
    }

    const journeyConfig = activeCheckpoint.journeyConfig;
    contentState.activeConfig = journeyConfig;
    await setStorage({
      [STORAGE_KEYS.ACTIVE_BOOKING]: {
        mode: "booking",
        journeyConfig,
        sourceTabId: null,
        triggeredBy: "resume",
        lastUpdatedAt: new Date().toISOString()
      }
    });

    await waitForBlockingPopupToClear();
    const currentPage = getCurrentPage();

    switch (activeCheckpoint.step) {
      case "STEP_COMPLETED_LOGIN":
        if (currentPage === "SEARCH") {
          return runSearchAutomation(journeyConfig, false);
        }
        location.assign(IRCTC_URLS.SEARCH);
        return { navigating: true };
      case "STEP_COMPLETED_SEARCH":
      case "STEP_WAITING_TRAIN_SELECT":
        if (currentPage === "TRAIN_LIST") {
          return handleTrainListAutomation(journeyConfig);
        }
        if (currentPage === "SEARCH") {
          showStatusToast("Resuming from search to reach train list again...", "info");
          return runSearchAutomation(journeyConfig, false);
        }
        location.assign(IRCTC_URLS.SEARCH);
        return { navigating: true };
      case "STEP_COMPLETED_TRAIN_SELECT":
        if (currentPage === "PAX") {
          return runPassengerAutomation(journeyConfig);
        }
        if (currentPage === "TRAIN_LIST") {
          showStatusToast("Re-selecting your train to continue...", "info");
          return handleTrainListAutomation(journeyConfig);
        }
        if (currentPage === "SEARCH") {
          showStatusToast("Returning to search so train selection can be rebuilt...", "info");
          return runSearchAutomation(journeyConfig, false);
        }
        location.assign(IRCTC_URLS.SEARCH);
        return { navigating: true };
      case "STEP_COMPLETED_PAX":
        if (currentPage === "PAYMENT") {
          showStatusToast("You are at payment page — please complete payment.", "info");
          mountProgressOverlay();
          updateProgressOverlay(4, "complete");
          return { resumed: true };
        }
        if (currentPage === "PAX") {
          return runPassengerAutomation(journeyConfig);
        }
        if (currentPage === "TRAIN_LIST") {
          showStatusToast("Rebuilding booking flow from train selection...", "info");
          return handleTrainListAutomation(journeyConfig);
        }
        if (currentPage === "SEARCH") {
          showStatusToast("Rebuilding booking flow from search...", "info");
          return runSearchAutomation(journeyConfig, false);
        }
        location.assign(IRCTC_URLS.SEARCH);
        return { navigating: true };
      case "STEP_COMPLETED_PAYMENT":
        showStatusToast("Booking already reached payment. Please complete payment.", "info");
        mountProgressOverlay();
        updateProgressOverlay(4, "complete");
        return { resumed: currentPage === "PAYMENT" };
      default:
        return { resumed: false };
    }
  }

  function getCheckpointStepLabel(step) {
    return CHECKPOINT_STEP_LABELS[step] || "In progress";
  }

  function decodeCredential(value) {
    if (!value) {
      return "";
    }
    try {
      return atob(value);
    } catch (error) {
      return "";
    }
  }

  async function resumeAfterCaptcha() {
    const journeyConfig = contentState.activeConfig || (await getActiveJourneyFromStorage()) || null;
    const resumeContext = contentState.captchaResumeContext || {};
    const pausedStep = contentState.captchaPausedAtStep;

    contentState.captchaPausedAtStep = null;
    contentState.captchaResumeContext = null;

    if (resumeContext.action === "search-submit") {
      const searchButton = await findElement("Search Trains button", SELECTORS.searchButton);
      await waitForBlockingPopupToClear();
      searchButton.click();
      if (journeyConfig) {
        await saveCheckpoint("STEP_COMPLETED_SEARCH", journeyConfig);
      }
      return { resumed: true };
    }

    if (resumeContext.action === "continue-pax") {
      const continueButton = await findContinueButton();
      continueButton.click();
      if (journeyConfig) {
        await saveCheckpoint("STEP_COMPLETED_PAX", journeyConfig);
      }
      return { resumed: true };
    }

    if (resumeContext.action === "book-now" || pausedStep === "STEP_COMPLETED_TRAIN_SELECT") {
      return autoSelectBestTrain(journeyConfig || {});
    }

    if (pausedStep === "STEP_WAITING_TRAIN_SELECT") {
      return handleTrainListAutomation(journeyConfig);
    }

    return resumeBookingFlow();
  }

  async function autoSelectBestTrainImpl(journeyConfig = {}) {
    try {
      await showReadyBadge("Auto-selecting the best train...");
      showStatusToast("Waiting for train list to load...", "info");
      await waitForTrainCards();
      updateProgressOverlay(2, "active");
      await humanDelay();

      if (await detectAndHandleCaptcha("STEP_WAITING_TRAIN_SELECT", { action: "train-auto-select" })) {
        return { pausedByCaptcha: true };
      }

      showStatusToast("🔄 Refreshing seat availability...", "info");
      await autoRefreshSeats();
      showStatusToast("✅ Availability loaded", "success");

      showStatusToast("Scanning visible trains...", "info");
      const trains = parseTrainCards();
      const preferredTrainText = String(journeyConfig.preferredTrain || "").trim();
      const preferredSelection = preferredTrainText ? findPreferredTrain(trains, preferredTrainText) : null;
      if (preferredTrainText && preferredSelection) {
        showStatusToast(`✅ Found preferred train: ${preferredSelection.train.trainName} (${preferredSelection.train.trainNumber})`, "success");
      }

      const best = preferredSelection || scoreTrainRecommendation(trains, journeyConfig.journeyClass || "3A");
      if (!best?.train?.trainNumber) {
        throw await createUserVisibleError("Could not identify the best train from the visible list.");
      }

      if (preferredTrainText && !preferredSelection) {
        showStatusToast(`⚠️ Preferred train ${preferredTrainText} not found on this date — falling back to best available train`, "info");
      }

      await maybeGenerateTrainRecommendation(journeyConfig);

      const card = findTrainCardByNumber(best.train.trainNumber);
      if (!card) {
        throw await createUserVisibleError(`Could not find the recommended train card for ${best.train.trainNumber}.`);
      }

      const fallbackOrder = getFallbackClassOrder(journeyConfig);
      const selection = await selectTrainClassWithFallback(card, best.train, fallbackOrder, trains);
      if (!selection?.classButton) {
        throw await createUserVisibleError(`All preferred classes full for train ${best.train.trainNumber}.`, card);
      }

      await updateStatus("active", `Best train found: ${selection.train.trainName} (${selection.train.trainNumber}). Opening ${selection.selectedClass} class...`, [
        { label: "Train list loaded", state: "complete" },
        { label: `Selected ${selection.train.trainNumber}`, state: "complete" },
        { label: `Opening ${selection.selectedClass} availability`, state: "active" }
      ]);
      showStatusToast(`Best train found: ${selection.train.trainName} (${selection.train.trainNumber})`, "success");

      card.scrollIntoView({ behavior: "smooth", block: "center" });
      await humanDelay(180, 320);

      selection.classButton.click();
      await humanDelay(220, 360);
      showStatusToast(`Opened ${selection.selectedClass} class for ${selection.train.trainNumber}`, "info");

      await updateStatus("active", `Looking for Book Now on ${selection.train.trainNumber}...`, [
        { label: "Train list loaded", state: "complete" },
        { label: `Opened ${selection.selectedClass} for ${selection.train.trainNumber}`, state: "complete" },
        { label: "Waiting for Book Now button", state: "active" }
      ]);

      const bookNowButton = await findBookNowButtonInCard(card, selection.train);
      if (!bookNowButton) {
        throw await createUserVisibleError(`Could not find Book Now for train ${selection.train.trainNumber}.`, card);
      }
      if (await detectAndHandleCaptcha("STEP_COMPLETED_TRAIN_SELECT", {
        action: "book-now",
        trainNumber: selection.train.trainNumber,
        selectedClass: selection.selectedClass
      })) {
        return { pausedByCaptcha: true };
      }

      showStatusToast(`Book Now found for ${selection.train.trainNumber}. Booking...`, "success");
      bookNowButton.click();
      await saveCheckpoint("STEP_COMPLETED_TRAIN_SELECT", journeyConfig);
      updateProgressOverlay(2, "complete");
      await humanDelay(200, 340);

      await updateStatus("active", `Book Now clicked for ${selection.train.trainName}. Moving to passenger details...`, [
        { label: "Train list loaded", state: "complete" },
        { label: `Selected ${selection.train.trainNumber}`, state: "complete" },
        { label: "Book Now clicked", state: "complete" }
      ]);
      await showReadyBadge(`Best train selected automatically: ${selection.train.trainNumber}`);
    } catch (error) {
      contentState.trainListHandledForUrl = "";
      throw error;
    }
  }

  const autoSelectBestTrain = (journeyConfig) =>
    withRetry(() => autoSelectBestTrainImpl(journeyConfig), "Train auto-selection", 3);

  function findTrainCardByNumber(trainNumber) {
    if (!trainNumber) {
      return null;
    }
    const cards = Array.from(document.querySelectorAll("app-train-list, .train-avl-enq-box, .train-list .train-row, .tbis-div"));
    return cards.find((card) => normalizeText(card.textContent).includes(normalizeText(trainNumber))) || null;
  }

  async function findClassButtonInCard(card, journeyClass) {
    const normalizedClass = normalizeText(journeyClass);
    const aliases = getClassAliases(normalizedClass);
    const timeoutAt = Date.now() + 8000;

    while (Date.now() < timeoutAt) {
      const candidates = Array.from(card.querySelectorAll("button, [role='button'], .btnDefault, .pre-avl, span, a"))
        .filter((element) => isVisible(element))
        .filter((element) => {
          const text = normalizeText(element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || "");
          return aliases.some((alias) => text === alias || text.includes(alias));
        });

      if (candidates.length) {
        return candidates[0];
      }
      await sleep(200);
    }
    return null;
  }

  function getClassAliases(journeyClass) {
    const aliasMap = {
      sl: ["sl", "sleeper"],
      "3a": ["3a", "ac 3 tier", "third ac"],
      "2a": ["2a", "ac 2 tier", "second ac"],
      "1a": ["1a", "ac first class", "first ac"]
    };
    return aliasMap[journeyClass] || [journeyClass];
  }

  function getFallbackClassOrder(journeyConfig) {
    return Array.isArray(journeyConfig.fallbackClassOrder) && journeyConfig.fallbackClassOrder.length
      ? journeyConfig.fallbackClassOrder
      : ["3A", "2A", "SL", "1A"];
  }

  function findPreferredTrain(trains, preferredTrainText) {
    const normalizedTarget = normalizeText(preferredTrainText);
    return trains.find((train) => {
      return normalizeText(train.trainNumber).includes(normalizedTarget) || normalizeText(train.trainName).includes(normalizedTarget);
    }) || null;
  }

  async function selectTrainClassWithFallback(card, train, fallbackOrder, trains) {
    const orderedTrains = [train, ...trains.filter((candidate) => candidate.trainNumber !== train.trainNumber)];
    for (const candidate of orderedTrains) {
      const candidateCard = findTrainCardByNumber(candidate.trainNumber) || findTrainCardByName(candidate.trainName);
      if (!candidateCard) {
        continue;
      }
      for (const className of fallbackOrder) {
        if (isClassUnavailable(candidate, className)) {
          showStatusToast(`⚠️ ${className} full — trying next class...`, "info");
          continue;
        }
        const classButton = await findClassButtonInCard(candidateCard, className);
        if (!classButton) {
          continue;
        }
        return {
          card: candidateCard,
          train: candidate,
          classButton,
          selectedClass: className
        };
      }
    }
    return null;
  }

  function isClassUnavailable(train, className) {
    const availabilityText = String(train.availability?.[className] || "").toLowerCase();
    if (!availabilityText) {
      return true;
    }
    if (/regret|not available|wait listed|wl|rAC/i.test(availabilityText)) {
      const match = availabilityText.match(/wl\s*(\d+)/i);
      if (!match) {
        return true;
      }
      return Number(match[1]) > 50;
    }
    return false;
  }

  function findTrainCardByName(trainName) {
    const cards = Array.from(document.querySelectorAll("app-train-list, .train-avl-enq-box, .train-list .train-row, .tbis-div"));
    return cards.find((card) => normalizeText(card.textContent || "").includes(normalizeText(trainName))) || null;
  }

  async function findBookNowButtonInCard(card, train) {
    const timeoutAt = Date.now() + 10000;

    while (Date.now() < timeoutAt) {
      const primary = Array.from(card.querySelectorAll("button.btnDefault"))
        .find((element) => isVisible(element) && /book now/i.test(element.textContent || ""));
      if (primary) {
        return primary;
      }

      const textMatch = Array.from(card.querySelectorAll("button, [role='button']"))
        .find((element) => isVisible(element) && /book now/i.test(element.textContent || ""));
      if (textMatch) {
        return textMatch;
      }

      const submit = Array.from(card.querySelectorAll("input[type='submit']"))
        .find((element) => isVisible(element) && /book/i.test(element.value || ""));
      if (submit) {
        return submit;
      }

      await sleep(220);
    }

    const geminiRecovered = await findWithGeminiFallback(`Book Now button for train ${train?.trainNumber || ""}`, [
      "button.btnDefault",
      "button",
      "input[type='submit'][value*='Book']"
    ]);

    if (geminiRecovered && (card.contains(geminiRecovered) || findTrainCardByNumber(train?.trainNumber) === geminiRecovered.closest("app-train-list, .train-avl-enq-box, .train-list .train-row, .tbis-div"))) {
      return geminiRecovered;
    }

    return null;
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

  async function autoRefreshSeats() {
    const cardSelector = "app-train-list, .train-avl-enq-box, .train-list .train-row, .tbis-div";
    const cards = Array.from(document.querySelectorAll(cardSelector));
    let totalClicked = 0;

    for (const card of cards) {
      const refreshButtons = Array.from(card.querySelectorAll("button, a"))
        .filter((element) => {
          const label = normalizeText(
            element.textContent || element.value || element.getAttribute("aria-label") || ""
          );
          return /refresh|re-?check|update|reload/i.test(label);
        })
        .filter((element) => isVisible(element));

      for (const btn of refreshButtons) {
        btn.click();
        totalClicked += 1;
        await humanDelay(160, 260);
      }
    }

    if (totalClicked > 0) {
      await waitForTrainCards();
      return;
    }

    // FALLBACK: no per-card buttons found — try global scan
    const globalCandidate = Array.from(document.querySelectorAll("button, input[type='button'], a"))
      .filter((element) => isVisible(element))
      .find((element) => {
        const label = normalizeText(
          element.textContent || element.value || element.getAttribute("aria-label") || ""
        );
        return /refresh|re-?check|update|reload/i.test(label);
      });

    if (globalCandidate) {
      globalCandidate.click();
      await humanDelay(520, 780);
      await waitForTrainCards();
      return;
    }

    await sleep(900);
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
      const response = await safeSendRuntimeMessage({
        type: "GEMINI_SELECTOR_QUERY",
        payload: {
          purpose,
          url: location.href,
          selectorHints: selectors,
          domSummary: serializeDomForGemini(document)
        }
      });
      if (!response?.ok || !response.selector) {
        return null;
      }
      const element = document.querySelector(response.selector);
      if (element) {
        return element;
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

  async function findCheckboxByLabelInRow(row, pattern, skipIfMissing = false) {
    const wrappers = Array.from(row.querySelectorAll("label, div, section"));
    const wrapper = wrappers.find((node) => pattern.test(normalizeText(node.textContent)));
    const checkbox = wrapper?.querySelector("input[type='checkbox']");
    if (checkbox) {
      return checkbox;
    }
    if (skipIfMissing) {
      return null;
    }
    throw await createUserVisibleError(`Checkbox matching ${pattern} in passenger row was not found.`);
  }

  async function findButtonByText(pattern) {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    return buttons.find((button) => pattern.test(normalizeText(button.textContent))) || null;
  }

  async function createUserVisibleError(message, targetElement = null) {
    if (targetElement) {
      highlightProblem(targetElement);
    }
    unmountProgressOverlay();
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
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none") return false;
    if (style.visibility === "hidden") return false;
    if (style.opacity === "0") return false;
    if (element.offsetWidth === 0 && element.offsetHeight === 0) {
      // Allow elements that are position:fixed/absolute and off-layout
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    return true;
  }

  function showStatusToast(message, type = "info") {
    let toast = document.getElementById("irctc-autofill-status-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "irctc-autofill-status-toast";
      toast.style.cssText = [
        "position:fixed",
        "right:18px",
        "bottom:28px",
        "z-index:2147483646",
        "max-width:320px",
        "padding:12px 14px",
        "border-radius:14px",
        "color:#ffffff",
        "font:700 12px/1.4 'Segoe UI',sans-serif",
        "box-shadow:0 16px 38px rgba(20,35,90,0.22)",
        "transition:opacity 180ms ease"
      ].join(";");
      document.body.appendChild(toast);
    }

    const palette = {
      info: "#1a73e8",
      success: "#1f9d57",
      error: "#d62839"
    };

    toast.style.background = palette[type] || palette.info;
    toast.textContent = message;
    toast.style.opacity = "1";
    clearTimeout(showStatusToast.timeoutId);
    showStatusToast.timeoutId = setTimeout(() => {
      if (toast) {
        toast.style.opacity = "0";
      }
    }, 2600);
  }

  async function withRetry(action, purpose, attempts = 3) {
    const BACKOFF_MS = [2000, 5000, 12000];
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          showStatusToast(
            `Retrying ${purpose} (${attempt + 1}/${attempts})...`,
            "info"
          );
          await sleep(BACKOFF_MS[attempt - 1] ?? 2000);
        }
      }
    }

    // All attempts exhausted — surface a permanent error to the user.
    contentState.activeConfig = null;

    mountTerminalErrorBanner(
      `${purpose} failed after ${attempts} attempts — ` +
      `please reload the page and try again.`
    );

    await safeSendRuntimeMessage({
      type: "SHOW_NOTIFICATION",
      payload: {
        title: "IRCTC AutoFill — Automation Failed",
        message: `${purpose} could not complete after ${attempts} retries.`
      }
    });

    throw lastError;
  }

  function mountTerminalErrorBanner(message) {
    const existing = document.getElementById("irctc-autofill-error-banner");
    if (existing) existing.remove();

    const banner = document.createElement("div");
    banner.id = "irctc-autofill-error-banner";
    banner.style.cssText = [
      "position:fixed",
      "bottom:0",
      "left:0",
      "right:0",
      "z-index:2147483647",
      "background:#B71C1C",
      "color:#fff",
      "font:14px/1.45 'Segoe UI',sans-serif",
      "padding:14px 16px",
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "box-shadow:0 -8px 28px rgba(0,0,0,0.28)"
    ].join(";");

    banner.innerHTML = `
      <div>❌ ${escapeHtml(message)}</div>
      <button id="irctc-error-dismiss" type="button"
        style="border:0;border-radius:10px;padding:9px 12px;
               background:rgba(255,255,255,0.18);color:#fff;
               font-weight:700;cursor:pointer;flex-shrink:0;">
        Dismiss
      </button>
    `;
    document.body.appendChild(banner);
    banner.querySelector("#irctc-error-dismiss")
      .addEventListener("click", () => banner.remove());
  }

  function mountProgressOverlay() {
    if (document.getElementById("irctc-autofill-progress-overlay")) {
      return;
    }

    // Inject spin keyframes if not already present
    if (!document.getElementById("irctc-progress-spin-style")) {
      const styleEl = document.createElement("style");
      styleEl.id = "irctc-progress-spin-style";
      styleEl.textContent = `@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`;
      document.documentElement.appendChild(styleEl);
    }

    const STEP_LABELS = ["Login", "Search", "Select Train", "Passenger Details", "Payment"];

    const overlay = document.createElement("div");
    overlay.id = "irctc-autofill-progress-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "bottom:18px",
      "right:18px",
      "width:270px",
      "z-index:2147483645",
      "background:linear-gradient(180deg,rgba(26,35,126,0.97),rgba(26,35,126,0.84))",
      "color:#fff",
      "border-radius:18px",
      "box-shadow:0 22px 55px rgba(20,35,90,0.3)",
      "font:13px/1.45 'Segoe UI',sans-serif",
      "overflow:hidden"
    ].join(";");

    // Header row
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 14px;";
    header.innerHTML = `
      <strong style="font-size:12px;">⚡ IRCTC AutoFill</strong>
      <button id="irctc-progress-minimize" type="button"
        style="border:0;border-radius:8px;padding:4px 9px;background:rgba(255,255,255,0.16);color:#fff;font-weight:700;cursor:pointer;font-size:14px;">−</button>
    `;

    // Step list
    const stepList = document.createElement("ul");
    stepList.id = "irctc-progress-steps";
    stepList.style.cssText = "list-style:none;margin:0;padding:4px 14px 14px;display:grid;gap:6px;";

    STEP_LABELS.forEach((label, index) => {
      const li = document.createElement("li");
      li.dataset.stepIndex = String(index);
      li.dataset.stepState = "pending";
      li.style.cssText = "display:flex;align-items:center;gap:10px;opacity:0.45;";
      li.innerHTML = `
        <span class="irctc-step-indicator" style="width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#999;">●</span>
        <span class="irctc-step-label" style="font-size:12px;">${label}</span>
      `;
      stepList.appendChild(li);
    });

    overlay.appendChild(header);
    overlay.appendChild(stepList);
    document.body.appendChild(overlay);

    // Minimize toggle
    overlay.querySelector("#irctc-progress-minimize").addEventListener("click", () => {
      const isMinimized = overlay.classList.toggle("minimized");
      contentState.progressMinimized = isMinimized;
      stepList.style.display = isMinimized ? "none" : "grid";
      overlay.querySelector("#irctc-progress-minimize").textContent = isMinimized ? "+" : "−";
    });
  }

  function updateProgressOverlay(stepIndex, state) {
    if (typeof stepIndex !== "number" || stepIndex < 0 || stepIndex > 4) {
      return;
    }
    const stepsContainer = document.getElementById("irctc-progress-steps");
    if (!stepsContainer) {
      return;
    }

    // When a step becomes active, auto-complete all lower-index pending steps
    if (state === "active") {
      const allItems = stepsContainer.querySelectorAll("li[data-step-index]");
      allItems.forEach((li) => {
        const idx = Number(li.dataset.stepIndex);
        if (idx < stepIndex && li.dataset.stepState === "pending") {
          applyStepVisual(li, "complete");
        }
      });
    }

    const targetLi = stepsContainer.querySelector(`li[data-step-index="${stepIndex}"]`);
    if (targetLi) {
      applyStepVisual(targetLi, state);
    }
  }

  function applyStepVisual(li, state) {
    li.dataset.stepState = state;
    const indicator = li.querySelector(".irctc-step-indicator");
    const label = li.querySelector(".irctc-step-label");
    if (!indicator || !label) return;

    if (state === "complete") {
      li.style.opacity = "1";
      indicator.innerHTML = "✓";
      indicator.style.cssText = "width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;color:#69f0ae;";
      label.style.cssText = "font-size:12px;color:#fff;text-decoration:line-through;";
    } else if (state === "active") {
      li.style.opacity = "1";
      indicator.innerHTML = "";
      indicator.style.cssText = "width:14px;height:14px;border:2px solid #fff;border-top-color:#4fc3f7;border-radius:50%;animation:spin 0.8s linear infinite;display:inline-block;box-sizing:border-box;";
      label.style.cssText = "font-size:12px;color:#fff;font-weight:700;";
    } else {
      // pending
      li.style.opacity = "0.45";
      indicator.innerHTML = "●";
      indicator.style.cssText = "width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#999;";
      label.style.cssText = "font-size:12px;color:#aaa;";
    }
  }

  function unmountProgressOverlay() {
    const overlay = document.getElementById("irctc-autofill-progress-overlay");
    if (overlay) {
      overlay.remove();
    }
  }

  function resetProgressOverlay() {
    for (let i = 0; i <= 4; i += 1) {
      updateProgressOverlay(i, "pending");
    }
    const page = getCurrentPage();
    if (page === "LOGIN") {
      updateProgressOverlay(0, "active");
    } else if (page === "SEARCH") {
      updateProgressOverlay(0, "complete");
      updateProgressOverlay(1, "active");
    } else if (page === "TRAIN_LIST") {
      updateProgressOverlay(1, "complete");
      updateProgressOverlay(2, "active");
    } else if (page === "PAX") {
      updateProgressOverlay(2, "complete");
      updateProgressOverlay(3, "active");
    } else if (page === "PAYMENT") {
      updateProgressOverlay(3, "complete");
      updateProgressOverlay(4, "complete");
    }
  }

  function updateProgressFromCheckpoint(step) {
    resetProgressOverlay();
    if (step === "STEP_COMPLETED_LOGIN") {
      updateProgressOverlay(0, "complete");
      updateProgressOverlay(1, "active");
      return;
    }
    if (step === "STEP_COMPLETED_SEARCH" || step === "STEP_WAITING_TRAIN_SELECT") {
      updateProgressOverlay(1, "complete");
      updateProgressOverlay(2, "active");
      return;
    }
    if (step === "STEP_COMPLETED_TRAIN_SELECT") {
      updateProgressOverlay(2, "complete");
      updateProgressOverlay(3, "active");
      return;
    }
    if (step === "STEP_COMPLETED_PAX") {
      updateProgressOverlay(3, "complete");
      updateProgressOverlay(4, "active");
      return;
    }
    if (step === "STEP_COMPLETED_PAYMENT") {
      updateProgressOverlay(4, "complete");
    }
  }

  function captureAvailabilitySnapshot() {
    return parseTrainCards()
      .map((train) => `${train.trainNumber}:${Object.entries(train.availability || {}).map(([className, value]) => `${className}-${normalizeText(value)}`).join("|")}`)
      .join("||");
  }

  async function waitForAvailabilityRefresh(previousSnapshot, allowStableFallback = false) {
    const timeoutAt = Date.now() + 10000;
    while (Date.now() < timeoutAt) {
      const trains = parseTrainCards();
      const currentSnapshot = captureAvailabilitySnapshot();
      const hasAvailabilityData = trains.some((train) => Object.values(train.availability || {}).some((value) => normalizeText(value)));
      if (hasAvailabilityData && (allowStableFallback || currentSnapshot !== previousSnapshot)) {
        return true;
      }
      await sleep(300);
    }
    return allowStableFallback;
  }

  function showPersistentErrorToast(message) {
    let toast = document.getElementById("irctc-autofill-persistent-error");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "irctc-autofill-persistent-error";
      toast.style.cssText = [
        "position:fixed",
        "right:18px",
        "bottom:18px",
        "z-index:2147483647",
        "max-width:360px",
        "padding:14px 16px",
        "border-radius:16px",
        "background:#7f1d1d",
        "color:#fff",
        "font:13px/1.45 'Segoe UI',sans-serif",
        "box-shadow:0 18px 40px rgba(0,0,0,0.22)"
      ].join(";");
      document.body.appendChild(toast);
    }
    toast.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div>${escapeHtml(message)}</div>
        <div style="display:flex;justify-content:flex-end;">
          <button id="irctc-persistent-error-dismiss" type="button" style="border:0;border-radius:10px;padding:8px 12px;background:#fff;color:#7f1d1d;font-weight:700;cursor:pointer;">Dismiss</button>
        </div>
      </div>
    `;
    toast.querySelector("#irctc-persistent-error-dismiss")?.addEventListener("click", () => {
      toast.remove();
    });
  }

  function setServerRecoveryPending(value) {
    try {
      sessionStorage.setItem("irctc_server_recovery_pending", value ? "1" : "0");
    } catch (error) {
      /* Ignore storage issues on page context. */
    }
  }

  function getServerRecoveryPending() {
    try {
      return sessionStorage.getItem("irctc_server_recovery_pending") === "1";
    } catch (error) {
      return false;
    }
  }

  function clearServerRecoveryPending() {
    try {
      sessionStorage.removeItem("irctc_server_recovery_pending");
    } catch (error) {
      /* Ignore storage issues on page context. */
    }
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

    await clearCheckpoint();
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
    updateProgressOverlay(4, "complete");
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

      const passengerDetails = (journeyConfig.selectedPassengers || []).map((passenger, index) => `
        <div style="padding:10px 12px;border-radius:14px;background:#fff;border:1px solid #e3e8ff;">
          <div><strong>Passenger ${index + 1}:</strong> ${escapeHtml(passenger.fullName)}</div>
          <div>Age / Gender: ${escapeHtml(`${passenger.age} / ${passenger.gender}`)}</div>
          <div>Berth: ${escapeHtml(passenger.berthPreference || "No Preference")}</div>
          <div>ID Proof: ${escapeHtml(passenger.idProofType || "Not set")} ${passenger.idProofNumber ? `(${escapeHtml(passenger.idProofNumber)})` : ""}</div>
          <div>Senior Concession: ${passenger.seniorConcession || passenger.age >= 60 ? "Yes" : "No"}</div>
        </div>
      `).join("");
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
          <div style="display:grid;gap:8px;">
            <strong>Passengers</strong>
            ${passengerDetails}
          </div>
          <div><strong>Insurance:</strong> ${journeyConfig.preferences?.travelInsurance ? "Yes" : "No"}</div>
          <div><strong>Auto Upgrade:</strong> ${journeyConfig.preferences?.autoUpgrade ? "Yes" : "No"}</div>
          <div><strong>Confirmed Berths Only:</strong> ${journeyConfig.preferences?.onlyConfirmBerths ? "Yes" : "No"}</div>
          <div><strong>Reservation Choice:</strong> ${escapeHtml(journeyConfig.preferences?.reservationChoice || "Not set")}</div>
          <div><strong>Preferred Coach:</strong> ${escapeHtml(journeyConfig.preferences?.preferredCoach || "Not set")}</div>
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

  function getCurrentPage(url = location.href) {
    if (isSearchPage(url)) {
      return "SEARCH";
    }
    if (isTrainListPage(url)) {
      return "TRAIN_LIST";
    }
    if (isPaxDetailsPage(url)) {
      return "PAX";
    }
    if (isPaymentPage(url)) {
      return "PAYMENT";
    }
    if (/login|user-registration/i.test(String(url))) {
      return "LOGIN";
    }
    return "HOME";
  }
})();
