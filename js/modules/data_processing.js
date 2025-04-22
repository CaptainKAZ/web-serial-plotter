// js/modules/data_processing.js
// Manages the data buffer for CSV export and calculates rate/estimates.

import { formatSecondsToHMS } from "../utils.js";

// --- Module State ---
let dataBuffer = []; // Buffer specifically for CSV export/download
let currentDataRateHz = 0;
let estimatedBufferTimeRemainingSec = null;
let estimatedBufferTimeSec = null;
let dataPointCounter = 0;
let lastRateCheckTime = 0;

// --- Buffer Management ---

/**
 * Adds data points from a batch to the internal CSV buffer.
 * @param {Array<object>} batch - Array of data items { timestamp, values, ... }.
 */
export function addToBuffer(batch) {
  for (const item of batch) {
    // Ensure basic structure is present
    if (
      !item ||
      typeof item.timestamp !== "number" ||
      !Array.isArray(item.values)
    )
      continue;
    // Store only timestamp and validated values for CSV
    dataBuffer.push({
      timestamp: item.timestamp,
      values: item.values.map((v) =>
        typeof v === "number" && isFinite(v) ? v : NaN
      ), // Sanitize values
    });
  }
}

/**
 * Trims the internal CSV data buffer to the specified maximum number of points.
 * @param {number} maxPoints - The maximum number of points to keep.
 */
export function trimDataBuffer(maxPoints) {
  const pointsToRemove = dataBuffer.length - maxPoints;
  if (pointsToRemove > 0) {
    dataBuffer.splice(0, pointsToRemove);
  }
}

/**
 * Returns the current number of points in the CSV buffer.
 * @returns {number}
 */
export function getBufferLength() {
  return dataBuffer.length;
}

/**
 * Clears the internal CSV data buffer.
 */
export function clearBuffer() {
  dataBuffer = [];
}

// --- Data Rate Calculation ---

/**
 * Updates the internal data rate calculation based on processed points and time.
 * @param {number} pointsInBatch - Number of data points/timestamps processed.
 * @param {number} currentTimestamp - The timestamp of the latest data point (performance.now() based).
 */
export function updateDataRate(pointsInBatch, currentTimestamp) {
  if (pointsInBatch > 0) {
    dataPointCounter += pointsInBatch;
  }
  const now = currentTimestamp; // Use timestamp from data processing loop
  const rateDelta = now - lastRateCheckTime;

  if (rateDelta >= 1000) {
    // Update rate calculation roughly every second
    currentDataRateHz = (dataPointCounter * 1000) / rateDelta;
    dataPointCounter = 0;
    lastRateCheckTime = now;
  } else if (
    performance.now() - lastRateCheckTime > 2000 &&
    pointsInBatch === 0
  ) {
    // Decay rate to 0 if no data received for a while
    currentDataRateHz = 0;
    dataPointCounter = 0; // Reset counter
    lastRateCheckTime = performance.now(); // Update check time to avoid rapid resets
  }
}

/**
 * Gets the currently calculated data rate. Handles decay if inactive.
 * @returns {number} Data rate in Hz.
 */
export function getCurrentDataRate() {
  // Check for decay if called long after last update
  if (performance.now() - lastRateCheckTime > 2000 && dataPointCounter === 0) {
    currentDataRateHz = 0;
  }
  return currentDataRateHz;
}

// --- Buffer Time Estimation ---

/**
 * Calculates the estimated total buffer time and remaining time based on current state.
 * @param {number} rate - Current data rate in Hz.
 * @param {number} currentPoints - Current number of points in the buffer.
 * @param {number} maxPoints - Maximum points the buffer can hold.
 * @param {boolean} isCollecting - Whether data collection is active.
 */
export function calculateBufferEstimate(
  rate,
  currentPoints,
  maxPoints,
  isCollecting
) {
  const remainingPoints = maxPoints - currentPoints;
  if (isCollecting && rate > 0 && maxPoints > 0) {
    estimatedBufferTimeSec = maxPoints / rate;
    estimatedBufferTimeRemainingSec =
      remainingPoints <= 0 ? 0 : remainingPoints / rate;
  } else {
    estimatedBufferTimeRemainingSec = null;
    estimatedBufferTimeSec = null;
  }
}

/**
 * Gets the estimated remaining buffer time in seconds.
 * @returns {number | null}
 */
export function getEstimateRemaining() {
  return estimatedBufferTimeRemainingSec;
}

/**
 * Gets the estimated total buffer time in seconds.
 * @returns {number | null}
 */
export function getEstimateTotal() {
  return estimatedBufferTimeSec;
}

/**
 * Resets the rate and estimation calculation states.
 */
export function resetEstimatesAndRate() {
  currentDataRateHz = 0;
  estimatedBufferTimeRemainingSec = null;
  estimatedBufferTimeSec = null;
  dataPointCounter = 0;
  lastRateCheckTime = performance.now();
}

// --- Data Export ---

/**
 * Generates and triggers the download of the internal dataBuffer as a CSV file.
 * @param {Array<{name: string}> | null} chartSeriesRef - Optional array of series objects (like [{name: 'Ch 1'}, ...]) for header names.
 */
export function downloadCSV(chartSeriesRef = null) {
  if (!dataBuffer || dataBuffer.length === 0) {
    alert("没有数据可以下载。");
    return;
  }
  console.log("Generating CSV from dataProcessor buffer...");

  const numPoints = dataBuffer.length;
  const numChannels = dataBuffer[0]?.values?.length || 0;
  if (numChannels === 0) {
    alert("缓冲区中未找到通道数据。");
    return;
  }

  // Build Header Row
  let header = "Timestamp (s)";
  for (let i = 0; i < numChannels; i++) {
    // Use names from chart series if provided, otherwise default
    const seriesName = chartSeriesRef?.[i]?.name || `通道 ${i + 1}`;
    // Sanitize name for CSV (remove commas, quotes)
    const sanitizedName = seriesName.replace(/["',]/g, "");
    header += `,${sanitizedName}`;
  }
  header += "\n";

  // Process data rows (using Promise for potentially large data)
  new Promise((resolve, reject) => {
    try {
      const rows = [header];
      // Use map for potentially better performance? Or keep simple loop.
      for (let i = 0; i < numPoints; i++) {
        const entry = dataBuffer[i];
        // Skip invalid entries just in case
        if (
          !entry ||
          typeof entry.timestamp !== "number" ||
          !Array.isArray(entry.values)
        )
          continue;

        // Format timestamp (seconds with high precision)
        let rowValues = [(entry.timestamp / 1000.0).toFixed(6)];

        // Format channel values (numbers with high precision, empty for NaN/null/undefined)
        for (let ch = 0; ch < numChannels; ch++) {
          const value = entry.values[ch];
          rowValues.push(
            typeof value === "number" && isFinite(value) ? value.toFixed(6) : ""
          );
        }
        rows.push(rowValues.join(","));
      }
      resolve(rows.join("\n"));
    } catch (error) {
      reject(error);
    }
  })
    .then((csvContent) => {
      // Create Blob and trigger download
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      link.setAttribute("download", `web_plotter_data_${timestamp}.csv`);
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url); // Clean up object URL
      console.log("CSV download initiated.");
    })
    .catch((error) => {
      console.error("生成 CSV 时出错:", error);
      alert("导出 CSV 时出错: " + error.message);
    });
}

// --- UI Update Helpers (Called by main.js) ---
// These remain here as they directly visualize the state managed by this module.

export function updateBufferStatusUI(
  currentPoints,
  maxPoints,
  collecting,
  estimateRemainingSec,
  estimateTotalSec
) {
  const bufferUsageBarEl = document.getElementById("bufferUsageBar");
  const bufferStatusEl = document.getElementById("bufferStatus");
  if (!bufferUsageBarEl || !bufferStatusEl) return;

  const usagePercent =
    maxPoints > 0 ? Math.min(100, (currentPoints / maxPoints) * 100) : 0;
  bufferUsageBarEl.style.width = `${usagePercent.toFixed(1)}%`;

  let statusText = `缓冲点数: ${currentPoints.toLocaleString()} / ${maxPoints.toLocaleString()}`;
  if (collecting) {
    if (
      estimateRemainingSec !== null &&
      estimateRemainingSec >= 0 &&
      estimateTotalSec !== null &&
      estimateTotalSec > 0
    ) {
      if (usagePercent >= 99.9 || estimateRemainingSec <= 0.1) {
        statusText += ` <br /> 已满 (约 ${formatSecondsToHMS(
          estimateTotalSec
        )})`;
      } else {
        statusText += `<br /> 预计剩余: ${formatSecondsToHMS(
          estimateRemainingSec
        )} / ${formatSecondsToHMS(estimateTotalSec)}`;
      }
    } else {
      statusText += `<br /> 预计剩余: 计算中...`;
    }
  }
  bufferStatusEl.innerHTML = statusText; // Use innerHTML for <br>
}

// Note: updateParsedDataDisplay and updateDataRateDisplayUI are removed
// as those responsibilities are now handled by main.js loop and plot_module respectively.

console.log("data_processing.js (Refactored - Data Buffer/Stats only) loaded.");
