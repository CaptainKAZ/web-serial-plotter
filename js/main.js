// js/main.js - Refactored Application Core / Coordinator

import {
  DEFAULT_MAX_BUFFER_POINTS,
  MIN_BUFFER_POINTS,
  DEFAULT_SIM_CHANNELS,
  DEFAULT_SIM_FREQUENCY,
  DEFAULT_SIM_AMPLITUDE,
  DEFAULT_BAUD_RATE,
} from "./config.js";
import { eventBus } from "./event_bus.js";
import * as uiManager from "./modules/ui.js";
import * as serialService from "./modules/serial.js";
import * as workerService from "./modules/worker_service.js";
import * as dataProcessor from "./modules/data_processing.js";
import * as plotModule from "./modules/plot_module.js";
import * as terminalModule from "./modules/terminal_module.js";
import * as quatModule from "./modules/quat_module.js";
import { debounce } from "./utils.js";
import * as elfAnalyzerService from "./modules/elf_analyzer_service.js";
import * as aresplotProtocol from "./modules/aresplot_protocol.js";

// Core Application State
const appState = {
  isCollecting: false,
  isSerialConnected: false, // Managed primarily by serialService events
  mainThreadDataQueue: [],
  config: {
    // Initial defaults, overwritten during init by syncConfigFromUI
    dataSource: "simulated",
    numChannels: DEFAULT_SIM_CHANNELS,
    maxBufferPoints: DEFAULT_MAX_BUFFER_POINTS,
    baudRate: DEFAULT_BAUD_RATE,
    serialProtocol: "default",
    parserCode: "",
    simFrequency: DEFAULT_SIM_FREQUENCY,
    simAmplitude: DEFAULT_SIM_AMPLITUDE,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
    bufferSize: 32768,
  },
  rAFID: null,
};

const displayModules = [plotModule, terminalModule, quatModule];

// --- Initialization ---
function registerServiceWorker() {
  console.log("Core: Registering Service Worker...");
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("sw.js")
      .then((registration) => {
        console.log("ServiceWorker register successfully", registration.scope); // ServiceWorker registration successful with scope:
      })
      .catch((error) => {
        console.error("ServiceWorker register fail:", error); // ServiceWorker registration failed:
      });
  } else {
    console.log("Browser not support Service Worker。"); // Service Worker not supported by this browser.
  }
}
async function initializeApp() {
  console.log("Core: Initializing application...");
  try {
    uiManager.updateStatus("状态：正在初始化...");
  } catch (e) {}

  const workerReady = await workerService.init();
  if (!workerReady) {
    uiManager.updateStatus("错误：无法初始化 Worker Service！");
    return;
  }

  await uiManager.initUIManager();

  syncConfigFromUI(); // Sync initial config FROM UI after UI is ready

  // --- Proactively Initialize Wasm Module ---
  // Call the init function here. We don't necessarily need to await it
  // if the UI can load without it, but we should handle potential errors.
  elfAnalyzerService
    .initWasmModule()
    .then(() => {
      console.log("Core: Wasm module background initialization successful.");
      // Optional: Update UI element if needed, e.g., enable aresplot option if disabled initially
    })
    .catch((error) => {
      console.error(
        "Core: Wasm module background initialization failed:",
        error
      );
      // Optional: Update UI to indicate Wasm features might be unavailable
      uiManager.updateStatus(`警告：ELF 分析器初始化失败 (${error.message})`);
      // Optional: Disable the 'aresplot' option in the dropdown
      const aresplotOption = document.querySelector(
        '#serialProtocolSelect option[value="aresplot"]'
      );
      if (aresplotOption) {
        aresplotOption.disabled = true;
        aresplotOption.textContent += " (加载失败)";
      }
    });
  // --- End Wasm Initialization ---

  console.log(
    `Core: Initial State Applied - Source: ${appState.config.dataSource}`
  );

  setupAppEventListeners(); // Setup core listeners AFTER initial state sync

  // Update Initial UI State based on synced config
  uiManager.updateControlVisibility(appState.config.dataSource);
  uiManager.updateButtonStates(getButtonState());
  uiManager.updateParserVisibility(appState.config.serialProtocol);
  uiManager.updateBufferUI(getBufferStats());
  registerServiceWorker();

  // Defer Display Module Creation & Layout Init
  requestAnimationFrame(() => {
    console.log("Core: Deferred initialization starting...");

    // Determine initial channels based on ACTUAL data source AFTER sync
    const initialChannelsForPlot =
      appState.config.dataSource === "simulated"
        ? appState.config.numChannels
        : 1; // Default to 1 channel for WebSerial initially
    console.log(
      `Core: Initializing plot with ${initialChannelsForPlot} channel(s).`
    );

    const moduleCreationResults = [
      plotModule.create("plotModule", {
        follow: true,
        numChannels: initialChannelsForPlot,
        maxBufferPoints: appState.config.maxBufferPoints,
      }),
      terminalModule.create("textModule", { rawDisplayMode: "str" }),
      quatModule.create("quatModuleContainer", {
        numChannels: initialChannelsForPlot,
      }),
    ];
    const plotSuccess = moduleCreationResults[0];
    const terminalSuccess = moduleCreationResults[1];
    const quatSuccess = moduleCreationResults[2];

    console.log("Core: Initializing layout...");
    const mainResizeHandler = () => {
      if (plotSuccess)
        try {
          plotModule.resize();
        } catch (e) {}
      if (terminalSuccess)
        try {
          terminalModule.resize();
        } catch (e) {}
      if (quatSuccess)
        try {
          quatModule.resize();
        } catch (e) {}
    };
    const debouncedResizeHandler = debounce(mainResizeHandler, 150);
    try {
      uiManager.initializeSplitLayout(debouncedResizeHandler);
      uiManager.setupResizeObserver(debouncedResizeHandler);
      requestAnimationFrame(mainResizeHandler);
    } catch (layoutError) {
      console.error("Core: Error during layout initialization:", layoutError);
      uiManager.updateStatus("错误：布局初始化失败！");
    }

    if (!appState.rAFID) {
      appState.rAFID = requestAnimationFrame(mainLoop);
      console.log("Core: Main loop started.");
    }
    uiManager.updateStatus("状态：初始化完成，准备就绪。");
    console.log("Core: Application initialized.");
  });
}

// --- Event Bus Listener Setup ---
function setupAppEventListeners() {
  eventBus.on("ui:startStopClicked", handleStartStopIntent);
  eventBus.on("ui:connectDisconnectClicked", handleConnectDisconnectIntent);
  eventBus.on("ui:dataSourceChanged", handleDataSourceChangeIntent);
  eventBus.on("ui:protocolChanged", handleProtocolChangeIntent);
  eventBus.on("ui:updateParserClicked", handleUpdateParserIntent);
  eventBus.on("ui:bufferDurationChanged", handleBufferChangeIntent);
  eventBus.on("ui:simConfigChanged", handleSimConfigChangeIntent);
  eventBus.on("ui:clearDataClicked", handleClearDataIntent);
  eventBus.on("ui:downloadCsvClicked", handleDownloadCsvIntent);
  eventBus.on("ui:baudRateSet", handleBaudRateSetIntent);
  eventBus.on("serial:connected", handleSerialConnected);
  eventBus.on("serial:disconnected", handleSerialDisconnected);
  eventBus.on("serial:error", handleSerialError);
  eventBus.on("serial:status", handleSerialStatus);
  eventBus.on("worker:dataBatch", handleWorkerData);
  eventBus.on("worker:status", handleWorkerStatus); // General status
  eventBus.on("worker:info", handleWorkerInfo); // Aresplot specific info (e.g. timestamp init)
  eventBus.on("worker:warn", handleWorkerWarn); // Aresplot warnings (ACK NACK, drift, parser issues)
  eventBus.on("worker:error", handleWorkerError); // Critical worker errors
  eventBus.on("ui:elfFileSelected", handleElfFileSelected);
  eventBus.on("ui:symbolSearchChanged", handleSymbolSearchChanged); // Listener for input/suggestions
  eventBus.on("ui:symbolInputValidated", handleSymbolInputValidation); // <<< NEW listener for validation
  eventBus.on("ui:symbolSelectedForAdd", handleSymbolSelectedForAdd); // Listener for add button/enter
  eventBus.on("main:statusUpdate", handleMainStatusUpdate);
  eventBus.on("ui:symbolSlotsUpdated", (event) => {
    const currentSlots = event.detail.slots;
    console.log(
      "Main: Detected symbol slots updated. Current symbols:",
      currentSlots.map((s) => s.name)
    );
    // If Aresplot is active and connected, send the new monitor command
    if (
      appState.config.serialProtocol === "aresplot" &&
      serialService.isConnected() &&
      appState.isCollecting
    ) {
      sendAresplotStartMonitorCommand();
    }
  });
}

// --- Intent Handlers (Responding to UI Events) ---

function handleStartStopIntent() {
  if (appState.isCollecting) stopCore();
  else startCore();
  uiManager.updateButtonStates(getButtonState());
}

async function handleConnectDisconnectIntent(event) {
  const optionsFromUI = event.detail; // May be null if UI validation failed
  if (serialService.isConnected()) {
    // Check service state
    await serialService.disconnect();
  } else {
    if (appState.config.dataSource === "webserial") {
      syncConfigFromUI(); // Get latest settings before connecting
      const connectOptions = {
        baudRate: appState.config.baudRate,
        dataBits: appState.config.dataBits,
        stopBits: appState.config.stopBits,
        parity: appState.config.parity,
        flowControl: appState.config.flowControl,
        bufferSize: appState.config.bufferSize,
      };
      if (connectOptions.baudRate > 0) {
        await serialService.connect(connectOptions);
      } else {
        uiManager.updateStatus("错误：无效波特率");
      }
    }
  }
}

function handleDataSourceChangeIntent(event) {
  const { source } = event.detail;
  console.log(`Core: Data source changed to ${source}`);
  if (appState.isCollecting) stopCore();
  if (source === "simulated" || source === "webserial") {
    appState.config.dataSource = source;
    uiManager.updateControlVisibility(source);
    syncConfigFromUI(); // Sync relevant config for the new source
    let targetChannelCount =
      source === "simulated" ? appState.config.numChannels : 1; // Default to 1 for serial
    if (source !== "simulated") appState.config.numChannels = 1; // Reset internal channel count state for non-sim sources
    displayModules.forEach((m) => {
      if (m.updateConfig)
        m.updateConfig({
          numChannels: targetChannelCount,
        });
    });
    handleClearDataIntent(); // Clear data
    uiManager.updateButtonStates(getButtonState()); // Update UI state
  } else {
    console.error(`Core: Invalid data source: ${source}`);
  }
}

function handleProtocolChangeIntent(event) {
  const { protocol, code } = event.detail;
  appState.config.serialProtocol = protocol;
  appState.config.parserCode = protocol === "custom" ? code : "";

  if (protocol === "aresplot") {
    console.log("Aresplot protocol selected.");
    // We assume Wasm initialization was already triggered.
    // Check if it failed earlier and maybe show a message if needed.
    if (!elfAnalyzerService.isWasmReady()) {
      const statusMsgEl = document.getElementById("elfStatusMessage");
      if (statusMsgEl) {
        statusMsgEl.textContent =
          "Error: ELF Analyzer module failed to initialize during startup.";
        statusMsgEl.classList.add("text-red-500");
      }
      console.warn(
        "Aresplot selected, but Wasm module failed to initialize earlier."
      );
    } else {
      // Clear previous symbols if switching TO aresplot
      elfAnalyzerService.clearParsedSymbols();
    }
  } else {
    // Logic for other protocols (send parser update, etc.)
    if (serialService.isConnected() && !appState.isCollecting) {
      workerService.updateParser(protocol, code);
    } else if (appState.isCollecting) {
      uiManager.updateStatus("警告：协议已更改，请停止并重新开始采集。");
    }
  }

  uiManager.updateButtonStates(getButtonState());
}

function handleUpdateParserIntent(event) {
  const { code } = event.detail;
  if (appState.config.serialProtocol === "custom") {
    appState.config.parserCode = code;
    if (serialService.isConnected() && !appState.isCollecting)
      workerService.updateParser("custom", code);
    else
      uiManager.showParserStatus(
        "解析器代码已更新，将在下次启动时应用。",
        false
      );
  } else {
    uiManager.showParserStatus("请先选择 '自定义' 协议。", true);
  }
}

function handleBufferChangeIntent(event) {
  const { duration } = event.detail;
  if (
    duration &&
    duration >= MIN_BUFFER_POINTS &&
    appState.config.maxBufferPoints !== duration
  ) {
    appState.config.maxBufferPoints = duration;
    plotModule.updateConfig({ maxBufferPoints: duration });
    dataProcessor.trimDataBuffer(duration);
    dataProcessor.calculateBufferEstimate(
      dataProcessor.getCurrentDataRate(),
      dataProcessor.getBufferLength(),
      duration,
      appState.isCollecting
    );
    uiManager.updateBufferUI(getBufferStats());
  }
}

function handleSimConfigChangeIntent(event) {
  const simConfig = event.detail;
  appState.config.numChannels = simConfig.numChannels;
  appState.config.simFrequency = simConfig.frequency;
  appState.config.simAmplitude = simConfig.amplitude;

  // 如果当前正在采集模拟数据，则向 Worker 发送更新配置的消息
  // 而不是重启整个采集流程
  if (appState.isCollecting && appState.config.dataSource === "simulated") {
    console.log("Core: 向 Worker 发送模拟配置更新。");
    workerService.updateSimConfig(simConfig); // <-- 修改点：调用新的服务函数
  }
}

function handleClearDataIntent() {
  if (appState.isCollecting) {
    stopCore(); // Initiate stop
  }
  // Delay clear operations slightly (e.g., 50ms)
  // Adjust delay as needed, 50ms is usually enough for in-flight messages
  setTimeout(() => {
    const confirmationMessage = "清除所有图表和缓冲区数据？";
    if (
      dataProcessor.getBufferLength() > 0 &&
      window.confirm(confirmationMessage)
    ) {
      displayModules.forEach((module) => {
        try {
          module.clear();
        } catch (e) {
          console.warn("Error clearing module:", e);
        }
      });
      dataProcessor.clearBuffer();
      appState.mainThreadDataQueue = []; // Clear queue after delay
      dataProcessor.resetEstimatesAndRate();
      uiManager.updateBufferUI(getBufferStats());
      uiManager.updateButtonStates(getButtonState());

      console.log("Delayed clear operations (setTimeout) complete.");
    }
  }, 50);
}

function handleDownloadCsvIntent() {
  let seriesInfo = null;
  try {
    seriesInfo = plotModule.chartInstance?.options?.series;
  } catch (e) {}
  dataProcessor.downloadCSV(seriesInfo);
}

function handleBaudRateSetIntent(event) {
  const { value } = event.detail;
  const num = parseInt(value);
  if (value && !isNaN(num) && num > 0) appState.config.baudRate = num;
}

// --- Service/Worker Event Handlers ---
function handleSerialConnected(event) {
  appState.isSerialConnected = true;
  uiManager.updateStatus("状态：串口已连接");
  uiManager.updateButtonStates(getButtonState());
}
function handleSerialDisconnected(event) {
  const detail = event.detail;
  appState.isSerialConnected = false;
  if (appState.isCollecting && appState.config.dataSource === "webserial")
    stopCore();
  uiManager.updateStatus(
    detail?.external ? "状态：串口连接丢失" : "状态：串口已断开"
  );
  uiManager.updateButtonStates(getButtonState());
}
function handleSerialError(event) {
  const error = event.detail;
  appState.isSerialConnected = false;
  if (appState.isCollecting && appState.config.dataSource === "webserial")
    stopCore();
  uiManager.updateStatus(`错误: ${error.message}`);
  uiManager.updateButtonStates(getButtonState());
}
function handleSerialStatus(event) {
  const status = event.detail;
  uiManager.updateStatus(`状态：${status}`);
}
function handleWorkerData(event) {
  const batch = event.detail;
  if (Array.isArray(batch) && batch.length > 0) {
    // Batch items are expected to be { timestamp, values, rawLineBytes?, isUnidentifiedAresplotData? }
    // For Aresplot, timestamp is PC-calibrated, values are FP32.
    // For other protocols, timestamp is PC time at reception in worker.
    // rawLineBytes is used by terminalModule.
    Array.prototype.push.apply(appState.mainThreadDataQueue, batch);
  }
}

function handleWorkerStatus(event) {
  // For general worker status messages
  const payload = event.detail;
  // console.log("Main (Worker Status):", payload);
  if (payload && typeof payload === "string") {
    if (
      payload.toLowerCase().includes("parser") &&
      (payload.toLowerCase().includes("error") ||
        payload.toLowerCase().includes("invalid"))
    ) {
      uiManager.showParserStatus(payload, true);
    } else if (payload.toLowerCase().includes("parser")) {
      uiManager.showParserStatus(payload, false);
    } else {
      uiManager.showWorkerStatus(payload, false); // General, non-error status
    }
  } else {
    uiManager.showWorkerStatus(String(payload), false);
  }
}

function handleWorkerInfo(event) {
  // For Aresplot specific info (e.g., timestamp sync)
  const payload = event.detail;
  if (payload && payload.source === "aresplot_timestamp") {
    console.info("Main (Aresplot Info):", payload.message);
    // Update a subtle status area or just log for now
    if (
      document.getElementById("elfStatusMessage") &&
      appState.config.serialProtocol === "aresplot"
    ) {
      // uiManager.updateElementText('elfStatusMessage', `Aresplot: ${payload.message}`);
    }
  } else {
    console.info("Main (Worker Info):", payload);
  }
}

function handleWorkerWarn(event) {
  // For Aresplot NACKs, timestamp drift, parser internal warnings
  const payload = event.detail;
  let message = "Worker warning.";
  let targetStatusElementId = "statusMessage"; // Default general status

  if (payload instanceof Error) {
    message = payload.message;
  } else if (typeof payload === "object" && payload !== null) {
    message = payload.message || JSON.stringify(payload);
    if (payload.source === "aresplot_ack_error") {
      message = `MCU NACK for CMD 0x${(payload.commandId || 0).toString(
        16
      )} - Status 0x${(payload.statusCode || 0).toString(16)}.`;
      targetStatusElementId = "elfStatusMessage";
    } else if (payload.source === "aresplot_timestamp") {
      message = `Timestamp Drift: ${payload.message}`;
      targetStatusElementId = "elfStatusMessage";
    } else if (payload.source === "aresplot_parser_internal") {
      message = `Aresplot Parser: ${payload.message}`;
      targetStatusElementId = "elfStatusMessage";
    } else if (payload.source === "parser_line_break") {
      // From non-aresplot text parser
      message = `Parser Warning: ${payload.message}`;
      // targetStatusElementId remains 'statusMessage' or a dedicated parser status area
    }
  } else if (typeof payload === "string") {
    message = payload;
  }

  console.warn("Main (Worker Warn):", message, payload);
  if (
    document.getElementById(targetStatusElementId) &&
    targetStatusElementId === "elfStatusMessage" &&
    appState.config.serialProtocol === "aresplot"
  ) {
    uiManager.updateElementText(
      targetStatusElementId,
      `Warning: ${message}`,
      true
    );
  } else {
    uiManager.showWorkerStatus(`Warning: ${message}`, true); // General worker warning display
  }
}

function handleWorkerError(event) {
  // For critical worker errors
  const error = event.detail; // This is expected to be an Error object from worker_service
  console.error("Main (Worker Error):", error.message || error);
  if (appState.isCollecting) stopCore(); // Stop collection on critical worker error
  uiManager.showWorkerStatus(
    `Worker Error: ${error.message || String(error)}`,
    true
  );
  uiManager.updateButtonStates(getButtonState());
}

/**
 * Processes a symbol object from ELF analysis to add:
 * 1. _displayType: A concise string for UI display (e.g., "f32", "u16*", "INT8").
 * 2. _protocolType: The numeric AresOriginalType_t value for protocol communication.
 * Modifies the symbol object in place and returns it.
 * @param {object} symbol - The symbol object (must have name, type_name, size from ELF).
 * @returns {object} The augmented symbol object.
 */
function augmentSymbolWithTypeData(symbol) {
  if (
    !symbol ||
    typeof symbol.name === "undefined" ||
    typeof symbol.type_name === "undefined" ||
    typeof symbol.size === "undefined"
  ) {
    console.warn(
      "augmentSymbolWithTypeData: Invalid symbol object received.",
      symbol
    );
    if (symbol) {
      symbol._displayType = "UNK"; // Short for UNKNOWN
      symbol._protocolType = null;
    }
    return symbol;
  }

  let displayTypeStr = "UNK"; // Default concise display type
  let protocolTypeValue = null; // Protocol type value

  const typeNameLower = symbol.type_name.toLowerCase();
  const sizeBytes = symbol.size;

  // 1. Handle Pointers first
  if (
    typeNameLower.includes("*") ||
    typeNameLower === "pointer" ||
    typeNameLower === "ptr"
  ) {
    protocolTypeValue = aresplotProtocol.AresOriginalType.UINT32; // Default protocol type for pointer addresses
    switch (sizeBytes) {
      case 1:
        displayTypeStr = "u8";
        protocolTypeValue = aresplotProtocol.AresOriginalType.UINT8;
        break; // Unlikely but for spec
      case 2:
        displayTypeStr = "u16";
        protocolTypeValue = aresplotProtocol.AresOriginalType.UINT16;
        break; // Unlikely
      case 4:
        displayTypeStr = "u32";
        protocolTypeValue = aresplotProtocol.AresOriginalType.UINT32;
        break;
      case 8:
        displayTypeStr = "u64";
        protocolTypeValue = aresplotProtocol.AresOriginalType.UINT32;
        break; // Or future UINT64
      default:
        displayTypeStr = `u${sizeBytes * 8}`; // e.g. ptr_s_
        if (sizeBytes > 0 && sizeBytes <= 4)
          protocolTypeValue = aresplotProtocol.AresOriginalType.UINT32;
        else protocolTypeValue = null; // Cannot map non-standard pointer size to current protocol types easily
        break;
    }
  }
  // 2. Handle Floating Point types
  else if (typeNameLower.includes("float") || typeNameLower === "f32") {
    displayTypeStr = "f32";
    protocolTypeValue = aresplotProtocol.AresOriginalType.FLOAT32;
  } else if (typeNameLower.includes("double") || typeNameLower === "f64") {
    displayTypeStr = "f64";
    protocolTypeValue = aresplotProtocol.AresOriginalType.FLOAT64;
  }
  // 3. Handle Boolean
  else if (typeNameLower.includes("bool") || typeNameLower === "_bool") {
    displayTypeStr = "bool"; // Simple 'bool' for display
    protocolTypeValue = aresplotProtocol.AresOriginalType.BOOL;
  }
  // 4. Handle Integers (and char as integer)
  else {
    let isSigned =
      typeNameLower.includes("int") ||
      typeNameLower.includes("short") ||
      typeNameLower.includes("long") ||
      (typeNameLower.includes("char") && !typeNameLower.includes("unsigned"));
    // Further refine signed for specific intN_t types
    if (
      typeNameLower.match(/i(8|16|32|64)_t$/) ||
      typeNameLower === "signed char"
    )
      isSigned = true;
    if (
      typeNameLower.match(/u(8|16|32|64)_t$/) ||
      typeNameLower === "unsigned char"
    )
      isSigned = false;

    switch (sizeBytes) {
      case 1:
        displayTypeStr = isSigned ? "i8" : "u8";
        protocolTypeValue = isSigned
          ? aresplotProtocol.AresOriginalType.INT8
          : aresplotProtocol.AresOriginalType.UINT8;
        break;
      case 2:
        displayTypeStr = isSigned ? "i16" : "u16";
        protocolTypeValue = isSigned
          ? aresplotProtocol.AresOriginalType.INT16
          : aresplotProtocol.AresOriginalType.UINT16;
        break;
      case 4:
        displayTypeStr = isSigned ? "i32" : "u32";
        protocolTypeValue = isSigned
          ? aresplotProtocol.AresOriginalType.INT32
          : aresplotProtocol.AresOriginalType.UINT32;
        break;
      case 8:
        displayTypeStr = isSigned ? "i64" : "u64";
        // Protocol type for 64-bit integers needs careful consideration based on MCU's conversion to FP32
        protocolTypeValue = isSigned
          ? aresplotProtocol.AresOriginalType.INT32
          : aresplotProtocol.AresOriginalType.UINT32; // Defaulting to 32-bit for protocol
        // console.warn(`Symbol '${symbol.name}' type ${typeNameLower} (size 8) is 64-bit; Aresplot protocol uses 32-bit for OriginalType.`);
        break;
      default:
        // For named enums, structs, or unknown types with a specific size
        if (
          typeNameLower &&
          typeNameLower !== "unknown" &&
          typeNameLower !== "void" &&
          typeNameLower.length > 0
        ) {
          // Keep original type name for display if it's not a standard C type, append size
          displayTypeStr = `${symbol.type_name}_s${sizeBytes}`;
        } else if (sizeBytes > 0) {
          displayTypeStr = `b${sizeBytes}`; // Generic 'bytes of size X'
        }
        // Try to map to a protocol type based on size if possible
        if (sizeBytes === 1)
          protocolTypeValue = aresplotProtocol.AresOriginalType.UINT8;
        else if (sizeBytes === 2)
          protocolTypeValue = aresplotProtocol.AresOriginalType.UINT16;
        else if (sizeBytes === 4)
          protocolTypeValue = aresplotProtocol.AresOriginalType.UINT32;
        else protocolTypeValue = null; // Cannot reliably map other sizes

        if (protocolTypeValue === null && sizeBytes > 0) {
          console.warn(
            `Symbol '${symbol.name}' (type: ${typeNameLower}, size: ${sizeBytes}) has unmapped complex/large type. Cannot determine _protocolType.`
          );
        }
        break;
    }
  }

  symbol._displayType = displayTypeStr; // For UI rendering prefix in slots
  symbol._protocolType = protocolTypeValue; // Numeric value for CMD_START_MONITOR
  return symbol;
}

/**
 * Sends the CMD_START_MONITOR command based on current symbol slots for Aresplot.
 */
async function sendAresplotStartMonitorCommand() {
  if (
    appState.config.serialProtocol !== "aresplot" ||
    !serialService.isConnected()
  ) {
    return; // Conditions not met
  }

  const symbolsInSlots = uiManager.getSelectedSymbolsInSlots(); // Gets array of augmented symbol objects
  const symbolsForProtocol = symbolsInSlots
    .map((s) => {
      // _protocolType should have been set when symbol was added/updated via augmentSymbolWithTypeData
      if (s._protocolType === null || s._protocolType === undefined) {
        console.error(
          `Aresplot Error: Symbol "${s.name}" in slot is missing _protocolType or it's null. Cannot send.`
        );
        return null;
      }
      return { address: s.address, originalType: s._protocolType };
    })
    .filter((s) => s !== null); // Filter out any unmappable symbols

  try {
    const frame = aresplotProtocol.buildStartMonitorFrame(symbolsForProtocol);
    const numVars = symbolsForProtocol.length;
    console.log(
      `Main: Sending CMD_START_MONITOR with ${numVars} variable(s) for Aresplot.`
    );
    await serialService.write(frame); // Assumes serialService.write accepts Uint8Array
    if (document.getElementById("elfStatusMessage")) {
      // Update specific status if element exists
      uiManager.updateElementText(
        "elfStatusMessage",
        `${
          numVars > 0 ? "Monitoring" : "Stopped monitoring"
        } ${numVars} variable(s).`
      );
    }
  } catch (error) {
    console.error(
      "Main: Error building or sending Aresplot CMD_START_MONITOR:",
      error
    );
    if (document.getElementById("elfStatusMessage")) {
      uiManager.updateElementText(
        "elfStatusMessage",
        `Error sending monitor cmd: ${error.message}`,
        true
      );
    } else {
      uiManager.updateStatus(`Error sending monitor cmd: ${error.message}`);
    }
  }
}

async function handleElfFileSelected(event) {
  const file = event.detail.file;
  if (!file) {
    uiManager.updateElementText("elfStatusMessage", "No file selected.");
    return;
  }

  const statusMsgEl = document.getElementById("elfStatusMessage");
  const searchAreaEl = document.getElementById("symbolSearchArea");
  const searchInputEl = document.getElementById("symbolSearchInput"); // For clearing

  const updateAresplotStatus = (message, isError = false) => {
    if (statusMsgEl) {
      statusMsgEl.textContent = message;
      if (isError) statusMsgEl.classList.add("text-red-500");
      else statusMsgEl.classList.remove("text-red-500");
    }
    console.log(`Aresplot Status: ${message}`);
  };

  if (searchAreaEl) searchAreaEl.style.display = "none";
  uiManager.updateSymbolDatalist([]);
  if (searchInputEl) searchInputEl.value = "";
  uiManager.setAddSymbolButtonEnabled(false);

  updateAresplotStatus("Reading file and initializing Wasm...");

  try {
    await elfAnalyzerService.ensureInitialized();
    updateAresplotStatus("Wasm ready. Reading ELF file...");

    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    updateAresplotStatus("Analyzing ELF file...");

    const newAnalysisResults = await elfAnalyzerService.analyzeElf(uint8Array);

    // --- Symbol Re-matching Logic ---
    const previouslySelectedSymbols = uiManager.getSelectedSymbolsInSlots();
    const reMatchedSymbols = [];
    if (previouslySelectedSymbols.length > 0 && newAnalysisResults.length > 0) {
      updateAresplotStatus(
        "Re-matching existing slot symbols with new ELF data..."
      );
      previouslySelectedSymbols.forEach((oldSymbolInSlot) => {
        let bestMatch = null;
        // Use original name from oldSymbolInSlot as its _displayType might differ
        const oldSymbolName = oldSymbolInSlot.name;
        const oldSymbolFile = oldSymbolInSlot.file_name;
        const oldSymbolLine = oldSymbolInSlot.line_number;

        bestMatch = newAnalysisResults.find(
          (newSym) =>
            newSym.name === oldSymbolName &&
            newSym.file_name === oldSymbolFile &&
            newSym.line_number === oldSymbolLine
        );
        if (!bestMatch) {
          bestMatch = newAnalysisResults.find(
            (newSym) =>
              newSym.name === oldSymbolName &&
              newSym.file_name === oldSymbolFile
          );
        }
        if (!bestMatch) {
          const nameMatches = newAnalysisResults.filter(
            (newSym) => newSym.name === oldSymbolName
          );
          if (nameMatches.length === 1) {
            bestMatch = nameMatches[0];
          } else if (nameMatches.length > 1) {
            const typeAndSizeMatch = nameMatches.find(
              (nm) =>
                nm.type_name === oldSymbolInSlot.type_name &&
                nm.size === oldSymbolInSlot.size
            );
            if (typeAndSizeMatch) bestMatch = typeAndSizeMatch;
            else bestMatch = nameMatches[0]; // Fallback to first name match if still ambiguous
            console.warn(
              `Ambiguous re-match for "${oldSymbolName}", took one of ${nameMatches.length}`
            );
          }
        }

        if (bestMatch) {
          reMatchedSymbols.push(augmentSymbolWithTypeData({ ...bestMatch })); // Use new data, format type
        } else {
          console.warn(
            `Symbol "${oldSymbolName}" from previous slots not found in new ELF.`
          );
        }
      });
      uiManager.updateSlotsWithNewSymbols(reMatchedSymbols);
      updateAresplotStatus(
        `ELF loaded. ${newAnalysisResults.length} symbols found. Slots re-matched: ${reMatchedSymbols.length}.`
      );
    } else {
      uiManager.clearSymbolSlots(); // Clear if no old slots or new ELF has no results
      updateAresplotStatus(
        `ELF loaded. ${newAnalysisResults.length} symbols found.`
      );
    }
    // --- End Re-matching ---

    if (searchAreaEl) searchAreaEl.style.display = "block";
    uiManager.updateSymbolDatalist([]); // Clear datalist, ready for new search
  } catch (error) {
    console.error("ELF Processing Error caught in main.js:", error);
    updateAresplotStatus(
      `Error: ${error.message || "ELF processing error."}`,
      true
    );
    if (searchAreaEl) searchAreaEl.style.display = "none";
    uiManager.updateSymbolDatalist([]);
  }
}

function handleSymbolSearchChanged(event) {
  const term = event.detail.term;
  // console.debug(`[Debug Suggest] Search term changed: "${term}"`); // DEBUG

  if (!elfAnalyzerService.isElfLoadedAndAnalyzed()) {
    uiManager.updateSymbolDatalist([]);
    // DO NOT set button state here
    return;
  }

  // Fetch suggestions even for empty term to clear datalist
  const searchLimit = 50;
  const results = elfAnalyzerService.searchSymbols(term, searchLimit);
  uiManager.updateSymbolDatalist(results);

  // DO NOT set button state here - moved to handleSymbolInputValidation
}

function handleSymbolInputValidation(event) {
  const currentInputValue = event.detail.value;
  let canAdd = false;

  // console.debug(`[Debug Validate] Validating input value: "${currentInputValue}"`); // DEBUG

  if (
    elfAnalyzerService.isElfLoadedAndAnalyzed() &&
    currentInputValue.trim() !== ""
  ) {
    // Perform a quick search just to see if this exact value could be a result
    // We limit to 1 because we only care if THIS specific value is a potential valid formatted result
    const results = elfAnalyzerService.searchSymbols(currentInputValue, 50); // Search based on full input value

    // Check if the full input value exactly matches any formatted suggestion
    // (using the same formatting as the datalist options)
    canAdd = results.some((symbol) => {
      const optionValue = uiManager.formatSymbolForDatalistValue(symbol);
      const isMatch = currentInputValue === optionValue;
      // console.debug(`[Debug Validate] Comparing Input "<span class="math-inline">\{currentInputValue\}" \=\=\= Suggestion "</span>{optionValue}" -> ${isMatch}`); // DEBUG
      return isMatch;
    });
  } else {
    // console.debug("[Debug Validate] ELF not loaded or input empty. Cannot add."); // DEBUG
    canAdd = false;
  }

  // console.debug(`[Debug Validate] Validation result: canAdd = ${canAdd}. Updating button state.`); // DEBUG
  uiManager.setAddSymbolButtonEnabled(canAdd);
}
function handleSymbolSelectedForAdd(event) {
  const inputValue = event.detail.value;

  if (!elfAnalyzerService.isElfLoadedAndAnalyzed()) {
    eventBus.emit("main:statusUpdate", {
      message: "Error: ELF not analyzed. Cannot add symbol.",
      isError: true,
    });
    return;
  }

  let foundSymbol = null;
  const allSymbols = elfAnalyzerService.getAllParsedSymbols();
  const disambiguationMatch = inputValue.match(/^(.*)\s\(([^:]+):(\d+)\)$/);

  if (disambiguationMatch && disambiguationMatch.length === 4) {
    const namePart = disambiguationMatch[1];
    const filePart = disambiguationMatch[2];
    const linePart = parseInt(disambiguationMatch[3], 10);
    foundSymbol = allSymbols.find(
      (s) =>
        s.name === namePart &&
        s.line_number === linePart &&
        s.file_name &&
        s.file_name.endsWith(filePart)
    );
    if (!foundSymbol) {
      foundSymbol = allSymbols.find(
        (s) => s.name === namePart && s.line_number === linePart
      );
    }
  } else {
    const namePart = inputValue;
    const potentialMatches = allSymbols.filter((s) => s.name === namePart);
    if (potentialMatches.length === 1) {
      foundSymbol = potentialMatches[0];
    } else if (potentialMatches.length > 1) {
      const exactNameButUndisambiguated = potentialMatches.find(
        (s) => !s.file_name && !s.line_number
      );
      if (exactNameButUndisambiguated)
        foundSymbol = exactNameButUndisambiguated;
      else {
        // Still ambiguous
        eventBus.emit("main:statusUpdate", {
          message: `Error: Symbol name "${namePart}" is ambiguous.`,
          isError: true,
        });
        uiManager.setAddSymbolButtonEnabled(false);
        return;
      }
    }
  }

  if (foundSymbol) {
    const symbolToAdd = augmentSymbolWithTypeData({ ...foundSymbol }); // Create a copy and add display type
    const added = uiManager.addSymbolToSlot(symbolToAdd);
    if (added) {
      const searchInput = document.getElementById("symbolSearchInput");
      if (searchInput) searchInput.value = "";
      uiManager.updateSymbolDatalist([]);
      uiManager.setAddSymbolButtonEnabled(false);
      eventBus.emit("main:statusUpdate", {
        message: `Symbol "${foundSymbol.name}" added.`,
        isError: false,
      });
    }
    // If not added, uiManager.addSymbolToSlot will emit its own status message
  } else {
    eventBus.emit("main:statusUpdate", {
      message: `Error: Symbol '${inputValue}' not found. Select from list.`,
      isError: true,
    });
    uiManager.setAddSymbolButtonEnabled(false);
  }
}

function handleMainStatusUpdate(event) {
  const { message, isError } = event.detail;
  const statusMsgEl = document.getElementById("elfStatusMessage"); // Or a general status display
  if (statusMsgEl) {
    statusMsgEl.textContent = message;
    if (isError) {
      statusMsgEl.classList.add("text-red-500");
      statusMsgEl.classList.remove("text-green-500"); // Ensure only one color class
    } else {
      statusMsgEl.classList.remove("text-red-500");
      statusMsgEl.classList.add("text-green-500"); // Or a neutral color if preferred
    }
  } else {
    // Fallback if specific element not found, use the general app status
    uiManager.updateStatus(message); // Assuming uiManager.updateStatus can handle error styling or use another method
  }
}

// --- Core Logic Functions ---
function startCore() {
  if (appState.isCollecting) return;
  syncConfigFromUI(); // Sync config just before starting
  const dataSource = appState.config.dataSource;
  let workerConfig = {
    source: dataSource,
    protocol: appState.config.serialProtocol,
    parserCode: appState.config.parserCode,
    config: {},
  };
  plotModule.truncate();

  if (dataSource === "simulated") {
    workerConfig.config = {
      numChannels: appState.config.numChannels,
      frequency: appState.config.simFrequency,
      amplitude: appState.config.simAmplitude,
    };
    appState.isCollecting = true;
    uiManager.updateStatus("状态：采集中 (模拟)...");
    workerService.startWorker(workerConfig);
  } else if (dataSource === "webserial") {
    if (!serialService.isConnected()) {
      uiManager.updateStatus("错误：串口未连接。");
      return;
    }
    const readable = serialService.getReadableStream();
    if (!readable) {
      uiManager.updateStatus("错误：无法获取串口流。");
      return;
    }
    workerConfig.readableStream = readable;
    appState.isCollecting = true;
    uiManager.updateStatus("状态：采集中 (串口)...");
    workerService.startWorker(workerConfig);
  } else {
    uiManager.updateStatus(`错误：未知数据源 "${dataSource}"`);
    return;
  }

  if (
    dataSource === "webserial" &&
    appState.config.serialProtocol === "aresplot" &&
    serialService.isConnected()
  ) {
    console.log(
      "Main: Collection started with Aresplot. Sending initial CMD_START_MONITOR."
    );
    // Small delay to allow worker to initialize stream handling after receiving 'startSerialStream'
    setTimeout(() => {
      sendAresplotStartMonitorCommand();
    }, 10); // Adjust delay if needed
  }

  console.log("Core: Collection started.");
  uiManager.updateButtonStates(getButtonState());
  dataProcessor.resetEstimatesAndRate();
  uiManager.updateBufferUI(getBufferStats());
}
async function stopCore() {
  if (!appState.isCollecting) return;
  appState.isCollecting = false;
  if (
    appState.config.serialProtocol === "aresplot" &&
    serialService.isConnected()
  ) {
    console.log("Main: Stopping Aresplot monitoring.");
    const emptySymbols = [];
    const frame = aresplotProtocol.buildStartMonitorFrame(emptySymbols); // NumVars = 0
    serialService
      .write(frame)
      .catch((e) => console.error("Error sending stop monitor cmd:", e));
  }
  await workerService.stopWorker();
  dataProcessor.resetEstimatesAndRate();
  appState.mainThreadDataQueue = [];
  uiManager.updateStatus("状态：已停止");
  uiManager.updateButtonStates(getButtonState());
  uiManager.updateBufferUI(getBufferStats());
  console.log("Core: Collection stopped.");
}

// --- Main Data Processing Loop ---
function mainLoop() {
  const batch = appState.mainThreadDataQueue.splice(
    0,
    appState.mainThreadDataQueue.length
  );
  if (batch.length > 0) {
    displayModules.forEach((m) => {
      try {
        m.processDataBatch(batch);
      } catch (e) {}
    });
    const lastTs = batch[batch.length - 1]?.timestamp || performance.now();
    dataProcessor.updateDataRate(batch.length, lastTs);
    dataProcessor.addToBuffer(batch);
    dataProcessor.trimDataBuffer(appState.config.maxBufferPoints);
  }
  if (appState.isCollecting || batch.length > 0) {
    dataProcessor.calculateBufferEstimate(
      dataProcessor.getCurrentDataRate(),
      dataProcessor.getBufferLength(),
      appState.config.maxBufferPoints,
      appState.isCollecting
    );
    uiManager.updateBufferUI(getBufferStats());
  }
  appState.rAFID = requestAnimationFrame(mainLoop);
}

// --- Helper Functions ---
function getBufferStats() {
  return {
    currentPoints: dataProcessor.getBufferLength(),
    maxPoints: appState.config.maxBufferPoints,
    collecting: appState.isCollecting,
    estimateRemainingSec: dataProcessor.getEstimateRemaining(),
    estimateTotalSec: dataProcessor.getEstimateTotal(),
  };
}
function getButtonState() {
  return {
    isCollecting: appState.isCollecting,
    isSerialConnected: serialService.isConnected(),
    serialProtocol: appState.config.serialProtocol,
    dataBufferHasData: dataProcessor.getBufferLength() > 0,
    dataSource: appState.config.dataSource,
  };
}

/** Reads current config from UI and updates appState.config */
function syncConfigFromUI() {
  const uiConfig = uiManager.getCurrentConfigFromUI();
  if (uiConfig) {
    appState.config = { ...appState.config, ...uiConfig };
  } else {
    console.error("Core: Failed to get current config from UI Manager!");
  }
}

// --- Global Cleanup ---
window.addEventListener("beforeunload", () => {
  displayModules.forEach((m) => {
    try {
      if (typeof m.destroy === "function") m.destroy();
    } catch (e) {}
  });
  workerService.terminate();
  if (serialService.isConnected()) serialService.disconnect();
});

// --- Start Application ---
document.addEventListener("DOMContentLoaded", initializeApp);
