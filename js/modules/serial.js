// js/modules/serial.js (Revised to fix import errors)
// Import only necessary functions from ui.js, not specific elements
import { updateStatusMessage } from './ui.js';
// Import default config if needed (e.g., for baud rate default)
import { DEFAULT_BAUD_RATE } from '../config.js';

// --- Web Serial Port Handling ---

// State and helper functions (like updateButtonStates, stopDataCollectionFn)
// are managed in main.js and passed via appStateRef or called from main.js

/**
 * Handles the request and opening of a Web Serial port.
 * @param {object} appStateRef - Reference to the main application state object.
 */
export async function connectSerial(appStateRef) {
    if (!('serial' in navigator)) {
        alert("错误：您的浏览器不支持 Web Serial API。\n请使用 Chrome、Edge 或 Opera 浏览器。");
        return;
    }
    if (appStateRef.isCollecting) {
        console.warn("Cannot connect: Data collection is active.");
        updateStatusMessage("状态：请先停止采集再连接串口");
        return;
    }
    if (appStateRef.serialPort) {
        console.warn("Connect clicked, but port exists. Disconnecting first.");
        // Call the disconnect function which should handle cleanup
        // Ensure appStateRef includes the function or it's globally accessible if needed
        await disconnectSerial(appStateRef);
    }

    // Query DOM elements needed for options *inside* the function
    const baudRateInputEl = document.getElementById('baudRateInput');
    const dataBitsSelectEl = document.getElementById('dataBitsSelect');
    const stopBitsSelectEl = document.getElementById('stopBitsSelect');
    const paritySelectEl = document.getElementById('paritySelect');
    const flowControlSelectEl = document.getElementById('flowControlSelect');

    try {
        updateStatusMessage("状态：请求串口权限...");
        const requestedPort = await navigator.serial.requestPort();
        updateStatusMessage("状态：正在打开串口...");

        const options = {
            // Use queried elements, provide defaults if elements not found
            baudRate: parseInt(baudRateInputEl?.value || DEFAULT_BAUD_RATE),
            dataBits: parseInt(dataBitsSelectEl?.value || 8),
            stopBits: parseInt(stopBitsSelectEl?.value || 1),
            parity: paritySelectEl?.value || 'none',
            flowControl: flowControlSelectEl?.value || 'none',
            bufferSize: 32768
        };
        await requestedPort.open(options);

        appStateRef.serialPort = requestedPort; // Update main state
        console.log("Main: Serial port opened successfully.");
        updateStatusMessage("状态：串口已连接 (准备就绪)");

        // Attach disconnect listener - ensure handler has access to appStateRef
        // Remove previous listener first to avoid duplicates
        navigator.serial.removeEventListener('disconnect', handleSerialDisconnectEvent); // Use the named function reference
        navigator.serial.addEventListener('disconnect', (event) => handleSerialDisconnectEvent(event, appStateRef));

    } catch (error) {
        console.error("Serial connection failed:", error.name, error.message);
        if (error.name === 'NotFoundError') { updateStatusMessage("状态：未选择串口"); }
        else { updateStatusMessage(`状态：串口连接失败: ${error.message}`); }
        appStateRef.serialPort = null; // Ensure state is clean on error
    } finally {
        // Let main.js handle button state updates after promise resolves/rejects
        // Or pass the updateButtonStates function if preferred.
        // For now, rely on main.js context after await finishes.
        if (appStateRef.updateButtonStatesFn) appStateRef.updateButtonStatesFn();
    }
}

/**
 * Handles the closing of the Web Serial port and cleanup.
 * Needs access to appStateRef which holds serialPort and dataWorker.
 * @param {object} appStateRef - Reference to the main application state object.
 */
export async function disconnectSerial(appStateRef) {
    console.log("Main: Disconnect requested.");

    // Ask worker to release port reference
    if (appStateRef.dataWorker) {
        console.log("Main: Asking worker to close/release port reference.");
        appStateRef.dataWorker.postMessage({ type: 'closePort' });
    }

    const portToClose = appStateRef.serialPort;
    if (portToClose) {
        // Remove listener specific to this port instance
        navigator.serial.removeEventListener('disconnect', handleSerialDisconnectEvent);
        try {
            updateStatusMessage("状态：正在关闭串口...");
            // --- Attempt to close ---
            // Check locks (optional but good practice)
            if (portToClose.readable && portToClose.readable.locked) { await portToClose.readable.cancel().catch(e => console.warn("Error cancelling readable:", e)); }
            if (portToClose.writable && portToClose.writable.locked) { await portToClose.writable.abort().catch(e => console.warn("Error aborting writable:", e)); }
            // Close
            await portToClose.close();
            // --- End Attempt ---
            console.log("Main: Serial port closed successfully.");
            updateStatusMessage("状态：串口已断开");
        } catch (error) {
            console.warn(`Main: Error closing serial port: ${error.message}`);
            updateStatusMessage(`状态：关闭串口时出错: ${error.message}`);
        } finally {
            // Ensure cleanup runs regardless of close success
            handleSerialDisconnectCleanup(appStateRef); // This now updates state and buttons
        }
    } else {
        console.log("Disconnect called but no active port reference found in main state.");
        // Still run cleanup to ensure UI consistency
        handleSerialDisconnectCleanup(appStateRef);
        // Ensure status reflects disconnect if it wasn't already set
        // updateStatusMessage("状态：串口已断开"); // Cleanup handles status now
    }
}

/**
 * Event handler for the 'disconnect' event from the Web Serial API.
 * NOTE: This function needs to be accessible when adding the listener.
 * @param {Event} event - The disconnect event object.
 * @param {object} appStateRef - Reference to the main application state object.
 */
export function handleSerialDisconnectEvent(event, appStateRef) {
    // Check if the disconnected port is the one we *thought* we were using
    // Note: appStateRef.serialPort might be null if worker had it. Check against event.target?
    // For simplicity, if *any* port disconnects, and we are in serial mode & collecting, stop.
    console.warn("Browser reported serial disconnect event:", event.target);
    // Check if we are currently collecting data using the webserial source
    if (appStateRef.isCollecting && appStateRef.currentDataSource === 'webserial') {
        console.log("Main: Stopping collection due to external serial disconnect event.");
        updateStatusMessage("状态：串口连接丢失 (外部事件) - 停止采集中...");
        // Call the main stop function passed in appStateRef
        if (appStateRef.stopDataCollectionFn) {
            appStateRef.stopDataCollectionFn(); // This should also trigger cleanup
        } else {
            console.error("stopDataCollection function not available to handle disconnect event!");
            handleSerialDisconnectCleanup(appStateRef); // Fallback cleanup
        }
    } else if (appStateRef.serialPort && event.target === appStateRef.serialPort) {
        // If not collecting, but the disconnected port is the one main holds, cleanup state.
        console.log("Main: External disconnect for non-collecting port detected. Cleaning up.");
        updateStatusMessage("状态：串口连接丢失 (外部事件)");
        handleSerialDisconnectCleanup(appStateRef);
    } else {
        // Disconnect event for a port we don't know about or already cleaned up
        console.log("Main: Ignoring disconnect event for unrelated or already closed port.");
    }
}


/**
 * Cleans up main thread state and UI related to the serial connection.
 * @param {object} appStateRef - Reference to the main application state object.
 */
export function handleSerialDisconnectCleanup(appStateRef) {
    console.log("Running serial disconnect cleanup...");
    // Clear the serial port reference in the main state
    if (appStateRef.serialPort) {
        // Ensure listener removal happens here too
        navigator.serial.removeEventListener('disconnect', handleSerialDisconnectEvent);
        appStateRef.serialPort = null;
    }
    // General listener removal just in case
    navigator.serial.removeEventListener('disconnect', handleSerialDisconnectEvent);


    // Query and Update UI elements state
    const connectBtn = document.getElementById('connectSerialButton');
    const serialOptsDiv = document.getElementById('serialOptions');
    const updateParserBtnEl = document.getElementById('updateParserButton');

    if (connectBtn) {
        connectBtn.textContent = "连接串口"; // Changed label
        connectBtn.classList.replace('bg-yellow-500', 'bg-blue-500');
        connectBtn.classList.replace('hover:bg-yellow-600', 'hover:bg-blue-600');
    }
    if (serialOptsDiv) {
        // Re-enable serial options only if not collecting
        const disableSerialOptions = appStateRef.isCollecting;
        serialOptsDiv.querySelectorAll('input, select, textarea, button').forEach(el => {
            // Don't re-enable connect button if disabled for other reasons (e.g., collecting)
            if (el !== connectBtn) el.disabled = disableSerialOptions;
        });
        if (updateParserBtnEl) updateParserBtnEl.disabled = disableSerialOptions;
    }

    // Update button states using the main handler (important after cleanup)
    if (appStateRef.updateButtonStatesFn) appStateRef.updateButtonStatesFn();

    console.log("Main: Serial disconnect cleanup finished.");
}

/**
 * Sends the custom serial parser code to the worker for validation and use.
 * @param {object} appStateRef - Reference to the main application state object.
 */
export function updateSerialParser(appStateRef) {
    // Query elements when needed
    const serialParserTextareaEl = document.getElementById('serialParser');
    const parserStatusEl = document.getElementById('parserStatus');

    if (!serialParserTextareaEl || !parserStatusEl) {
        console.error("Cannot update parser: Textarea or status element not found.");
        return;
    }
    const code = serialParserTextareaEl.value;

    if (appStateRef.dataWorker) {
        try {
            // Basic syntax check on main thread
            new Function('uint8ArrayData', code); // Check if it's valid function code

            appStateRef.dataWorker.postMessage({ type: 'updateParser', payload: { code: code } });
            parserStatusEl.textContent = "状态：发送到 Worker..."; // Changed label
            parserStatusEl.classList.remove('text-red-600', 'text-green-600');
        } catch (error) {
            parserStatusEl.textContent = `状态：解析器代码语法错误: ${error.message}`; // Changed label
            parserStatusEl.classList.add('text-red-600');
            parserStatusEl.classList.remove('text-green-600');
        }
    } else {
        parserStatusEl.textContent = "状态：Worker 未运行"; // Changed label
        parserStatusEl.classList.add('text-red-600');
    }
}

console.log("serial.js loaded (revised)");