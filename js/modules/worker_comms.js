// js/modules/worker_comms.js (Revised to fix import errors)
// Import only necessary functions, not specific DOM elements
import { updateStatusMessage } from './ui.js';

/**
 * Handles status messages received from the worker.
 * @param {string} statusPayload - The status message string.
 */
function handleWorkerStatusUpdate(statusPayload) {
    console.log("Worker Status:", statusPayload);
    // Query elements inside the function when needed
    const workerStatusDisplayEl = document.getElementById('workerStatusDisplay');
    const parserStatusEl = document.getElementById('parserStatus');

    // Hide generic status display by default
    if (workerStatusDisplayEl) workerStatusDisplayEl.style.display = 'none';

    if (statusPayload === 'Worker ready.') {
        return; // No persistent status needed
    }
    if (statusPayload === 'Worker: Custom parser updated.' || statusPayload === 'Worker: Custom parser applied.') {
        if (parserStatusEl) {
            parserStatusEl.textContent = "状态：Worker 解析器已更新。"; // Changed label
            parserStatusEl.classList.add('text-green-600');
            parserStatusEl.classList.remove('text-red-600');
        }
    } else if (statusPayload.startsWith('Worker: Invalid parser code:')) {
        const errorMsg = statusPayload.substring('Worker: '.length);
        if (parserStatusEl) {
            parserStatusEl.textContent = `状态：Worker 解析器错误 - ${errorMsg}`; // Changed label
            parserStatusEl.classList.add('text-red-600');
            parserStatusEl.classList.remove('text-green-600');
        }
        if (workerStatusDisplayEl) { // Show in main worker status too
            workerStatusDisplayEl.textContent = `Worker 错误: ${errorMsg}`; // Changed label
            workerStatusDisplayEl.style.color = '#dc2626';
            workerStatusDisplayEl.style.display = 'block';
        }
    } else if (statusPayload.startsWith('Worker: Error:')) {
        const errorMsg = statusPayload.substring('Worker: Error:'.length).trim();
        if (workerStatusDisplayEl) {
            workerStatusDisplayEl.textContent = `Worker 错误: ${errorMsg}`; // Changed label
            workerStatusDisplayEl.style.color = '#dc2626';
            workerStatusDisplayEl.style.display = 'block';
        }
    } else {
        // Log other status messages
        console.log("Worker Status:", statusPayload);
    }
}


/**
 * Sets up 'onmessage' and 'onerror' listeners for the data worker.
 * @param {Worker} workerInstance - The Web Worker instance.
 * @param {object} appStateRef - Reference to the main application state object (to access mainThreadDataQueue).
 * @param {Function} stopDataCollectionFn - Function to call to stop collection on critical errors.
 */
export function setupWorkerListeners(workerInstance, appStateRef, stopDataCollectionFn) {
    if (!workerInstance) {
        console.error("Cannot setup worker listeners: Worker instance is null.");
        return;
    }

    workerInstance.onmessage = (event) => {
        const { type, payload } = event.data;
        switch (type) {
            case 'dataBatch':
                if (Array.isArray(payload)) {
                    Array.prototype.push.apply(appStateRef.mainThreadDataQueue, payload);
                }
                break;
            case 'status':
                handleWorkerStatusUpdate(payload); // Use the updated handler
                break;
            case 'error':
                console.error("Worker Error Message:", payload);
                updateStatusMessage(`Worker 错误: ${payload}`); // Update main status
                // Query worker status display here too
                const workerStatusDisplayEl = document.getElementById('workerStatusDisplay');
                if (workerStatusDisplayEl) {
                    workerStatusDisplayEl.textContent = `Worker 错误: ${payload}`; // Changed label
                    workerStatusDisplayEl.style.color = '#dc2626';
                    workerStatusDisplayEl.style.display = 'block';
                }
                if (appStateRef.isCollecting) {
                    console.warn("Stopping collection due to worker error.");
                    stopDataCollectionFn();
                }
                break;
            case 'warn':
                console.warn("Worker Warning:", payload);
                break;
            default:
                console.log("Main received unknown message type from worker:", type, payload);
        }
    };

    workerInstance.onerror = (error) => {
        console.error("Unhandled Worker Error Event:", error);
        console.error("Error details:", { message: error.message, filename: error.filename, lineno: error.lineno });
        updateStatusMessage(`关键 Worker 错误: ${error.message}`); // Update main status
        // Query worker status display here too
        const workerStatusDisplayEl = document.getElementById('workerStatusDisplay');
        if (workerStatusDisplayEl) {
            workerStatusDisplayEl.textContent = `关键 Worker 错误: ${error.message}`; // Changed label
            workerStatusDisplayEl.style.color = '#dc2626';
            workerStatusDisplayEl.style.display = 'block';
        }
        if (appStateRef.isCollecting) {
            stopDataCollectionFn();
        }
        // Optionally disable controls in main.js if worker is broken
    };

    console.log("Worker message listeners set up.");
}

console.log("worker_comms.js loaded (revised)");