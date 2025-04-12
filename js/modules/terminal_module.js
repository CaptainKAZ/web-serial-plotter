// js/modules/terminal_module.js
// Manages the xterm.js terminal, parsed data display, and raw output buffering.

// Target update interval for the raw output terminal in milliseconds (e.g., 100ms = ~10 FPS)
import { TERMINAL_UPDATE_INTERVAL_MS } from '../config.js';

// Module state
let terminalInstance = null;
let fitAddonInstance = null;
let rawStrBtnElement = null;
let rawHexBtnElement = null;
let parsedDataDisplayElement = null;
let isInitialized = false;
let textDecoder = null; // For decoding raw bytes

// Configuration and state for buffering/updates
let internalConfig = {
    rawDisplayMode: 'str'
};
let rawOutputBuffer = ''; // Buffer for raw terminal lines
let lastTerminalWriteTime = 0; // Timestamp of last terminal write

// --- Internal Helper Functions ---

function updateParsedDataDisplayInternal(latestValues) {
    if (!parsedDataDisplayElement) return;
    if (!latestValues || latestValues.length === 0) {
        parsedDataDisplayElement.innerHTML = `<span class="text-gray-400 text-xs italic">Waiting for data...</span>`;
        return;
    }
    let htmlContent = '';
    latestValues.forEach((value, index) => {
        let displayValue = 'N/A';
        if (typeof value === 'number' && isFinite(value)) { displayValue = value.toFixed(3); }
        else if (isNaN(value)) { displayValue = 'NaN'; }
        htmlContent += `<div class="channel-value"><span class="channel-label">ch${index + 1}:</span>${displayValue}</div>`;
    });
    parsedDataDisplayElement.innerHTML = htmlContent;
}

function handleInternalFormatChange(newMode) {
    if (internalConfig.rawDisplayMode !== newMode) {
        flushRawOutputBuffer(); // Flush buffer before changing mode
        internalConfig.rawDisplayMode = newMode;
        rawStrBtnElement?.classList.toggle('active', newMode === 'str');
        rawHexBtnElement?.classList.toggle('active', newMode === 'hex');
        if(terminalInstance) terminalInstance.write(`\r\n--- Display Mode Changed to ${internalConfig.rawDisplayMode.toUpperCase()} ---\r\n`);
    }
}

// Bound event handlers
let boundStrHandler = () => handleInternalFormatChange('str');
let boundHexHandler = () => handleInternalFormatChange('hex');

// Helper to flush the raw output buffer immediately
function flushRawOutputBuffer() {
     if (terminalInstance && rawOutputBuffer.length > 0) {
         try {
             // Clean up consecutive newlines before writing
             const cleanedBuffer = rawOutputBuffer.replace(/(?:\r?\n\s*){2,}/g, '\r\n');
             terminalInstance.write(cleanedBuffer);
             lastTerminalWriteTime = performance.now(); // Update time as we just wrote
         } catch(e) { console.warn("Error flushing terminal buffer:", e); }
     }
     rawOutputBuffer = ''; // Always clear buffer after attempting flush
}

// --- Display Module Interface Implementation ---

export function create(elementId, initialState = {}) {
    if (isInitialized) return true;
    const containerElement = document.getElementById(elementId);
    if (!containerElement) { console.error(`Terminal Module: Container #${elementId} not found.`); return false; }

    // Find internal elements
    const targetDiv = containerElement.querySelector('#terminal');
    parsedDataDisplayElement = containerElement.querySelector('#parsedDataDisplay');
    rawStrBtnElement = containerElement.querySelector('#rawStrBtn');
    rawHexBtnElement = containerElement.querySelector('#rawHexBtn');

    if (!targetDiv || !parsedDataDisplayElement || !rawStrBtnElement || !rawHexBtnElement) {
        console.error("Terminal Module: Could not find all internal elements."); return false;
    }
    const Terminal = window.Terminal; const FitAddon = window.FitAddon?.FitAddon;
    if (!Terminal || !FitAddon) { console.error("xterm.js or FitAddon library not loaded."); return false; }

    // Merge initial state
    internalConfig = { ...internalConfig, ...initialState };

    // Initialize state variables
    rawOutputBuffer = '';
    lastTerminalWriteTime = 0;
    textDecoder = new TextDecoder('utf-8', { fatal: false });

    try {
        terminalInstance = new Terminal({
             fontFamily: 'Consolas, "Liberation Mono", Menlo, Courier, monospace', fontSize: 13,
             theme: { background: '#FFFFFF', foreground: '#000000', cursor: '#000000', selectionBackground: '#A9A9A9' },
             cursorBlink: false, convertEol: true, scrollback: 5000, disableStdin: true, windowsMode: false
         });
        fitAddonInstance = new FitAddon();
        terminalInstance.loadAddon(fitAddonInstance);
        terminalInstance.open(targetDiv);
        fitAddonInstance.fit();
        terminalInstance.write(`Terminal Initialized.\r\n`);
        updateParsedDataDisplayInternal([]);

        // Set up buttons
        rawStrBtnElement.classList.toggle('active', internalConfig.rawDisplayMode === 'str');
        rawHexBtnElement.classList.toggle('active', internalConfig.rawDisplayMode === 'hex');
        rawStrBtnElement.addEventListener('click', boundStrHandler);
        rawHexBtnElement.addEventListener('click', boundHexHandler);

        isInitialized = true;
        console.log(`Terminal Module Created (Time-based Update: ~${(1000 / TERMINAL_UPDATE_INTERVAL_MS).toFixed(0)} FPS).`);
        return true;
    } catch (error) {
        console.error("Error initializing xterm.js:", error);
        isInitialized = false; terminalInstance = null; fitAddonInstance = null;
        return false;
    }
}

export function processDataBatch(batch) {
    if (!isInitialized || batch.length === 0) return;
    const now = performance.now();

    // --- Update parsed data display (always) ---
    let latestValuesForDisplay = null;
    for (let i = batch.length - 1; i >= 0; i--) {
        if (batch[i] && Array.isArray(batch[i].values)) {
            latestValuesForDisplay = batch[i].values;
            break;
        }
    }
    if (latestValuesForDisplay !== null) {
        updateParsedDataDisplayInternal(latestValuesForDisplay);
    }

    // --- Format and buffer raw output (always) ---
    for (const item of batch) {
        if (!item || typeof item.timestamp !== 'number') continue;
        const { timestamp, values, rawLineBytes } = item;
        const displayTimeStr = (timestamp / 1000.0).toFixed(3);
        let displayLine = '';

        if (rawLineBytes instanceof Uint8Array && rawLineBytes.byteLength > 0) {
            if (internalConfig.rawDisplayMode === 'hex') {
                displayLine = Array.prototype.map.call(rawLineBytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
            } else { // STR mode
                try {
                    let decodedString = textDecoder.decode(rawLineBytes, { stream: false })
                                       .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '.');
                    displayLine = decodedString.trimEnd(); // Remove trailing whitespace/newlines from source data
                } catch (e) {
                    displayLine = "[Decode Error]";
                }
            }
        } else if (Array.isArray(values) && values.length > 0) {
            displayLine = values.map(v => (v===null || v===undefined) ? 'N/A' : isNaN(v)? 'NaN' : (typeof v === 'number' ? v.toFixed(3) : String(v))).join(', ');
        } else {
            displayLine = "[No Data]";
        }
        // Append formatted line with timestamp and module-added newline to buffer
        rawOutputBuffer += `${displayTimeStr}: ${displayLine}\r\n`;
    }

    // --- Write buffer to terminal based on time interval ---
    if (terminalInstance && rawOutputBuffer.length > 0 && (now - lastTerminalWriteTime >= TERMINAL_UPDATE_INTERVAL_MS)) {
        // Clean up consecutive newlines before writing
        const cleanedBuffer = rawOutputBuffer.replace(/(?:\r?\n\s*){2,}/g, '\r\n');
        terminalInstance.write(cleanedBuffer);
        rawOutputBuffer = ''; // Clear buffer
        lastTerminalWriteTime = now; // Update last write time
        // terminalInstance.scrollToBottom(); // Optional scroll
    }
}

export function resize() {
    if (!fitAddonInstance || !isInitialized) return;
    try { fitAddonInstance.fit(); } catch (e) { console.warn("Terminal fit error:", e); }
}

export function updateConfig(newConfig) {
    if (!isInitialized) return;
    // Handle only rawDisplayMode changes now
    if (newConfig.rawDisplayMode !== undefined && newConfig.rawDisplayMode !== internalConfig.rawDisplayMode) {
        handleInternalFormatChange(newConfig.rawDisplayMode); // Use the handler which includes flushing
    }
    // updateDivider logic removed
}

export function clear() {
    if (!isInitialized) return;
    if (terminalInstance) {
        terminalInstance.clear();
        terminalInstance.write('Terminal cleared.\r\n');
    }
    updateParsedDataDisplayInternal([]);
    // batchCounter removed
}

export function destroy() {
    if (!isInitialized) return;
    flushRawOutputBuffer(); // Flush pending output first

    isInitialized = false;
    if (rawStrBtnElement) { rawStrBtnElement.removeEventListener('click', boundStrHandler); rawStrBtnElement = null; }
    if (rawHexBtnElement) { rawHexBtnElement.removeEventListener('click', boundHexHandler); rawHexBtnElement = null; }
    if (terminalInstance) { terminalInstance.dispose(); }

    terminalInstance = null;
    fitAddonInstance = null;
    parsedDataDisplayElement = null;
    textDecoder = null;
    rawOutputBuffer = '';
    lastTerminalWriteTime = 0;
    internalConfig = { rawDisplayMode: 'str' };

    console.log("Terminal Module Destroyed.");
}

console.log("terminal_module.js (Time-based Update, Buffering) loaded.");