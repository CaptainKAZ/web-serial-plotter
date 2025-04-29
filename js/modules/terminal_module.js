// js/modules/terminal_module.js
// Manages the xterm.js terminal, parsed data display, and raw output buffering.

// Target update interval for the raw output terminal in milliseconds (e.g., 100ms = ~10 FPS)
import { TERMINAL_UPDATE_INTERVAL_MS } from "../config.js";

// Module state
let terminalInstance = null;
let fitAddonInstance = null;
let rawStrBtnElement = null;
let rawHexBtnElement = null;
let terminalEncodingSelectElement = null; // NEW: Reference to the encoding select dropdown
let parsedDataDisplayElement = null;
let isInitialized = false;
let textDecoder = null; // For decoding raw bytes
let currentEncoding = "utf-8"; // Default encoding, will be updated by recommendation

// Configuration and state for buffering/updates
let internalConfig = {
  rawDisplayMode: "str", // Initial display mode
};
let rawOutputBuffer = ""; // Buffer for raw terminal lines
let lastTerminalWriteTime = 0; // Timestamp of last terminal write

// --- Internal Helper Functions ---

function updateParsedDataDisplayInternal(latestValues) {
  if (!parsedDataDisplayElement) return;
  if (!latestValues || latestValues.length === 0) {
    parsedDataDisplayElement.innerHTML = `<span class="text-gray-400 text-xs italic">Waiting for data...</span>`;
    return;
  }
  let htmlContent = "";
  latestValues.forEach((value, index) => {
    let displayValue = "N/A";
    if (typeof value === "number" && isFinite(value)) {
      displayValue = value.toFixed(3);
    } else if (isNaN(value)) {
      displayValue = "NaN";
    }
    htmlContent += `<div class="channel-value"><span class="channel-label">ch${
      index + 1
    }:</span>${displayValue}</div>`;
  });
  parsedDataDisplayElement.innerHTML = htmlContent;
}

function handleInternalFormatChange(newMode) {
  if (internalConfig.rawDisplayMode !== newMode) {
    flushRawOutputBuffer(); // Flush buffer before changing mode
    internalConfig.rawDisplayMode = newMode;
    rawStrBtnElement?.classList.toggle("active", newMode === "str");
    rawHexBtnElement?.classList.toggle("active", newMode === "hex");


    if (terminalInstance)
      terminalInstance.write(
        `\r\n--- Display Mode Changed to ${internalConfig.rawDisplayMode.toUpperCase()} ---\r\n`
      );
  }
}

// --- Encoding Handling ---

// Tries to recommend an encoding based on browser language
function getRecommendedEncoding() {
  const lang = (navigator.language || navigator.userLanguage || "").toLowerCase();
  if (lang.startsWith("zh")) return "gbk"; // Simplified Chinese
  if (lang.startsWith("ja")) return "shift_jis"; // Japanese
  if (lang.startsWith("ko")) return "euc-kr"; // Korean
  // Default to UTF-8 for others
  return "utf-8";
}

// Handles changing the active text encoding based on dropdown selection
function handleEncodingChange() {
    if (!terminalEncodingSelectElement) return;
    const newEncoding = terminalEncodingSelectElement.value;
    console.log(`Attempting to change encoding to: ${newEncoding}`);

    try {
        // Test if the encoding is valid by creating a temporary decoder
        new TextDecoder(newEncoding);

        // Update the main TextDecoder instance
        textDecoder = new TextDecoder(newEncoding, { fatal: false }); // Use fatal: false to avoid throwing on errors
        currentEncoding = newEncoding; // Update state only if valid
        console.log(`TextDecoder updated to ${currentEncoding}`);

        // Ensure display mode is 'str' when changing encoding
        if (internalConfig.rawDisplayMode !== "str") {
            handleInternalFormatChange("str"); // Switch to text view (will also log the mode change)
        } else {
            // If already in 'str' mode, just log the encoding change
            if (terminalInstance) {
                terminalInstance.write(
                    `\r\n--- Text Encoding Changed to ${currentEncoding.toUpperCase()} ---\r\n`
                );
            }
        }

    } catch (error) {
        console.error(`Failed to set encoding ${newEncoding}:`, error);
        // Revert the dropdown selection back to the previous valid encoding
        terminalEncodingSelectElement.value = currentEncoding;
        if (terminalInstance) {
            terminalInstance.write(
                `\r\n--- Error: Invalid encoding '${newEncoding}'. Reverted to ${currentEncoding.toUpperCase()}. ---\r\n`
            );
        }
    }
}


// Bound event handlers for STR/HEX mode buttons
let boundStrModeHandler = () => handleInternalFormatChange("str"); // STR button changes display mode to text
let boundHexModeHandler = () => handleInternalFormatChange("hex"); // HEX button changes display mode to hex

// Helper to flush the raw output buffer immediately
function flushRawOutputBuffer() {
  if (terminalInstance && rawOutputBuffer.length > 0) {
    try {
      // Clean up consecutive newlines before writing
      const cleanedBuffer = rawOutputBuffer.replace(
        /(?:\r?\n\s*){2,}/g,
        "\r\n"
      );
      terminalInstance.write(cleanedBuffer);
      lastTerminalWriteTime = performance.now(); // Update time as we just wrote
    } catch (e) {
      console.warn("Error flushing terminal buffer:", e);
    }
  }
  rawOutputBuffer = ""; // Always clear buffer after attempting flush
}

// --- Display Module Interface Implementation ---

export function create(elementId, initialState = {}) {
  if (isInitialized) return true;
  const containerElement = document.getElementById(elementId);
  if (!containerElement) {
    console.error(`Terminal Module: Container #${elementId} not found.`);
    return false;
  }

  // Find internal elements
  const targetDiv = containerElement.querySelector("#terminal");
  parsedDataDisplayElement =
    containerElement.querySelector("#parsedDataDisplay");
  rawStrBtnElement = containerElement.querySelector("#rawStrBtn");
  rawHexBtnElement = containerElement.querySelector("#rawHexBtn");
  terminalEncodingSelectElement = containerElement.querySelector("#terminalEncodingSelect"); // Get the select element

  if (
    !targetDiv ||
    !parsedDataDisplayElement ||
    !rawStrBtnElement ||
    !rawHexBtnElement ||
    !terminalEncodingSelectElement // Check for the select element
  ) {
    console.error("Terminal Module: Could not find all required internal elements.");
    return false;
  }
  const Terminal = window.Terminal;
  const FitAddon = window.FitAddon?.FitAddon;
  if (!Terminal || !FitAddon) {
    console.error("xterm.js or FitAddon library not loaded.");
    return false;
  }

  // Merge initial state
  internalConfig = { ...internalConfig, ...initialState };

  // Initialize state variables
  rawOutputBuffer = "";
  lastTerminalWriteTime = 0;
  // Set initial encoding based on recommendation
  const recommendedEncoding = getRecommendedEncoding();
  currentEncoding = recommendedEncoding;
  terminalEncodingSelectElement.value = currentEncoding; // Set dropdown to recommended value

  try {
    textDecoder = new TextDecoder(currentEncoding, { fatal: false }); // Initialize with recommended encoding
  } catch (e) {
    console.error(`Failed to initialize TextDecoder with recommended encoding ${currentEncoding}:`, e);
    currentEncoding = "utf-8"; // Fallback to UTF-8
    terminalEncodingSelectElement.value = currentEncoding;
    textDecoder = new TextDecoder(currentEncoding, { fatal: false });
  }

  try {
    terminalInstance = new Terminal({
      fontFamily: 'Consolas, "Liberation Mono", Menlo, Courier, monospace',
      fontSize: 13,
      theme: {
        background: "#FFFFFF",
        foreground: "#000000",
        cursor: "#000000",
        selectionBackground: "#A9A9A9",
      },
      cursorBlink: false,
      convertEol: true,
      scrollback: 5000,
      disableStdin: true,
      windowsMode: false,
    });
    fitAddonInstance = new FitAddon();
    terminalInstance.loadAddon(fitAddonInstance);
    terminalInstance.open(targetDiv);
    fitAddonInstance.fit();
    terminalInstance.write(`Terminal Initialized.\r\n`);
    updateParsedDataDisplayInternal([]);
    // Initial UI state: STR active, HEX inactive, encoding select visible
    rawStrBtnElement.classList.add("active");
    rawHexBtnElement.classList.remove("active");
    terminalEncodingSelectElement.parentElement.style.display = ''; // Ensure encoding select is visible initially

    // Set up buttons and select dropdown
    rawStrBtnElement.addEventListener("click", boundStrModeHandler); // Use new handler
    rawHexBtnElement.addEventListener("click", boundHexModeHandler); // Use new handler
    terminalEncodingSelectElement.addEventListener("change", handleEncodingChange); // Listen for dropdown changes

    isInitialized = true;
    console.log(
      `Terminal Module Created (Time-based Update: ~${(
        1000 / TERMINAL_UPDATE_INTERVAL_MS
      ).toFixed(0)} FPS).`
    );
    return true;
  } catch (error) {
    console.error("Error initializing xterm.js:", error);
    isInitialized = false;
    terminalInstance = null;
    fitAddonInstance = null;
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
    if (!item || typeof item.timestamp !== "number") continue;
    const { timestamp, values, rawLineBytes } = item;
    const displayTimeStr = (timestamp / 1000.0).toFixed(3);
    let displayLine = "";

    if (rawLineBytes instanceof Uint8Array && rawLineBytes.byteLength > 0) {
      // --- Display based on mode ---
      if (internalConfig.rawDisplayMode === "hex") {
        // Show HEX button now that we have raw bytes (if not already visible)
        if (rawHexBtnElement?.classList.contains("hidden")) {
            rawHexBtnElement.classList.remove("hidden");
        }
        displayLine = Array.prototype.map
          .call(rawLineBytes, (b) =>
            b.toString(16).toUpperCase().padStart(2, "0")
          )
          .join(" ");
      } else {
        // STR mode (uses currentEncoding via textDecoder)
        try {
          // Ensure textDecoder is initialized and using the current encoding
          if (!textDecoder) {
              try {
                  textDecoder = new TextDecoder(currentEncoding, { fatal: false });
              } catch (err) {
                  console.error(`Failed to initialize TextDecoder with ${currentEncoding}, falling back to utf-8`, err);
                  currentEncoding = 'utf-8';
                  terminalEncodingSelectElement.value = currentEncoding; // Update dropdown if fallback occurs
                  textDecoder = new TextDecoder(currentEncoding, { fatal: false });
              }
          }
          let decodedString = textDecoder
            .decode(rawLineBytes, { stream: false }) // Use stream: false for complete lines
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "."); // Replace non-printable chars
          displayLine = decodedString.trimEnd(); // Remove trailing whitespace/newlines from source data
        } catch (e) {
          console.warn(`Decoding error with ${currentEncoding}:`, e);
          displayLine = "[Decode Error]";
          // No automatic fallback here, user must select a working encoding
        }
      }
    } else if (Array.isArray(values) && values.length > 0) {
      displayLine = values
        .map((v) =>
          v === null || v === undefined
            ? "N/A"
            : isNaN(v)
            ? "NaN"
            : typeof v === "number"
            ? v.toFixed(3)
            : String(v)
        )
        .join(", ");
    } else {
      displayLine = "[No Data]";
    }
    // Append formatted line with timestamp and module-added newline to buffer
    rawOutputBuffer += `${displayTimeStr}: ${displayLine}\r\n`;
  }

  // --- Write buffer to terminal based on time interval ---
  if (
    terminalInstance &&
    rawOutputBuffer.length > 0 &&
    now - lastTerminalWriteTime >= TERMINAL_UPDATE_INTERVAL_MS
  ) {
    // Clean up consecutive newlines before writing
    const cleanedBuffer = rawOutputBuffer.replace(/(?:\r?\n\s*){2,}/g, "\r\n");
    terminalInstance.write(cleanedBuffer);
    rawOutputBuffer = ""; // Clear buffer
    lastTerminalWriteTime = now; // Update last write time
    // terminalInstance.scrollToBottom(); // Optional scroll
  }
}

export function resize() {
  if (!fitAddonInstance || !isInitialized) return;
  try {
    fitAddonInstance.fit();
  } catch (e) {
    console.warn("Terminal fit error:", e);
  }
}

export function updateConfig(newConfig) {
  if (!isInitialized) return;
  // Handle only rawDisplayMode changes now
  if (
    newConfig.rawDisplayMode !== undefined &&
    newConfig.rawDisplayMode !== internalConfig.rawDisplayMode
  ) {
    handleInternalFormatChange(newConfig.rawDisplayMode); // Use the handler which includes flushing
  }
  // updateDivider logic removed
}

export function clear() {
  if (!isInitialized) return;
  if (terminalInstance) {
    terminalInstance.clear();
    terminalInstance.write("Terminal cleared.\r\n");
  }
  updateParsedDataDisplayInternal([]);
  // batchCounter removed
}

export function destroy() {
  if (!isInitialized) return;
  flushRawOutputBuffer(); // Flush pending output first

  isInitialized = false;

  // Remove event listeners
  if (rawStrBtnElement) {
    rawStrBtnElement.removeEventListener("click", boundStrModeHandler);
    rawStrBtnElement = null;
  }
  if (rawHexBtnElement) {
    rawHexBtnElement.removeEventListener("click", boundHexModeHandler);
    rawHexBtnElement = null;
  }
  if (terminalEncodingSelectElement) {
      terminalEncodingSelectElement.removeEventListener("change", handleEncodingChange);
      terminalEncodingSelectElement = null;
  }

  // Dispose terminal
  if (terminalInstance) {
    terminalInstance.dispose();
  }

  // Reset state variables
  terminalInstance = null;
  fitAddonInstance = null;
  parsedDataDisplayElement = null;
  textDecoder = null;
  rawOutputBuffer = "";
  lastTerminalWriteTime = 0;
  currentEncoding = "utf-8"; // Reset to default
  internalConfig = { rawDisplayMode: "str" }; // Reset config

  console.log("Terminal Module Destroyed.");
}

console.log("terminal_module.js (Time-based Update, Buffering) loaded.");
