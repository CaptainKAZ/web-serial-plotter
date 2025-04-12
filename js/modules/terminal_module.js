// Manages xterm.js terminal AND the parsed data display area.
// Includes update frequency division.

let terminalInstance = null;
let fitAddonInstance = null;
let rawStrBtnElement = null;
let rawHexBtnElement = null;
let parsedDataDisplayElement = null;
let isInitialized = false;
let textDecoder = null;

let internalConfig = {
    rawDisplayMode: 'str',
    updateDivider: 1 // Default: Update every batch
};
let batchCounter = 0; // Counter for update division

// --- Internal Helper ---
function updateParsedDataDisplayInternal(latestValues) {
    if (!parsedDataDisplayElement) return;
    if (!latestValues || latestValues.length === 0) {
        parsedDataDisplayElement.innerHTML = `<span class="text-gray-400 text-xs italic">等待数据...</span>`;
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

// --- Internal Event Handlers ---
function handleInternalFormatChange(newMode) {
    if (internalConfig.rawDisplayMode !== newMode) {
        internalConfig.rawDisplayMode = newMode;
        rawStrBtnElement?.classList.toggle('active', newMode === 'str');
        rawHexBtnElement?.classList.toggle('active', newMode === 'hex');
    }
}

let boundStrHandler = () => handleInternalFormatChange('str');
let boundHexHandler = () => handleInternalFormatChange('hex');

// --- Display Module Interface Implementation ---

export function create(elementId, initialState = {}) {
    if (isInitialized) return true;
    const containerElement = document.getElementById(elementId);
    if (!containerElement) { console.error(`Terminal Module: Container #${elementId} not found.`); return false; }

    const targetDiv = containerElement.querySelector('#terminal');
    parsedDataDisplayElement = containerElement.querySelector('#parsedDataDisplay');
    rawStrBtnElement = containerElement.querySelector('#rawStrBtn');
    rawHexBtnElement = containerElement.querySelector('#rawHexBtn');

    if (!targetDiv || !parsedDataDisplayElement || !rawStrBtnElement || !rawHexBtnElement) {
        console.error("Terminal Module: Could not find all internal elements."); return false;
    }
    const Terminal = window.Terminal; const FitAddon = window.FitAddon?.FitAddon;
    if (!Terminal || !FitAddon) { console.error("xterm.js or FitAddon library not loaded."); return false; }

    // Merge initial state, ensuring updateDivider is at least 1
    internalConfig = { ...internalConfig, ...initialState };
    internalConfig.updateDivider = Math.max(1, parseInt(internalConfig.updateDivider) || 1);
    batchCounter = 0; // Initialize counter
    textDecoder = new TextDecoder('utf-8', { fatal: false });

    try {
        terminalInstance = new Terminal({ /* ... terminal options ... */
             fontFamily: 'Consolas, "Liberation Mono", Menlo, Courier, monospace', fontSize: 13,
             theme: { background: '#FFFFFF', foreground: '#000000', cursor: '#000000', selectionBackground: '#A9A9A9' },
             cursorBlink: false, convertEol: true, scrollback: 5000, disableStdin: true, windowsMode: false
         });
        fitAddonInstance = new FitAddon();
        terminalInstance.loadAddon(fitAddonInstance);
        terminalInstance.open(targetDiv);
        fitAddonInstance.fit();
        terminalInstance.write(`终端初始化完毕 (更新分频: ${internalConfig.updateDivider})...\r\n`);
        updateParsedDataDisplayInternal([]);

        rawStrBtnElement.classList.toggle('active', internalConfig.rawDisplayMode === 'str');
        rawHexBtnElement.classList.toggle('active', internalConfig.rawDisplayMode === 'hex');
        rawStrBtnElement.addEventListener('click', boundStrHandler);
        rawHexBtnElement.addEventListener('click', boundHexHandler);

        isInitialized = true;
        console.log(`Terminal Module Created (Update Divider: ${internalConfig.updateDivider}).`);
        return true;
    } catch (error) {
        console.error("Error initializing xterm.js:", error);
        isInitialized = false; terminalInstance = null; fitAddonInstance = null;
        return false;
    }
}

export function processDataBatch(batch) {
    if (!isInitialized || batch.length === 0) return;

    batchCounter++;
    let latestValuesForDisplay = null; // Track latest values for parsed display

    // Find the last valid 'values' array in the batch for the parsed display
    for (let i = batch.length - 1; i >= 0; i--) {
        if (batch[i] && Array.isArray(batch[i].values)) {
            latestValuesForDisplay = batch[i].values;
            break;
        }
    }

    // --- Update Terminal only every 'updateDivider' batches ---
    if (batchCounter >= internalConfig.updateDivider) {
        batchCounter = 0; // Reset counter

        if (latestValuesForDisplay !== null) {
            updateParsedDataDisplayInternal(latestValuesForDisplay);
        }

        if (!terminalInstance) return; // Extra safety check

        let terminalOutputBuffer = '';
        for (const item of batch) {
            if (!item || typeof item.timestamp !== 'number') continue;
            const { timestamp, values, rawLineBytes } = item;
            const displayTimeStr = (timestamp / 1000.0).toFixed(3);
            let displayLine = '';

            if (rawLineBytes instanceof Uint8Array && rawLineBytes.byteLength > 0) {
                if (internalConfig.rawDisplayMode === 'hex') {
                    displayLine = Array.prototype.map.call(rawLineBytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
                } else {
                     try {
                        displayLine = textDecoder.decode(rawLineBytes).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '.');
                     } catch (e) { displayLine = "[解码错误]"; }
                }
            } else if (Array.isArray(values) && values.length > 0) {
                 displayLine = values.map(v => (v===null || v===undefined) ? 'N/A' : isNaN(v)? 'NaN' : (typeof v === 'number' ? v.toFixed(3) : String(v))).join(', ');
            } else {
                 displayLine = "[无有效数据]";
            }
            terminalOutputBuffer += `${displayTimeStr}: ${displayLine}\r\n`;
        }

        if (terminalOutputBuffer) {
            terminalInstance.write(terminalOutputBuffer);
            // terminalInstance.scrollToBottom(); // Optional explicit scroll
        }
    }
}

export function resize() {
    if (!fitAddonInstance || !isInitialized) return;
    try { fitAddonInstance.fit(); } catch (e) { /* Ignore */ }
}

export function updateConfig(newConfig) {
    if (!isInitialized) return;
    if (newConfig.rawDisplayMode !== undefined && newConfig.rawDisplayMode !== internalConfig.rawDisplayMode) {
        internalConfig.rawDisplayMode = newConfig.rawDisplayMode;
        rawStrBtnElement?.classList.toggle('active', internalConfig.rawDisplayMode === 'str');
        rawHexBtnElement?.classList.toggle('active', internalConfig.rawDisplayMode === 'hex');
    }
    // Update divider if provided and valid
    if (newConfig.updateDivider !== undefined) {
        const newDivider = Math.max(1, parseInt(newConfig.updateDivider) || 1);
        if (newDivider !== internalConfig.updateDivider) {
            internalConfig.updateDivider = newDivider;
            batchCounter = 0; // Reset counter when divider changes
            console.log(`Terminal Module Update Divider set to: ${internalConfig.updateDivider}`);
        }
    }
}

export function clear() {
    if (!isInitialized) return;
    if (terminalInstance) {
        terminalInstance.clear();
        terminalInstance.write('终端已清空。\r\n');
    }
    updateParsedDataDisplayInternal([]);
    batchCounter = 0; // Reset counter on clear
}

export function destroy() {
    if (!isInitialized) return;
    isInitialized = false;
    if (rawStrBtnElement) { rawStrBtnElement.removeEventListener('click', boundStrHandler); rawStrBtnElement = null; }
    if (rawHexBtnElement) { rawHexBtnElement.removeEventListener('click', boundHexHandler); rawHexBtnElement = null; }
    if (terminalInstance) { terminalInstance.dispose(); }
    terminalInstance = null; fitAddonInstance = null; parsedDataDisplayElement = null; textDecoder = null;
    internalConfig = { rawDisplayMode: 'str', updateDivider: 1 }; // Reset config
    batchCounter = 0;
    console.log("Terminal Module Destroyed.");
}

console.log("terminal_module.js (incl. Parsed Data & Update Divider) loaded.");