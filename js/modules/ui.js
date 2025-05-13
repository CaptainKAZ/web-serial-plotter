// js/modules/ui.js (UIManager)

import { eventBus } from "../event_bus.js";
import { debounce, formatSecondsToHMS } from "../utils.js";
import {
  DEFAULT_BAUD_RATE,
  DEFAULT_MAX_BUFFER_POINTS,
  MIN_BUFFER_POINTS,
  DEFAULT_SIM_CHANNELS,
  DEFAULT_SIM_FREQUENCY,
  DEFAULT_SIM_AMPLITUDE,
} from "../config.js";

let domElements = {};
let lastValidBaudRate = String(DEFAULT_BAUD_RATE);
let verticalSplitInstance = null;
let horizontalSplitInstance = null;

async function loadHtmlIntoElement(partialUrl, targetElementId) {
  const targetElement = document.getElementById(targetElementId);
  if (!targetElement) {
    console.error(`UI: Target element #${targetElementId} missing`);
    return null;
  }
  try {
    const response = await fetch(partialUrl);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const html = await response.text();
    targetElement.innerHTML = html;
    return targetElement;
  } catch (error) {
    console.error(`UI: Failed to load partial ${partialUrl}:`, error);
    targetElement.innerHTML = `<p class="text-red-500 p-4">Error loading UI component.</p>`;
    return null;
  }
}

function queryElements() {
  const get = (id) => document.getElementById(id);
  domElements = {
    controlPanel: get("control-panel"),
    dataSourceSelect: get("dataSourceSelect"),
    startStopButton: get("startStopButton"),
    statusMessage: get("statusMessage"),
    workerStatusDisplay: get("workerStatusDisplay"),
    simulatedControls: get("simulatedControls"),
    webSerialControls: get("webSerialControls"),
    parsingSettingsSection: get("parsingSettingsSection"),
    serialOptionsDiv: get("serialOptions"),
    connectSerialButton: get("connectSerialButton"),
    baudRateInput: get("baudRateInput"), // Changed back to baudRateInput
    commonBaudRatesDatalist: get("commonBaudRates"), // Added datalist ref
    dataBitsSelect: get("dataBitsSelect"),
    stopBitsSelect: get("stopBitsSelect"),
    paritySelect: get("paritySelect"),
    flowControlSelect: get("flowControlSelect"),
    serialProtocolSelect: get("serialProtocolSelect"),
    customParserSection: get("customParserSection"),
    serialParserTextarea: get("serialParser"),
    updateParserButton: get("updateParserButton"),
    parserStatus: get("parserStatus"),
    builtInParserStatus: get("builtInParserStatus"),
    simNumChannelsInput: get("simNumChannels"),
    simFrequencyInput: get("simFrequency"),
    simAmplitudeInput: get("simAmplitude"),
    bufferDurationInput: get("bufferDurationInput"),
    bufferUsageBar: get("bufferUsageBar"),
    bufferStatus: get("bufferStatus"),
    downloadCsvButton: get("downloadCsvButton"),
    clearDataButton: get("clearDataButton"),
    displayAreaContainer: get("displayAreaContainer"),
    displayArea: get("displayArea"),
    bottomRow: get("bottomRow"),
    plotModulePlaceholder: get("plotModule"),
    textModulePlaceholder: get("textModule"),
    quatModulePlaceholder: get("quatModule"),
    quatModuleContainer: get("quatModuleContainer"),
    aresplotControlsSection: get("aresplotControlsSection"),
    elfDropZone: get("elfDropZone"),
    elfFileInput: get("elfFileInput"),
    elfName: get("elfName"),
    elfStatusMessage: get("elfStatusMessage"),
    symbolSearchArea: get("symbolSearchArea"),
    symbolSearchInput: get("symbolSearchInput"),
    symbolDatalist: get("symbolDatalist"),
    addSymbolButton: get("addSymbolButton"),
    symbolSlotsContainer: get("symbolSlotsContainer"),
  };
  lastValidBaudRate =
    domElements.baudRateInput?.value || String(DEFAULT_BAUD_RATE);
}

function setupControlPanelListeners() {
  const addListener = (element, event, handler) => {
    if (element) element.addEventListener(event, handler);
  };

  addListener(domElements.dataSourceSelect, "change", (e) =>
    eventBus.emit("ui:dataSourceChanged", { source: e.target.value })
  );
  addListener(domElements.startStopButton, "click", () =>
    eventBus.emit("ui:startStopClicked")
  );
  addListener(domElements.connectSerialButton, "click", () =>
    eventBus.emit("ui:connectDisconnectClicked", null)
  ); // Options read later

  // Baud Rate Input Listeners (for input+datalist)
  addListener(domElements.baudRateInput, "focus", (e) => {
    const currentVal = e.target.value;
    if (currentVal) {
      const num = parseInt(currentVal);
      if (!isNaN(num) && num > 0) {
        lastValidBaudRate = currentVal;
      }
    }
    e.target.value = "";
  });
  addListener(domElements.baudRateInput, "blur", (e) => {
    const currentVal = e.target.value;
    const num = parseInt(currentVal);
    if (!currentVal || isNaN(num) || num <= 0) {
      e.target.value = lastValidBaudRate;
    } else {
      lastValidBaudRate = currentVal;
      const datalist = domElements.commonBaudRatesDatalist;
      if (datalist) {
        let exists = false;
        for (let i = 0; i < datalist.options.length; i++) {
          if (datalist.options[i].value === currentVal) {
            exists = true;
            break;
          }
        }
        if (!exists) {
          const opt = document.createElement("option");
          opt.value = currentVal;
          datalist.appendChild(opt);
          sortDatalistOptions(datalist);
        }
      }
    }
    eventBus.emit("ui:baudRateSet", { value: e.target.value }); // Notify main of final value
  });

  addListener(domElements.serialProtocolSelect, "change", (e) => {
    const proto = e.target.value;
    updateParserVisibility(proto);
    let detail = { protocol: proto };
    if (proto === "custom") {
      detail.code = domElements.serialParserTextarea?.value || "";
    }
    eventBus.emit("ui:protocolChanged", detail);
  });
  addListener(domElements.updateParserButton, "click", () => {
    const code = domElements.serialParserTextarea?.value || "";
    eventBus.emit("ui:updateParserClicked", { code: code });
  });

  const emitSimConfigChange = debounce(() => {
    const config = {
      numChannels: parseInt(domElements.simNumChannelsInput?.value || 1),
      frequency: parseInt(domElements.simFrequencyInput?.value || 1000),
      amplitude: parseFloat(domElements.simAmplitudeInput?.value || 1),
    };
    eventBus.emit("ui:simConfigChanged", config);
  }, 300);
  addListener(domElements.simNumChannelsInput, "change", emitSimConfigChange);
  addListener(domElements.simFrequencyInput, "change", emitSimConfigChange);
  addListener(domElements.simAmplitudeInput, "change", emitSimConfigChange);

  addListener(domElements.bufferDurationInput, "change", (e) => {
    let v = parseInt(e.target.value);
    if (isNaN(v) || v < MIN_BUFFER_POINTS) {
      v = MIN_BUFFER_POINTS;
      e.target.value = v;
    }
    eventBus.emit("ui:bufferDurationChanged", { duration: v });
  });
  addListener(domElements.downloadCsvButton, "click", () =>
    eventBus.emit("ui:downloadCsvClicked")
  );
  addListener(domElements.clearDataButton, "click", () =>
    eventBus.emit("ui:clearDataClicked")
  );
}

// Reads all relevant config values from UI elements
function getCurrentConfigFromUI() {
  const config = {};
  try {
    config.dataSource = domElements.dataSourceSelect?.value || "simulated";
    config.maxBufferPoints = parseInt(
      domElements.bufferDurationInput?.value || DEFAULT_MAX_BUFFER_POINTS
    );
    if (
      isNaN(config.maxBufferPoints) ||
      config.maxBufferPoints < MIN_BUFFER_POINTS
    )
      config.maxBufferPoints = DEFAULT_MAX_BUFFER_POINTS;
    config.baudRate = parseInt(
      domElements.baudRateInput?.value || DEFAULT_BAUD_RATE
    ); // Read from input
    if (isNaN(config.baudRate) || config.baudRate <= 0)
      config.baudRate = DEFAULT_BAUD_RATE;
    config.numChannels = parseInt(
      domElements.simNumChannelsInput?.value || DEFAULT_SIM_CHANNELS
    );
    config.frequency = parseInt(
      domElements.simFrequencyInput?.value || DEFAULT_SIM_FREQUENCY
    );
    config.amplitude = parseFloat(
      domElements.simAmplitudeInput?.value || DEFAULT_SIM_AMPLITUDE
    );
    if (isNaN(config.numChannels) || config.numChannels <= 0)
      config.numChannels = DEFAULT_SIM_CHANNELS;
    if (isNaN(config.frequency) || config.frequency <= 0)
      config.frequency = DEFAULT_SIM_FREQUENCY;
    if (isNaN(config.amplitude) || config.amplitude <= 0)
      config.amplitude = DEFAULT_SIM_AMPLITUDE;
    config.protocol = domElements.serialProtocolSelect?.value || "default";
    config.parserCode =
      config.protocol === "custom"
        ? domElements.serialParserTextarea?.value || ""
        : "";
    config.dataBits = parseInt(domElements.dataBitsSelect?.value || 8);
    config.stopBits = parseInt(domElements.stopBitsSelect?.value || 1);
    config.parity = domElements.paritySelect?.value || "none";
    config.flowControl = domElements.flowControlSelect?.value || "none";
    config.bufferSize = 32768; // Keep hardcoded or make configurable
  } catch (error) {
    console.error("UI: Error reading config from UI:", error);
  }
  return config;
}

function sortDatalistOptions(datalistElement) {
  if (
    !datalistElement ||
    !datalistElement.options ||
    datalistElement.options.length === 0
  )
    return;
  const optionsArray = Array.from(datalistElement.options);
  optionsArray.sort((a, b) => {
    const valA = parseInt(a.value);
    const valB = parseInt(b.value);
    if (isNaN(valA)) return 1;
    if (isNaN(valB)) return -1;
    return valA - valB;
  });
  optionsArray.forEach((opt) => datalistElement.appendChild(opt));
}

// Add this helper function within ui.js or call it from main.js
function handleElfFile(file) {
  if (file && file.name.toLowerCase().endsWith(".elf")) {
    // Emit an event with the valid file object
    eventBus.emit("ui:elfFileSelected", { file: file });
    // Optionally update status message immediately
    if (domElements.elfStatusMessage) {
      domElements.elfStatusMessage.textContent = `Selected file: ${file.name}`;
      domElements.elfStatusMessage.classList.remove("text-red-500");
      domElements.elfName.textContent = file.name;
      domElements.elfName.classList.remove("text-blue-600");
    }
  } else if (file) {
    // Handle invalid file type
    console.warn("Invalid file type selected:", file.name);
    if (domElements.elfStatusMessage) {
      domElements.elfStatusMessage.textContent =
        "Error: Please select a .elf file.";
      domElements.elfStatusMessage.classList.add("text-red-500");
    }
  }
  if (domElements.elfFileInput) {
    domElements.elfFileInput.value = "";
  }
}

// Function to setup listeners (call this during UI initialization)
function setupAresplotListeners() {
  if (!domElements.elfDropZone || !domElements.elfFileInput) {
    console.warn(
      "Could not find ELF Drop Zone or File Input elements for listeners."
    );
    return;
  }

  const dropZone = domElements.elfDropZone;
  const fileInput = domElements.elfFileInput;

  // 1. Trigger hidden file input click when drop zone is clicked
  dropZone.addEventListener("click", () => {
    fileInput.click();
  });

  // 2. Handle file selection via the hidden input
  fileInput.addEventListener("change", (event) => {
    if (event.target.files && event.target.files.length > 0) {
      handleElfFile(event.target.files[0]);
    }
  });

  // 3. Drag and Drop listeners for the drop zone
  dropZone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.add("drag-over");
  });

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault(); // Necessary to allow drop
    event.stopPropagation();
    dropZone.classList.add("drag-over"); // Keep class while dragging over
  });

  dropZone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Only remove class if the leave target isn't a child element
    if (event.relatedTarget && !dropZone.contains(event.relatedTarget)) {
      dropZone.classList.remove("drag-over");
    } else if (!event.relatedTarget) {
      // Handles leaving the browser window
      dropZone.classList.remove("drag-over");
    }
  });

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove("drag-over");

    if (
      event.dataTransfer &&
      event.dataTransfer.files &&
      event.dataTransfer.files.length > 0
    ) {
      handleElfFile(event.dataTransfer.files[0]);
      // Clear the dataTransfer buffer (good practice)
      if (event.dataTransfer.items) {
        event.dataTransfer.items.clear();
      } else {
        event.dataTransfer.clearData();
      }
    }
  });

  if (domElements.symbolSearchInput && domElements.addSymbolButton) {
    const searchInput = domElements.symbolSearchInput;
    const addButton = domElements.addSymbolButton;

    // 1. Input event listener (debounced) - ONLY triggers search for suggestions
    searchInput.addEventListener(
      "input",
      debounce((event) => {
        eventBus.emit("ui:symbolSearchChanged", { term: event.target.value });
        eventBus.emit("ui:symbolInputValidated", { value: event.target.value });
        // DO NOT set button state here anymore
      }, 100)
    );

    // 2. Change event listener - Triggers validation of the final value
    searchInput.addEventListener("change", (event) => {
      eventBus.emit("ui:symbolInputValidated", { value: event.target.value });
    });

    // 3. Blur event listener - Also triggers validation when focus is lost
    searchInput.addEventListener("blur", (event) => {
      eventBus.emit("ui:symbolInputValidated", { value: event.target.value });
    });

    // 4. Add button click listener (remains the same)
    addButton.addEventListener("click", () => {
      const selectedValue = searchInput.value;
      if (selectedValue.trim() !== "") {
        searchInput.select();
        eventBus.emit("ui:symbolSelectedForAdd", { value: selectedValue });
      }
    });

    // 5. Enter key listener (remains the same)
    searchInput.addEventListener("keypress", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const selectedValue = searchInput.value;
        searchInput.select();
        // Trigger ADD directly on Enter if button would be enabled
        // We can perhaps trigger validation first, then add if valid?
        // Simpler: just trigger the add action, it will validate internally.
        if (selectedValue.trim() !== "") {
          eventBus.emit("ui:symbolSelectedForAdd", { value: selectedValue });
        }
      }
    });
  } else {
    console.warn(
      "Could not find Symbol Search Input or Add Button elements for listeners."
    );
  }

  // Prevent dropping files outside the drop zone if needed (optional)
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

// --- Symbol Slot Management ---
const MAX_SLOTS = 10;
let selectedSymbolsInSlots = []; // Array to hold the symbol objects in the slots
let sortableInstance = null;

/**
 * Emits an event indicating the symbol slots have been updated.
 * @private
 */
function emitSlotsUpdatedEvent() {
  eventBus.emit("ui:symbolSlotsUpdated", {
    slots: [...selectedSymbolsInSlots],
  });
  // console.log("UI: Emitted 'ui:symbolSlotsUpdated' with current slots:", selectedSymbolsInSlots.map(s => `${s._displayType || ''}${s.name}`));
}

/**
 * Renders the symbol slots dynamically.
 */
export function renderSymbolSlots() {
  if (!domElements.symbolSlotsContainer) {
    // Try to query elements if not already done, useful for initial calls or race conditions
    if (
      typeof queryElements === "function" &&
      Object.keys(domElements).length < 5
    ) {
      // Arbitrary check if domElements is minimal
      queryElements();
    }
    if (!domElements.symbolSlotsContainer) {
      console.error(
        "UI Error: Symbol slots container (#symbolSlotsContainer) not found for rendering."
      );
      return;
    }
  }

  const container = domElements.symbolSlotsContainer;
  container.innerHTML = ""; // Clear existing content
  container.classList.remove("border", "p-2", "bg-gray-50"); // Remove container styling if empty

  if (selectedSymbolsInSlots.length === 0) {
    const placeholderDiv = document.createElement("div");
    placeholderDiv.className = "text-gray-400 italic p-2 text-center text-xs";
    placeholderDiv.textContent = "No symbols selected.";
    container.appendChild(placeholderDiv);
    return;
  }

  selectedSymbolsInSlots.forEach((symbol, index) => {
    if (!symbol) return;

    const slotDiv = document.createElement("div");
    slotDiv.className =
      "p-1.5 bg-white border rounded flex justify-between items-center text-sm group";

    const handleSpan = document.createElement("span");
    handleSpan.className =
      "drag-handle cursor-move px-1 text-gray-400 hover:text-gray-600";
    const dragIcon = document.createElement("i");
    dragIcon.setAttribute("data-lucide", "grip-vertical");
    dragIcon.style.width = "14px";
    dragIcon.style.height = "14px";
    handleSpan.appendChild(dragIcon);
    slotDiv.appendChild(handleSpan);

    const nameSpan = document.createElement("span");
    nameSpan.className = "flex-grow px-0";
    const displayTypePrefix = symbol._displayType
      ? `${symbol._displayType} `
      : "";
    nameSpan.textContent = `${displayTypePrefix}${
      symbol.name || "Unnamed Symbol"
    }`;
    let titleText = `Name: ${symbol.name}\nType: ${
      symbol.type_name || "N/A"
    }\nAddress: 0x${(symbol.address || 0).toString(16)}\nSize: ${
      symbol.size || "N/A"
    }`;
    if (symbol.file_name && symbol.line_number) {
      titleText += `\nSource: ${symbol.file_name}:${symbol.line_number}`;
    }
    nameSpan.title = titleText;
    slotDiv.appendChild(nameSpan);

    const controlsDiv = document.createElement("div");
    controlsDiv.className = "flex items-center";
    const deleteButton = document.createElement("button");
    deleteButton.title = "Delete Symbol";
    deleteButton.className =
      "slot-action-btn delete-btn text-red-500 hover:text-red-700";
    deleteButton.dataset.action = "delete";
    deleteButton.dataset.slotIndex = index; // Store current index for the handler
    const deleteIcon = document.createElement("i");
    deleteIcon.setAttribute("data-lucide", "trash-2");
    deleteIcon.style.width = "14px";
    deleteIcon.style.height = "14px";
    deleteButton.appendChild(deleteIcon);
    controlsDiv.appendChild(deleteButton);
    slotDiv.appendChild(controlsDiv);

    container.appendChild(slotDiv);
  });

  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons({ context: container }); // Optimize by providing context
  }
}

/**
 * (Internal) Removes a symbol from the slot list by its index and re-renders.
 * @param {number} indexToRemove - The index of the symbol to remove.
 * @private
 */
function removeSymbolFromSlotInternal(indexToRemove) {
  if (indexToRemove >= 0 && indexToRemove < selectedSymbolsInSlots.length) {
    renderSymbolSlots();
    emitSlotsUpdatedEvent();
    // console.log(`UI: Symbol "${removedSymbol.name}" removed from slot ${indexToRemove}.`);
  } else {
    console.warn(
      "UI: Attempted to remove symbol from invalid index:",
      indexToRemove
    );
  }
}

/**
 * Initializes the symbol slots UI, including SortableJS and action listeners.
 */
export function initSymbolSlots() {
  if (
    typeof queryElements === "function" &&
    Object.keys(domElements).length < 5
  )
    queryElements();

  if (!domElements.symbolSlotsContainer) {
    console.error(
      "UI Error: Symbol slots container (#symbolSlotsContainer) not found for initialization."
    );
    return;
  }
  selectedSymbolsInSlots = [];
  renderSymbolSlots(); // Initial render (will show placeholder)

  if (typeof Sortable !== "undefined") {
    if (sortableInstance) {
      sortableInstance.destroy();
    }
    sortableInstance = Sortable.create(domElements.symbolSlotsContainer, {
      animation: 150,
      handle: ".drag-handle",
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      onEnd: function (evt) {
        if (
          evt.oldDraggableIndex !== undefined &&
          evt.newDraggableIndex !== undefined &&
          selectedSymbolsInSlots.length >
            Math.max(evt.oldDraggableIndex, evt.newDraggableIndex)
        ) {
          const movedItem = selectedSymbolsInSlots.splice(
            evt.oldDraggableIndex,
            1
          )[0];
          selectedSymbolsInSlots.splice(evt.newDraggableIndex, 0, movedItem);
          renderSymbolSlots(); // Re-render to update data-slot-index attributes correctly
          emitSlotsUpdatedEvent();
        }
      },
    });
  } else {
    console.error(
      "UI Error: SortableJS library not loaded. Drag-and-drop for symbol slots will not work."
    );
  }

  // Setup event delegation for slot actions (like delete)
  domElements.symbolSlotsContainer.addEventListener("click", (event) => {
    const targetButton = event.target.closest(
      'button.delete-btn[data-action="delete"]'
    );
    if (targetButton) {
      const slotIndex = parseInt(targetButton.dataset.slotIndex, 10);
      if (!isNaN(slotIndex)) {
        removeSymbolFromSlotInternal(slotIndex); // Call internal remove function directly
      } else {
        console.warn(
          "UI: Invalid slot index for delete action from button:",
          targetButton
        );
      }
    }
  });
}

/**
 * (Public) Adds a symbol (already processed with _displayType) to the slot list.
 * Called by main.js.
 * @param {object} symbolWithDisplayType - The full symbol object with _displayType property.
 * @returns {boolean} True if added successfully, false otherwise.
 */
export function addSymbolToSlot(symbolWithDisplayType) {
  if (
    !symbolWithDisplayType ||
    !symbolWithDisplayType.name ||
    !symbolWithDisplayType._displayType
  ) {
    // Check for _displayType
    console.warn(
      "UI: Attempted to add invalid or non-formatted symbol object."
    );
    return false;
  }
  if (selectedSymbolsInSlots.length >= MAX_SLOTS) {
    eventBus.emit("main:statusUpdate", {
      message: "Error: Slots are full (Max 10 symbols).",
      isError: true,
    });
    return false;
  }
  const isDuplicate = selectedSymbolsInSlots.some(
    (s) =>
      s.address === symbolWithDisplayType.address &&
      s.name === symbolWithDisplayType.name
  );
  if (isDuplicate) {
    eventBus.emit("main:statusUpdate", {
      message: `Info: Symbol "${symbolWithDisplayType.name}" is already in slots.`,
      isError: false,
    });
    return false;
  }

  selectedSymbolsInSlots.push(symbolWithDisplayType);
  renderSymbolSlots();
  emitSlotsUpdatedEvent();
  return true;
}

/**
 * (Public) Clears all symbols from the slots and re-renders.
 */
export function clearSymbolSlots() {
  const hadSymbols = selectedSymbolsInSlots.length > 0;
  selectedSymbolsInSlots = [];
  renderSymbolSlots();
  if (hadSymbols) {
    emitSlotsUpdatedEvent();
  }
  // console.log("UI: All symbol slots cleared.");
}

/**
 * (Public) Returns a copy of the currently selected symbols in slots.
 * @returns {Array<object>}
 */
export function getSelectedSymbolsInSlots() {
  return [...selectedSymbolsInSlots];
}

/**
 * (Public) Updates the entire list of selected symbols and re-renders the slots.
 * Expects symbols to already have _displayType.
 * @param {Array<object>} newSymbolsArray - The new array of symbol objects (with _displayType) for the slots.
 */
export function updateSlotsWithNewSymbols(newSymbolsArray) {
  if (!Array.isArray(newSymbolsArray)) {
    console.error("UI: updateSlotsWithNewSymbols expects an array.");
    return;
  }
  selectedSymbolsInSlots = newSymbolsArray.slice(0, MAX_SLOTS);
  renderSymbolSlots();
  emitSlotsUpdatedEvent();
}

// --- Public API / UI Update Functions ---

/** Initializes the UI Manager */
async function initUIManager() {
  console.log("UI: Initializing UIManager...");
  try {
    const partialTargets = {
      "control-panel": "html_partials/control_panel.html",
      plotModule: "html_partials/plot_module.html",
      textModule: "html_partials/text_module.html",
      quatModule: "html_partials/quaternion_module.html",
    };
    await Promise.allSettled(
      Object.entries(partialTargets).map(([id, url]) =>
        loadHtmlIntoElement(url, id)
      )
    );
    console.log("UI: Partials loaded.");
    queryElements();
    if (domElements.commonBaudRatesDatalist) {
      sortDatalistOptions(domElements.commonBaudRatesDatalist);
    } // Sort initial list
    const initialState = getCurrentConfigFromUI(); // Read initial DOM state
    initSymbolSlots();
    setupControlPanelListeners();
    setupAresplotListeners();
    setupModuleFullscreenButtons();
    updateControlVisibility(initialState.dataSource);
    updateParserVisibility(initialState.protocol);
    if (typeof lucide !== "undefined" && lucide.createIcons) {
      try {
        lucide.createIcons();
      } catch (e) {}
    }
    console.log("UI: UIManager initialized successfully.");
    return initialState; // Return initial state read from DOM
  } catch (error) {
    console.error("UI: UIManager initialization failed:", error);
    return null;
  }
}

/** Updates the main status message text. */
function updateStatus(text = "状态：空闲") {
  if (domElements.statusMessage) domElements.statusMessage.textContent = text;
}

/** Updates enable/disable state and text of control panel buttons. */
function updateButtonStates(state = {}) {
  if (!domElements || Object.keys(domElements).length === 0) return;
  const {
    isCollecting = false,
    isSerialConnected = false,
    serialProtocol = "default",
    dataBufferHasData = false,
    dataSource = "simulated",
  } = state;
  const isSerial = dataSource === "webserial";
  if (domElements.startStopButton) {
    domElements.startStopButton.disabled =
      isSerial && !isSerialConnected && !isCollecting;
    domElements.startStopButton.textContent = isCollecting
      ? "结束采集"
      : "开始采集";
    domElements.startStopButton.className = `w-full mb-2 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-70 ${
      isCollecting
        ? "bg-red-500 hover:bg-red-600"
        : "bg-blue-500 hover:bg-blue-600"
    }`;
  }
  if (domElements.connectSerialButton) {
    domElements.connectSerialButton.disabled = !isSerial || isCollecting;
    domElements.connectSerialButton.textContent = isSerialConnected
      ? "断开串口"
      : "连接串口";
    domElements.connectSerialButton.className = `w-full enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-70 ${
      isSerialConnected
        ? "bg-yellow-500 hover:bg-yellow-600"
        : "bg-blue-500 hover:bg-blue-600"
    }`;
  }
  if (domElements.serialOptionsDiv && domElements.parsingSettingsSection) {
    const disableCoreParams = isSerialConnected || isCollecting;
    [
      domElements.baudRateInput,
      domElements.dataBitsSelect,
      domElements.stopBitsSelect,
      domElements.paritySelect,
      domElements.flowControlSelect,
    ].forEach((el) => {
      if (el) el.disabled = disableCoreParams;
    });
    const disableParsing = isCollecting;
    const disableCustom = isCollecting || serialProtocol !== "custom";
    if (domElements.serialProtocolSelect)
      domElements.serialProtocolSelect.disabled = disableParsing;
    if (domElements.serialParserTextarea)
      domElements.serialParserTextarea.disabled = disableCustom;
    if (domElements.updateParserButton)
      domElements.updateParserButton.disabled = disableCustom;
  }
  if (domElements.downloadCsvButton)
    domElements.downloadCsvButton.disabled = !dataBufferHasData;
  if (domElements.clearDataButton) {
    domElements.clearDataButton.disabled = !dataBufferHasData && !isCollecting;
  }
}

/** Updates the buffer usage bar and text display. */
function updateBufferUI(stats = {}) {
  const {
    currentPoints = 0,
    maxPoints = DEFAULT_MAX_BUFFER_POINTS,
    collecting = false,
    estimateRemainingSec = null,
    estimateTotalSec = null,
  } = stats;
  if (!domElements.bufferUsageBar || !domElements.bufferStatus) return;
  const usagePercent =
    maxPoints > 0 ? Math.min(100, (currentPoints / maxPoints) * 100) : 0;
  domElements.bufferUsageBar.style.width = `${usagePercent.toFixed(1)}%`;
  let statusText = `缓冲: ${currentPoints.toLocaleString()} / ${maxPoints.toLocaleString()} 点`;
  if (collecting) {
    if (
      estimateRemainingSec !== null &&
      estimateRemainingSec >= 0 &&
      estimateTotalSec !== null &&
      estimateTotalSec > 0
    ) {
      if (usagePercent >= 99.9 || estimateRemainingSec <= 0.1) {
        statusText += ` (已满 ~${formatSecondsToHMS(estimateTotalSec)})`;
      } else {
        statusText += ` (剩余 ~${formatSecondsToHMS(estimateRemainingSec)})`;
      }
    } else {
      statusText += ` (计算中...)`;
    }
  }
  domElements.bufferStatus.innerHTML = statusText;
}

/**
 * Updates the text content of a DOM element.
 * @param {string} elementId - The ID of the element.
 * @param {string} text - The text to set.
 */
export function updateElementText(elementId, text) {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = text;
    } else {
        console.warn(`UI: Element with ID '${elementId}' not found for text update.`);
    }
}

/** Displays status messages from the worker. */
function showWorkerStatus(text, isError = false) {
  if (!domElements.workerStatusDisplay) return;
  if (text && text !== "Worker ready.") {
    domElements.workerStatusDisplay.textContent = text;
    domElements.workerStatusDisplay.style.color = isError
      ? "#dc2626"
      : "#6b7280";
    domElements.workerStatusDisplay.style.display = "block";
  } else {
    domElements.workerStatusDisplay.style.display = "none";
  }
}

/** Displays status or error messages related to the serial parser. */
function showParserStatus(text, isError = false) {
  const statusEl = domElements.parserStatus;
  const builtInStatusEl = domElements.builtInParserStatus;
  if (!statusEl || !builtInStatusEl) return;
  const currentProtocol = domElements.serialProtocolSelect?.value;
  const isCustom = currentProtocol === "custom";
  const targetEl = isCustom ? statusEl : builtInStatusEl;
  const otherEl = isCustom ? builtInStatusEl : statusEl;
  if (text) {
    targetEl.textContent = `状态：${text}`;
    targetEl.className = `parser-status ${
      isError
        ? "text-red-600"
        : text.includes("成功") ||
          text.includes("应用") ||
          text.includes("更新")
        ? "text-green-600"
        : ""
    }`;
    targetEl.style.display = "block";
    if (otherEl) otherEl.style.display = "none";
  } else {
    updateParserVisibility();
  }
}

/** Updates visibility of Simulation, WebSerial Connection, and Parsing sections. */
function updateControlVisibility(currentDataSource) {
  const showSim = currentDataSource === "simulated";
  const showWebSerial = currentDataSource === "webserial";
  const showParsing = showWebSerial; // Adjust if WebSocket added
  if (domElements.simulatedControls)
    domElements.simulatedControls.style.display = showSim ? "block" : "none";
  if (domElements.webSerialControls)
    domElements.webSerialControls.style.display = showWebSerial
      ? "block"
      : "none";
  if (domElements.parsingSettingsSection)
    domElements.parsingSettingsSection.style.display = showParsing
      ? "block"
      : "none";
  if (domElements.aresplotControlsSection)
    domElements.aresplotControlsSection.style.display = showParsing
      ? "block"
      : "none";
  if (showParsing) updateParserVisibility();
}

/** Updates visibility of the custom parser section based on selected protocol. */
function updateParserVisibility(protocol = null) {
  if (!domElements.serialProtocolSelect) queryElements();
  const selectedProtocol = protocol ?? domElements.serialProtocolSelect?.value;
  const isCustom = selectedProtocol === "custom";
  const isAresplot = selectedProtocol === "aresplot"; // Check for aresplot

  // Handle Custom Parser Section
  if (domElements.customParserSection) {
    // Show custom section only if 'custom' is selected AND NOT 'aresplot'
    domElements.customParserSection.style.display =
      isCustom && !isAresplot ? "block" : "none";
  }

  // Handle Built-in Parser Status
  if (domElements.builtInParserStatus) {
    // Show built-in status if NEITHER 'custom' NOR 'aresplot' is selected
    const showBuiltIn = !isCustom && !isAresplot;
    domElements.builtInParserStatus.style.display = showBuiltIn
      ? "block"
      : "none";
    if (showBuiltIn) {
      // Update text for the selected built-in protocol
      const selectedOption =
        domElements.serialProtocolSelect?.options[
          domElements.serialProtocolSelect.selectedIndex
        ];
      const txt = selectedOption ? selectedOption.text : "默认";
      domElements.builtInParserStatus.textContent = `状态：使用内置协议 "${txt}"。`;
      domElements.builtInParserStatus.className = "parser-status"; // Reset class
    }
  }

  // Handle Custom Parser Status Text (visible only when custom is selected)
  if (domElements.parserStatus) {
    domElements.parserStatus.style.display = isCustom ? "block" : "none";
    if (isCustom && !domElements.parserStatus.textContent.includes(":")) {
      // Reset status text if switching back to custom
      domElements.parserStatus.textContent = "状态：使用自定义解析器。";
      domElements.parserStatus.className = "parser-status"; // Reset class
    }
  }
  if (domElements.aresplotControlsSection) {
    domElements.aresplotControlsSection.style.display = isAresplot
      ? "block"
      : "none";
  }
}

// --- Layout Setup (Exported) ---
function initializeSplitLayout(onDragEndCallback) {
  const plotElement = domElements.plotModulePlaceholder;
  const bottomRowElement = domElements.bottomRow;
  const textElement = domElements.textModulePlaceholder;
  const quatElement = domElements.quatModulePlaceholder;
  if (!plotElement || !bottomRowElement || !textElement || !quatElement) {
    console.error("UI: Split.js init failed: Elements not found.");
    return;
  }
  if (typeof Split === "undefined") {
    console.error("UI: Split.js library not loaded.");
    return;
  }
  if (verticalSplitInstance) {
    try {
      verticalSplitInstance.destroy();
    } catch (e) {}
  }
  if (horizontalSplitInstance) {
    try {
      horizontalSplitInstance.destroy();
    } catch (e) {}
  }
  verticalSplitInstance = null;
  horizontalSplitInstance = null;
  try {
    const plotMin = 150;
    const bottomMin = 150;
    const textMin = 150;
    const quatMin = 150;
    verticalSplitInstance = Split([plotElement, bottomRowElement], {
      sizes: [65, 35],
      minSize: [plotMin, bottomMin],
      direction: "vertical",
      gutterSize: 8,
      cursor: "row-resize",
      onDragEnd: onDragEndCallback,
    });
    horizontalSplitInstance = Split([textElement, quatElement], {
      sizes: [50, 50],
      minSize: [textMin, quatMin],
      direction: "horizontal",
      gutterSize: 8,
      cursor: "col-resize",
      onDragEnd: onDragEndCallback,
    });
  } catch (error) {
    console.error("UI: Failed to initialize Split.js:", error);
  }
}

function setupResizeObserver(resizeHandler) {
  const plotTarget = domElements.plotModulePlaceholder;
  const textTarget = domElements.textModulePlaceholder;
  const quatTarget = domElements.quatModulePlaceholder;
  if (!plotTarget || !textTarget || !quatTarget) {
    console.warn("UI: ResizeObserver setup skipped.");
    return;
  }
  if (typeof ResizeObserver === "undefined") {
    console.warn("UI: ResizeObserver not supported.");
    window.addEventListener("resize", resizeHandler);
    return;
  }
  const observer = new ResizeObserver(resizeHandler);
  try {
    observer.observe(plotTarget);
    observer.observe(textTarget);
    observer.observe(quatTarget);
  } catch (error) {
    console.error("UI: Error observing elements:", error);
    window.addEventListener("resize", resizeHandler);
  }
}

/**
 * Sets up event listeners for all module fullscreen buttons using delegation.
 * Should be called in initUIManager after partials are loaded and queryElements is run.
 */
function setupModuleFullscreenButtons() {
  // Set up delegated listener on #displayArea
  const displayArea = domElements.displayArea;
  if (!displayArea) {
    console.error(
      "Cannot setup fullscreen buttons: #displayArea element not found."
    );
    return;
  }

  displayArea.addEventListener("click", (event) => {
    // event.target is the actual clicked element
    // .closest() finds the nearest ancestor (or self) that matches the selector
    const button = event.target.closest(".module-fullscreen-button");
    if (button) {
      // Get the target module ID from the button's data-* attribute
      const targetId = button.dataset.targetModuleId;
      if (targetId) {
        toggleModuleFullscreen(targetId); // Call the toggle function
      } else {
        console.warn(
          "Fullscreen button is missing data-target-module-id attribute."
        );
      }
    }
  });
  console.log(
    "Delegated listener for fullscreen buttons setup on #displayArea."
  );
}

/**
 * Sets the enabled/disabled state of the Add Symbol button.
 * @param {boolean} isEnabled - True to enable the button, false to disable.
 */
export function setAddSymbolButtonEnabled(isEnabled) {
  // Ensure elements are available
  if (!domElements.addSymbolButton) {
    // Attempt to query again if elements might not be ready initially
    queryElements();
    if (!domElements.addSymbolButton) {
      console.error(
        "UI: Cannot set Add Symbol Button state, element not found."
      );
      return;
    }
  }
  domElements.addSymbolButton.disabled = !isEnabled;
}

/**
 * Creates the value string for a datalist option based on the symbol and potential duplicates.
 * @param {object} symbol - The symbol object (may have needsDisambiguation flag).
 * @returns {string} The string to be used as the option's value.
 */
export function formatSymbolForDatalistValue(symbol) {
  if (symbol.needsDisambiguation && symbol.file_name && symbol.line_number) {
    // Extract basename from file_name for brevity if needed
    const filename = symbol.file_name.includes("/")
      ? symbol.file_name.substring(symbol.file_name.lastIndexOf("/") + 1)
      : symbol.file_name;
    return `${symbol.name} (${filename}:${symbol.line_number})`;
  } else {
    // If no disambiguation needed or possible, just return the name
    return symbol.name;
  }
}

/**
 * Populates the symbol datalist with options based on search results.
 * Option values include disambiguation info if needed.
 * @param {Array<object>} symbols - Array of symbol objects from the search.
 */
export function updateSymbolDatalist(symbols) {
  if (!domElements.symbolDatalist) return;
  const datalist = domElements.symbolDatalist;
  datalist.innerHTML = ""; // Clear previous options

  if (!symbols || symbols.length === 0) {
    return;
  }

  // Keep track of values added to prevent exact duplicate options in datalist
  const addedValues = new Set();

  symbols.forEach((symbol) => {
    const optionValue = formatSymbolForDatalistValue(symbol);
    // Prevent adding the exact same string value twice to the datalist
    if (!addedValues.has(optionValue)) {
      const option = document.createElement("option");
      option.value = optionValue;
      // Store the original name and address (if needed for lookup later)
      // It's often simpler to just parse the value back during 'add' action
      // option.dataset.rawName = symbol.name;
      // option.dataset.address = symbol.address;
      datalist.appendChild(option);
      addedValues.add(optionValue);
    }
  });
}

/**
 * Toggles fullscreen state for a given module.
 * @param {string} targetModuleId - The ID of the module to toggle ('plotModule', 'textModule', 'quatModuleContainer').
 */
function toggleModuleFullscreen(targetModuleId) {
  const targetModule = document.getElementById(targetModuleId);
  // #displayArea is the container and boundary for fullscreen
  const displayArea = domElements.displayArea;
  // Define all modules/containers potentially involved in fullscreen toggle and their DOM refs
  const modules = {
    plot: domElements.plotModulePlaceholder,
    text: domElements.textModulePlaceholder, // Note: text/quat modules might be nested inside #bottomRow
    quat: domElements.quatModuleContainer,
    bottomRow: domElements.bottomRow, // #bottomRow container
  };

  const button = targetModule?.querySelector(".module-fullscreen-button");

  // Basic checks for required elements
  if (
    !targetModule ||
    !displayArea ||
    !button ||
    !modules.plot ||
    !modules.bottomRow ||
    !modules.text ||
    !modules.quat
  ) {
    console.error(
      "Fullscreen toggle error: Missing necessary element references. Check module IDs and queryElements. ID:",
      targetModuleId
    );
    return;
  }

  const isEnteringFullscreen =
    !targetModule.classList.contains("module-fullscreen");
  let moduleToResizeId = null; // Track which module(s) need resizing
  let nextIconName = ""; // Variable to hold the next icon name for the button

  // --- Update Icon ---
  nextIconName = isEnteringFullscreen ? "minimize" : "maximize"; // Choose icon based on next state
  button.innerHTML = `<i data-lucide="${nextIconName}" style="width:1em; height:1em;"></i>`;
  button.title = "Fullscreen/Restore"; // Update title
  if (typeof lucide !== "undefined" && lucide.createIcons) {
    try {
      // Render the specific icon within the button
      lucide.createIcons({ nodes: [button] });
    } catch (e) {
      console.error("Lucide failed to update icon", e);
    }
  }

  // --- Toggle Classes ---
  if (isEnteringFullscreen) {
    // 1. Remove fullscreen state from any other module if active
    Object.entries(modules).forEach(([key, moduleEl]) => {
      if (
        moduleEl &&
        moduleEl.id !== targetModuleId &&
        moduleEl.classList.contains("module-fullscreen")
      ) {
        moduleEl.classList.remove("module-fullscreen");
        const otherButton = moduleEl.querySelector(".module-fullscreen-button");
        if (otherButton) {
          // Reset other button's icon back to 'maximize'
          otherButton.innerHTML = `<i data-lucide="maximize" style="width:1em; height:1em;"></i>`;
          otherButton.title = "Fullscreen/Restore";
          // Optionally update just this icon if needed immediately
          if (typeof lucide !== "undefined") {
            try {
              lucide.createIcons({ nodes: [otherButton] });
            } catch (e) {}
          }
        }
      }
    });

    // 2. Apply fullscreen classes to the target module and the container
    targetModule.classList.add("module-fullscreen");
    displayArea.classList.add("display-area-fullscreen-active");
    moduleToResizeId = targetModuleId; // Target module needs resizing

    // 3. Hide other modules/containers
    if (targetModuleId === "plotModule") {
      modules.bottomRow?.classList.add("hidden-by-fullscreen"); // Hide the entire bottom row
    } else {
      // text or quat module is fullscreen
      modules.plot?.classList.add("hidden-by-fullscreen"); // Hide the plot module
      const siblingId =
        targetModuleId === "textModule" ? "quatModuleContainer" : "textModule";
      document.getElementById(siblingId)?.classList.add("hidden-by-fullscreen"); // Hide the sibling module in the bottom row
      modules.bottomRow?.classList.remove("hidden-by-fullscreen"); // Ensure bottomRow itself remains visible (as container)
    }
  } else {
    // Exiting fullscreen
    targetModule.classList.remove("module-fullscreen");
    displayArea.classList.remove("display-area-fullscreen-active");
    moduleToResizeId = "all"; // All modules might need resizing when exiting

    // Remove all hiding classes
    Object.values(modules).forEach((moduleEl) => {
      moduleEl?.classList.remove("hidden-by-fullscreen");
    });
    // Ensure specific elements are unhidden too (might be redundant but safe)
    document
      .getElementById("textModule")
      ?.classList.remove("hidden-by-fullscreen");
    document
      .getElementById("quatModuleContainer")
      ?.classList.remove("hidden-by-fullscreen");
  }

  // --- Trigger Resize ---
  // Schedule resize after the DOM changes have likely been processed
  requestAnimationFrame(() => {
    console.log(`Triggering resize for: ${moduleToResizeId}`);
    try {
      // Access module instances (e.g., via window or imports) - *** ADJUST AS NEEDED ***
      const plot = window.plotModule;
      const terminal = window.terminalModule;
      const quat = window.quatModule;

      if (moduleToResizeId === "all" || moduleToResizeId === "plotModule")
        plot?.resize();
      if (moduleToResizeId === "all" || moduleToResizeId === "textModule")
        terminal?.resize();
      if (
        moduleToResizeId === "all" ||
        moduleToResizeId === "quatModuleContainer"
      )
        quat?.resize();

      // After exiting fullscreen, might need to re-initialize Split.js layout
      // if(moduleToResizeId === 'all' && typeof initializeSplitLayout === 'function') {
      //    console.log("Re-initializing split layout after exiting fullscreen.");
      //    initializeSplitLayout(debouncedResizeHandler); // Need access to the resize handler from ui.js scope
      // }
    } catch (e) {
      console.warn("Error during resize after fullscreen toggle:", e);
    }
  });
}
// --- Export Public API for UIManager ---
export {
  initUIManager,
  updateStatus,
  updateButtonStates,
  updateBufferUI,
  showWorkerStatus,
  showParserStatus,
  updateControlVisibility,
  updateParserVisibility,
  initializeSplitLayout,
  setupResizeObserver,
  getCurrentConfigFromUI,
};
