/* global chrome, IRCTCUtils */

(function () {
  const {
    JOURNEY_CLASSES,
    QUOTAS,
    PAYMENT_MODES,
    todayISO,
    DEFAULT_PREFERENCES,
    STORAGE_KEYS,
    getStorage,
    setStorage,
    computeTatkalTime,
    formatTimestamp,
    summarizeConfig
  } = IRCTCUtils;

  const state = {
    passengers: [],
    groups: [],
    savedStations: [],
    bookingHistory: [],
    availabilityAlerts: [],
    journeyDraft: null,
    runtimeStatus: null,
    recommendation: null,
    selectedPassengerIds: new Set(),
    fallbackClassOrder: ["3A", "2A", "SL", "1A"],
    availabilityResults: null,
    tatkalRushConfig: null,
    bookingCheckpoint: null
  };

  const elements = {};
  let popupPort = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    captureElements();
    seedStaticControls();
    attachEvents();
    connectPort();
    await loadState();
    await hydrateCurrentTabContext();
  }

  function captureElements() {
    [
      "tatkalRushMode",
      "fromStation",
      "toStation",
      "journeyDate",
      "passengerCount",
      "journeyClass",
      "quota",
      "preferredTrain",
      "fallbackClassOrderList",
      "autoSelectTrain",
      "travelInsurance",
      "autoUpgrade",
      "onlyConfirmBerths",
      "paymentMode",
      "preferredCoach",
      "reservationChoice",
      "tatkalClassAc",
      "tatkalClassSleeper",
      "tatkalClassBoth",
      "tatkalSlotDisplay",
      "tatkalReminderDisplay",
      "tatkalAlarmStatus",
      "armTatkalButton",
      "disarmTatkalButton",
      "statusCard",
      "statusPhase",
      "statusMessage",
      "statusSteps",
      "passengerCards",
      "openOptionsButton",
      "resumeBookingButton",
      "startBookingButton",
      "saveConfigButton",
      "recommendationCard",
      "recommendationText",
      "savedStationsList",
      "availabilityFrom",
      "availabilityTo",
      "availabilityDate",
      "availabilityQuota",
      "availabilityClass",
      "createAvailabilityAlert",
      "checkAvailabilityButton",
      "saveAlertButton",
      "availabilityLoading",
      "availabilityResults",
      "availabilityAlertsList",
      "historyList"
    ].forEach((id) => {
      elements[id] = document.getElementById(id);
    });
  }

  function seedStaticControls() {
    seedSelect(elements.passengerCount, [1, 2, 3, 4, 5, 6], "1");
    seedSelect(elements.journeyClass, JOURNEY_CLASSES, "3A");
    seedSelect(elements.quota, QUOTAS, "General");
    seedSelect(elements.paymentMode, PAYMENT_MODES, DEFAULT_PREFERENCES.paymentMode);
    seedSelect(elements.availabilityClass, ["SL", "3A", "2A"], "3A");
    seedSelect(elements.availabilityQuota, QUOTAS, "General");
    elements.journeyDate.value = todayISO();
    elements.availabilityDate.value = todayISO();
  }

  function attachEvents() {
    document.querySelectorAll(".tab-button").forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.tab));
    });

    document.querySelectorAll(".collapse-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const section = button.closest(".collapsible");
        if (section) {
          section.classList.toggle("open");
        }
      });
    });

    elements.openOptionsButton.addEventListener("click", async () => {
      try {
        await chrome.runtime.openOptionsPage();
      } catch (error) {
        await sendMessage({ type: "OPEN_OPTIONS" });
      }
    });
    elements.resumeBookingButton.addEventListener("click", resumeLastBooking);
    elements.saveConfigButton.addEventListener("click", saveSetup);
    elements.startBookingButton.addEventListener("click", startBooking);
    elements.checkAvailabilityButton.addEventListener("click", checkAvailability);
    elements.saveAlertButton.addEventListener("click", saveAvailabilityAlert);
    elements.tatkalRushMode.addEventListener("change", async () => {
      syncAutoSelectConstraint();
      updateTatkalDisplays();
      await persistDraftSilently();
    });
    elements.autoSelectTrain.addEventListener("change", persistDraftSilently);
    [elements.tatkalClassAc, elements.tatkalClassSleeper, elements.tatkalClassBoth].forEach((radio) => {
      radio.addEventListener("change", async () => {
        updateTatkalDisplays();
        await persistDraftSilently();
      });
    });
    elements.armTatkalButton.addEventListener("click", armTatkalRush);
    elements.disarmTatkalButton.addEventListener("click", disarmTatkalRush);

    if (elements.fallbackClassOrderList) {
      elements.fallbackClassOrderList.addEventListener("dragstart", onFallbackDragStart);
      elements.fallbackClassOrderList.addEventListener("dragover", onFallbackDragOver);
      elements.fallbackClassOrderList.addEventListener("drop", onFallbackDrop);
      elements.fallbackClassOrderList.addEventListener("dragend", onFallbackDragEnd);
    }
  }

  function onFallbackDragStart(event) {
    event.dataTransfer?.setData("text/plain", (event.target && event.target.dataset?.value) || "");
    event.dataTransfer.effectAllowed = "move";
    if (event.target) {
      event.target.classList.add("dragging");
    }
  }

  function onFallbackDragOver(event) {
    event.preventDefault();
    const list = elements.fallbackClassOrderList;
    const afterElement = getDragAfterElement(list, event.clientY);
    const dragging = list.querySelector(".dragging");
    if (!dragging) {
      return;
    }
    if (afterElement == null) {
      list.appendChild(dragging);
    } else {
      list.insertBefore(dragging, afterElement);
    }
  }

  function onFallbackDrop(event) {
    event.preventDefault();
    state.fallbackClassOrder = readFallbackClassOrder();
  }

  function onFallbackDragEnd(event) {
    if (event.target) {
      event.target.classList.remove("dragging");
    }
    state.fallbackClassOrder = readFallbackClassOrder();
  }

  function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll("li:not(.dragging)")];
    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
  }

  function renderFallbackClassOrder() {
    if (!elements.fallbackClassOrderList) {
      return;
    }
    elements.fallbackClassOrderList.innerHTML = "";
    const order = Array.isArray(state.fallbackClassOrder) && state.fallbackClassOrder.length
      ? state.fallbackClassOrder
      : ["3A", "2A", "SL", "1A"];
    order.forEach((value) => {
      const li = document.createElement("li");
      li.dataset.value = value;
      li.draggable = true;
      li.textContent = value;
      elements.fallbackClassOrderList.appendChild(li);
    });
  }

  function readFallbackClassOrder() {
    if (!elements.fallbackClassOrderList) {
      return ["3A", "2A", "SL", "1A"];
    }
    return Array.from(elements.fallbackClassOrderList.querySelectorAll("li"))
      .map((li) => li.dataset.value)
      .filter(Boolean);
  }

  function connectPort() {
    popupPort = chrome.runtime.connect({ name: "popup-channel" });
    popupPort.onMessage.addListener((message) => {
      if (message.type === "status-updated") {
        state.runtimeStatus = message.payload;
        renderRuntimeStatus();
      }
      if (message.type === "availability-result") {
        state.availabilityResults = message.payload;
        elements.availabilityLoading.classList.add("hidden");
        renderAvailabilityResults();
      }
      if (message.type === "history-updated") {
        state.bookingHistory = [message.payload, ...state.bookingHistory].slice(0, 10);
        renderHistory();
      }
    });
  }

  async function loadState() {
    const response = await sendMessage({ type: "GET_EXTENSION_STATE" });
    state.passengers = response.passengers || [];
    state.groups = response.groups || [];
    state.savedStations = response.savedStations || [];
    state.bookingHistory = response.bookingHistory || [];
    state.availabilityAlerts = response.availabilityAlerts || [];
    state.journeyDraft = response.journeyDraft || null;
    state.runtimeStatus = response.runtimeStatus || null;
    state.recommendation = response.latestRecommendation || null;
    state.tatkalRushConfig = response.tatkalRushConfig || null;
    state.bookingCheckpoint = await getValidCheckpoint();
    applyDraft();
    renderStations();
    renderPassengerCards();
    renderRuntimeStatus();
    renderRecommendation();
    renderAvailabilityAlerts();
    renderHistory();
    renderResumeBookingButton();
    updateTatkalDisplays();
    await refreshTatkalAlarmStatus();
  }

  async function hydrateCurrentTabContext() {
    const response = await sendMessage({ type: "GET_RECOMMENDATION" });
    if (response.latestRecommendation) {
      state.recommendation = response.latestRecommendation;
      renderRecommendation();
    }
  }

  function applyDraft() {
    const draft = state.journeyDraft;
    if (!draft) {
      elements.tatkalRushMode.checked = false;
      elements.autoSelectTrain.checked = false;
      elements.preferredTrain.value = "";
      state.fallbackClassOrder = ["3A", "2A", "SL", "1A"];
      renderFallbackClassOrder();
      applyTatkalClassType("ac");
      applyPreferences(DEFAULT_PREFERENCES);
      syncAutoSelectConstraint();
      return;
    }

    elements.fromStation.value = draft.fromStation || "";
    elements.toStation.value = draft.toStation || "";
    elements.journeyDate.value = draft.journeyDate || todayISO();
    elements.passengerCount.value = String(draft.passengerCount || 1);
    elements.journeyClass.value = draft.journeyClass || "3A";
    elements.quota.value = draft.quota || "General";
    elements.preferredTrain.value = draft.preferredTrain || "";
    state.fallbackClassOrder = Array.isArray(draft.fallbackClassOrder) && draft.fallbackClassOrder.length
      ? draft.fallbackClassOrder
      : ["3A", "2A", "SL", "1A"];
    renderFallbackClassOrder();
    elements.tatkalRushMode.checked = Boolean(draft.tatkalRushMode);
    elements.autoSelectTrain.checked = Boolean(draft.autoSelectTrain || draft.metadata?.autoSelectTrain);
    state.selectedPassengerIds = new Set(draft.selectedPassengerIds || []);
    applyTatkalClassType(state.tatkalRushConfig?.tatkalClassType || inferTatkalClassType(draft));
    applyPreferences(draft.preferences || DEFAULT_PREFERENCES);
    syncAutoSelectConstraint();
  }

  function applyPreferences(preferences) {
    elements.travelInsurance.checked = Boolean(preferences.travelInsurance);
    elements.autoUpgrade.checked = Boolean(preferences.autoUpgrade);
    elements.onlyConfirmBerths.checked = Boolean(preferences.onlyConfirmBerths);
    elements.paymentMode.value = preferences.paymentMode || DEFAULT_PREFERENCES.paymentMode;
    elements.preferredCoach.value = preferences.preferredCoach || "";
    elements.reservationChoice.value = preferences.reservationChoice || "";
  }

  function readForm() {
    const tatkalRushMode = elements.tatkalRushMode.checked;
    const autoSelectTrain = tatkalRushMode ? true : elements.autoSelectTrain.checked;
    return {
      fromStation: elements.fromStation.value.trim(),
      toStation: elements.toStation.value.trim(),
      journeyDate: elements.journeyDate.value,
      passengerCount: Number(elements.passengerCount.value),
      journeyClass: elements.journeyClass.value,
      quota: elements.quota.value,
      selectedPassengerIds: Array.from(state.selectedPassengerIds),
      preferences: {
        travelInsurance: elements.travelInsurance.checked,
        autoUpgrade: elements.autoUpgrade.checked,
        onlyConfirmBerths: elements.onlyConfirmBerths.checked,
        paymentMode: elements.paymentMode.value,
        preferredCoach: elements.preferredCoach.value.trim(),
        reservationChoice: elements.reservationChoice.value.trim()
      },
      preferredTrain: elements.preferredTrain.value.trim(),
      fallbackClassOrder: readFallbackClassOrder(),
      tatkalRushMode,
      autoSelectTrain,
      tatkalClassType: getSelectedTatkalClassType(),
      metadata: {
        autoSelectTrain
      }
    };
  }

  function validateForm(data) {
    if (!data.fromStation || !data.toStation) {
      throw new Error("Please enter both From and To stations.");
    }
    if (!data.journeyDate) {
      throw new Error("Please choose a journey date.");
    }
    if (!data.selectedPassengerIds.length) {
      throw new Error("Select at least one passenger profile.");
    }
  }

  async function saveSetup() {
    try {
      const payload = readForm();
      validateForm(payload);
      const response = await sendMessage({ type: "SAVE_JOURNEY_DRAFT", payload });
      state.journeyDraft = mergeJourneyExtras(response.journeyDraft, payload);
      state.savedStations = response.savedStations || state.savedStations;
      await persistJourneyExtras(state.journeyDraft, payload);
      renderStations();
      setInlineStatus("ready", `Setup saved. ${summarizeConfig(state.journeyDraft)}`);
      await refreshTatkalAlarmStatus();
    } catch (error) {
      setInlineStatus("error", error.message);
    }
  }

  async function startBooking() {
    try {
      const payload = readForm();
      validateForm(payload);
      await clearCheckpoint();
      const saveResponse = await sendMessage({ type: "SAVE_JOURNEY_DRAFT", payload });
      state.journeyDraft = mergeJourneyExtras(saveResponse.journeyDraft, payload);
      await persistJourneyExtras(state.journeyDraft, payload);
      setInlineStatus("active", "Starting IRCTC automation...");
      await sendMessage({ type: "START_BOOKING_FLOW", payload });
      window.close();
    } catch (error) {
      setInlineStatus("error", error.message);
    }
  }

  async function checkAvailability() {
    const payload = {
      fromStation: elements.availabilityFrom.value.trim(),
      toStation: elements.availabilityTo.value.trim(),
      journeyDate: elements.availabilityDate.value,
      journeyClass: elements.availabilityClass.value,
      quota: elements.availabilityQuota.value
    };

    if (!payload.fromStation || !payload.toStation || !payload.journeyDate) {
      setInlineStatus("error", "Enter route and date before checking availability.");
      return;
    }

    elements.availabilityLoading.classList.remove("hidden");
    state.availabilityResults = null;
    renderAvailabilityResults();
    await sendMessage({ type: "RUN_AVAILABILITY_CHECK", payload });
    setInlineStatus("active", "Availability check launched in the background.");
  }

  async function saveAvailabilityAlert() {
    const payload = {
      fromStation: elements.availabilityFrom.value.trim(),
      toStation: elements.availabilityTo.value.trim(),
      journeyDate: elements.availabilityDate.value,
      journeyClass: elements.availabilityClass.value,
      quota: elements.availabilityQuota.value,
      enabled: elements.createAvailabilityAlert.checked
    };

    if (!payload.fromStation || !payload.toStation || !payload.journeyDate) {
      setInlineStatus("error", "Enter route and date before saving an alert.");
      return;
    }

    const response = await sendMessage({ type: "SAVE_AVAILABILITY_ALERT", payload });
    state.availabilityAlerts = response.availabilityAlerts || [];
    renderAvailabilityAlerts();
    setInlineStatus("ready", "Availability alert saved.");
  }

  function renderStations() {
    elements.savedStationsList.innerHTML = "";
    state.savedStations.forEach((station) => {
      const option = document.createElement("option");
      option.value = station;
      elements.savedStationsList.appendChild(option);
    });
  }

  function renderPassengerCards() {
    const container = elements.passengerCards;
    container.innerHTML = "";

    if (!state.passengers.length) {
      container.classList.add("empty-state");
      container.textContent = "No passenger profiles saved yet.";
      return;
    }

    container.classList.remove("empty-state");
    state.passengers.forEach((passenger) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `passenger-card ${state.selectedPassengerIds.has(passenger.id) ? "selected" : ""}`;
      card.innerHTML = `
        <strong>${escapeHtml(passenger.fullName)}</strong>
        <div class="meta">${escapeHtml(`${passenger.age} yrs | ${passenger.gender} | ${passenger.berthPreference}`)}</div>
      `;
      card.addEventListener("click", () => {
        if (state.selectedPassengerIds.has(passenger.id)) {
          state.selectedPassengerIds.delete(passenger.id);
        } else if (state.selectedPassengerIds.size < 6) {
          state.selectedPassengerIds.add(passenger.id);
        }
        renderPassengerCards();
      });
      container.appendChild(card);
    });
  }

  function renderRuntimeStatus() {
    const status = state.runtimeStatus;
    const phase = status?.phase || "idle";
    elements.statusPhase.textContent = phase.replace(/^\w/, (char) => char.toUpperCase());
    elements.statusPhase.className = `pill ${phase === "error" ? "error" : phase === "complete" || phase === "ready" ? "success" : "neutral"}`;
    elements.statusMessage.textContent = status?.message || "Configure your trip and start when ready.";
    elements.statusSteps.innerHTML = "";

    (status?.steps || []).forEach((step) => {
      const item = document.createElement("div");
      item.className = `status-step ${step.state || "pending"}`;
      item.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="dot"></span>
          <div>${escapeHtml(step.label)}</div>
        </div>
        <span class="meta">${escapeHtml(step.detail || "")}</span>
      `;
      elements.statusSteps.appendChild(item);
    });
  }

  function renderRecommendation() {
    if (!state.recommendation?.summary) {
      elements.recommendationCard.classList.add("hidden");
      return;
    }
    elements.recommendationCard.classList.remove("hidden");
    elements.recommendationText.textContent = state.recommendation.summary;
  }

  function renderAvailabilityResults() {
    const container = elements.availabilityResults;
    container.innerHTML = "";

    if (!state.availabilityResults?.results) {
      container.classList.add("empty-state");
      container.textContent = "No results yet.";
      return;
    }

    container.classList.remove("empty-state");
    Object.entries(state.availabilityResults.results).forEach(([className, value]) => {
      const card = document.createElement("div");
      card.className = "availability-card";
      card.innerHTML = `
        <strong>${escapeHtml(className)}</strong>
        <div class="meta">${escapeHtml(String(value || "Unavailable"))}</div>
      `;
      container.appendChild(card);
    });
  }

  function renderAvailabilityAlerts() {
    const container = elements.availabilityAlertsList;
    container.innerHTML = "";

    if (!state.availabilityAlerts.length) {
      container.classList.add("empty-state");
      container.textContent = "No active alerts.";
      return;
    }

    container.classList.remove("empty-state");
    state.availabilityAlerts.forEach((alert) => {
      const item = document.createElement("div");
      item.className = "alert-item";
      item.innerHTML = `
        <strong>${escapeHtml(`${alert.fromStation} -> ${alert.toStation}`)}</strong>
        <div class="meta">${escapeHtml(`${alert.journeyDate} | ${alert.journeyClass} | ${alert.quota}`)}</div>
        <div class="history-actions">
          <button class="chip-button" type="button" data-action="delete-alert" data-id="${alert.id}">Delete</button>
        </div>
      `;
      item.querySelector("[data-action='delete-alert']").addEventListener("click", async () => {
        const response = await sendMessage({ type: "DELETE_AVAILABILITY_ALERT", payload: { id: alert.id } });
        state.availabilityAlerts = response.availabilityAlerts || [];
        renderAvailabilityAlerts();
      });
      container.appendChild(item);
    });
  }

  function renderHistory() {
    const container = elements.historyList;
    container.innerHTML = "";

    if (!state.bookingHistory.length) {
      container.classList.add("empty-state");
      container.textContent = "No booking history yet.";
      return;
    }

    container.classList.remove("empty-state");
    state.bookingHistory.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <strong>${escapeHtml(`${entry.fromStation} -> ${entry.toStation}`)}</strong>
        <div class="meta">${escapeHtml(`${entry.trainName} | ${entry.journeyClass}`)}</div>
        <div class="meta">${escapeHtml((entry.passengers || []).join(", "))}</div>
        <div class="meta">${escapeHtml(formatTimestamp(entry.timestamp))}</div>
        <div class="history-actions">
          <button class="chip-button" type="button">Re-book</button>
        </div>
      `;
      item.querySelector("button").addEventListener("click", async () => {
        const config = entry.journeyConfig;
        await sendMessage({
          type: "SAVE_JOURNEY_DRAFT",
          payload: {
            ...config,
            selectedPassengerIds: config.selectedPassengerIds || (config.selectedPassengers || []).map((passenger) => passenger.id)
          }
        });
        state.journeyDraft = config;
        state.selectedPassengerIds = new Set(config.selectedPassengerIds || []);
        switchTab("booking");
        applyDraft();
        renderPassengerCards();
        setInlineStatus("ready", "Previous booking loaded into the form.");
      });
      container.appendChild(item);
    });
  }

  function renderResumeBookingButton() {
    const checkpoint = state.bookingCheckpoint;
    if (!checkpoint?.journeyConfig) {
      elements.resumeBookingButton.classList.add("hidden");
      elements.resumeBookingButton.textContent = "";
      return;
    }

    const route = `${checkpoint.journeyConfig.fromStation} -> ${checkpoint.journeyConfig.toStation}`;
    elements.resumeBookingButton.textContent = `▶ Resume: ${route} — Last step: ${getCheckpointStepLabel(checkpoint.step)}`;
    elements.resumeBookingButton.classList.remove("hidden");
  }

  function switchTab(tabName) {
    document.querySelectorAll(".tab-button").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tabName);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.panel === tabName);
    });
  }

  function setInlineStatus(phase, message) {
    state.runtimeStatus = {
      phase,
      message,
      steps: state.runtimeStatus?.steps || []
    };
    renderRuntimeStatus();
  }

  async function sendMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || "Unknown extension error");
    }
    return response;
  }

  function seedSelect(select, values, selectedValue) {
    select.innerHTML = "";
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      if (String(value) === String(selectedValue)) {
        option.selected = true;
      }
      select.appendChild(option);
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

  async function getValidCheckpoint() {
    const { [STORAGE_KEYS.BOOKING_CHECKPOINT]: checkpoint } = await getStorage([STORAGE_KEYS.BOOKING_CHECKPOINT]);
    if (!checkpoint?.timestamp) {
      return null;
    }

    if (Date.now() - new Date(checkpoint.timestamp).getTime() > 30 * 60 * 1000) {
      await clearCheckpoint();
      return null;
    }

    return checkpoint;
  }

  async function clearCheckpoint() {
    state.bookingCheckpoint = null;
    await setStorage({ [STORAGE_KEYS.BOOKING_CHECKPOINT]: null });
    renderResumeBookingButton();
  }

  function getCheckpointStepLabel(step) {
    return {
      STEP_COMPLETED_LOGIN: "Login completed",
      STEP_COMPLETED_SEARCH: "Search submitted",
      STEP_WAITING_TRAIN_SELECT: "Waiting for train selection",
      STEP_COMPLETED_TRAIN_SELECT: "Train selected",
      STEP_COMPLETED_PAX: "Passenger details completed",
      STEP_COMPLETED_PAYMENT: "Payment handoff reached"
    }[step] || "In progress";
  }

  async function resumeLastBooking() {
    try {
      const checkpoint = await getValidCheckpoint();
      state.bookingCheckpoint = checkpoint;
      renderResumeBookingButton();

      if (!checkpoint?.journeyConfig) {
        setInlineStatus("error", "No recent booking checkpoint is available.");
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url?.startsWith("https://www.irctc.co.in/")) {
        setInlineStatus("error", "Open an IRCTC tab first, then tap Resume Last Booking.");
        return;
      }

      await chrome.tabs.sendMessage(tab.id, {
        type: "RESUME_BOOKING_FLOW",
        checkpoint
      });
      window.close();
    } catch (error) {
      setInlineStatus("error", error.message);
    }
  }

  function syncAutoSelectConstraint() {
    const forced = elements.tatkalRushMode.checked;
    if (forced) {
      elements.autoSelectTrain.checked = true;
    }
    elements.autoSelectTrain.disabled = forced;
  }

  function getSelectedTatkalClassType() {
    if (elements.tatkalClassSleeper.checked) {
      return "sleeper";
    }
    if (elements.tatkalClassBoth.checked) {
      return "both";
    }
    return "ac";
  }

  function applyTatkalClassType(type = "ac") {
    elements.tatkalClassAc.checked = type === "ac";
    elements.tatkalClassSleeper.checked = type === "sleeper";
    elements.tatkalClassBoth.checked = type === "both";
  }

  function inferTatkalClassType(draft = {}) {
    const normalizedClass = String(draft.journeyClass || "").trim().toUpperCase();
    return normalizedClass === "SL" ? "sleeper" : "ac";
  }

  function updateTatkalDisplays() {
    const selectedType = getSelectedTatkalClassType();
    if (selectedType === "sleeper") {
      elements.tatkalSlotDisplay.textContent = "Sleeper Tatkal fires at 11:00:00 AM";
      elements.tatkalReminderDisplay.textContent = "You will be notified at 10:55 AM";
      return;
    }
    if (selectedType === "both") {
      elements.tatkalSlotDisplay.textContent = "AC Tatkal fires at 10:00:00 AM | Sleeper fires at 11:00:00 AM";
      elements.tatkalReminderDisplay.textContent = "You will be notified at 9:55 AM / 10:55 AM";
      return;
    }
    elements.tatkalSlotDisplay.textContent = "AC Tatkal fires at 10:00:00 AM";
    elements.tatkalReminderDisplay.textContent = "You will be notified at 9:55 AM";
  }

  async function refreshTatkalAlarmStatus() {
    const alarm = await chrome.alarms.get("tatkal-start");
    if (!alarm) {
      elements.tatkalAlarmStatus.textContent = "❌ No alarm set";
      return;
    }
    const when = new Date(alarm.scheduledTime);
    const dayLabel = isTomorrow(when) ? "tomorrow" : when.toLocaleDateString();
    const timeLabel = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    elements.tatkalAlarmStatus.textContent = `⏰ Alarm set for ${dayLabel} ${timeLabel}`;
  }

  function isTomorrow(date) {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return date.toDateString() === tomorrow.toDateString();
  }

  function buildTatkalScheduleForType(tatkalClassType, journeyConfig) {
    if (tatkalClassType === "sleeper") {
      return computeTatkalTime({ ...journeyConfig, journeyClass: "SL" });
    }
    if (tatkalClassType === "ac") {
      return computeTatkalTime({ ...journeyConfig, journeyClass: "3A" });
    }
    return computeTatkalTime(journeyConfig);
  }

  function mergeJourneyExtras(baseConfig = {}, formData = {}) {
    return {
      ...baseConfig,
      autoSelectTrain: Boolean(formData.autoSelectTrain),
      tatkalClassType: formData.tatkalClassType || "ac",
      metadata: {
        ...(baseConfig.metadata || {}),
        ...(formData.metadata || {}),
        autoSelectTrain: Boolean(formData.autoSelectTrain),
        tatkalClassType: formData.tatkalClassType || "ac"
      }
    };
  }

  async function persistJourneyExtras(journeyDraft, formData) {
    const draftWithExtras = mergeJourneyExtras(journeyDraft, formData);
    state.journeyDraft = draftWithExtras;
    await setStorage({
      [STORAGE_KEYS.JOURNEY_DRAFT]: draftWithExtras
    });
  }

  async function persistDraftSilently() {
    try {
      const payload = readForm();
      const draftWithExtras = mergeJourneyExtras(state.journeyDraft || {}, payload);
      await setStorage({
        [STORAGE_KEYS.JOURNEY_DRAFT]: {
          ...draftWithExtras,
          fromStation: payload.fromStation,
          toStation: payload.toStation,
          journeyDate: payload.journeyDate,
          journeyClass: payload.journeyClass,
          quota: payload.quota,
          passengerCount: payload.passengerCount,
          selectedPassengerIds: payload.selectedPassengerIds,
          preferences: payload.preferences,
          tatkalRushMode: payload.tatkalRushMode
        }
      });
    } catch (error) {
      /* Silent persistence should not interrupt popup usage. */
    }
  }

  async function armTatkalRush() {
    try {
      const payload = readForm();
      validateForm(payload);

      const saveResponse = await sendMessage({ type: "SAVE_JOURNEY_DRAFT", payload });
      const journeyConfig = {
        ...mergeJourneyExtras(saveResponse.journeyDraft, {
          ...payload,
          autoSelectTrain: true,
          tatkalRushMode: true
        }),
        tatkalRushMode: true
      };
      const tatkalClassType = payload.tatkalClassType || "ac";
      const schedule = buildTatkalScheduleForType(tatkalClassType, journeyConfig);

      try {
        await sendMessage({
          type: "SET_TATKAL_ALARM",
          payload: {
            tatkalClassType,
            journeyConfig
          }
        });
      } catch (error) {
        await chrome.alarms.create("tatkal-start", { when: schedule.startAt.getTime() });
        await chrome.alarms.create("tatkal-reminder", { when: schedule.reminderAt.getTime() });
      }

      state.tatkalRushConfig = {
        enabled: true,
        tatkalClassType,
        slotLabel: schedule.slotLabel,
        scheduledFor: schedule.startAt.toISOString(),
        reminderFor: schedule.reminderAt.toISOString(),
        journeyConfig
      };

      await setStorage({
        [STORAGE_KEYS.JOURNEY_DRAFT]: journeyConfig,
        [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: state.tatkalRushConfig
      });

      elements.tatkalRushMode.checked = true;
      syncAutoSelectConstraint();
      await refreshTatkalAlarmStatus();
      setInlineStatus("ready", "Tatkal Rush armed. The extension will wake up at the next Tatkal slot.");
    } catch (error) {
      setInlineStatus("error", error.message);
    }
  }

  async function disarmTatkalRush() {
    try {
      try {
        await sendMessage({ type: "CLEAR_TATKAL_ALARM" });
      } catch (error) {
        await chrome.alarms.clear("tatkal-start");
        await chrome.alarms.clear("tatkal-reminder");
      }

      state.tatkalRushConfig = {
        ...(state.tatkalRushConfig || {}),
        enabled: false
      };

      await setStorage({
        [STORAGE_KEYS.TATKAL_RUSH_CONFIG]: state.tatkalRushConfig
      });

      await refreshTatkalAlarmStatus();
      setInlineStatus("ready", "Tatkal Rush disarmed.");
    } catch (error) {
      setInlineStatus("error", error.message);
    }
  }
})();
