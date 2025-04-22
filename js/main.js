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

  console.log(
    `Core: Initial State Applied - Source: ${appState.config.dataSource}`
  );

  setupAppEventListeners(); // Setup core listeners AFTER initial state sync

  // Update Initial UI State based on synced config
  uiManager.updateControlVisibility(appState.config.dataSource);
  uiManager.updateButtonStates(getButtonState());
  uiManager.updateParserVisibility(appState.config.serialProtocol);
  uiManager.updateBufferUI(getBufferStats());

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
  eventBus.on("worker:status", handleWorkerStatus);
  eventBus.on("worker:error", handleWorkerError);
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
          numChannels: targetChannelCount
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
  if (serialService.isConnected() && !appState.isCollecting)
    workerService.updateParser(protocol, code);
  else if (appState.isCollecting)
    uiManager.updateStatus("警告：协议已更改，请停止并重新开始采集。");
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
  displayModules.forEach((m) => {
    if (m.updateConfig)
      m.updateConfig({
        numChannels: simConfig.numChannels,
      });
  });
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
  if (Array.isArray(batch) && batch.length > 0)
    Array.prototype.push.apply(appState.mainThreadDataQueue, batch);
}
function handleWorkerStatus(event) {
  const payload = event.detail;
  if (payload && typeof payload === "string") {
    if (payload.toLowerCase().includes("parser")) {
      const isErr =
        payload.toLowerCase().includes("invalid") ||
        payload.toLowerCase().includes("failed");
      uiManager.showParserStatus(payload, isErr);
    } else {
      uiManager.showWorkerStatus(payload, false);
    }
  } else {
    uiManager.showWorkerStatus(String(payload), false);
  }
}
function handleWorkerError(event) {
  const error = event.detail;
  console.error("Core: Worker Error event:", error);
  if (appState.isCollecting) stopCore();
  uiManager.showWorkerStatus(
    `Worker 错误: ${error.message || String(error)}`,
    true
  );
  uiManager.updateButtonStates(getButtonState());
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

  console.log("Core: Collection started.");
  uiManager.updateButtonStates(getButtonState());
  dataProcessor.resetEstimatesAndRate();
  uiManager.updateBufferUI(getBufferStats());
}
function stopCore() {
  if (!appState.isCollecting) return;
  appState.isCollecting = false;
  workerService.stopWorker();
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
