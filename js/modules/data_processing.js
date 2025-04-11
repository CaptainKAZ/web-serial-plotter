// js/modules/data_processing.js (Complete, Revised for xterm.js)

import {
    // Import necessary constants
    MAX_RAW_LOG_BUFFER_LINES, // Still potentially useful for xterm scrollback? Or remove if unused.
    DEFAULT_MAX_BUFFER_POINTS,
    ESTIMATION_UPDATE_INTERVAL_MS
} from '../config.js';
import { formatSecondsToHMS } from '../utils.js';
// Import update function for quaternion view if needed, ensure it queries elements
import { updateQuaternionView } from './quaternion.js';

// Note: State is managed in main.js and passed via stateRef where needed.

// --- Parsed Data Display ---
/**
 * Updates the parsed data display area showing latest channel values.
 * @param {Array<number>} latestValuesRef - Reference to the latestParsedValues array.
 */
function updateParsedDataDisplay(latestValuesRef) {
    // Query element when needed
    const parsedDataDisplayEl = document.getElementById('parsedDataDisplay');
    if (!parsedDataDisplayEl) return;

    if (!latestValuesRef || latestValuesRef.length === 0) {
        parsedDataDisplayEl.innerHTML = `<span class="text-gray-400 text-xs italic">等待数据...</span>`;
        return;
    }
    let htmlContent = '';
    latestValuesRef.forEach((value, index) => {
        let displayValue = 'N/A';
        if (value !== null && value !== undefined && isFinite(value)) {
            displayValue = value.toFixed(3);
        } else if (isNaN(value)) {
            displayValue = 'NaN';
        }
        htmlContent += `<div class="channel-value"><span class="channel-label">通道 ${index + 1}:</span>${displayValue}</div>`;
    });
    parsedDataDisplayEl.innerHTML = htmlContent;
}

// --- Buffer Management (CSV) ---
/**
 * Trims the main data buffer (for CSV) to the maximum allowed points.
 * @param {Array<object>} bufferRef - Reference to the dataBuffer array.
 * @param {number} currentMaxPoints - The current maxBufferPoints value.
 */
function trimDataBuffer(bufferRef, currentMaxPoints) {
    const pointsToRemove = bufferRef.length - currentMaxPoints;
    if (pointsToRemove > 0) {
        bufferRef.splice(0, pointsToRemove);
    }
}

// --- Buffer Status & Estimation ---
/**
 * Updates the buffer usage bar and status text UI elements.
 */
function updateBufferStatusUI(currentPoints, maxPoints, collecting, estimateRemainingSec, estimateTotalSec) {
    // Query elements when needed
    const bufferUsageBarEl = document.getElementById('bufferUsageBar');
    const bufferStatusEl = document.getElementById('bufferStatus');
    if (!bufferUsageBarEl || !bufferStatusEl) return;

    const usagePercent = maxPoints > 0 ? Math.min(100, (currentPoints / maxPoints) * 100) : 0;
    bufferUsageBarEl.style.width = `${usagePercent.toFixed(1)}%`;

    let statusText = `缓冲点数: ${currentPoints.toLocaleString()} / ${maxPoints.toLocaleString()}`;
    if (collecting) {
        if (estimateRemainingSec !== null && estimateRemainingSec >= 0 && estimateTotalSec !== null && estimateTotalSec > 0) {
            if (usagePercent >= 99.9 || estimateRemainingSec <= 0.1) { statusText += ` <br /> 已满 (约 ${formatSecondsToHMS(estimateTotalSec)})`; }
            else { statusText += `<br /> 预计剩余: ${formatSecondsToHMS(estimateRemainingSec)} / ${formatSecondsToHMS(estimateTotalSec)}`; }
        } else { statusText += `<br /> 预计剩余: 计算中...`; }
    }
    bufferStatusEl.innerHTML = statusText;
}

/**
 * Calculates the estimated buffer time remaining based on current rate.
 * @param {object} stateRef - Reference to the main state object.
 */
export function calculateBufferEstimate(stateRef) {
    const { dataBuffer, maxBufferPoints, isCollecting, currentDataRateHz } = stateRef;
    const currentPoints = dataBuffer.length;
    const remainingPoints = maxBufferPoints - currentPoints;

    if (isCollecting && currentDataRateHz > 0 && maxBufferPoints > 0) {
        stateRef.estimatedBufferTimeSec = maxBufferPoints / currentDataRateHz;
        stateRef.estimatedBufferTimeRemainingSec = (remainingPoints <= 0) ? 0 : remainingPoints / currentDataRateHz;
    } else {
        stateRef.estimatedBufferTimeRemainingSec = null;
        stateRef.estimatedBufferTimeSec = null;
    }
    // Update UI immediately after calculation
    updateBufferStatusUI(
        currentPoints,
        maxBufferPoints,
        isCollecting,
        stateRef.estimatedBufferTimeRemainingSec,
        stateRef.estimatedBufferTimeSec
    );
}

/**
 * Starts the interval timer for calculating and updating buffer estimates.
 * @param {Function} estimateFn - The calculateBufferEstimate function.
 * @param {object} stateRef - Reference to the main state object.
 * @returns {number} The interval timer ID.
 */
export function startBufferEstimationTimer(estimateFn, stateRef) {
    if (stateRef.bufferEstimateInterval) clearInterval(stateRef.bufferEstimateInterval);
    console.log("Buffer estimation timer started.");
    estimateFn(stateRef); // Run once immediately
    stateRef.bufferEstimateInterval = setInterval(() => estimateFn(stateRef), ESTIMATION_UPDATE_INTERVAL_MS);
    return stateRef.bufferEstimateInterval;
}

/**
 * Stops the buffer estimation interval timer.
 * @param {object} stateRef - Reference to the main state object.
 */
export function stopBufferEstimationTimer(stateRef) {
    if (stateRef.bufferEstimateInterval) {
        clearInterval(stateRef.bufferEstimateInterval);
        stateRef.bufferEstimateInterval = null;
        console.log("Buffer estimation timer stopped.");
    }
}

// --- Data Rate ---
/**
 * Updates the data rate display UI element.
 * @param {number} rate - The calculated data rate in Hz.
 */
function updateDataRateDisplayUI(rate) {
    const dataRateDisplayEl = document.getElementById('dataRateDisplay');
    if (dataRateDisplayEl) {
        dataRateDisplayEl.textContent = `速率: ${rate.toFixed(1)} Hz`;
    }
}

// --- Main Queue Processing ---
/**
 * Processes items from the queue, updates chart, parsed data, quaternion,
 * and writes formatted lines to the xterm.js terminal.
 * @param {object} stateRef - Reference to the main state object.
 * @param {TimeChart} timeChartInstance - The TimeChart instance.
 * @param {object} quaternionChannelIndices - Current W,X,Y,Z channel indices.
 */
export function processMainThreadQueue(stateRef, timeChartInstance, quaternionChannelIndices) {
    if (stateRef.mainThreadDataQueue.length === 0) return; // No data to process

    const termInstance = stateRef.terminalInstance; // Get terminal instance
    // Exit if terminal isn't ready, but still process chart/other data if needed?
    // For simplicity, let's process everything only if terminal is available,
    // as raw data display is key. Adjust if chart should update independently.
    if (!termInstance) {
        // Drain the queue to prevent memory build-up even if terminal isn't ready
        stateRef.mainThreadDataQueue.length = 0;
        return;
    }

    const itemsToProcess = stateRef.mainThreadDataQueue.splice(0, stateRef.mainThreadDataQueue.length);
    let lastItemForUI = null;
    let pointsAddedToChart = 0;
    const chartSeries = timeChartInstance?.options?.series;
    const numChartSeries = chartSeries?.length || 0;
    let terminalOutputBuffer = ''; // Buffer for batching writes to xterm

    for (const item of itemsToProcess) {
        if (!item || typeof item.timestamp !== 'number' || !Array.isArray(item.values)) continue;
        const { timestamp, values, rawLineBytes } = item;
        const validatedValues = values.map(v => (typeof v === 'number' && isFinite(v)) ? v : NaN);

        stateRef.latestWorkerTimestamp = timestamp;
        stateRef.latestParsedValues = validatedValues;
        lastItemForUI = item;

        // 1. Add data to TimeChart series arrays
        if (chartSeries) {
            const numDataChannels = validatedValues.length;
            for (let i = 0; i < Math.min(numDataChannels, numChartSeries); i++) {
                const seriesData = chartSeries[i]?.data;
                if (seriesData && (seriesData.length === 0 || timestamp >= seriesData[seriesData.length - 1].x)) {
                    seriesData.push({ x: timestamp, y: validatedValues[i] });
                    pointsAddedToChart++;
                }
            }
        }

        // 2. Format line for Terminal and add to batch buffer
        const displayTimeStr = (timestamp / 1000.0).toFixed(3);
        let displayLine = '';
        if (rawLineBytes != null && rawLineBytes.byteLength > 0) {
            if (stateRef.rawDisplayMode === 'hex') {
                displayLine = Array.from(rawLineBytes).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
            } else { // 'str' mode
                try {
                    const decoder = new TextDecoder('utf-8', { fatal: false });
                    displayLine = decoder.decode(rawLineBytes);
                    // Replace non-printable characters (excluding \t, \n, \r)
                    displayLine = displayLine.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '.');
                } catch (e) {
                    displayLine = "[解码错误]"; // Decoding Error in Chinese
                }
            }
        } else if (values && values.length > 0) { // Fallback to parsed values
            displayLine = values.map(v => (v === null || v === undefined) ? 'N/A' : isNaN(v) ? 'NaN' : typeof v === 'number' ? v.toFixed(3) : String(v)).join(', ');
        } else {
            displayLine = "[无数据]"; // No Data in Chinese
        }
        // Add formatted line with CRLF for terminal
        terminalOutputBuffer += `${displayTimeStr}: ${displayLine}\r\n`;

        // 3. Add to CSV Data Buffer
        stateRef.dataBuffer.push({ timestamp, values: validatedValues });

        // 4. Update data rate counter
        stateRef.dataPointCounter++;
    } // End processing item loop

    // --- After processing batch ---

    // Write the entire batch to the terminal if anything was generated
    if (terminalOutputBuffer.length > 0) {
        termInstance.write(terminalOutputBuffer);
        // Scroll to bottom after writing batch to maintain follow effect in terminal
        termInstance.scrollToBottom();
    }

    // 5. Trim TimeChart data arrays
    if (pointsAddedToChart > 0 && chartSeries) {
        const maxPoints = stateRef.maxBufferPoints;
        for (let i = 0; i < numChartSeries; i++) {
            const seriesData = chartSeries[i]?.data;
            if (seriesData) {
                const pointsToRemove = seriesData.length - maxPoints;
                if (pointsToRemove > 0) seriesData.splice(0, pointsToRemove);
            }
        }
    }

    // 6. Update TimeChart View if data was added
    if (pointsAddedToChart > 0 && timeChartInstance) {
        try { timeChartInstance.update(); } catch (e) { console.error("Error during timeChartInstance.update():", e); }
    }

    // 7. Update other UI based on last item (Parsed Data, Quaternion)
    if (lastItemForUI) {
        updateParsedDataDisplay(stateRef.latestParsedValues);
        // --- Quaternion Update Logic ---
        const { w, x, y, z } = quaternionChannelIndices;
        const hasAllIndices = w !== null && x !== null && y !== null && z !== null;
        const indicesAreUnique = hasAllIndices && (new Set([w, x, y, z])).size === 4;
        const indicesAreValid = hasAllIndices && [w, x, y, z].every(idx => idx < stateRef.latestParsedValues.length);
        const quatErrorOverlayEl = document.getElementById('quaternionErrorOverlay'); // Query here
        if (indicesAreValid && indicesAreUnique) {
            updateQuaternionView(stateRef.latestParsedValues[w], stateRef.latestParsedValues[x], stateRef.latestParsedValues[y], stateRef.latestParsedValues[z]);
            if (quatErrorOverlayEl) quatErrorOverlayEl.style.display = 'none';
        } else {
            if (Object.values(quaternionChannelIndices).some(idx => idx !== null)) {
                if (quatErrorOverlayEl) { quatErrorOverlayEl.textContent = "请确保选择了 4 个唯一有效的通道 (W, X, Y, Z)"; quatErrorOverlayEl.style.display = 'flex'; }
            } else { if (quatErrorOverlayEl) quatErrorOverlayEl.style.display = 'none'; }
        }
        // --- End Quaternion Update ---
    }

    // 8. **NO LONGER NEEDED: updateRawTextAreaUI / updateRawTextAreaOptimized**

    // 9. Trim CSV Data Buffer
    trimDataBuffer(stateRef.dataBuffer, stateRef.maxBufferPoints);

    // 10. Update Buffer Status UI
    updateBufferStatusUI(stateRef.dataBuffer.length, stateRef.maxBufferPoints, stateRef.isCollecting, stateRef.estimatedBufferTimeRemainingSec, stateRef.estimatedBufferTimeSec);

    // 11. Update Data Rate Display periodically
    const now = performance.now();
    const rateDelta = now - stateRef.lastRateCheckTime;
    if (rateDelta >= 1000) {
        const rate = (stateRef.dataPointCounter * 1000) / rateDelta;
        stateRef.currentDataRateHz = rate;
        updateDataRateDisplayUI(rate);
        stateRef.dataPointCounter = 0;
        stateRef.lastRateCheckTime = now;
    }
}


// --- Data Export & Clearing ---

/**
 * Generates and triggers the download of dataBuffer content as a CSV file.
 * @param {Array<object>} dataBufferRef - Reference to the dataBuffer array.
 * @param {Array<{name: string}>} chartSeriesRef - Reference to TimeChart series options for headers.
 */
export function downloadCSV(dataBufferRef, chartSeriesRef) {
    if (!dataBufferRef || dataBufferRef.length === 0) { alert("没有数据可以下载。"); return; }
    console.log("Generating CSV from dataBuffer...");
    const numPoints = dataBufferRef.length;
    const numChannels = dataBufferRef[0]?.values?.length || 0;
    if (numChannels === 0) { alert("缓冲区中未找到通道数据。"); return; }

    let header = "Timestamp (s)";
    for (let i = 0; i < numChannels; i++) { const seriesName = chartSeriesRef?.[i]?.name || `通道 ${i + 1}`; header += `,${seriesName}`; }
    header += "\n";

    new Promise((resolve, reject) => {
        try {
            const rows = [header];
            for (let i = 0; i < numPoints; i++) { /* ... format rows ... */
                const entry = dataBufferRef[i]; if (!entry || typeof entry.timestamp !== 'number' || !Array.isArray(entry.values)) continue;
                let rowValues = [(entry.timestamp / 1000.0).toFixed(6)];
                for (let ch = 0; ch < numChannels; ch++) { const value = entry.values[ch]; rowValues.push((typeof value === 'number' && isFinite(value)) ? value.toFixed(6) : ''); }
                rows.push(rowValues.join(','));
            } resolve(rows.join('\n'));
        } catch (error) { reject(error); }
    }).then(csvContent => { /* ... Blob and download link logic ... */
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement("a"); const url = URL.createObjectURL(blob); link.setAttribute("href", url); const timestamp = new Date().toISOString().replace(/[:.]/g, '-'); link.setAttribute("download", `web_plotter_data_${timestamp}.csv`); link.style.visibility = 'hidden'; document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url); console.log("CSV download initiated.");
    }).catch(error => { console.error("Error generating CSV:", error); alert("导出 CSV 时出错: " + error.message); });
}

/**
 * Clears all collected data from buffers, resets relevant state, and clears the xterm terminal.
 * @param {object} stateRef - Reference to the main state object.
 * @param {Function} reinitChartCallback - Function to call to re-initialize the TimeChart.
 */
export function clearAllData(stateRef, reinitChartCallback) {
    console.log("Clearing all data (including terminal)...");
    stopBufferEstimationTimer(stateRef);

    // Reset state properties
    stateRef.mainThreadDataQueue = [];
    stateRef.dataBuffer = [];
    // No rawLogBuffer to clear
    stateRef.latestWorkerTimestamp = 0;
    stateRef.latestParsedValues = [];
    stateRef.currentDataRateHz = 0;
    stateRef.estimatedBufferTimeRemainingSec = null;
    stateRef.estimatedBufferTimeSec = null;
    stateRef.dataPointCounter = 0;
    stateRef.lastRateCheckTime = performance.now();
    stateRef.maxBufferPoints = DEFAULT_MAX_BUFFER_POINTS; // Reset state value

    // Query and reset buffer duration input value
    const bufferDurationInputEl = document.getElementById('bufferDurationInput');
    if (bufferDurationInputEl) bufferDurationInputEl.value = DEFAULT_MAX_BUFFER_POINTS;

    // Clear the xterm.js terminal using its API
    stateRef.terminalInstance?.clear();
    stateRef.terminalInstance?.write('终端已清空。\r\n'); // Optional message


    // Clear other UI Elements (query internally)
    updateParsedDataDisplay([]);
    const quatErrorOverlayEl = document.getElementById('quaternionErrorOverlay'); if (quatErrorOverlayEl) quatErrorOverlayEl.style.display = 'none';
    updateDataRateDisplayUI(0);
    const quatFpsDisplayEl = document.getElementById('quatFpsDisplay'); if (quatFpsDisplayEl) quatFpsDisplayEl.textContent = '帧率: --';


    // Update buffer status UI
    updateBufferStatusUI(0, stateRef.maxBufferPoints, stateRef.isCollecting, null, null);

    // Reinitialize chart
    if (typeof reinitChartCallback === 'function') {
        reinitChartCallback();
    }

    console.log("Data cleared.");
}

/**
 * Handles the change event for the raw data display format buttons (STR/HEX).
 * Updates the rawDisplayMode state. Formatting is applied during write.
 * @param {string} newMode - The new mode ('str' or 'hex').
 * @param {object} stateRef - Reference to the main state object.
 */
export function handleRawFormatChange(newMode, stateRef) {
    // Query buttons when needed
    const rawStrBtnEl = document.getElementById('rawStrBtn');
    const rawHexBtnEl = document.getElementById('rawHexBtn');

    if (stateRef.rawDisplayMode !== newMode) {
        stateRef.rawDisplayMode = newMode;
        if (rawStrBtnEl) rawStrBtnEl.classList.toggle('active', newMode === 'str');
        if (rawHexBtnEl) rawHexBtnEl.classList.toggle('active', newMode === 'hex');
        console.log(`Raw display mode changed to: ${newMode}.`);
        // No terminal redraw needed here, future writes will use the new format.
    }
}

console.log("data_processing.js loaded (final xterm.js version)");