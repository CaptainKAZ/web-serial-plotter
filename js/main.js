// js/main.js - Main Application Entry Point (Refactored for Module Interface)

import {
    DEFAULT_MAX_BUFFER_POINTS, MIN_BUFFER_POINTS,
    DEFAULT_SIM_CHANNELS, DEFAULT_SIM_FREQUENCY, DEFAULT_SIM_AMPLITUDE, DEFAULT_BAUD_RATE
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
import { connectSerial, disconnectSerial, updateSerialParser } from './modules/serial.js';
import { setupWorkerListeners } from './modules/worker_comms.js';

const appState = {
    isCollecting: false,
    dataWorker: null,
    workerUrl: null,
    mainThreadDataQueue: [],
    serialPort: null,
    lastValidBaudRate: String(DEFAULT_BAUD_RATE), // 存储上一个有效的波特率（字符串形式）
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
        baudRateInput: get('baudRateInput'),
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
    appState.lastValidBaudRate = appState.domElements.baudRateInput?.value || String(DEFAULT_BAUD_RATE);


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
                initialState = { rawDisplayMode: appState.config.rawDisplayMode };
            } else if (module === quatModule) {
                elementId = 'quatModuleContainer';
                initialState = { availableChannels: appState.config.numChannels };
            }
            if (elementId && document.getElementById(elementId)) { module.create(elementId, initialState); }
            else { console.error(`Cannot create module, target element ID "${elementId}" not found.`); }
        } catch (error) { console.error("Error creating module instance:", error); }
    });

    // --- Baud Rate Input 的 focus 和 blur 事件监听 ---
    if (appState.domElements.baudRateInput) {
        const baudRateInput = appState.domElements.baudRateInput;

        // 获得焦点时清空
        baudRateInput.addEventListener('focus', (event) => {
            // 存储当前有效值（如果它不是空的）
            const currentValue = event.target.value;
            if (currentValue) {
                const numericValue = parseInt(currentValue);
                if (!isNaN(numericValue) && numericValue > 0) {
                    appState.lastValidBaudRate = currentValue;
                }
            }
            // 清空输入框
            event.target.value = '';
            console.log("Baud rate input focused, cleared. Last valid:", appState.lastValidBaudRate);
        });

        // 失去焦点时检查并恢复
        baudRateInput.addEventListener('blur', (event) => {
            const currentValue = event.target.value;
            const numericValue = parseInt(currentValue);

            if (!currentValue || isNaN(numericValue) || numericValue <= 0) {
                // 如果当前值为空或无效，恢复上一个有效值
                console.log(`Baud rate input blurred empty/invalid, restoring: ${appState.lastValidBaudRate}`);
                event.target.value = appState.lastValidBaudRate;
            } else {
                // 如果当前值有效，则更新 lastValidBaudRate
                appState.lastValidBaudRate = currentValue;
                console.log(`Baud rate input blurred with valid value: ${currentValue}`);
            }
        });
        console.log("Baud rate input focus/blur listeners added.");
    }
    // --- 结束 Baud Rate Input 事件监听 ---

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

/**
 * Starts data collection. For WebSerial, attempts to transfer the
 * ReadableStream from the SerialPort to the worker.
 */
async function startDataCollection() { // Added async for potential future await (like getInfo)
    // --- 1. Pre-checks ---
    if (appState.isCollecting || !appState.dataWorker) {
        console.warn("Main: startDataCollection called but already collecting or worker not ready. Aborting.");
        return;
    }
    const isSerial = appState.config.currentDataSource === 'webserial';
    const canStartSerial = isSerial && appState.serialPort !== null;

    // --- 1a. Check/Update Simulation Channel Config ---
    const currentSimChannels = parseInt(appState.domElements.simNumChannelsInput?.value || DEFAULT_SIM_CHANNELS);
    if (appState.config.currentDataSource === 'simulated' && appState.config.numChannels !== currentSimChannels) {
        console.log("Main: Sim channel count changed, applying update before starting simulation...");
        handleSimChannelChange({ target: { value: currentSimChannels } });
    }

    // --- 1b. Check if WebSerial can start ---
    if (isSerial && !canStartSerial) {
        console.error("Main: Cannot start WebSerial collection, appState.serialPort is null.");
        updateStatusMessage("状态：错误 - 请先连接串口");
        return;
    }

    // --- 2. Set State and Update UI ---
    console.log("Main: Starting data collection process...");
    appState.isCollecting = true;
    appState.mainThreadDataQueue = [];
    dataProcessor.resetEstimatesAndRate();
    updateStatusMessage("状态：采集中 (Worker)...");
    updateButtonStatesMain();

    // --- 3. Prepare Payload for Worker ---
    // Common payload structure
    const workerPayload = {
        source: appState.config.currentDataSource,
        config: {}, // Specific config added below
        protocol: appState.config.serialProtocol,
        parserCode: '' // Only relevant for custom serial protocol
    };

    // --- 4. Send 'start' message to Worker ---
    if (appState.config.currentDataSource === 'simulated') {
        // --- 4a. Simulation Start ---
        workerPayload.config = {
            numChannels: appState.config.numChannels,
            frequency: appState.config.simFrequency,
            amplitude: appState.config.simAmplitude
        };
        console.log("Main: Sending 'start' command to worker for SIMULATED data:", workerPayload);
        try {
            // No transfer needed for simulation
            appState.dataWorker.postMessage({ type: 'start', payload: workerPayload });
        } catch (postError) {
            console.error("Main: Error posting 'start' message for simulation:", postError);
            updateStatusMessage(`状态：启动模拟失败: ${postError.message}`);
            appState.isCollecting = false;
            updateButtonStatesMain();
            return;
        }

    } else if (canStartSerial) {
        // --- 4b. WebSerial Start (Attempt ReadableStream Transfer) ---

        // Include custom parser code if selected
        if (appState.config.serialProtocol === 'custom' && appState.domElements.serialParserTextarea) {
            workerPayload.parserCode = appState.domElements.serialParserTextarea.value || '';
            console.log("Main: Including custom parser code in payload.");
        } else {
            console.log(`Main: Using built-in parser logic in worker for protocol: ${appState.config.serialProtocol}`);
        }

        // --- Get the ReadableStream ---
        const readableStream = appState.serialPort.readable;

        // --- Validate the Stream ---
        if (!readableStream) {
            console.error("Main: FATAL - appState.serialPort.readable is null or undefined! Cannot transfer stream.");
            updateStatusMessage("状态：错误 - 无法获取串口读取流");
            appState.isCollecting = false;
            disconnectSerial(appState); // Clean up the port
            updateButtonStatesMain();
            return;
        }
        console.log("Main: Obtained ReadableStream:", readableStream);
        // Note: Checking readableStream.locked here might be misleading, transfer handles ownership.

        // --- Add Stream to Payload (using a different property name) ---
        workerPayload.readableStream = readableStream; // Add the stream to the payload

        // Log payload structure (omitting stream details)
        console.log("Main: Payload prepared for stream transfer:", { ...workerPayload, readableStream: '[ReadableStream Object]' });

        // --- Attempt the postMessage with stream transfer ---
        try {
            console.log("Main: Executing postMessage with ReadableStream transfer...");
            // Use a distinct message type, e.g., 'startSerialStream'
            // Transfer ONLY the readableStream
            appState.dataWorker.postMessage({ type: 'startSerialStream', payload: workerPayload }, [readableStream]);

            // If the above line succeeds without throwing:
            console.log("%cMain: postMessage successful (ReadableStream transfer initiated). Main thread retains SerialPort object for closing.", "color: green;");
            // DO NOT set appState.serialPort = null here. The main thread still needs it to close the port later.
            // The 'readable' property of the main thread's port object is now likely unusable as ownership transferred.

        } catch (transferError) {
            // --- Handle errors during the stream transfer ---
            console.error("%cMain: Error occurred during postMessage stream transfer!", "color: red; font-weight: bold;", transferError);
            console.error("Main: Error Name:", transferError.name);
            console.error("Main: Error Message:", transferError.message);
            console.error("Main: Payload that failed (stream omitted):", { ...workerPayload, readableStream: '[ReadableStream Object]' });
            console.error("Main: The ReadableStream object that failed transfer:", workerPayload.readableStream);
            if (transferError.stack) {
                console.error("Main: Error Stack Trace:", transferError.stack);
            }

            // --- Reset state and handle cleanup ---
            updateStatusMessage(`状态：传输读取流到 Worker 失败: ${transferError.message}`);
            appState.isCollecting = false; // Collection failed

            // Main thread still holds the port reference if stream transfer failed. Clean it up.
            if (appState.serialPort) {
                console.warn("Main: Stream transfer failed. Disconnecting/cleaning up the port held by main thread.");
                disconnectSerial(appState);
            } else {
                console.warn("Main: Stream transfer failed, but appState.serialPort was unexpectedly null.");
                updateButtonStatesMain(); // Still update UI state
            }
            return; // Stop execution
        }
    } // End of WebSerial start logic

    // --- 5. Final Log if Start Seems Successful ---
    console.log("Main: Data collection start initiated. Worker should be processing...");

} // --- End of startDataCollection ---
function stopDataCollection() {
    if (!appState.isCollecting) return;
    console.warn("MAIN THREAD: Stopping data collection...");
    appState.isCollecting = false;
    if (appState.dataWorker) appState.dataWorker.postMessage({ type: 'stop' });
    dataProcessor.resetEstimatesAndRate();
    mainLoop(); // Process final data
    updateStatusMessage("状态：已停止");
    if (appState.config.currentDataSource === 'webserial') {
        appState.serialPort.close()
        // handleSerialDisconnectCleanup(appState);
    }
    updateButtonStatesMain();
    updateBufferStatusUI(dataProcessor.getBufferLength(), appState.config.maxBufferPoints, false, null, null);
    console.warn("MAIN THREAD: Collection stopped.");
}

// --- Event Handlers ---
function handleDataSourceChange(event) {
    const newSource = event.target.value; if (appState.isCollecting) stopDataCollection();
    appState.config.currentDataSource = newSource; updateControlVisibility(newSource); updateButtonStatesMain();
    handleClearData();
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

/**
 * Sends a message to the data worker to update its active serial parser.
 * @param {string} newProtocol - The new protocol name ('default', 'justfloat', 'custom', etc.).
 */
function sendParserUpdateToWorker(newProtocol) {
    if (!appState.dataWorker) {
        console.error("Cannot update worker parser: Worker not available.");
        updateStatusMessage("错误：无法更新 Worker 解析器。");
        return;
    }

    const payload = { protocol: newProtocol };
    if (newProtocol === 'custom') {
        payload.parserCode = appState.domElements.serialParserTextarea?.value || '';
        if (!payload.parserCode) {
            console.warn("Custom protocol selected, but parser code is empty.");
            // Optionally show a warning UI message
        }
    }

    console.log("Main: Sending 'updateActiveParser' to worker:", payload);
    updateStatusMessage("状态：正在更新 Worker 解析器..."); // Status: Updating worker parser...
    try {
        appState.dataWorker.postMessage({ type: 'updateActiveParser', payload });
    } catch (e) {
        console.error("Error sending updateActiveParser message:", e);
        updateStatusMessage("错误: 发送解析器更新失败。");
    }
}
function handleProtocolChange(event) {
    const newProtocol = event.target.value;
    if (appState.config.serialProtocol !== newProtocol) {
        appState.config.serialProtocol = newProtocol;
        console.log("Serial protocol changed to:", newProtocol);
        updateParserVisibility(); // 更新自定义部分可见性

        if (appState.isCollecting) {
            console.warn("协议在采集中被更改。建议停止并重新开始采集以确保解析一致性。正在尝试动态更新 Worker...");
            // 尝试动态更新 Worker（如果 Worker 支持）
            sendParserUpdateToWorker(newProtocol);
        } else if (appState.serialPort || (appState.config.currentDataSource === 'webserial' && !appState.serialPort /* Port transferred? */)) {
            // 已连接但未采集，更新 Worker
            console.log("协议在连接后、采集前更改。正在更新 Worker 解析器...");
            sendParserUpdateToWorker(newProtocol);
        } else {
            // 未连接，仅更新配置
            console.log("协议已更改，将在下次连接或启动时应用。");
        }

        updateButtonStatesMain(); // 更新按钮状态（例如自定义解析器按钮的禁用状态）
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
    const domElements = appState.domElements;

    if (!domElements || Object.keys(domElements).length === 0) {
        console.warn("updateButtonStatesMain called before DOM elements were queried.");
        return; // 防止在初始化早期出错
    }

    const isSerial = currentDataSource === 'webserial';
    // isSerialConnectedOnMain 表示主线程是否还持有端口引用（即已连接但未开始采集/传输）
    const isSerialConnectedOnMain = isSerial && serialPort !== null;
    // dataBufferHasData 表示 CSV 缓冲区是否有数据
    const dataBufferHasData = dataProcessor.getBufferLength() > 0;

    // Start/Stop Button
    if (domElements.startStopButton) {
        if (isCollecting) {
            domElements.startStopButton.textContent = "结束采集";
            domElements.startStopButton.disabled = false;
            domElements.startStopButton.className = 'w-full mb-2 bg-red-500 hover:bg-red-600 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-70';
        } else {
            domElements.startStopButton.textContent = "开始采集";
            domElements.startStopButton.className = 'w-full mb-2 bg-blue-500 hover:bg-blue-600 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-70';
            // 禁用条件：是串口模式但主线程未连接端口
            domElements.startStopButton.disabled = (isSerial && !isSerialConnectedOnMain);
        }
    }

    // Connect/Disconnect Button
    if (domElements.connectSerialButton) {
        // 禁用条件：不是串口模式，或者正在采集中
        domElements.connectSerialButton.disabled = !isSerial || isCollecting;
        if (serialPort) { // 主线程持有端口（已连接，未开始）
            domElements.connectSerialButton.textContent = "断开串口";
            domElements.connectSerialButton.className = 'w-full bg-yellow-500 hover:bg-yellow-600 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-70';
        } else { // 未连接，或端口已传输给 Worker
            domElements.connectSerialButton.textContent = "连接串口";
            domElements.connectSerialButton.className = 'w-full bg-blue-500 hover:bg-blue-600 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-70';
        }
    }

    // Serial Options Container
    if (domElements.serialOptionsDiv) {
        // 核心参数（波特率、数据位等）禁用条件：已连接（主线程持有或已传输）或正在采集
        const disableCoreSerialOptions = isSerialConnectedOnMain || isCollecting;

        // 禁用波特率选择
        if (domElements.baudRateInput) {
            domElements.baudRateInput.disabled = disableCoreSerialOptions;
        }
        // 禁用数据位、停止位、校验位、流控制
        domElements.serialOptionsDiv.querySelectorAll('#dataBitsSelect, #stopBitsSelect, #paritySelect, #flowControlSelect').forEach(el => {
            if (el) el.disabled = disableCoreSerialOptions;
        });


        // 协议选择框禁用条件：仅在采集中禁用
        if (domElements.serialProtocolSelect) {
            domElements.serialProtocolSelect.disabled = isCollecting;
        }

        // 自定义解析器相关控件禁用条件：采集中，或者协议不是 'custom'
        const disableCustomParserInputs = isCollecting || serialProtocol !== 'custom';
        if (domElements.serialParserTextarea) {
            domElements.serialParserTextarea.disabled = disableCustomParserInputs;
        }
        if (domElements.updateParserButton) {
            domElements.updateParserButton.disabled = disableCustomParserInputs;
        }
    } else {
        console.warn("updateButtonStatesMain: domElements.serialOptionsDiv not found!");
    }

    // Download/Clear Buttons
    if (domElements.downloadCsvButton) domElements.downloadCsvButton.disabled = !dataBufferHasData;
    if (domElements.clearDataButton) {
        // 清除按钮：仅当有数据或正在采集时才启用
        domElements.clearDataButton.disabled = !dataBufferHasData && !isCollecting;
        domElements.clearDataButton.className = 'w-full bg-red-500 hover:bg-red-600 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-70'; // 添加基础样式控制
    }
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