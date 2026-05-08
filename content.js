const Utils = window.IRCTCUtils;
const { STORAGE_KEYS, humanDelay, clearAndType, normalizeText, serializeDomForGemini, safeSendRuntimeMessage, isVisible, escapeHtml, scoreTrainRecommendation, withRetry, showContentToast, getStorage, setStorage } = Utils;

const CHECKPOINT_STEP_LABELS = {
  STEP_COMPLETED_LOGIN: "Login completed",
  STEP_COMPLETED_SEARCH: "Search submitted",
  STEP_WAITING_TRAIN_SELECT: "Waiting for train selection",
  STEP_COMPLETED_TRAIN_SELECT: "Train selected",
  STEP_COMPLETED_PAX: "Passenger details completed",
  STEP_COMPLETED_PAYMENT: "Payment handoff reached"
};

const PAGE_PATTERNS = {
  search: /train-search|search/i,
  trainList: /train-list|seatAvailability|avail|train/i,
  pax: /pax-details|booking\/pax-details/i,
  payment: /payment|booking\/payment/i
};

const SELECTORS = {
  loginNav: ["a[href*='login']", "button[aria-label*='login']", "a:contains('Login')"],
  loginUserId: ["input#userId", "input[name='userId']", "input[placeholder*='User']"],
  loginPassword: ["input#pwd", "input[type='password']", "input[placeholder*='Password']"],
  loginSignIn: ["button[type='submit']", "button:contains('Sign In')", "button:contains('Login')"],
  loggedIn: ["a[title='My Account']", "span:contains('Welcome')", "button:contains('My Account')"],
  fromStation: ["input[aria-controls*='pr_id_1_list']", "input[placeholder*='From']", "input[name='origin']"],
  toStation: ["input[aria-controls*='pr_id_2_list']", "input[placeholder*='To']", "input[name='destination']"],
  journeyDate: ["input[placeholder*='Journey Date']", "input[formcontrolname='journeyDate']", "input[type='date']"],
  journeyClass: ["select[formcontrolname='journeyClass']", "select[name='journeyClass']", "select#journeyClass"],
  quota: ["select[formcontrolname='quota']", "select[name='quota']", "select#quota"],
  searchButton: ["button.search_btn", "button:contains('Find Trains')", "button:contains('Search Trains')"],
  trainCards: [".train-avl-wrap", ".train-card", ".list-group .train-row", "div[data-train]"],
  refreshButton: ["button:contains('Refresh')", "button[title*='Refresh']"],
  bookNow: ["button:contains('Book Now')", "button:contains('BOOK NOW')", "a:contains('Book Now')"],
  addPassenger: ["button:contains('Add Passenger')", "button[aria-label*='Add Passenger']"],
  passengerRows: [".passenger-info", ".passenger-row", ".pax-form-row"],
  continueButtons: ["button:contains('Continue')", "button:contains('Next')", "button:contains('Proceed')"]
};

const contentState = {
  activeConfig: null,
  currentCheckpoint: null,
  autoLoginInFlight: false,
  captchaPaused: false,
  captchaResumeAction: null,
  prePositionOnly: false,
  progressOverlay: null,
  serverDownTimer: null,
  sessionExpiryTimer: null
};

window.contentState = contentState;

init();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_PAGE_AUTOMATION") {
    contentState.activeConfig = message.journeyConfig || null;
    contentState.currentCheckpoint = null;
    saveCheckpoint("STEP_COMPLETED_LOGIN");
    startFlow().catch(() => undefined);
  }
  if (message?.type === "RESUME_BOOKING_FLOW") {
    contentState.currentCheckpoint = message.checkpoint || null;
    contentState.activeConfig = message.checkpoint?.journeyConfig || contentState.activeConfig;
    startFlow().catch(() => undefined);
  }
  sendResponse({ ok: true });
  return true;
});

async function init() {
  try {
    await loadActiveBooking();
    mountProgressOverlay();
    await detectServerDown();
    await detectSessionExpiry();
    showResumeBanner();
    startSessionExpiryWatcher();
    startServerDownWatcher();
    startCaptchaObserver();
    await startFlow();
  } catch (error) {
    console.warn("Init failed", error);
  }
}

async function loadActiveBooking() {
  const storage = await getStorage([STORAGE_KEYS.ACTIVE_BOOKING, STORAGE_KEYS.BOOKING_CHECKPOINT, STORAGE_KEYS.PRE_POSITION_ONLY]);
  contentState.activeConfig = storage[STORAGE_KEYS.ACTIVE_BOOKING] || null;
  contentState.currentCheckpoint = storage[STORAGE_KEYS.BOOKING_CHECKPOINT] || null;
  contentState.prePositionOnly = Boolean(storage[STORAGE_KEYS.PRE_POSITION_ONLY]);
}

function getPageType() {
  const href = location.href;
  if (PAGE_PATTERNS.payment.test(href)) return "payment";
  if (PAGE_PATTERNS.pax.test(href)) return "pax";
  if (PAGE_PATTERNS.trainList.test(href)) return "trainList";
  if (PAGE_PATTERNS.search.test(href)) return "search";
  return "search";
}

async function startFlow() {
  await detectServerDown();
  await detectSessionExpiry();
  const page = getPageType();
  if (await maybeHandleAutoLogin()) {
    return;
  }
  if (page === "search") {
    await withRetry(runSearchAutomation, "search fill");
  } else if (page === "trainList") {
    await withRetry(autoSelectBestTrain, "train selection");
  } else if (page === "pax") {
    await withRetry(runPassengerAutomation, "passenger automation");
  } else if (page === "payment") {
    await handlePaymentPage();
  }
}

async function maybeHandleAutoLogin() {
  if (contentState.autoLoginInFlight) return false;
  if (isLoggedIn()) return false;
  const storage = await getStorage([STORAGE_KEYS.AUTO_LOGIN, STORAGE_KEYS.LOGIN_CREDS]);
  if (!storage[STORAGE_KEYS.AUTO_LOGIN]) return false;
  const creds = storage[STORAGE_KEYS.LOGIN_CREDS] || {};
  const username = creds?.ircLogin ? atob(creds.ircLogin) : "";
  const password = creds?.ircPass ? atob(creds.ircPass) : "";
  if (!username || !password) return false;
  contentState.autoLoginInFlight = true;
  try {
    const success = await autoLogin(username, password);
    contentState.autoLoginInFlight = false;
    if (success) {
      saveCheckpoint("STEP_COMPLETED_LOGIN");
      updateProgressOverlay("login", "complete");
      return true;
    }
  } catch (error) {
    contentState.autoLoginInFlight = false;
    showContentToast(`Auto-login failed: ${error?.message || error}`, "error", true, 0);
  }
  return false;
}

function isLoggedIn() {
  const markers = Array.from(document.querySelectorAll("a,button,span,div"));
  return markers.some((node) => {
    if (!isVisible(node)) return false;
    const text = normalizeText(node.textContent || "");
    return text.includes("my account") || text.includes("welcome") || text.includes("logout");
  });
}

async function autoLogin(username, password) {
  const loginNav = findVisibleElement(SELECTORS.loginNav);
  if (loginNav) {
    loginNav.click();
    await humanDelay(400, 700);
  }
  const usernameField = await waitForVisible(SELECTORS.loginUserId, 10000);
  const passwordField = await waitForVisible(SELECTORS.loginPassword, 10000);
  const signIn = findVisibleElement(SELECTORS.loginSignIn);
  if (!usernameField || !passwordField || !signIn) {
    throw new Error("Login form not available.");
  }
  await clearAndType(usernameField, username);
  await clearAndType(passwordField, password);
  signIn.click();
  const success = await waitForCondition(() => isLoggedIn(), 10000);
  if (!success) {
    throw new Error("Login confirmation not detected.");
  }
  return true;
}

async function runSearchAutomation() {
  const config = contentState.activeConfig || contentState.currentCheckpoint?.journeyConfig;
  if (!config) return;
  const fromInput = await waitForVisible(SELECTORS.fromStation, 15000);
  const toInput = await waitForVisible(SELECTORS.toStation, 15000);
  const dateInput = await waitForVisible(SELECTORS.journeyDate, 15000);
  const classSelect = findVisibleElement(SELECTORS.journeyClass);
  const quotaSelect = findVisibleElement(SELECTORS.quota);
  if (!fromInput || !toInput || !dateInput) throw new Error("Search form fields missing.");
  await detectAndHandleCaptcha("STEP_COMPLETED_SEARCH", runSearchAutomation);
  await clearAndType(fromInput, config.from);
  await humanDelay(300, 600);
  await chooseAutocomplete(config.from);
  await clearAndType(toInput, config.to);
  await humanDelay(300, 600);
  await chooseAutocomplete(config.to);
  setInputValue(dateInput, config.date);
  if (classSelect) setSelectValue(classSelect, config.journeyClass);
  if (quotaSelect) setSelectValue(quotaSelect, config.quota);
  if (contentState.prePositionOnly) {
    showContentToast("Search form filled for Tatkal pre-positioning.", "success", false, 6000);
    return;
  }
  const searchButton = findVisibleElement(SELECTORS.searchButton);
  if (!searchButton) throw new Error("Search button not found.");
  await detectAndHandleCaptcha("STEP_COMPLETED_SEARCH", runSearchAutomation);
  searchButton.click();
  await waitForCondition(() => getPageType() === "trainList", 15000);
  saveCheckpoint("STEP_COMPLETED_SEARCH");
  updateProgressOverlay("search", "complete");
}

async function chooseAutocomplete(value) {
  const listSelectors = [".ui-autocomplete-panel .ui-autocomplete-items .ui-autocomplete-item", ".p-autocomplete-panel .p-autocomplete-item", "li[role='option']"];
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    for (const selector of listSelectors) {
      const items = Array.from(document.querySelectorAll(selector)).filter((item) => isVisible(item));
      const match = items.find((item) => normalizeText(item.textContent || "").includes(normalizeText(value)));
      if (match) {
        match.click();
        await humanDelay(200, 400);
        return;
      }
    }
    await humanDelay(200, 350);
  }
}

function setInputValue(el, value) {
  if (!el) return;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function setSelectValue(el, value) {
  if (!el) return;
  if (el.tagName.toLowerCase() === "select") {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const option = Array.from(el.querySelectorAll("option")).find((opt) => normalizeText(opt.textContent || opt.value) === normalizeText(value));
  if (option) {
    option.selected = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

async function autoSelectBestTrain() {
  const config = contentState.activeConfig || contentState.currentCheckpoint?.journeyConfig;
  if (!config) return;
  if (!config.autoSelectTrain) {
    showContentToast("Manual mode — select your train.", "warning", false, 6000);
    return;
  }
  const cards = await waitForTrainCards(20000);
  if (!cards.length) throw new Error("Train cards not found.");
  clickRefreshButtons();
  await humanDelay(3000, 4000);
  let chosenCard = null;
  if (config.preferredTrain) {
    const prefer = normalizeText(config.preferredTrain);
    chosenCard = cards.find((card) => normalizeText(card.textContent || "").includes(prefer));
    if (!chosenCard) {
      console.warn("Preferred train not found; using scoring.");
    }
  }
  if (!chosenCard) {
    const scored = cards.map((card) => ({ card, score: scoreTrainRecommendation(card, config) }));
    chosenCard = scored.sort((a, b) => b.score - a.score)[0]?.card;
  }
  if (!chosenCard) throw new Error("Could not choose any train.");
  let classButton = findClassButton(chosenCard, config.journeyClass);
  if (!classButton) {
    for (const fallback of config.fallbackClassOrder || ["SL", "3A", "2A", "1A"]) {
      classButton = findClassButton(chosenCard, fallback);
      if (classButton) break;
    }
  }
  if (!classButton) {
    throw new Error("No available class found.");
  }
  await detectAndHandleCaptcha("STEP_COMPLETED_TRAIN_SELECT", autoSelectBestTrain);
  classButton.click();
  await humanDelay(700, 1100);
  let bookButton = findVisibleElement(SELECTORS.bookNow, chosenCard);
  if (!bookButton) {
    const selector = await findWithGeminiFallback("Find the Book Now button in the selected train card.", serializeDomForGemini(chosenCard));
    if (selector) {
      bookButton = chosenCard.querySelector(selector);
    }
  }
  if (!bookButton) throw new Error("Book Now button not found.");
  await detectAndHandleCaptcha("STEP_COMPLETED_TRAIN_SELECT", autoSelectBestTrain);
  bookButton.click();
  await waitForCondition(() => getPageType() === "pax", 15000);
  saveCheckpoint("STEP_COMPLETED_TRAIN_SELECT");
  updateProgressOverlay("train", "complete");
}

function findClassButton(card, classCode) {
  if (!card || !classCode) return null;
  const classText = normalizeText(classCode);
  return Array.from(card.querySelectorAll("button,span,a,div")).find((node) => {
    const text = normalizeText(node.textContent || "");
    return text === classText && isVisible(node) && !node.disabled;
  }) || null;
}

async function waitForTrainCards(timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const cards = Array.from(document.querySelectorAll(SELECTORS.trainCards.join(","))).filter((card) => isVisible(card));
    if (cards.length) return cards;
    await humanDelay(250, 450);
  }
  return [];
}

function clickRefreshButtons() {
  Array.from(document.querySelectorAll(SELECTORS.refreshButton.join(","))).filter((button) => isVisible(button)).forEach((button) => button.click());
}

async function runPassengerAutomation() {
  const config = contentState.activeConfig || contentState.currentCheckpoint?.journeyConfig;
  if (!config) return;
  await detectAndHandleCaptcha("STEP_COMPLETED_PAX", runPassengerAutomation);
  const passengerRows = await waitForPassengerRows();
  const profiles = (await getStorage([STORAGE_KEYS.PASSENGERS]))[STORAGE_KEYS.PASSENGERS] || [];
  const targets = config.preferredPassengers || profiles.slice(0, passengerRows.length);
  await ensurePassengerCount(passengerRows.length, config, passengerRows);
  const rows = Array.from(document.querySelectorAll(SELECTORS.passengerRows.join(","))).filter((row) => isVisible(row));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const passenger = targets[index] || profiles[index];
    if (!passenger) continue;
    await fillPassengerRow(row, passenger);
  }
  applyPassengerPreferences(config);
  const confirmed = await showPassengerConfirmation(targets);
  if (!confirmed) return;
  const continueButton = findVisibleElement(SELECTORS.continueButtons);
  if (!continueButton) throw new Error("Continue button not found on passenger page.");
  await detectAndHandleCaptcha("STEP_COMPLETED_PAX", runPassengerAutomation);
  continueButton.click();
  await waitForCondition(() => getPageType() === "payment", 15000);
  saveCheckpoint("STEP_COMPLETED_PAX");
  updateProgressOverlay("pax", "complete");
}

async function waitForPassengerRows() {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const rows = Array.from(document.querySelectorAll(SELECTORS.passengerRows.join(","))).filter((row) => isVisible(row));
    if (rows.length) return rows;
    await humanDelay(300, 500);
  }
  return [];
}

async function ensurePassengerCount(currentCount, config, rows) {
  const desired = Math.min(6, config.passengerCount || rows.length || 1);
  const addButton = findVisibleElement(SELECTORS.addPassenger);
  for (let i = currentCount; i < desired && addButton; i += 1) {
    addButton.click();
    await humanDelay(500, 900);
  }
}

async function fillPassengerRow(row, passenger) {
  const nameInput = findInput(row, ["input[placeholder*='Name']", "input[name*='name']"]);
  const ageInput = findInput(row, ["input[placeholder*='Age']", "input[name*='age']"]);
  const genderSelect = findInput(row, ["select[name*='gender']", "select[aria-label*='Gender']"]);
  const berthSelect = findInput(row, ["select[name*='berth']", "select[aria-label*='Berth']"]);
  const idProofSelect = findInput(row, ["select[name*='idProof']", "select[aria-label*='ID']"]);
  if (nameInput) await clearAndType(nameInput, passenger.fullName);
  if (ageInput) await clearAndType(ageInput, String(passenger.age));
  if (genderSelect) setSelectValue(genderSelect, passenger.gender);
  if (berthSelect) setSelectValue(berthSelect, passenger.berthPreference);
  if (idProofSelect) setSelectValue(idProofSelect, passenger.idProofType);
  if (passenger.age >= 60) {
    const seniorCheckbox = row.querySelector("input[type='checkbox'][name*='senior'], input[type='checkbox'][aria-label*='Senior']");
    if (seniorCheckbox && !seniorCheckbox.checked) {
      seniorCheckbox.click();
    }
  }
  await humanDelay(200, 400);
}

function findInput(root, selectors) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (el && isVisible(el)) return el;
  }
  return null;
}

function applyPassengerPreferences(config) {
  const checkbox = Array.from(document.querySelectorAll("input[type='checkbox']")).find((input) => {
    const label = normalizeText(input.closest("label")?.textContent || "");
    return label.includes("auto upgrade") || label.includes("confirmed berth");
  });
  const insuranceCheckbox = Array.from(document.querySelectorAll("input[type='checkbox']")).find((input) => normalizeText(input.closest("label")?.textContent || "").includes("travel insurance"));
  if (insuranceCheckbox) {
    if (insuranceCheckbox.checked !== Boolean(config.preferences?.travelInsurance)) {
      insuranceCheckbox.click();
    }
  }
  const autoUpgradeCheckbox = Array.from(document.querySelectorAll("input[type='checkbox']")).find((input) => normalizeText(input.closest("label")?.textContent || "").includes("auto upgrade"));
  if (autoUpgradeCheckbox && autoUpgradeCheckbox.checked !== Boolean(config.preferences?.autoUpgrade)) {
    autoUpgradeCheckbox.click();
  }
  const confirmBerthCheckbox = Array.from(document.querySelectorAll("input[type='checkbox']")).find((input) => normalizeText(input.closest("label")?.textContent || "").includes("confirmed berth"));
  if (confirmBerthCheckbox && confirmBerthCheckbox.checked !== Boolean(config.preferences?.onlyConfirmBerths)) {
    confirmBerthCheckbox.click();
  }
}

function showPassengerConfirmation(passengers) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "irctc-passenger-confirm-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;z-index:99999999;padding:20px;";
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:20px;max-width:520px;width:100%;max-height:90vh;overflow:auto;font:14px/1.5 sans-serif;color:#111;">
        <h2 style="margin-top:0;font-size:18px;">Confirm Passenger Details</h2>
        <div id="irctc-confirm-list" style="margin-bottom:18px;"></div>
        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button id="irctc-edit-passengers" style="padding:10px 14px;border:1px solid #888;border-radius:10px;background:#fff;cursor:pointer;">Let Me Edit</button>
          <button id="irctc-confirm-passengers" style="padding:10px 14px;border:none;border-radius:10px;background:#1976D2;color:#fff;cursor:pointer;">Confirm & Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const list = overlay.querySelector("#irctc-confirm-list");
    passengers.forEach((passenger) => {
      const item = document.createElement("div");
      item.style.marginBottom = "10px";
      item.innerHTML = `
        <strong>${escapeHtml(passenger.fullName)}</strong><br>
        Age: ${escapeHtml(String(passenger.age))} | Gender: ${escapeHtml(passenger.gender)} | Berth: ${escapeHtml(passenger.berthPreference)}<br>
        ID: ${escapeHtml(passenger.idProofType)} ${escapeHtml(passenger.idProofNumber)}
      `;
      list.appendChild(item);
    });
    overlay.querySelector("#irctc-edit-passengers").addEventListener("click", () => { overlay.remove(); resolve(false); });
    overlay.querySelector("#irctc-confirm-passengers").addEventListener("click", () => { overlay.remove(); resolve(true); });
  });
}

async function handlePaymentPage() {
  showContentToast("AutoFill complete — please proceed with payment.", "success", true, 0);
  await saveBookingHistory();
  saveCheckpoint("STEP_COMPLETED_PAYMENT");
  updateProgressOverlay("payment", "complete");
}

async function saveBookingHistory() {
  try {
    const storage = await getStorage([STORAGE_KEYS.BOOKING_HISTORY]);
    const history = storage[STORAGE_KEYS.BOOKING_HISTORY] || [];
    const summary = {
      timestamp: new Date().toISOString(),
      journeyConfig: contentState.activeConfig || contentState.currentCheckpoint?.journeyConfig,
      from: contentState.activeConfig?.from || contentState.currentCheckpoint?.journeyConfig?.from,
      to: contentState.activeConfig?.to || contentState.currentCheckpoint?.journeyConfig?.to,
      date: contentState.activeConfig?.date || contentState.currentCheckpoint?.journeyConfig?.date
    };
    history.unshift(summary);
    await setStorage({ [STORAGE_KEYS.BOOKING_HISTORY]: history.slice(0, 20) });
  } catch (error) {
    console.warn("Failed to save booking history", error);
  }
}

function findVisibleElement(selectors, root = document) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const selector of list) {
    try {
      const nodes = Array.from(root.querySelectorAll(selector));
      const visible = nodes.find((node) => isVisible(node));
      if (visible) return visible;
    } catch (error) {
      // ignore invalid selector syntax
    }
  }
  return null;
}

async function waitForVisible(selectors, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const el = findVisibleElement(selectors);
    if (el) return el;
    await humanDelay(250, 450);
  }
  return null;
}

async function waitForCondition(condition, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (condition()) return true;
    await humanDelay(250, 400);
  }
  return false;
}

async function detectAndHandleCaptcha(step, resumeAction) {
  if (contentState.captchaPaused) return false;
  if (!isCaptchaPresent()) return false;
  contentState.captchaPaused = true;
  contentState.captchaResumeAction = resumeAction;
  mountCaptchaBanner();
  return true;
}

function isCaptchaPresent() {
  const candidates = Array.from(document.querySelectorAll("iframe,img,div,span,label"));
  return candidates.some((node) => {
    if (!isVisible(node)) return false;
    const src = String(node.src || "").toLowerCase();
    const text = normalizeText(node.textContent || node.alt || node.title || "");
    return src.includes("captcha") || text.includes("captcha") || text.includes("i am not a robot") || text.includes("verify");
  });
}

function mountCaptchaBanner() {
  if (document.getElementById("irctc-captcha-banner")) return;
  const banner = document.createElement("div");
  banner.id = "irctc-captcha-banner";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999999;background:#B71C1C;color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.25);";
  banner.innerHTML = `<span>CAPTCHA detected — solve it then click Continue</span><button id="irctc-captcha-continue" style="border:none;border-radius:10px;padding:10px 14px;background:#fff;color:#B71C1C;cursor:pointer;">Continue After CAPTCHA</button>`;
  document.body.appendChild(banner);
  banner.querySelector("#irctc-captcha-continue").addEventListener("click", async () => {
    banner.remove();
    contentState.captchaPaused = false;
    const action = contentState.captchaResumeAction;
    contentState.captchaResumeAction = null;
    if (typeof action === "function") {
      await action();
    }
  });
}

function startCaptchaObserver() {
  const observer = new MutationObserver(async () => {
    if (!contentState.captchaPaused && isCaptchaPresent()) {
      await detectAndHandleCaptcha("STEP_UNKNOWN", contentState.captchaResumeAction);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
}

async function detectSessionExpiry() {
  if (!contentState.activeConfig) return false;
  const body = normalizeText(document.body?.textContent || "");
  const expired = /session.*expired|logged.*out|please.*login|session timeout/i.test(body) || PAGE_PATTERNS.search.test(location.href);
  if (!expired) return false;
  showContentToast("Session expired detected — attempting re-login.", "warning", true, 0);
  const storage = await getStorage([STORAGE_KEYS.LOGIN_CREDS]);
  const creds = storage[STORAGE_KEYS.LOGIN_CREDS] || {};
  const username = creds?.ircLogin ? atob(creds.ircLogin) : "";
  const password = creds?.ircPass ? atob(creds.ircPass) : "";
  if (!username || !password) return false;
  await maybeHandleAutoLogin();
  return true;
}

function startSessionExpiryWatcher() {
  if (contentState.sessionExpiryTimer) return;
  contentState.sessionExpiryTimer = setInterval(() => {
    if (contentState.activeConfig) {
      detectSessionExpiry().catch(() => undefined);
    }
  }, 15000);
}

async function detectServerDown() {
  const title = normalizeText(document.title || "");
  const body = normalizeText(document.body?.textContent || "");
  const down = /503|502|service unavailable|maintenance|temporarily unavailable/i.test(title + " " + body) || !document.querySelector("app-root, #app");
  if (!down) {
    unmountServerDownBanner();
    return false;
  }
  mountServerDownBanner();
  await safeSendRuntimeMessage({ type: "SERVER_DOWN_NOTIFY" });
  return true;
}

function mountServerDownBanner() {
  if (document.getElementById("irctc-server-down-banner")) return;
  const banner = document.createElement("div");
  banner.id = "irctc-server-down-banner";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999999;background:#4A148C;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 10px 30px rgba(0,0,0,.25);";
  const timer = document.createElement("span");
  timer.id = "irctc-server-down-countdown";
  timer.textContent = "Retrying in 30s";
  const button = document.createElement("button");
  button.textContent = "Reload Now";
  button.style.cssText = "border:none;border-radius:10px;padding:10px 14px;background:#fff;color:#4A148C;cursor:pointer;";
  button.addEventListener("click", () => location.reload());
  banner.appendChild(document.createElement("div")).textContent = "IRCTC appears to be down — retrying automatically.";
  banner.appendChild(timer);
  banner.appendChild(button);
  document.body.appendChild(banner);
  let count = 30;
  if (contentState.serverDownTimer) clearInterval(contentState.serverDownTimer);
  contentState.serverDownTimer = setInterval(() => {
    count -= 1;
    timer.textContent = `Retrying in ${count}s`;
    if (count <= 0) {
      clearInterval(contentState.serverDownTimer);
      contentState.serverDownTimer = null;
      location.reload();
    }
  }, 1000);
}

function unmountServerDownBanner() {
  const banner = document.getElementById("irctc-server-down-banner");
  if (banner) banner.remove();
  if (contentState.serverDownTimer) {
    clearInterval(contentState.serverDownTimer);
    contentState.serverDownTimer = null;
  }
}

function startServerDownWatcher() {
  setInterval(() => {
    if (contentState.activeConfig) {
      detectServerDown().catch(() => undefined);
    }
  }, 30000);
}

async function saveCheckpoint(step) {
  const checkpoint = {
    step,
    timestamp: new Date().toISOString(),
    journeyConfig: contentState.activeConfig || contentState.currentCheckpoint?.journeyConfig || null
  };
  await setStorage({ [STORAGE_KEYS.BOOKING_CHECKPOINT]: checkpoint });
  contentState.currentCheckpoint = checkpoint;
  updateProgressOverlay(step, "complete");
}

async function showResumeBanner() {
  const checkpoint = contentState.currentCheckpoint;
  if (!checkpoint?.journeyConfig) return;
  if (document.getElementById("irctc-resume-banner")) return;
  const banner = document.createElement("div");
  banner.id = "irctc-resume-banner";
  banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999998;background:#0D47A1;color:#fff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 10px 30px rgba(0,0,0,.22);";
  banner.innerHTML = `<span>Resume booking: ${escapeHtml(checkpoint.journeyConfig.from)} → ${escapeHtml(checkpoint.journeyConfig.to)} on ${escapeHtml(checkpoint.journeyConfig.date)} — Last step: ${escapeHtml(CHECKPOINT_STEP_LABELS[checkpoint.step] || checkpoint.step)}</span>`;
  const controls = document.createElement("div");
  const continueBtn = document.createElement("button");
  continueBtn.textContent = "Continue";
  continueBtn.style.cssText = "margin-right:8px;padding:8px 12px;border-radius:10px;background:#fff;color:#0D47A1;border:none;cursor:pointer;";
  continueBtn.addEventListener("click", async () => { banner.remove(); await resumeFlow(); });
  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Dismiss";
  dismissBtn.style.cssText = "padding:8px 12px;border-radius:10px;background:#B0BEC5;color:#1A237E;border:none;cursor:pointer;";
  dismissBtn.addEventListener("click", async () => { await setStorage({ [STORAGE_KEYS.BOOKING_CHECKPOINT]: null }); banner.remove(); });
  controls.appendChild(continueBtn);
  controls.appendChild(dismissBtn);
  banner.appendChild(controls);
  document.body.appendChild(banner);
}

async function resumeFlow() {
  const checkpoint = await loadCheckpoint();
  if (!checkpoint?.journeyConfig) return;
  contentState.currentCheckpoint = checkpoint;
  contentState.activeConfig = checkpoint.journeyConfig;
  await startFlow();
}

async function loadCheckpoint() {
  const storage = await getStorage([STORAGE_KEYS.BOOKING_CHECKPOINT]);
  const checkpoint = storage[STORAGE_KEYS.BOOKING_CHECKPOINT] || null;
  if (!checkpoint?.timestamp) return null;
  if (Date.now() - new Date(checkpoint.timestamp).getTime() > 30 * 60 * 1000) {
    await setStorage({ [STORAGE_KEYS.BOOKING_CHECKPOINT]: null });
    return null;
  }
  return checkpoint;
}

function mountProgressOverlay() {
  if (contentState.progressOverlay) return;
  const overlay = document.createElement("div");
  overlay.id = "irctc-progress-overlay";
  overlay.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:99999999;background:rgba(255,255,255,.97);border:1px solid rgba(0,0,0,.12);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.22);padding:14px;width:240px;font:12px/1.4 sans-serif;color:#111;";
  overlay.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><strong>IRCTC Progress</strong><button id="irctc-progress-toggle" style="background:none;border:none;color:#1976D2;cursor:pointer;padding:0;font-size:12px;">Minimize</button></div><div id="irctc-progress-steps"></div>`;
  document.body.appendChild(overlay);
  document.getElementById("irctc-progress-toggle").addEventListener("click", toggleProgressOverlay);
  const steps = document.getElementById("irctc-progress-steps");
  ["login", "search", "train", "pax", "payment"].forEach((key) => {
    const item = document.createElement("div");
    item.id = `irctc-progress-${key}`;
    item.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid rgba(0,0,0,.08);";
    item.innerHTML = `<span>${escapeHtml(key === "train" ? "Select Train" : key === "pax" ? "Passenger Details" : key === "payment" ? "Payment" : key.charAt(0).toUpperCase() + key.slice(1))}</span><span style=\"width:14px;height:14px;border-radius:50%;background:#B0BEC5;display:inline-block;\"></span>`;
    steps.appendChild(item);
  });
  contentState.progressOverlay = overlay;
}

function toggleProgressOverlay() {
  if (!contentState.progressOverlay) return;
  const steps = document.getElementById("irctc-progress-steps");
  const minimized = contentState.progressOverlay.getAttribute("data-minimized") === "true";
  if (minimized) {
    steps.style.display = "block";
    contentState.progressOverlay.setAttribute("data-minimized", "false");
  } else {
    steps.style.display = "none";
    contentState.progressOverlay.setAttribute("data-minimized", "true");
  }
}

function updateProgressOverlay(step, state) {
  const item = document.getElementById(`irctc-progress-${step}`);
  if (!item) return;
  const dot = item.querySelector("span:last-child");
  if (!dot) return;
  if (state === "complete") {
    dot.style.background = "#2E7D32";
  } else if (state === "active") {
    dot.style.background = "#1976D2";
  } else {
    dot.style.background = "#B0BEC5";
  }
}
