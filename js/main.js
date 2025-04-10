// js/main.js - Main Application Entry Point (Revised)

// --- Imports ---
import {
    DEFAULT_MAX_BUFFER_POINTS, MIN_BUFFER_POINTS,
    DEFAULT_SIM_CHANNELS, DEFAULT_SIM_FREQUENCY, DEFAULT_SIM_AMPLITUDE
} from './config.js';
import { debounce } from './utils.js';
import { // Import UI functions and *only necessary initial* elements
    loadAllPartials, setupEventListeners as setupUIEventListeners, updateControlVisibility,
    initializeSplitLayout, setupResizeObserver, handleResizeUI, // <-- Corrected import name
    updateStatusMessage,
} from './modules/ui.js';
import { initializeTimeChart, handleFollowToggleChange as handleFollowToggleChangeChart } from './modules/timechart.js';
import {
    initializeQuaternionView, updateQuaternionSelectors, updateQuaternionIndices,
    threeRenderer, threeCamera // Import instances for resize handler
} from './modules/quaternion.js';
import {
    processMainThreadQueue, clearAllData as clearDataProcessing, downloadCSV,
    calculateBufferEstimate, startBufferEstimationTimer, stopBufferEstimationTimer, handleRawFormatChange as handleRawFormatDataChange
} from './modules/data_processing.js';
import {
    connectSerial, disconnectSerial, updateSerialParser,
    handleSerialDisconnectEvent, handleSerialDisconnectCleanup // Import serial functions
} from './modules/serial.js';
import { setupWorkerListeners } from './modules/worker_comms.js';


// --- Application State ---
const appState = {
    // Core State
    isCollecting: false,
    currentDataSource: 'simulated', // Default set later from DOM if possible
    // Worker
    dataWorker: null,
    workerUrl: null,
    mainThreadDataQueue: [],
    latestWorkerTimestamp: 0,
    // Serial Port
    serialPort: null,
    // Buffers
    dataBuffer: [],
    rawLogBuffer: [],
    maxBufferPoints: DEFAULT_MAX_BUFFER_POINTS,
    // Data Processing & Display
    latestParsedValues: [],
    // Add instances for xterm
    terminalInstance: null,
    fitAddonInstance: null,
    rawDisplayMode: 'str',
    // Rate & Estimation
    dataPointCounter: 0,
    lastRateCheckTime: 0,
    currentDataRateHz: 0,
    bufferEstimateInterval: null,
    estimatedBufferTimeRemainingSec: null,
    estimatedBufferTimeSec: null,
    // Instances
    timeChartInstance: null,
    quaternionChannelIndices: { w: null, x: null, y: null, z: null },
    // Chart Interaction State
    followData: true,
    // DOM element references - populated *after* partials load
    domElements: {} // Store references here after querying
};
appState.stopDataCollectionFn = () => stopDataCollection();
appState.updateButtonStatesFn = () => updateButtonStatesMain();

// --- DOM Element Querying (after partial load) ---
/**
 * Queries all necessary DOM elements after HTML partials are loaded
 * and stores references in appState.domElements.
 * **Should be called after loadAllPartials() completes.**
 */
function queryDOMElements() {
    const get = (id) => document.getElementById(id); // Helper

    appState.domElements = {
        // --- Control Panel Elements ---
        controlPanel: get('control-panel'),
        dataSourceSelect: get('dataSourceSelect'),
        startStopButton: get('startStopButton'),
        statusMessage: get('statusMessage'),
        workerStatusDisplay: get('workerStatusDisplay'),

        // --- Control Sub-sections ---
        simulatedControls: get('simulatedControls'),
        webSerialControls: get('webSerialControls'),
        serialOptionsDiv: get('serialOptions'),
        quaternionSettings: get('quaternionSettings'),

        // --- Simulation Controls ---
        simNumChannelsInput: get('simNumChannels'),
        simFrequencyInput: get('simFrequency'),
        simAmplitudeInput: get('simAmplitude'),

        // --- Serial Controls ---
        connectSerialButton: get('connectSerialButton'),
        baudRateInput: get('baudRateInput'), // Matches HTML
        dataBitsSelect: get('dataBitsSelect'),
        stopBitsSelect: get('stopBitsSelect'),
        paritySelect: get('paritySelect'),
        flowControlSelect: get('flowControlSelect'),
        serialParserTextarea: get('serialParser'),
        updateParserButton: get('updateParserButton'),
        parserStatus: get('parserStatus'),

        // --- Quaternion Selectors ---
        quatWSelect: get('quatWChannel'),
        quatXSelect: get('quatXChannel'),
        quatYSelect: get('quatYChannel'),
        quatZSelect: get('quatZChannel'),

        // --- Buffer & Export ---
        bufferDurationInput: get('bufferDurationInput'),
        bufferUsageBar: get('bufferUsageBar'),
        bufferStatus: get('bufferStatus'),
        downloadCsvButton: get('downloadCsvButton'),
        clearDataButton: get('clearDataButton'),

        // --- Main Layout Containers (Initial) ---
        displayAreaContainer: get('displayAreaContainer'),
        displayArea: get('displayArea'),
        bottomRow: get('bottomRow'),

        // --- Module Containers (Targets for loading/splitting) ---
        plotModule: get('plotModule'),
        textModule: get('textModule'),
        quatModule: get('quatModule'),

        // --- Plot Module Internals ---
        lineChartDiv: get('lineChart'), // TimeChart target
        followToggle: get('followToggle'),
        dataRateDisplay: get('dataRateDisplay'),

        // --- Text Module Internals ---
        parsedDataDisplay: get('parsedDataDisplay'),
        terminalContainer: get('terminal'), // xterm target
        rawStrBtn: get('rawStrBtn'),
        rawHexBtn: get('rawHexBtn'),

        // --- Quaternion Module Internals ---
        quaternionViewDiv: get('quaternionView'), // Three.js target
        quatFpsDisplay: get('quatFpsDisplay'),
        quaternionErrorOverlay: get('quaternionErrorOverlay')
    };

    // Optional: Check if critical elements were found
    const criticalElements = ['plotModule', 'textModule', 'quatModule', 'lineChartDiv', 'terminalContainer', 'quaternionViewDiv', 'control-panel'];
    let notFound = [];
    for (const id of criticalElements) {
        // Convert kebab-case id to camelCase key if necessary (simple case)
        const key = id.includes('-') ? id.replace(/-([a-z])/g, (g) => g[1].toUpperCase()) : id;
        if (!appState.domElements[key]) {
            notFound.push(id);
        }
    }
    if (notFound.length > 0) {
        console.warn("Query DOM Elements: Critical elements not found by ID:", notFound);
    } else {
        console.log("DOM elements queried successfully.");
    }
}

// --- Initialization ---
async function initializeApp() {
    console.log("Initializing application...");
    updateStatusMessage("Status: Initializing...");

    // 1. Load HTML Partials and wait for element references
    let loadedModuleElements;
    try {
        // Await the object containing references to the loaded module containers
        loadedModuleElements = await loadAllPartials();
        if (!loadedModuleElements) {
            throw new Error("loadAllPartials returned null or undefined.");
        }
        // Store these main elements in appState if needed often elsewhere
        appState.domElements.plotModule = loadedModuleElements.plotModule;
        appState.domElements.textModule = loadedModuleElements.textModule;
        appState.domElements.quatModule = loadedModuleElements.quatModule;
        appState.domElements.controlPanel = loadedModuleElements.controlPanel;

        // Check if essential elements were loaded successfully
        if (!loadedModuleElements.plotModule || !loadedModuleElements.textModule || !loadedModuleElements.quatModule || !loadedModuleElements.controlPanel) {
             throw new Error("Essential module container(s) failed to load.");
        }

    } catch(error) {
        console.error("Failed during partial loading or element retrieval. Initialization aborted.", error);
        updateStatusMessage("Error: Failed to load UI components. Please refresh.");
        return; // Stop initialization
    }

    // 2. Query OTHER necessary DOM elements (those inside loaded partials or existing in index.html)
    // This function populates appState.domElements
    queryDOMElements();

    // 3. Create Web Worker
    try {
        // Ensure worker creation only happens once
        if (!appState.dataWorker && !appState.workerUrl) {
             const workerResponse = await fetch('js/worker/data_worker.js');
             if (!workerResponse.ok) throw new Error(`Failed to fetch worker script: ${workerResponse.statusText}`);
             const workerCode = await workerResponse.text();
             const blob = new Blob([workerCode], { type: 'application/javascript' });
             appState.workerUrl = URL.createObjectURL(blob);
             appState.dataWorker = new Worker(appState.workerUrl);
             console.log("Data worker created successfully.");
        } else {
             console.log("Worker already exists or URL is set.");
        }
        // 4. Setup Worker Communication Listeners (safe to call even if worker existed)
         setupWorkerListeners(appState.dataWorker, appState, stopDataCollection);

    } catch (error) {
        console.error("Worker Initialization Error:", error);
        updateStatusMessage(`Error: Worker initialization failed - ${error.message}`);
        if(appState.domElements.startStopButton) appState.domElements.startStopButton.disabled = true;
        if(appState.domElements.connectSerialButton) appState.domElements.connectSerialButton.disabled = true;
        return; // Stop init if worker failed
    }


    // 5. Read initial state from DOM elements (which are now confirmed to exist)
    appState.currentDataSource = appState.domElements.dataSourceSelect?.value || 'simulated';
    appState.maxBufferPoints = parseInt(appState.domElements.bufferDurationInput?.value || DEFAULT_MAX_BUFFER_POINTS);
    appState.followData = appState.domElements.followToggle?.checked ?? true;
    appState.rawDisplayMode = appState.domElements.rawStrBtn?.classList.contains('active') ? 'str' : 'hex';


    // 6. Initialize Charting and 3D View (pass queried elements)
    if (appState.domElements.lineChartDiv) {
        appState.timeChartInstance = initializeTimeChart(
            appState.domElements.lineChartDiv,
            parseInt(appState.domElements.simNumChannelsInput?.value || DEFAULT_SIM_CHANNELS),
            appState.followData,
            // Callbacks for custom interaction plugin (if used, ensure they are correct)
             (newFollowState) => { appState.followData = newFollowState; if (appState.domElements.followToggle) appState.domElements.followToggle.checked = newFollowState; },
             () => true // shouldEnableFollow check
        );
    } else { console.error("Cannot initialize TimeChart: #lineChart element not found."); }

    initializeQuaternionView(); // Assumes this queries #quaternionView internally now


    // 7. Initialize xterm.js Terminal
    const Terminal = window.Terminal; const FitAddon = window.FitAddon?.FitAddon;
    if (appState.domElements.terminalContainer && Terminal && FitAddon) {
         try {
            const term = new Terminal({
                 fontFamily: 'Consolas, "Liberation Mono", Menlo, Courier, monospace', fontSize: 13, fontWeight: 'normal',
                 theme: { background: '#FFFFFF', foreground: '#000000', cursor: '#000000', cursorAccent: '#FFFFFF', selectionBackground: '#A9A9A9', selectionForeground: '#000000' },
                 cursorBlink: false, convertEol: true, scrollback: 5000, disableStdin: true, windowsMode: false
             });
            const fitAddon = new FitAddon(); term.loadAddon(fitAddon); term.open(appState.domElements.terminalContainer); fitAddon.fit();
            appState.terminalInstance = term; appState.fitAddonInstance = fitAddon; term.write('Terminal Initialized...\r\n'); console.log("xterm.js initialized.");
         } catch(termError) { console.error("Error initializing xterm.js:", termError); if(appState.domElements.terminalContainer) appState.domElements.terminalContainer.innerText = "Failed to load terminal."; }
    } else { console.error("Terminal container element or xterm libraries not found!"); if(appState.domElements.terminalContainer) appState.domElements.terminalContainer.innerText = "Failed to load terminal component."; }

    // 8. Initialize UI State and Controls
    updateQuaternionSelectors(parseInt(appState.domElements.simNumChannelsInput?.value || DEFAULT_SIM_CHANNELS), appState.quaternionChannelIndices, () => updateQuaternionIndices(appState.quaternionChannelIndices));
    updateControlVisibility(appState.currentDataSource);
    updateButtonStatesMain();


    // 9. Setup Event Listeners (Now safe as DOM is ready)
    setupUIEventListeners({ // Pass handlers defined in main.js
        handleDataSourceChange, handleStartStop, handleConnectSerial, handleUpdateParser, handleQuaternionSelectChange, handleBufferDurationChange,
        handleDownloadCsv, handleClearData, handleSimChannelChange, handleSimFrequencyChange, handleSimAmplitudeChange,
        handleRawFormatChange: (mode) => handleRawFormatDataChange(mode, appState), // Pass state
        handleFollowToggleChange: (event) => handleFollowToggleChangeChart(event, appState.timeChartInstance, (newState) => { appState.followData = newState; }) // Pass instance and state setter
    });

    // 10. Setup Layout and Resize Handling
    const mainResizeHandler = () => {
        handleResizeUI({ timeChartInstance: appState.timeChartInstance, threeRenderer, threeCamera }); // Pass chart/3D instances
        appState.fitAddonInstance?.fit(); // Fit terminal on resize
    };
    const debouncedResizeHandler = debounce(mainResizeHandler, 150);
    // Initialize Split.js *now*, passing the elements returned by loadAllPartials
    initializeSplitLayout({
        plotElement: appState.domElements.plotModule, // Use stored reference
        bottomRowElement: appState.domElements.bottomRow, // Use stored reference (or direct ID get)
        textElement: appState.domElements.textModule,   // Use stored reference
        quatElement: appState.domElements.quatModule    // Use stored reference
    }, debouncedResizeHandler);
    setupResizeObserver(debouncedResizeHandler);
    window.addEventListener('resize', debouncedResizeHandler);
    console.log("Window resize listener added.");
    mainResizeHandler();

    // 11. Start Main Processing Loop
    if (!appState.rAFID) {
        console.log("Starting main loop.");
        appState.rAFID = requestAnimationFrame(processMainQueueLoop);
    }

    updateStatusMessage("Status: Initialization complete. Ready.");
    console.log("Application initialized.");

}

// --- Main Data Processing Loop --- (remains the same)
function processMainQueueLoop() {
    processMainThreadQueue(appState, appState.timeChartInstance, appState.quaternionChannelIndices);
    requestAnimationFrame(processMainQueueLoop);
}

// --- Core Control Functions --- (startDataCollection and stopDataCollection remain largely the same structurally)
// They now rely on appState and queried elements in appState.domElements

function startDataCollection() {
    // ... (implementation similar to previous version, but using appState and appState.domElements)
    if (appState.isCollecting || !appState.dataWorker) return;
    const isSimulated = appState.currentDataSource === 'simulated';
    const isSerial = appState.currentDataSource === 'webserial';
    const canStartSerial = isSerial && appState.serialPort !== null;

    const currentSimChannels = parseInt(appState.domElements.simNumChannelsInput?.value || DEFAULT_SIM_CHANNELS);
    if (isSimulated && (!appState.timeChartInstance || appState.timeChartInstance.options.series.length !== currentSimChannels)) {
        reinitializeTimeChart(currentSimChannels);
    } else if (!appState.timeChartInstance) {
        reinitializeTimeChart(currentSimChannels);
        if (!appState.timeChartInstance) { updateStatusMessage("错误：无法初始化图表！"); return; }
    }

    if (!isSimulated && !canStartSerial) { updateStatusMessage("状态：错误 - 请先连接串口"); return; }

    appState.isCollecting = true;
    appState.latestWorkerTimestamp = 0;
    appState.lastRateCheckTime = performance.now();
    appState.dataPointCounter = 0;
    appState.mainThreadDataQueue = [];
    updateStatusMessage("状态：采集中 (Worker)...");
    startBufferEstimationTimer(calculateBufferEstimate, appState);

    if (appState.domElements.followToggle?.checked !== appState.followData) {
        appState.followData = appState.domElements.followToggle.checked;
    }
    if (appState.timeChartInstance) { appState.timeChartInstance.options.realTime = appState.followData; if (appState.followData) appState.timeChartInstance.options.yRange = 'auto'; }

    if (isSimulated) {
        appState.dataWorker.postMessage({
            type: 'start', payload: {
                source: 'simulated', config: {
                    numChannels: currentSimChannels,
                    frequency: parseInt(appState.domElements.simFrequencyInput?.value || DEFAULT_SIM_FREQUENCY),
                    amplitude: parseFloat(appState.domElements.simAmplitudeInput?.value || DEFAULT_SIM_AMPLITUDE),
                }
            }
        });
    } else if (canStartSerial) {
        try {
            const parserCode = appState.domElements.serialParserTextarea?.value || '';
            appState.dataWorker.postMessage({ type: 'start', payload: { source: 'webserial', port: appState.serialPort, config: {}, parserCode: parserCode } }, [appState.serialPort]);
            appState.serialPort = null;
        } catch (transferError) {
            console.error("Main: Error transferring SerialPort:", transferError);
            updateStatusMessage(`状态：传输端口到 Worker 失败: ${transferError.message}`);
            appState.isCollecting = false;
            if (appState.serialPort) { disconnectSerial(appState); }
            stopBufferEstimationTimer(appState);
            updateButtonStatesMain(); // Update buttons after failed start
            return;
        }
    }
    updateButtonStatesMain(); // Update buttons after successful start
    console.log("Data collection active...");
}

function stopDataCollection() {
    // ... (implementation similar to previous version, using appState and calling updateButtonStatesMain)
    if (!appState.isCollecting) return;
    console.warn("MAIN THREAD: Stopping data collection...");
    stopBufferEstimationTimer(appState);
    appState.isCollecting = false;
    if (appState.dataWorker) { appState.dataWorker.postMessage({ type: 'stop' }); }
    processMainQueueLoop(); // Process final data
    appState.currentDataRateHz = 0;
    // Query dataRateDisplay now as it might not exist during init
    const drDisplay = document.getElementById('dataRateDisplay');
    if (drDisplay) drDisplay.textContent = `速率: 0.0 Hz`;

    updateStatusMessage("状态：已停止");
    if (appState.currentDataSource === 'webserial') {
        handleSerialDisconnectCleanup(appState); // This calls updateButtonStates internally
    } else {
        updateButtonStatesMain(); // Explicitly update for non-serial stop
    }
    console.warn("MAIN THREAD: Collection stopped.");
}


// --- Event Handlers (Defined in main.js, passed to ui.js) ---

function handleDataSourceChange(event) {
    const newSource = event.target.value;
    if (appState.isCollecting) stopDataCollection();
    appState.currentDataSource = newSource;
    updateControlVisibility(appState.currentDataSource); // Use imported UI function
    updateButtonStatesMain(); // Use main state update
}

function handleStartStop() {
    if (appState.isCollecting) stopDataCollection(); else startDataCollection();
}

async function handleConnectSerial() {
    if (appState.serialPort) await disconnectSerial(appState); else await connectSerial(appState);
    // Note: connectSerial/disconnectSerial now call updateButtonStates themselves via cleanup/finally
}

function handleUpdateParser() {
    updateSerialParser(appState); // Use imported serial function
}

function handleQuaternionSelectChange() {
    updateQuaternionIndices(appState.quaternionChannelIndices); // Use imported quat function
}

function handleBufferDurationChange(event) {
    const v = parseInt(event.target.value);
    const maxPointsInput = appState.domElements.bufferDurationInput; // Use queried element
    if (v && v >= MIN_BUFFER_POINTS) {
        appState.maxBufferPoints = v;
        calculateBufferEstimate(appState); // Use imported data_proc function
    } else {
        alert(`缓冲点数必须是一个大于或等于 ${MIN_BUFFER_POINTS} 的数字。`);
        if (maxPointsInput) maxPointsInput.value = appState.maxBufferPoints; // Revert input
    }
}

function handleDownloadCsv() {
    downloadCSV(appState.dataBuffer, appState.timeChartInstance?.options?.series); // Use imported data_proc function
}

function handleClearData() {
    if (appState.isCollecting) {
        stopDataCollection(); // Stop collection first
    }
    const defaultChannels = parseInt(appState.domElements.simNumChannelsInput?.value || DEFAULT_SIM_CHANNELS);
    // Call the imported clear function, passing the reinit callback
    clearDataProcessing(appState, () => reinitializeTimeChart(defaultChannels));
    updateButtonStatesMain();
}

function handleSimChannelChange(event) {
    const newChannelCount = parseInt(event.target.value) || DEFAULT_SIM_CHANNELS;
    if (appState.isCollecting && appState.currentDataSource === 'simulated' && appState.dataWorker) {
        // Query elements now
        const freqInput = document.getElementById('simFrequency');
        const ampInput = document.getElementById('simAmplitude');
        appState.dataWorker.postMessage({
            type: 'updateSimConfig', payload: {
                numChannels: newChannelCount,
                frequency: parseInt(freqInput?.value || DEFAULT_SIM_FREQUENCY),
                amplitude: parseFloat(ampInput?.value || DEFAULT_SIM_AMPLITUDE)
            }
        });
        console.warn("Sim channel count changed during collection. Restart recommended.");
    }
    updateQuaternionSelectors(newChannelCount, appState.quaternionChannelIndices, () => updateQuaternionIndices(appState.quaternionChannelIndices));
    if (!appState.isCollecting) reinitializeTimeChart(newChannelCount);
    updateButtonStatesMain(); // Ensure button states reflect potential changes
}
function handleSimFrequencyChange(event) {
    const newFrequency = parseInt(event.target.value) || DEFAULT_SIM_FREQUENCY;
    if (appState.isCollecting && appState.currentDataSource === 'simulated' && appState.dataWorker) {
        const chanInput = document.getElementById('simNumChannels');
        const ampInput = document.getElementById('simAmplitude');
        appState.dataWorker.postMessage({
            type: 'updateSimConfig', payload: {
                numChannels: parseInt(chanInput?.value || DEFAULT_SIM_CHANNELS),
                frequency: newFrequency,
                amplitude: parseFloat(ampInput?.value || DEFAULT_SIM_AMPLITUDE)
            }
        });
    }
}
function handleSimAmplitudeChange(event) {
    const newAmplitude = parseFloat(event.target.value) || DEFAULT_SIM_AMPLITUDE;
    if (appState.isCollecting && appState.currentDataSource === 'simulated' && appState.dataWorker) {
        const chanInput = document.getElementById('simNumChannels');
        const freqInput = document.getElementById('simFrequency');
        appState.dataWorker.postMessage({
            type: 'updateSimConfig', payload: {
                numChannels: parseInt(chanInput?.value || DEFAULT_SIM_CHANNELS),
                frequency: parseInt(freqInput?.value || DEFAULT_SIM_FREQUENCY),
                amplitude: newAmplitude
            }
        });
    }
}

// --- Helper Functions ---
function reinitializeTimeChart(numChannels) {
    console.log(`Re-initializing chart with ${numChannels} channels.`);
    if (appState.timeChartInstance && typeof appState.timeChartInstance.dispose === 'function') { try { appState.timeChartInstance.dispose(); } catch (e) { } }
    // Query target element again just in case
    const targetDiv = document.getElementById('lineChart');
    if (targetDiv) {
        appState.timeChartInstance = initializeTimeChart(targetDiv, numChannels, appState.followData, (newState) => { appState.followData = newState; if (appState.domElements.followToggle) appState.domElements.followToggle.checked = newState; }, () => true);
    } else {
        console.error("Cannot reinitialize TimeChart: Target element #lineChart not found.");
    }
}

/** Updates button states using the function from ui.js, passing current appState */
function updateButtonStatesMain() {
    // Use appState directly
    const { isCollecting, currentDataSource, serialPort, dataBuffer, rawLogBuffer, latestWorkerTimestamp, domElements } = appState;

    // Ensure elements have been queried
    if (!domElements || Object.keys(domElements).length === 0) {
        console.warn("updateButtonStatesMain called before DOM elements were queried.");
        return;
    }

    const isSerial = currentDataSource === 'webserial';
    const isSerialConnectedOnMain = isSerial && serialPort !== null;
    const dataBufferLength = dataBuffer.length;
    const rawLogBufferLength = rawLogBuffer.length;

    // Start/Stop Button
    if (domElements.startStopButton) {
        if (isCollecting) {
            domElements.startStopButton.textContent = "结束采集";
            domElements.startStopButton.disabled = false;
            domElements.startStopButton.classList.remove('bg-blue-500', 'hover:bg-blue-600');
            domElements.startStopButton.classList.add('bg-red-500', 'hover:bg-red-600');
        } else {
            domElements.startStopButton.textContent = "开始采集";
            domElements.startStopButton.classList.remove('bg-red-500', 'hover:bg-red-600');
            domElements.startStopButton.classList.add('bg-blue-500', 'hover:bg-blue-600');
            domElements.startStopButton.disabled = (isSerial && !isSerialConnectedOnMain);
        }
    }

    // Connect/Disconnect Button
    if (domElements.connectSerialButton) {
        domElements.connectSerialButton.disabled = !isSerial || isCollecting;
        if (serialPort) { // Main thread holds port
            domElements.connectSerialButton.textContent = "断开串口";
            domElements.connectSerialButton.classList.replace('bg-blue-500', 'bg-yellow-500');
            domElements.connectSerialButton.classList.replace('hover:bg-blue-600', 'hover:bg-yellow-600');
        } else { // Main thread doesn't hold port
            domElements.connectSerialButton.textContent = "连接串口";
            domElements.connectSerialButton.classList.replace('bg-yellow-500', 'bg-blue-500');
            domElements.connectSerialButton.classList.replace('hover:bg-yellow-600', 'hover:bg-blue-600');
        }
    }

    // Serial Options Div
    if (domElements.serialOptionsDiv) {
        const disableSerialOptions = !isSerial || isCollecting || isSerialConnectedOnMain;
        domElements.serialOptionsDiv.querySelectorAll('input, select, textarea, button').forEach(el => {
            // Avoid disabling the connect button itself based on this logic
            if (el !== domElements.connectSerialButton) el.disabled = disableSerialOptions;
        });
        if (domElements.updateParserButton) domElements.updateParserButton.disabled = disableSerialOptions;
    }

    // Download/Clear Buttons
    if (domElements.downloadCsvButton) domElements.downloadCsvButton.disabled = dataBufferLength === 0;
    if (domElements.clearDataButton) {
        domElements.clearDataButton.disabled = dataBufferLength === 0 && rawLogBufferLength === 0 && !latestWorkerTimestamp;
    }
}


// --- Global Cleanup on Page Unload ---
window.addEventListener('beforeunload', () => {
    console.log("Page unloading. Cleaning up worker, serial port, and terminal.");
    if (appState.terminalInstance) { // Dispose terminal
        appState.terminalInstance.dispose();
    }
    if (appState.dataWorker) appState.dataWorker.terminate();
    if (appState.workerUrl) URL.revokeObjectURL(appState.workerUrl);
    if (appState.serialPort) disconnectSerial(appState); // disconnectSerial handles async
});


// --- Start the Application ---
document.addEventListener('DOMContentLoaded', initializeApp);

console.log("main.js loaded (revised)");