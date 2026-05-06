/* global chrome, IRCTCUtils */

(function () {
  const {
    JOURNEY_CLASSES,
    QUOTAS,
    PAYMENT_MODES,
    todayISO,
    DEFAULT_PREFERENCES,
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
    availabilityResults: null
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
      "travelInsurance",
      "autoUpgrade",
      "onlyConfirmBerths",
      "paymentMode",
      "preferredCoach",
      "reservationChoice",
      "statusCard",
      "statusPhase",
      "statusMessage",
      "statusSteps",
      "passengerCards",
      "openOptionsButton",
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

    elements.openOptionsButton.addEventListener("click", () => sendMessage({ type: "OPEN_OPTIONS" }));
    elements.saveConfigButton.addEventListener("click", saveSetup);
    elements.startBookingButton.addEventListener("click", startBooking);
    elements.checkAvailabilityButton.addEventListener("click", checkAvailability);
    elements.saveAlertButton.addEventListener("click", saveAvailabilityAlert);
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
    applyDraft();
    renderStations();
    renderPassengerCards();
    renderRuntimeStatus();
    renderRecommendation();
    renderAvailabilityAlerts();
    renderHistory();
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
      applyPreferences(DEFAULT_PREFERENCES);
      return;
    }

    elements.fromStation.value = draft.fromStation || "";
    elements.toStation.value = draft.toStation || "";
    elements.journeyDate.value = draft.journeyDate || todayISO();
    elements.passengerCount.value = String(draft.passengerCount || 1);
    elements.journeyClass.value = draft.journeyClass || "3A";
    elements.quota.value = draft.quota || "General";
    elements.tatkalRushMode.checked = Boolean(draft.tatkalRushMode);
    state.selectedPassengerIds = new Set(draft.selectedPassengerIds || []);
    applyPreferences(draft.preferences || DEFAULT_PREFERENCES);
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
      tatkalRushMode: elements.tatkalRushMode.checked
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
      state.journeyDraft = response.journeyDraft;
      state.savedStations = response.savedStations || state.savedStations;
      renderStations();
      setInlineStatus("ready", `Setup saved. ${summarizeConfig(state.journeyDraft)}`);
    } catch (error) {
      setInlineStatus("error", error.message);
    }
  }

  async function startBooking() {
    try {
      const payload = readForm();
      validateForm(payload);
      await sendMessage({ type: "SAVE_JOURNEY_DRAFT", payload });
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
})();
