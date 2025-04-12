// js/worker/data_worker.js - REVISED for ReadableStream Transfer

// --- Worker Globals ---
const WORKER_BATCH_INTERVAL_MS = 10; // Simulation batching interval
const SERIAL_BATCH_TIME_MS = 10;     // Serial data batching interval
const MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK = 80; // Force break rule

// --- Simulation State ---
let simWorkerBatchInterval = null;
let currentDataSource = 'simulated'; // Default source
let simConfig = { numChannels: 4, frequency: 1000, amplitude: 1 };
let simCurrentRunStartTime = 0;
let simLastBatchSendTime = 0;

// --- Serial Data Handling State ---
let serialParserFunction = parseDefault; // Default parser
let keepReadingSerial = false;        // Flag to control serial read loop
let internalWorkerBuffer = new Uint8Array(0); // Buffer for incoming serial bytes
let currentReader = null;             // Holds the reader obtained from the transferred stream

// --- Utility Functions ---
/** Helper function to concatenate two Uint8Arrays. */
function concatUint8Arrays(a, b) {
    if (!a || a.byteLength === 0) return b;
    if (!b || b.byteLength === 0) return a;
    const result = new Uint8Array(a.byteLength + b.byteLength);
    result.set(a, 0);
    result.set(b, a.byteLength);
    return result;
}

// --- Parser Functions (Keep all existing parsers: parseDefault, parseJustFloat, parseFirewater) ---
/** Default parser: Parses comma or space-separated numbers ending with a newline. */
function parseDefault(uint8ArrayData) {
    const newlineIndex = uint8ArrayData.indexOf(0x0A); // Find LF (newline)
    if (newlineIndex !== -1) {
        const frameEndIndex = (newlineIndex > 0 && uint8ArrayData[newlineIndex - 1] === 0x0D) ? newlineIndex - 1 : newlineIndex;
        const lineBytes = uint8ArrayData.slice(0, frameEndIndex);
        const consumedLength = newlineIndex + 1;
        try {
            const textDecoder = new TextDecoder();
            const lineString = textDecoder.decode(lineBytes);
            const values = lineString.trim().split(/\s*,\s*|\s+/).map(Number).filter(n => !isNaN(n));
            return { values: values, frameByteLength: consumedLength };
        } catch (e) {
            console.warn("Worker: Default parser failed to decode/parse line", e);
            return { values: [], frameByteLength: consumedLength }; // Consume line even on error
        }
    }
    return { values: null, frameByteLength: 0 }; // No newline found
}

/** justfloat parser: Parses N * float (little-endian) + tail [0x00, 0x00, 0x80, 0x7f]. */
function parseJustFloat(uint8ArrayData) {
    const tail = [0x00, 0x00, 0x80, 0x7f];
    const tailLength = tail.length;
    const floatSize = 4;
    let searchStartIndex = 0;
    while (searchStartIndex < uint8ArrayData.length) {
        const tailStartIndex = uint8ArrayData.indexOf(tail[0], searchStartIndex);
        if (tailStartIndex === -1) break;
        if (tailStartIndex + tailLength > uint8ArrayData.length) break; // Incomplete tail
        let tailFound = true;
        for (let j = 1; j < tailLength; j++) {
            if (uint8ArrayData[tailStartIndex + j] !== tail[j]) {
                tailFound = false;
                searchStartIndex = tailStartIndex + 1;
                break;
            }
        }
        if (tailFound) {
            const frameDataLength = tailStartIndex;
            if (frameDataLength % floatSize !== 0) {
                console.warn(`Worker (justfloat): Invalid frame data length ${frameDataLength}. Consuming up to tail.`);
                return { values: [], frameByteLength: tailStartIndex + tailLength };
            }
            const numChannels = frameDataLength / floatSize;
            const values = [];
            const dataView = new DataView(uint8ArrayData.buffer, uint8ArrayData.byteOffset, frameDataLength);
            try {
                for (let ch = 0; ch < numChannels; ch++) {
                    values.push(dataView.getFloat32(ch * floatSize, true)); // true for little-endian
                }
                return { values: values, frameByteLength: frameDataLength + tailLength };
            } catch (e) {
                console.error("Worker (justfloat): Error reading float data:", e);
                return { values: [], frameByteLength: tailStartIndex + tailLength }; // Consume frame on error
            }
        }
    }
    return { values: null, frameByteLength: 0 }; // Tail not found or incomplete frame
}

/** firewater parser: Parses "<any>:ch0,ch1,...,chN\n" format. */
function parseFirewater(uint8ArrayData) {
    const newlineIndex = uint8ArrayData.indexOf(0x0A);
    if (newlineIndex !== -1) {
        const frameEndIndex = (newlineIndex > 0 && uint8ArrayData[newlineIndex - 1] === 0x0D) ? newlineIndex - 1 : newlineIndex;
        const lineBytes = uint8ArrayData.slice(0, frameEndIndex);
        const consumedLength = newlineIndex + 1;
        try {
            const textDecoder = new TextDecoder();
            let lineString = textDecoder.decode(lineBytes);
            const colonIndex = lineString.indexOf(':');
            if (colonIndex !== -1) {
                lineString = lineString.substring(colonIndex + 1);
            }
            const values = lineString.trim().split(',')
                .map(s => parseFloat(s.trim()))
                .filter(n => !isNaN(n));
            return { values: values, frameByteLength: consumedLength };
        } catch (e) {
            console.warn("Worker (firewater): Failed to decode/parse line:", e);
            return { values: [], frameByteLength: consumedLength };
        }
    }
    return { values: null, frameByteLength: 0 };
}
// --- End Parser Functions ---


// --- Simulation Functions ---
function generateAndSendSimBatch() {
    const now = performance.now();
    const timeSinceLastBatch = Math.max(1, now - simLastBatchSendTime);
    const pointsInBatch = Math.max(1, Math.round(simConfig.frequency * timeSinceLastBatch / 1000));
    const batch = [];
    for (let p = 0; p < pointsInBatch; p++) {
        const pointTimestamp = simLastBatchSendTime + (timeSinceLastBatch * (p + 1) / pointsInBatch);
        const pointElapsedMs = pointTimestamp - simCurrentRunStartTime;
        const values = [];
        for (let i = 0; i < simConfig.numChannels; i++) {
            const phase = (i * Math.PI) / 4;
            const freqMultiplier = 1 + i * 0.5;
            const timeSec = pointElapsedMs / 1000.0;
            let value = simConfig.amplitude * Math.sin(2 * Math.PI * freqMultiplier * timeSec + phase) + (Math.random() - 0.5) * 0.1 * simConfig.amplitude;
            values.push(typeof value === 'number' && isFinite(value) ? value : 0);
        }
        batch.push({ timestamp: pointTimestamp, values: values }); // No rawLineBytes for sim
    }
    if (batch.length > 0) {
        self.postMessage({ type: 'dataBatch', payload: batch });
    }
    simLastBatchSendTime = now;
}
function startSimulation() {
    stopSimulation(); // Stop previous if any
    simCurrentRunStartTime = performance.now();
    simLastBatchSendTime = simCurrentRunStartTime;
    console.log(`Worker: Starting simulation (Freq: ${simConfig.frequency}Hz, Ch: ${simConfig.numChannels})`);
    simWorkerBatchInterval = setInterval(generateAndSendSimBatch, WORKER_BATCH_INTERVAL_MS);
}
function stopSimulation() {
    if (simWorkerBatchInterval) {
        clearInterval(simWorkerBatchInterval);
        simWorkerBatchInterval = null;
        console.warn("Worker: Simulation interval STOPPED.");
        simCurrentRunStartTime = 0;
    }
}
// --- End Simulation Functions ---


// --- NEW Serial Stream Reading Function ---
/**
 * Reads data from the provided ReadableStream, parses it, and sends batches back.
 * @param {ReadableStream} stream - The ReadableStream transferred from the main thread.
 */
async function startReadingSerialFromStream(stream) {
    console.log("Worker: startReadingSerialFromStream called.");
    if (!stream) {
        self.postMessage({ type: 'error', payload: 'Worker: Received null stream for reading.' });
        return;
    }

    // Reset state for this reading session
    keepReadingSerial = true;
    internalWorkerBuffer = new Uint8Array(0);
    const dataPointsBatch = [];
    let lastSerialSendTime = performance.now();

    try {
        // Get the reader INSIDE the worker from the transferred stream
        currentReader = stream.getReader();
        console.log("Worker: Obtained reader from transferred stream.");
        self.postMessage({ type: 'status', payload: 'Worker: Starting serial read loop.' });

        // --- Main Read Loop ---
        while (keepReadingSerial) {
            const { value, done } = await currentReader.read().catch(err => {
                if (err.name !== 'AbortError' && keepReadingSerial) { // Only log error if not intentionally stopped
                    console.error("Worker: Read error from stream:", err);
                    self.postMessage({ type: 'error', payload: `Worker: Read error: ${err.message}` });
                } else {
                    console.log("Worker: Read operation cancelled or aborted.");
                }
                return { value: undefined, done: true }; // Treat error/abort as stream end
            });

            const now = performance.now();

            if (done) {
                console.log("Worker: Transferred stream reported done (closed).");
                keepReadingSerial = false; // Ensure loop condition breaks
                break; // Exit loop
            }
            if (!keepReadingSerial) {
                console.log("Worker: keepReadingSerial became false, exiting stream read loop.");
                // Reader might still need cancelling if stopped externally
                if (currentReader) await currentReader.cancel().catch(() => { });
                break; // Exit loop
            }

            if (value && value.byteLength > 0) {
                // --- Process the received Uint8Array (value) ---
                internalWorkerBuffer = concatUint8Arrays(internalWorkerBuffer, value);
                let processedSomething = true;

                // --- Inner processing loop (same logic as before) ---
                while (processedSomething && internalWorkerBuffer.byteLength > 0 && keepReadingSerial) {
                    processedSomething = false;
                    const parseResult = serialParserFunction(internalWorkerBuffer); // Use selected parser

                    if (parseResult && parseResult.values !== null && parseResult.frameByteLength > 0) {
                        const rawFrameBytes = internalWorkerBuffer.slice(0, parseResult.frameByteLength);
                        dataPointsBatch.push({
                            timestamp: now, // Use timestamp from read() completion
                            values: parseResult.values,
                            rawLineBytes: rawFrameBytes
                        });
                        internalWorkerBuffer = internalWorkerBuffer.slice(parseResult.frameByteLength);
                        processedSomething = true;
                        continue; // Try next frame immediately
                    }

                    // Optional: Add 80-byte rule check if needed, though parsers should handle delimiters
                    if (!processedSomething && internalWorkerBuffer.byteLength > MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK) {
                        const earlyNewlineIndex = internalWorkerBuffer.slice(0, MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK).indexOf(0x0A);
                        if (earlyNewlineIndex === -1) {
                            console.warn(`Worker: Forcing raw line break at ${MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK} bytes.`);
                            const rawSegmentBytes = internalWorkerBuffer.slice(0, MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK);
                            dataPointsBatch.push({ timestamp: now, values: [], rawLineBytes: rawSegmentBytes });
                            internalWorkerBuffer = internalWorkerBuffer.slice(MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK);
                            processedSomething = true;
                            continue;
                        }
                    }

                    if (!processedSomething) break; // Exit inner loop if no frame found in current buffer
                } // --- End inner processing loop ---
            } // --- End data processing (if value) ---

            // --- Batch send data to main thread periodically ---
            if (dataPointsBatch.length > 0 && (now - lastSerialSendTime > SERIAL_BATCH_TIME_MS)) {
                self.postMessage({ type: 'dataBatch', payload: [...dataPointsBatch] }); // Send copy
                dataPointsBatch.length = 0; // Clear the batch array efficiently
                lastSerialSendTime = now;
            }
        } // --- End main read loop (while keepReadingSerial) ---

        // --- Send any remaining batched data after loop ends ---
        if (dataPointsBatch.length > 0) {
            self.postMessage({ type: 'dataBatch', payload: [...dataPointsBatch] });
        }

    } catch (error) {
        // --- Handle errors in the outer read loop ---
        if (error.name !== 'AbortError' && keepReadingSerial) {
            console.error("Worker: Outer stream read loop error:", error);
            self.postMessage({ type: 'error', payload: `Worker: Outer read loop error: ${error.message}` });
        } else {
            // Ignore AbortError if keepReadingSerial is false (expected stop)
            if (error.name === 'AbortError' && keepReadingSerial) {
                console.warn("Worker: Read aborted unexpectedly while keepReadingSerial was true.");
            } else {
                console.log("Worker: Serial reading successfully aborted or finished.");
            }
        }
    } finally {
        // --- Cleanup ---
        console.log("Worker: Entering serial stream read loop finally block.");
        keepReadingSerial = false; // Ensure flag is false
        if (currentReader) {
            console.log("Worker: Releasing reader lock on transferred stream...");
            try {
                // Attempt to cancel again just in case loop exited abruptly
                await currentReader.cancel().catch(() => { }); // Ignore cancel errors
                currentReader.releaseLock(); // Release the lock on the readable stream
                console.log("Worker: Reader lock released.");
            } catch (e) { console.error("Worker: Error releasing reader lock:", e); }
        }
        currentReader = null; // Clear reader reference
        internalWorkerBuffer = new Uint8Array(0); // Clear buffer on exit
        self.postMessage({ type: 'status', payload: 'Worker: Serial read loop finished.' });
    }
}
// --- End NEW Serial Stream Reading Function ---


// --- Worker Message Handling ---
self.onmessage = async (event) => {
    const { type, payload } = event.data;

    switch (type) {
        case 'start': // Handles Simulation start ONLY now
            console.log("Worker: Received 'start' command (expected for Simulation):", payload);
            if (payload.source === 'simulated') {
                currentDataSource = 'simulated';
                simConfig = payload.config;
                // Stop serial reading if it was somehow active
                if (keepReadingSerial && currentReader) {
                    keepReadingSerial = false;
                    await currentReader.cancel().catch(() => { });
                }
                startSimulation();
            } else {
                console.warn("Worker: Received 'start' command but source is not 'simulated'. Use 'startSerialStream' for serial.");
                self.postMessage({ type: 'warn', payload: "Worker: Invalid 'start' command for non-simulation source." });
            }
            break;

        case 'startSerialStream': // NEW: Handles Serial start with ReadableStream
            console.log("Worker: Received 'startSerialStream' command.");
            if (payload.source === 'webserial' && payload.readableStream) {
                currentDataSource = 'webserial';
                const readableStream = payload.readableStream;

                stopSimulation(); // Stop simulation if running

                // --- Set up Parser ---
                const protocol = payload.protocol;
                let parserStatusMsg = `Worker: Using parser for protocol '${protocol}'.`;
                try {
                    if (protocol === 'custom' && payload.parserCode) {
                        const newParser = new Function('uint8ArrayData', payload.parserCode);
                        newParser(new Uint8Array([49, 44, 50, 10])); // Basic test
                        serialParserFunction = newParser;
                        parserStatusMsg = 'Worker: Custom parser applied.';
                        console.log(parserStatusMsg);
                    } else if (protocol === 'justfloat') {
                        serialParserFunction = parseJustFloat;
                        console.log(parserStatusMsg);
                    } else if (protocol === 'firewater') {
                        serialParserFunction = parseFirewater;
                        console.log(parserStatusMsg);
                    } else { // default or unknown
                        serialParserFunction = parseDefault;
                        if (protocol !== 'default') {
                            parserStatusMsg = `Worker: Unknown protocol '${protocol}', using default parser.`;
                            console.warn(parserStatusMsg);
                        } else {
                            parserStatusMsg = 'Worker: Using default parser.';
                            console.log(parserStatusMsg);
                        }
                    }
                    self.postMessage({ type: 'status', payload: parserStatusMsg });
                } catch (error) {
                    parserStatusMsg = `Worker: Invalid parser setup: ${error.message}. Using default.`;
                    self.postMessage({ type: 'error', payload: parserStatusMsg });
                    serialParserFunction = parseDefault; // Fallback
                    console.error(parserStatusMsg);
                }
                // --- End Parser Setup ---

                // --- Start reading from the transferred stream ---
                startReadingSerialFromStream(readableStream); // Call the new reading function

            } else {
                console.error("Worker: Received 'startSerialStream' but source is not 'webserial' or readableStream is missing.");
                self.postMessage({ type: 'error', payload: "Worker: Invalid 'startSerialStream' payload." });
            }
            break;

        case 'stop':
            console.log("Worker: Received 'stop' command.");
            stopSimulation(); // Stop simulation if running

            // Stop serial reading loop
            if (keepReadingSerial) {
                keepReadingSerial = false; // Signal the loop to stop
                if (currentReader) {
                    console.log("Worker: Attempting to cancel serial reader due to 'stop' command...");
                    // Cancel the reader, the finally block in the loop will handle releaseLock
                    currentReader.cancel().catch((e) => { console.warn("Worker: Error cancelling reader on stop:", e); });
                } else {
                    console.log("Worker: 'stop' received, keepReadingSerial was true but no currentReader found.");
                }
            } else {
                console.log("Worker: 'stop' received, but serial reading loop was not active.");
            }
            internalWorkerBuffer = new Uint8Array(0); // Clear buffer
            currentReader = null; // Clear reader ref just in case
            break;

        case 'updateSimConfig':
            if (currentDataSource === 'simulated') {
                console.log("Worker: Updating simulation config:", payload);
                simConfig = payload;
                if (simWorkerBatchInterval) { // Restart simulation if running
                    startSimulation();
                }
            } else {
                console.warn("Worker: Received 'updateSimConfig' but not in simulation mode.");
            }
            break;

        case 'updateParser': // Should still work for serial mode
            if (currentDataSource === 'webserial') {
                console.log("Worker: Received 'updateParser' command.");
                try {
                    const newParser = new Function('uint8ArrayData', payload.code);
                    newParser(new Uint8Array([49, 44, 50, 10])); // Basic test
                    serialParserFunction = newParser;
                    self.postMessage({ type: 'status', payload: 'Worker: Custom parser updated.' });
                    console.log("Worker: Custom parser updated successfully.");
                } catch (error) {
                    self.postMessage({ type: 'error', payload: `Worker: Invalid parser code on update: ${error.message}` });
                    console.error(`Worker: Failed to update custom parser: ${error.message}`);
                    // Keep using the old parser
                }
            } else {
                console.warn("Worker: Received 'updateParser' but not in webserial mode.");
                self.postMessage({ type: 'warn', payload: "Worker: Parser update ignored (not in serial mode)." });
            }
            break;

        // 'closePort' message is no longer needed as worker doesn't hold the port object.

        default:
            console.warn("Worker received unknown message type:", type, payload);
    }
};

// Notify main thread that the worker script has loaded and is ready
self.postMessage({ type: 'status', payload: 'Worker ready.' });
console.log("Worker script loaded and ready (Revised for Stream Transfer).");