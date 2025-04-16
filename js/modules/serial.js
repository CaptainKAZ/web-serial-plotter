// js/modules/serial.js (Revised to fix import errors & add baud validation)
// Import only necessary functions from ui.js, not specific elements
import { updateStatusMessage } from './ui.js';
// Import default config if needed (e.g., for baud rate default)
// import { DEFAULT_BAUD_RATE } from '../config.js'; // 不再需要默认值，因为有验证

// --- Web Serial Port Handling ---

// State and helper functions (like updateButtonStates, stopDataCollectionFn)
// are managed in main.js and passed via appStateRef or called from main.js

/**
 * Handles the request and opening of a Web Serial port.
 * @param {object} appStateRef - Reference to the main application state object (needs baudRateTomSelect instance).
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
        await disconnectSerial(appStateRef);
    }

    // Query DOM elements needed for options *inside* the function
    // (Baud rate now comes from Tom Select instance via appStateRef)
    const baudRateInputEl = document.getElementById('baudRateInput');
    const dataBitsSelectEl = document.getElementById('dataBitsSelect');
    const stopBitsSelectEl = document.getElementById('stopBitsSelect');
    const paritySelectEl = document.getElementById('paritySelect');
    const flowControlSelectEl = document.getElementById('flowControlSelect');

    // --- Baud Rate Validation ---
    const baudRateValue = baudRateInputEl?.value;
    const baudRate = parseInt(baudRateValue);

    if (!baudRateValue || !baudRate || baudRate <= 0) {
        console.log("Baud Rate Value from TomSelect:", baudRateValue); // Debugging
        updateStatusMessage("错误：请选择或输入一个有效的波特率。"); // Error: Please select or enter a valid baud rate.
        // 可选: 聚焦到输入框
        appStateRef.baudRateInput.focus();
        return; // Stop connection attempt
    }
    console.log("Validated Baud Rate:", baudRate);
    // --- End Validation ---

    try {
        updateStatusMessage("状态：请求串口权限...");
        const requestedPort = await navigator.serial.requestPort();
        updateStatusMessage("状态：正在打开串口...");

        const options = {
            baudRate: baudRate, // <<< 使用验证后的波特率
            dataBits: parseInt(dataBitsSelectEl?.value || 8),
            stopBits: parseInt(stopBitsSelectEl?.value || 1),
            parity: paritySelectEl?.value || 'none',
            flowControl: flowControlSelectEl?.value || 'none',
            bufferSize: 32768 // 增加缓冲区大小可能有助于高波特率
        };
        console.log("Attempting to open port with options:", options);
        await requestedPort.open(options);

        appStateRef.serialPort = requestedPort; // Update main state
        console.log("Main: Serial port opened successfully.");
        updateStatusMessage("状态：串口已连接 (准备就绪)");

        // Attach disconnect listener - ensure handler has access to appStateRef
        navigator.serial.removeEventListener('disconnect', handleSerialDisconnectEvent); // Remove previous listener first
        // 使用箭头函数捕获 appStateRef 传递给事件处理器
        const disconnectHandler = (event) => handleSerialDisconnectEvent(event, appStateRef);
        navigator.serial.addEventListener('disconnect', disconnectHandler);
        // 存储处理器引用以便后续移除 (如果需要精确移除)
        // appStateRef.currentDisconnectHandler = disconnectHandler;

    } catch (error) {
        console.error("Serial connection failed:", error.name, error.message);
        if (error.name === 'NotFoundError') {
            updateStatusMessage("状态：未选择串口");
        } else if (error.name === 'InvalidStateError') {
            updateStatusMessage(`状态：串口打开失败(已被占用?): ${error.message}`);
        }
        else {
            updateStatusMessage(`状态：串口连接失败: ${error.message}`);
        }
        appStateRef.serialPort = null; // Ensure state is clean on error
    } finally {
        // Let main.js handle button state updates after promise resolves/rejects
        if (appStateRef.updateButtonStatesFn) {
            appStateRef.updateButtonStatesFn();
        }
    }
}

/**
 * Handles the closing of the Web Serial port and cleanup.
 * Needs access to appStateRef which holds serialPort and dataWorker.
 * @param {object} appStateRef - Reference to the main application state object.
 */
export async function disconnectSerial(appStateRef) {
    console.log("Main: Disconnect requested.");

    // Ask worker to release port reference and stop reading
    // (Worker should handle this upon receiving 'stop' or via stream closing)
    // We mainly need to ensure the main thread releases its reference and closes the port object.

    const portToClose = appStateRef.serialPort;
    if (portToClose) {
        // --- IMPORTANT: Remove the specific disconnect listener ---
        // If storing the handler reference:
        // if (appStateRef.currentDisconnectHandler) {
        //     navigator.serial.removeEventListener('disconnect', appStateRef.currentDisconnectHandler);
        //     appStateRef.currentDisconnectHandler = null;
        // } else {
        // Fallback: remove any listener using the function reference (less precise if added multiple times)
        navigator.serial.removeEventListener('disconnect', (event) => handleSerialDisconnectEvent(event, appStateRef)); // This might not work reliably if lambda used
        // A better generic removal might not be possible without storing the handler.
        // }


        try {
            updateStatusMessage("状态：正在关闭串口...");

            // --- Attempt to close ---
            // Reader cancellation should ideally happen in the worker or when stream closes.
            // Main thread might not have a locked reader if transferred.
            // Avoid cancelling streams here unless certain main thread holds the lock.
            // if (portToClose.readable && portToClose.readable.locked) {
            //    console.warn("Attempting to cancel readable stream from main thread during disconnect...");
            //    await portToClose.readable.cancel().catch(e => console.warn("Error cancelling readable:", e));
            // }
            // if (portToClose.writable && portToClose.writable.locked) { // Not using writable currently
            //     await portToClose.writable.abort().catch(e => console.warn("Error aborting writable:", e));
            // }

            // Close the port object held by the main thread
            await portToClose.close();
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
        // Still run cleanup to ensure UI consistency, especially removing general listeners
        handleSerialDisconnectCleanup(appStateRef);
    }
}

/**
 * Event handler for the 'disconnect' event from the Web Serial API.
 * NOTE: This function needs access to appStateRef, passed via closure/arrow function.
 * @param {Event} event - The disconnect event object.
 * @param {object} appStateRef - Reference to the main application state object.
 */
export function handleSerialDisconnectEvent(event, appStateRef) {
    console.warn("Browser reported serial disconnect event for port:", event.target);

    // Check if the disconnected port is the one we *thought* we were using
    // This is tricky because the worker might have the stream lock.
    // A safer approach: if *any* port disconnects while we *think* we are connected
    // serially (even if collecting stopped), trigger cleanup.
    if (appStateRef.config.currentDataSource === 'webserial') {
        console.log("Disconnect event occurred while in WebSerial mode.");
        updateStatusMessage("状态：串口连接丢失 (外部事件)");

        // If actively collecting, call the main stop function passed in appStateRef
        if (appStateRef.isCollecting && appStateRef.stopDataCollectionFn) {
            console.log("Main: Stopping collection due to external serial disconnect event.");
            appStateRef.stopDataCollectionFn(); // This should also trigger cleanup via its own logic
        } else {
            // If not collecting, or stop function unavailable, directly call cleanup
            handleSerialDisconnectCleanup(appStateRef);
        }
    } else {
        console.log("Ignoring disconnect event as not in WebSerial mode.");
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
        appStateRef.serialPort = null;
    }
    // General listener removal just in case (might be redundant but safe)
    // navigator.serial.removeEventListener('disconnect', handleSerialDisconnectEvent); // Be careful removing potentially different handlers

    // Query and Update UI elements state
    const connectBtn = document.getElementById('connectSerialButton');
    const serialOptsDiv = document.getElementById('serialOptions');
    // const updateParserBtnEl = document.getElementById('updateParserButton'); // Handled by updateButtonStatesFn

    if (connectBtn) {
        connectBtn.textContent = "连接串口";
        connectBtn.classList.replace('bg-yellow-500', 'bg-blue-500');
        connectBtn.classList.replace('hover:bg-yellow-600', 'hover:bg-blue-600');
    }
    // serialOptsDiv disabling/enabling is now handled more granularly in updateButtonStatesFn

    // Update button states using the main handler (important after cleanup)
    if (appStateRef.updateButtonStatesFn) {
        appStateRef.updateButtonStatesFn();
    } else {
        console.warn("updateButtonStates function not available during disconnect cleanup!");
    }

    console.log("Main: Serial disconnect cleanup finished.");
}

/**
 * Sends the custom serial parser code to the worker for validation and use.
 * This function is called when the "Update Parser" button is clicked.
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
            // Basic syntax check on main thread (optional but good practice)
            new Function('uint8ArrayData', code); // Check if it's valid function code

            // Send 'updateActiveParser' message, similar to dynamic update
            const payload = { protocol: 'custom', parserCode: code };
            console.log("Main: Sending 'updateActiveParser' (from button) to worker:", payload);
            parserStatusEl.textContent = "状态：发送到 Worker...";
            parserStatusEl.classList.remove('text-red-600', 'text-green-600');
            appStateRef.dataWorker.postMessage({ type: 'updateActiveParser', payload: payload });

        } catch (error) {
            parserStatusEl.textContent = `状态：解析器代码语法错误: ${error.message}`;
            parserStatusEl.classList.add('text-red-600');
            parserStatusEl.classList.remove('text-green-600');
        }
    } else {
        parserStatusEl.textContent = "状态：Worker 未运行";
        parserStatusEl.classList.add('text-red-600');
    }
}

console.log("serial.js loaded (revised for TomSelect & Validation)");