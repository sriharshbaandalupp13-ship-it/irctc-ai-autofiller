const { STORAGE_KEYS, getStorage, setStorage, safeSendRuntimeMessage, normalizeText, escapeHtml } = window.IRCTCUtils;
const JOURNEY_CLASSES = ["SL", "3A", "2A", "1A"];
const QUOTAS = ["General", "Tatkal", "Ladies", "Senior Citizen", "Premium Tatkal"];
const elements = {};
let checkpoint = null;

window.addEventListener("DOMContentLoaded", init);

function init() {
  captureElements();
  seedControls();
  attachEvents();
  loadState();
}

function captureElements() {
  [
    "fromStation",
    "toStation",
    "journeyDate",
    "journeyClass",
    "quota",
    "preferredTrain",
    "fallbackClassOrder",
    "autoSelectTrain",
    "tatkalRushMode",
    "tatkalAc",
    "tatkalSleeper",
    "tatkalBoth",
    "tatkalSlotDisplay",
    "tatkalReminderDisplay",
    "tatkalAlarmStatus",
    "armTatkal",
    "disarmTatkal",
    "startBooking",
    "saveConfig",
    "resumeBooking",
    "statusMessage"
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function seedControls() {
  elements.journeyDate.value = new Date().toISOString().slice(0, 10);
  populateSelect(elements.journeyClass, JOURNEY_CLASSES);
  populateSelect(elements.quota, QUOTAS);
  renderFallbackOrder(["SL", "3A", "2A", "1A"]);
}

function populateSelect(select, values) {
  if (!select) return;
  select.innerHTML = "";
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

function attachEvents() {
  elements.saveConfig.addEventListener("click", saveSetup);
  elements.startBooking.addEventListener("click", startBooking);
  elements.resumeBooking.addEventListener("click", resumeBooking);
  elements.armTatkal.addEventListener("click", armTatkalRush);
  elements.disarmTatkal.addEventListener("click", disarmTatkalRush);
  elements.tatkalRushMode.addEventListener("change", () => {
    elements.autoSelectTrain.checked = true;
    elements.autoSelectTrain.disabled = elements.tatkalRushMode.checked;
    updateTatkalText();
  });
  [elements.tatkalAc, elements.tatkalSleeper, elements.tatkalBoth].forEach((radio) => radio.addEventListener("change", updateTatkalText));
  elements.fallbackClassOrder.addEventListener("dragstart", onFallbackDragStart);
  elements.fallbackClassOrder.addEventListener("dragover", onFallbackDragOver);
  elements.fallbackClassOrder.addEventListener("drop", onFallbackDrop);
  elements.fallbackClassOrder.addEventListener("dragend", onFallbackDragEnd);
}

async function loadState() {
  const stored = await getStorage([STORAGE_KEYS.BOOKING_CHECKPOINT]);
  checkpoint = stored[STORAGE_KEYS.BOOKING_CHECKPOINT] || null;
  renderResumeButton();
}

function renderFallbackOrder(order) {
  elements.fallbackClassOrder.innerHTML = "";
  const values = order || ["SL", "3A", "2A", "1A"];
  values.forEach((value) => {
    const item = document.createElement("li");
    item.draggable = true;
    item.dataset.value = value;
    item.textContent = value;
    elements.fallbackClassOrder.appendChild(item);
  });
}

let draggedItem = null;
function onFallbackDragStart(event) {
  if (!event.target) return;
  draggedItem = event.target;
  event.dataTransfer.setData("text/plain", event.target.dataset.value);
}

function onFallbackDragOver(event) {
  event.preventDefault();
  const after = getDragAfterElement(elements.fallbackClassOrder, event.clientY);
  const dragging = draggedItem;
  if (!dragging) return;
  if (after == null) {
    elements.fallbackClassOrder.appendChild(dragging);
  } else {
    elements.fallbackClassOrder.insertBefore(dragging, after);
  }
}

function onFallbackDrop(event) {
  event.preventDefault();
  draggedItem = null;
}

function onFallbackDragEnd() {
  draggedItem = null;
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

function buildJourneyConfig() {
  return {
    from: elements.fromStation.value.trim(),
    to: elements.toStation.value.trim(),
    date: elements.journeyDate.value,
    journeyClass: elements.journeyClass.value,
    quota: elements.quota.value,
    preferredTrain: elements.preferredTrain.value.trim(),
    fallbackClassOrder: Array.from(elements.fallbackClassOrder.querySelectorAll("li")).map((li) => li.dataset.value),
    autoSelectTrain: elements.tatkalRushMode.checked ? true : elements.autoSelectTrain.checked,
    tatkalConfig: {
      enabled: elements.tatkalRushMode.checked,
      classType: getTatkalClassType()
    }
  };
}

function validateJourneyConfig(config) {
  if (!config.from || !config.to) {
    throw new Error("Both From and To stations are required.");
  }
  if (!config.date) {
    throw new Error("Journey date is required.");
  }
}

async function saveSetup() {
  try {
    const config = buildJourneyConfig();
    validateJourneyConfig(config);
    await setStorage({ [STORAGE_KEYS.ACTIVE_BOOKING]: config });
    setStatus("Setup saved locally.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function startBooking() {
  try {
    const config = buildJourneyConfig();
    validateJourneyConfig(config);
    await setStorage({ [STORAGE_KEYS.ACTIVE_BOOKING]: config });
    setStatus("Starting booking flow...", "active");
    await chrome.tabs.create({ url: "https://www.irctc.co.in", active: true });
    window.close();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function resumeBooking() {
  if (!checkpoint?.journeyConfig) {
    setStatus("No valid checkpoint available.", "error");
    return;
  }
  const tabs = await chrome.tabs.query({ url: "https://www.irctc.co.in/*" });
  const target = tabs.find((tab) => tab.active) || tabs[0];
  if (!target?.id) {
    setStatus("Open an IRCTC tab to resume.", "error");
    return;
  }
  await chrome.tabs.sendMessage(target.id, { type: "RESUME_BOOKING_FLOW", checkpoint });
  setStatus("Resume command sent to IRCTC tab.", "success");
  window.close();
}

async function armTatkalRush() {
  try {
    const config = buildJourneyConfig();
    validateJourneyConfig(config);
    await setStorage({ [STORAGE_KEYS.ACTIVE_BOOKING]: config });
    await chrome.runtime.sendMessage({ type: "SET_TATKAL_ALARM", payload: { tatkalClassType: getTatkalClassType(), journeyConfig: config } });
    elements.tatkalAlarmStatus.textContent = "⏰ Armed for Tatkal rush";
    setStatus("Tatkal Rush armed successfully.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function disarmTatkalRush() {
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_TATKAL_ALARM" });
    elements.tatkalAlarmStatus.textContent = "❌ Not Set";
    setStatus("Tatkal Rush disarmed.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function updateTatkalText() {
  const selected = getTatkalClassType();
  if (selected === "sleeper") {
    elements.tatkalSlotDisplay.textContent = "Sleeper Tatkal fires at 11:00:00 AM";
    elements.tatkalReminderDisplay.textContent = "You will be notified at 10:55 AM";
  } else if (selected === "both") {
    elements.tatkalSlotDisplay.textContent = "AC Tatkal fires at 10:00:00 AM | Sleeper at 11:00:00 AM";
    elements.tatkalReminderDisplay.textContent = "Reminders at 9:55 AM and 10:55 AM";
  } else {
    elements.tatkalSlotDisplay.textContent = "AC Tatkal fires at 10:00:00 AM";
    elements.tatkalReminderDisplay.textContent = "You will be notified at 9:55 AM";
  }
}

function getTatkalClassType() {
  if (elements.tatkalSleeper.checked) return "sleeper";
  if (elements.tatkalBoth.checked) return "both";
  return "ac";
}

function setStatus(message, type = "info") {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = type;
}

function renderResumeButton() {
  if (!checkpoint?.journeyConfig) {
    elements.resumeBooking.classList.add("hidden");
    return;
  }
  elements.resumeBooking.classList.remove("hidden");
  elements.resumeBooking.textContent = `Resume Last Booking: ${checkpoint.journeyConfig.from} → ${checkpoint.journeyConfig.to}`;
}
