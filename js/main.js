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
    updateBufferStatusUI
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
        simAmplitude: DEFAULT_SIM_AMPLITUDE
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
        webSerialControls: get('webSerialControls'), serialOptionsDiv: get('serialOptions'),
        simNumChannelsInput: get('simNumChannels'), simFrequencyInput: get('simFrequency'),
        simAmplitudeInput: get('simAmplitude'), connectSerialButton: get('connectSerialButton'),
        baudRateInput: get('baudRateInput'), dataBitsSelect: get('dataBitsSelect'),
        stopBitsSelect: get('stopBitsSelect'), paritySelect: get('paritySelect'),
        flowControlSelect: get('flowControlSelect'), serialParserTextarea: get('serialParser'),
        updateParserButton: get('updateParserButton'), parserStatus: get('parserStatus'),
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
    } catch(error) {
        console.error("Partial loading failed.", error);
        updateStatusMessage("Error: Failed to load UI. Please refresh.");
        return;
    }
    queryDOMElements();

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
        if(appState.domElements.startStopButton) appState.domElements.startStopButton.disabled = true;
        if(appState.domElements.connectSerialButton) appState.domElements.connectSerialButton.disabled = true;
        return;
    }

    appState.config.currentDataSource = appState.domElements.dataSourceSelect?.value || 'simulated';
    appState.config.maxBufferPoints = parseInt(appState.domElements.bufferDurationInput?.value || DEFAULT_MAX_BUFFER_POINTS);
    appState.config.followData = document.getElementById('followToggle')?.checked ?? true;
    appState.config.rawDisplayMode = document.getElementById('rawStrBtn')?.classList.contains('active') ? 'str' : 'hex';
    appState.config.numChannels = parseInt(appState.domElements.simNumChannelsInput?.value || DEFAULT_SIM_CHANNELS);
    appState.config.simFrequency = parseInt(appState.domElements.simFrequencyInput?.value || DEFAULT_SIM_FREQUENCY);
    appState.config.simAmplitude = parseFloat(appState.domElements.simAmplitudeInput?.value || DEFAULT_SIM_AMPLITUDE);

    displayModules.forEach(module => {
        try {
            let elementId = ''; let initialState = {};
            if (module === plotModule) {
                elementId = 'plotModule'; // Use placeholder ID
                initialState = { follow: appState.config.followData, numChannels: appState.config.numChannels, maxBufferPoints: appState.config.maxBufferPoints };
            } else if (module === terminalModule) {
                elementId = 'textModule'; // Use placeholder ID
                initialState = { rawDisplayMode: appState.config.rawDisplayMode , updateDivider: 3};
            } else if (module === quatModule) {
                // Pass the ID of the specific container element from the quat partial's HTML
                // Assuming the partial's root element has id="quatModuleContainer"
                // and it's loaded inside the #quatModule placeholder
                elementId = 'quatModuleContainer'; // ID from the partial's root
                initialState = { availableChannels: appState.config.numChannels };
            }
            if (elementId && document.getElementById(elementId)) { module.create(elementId, initialState); }
            else { console.error(`Cannot create module, target element ID "${elementId}" not found.`); }
        } catch (error) { console.error("Error creating module instance:", error); }
    });

    updateControlVisibility(appState.config.currentDataSource);
    updateButtonStatesMain();
    setupUIEventListeners({
        handleDataSourceChange, handleStartStop, handleConnectSerial, handleUpdateParser,
        handleBufferDurationChange, handleDownloadCsv, handleClearData,
        handleSimChannelChange, handleSimFrequencyChange, handleSimAmplitudeChange,
    });

    const mainResizeHandler = () => {
        displayModules.forEach(module => { try { module.resize(); } catch(e){ /* ignore */ }});
    };
    const debouncedResizeHandler = debounce(mainResizeHandler, 150);
    initializeSplitLayout({
        plotElement: appState.domElements.plotModulePlaceholder, // Use placeholder ref
        bottomRowElement: appState.domElements.bottomRow,
        textElement: appState.domElements.textModulePlaceholder, // Use placeholder ref
        quatElement: appState.domElements.quatModulePlaceholder  // Use placeholder ref
    }, debouncedResizeHandler);
    setupResizeObserver(debouncedResizeHandler);
    window.addEventListener('resize', debouncedResizeHandler);
    mainResizeHandler();

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

    const startPayload = { source: appState.config.currentDataSource, config: {}, parserCode: '' };
    if (appState.config.currentDataSource === 'simulated') {
        startPayload.config = { numChannels: appState.config.numChannels, frequency: appState.config.simFrequency, amplitude: appState.config.simAmplitude };
        appState.dataWorker.postMessage({ type: 'start', payload: startPayload });
    } else if (canStartSerial) {
        try {
            startPayload.port = appState.serialPort;
            startPayload.parserCode = appState.domElements.serialParserTextarea?.value || '';
            appState.dataWorker.postMessage({ type: 'start', payload: startPayload }, [appState.serialPort]);
            appState.serialPort = null;
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
function handleUpdateParser() { updateSerialParser(appState); }

function handleBufferDurationChange(event) {
    const v = parseInt(event.target.value); const maxPointsInput = appState.domElements.bufferDurationInput;
    if (v && v >= MIN_BUFFER_POINTS) {
        if (appState.config.maxBufferPoints !== v) {
            appState.config.maxBufferPoints = v;
            displayModules.forEach(m => { if(m.updateConfig) m.updateConfig({ maxBufferPoints: v }); });
            dataProcessor.calculateBufferEstimate( dataProcessor.getCurrentDataRate(), dataProcessor.getBufferLength(), v, appState.isCollecting );
            updateBufferStatusUI( dataProcessor.getBufferLength(), v, appState.isCollecting, dataProcessor.getEstimateRemaining(), dataProcessor.getEstimateTotal() );
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
    displayModules.forEach(module => { try { 
        console.log("Clearing module", module);
        module.clear(); 
    } catch(e){ console.warn("Error clearing module", e); }});
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
        displayModules.forEach(m => { if(m.updateConfig) m.updateConfig({ availableChannels: newChannelCount, numChannels: newChannelCount }); });
        updateButtonStatesMain();
    }
}
function handleSimFrequencyChange(event) {
     const newFrequency = parseInt(event.target.value) || DEFAULT_SIM_FREQUENCY; if(appState.config.simFrequency !== newFrequency){
        appState.config.simFrequency = newFrequency; if (appState.isCollecting && appState.config.currentDataSource === 'simulated' && appState.dataWorker) {
            appState.dataWorker.postMessage({ type: 'updateSimConfig', payload: { numChannels: appState.config.numChannels, frequency: appState.config.simFrequency, amplitude: appState.config.simAmplitude } }); } }
}
function handleSimAmplitudeChange(event) {
     const newAmplitude = parseFloat(event.target.value) || DEFAULT_SIM_AMPLITUDE; if(appState.config.simAmplitude !== newAmplitude){
        appState.config.simAmplitude = newAmplitude; if (appState.isCollecting && appState.config.currentDataSource === 'simulated' && appState.dataWorker) {
            appState.dataWorker.postMessage({ type: 'updateSimConfig', payload: { numChannels: appState.config.numChannels, frequency: appState.config.simFrequency, amplitude: appState.config.simAmplitude } }); } }
}

// --- Helper: Update Button States ---
function updateButtonStatesMain() {
    const { isCollecting, config, serialPort } = appState; const { currentDataSource } = config; const domElements = appState.domElements;
    if (!domElements || Object.keys(domElements).length === 0) return; const isSerial = currentDataSource === 'webserial';
    const isSerialConnectedOnMain = isSerial && serialPort !== null; const dataBufferHasData = dataProcessor.getBufferLength() > 0;
    if (domElements.startStopButton) { if (isCollecting) { domElements.startStopButton.textContent = "结束采集"; domElements.startStopButton.disabled = false; domElements.startStopButton.className = 'w-full mb-2 bg-red-500 hover:bg-red-600'; } else { domElements.startStopButton.textContent = "开始采集"; domElements.startStopButton.className = 'w-full mb-2 bg-blue-500 hover:bg-blue-600'; domElements.startStopButton.disabled = (isSerial && !isSerialConnectedOnMain); } }
    if (domElements.connectSerialButton) { domElements.connectSerialButton.disabled = !isSerial || isCollecting; if (serialPort) { domElements.connectSerialButton.textContent = "断开串口"; domElements.connectSerialButton.className = 'w-full bg-yellow-500 hover:bg-yellow-600'; } else { domElements.connectSerialButton.textContent = "连接串口"; domElements.connectSerialButton.className = 'w-full bg-blue-500 hover:bg-blue-600'; } }
    if (domElements.serialOptionsDiv) { const disableSerialOptions = !isSerial || isCollecting || isSerialConnectedOnMain; domElements.serialOptionsDiv.querySelectorAll('input, select, textarea, button').forEach(el => { if (el !== domElements.connectSerialButton) el.disabled = disableSerialOptions; }); if (domElements.updateParserButton) domElements.updateParserButton.disabled = disableSerialOptions; }
    if (domElements.downloadCsvButton) domElements.downloadCsvButton.disabled = !dataBufferHasData; if (domElements.clearDataButton) domElements.clearDataButton.disabled = !dataBufferHasData && !isCollecting;
}

// --- Global Cleanup ---
window.addEventListener('beforeunload', () => {
    console.log("Page unloading. Cleaning up...");
    displayModules.forEach(module => { try { module.destroy(); } catch(e){ console.error("Error destroying module", e);} });
    if (appState.dataWorker) appState.dataWorker.terminate();
    if (appState.workerUrl) URL.revokeObjectURL(appState.workerUrl);
    if (appState.serialPort) disconnectSerial(appState); // Attempt disconnect
});

// --- Start App ---
document.addEventListener('DOMContentLoaded', initializeApp);