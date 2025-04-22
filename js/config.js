// js/config.js

// --- Core Behavior Constants ---
export const ESTIMATION_UPDATE_INTERVAL_MS = 1000; // How often buffer estimation runs (ms)
// --- Buffer & Logging Constants ---
export const MAX_RAW_TEXT_LINES_DISPLAY = 1000; // Max lines shown in the raw text area
export const MAX_RAW_LOG_BUFFER_LINES = 10000; // Max lines kept in the raw log memory buffer
export const DEFAULT_MAX_BUFFER_POINTS = 120000; // Default max points for TimeChart/CSV buffer (matches HTML default)
export const MIN_BUFFER_POINTS = 1000; // Minimum allowed buffer points

// --- Charting Constants ---
export const seriesColors = [
  // Default colors for TimeChart series
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
  "#aec7e8",
  "#ffbb78",
  "#98df8a",
  "#ff9896",
  "#c5b0d5",
  "#c49c94",
];
export const ZOOM_FACTOR = 1.1; // Factor for wheel zoom in TimeChart custom interaction

// --- Simulation Defaults ---
export const DEFAULT_SIM_CHANNELS = 1;
export const DEFAULT_SIM_FREQUENCY = 1000;
export const DEFAULT_SIM_AMPLITUDE = 1;

// --- Serial Defaults ---
export const DEFAULT_BAUD_RATE = 115200;
// Add other serial defaults if needed

// --- Terminal View ---
export const TERMINAL_UPDATE_INTERVAL_MS = 40;

// Base time calculation (consider if needed globally or just in timechart init)
// Using performance.now() relative timestamps might be simpler if baseTime is handled well by TimeChart
// export const performanceTimeToDateEpochOffset = Date.now() - performance.now();
// export const baseTimeForChart = 0; // Or performanceTimeToDateEpochOffset, or null

console.log("config.js loaded"); // For debugging load order
