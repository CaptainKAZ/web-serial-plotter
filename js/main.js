// js/main.js - Main Application Entry Point (Refactored for Module Interface)

import {
    DEFAULT_MAX_BUFFER_POINTS, MIN_BUFFER_POINTS,
    DEFAULT_SIM_CHANNELS, DEFAULT_SIM_FREQUENCY, DEFAULT_SIM_AMPLITUDE
} from './config.js';
import { debounce } from './utils.js';
import {
    loadAllPartials, setupEventListeners as setupUIEventListeners, updateControlVisibility,
    initializeSplitLayout, setupResizeObserver,
    updateStatusMessage,
    updateBufferStatusUI,
    updateParserVisibility // 导入新的函数
} from './modules/ui.js';

import * as plotModule from './modules/plot_module.js';
import * as terminalModule from './modules/terminal_module.js';
import * as quatModule from './modules/quat_module.js';
import * as dataProcessor from './modules/data_processing.js';
import { connectSerial, disconnectSerial, updateSerialParser, handleSerialDisconnectCleanup } from './modules/serial.js';
import { setupWorkerListeners } from './modules/worker_comms.js';

const appState = {
    isCollecting: false,
    dataWorker: null,
    workerUrl: null,
    mainThreadDataQueue: [],
    serialPort: null,
    config: {
        currentDataSource: 'simulated',
        numChannels: DEFAULT_SIM_CHANNELS,
        maxBufferPoints: DEFAULT_MAX_BUFFER_POINTS,
        followData: true,
        rawDisplayMode: 'str',
        simFrequency: DEFAULT_SIM_FREQUENCY,
        simAmplitude: DEFAULT_SIM_AMPLITUDE,
        serialProtocol: 'default' // 新增：默认协议
    },
    rAFID: null,
    domElements: {},
    stopDataCollectionFn: null,
    updateButtonStatesFn: null,
};
appState.stopDataCollectionFn = () => stopDataCollection();
appState.updateButtonStatesFn = () => updateButtonStatesMain();

const displayModules = [plotModule, terminalModule, quatModule];

function queryDOMElements() {
    const get = (id) => document.getElementById(id);
    appState.domElements = {
        controlPanel: get('control-panel'), dataSourceSelect: get('dataSourceSelect'),
        startStopButton: get('startStopButton'), statusMessage: get('statusMessage'),
        workerStatusDisplay: get('workerStatusDisplay'), simulatedControls: get('simulatedControls'),
        webSerialControls: get('webSerialControls'), serialOptionsDiv: get('serialOptions'), // 正确获取
        simNumChannelsInput: get('simNumChannels'), simFrequencyInput: get('simFrequency'),
        simAmplitudeInput: get('simAmplitude'), connectSerialButton: get('connectSerialButton'),
        baudRateInput: get('baudRateInput'), dataBitsSelect: get('dataBitsSelect'),
        stopBitsSelect: get('stopBitsSelect'), paritySelect: get('paritySelect'),
        flowControlSelect: get('flowControlSelect'),
        serialProtocolSelect: get('serialProtocolSelect'), // 新增: 协议选择框
        customParserSection: get('customParserSection'),   // 新增: 自定义部分
        serialParserTextarea: get('serialParser'),         // 自定义文本框
        updateParserButton: get('updateParserButton'),     // 更新按钮
        parserStatus: get('parserStatus'),                 // 自定义状态
        builtInParserStatus: get('builtInParserStatus'),   // 新增: 内置状态
        bufferDurationInput: get('bufferDurationInput'), bufferUsageBar: get('bufferUsageBar'),
        bufferStatus: get('bufferStatus'), downloadCsvButton: get('downloadCsvButton'),
        clearDataButton: get('clearDataButton'), displayAreaContainer: get('displayAreaContainer'),
        displayArea: get('displayArea'), bottomRow: get('bottomRow'),
        // Get references to the placeholder divs from index.html
        plotModulePlaceholder: get('plotModule'),
        textModulePlaceholder: get('textModule'),
        quatModulePlaceholder: get('quatModule'),
        // Get reference to the container for quat module (if needed elsewhere, though likely not)
        quatModuleContainer: get('quatModuleContainer'), // Might still be useful if returned by loadPartials
    };
    console.log("DOM elements queried.");
}

async function initializeApp() {
    console.log("Initializing application...");
    updateStatusMessage("Status: Initializing...");

    try {
        const loaded = await loadAllPartials();
        if (!loaded || !loaded.controlPanel || !loaded.plotModule || !loaded.textModule || !loaded.quatModule) {
            throw new Error("Essential containers failed load.");
        }
        console.log("HTML partials loaded.");
    } catch (error) {
        console.error("Partial loading failed.", error);
        updateStatusMessage("Error: Failed to load UI. Please refresh.");
        return;
    }
    queryDOMElements(); // 获取所有元素

    try {
        if (!appState.dataWorker && !appState.workerUrl) {
            const workerResponse = await fetch('js/worker/data_worker.js');
            if (!workerResponse.ok) throw new Error(`Failed to fetch worker script: ${workerResponse.statusText}`);
            const workerCode = await workerResponse.text();
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            appState.workerUrl = URL.createObjectURL(blob);
            appState.dataWorker = new Worker(appState.workerUrl);
            console.log("Data worker created.");
        }
        setupWorkerListeners(appState.dataWorker, appState, stopDataCollection);
    } catch (error) {
        console.error("Worker Initialization Error:", error);
        updateStatusMessage(`Error: Worker initialization failed - ${error.message}`);
        if (appState.domElements.startStopButton) appState.domElements.startStopButton.disabled = true;
        if (appState.domElements.connectSerialButton) appState.domElements.connectSerialButton.disabled = true;
        return;
    }

    // 初始化配置
    appState.config.currentDataSource = appState.domElements.dataSourceSelect?.value || 'simulated';
    appState.config.serialProtocol = appState.domElements.serialProtocolSelect?.value || 'default'; // 初始化协议
    appState.config.maxBufferPoints = parseInt(appState.domElements.bufferDurationInput?.value || DEFAULT_MAX_BUFFER_POINTS);
    appState.config.followData = document.getElementById('followToggle')?.checked ?? true;
    appState.config.rawDisplayMode = document.getElementById('rawStrBtn')?.classList.contains('active') ? 'str' : 'hex';
    appState.config.numChannels = parseInt(appState.domElements.simNumChannelsInput?.value || DEFAULT_SIM_CHANNELS);
    appState.config.simFrequency = parseInt(appState.domElements.simFrequencyInput?.value || DEFAULT_SIM_FREQUENCY);
    appState.config.simAmplitude = parseFloat(appState.domElements.simAmplitudeInput?.value || DEFAULT_SIM_AMPLITUDE);

    // 设置解析器文本框的占位符
    if (appState.domElements.serialParserTextarea) {
        appState.domElements.serialParserTextarea.value = `/**
 * @param {Uint8Array} uint8ArrayData - Raw data bytes from serial port.
 * @returns {{values: number[] | null, frameByteLength: number}}
 * - values: Array of parsed numbers, or null if no complete frame found.
 * - frameByteLength: Number of bytes consumed from the start of uint8ArrayData.
 */
// Example: Default comma/space separated lines parser
const newlineIndex = uint8ArrayData.indexOf(0x0A); // Find newline
if (newlineIndex !== -1) {
    const lineBytes = uint8ArrayData.slice(0, newlineIndex);
    try {
        const textDecoder = new TextDecoder(); // Default UTF-8
        const lineString = textDecoder.decode(lineBytes);
        const parsedValues = lineString.trim().split(/\\s*,\\s*|\\s+/).map(Number).filter(n => !isNaN(n));
        return { values: parsedValues, frameByteLength: newlineIndex + 1 }; // Consume line + newline
    } catch (e) {
        // Handle decoding error, maybe return empty values but consume line
        return { values: [], frameByteLength: newlineIndex + 1 };
    }
}
// No complete frame (newline) found yet
return { values: null, frameByteLength: 0 };
`;
    }

    // 创建显示模块
    displayModules.forEach(module => {
        try {
            let elementId = ''; let initialState = {};
            if (module === plotModule) {
                elementId = 'plotModule';
                initialState = { follow: appState.config.followData, numChannels: appState.config.numChannels, maxBufferPoints: appState.config.maxBufferPoints };
            } else if (module === terminalModule) {
                elementId = 'textModule';
                initialState = { rawDisplayMode: appState.config.rawDisplayMode, updateDivider: 3 };
            } else if (module === quatModule) {
                elementId = 'quatModuleContainer';
                initialState = { availableChannels: appState.config.numChannels };
            }
            if (elementId && document.getElementById(elementId)) { module.create(elementId, initialState); }
            else { console.error(`Cannot create module, target element ID "${elementId}" not found.`); }
        } catch (error) { console.error("Error creating module instance:", error); }
    });

    // 设置UI可见性和事件监听器
    updateControlVisibility(appState.config.currentDataSource); // 这会调用 updateParserVisibility
    updateButtonStatesMain(); // 更新按钮状态
    setupUIEventListeners({
        handleDataSourceChange, handleStartStop, handleConnectSerial, handleUpdateParser,
        handleBufferDurationChange, handleDownloadCsv, handleClearData,
        handleSimChannelChange, handleSimFrequencyChange, handleSimAmplitudeChange,
        handleProtocolChange // 新增协议处理器
    });

    // 设置布局和大小调整
    const mainResizeHandler = () => {
        displayModules.forEach(module => { try { module.resize(); } catch (e) { /* ignore */ } });
    };
    const debouncedResizeHandler = debounce(mainResizeHandler, 150);
    initializeSplitLayout({
        plotElement: appState.domElements.plotModulePlaceholder,
        bottomRowElement: appState.domElements.bottomRow,
        textElement: appState.domElements.textModulePlaceholder,
        quatElement: appState.domElements.quatModulePlaceholder
    }, debouncedResizeHandler);
    setupResizeObserver(debouncedResizeHandler);
    window.addEventListener('resize', debouncedResizeHandler);
    mainResizeHandler(); // 初始调整

    // --- Register Service Worker ---
    if ('serviceWorker' in navigator) {
        // 使用 window.load 事件确保页面及其所有资源（如图标）加载完毕后再注册
        // 这可以避免 Service Worker 缓存不完整的资源
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js') // 注册根目录下的 sw.js
                .then((registration) => {
                    console.log('[Main] Service Worker registered successfully with scope:', registration.scope);
                })
                .catch((error) => {
                    console.error('[Main] Service Worker registration failed:', error);
                });
        });
    } else {
        console.warn('[Main] Service Worker not supported in this browser.');
    }
    // --- End Service Worker Registration ---

    // 启动主循环
    if (!appState.rAFID) {
        appState.rAFID = requestAnimationFrame(mainLoop);
    }

    updateStatusMessage("Status: Initialization complete. Ready.");
    console.log("Application initialized.");
}

function mainLoop() {
    const batch = appState.mainThreadDataQueue.splice(0, appState.mainThreadDataQueue.length);

    if (batch.length > 0) {
        displayModules.forEach(module => {
            try { module.processDataBatch(batch); }
            catch (error) { console.error("Error processing batch in module:", error); }
        });

        const latestTimestamp = batch[batch.length - 1]?.timestamp || performance.now();
        dataProcessor.updateDataRate(batch.length, latestTimestamp);
        dataProcessor.addToBuffer(batch);
        dataProcessor.trimDataBuffer(appState.config.maxBufferPoints);
        dataProcessor.calculateBufferEstimate(
            dataProcessor.getCurrentDataRate(), dataProcessor.getBufferLength(),
            appState.config.maxBufferPoints, appState.isCollecting
        );

        updateBufferStatusUI(
            dataProcessor.getBufferLength(), appState.config.maxBufferPoints,
            appState.isCollecting, dataProcessor.getEstimateRemaining(), dataProcessor.getEstimateTotal()
        );
    }

    appState.rAFID = requestAnimationFrame(mainLoop);
}

function startDataCollection() {
    if (appState.isCollecting || !appState.dataWorker) return;
    const isSerial = appState.config.currentDataSource === 'webserial';
    const canStartSerial = isSerial && appState.serialPort !== null;
    const currentSimChannels = parseInt(appState.domElements.simNumChannelsInput?.value || DEFAULT_SIM_CHANNELS);
    if (appState.config.currentDataSource === 'simulated' && appState.config.numChannels !== currentSimChannels) {
        handleSimChannelChange({ target: { value: currentSimChannels } });
    }
    if (isSerial && !canStartSerial) { updateStatusMessage("状态：错误 - 请先连接串口"); return; }

    appState.isCollecting = true;
    appState.mainThreadDataQueue = [];
    dataProcessor.resetEstimatesAndRate();
    updateStatusMessage("状态：采集中 (Worker)...");
    updateButtonStatesMain();

    const startPayload = {
        source: appState.config.currentDataSource,
        config: {},
        protocol: appState.config.serialProtocol, // 发送选定的协议
        parserCode: '' // 默认为空
    };

    if (appState.config.currentDataSource === 'simulated') {
        startPayload.config = { numChannels: appState.config.numChannels, frequency: appState.config.simFrequency, amplitude: appState.config.simAmplitude };
        appState.dataWorker.postMessage({ type: 'start', payload: startPayload });
    } else if (canStartSerial) {
        // 如果协议是 'custom'，则发送文本框内容
        if (appState.config.serialProtocol === 'custom' && appState.domElements.serialParserTextarea) {
            startPayload.parserCode = appState.domElements.serialParserTextarea.value || '';
        }
        // 否则，parserCode 保持为空，Worker 将根据 protocol 字段选择内部实现

        try {
            startPayload.port = appState.serialPort;
            appState.dataWorker.postMessage({ type: 'start', payload: startPayload }, [appState.serialPort]);
            appState.serialPort = null; // 清除主线程引用
        } catch (transferError) {
            console.error("Main: Error transferring SerialPort:", transferError);
            updateStatusMessage(`状态：传输端口到 Worker 失败: ${transferError.message}`);
            appState.isCollecting = false; if (appState.serialPort) disconnectSerial(appState); updateButtonStatesMain(); return;
        }
    }
    console.log("Data collection active...");
}

function stopDataCollection() {
    if (!appState.isCollecting) return;
    console.warn("MAIN THREAD: Stopping data collection...");
    appState.isCollecting = false;
    if (appState.dataWorker) appState.dataWorker.postMessage({ type: 'stop' });
    dataProcessor.resetEstimatesAndRate();
    mainLoop(); // Process final data
    updateStatusMessage("状态：已停止");
    if (appState.config.currentDataSource === 'webserial') {
        handleSerialDisconnectCleanup(appState);
    } else { updateButtonStatesMain(); }
    updateBufferStatusUI(dataProcessor.getBufferLength(), appState.config.maxBufferPoints, false, null, null);
    console.warn("MAIN THREAD: Collection stopped.");
}

// --- Event Handlers ---
function handleDataSourceChange(event) {
    const newSource = event.target.value; if (appState.isCollecting) stopDataCollection();
    appState.config.currentDataSource = newSource; updateControlVisibility(newSource); updateButtonStatesMain();
}
function handleStartStop() { if (appState.isCollecting) stopDataCollection(); else startDataCollection(); }
async function handleConnectSerial() { if (appState.serialPort) await disconnectSerial(appState); else await connectSerial(appState); }
function handleUpdateParser() {
    if (appState.config.serialProtocol === 'custom') {
        updateSerialParser(appState);
    } else {
        console.warn("Update Parser ignored: Not in 'custom' protocol mode.");
        if (appState.domElements.parserStatus) {
            if (appState.domElements.builtInParserStatus) {
                appState.domElements.builtInParserStatus.textContent = '状态：请先选择 "自定义" 协议再更新';
                appState.domElements.builtInParserStatus.classList.add('text-red-600');
            }
        }
    }
}

function handleProtocolChange(event) {
    const newProtocol = event.target.value;
    if (appState.config.serialProtocol !== newProtocol) {
        appState.config.serialProtocol = newProtocol;
        console.log("Serial protocol changed to:", newProtocol);
        updateParserVisibility();
        if (appState.isCollecting) {
            console.warn("Protocol changed while collecting. Stopping collection. Restart to apply.");
            stopDataCollection();
        }
        updateButtonStatesMain();
    }
}


function handleBufferDurationChange(event) {
    const v = parseInt(event.target.value); const maxPointsInput = appState.domElements.bufferDurationInput;
    if (v && v >= MIN_BUFFER_POINTS) {
        if (appState.config.maxBufferPoints !== v) {
            appState.config.maxBufferPoints = v;
            displayModules.forEach(m => { if (m.updateConfig) m.updateConfig({ maxBufferPoints: v }); });
            dataProcessor.calculateBufferEstimate(dataProcessor.getCurrentDataRate(), dataProcessor.getBufferLength(), v, appState.isCollecting);
            updateBufferStatusUI(dataProcessor.getBufferLength(), v, appState.isCollecting, dataProcessor.getEstimateRemaining(), dataProcessor.getEstimateTotal());
        }
    } else { alert(`Buffer points must be >= ${MIN_BUFFER_POINTS}.`); if (maxPointsInput) maxPointsInput.value = appState.config.maxBufferPoints; }
}

function handleDownloadCsv() {
    const plotInstance = displayModules.find(m => m === plotModule);
    const seriesInfo = plotInstance?.chartInstance?.options?.series; // Access internal instance if needed
    dataProcessor.downloadCSV(seriesInfo);
}

function handleClearData() {
    if (appState.isCollecting) stopDataCollection();
    displayModules.forEach(module => {
        try {
            console.log("Clearing module", module);
            module.clear();
        } catch (e) { console.warn("Error clearing module", e); }
    });
    console.log("Clearing data processor...");
    dataProcessor.clearBuffer();
    console.log("Clearing estimate...");
    dataProcessor.resetEstimatesAndRate();
    console.log("Clearing UI...");
    updateBufferStatusUI(0, appState.config.maxBufferPoints, false, null, null);
    console.log("Clearing status...");
    updateButtonStatesMain();
}

function handleSimChannelChange(event) {
    const newChannelCount = parseInt(event.target.value) || DEFAULT_SIM_CHANNELS;
    if (appState.config.numChannels !== newChannelCount) {
        appState.config.numChannels = newChannelCount;
        appState.config.simFrequency = parseInt(appState.domElements.simFrequencyInput?.value || DEFAULT_SIM_FREQUENCY);
        appState.config.simAmplitude = parseFloat(appState.domElements.simAmplitudeInput?.value || DEFAULT_SIM_AMPLITUDE);
        if (appState.isCollecting && appState.config.currentDataSource === 'simulated' && appState.dataWorker) {
            appState.dataWorker.postMessage({ type: 'updateSimConfig', payload: { numChannels: appState.config.numChannels, frequency: appState.config.simFrequency, amplitude: appState.config.simAmplitude } });
        }
        displayModules.forEach(m => { if (m.updateConfig) m.updateConfig({ availableChannels: newChannelCount, numChannels: newChannelCount }); });
        updateButtonStatesMain();
    }
}
function handleSimFrequencyChange(event) {
    const newFrequency = parseInt(event.target.value) || DEFAULT_SIM_FREQUENCY; if (appState.config.simFrequency !== newFrequency) {
        appState.config.simFrequency = newFrequency; if (appState.isCollecting && appState.config.currentDataSource === 'simulated' && appState.dataWorker) {
            appState.dataWorker.postMessage({ type: 'updateSimConfig', payload: { numChannels: appState.config.numChannels, frequency: appState.config.simFrequency, amplitude: appState.config.simAmplitude } });
        }
    }
}
function handleSimAmplitudeChange(event) {
    const newAmplitude = parseFloat(event.target.value) || DEFAULT_SIM_AMPLITUDE; if (appState.config.simAmplitude !== newAmplitude) {
        appState.config.simAmplitude = newAmplitude; if (appState.isCollecting && appState.config.currentDataSource === 'simulated' && appState.dataWorker) {
            appState.dataWorker.postMessage({ type: 'updateSimConfig', payload: { numChannels: appState.config.numChannels, frequency: appState.config.simFrequency, amplitude: appState.config.simAmplitude } });
        }
    }
}

// --- Helper: Update Button States ---
function updateButtonStatesMain() {
    const { isCollecting, config, serialPort } = appState;
    const { currentDataSource, serialProtocol } = config;
    const domElements = appState.domElements; // 使用存储的引用

    if (!domElements || Object.keys(domElements).length === 0) return;
    const isSerial = currentDataSource === 'webserial';
    const isSerialConnectedOnMain = isSerial && serialPort !== null;
    const dataBufferHasData = dataProcessor.getBufferLength() > 0;

    // Start/Stop Button
    if (domElements.startStopButton) {
        if (isCollecting) {
            domElements.startStopButton.textContent = "结束采集";
            domElements.startStopButton.disabled = false;
            domElements.startStopButton.className = 'w-full mb-2 bg-red-500 hover:bg-red-600';
        } else {
            domElements.startStopButton.textContent = "开始采集";
            domElements.startStopButton.className = 'w-full mb-2 bg-blue-500 hover:bg-blue-600';
            domElements.startStopButton.disabled = (isSerial && !isSerialConnectedOnMain); // 串口模式下未连接则禁用开始
        }
    }

    // Connect/Disconnect Button
    if (domElements.connectSerialButton) {
        domElements.connectSerialButton.disabled = !isSerial || isCollecting; // 非串口模式或采集中禁用
        if (serialPort) { // 主线程持有端口引用（已连接未传输）
            domElements.connectSerialButton.textContent = "断开串口";
            domElements.connectSerialButton.className = 'w-full bg-yellow-500 hover:bg-yellow-600';
        } else { // 未连接或已传输给 Worker
            domElements.connectSerialButton.textContent = "连接串口";
            domElements.connectSerialButton.className = 'w-full bg-blue-500 hover:bg-blue-600';
        }
    }

    // Serial Options Container (使用正确的变量名 domElements.serialOptionsDiv)
    if (domElements.serialOptionsDiv) {
        const disableSerialOptions = !isSerial || isCollecting || isSerialConnectedOnMain; // 禁用条件

        // 禁用或启用波特率、数据位等基础选项
        domElements.serialOptionsDiv.querySelectorAll('input[type="number"], select:not(#serialProtocolSelect)').forEach(el => {
            el.disabled = disableSerialOptions;
        });

        // 单独处理协议选择框
        if (domElements.serialProtocolSelect) {
            domElements.serialProtocolSelect.disabled = isCollecting || isSerialConnectedOnMain; // 采集中或已连接时禁用协议切换
        }

        // 单独处理自定义解析器部分
        const disableCustomParser = disableSerialOptions || serialProtocol !== 'custom';
        if (domElements.serialParserTextarea) {
            domElements.serialParserTextarea.disabled = disableCustomParser;
        }
        if (domElements.updateParserButton) {
            domElements.updateParserButton.disabled = disableCustomParser;
        }
    } else {
        console.warn("updateButtonStatesMain: domElements.serialOptionsDiv not found!"); // 添加警告
    }


    // Download/Clear Buttons
    if (domElements.downloadCsvButton) domElements.downloadCsvButton.disabled = !dataBufferHasData;
    if (domElements.clearDataButton) domElements.clearDataButton.disabled = !dataBufferHasData && !isCollecting; // 仅在有数据或采集中时启用清除
}


// --- Global Cleanup ---
window.addEventListener('beforeunload', () => {
    console.log("Page unloading. Cleaning up...");
    displayModules.forEach(module => { try { module.destroy(); } catch (e) { console.error("Error destroying module", e); } });
    if (appState.dataWorker) appState.dataWorker.terminate();
    if (appState.workerUrl) URL.revokeObjectURL(appState.workerUrl);
    if (appState.serialPort) disconnectSerial(appState); // Attempt disconnect
});

// --- Start App ---
document.addEventListener('DOMContentLoaded', initializeApp);