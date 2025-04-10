// --- Worker Globals ---
// Keep batch interval from origin
const WORKER_BATCH_INTERVAL_MS = 10; // 100Hz batching for simulation
const SERIAL_BATCH_TIME_MS = 10;     // Batching interval for serial data posting
const MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK = 80; // Rule for breaking long raw lines without newline

let workerBatchInterval = null; // Timer for simulation batching

// Serial Port State
let serialPort = null;
let serialReader = null;
let keepReadingSerial = false; // Flag to control the serial read loop
let serialAbortController = null; // To signal cancellation of reads

// Default parser (processes simple comma/space separated numbers), can be overwritten by main thread
let serialParserFunction = (uint8ArrayData) => {
    // Default: Find the first newline character (0x0A)
    const newlineIndex = uint8ArrayData.indexOf(0x0A);
    if (newlineIndex !== -1) {
        // Extract the line bytes (excluding newline)
        const lineBytes = uint8ArrayData.slice(0, newlineIndex);
        // Attempt to decode as UTF-8 (common case) and parse
        try {
            const textDecoder = new TextDecoder(); // Use default UTF-8
            const lineString = textDecoder.decode(lineBytes);
            const values = lineString.trim().split(/\s*,\s*|\s+/).map(Number).filter(n => !isNaN(n));
            return {
                values: values,
                frameByteLength: newlineIndex + 1 // Consume line + newline
            };
        } catch (e) {
             console.warn("Worker: Default parser failed to decode/parse line", e);
             // If decode/parse fails, still consume the line to avoid getting stuck
             return { values: [], frameByteLength: newlineIndex + 1 };
        }
    }
    // No newline found, indicate no complete frame parsed yet
    return { values: null, frameByteLength: 0 };
};


// Data Source State
let currentDataSource = 'simulated';
let simConfig = { numChannels: 4, frequency: 1000, amplitude: 1 };
let serialConfig = {}; // Placeholder for potential future serial config options

// Simulation Timing
let currentRunStartTime = 0; // Worker's internal start time for simulation calculation
let lastBatchSendTime = 0;

// --- Worker Functions ---

/**
 * Generates a batch of simulated data points based on elapsed time and target frequency.
 * Sends the batch to the main thread.
 */
function generateAndSendBatch() {
    const now = performance.now();
    const timeSinceLastBatch = Math.max(1, now - lastBatchSendTime); // Avoid zero/negative time
    // Calculate points needed based on target frequency and actual elapsed time
    const pointsInBatch = Math.max(1, Math.round(simConfig.frequency * timeSinceLastBatch / 1000));

    const batch = [];
    for (let p = 0; p < pointsInBatch; p++) {
        // Interpolate timestamp for this specific point within the batch interval
        const pointTimestamp = lastBatchSendTime + (timeSinceLastBatch * (p + 1) / pointsInBatch);
        // Calculate elapsed time relative to the worker's simulation start time
        const pointElapsedMs = pointTimestamp - currentRunStartTime;
        const values = [];
        for (let i = 0; i < simConfig.numChannels; i++) {
            const phase = (i * Math.PI) / 4;
            const freqMultiplier = 1 + i * 0.5;
            const timeSec = pointElapsedMs / 1000.0;
            // Generate simulated value (sine wave + noise)
            let value = simConfig.amplitude * Math.sin(2 * Math.PI * freqMultiplier * timeSec + phase) + (Math.random() - 0.5) * 0.1 * simConfig.amplitude;
            // Ensure value is a finite number, default to 0 otherwise
            values.push(typeof value === 'number' && isFinite(value) ? value : 0);
        }
        // Add point with its absolute timestamp and values
        batch.push({ timestamp: pointTimestamp, values: values });
    }

    if (batch.length > 0) {
        self.postMessage({ type: 'dataBatch', payload: batch });
    }
    lastBatchSendTime = now; // Update the time of the last batch sending
}

/**
 * Starts the simulation data generation interval.
 */
function startSimulation() {
    stopSimulation(); // Ensure any previous simulation is stopped
    currentRunStartTime = performance.now(); // Record the start time for this simulation run
    lastBatchSendTime = currentRunStartTime; // Initialize last send time
    console.log(`Worker: Starting simulation batch generation at ${simConfig.frequency} Hz (Batch interval: ${WORKER_BATCH_INTERVAL_MS}ms)`);
    workerBatchInterval = setInterval(generateAndSendBatch, WORKER_BATCH_INTERVAL_MS);
}

/**
 * Stops the simulation data generation interval.
 */
function stopSimulation() {
    if (workerBatchInterval) {
        clearInterval(workerBatchInterval);
        workerBatchInterval = null;
        console.warn("Worker: Simulation batch interval STOPPED.");
        currentRunStartTime = 0; // Reset start time
    }
}

/**
 * Helper function to concatenate two Uint8Arrays.
 * @param {Uint8Array} a - First array.
 * @param {Uint8Array} b - Second array.
 * @returns {Uint8Array} The concatenated array.
 */
function concatUint8Arrays(a, b) {
    if (!a || a.byteLength === 0) return b;
    if (!b || b.byteLength === 0) return a;
    const result = new Uint8Array(a.byteLength + b.byteLength);
    result.set(a, 0);
    result.set(b, a.byteLength);
    return result;
}

/**
 * Starts reading data from the Web Serial port in a loop.
 * Reads raw bytes, uses the serialParserFunction to find frames/lines,
 * and sends batches of data points (including raw bytes) to the main thread.
 */
async function startReadingSerial() {
    // --- 1. Pre-checks and State Setup ---
    if (!serialPort || !serialPort.readable) {
        self.postMessage({ type: 'error', payload: 'Worker: Serial port unavailable or not readable.' });
        return;
    }
    if (serialReader) {
        console.warn("Worker: Reader already exists, attempting cleanup...");
        await stopReadingSerial(); // Ensure previous reader is cleaned up
    }

    keepReadingSerial = true; // Control flag for the read loop
    serialAbortController = new AbortController(); // Used to signal cancellation
    let lineBuffer = new Uint8Array(0); // Buffer for incoming serial bytes
    const dataPointsBatch = []; // Array for batching data points to send
    let lastSerialSendTime = performance.now();

    // --- 2. Get Raw Byte Stream Reader ---
    try {
        serialReader = serialPort.readable.getReader();
        console.log("Worker: Raw serial reader obtained.");
        self.postMessage({ type: 'status', payload: 'Worker: Starting serial read loop.' });
    } catch (error) {
        self.postMessage({ type: 'error', payload: `Worker: Error obtaining reader: ${error.message}` });
        await stopReadingSerial(); // Cleanup on error
        return;
    }

    // --- 3. Main Read and Process Loop ---
    try {
        while (keepReadingSerial) {
            // --- Read a chunk of raw data (value will be Uint8Array) ---
            const { value, done } = await serialReader.read().catch(err => {
                if (err.name !== 'AbortError') { // AbortError is expected on stop
                    console.error("Worker: Read error:", err);
                    self.postMessage({ type: 'error', payload: `Worker: Read error: ${err.message}` });
                }
                return { value: undefined, done: true }; // Treat error as stream end
            });

            const now = performance.now(); // Timestamp for received data

            // --- Check for stream end or external stop signal ---
            if (done) { console.log("Worker: Serial stream reported done."); keepReadingSerial = false; break; }
            if (!keepReadingSerial) { console.log("Worker: keepReadingSerial became false, exiting loop."); break; }

            // --- Process received Uint8Array data ---
            if (value && value.byteLength > 0) {
                lineBuffer = concatUint8Arrays(lineBuffer, value); // Append new data to buffer

                let processedSomething = true; // Inner loop processing flag
                // --- Inner processing loop: Continually process buffer until no progress ---
                while (processedSomething && lineBuffer.byteLength > 0 && keepReadingSerial) {
                    processedSomething = false; // Reset flag for this iteration

                    // --- Step 1: Attempt to parse a protocol frame using the parser ---
                    const parseResult = serialParserFunction(lineBuffer);
                    if (parseResult && parseResult.values !== null && parseResult.frameByteLength > 0) {
                        const rawFrameBytes = lineBuffer.slice(0, parseResult.frameByteLength);
                        dataPointsBatch.push({
                            timestamp: now,
                            values: parseResult.values,
                            rawLineBytes: rawFrameBytes // Store raw bytes of the frame
                        });
                        lineBuffer = lineBuffer.slice(parseResult.frameByteLength); // Consume processed bytes
                        processedSomething = true;
                        continue; // Immediately try to parse the next frame
                    }

                    // --- Step 2: Check for 80-byte force break rule (if parser didn't find frame) ---
                     if (lineBuffer.byteLength > MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK) {
                        const first80Bytes = lineBuffer.slice(0, MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK);
                        const earlyNewlineIndex = first80Bytes.indexOf(0x0A);

                        if (earlyNewlineIndex === -1) { // No newline within the first 80 bytes
                            console.warn(`Worker: Forcing raw line break at ${MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK} bytes.`);
                            const rawSegmentBytes = first80Bytes;
                            dataPointsBatch.push({
                                timestamp: now,
                                values: [], // No parsed values for this segment
                                rawLineBytes: rawSegmentBytes // Store the raw segment
                            });
                            lineBuffer = lineBuffer.slice(MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK); // Consume the segment
                            processedSomething = true;
                            continue; // Try processing remaining buffer
                        }
                        // else: There's a newline within 80 bytes, let Step 3 handle it below.
                    }


                    // --- Step 3: Check for a simple newline (0x0A) as a fallback separator (if parser/break rule didn't apply) ---
                    const newlineIndex = lineBuffer.indexOf(0x0A);
                    if (newlineIndex !== -1) {
                        // We found a newline, but the parser didn't recognize it as a full frame.
                        // Treat it as a raw line segment termination.
                        const rawSegmentBytes = lineBuffer.slice(0, newlineIndex); // Data before newline
                        dataPointsBatch.push({
                            timestamp: now,
                            values: [], // No parsed values
                            rawLineBytes: rawSegmentBytes // Store raw segment bytes
                        });
                        // Consume segment AND the newline character
                        lineBuffer = lineBuffer.slice(newlineIndex + 1);
                        processedSomething = true;
                        continue;
                    }

                    // If nothing was processed (no frame, no break, no newline), exit inner loop
                    if (!processedSomething) { break; }
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
        if (error.name !== 'AbortError') {
            console.error("Worker: Outer read loop error:", error);
            self.postMessage({ type: 'error', payload: `Worker: Outer read loop error: ${error.message}` });
        } else {
            console.log("Worker: Serial reading successfully aborted."); // Expected on stop
        }
    } finally {
        // --- 4. Cleanup ---
        console.log("Worker: Entering serial read loop finally block.");
        keepReadingSerial = false; // Ensure flag is false
        if (serialReader) {
            console.log("Worker: Releasing reader lock...");
            try {
                // Attempt to cancel any pending read (might trigger AbortError, caught above)
                await serialReader.cancel().catch(() => {}); // Ignore cancel errors
                serialReader.releaseLock(); // Release the lock on the readable stream
                console.log("Worker: Reader lock released.");
            } catch (e) { console.error("Worker: Error releasing reader lock:", e); }
        }
        serialReader = null; // Clear reader reference
        self.postMessage({ type: 'status', payload: 'Worker: Serial read loop finished.' });
    }
}

/**
 * Stops the serial data reading loop and cleans up resources.
 */
async function stopReadingSerial() {
    console.log("Worker: stopReadingSerial called.");
    const wasReading = keepReadingSerial;
    keepReadingSerial = false; // Signal the read loop to stop FIRST

    // Abort any ongoing read operation using the controller
    if (serialAbortController) {
        console.log("Worker: Aborting read controller...");
        serialAbortController.abort(); // This should cause the await reader.read() to throw AbortError
        console.log("Worker: Controller aborted.");
        serialAbortController = null;
    } else if (wasReading) {
        console.log("Worker: No abort controller to abort, but was reading.");
    }

    console.warn("Worker: keepReadingSerial set to false. Loop should exit, cleanup in finally block.");

    // Reader cleanup (cancel, releaseLock) is handled in the finally block of startReadingSerial

    // Release the port reference held by the worker
    if (serialPort) {
        console.log("Worker: Releasing serial port reference in stopReadingSerial.");
        // We don't explicitly close the port here; the main thread owns closing it.
        // We just release the worker's reference to it.
        serialPort = null;
        self.postMessage({ type: 'status', payload: 'Worker: Serial port reference released.' });
    } else if (wasReading) {
        console.log("Worker: No serial port reference to release, but was reading.");
    }
    console.warn("WORKER SERIAL STOPPED");
}


// --- Worker Message Handling ---
self.onmessage = async (event) => {
    const { type, payload } = event.data;

    switch (type) {
        case 'start':
            console.log("Worker: Received 'start' command for source:", payload.source);
            currentDataSource = payload.source;

            if (currentDataSource === 'simulated') {
                simConfig = payload.config;
                await stopReadingSerial(); // Ensure serial is stopped if switching
                startSimulation();
            } else if (currentDataSource === 'webserial') {
                stopSimulation(); // Ensure simulation is stopped
                await stopReadingSerial(); // Ensure previous serial session is fully stopped before starting new

                serialPort = payload.port; // Assume port is transferred here
                serialConfig = payload.config; // Store any serial-specific config

                // Apply custom parser if provided, otherwise reset to default
                if (payload.parserCode) {
                    try {
                        // IMPORTANT: Use Function constructor carefully. Assumes code comes from trusted source (user input in this app).
                        const newParser = new Function('uint8ArrayData', payload.parserCode);
                        // Basic test: Call with empty array or simple known data
                        newParser(new Uint8Array([49, 44, 50, 10])); // Test with "1,2\n"
                        serialParserFunction = newParser;
                        self.postMessage({ type: 'status', payload: 'Worker: Custom parser applied.' });
                        console.log("Worker: Custom parser applied.");
                    } catch (error) {
                        self.postMessage({ type: 'error', payload: `Worker: Invalid parser code: ${error.message}` });
                        // Optionally: Stop processing if parser is invalid? For now, we just report error.
                        // Reset to default if custom fails?
                        // serialParserFunction = (uint8ArrayData) => { /* ... default logic ... */ };
                        // return; // Or maybe don't start reading? Depends on requirements.
                    }
                } else {
                     // Reset to default parser if no code provided
                    serialParserFunction = (uint8ArrayData) => {
                        const newlineIndex = uint8ArrayData.indexOf(0x0A);
                        if (newlineIndex !== -1) {
                            const lineBytes = uint8ArrayData.slice(0, newlineIndex);
                            try {
                                const textDecoder = new TextDecoder();
                                const lineString = textDecoder.decode(lineBytes);
                                const values = lineString.trim().split(/\s*,\s*|\s+/).map(Number).filter(n => !isNaN(n));
                                return { values: values, frameByteLength: newlineIndex + 1 };
                            } catch (e) { return { values: [], frameByteLength: newlineIndex + 1 }; }
                        }
                        return { values: null, frameByteLength: 0 };
                    };
                    console.log("Worker: Reset to default parser.");
                }
                startReadingSerial(); // Start the async read loop
            }
            break;

        case 'stop':
            console.log("Worker: Received 'stop' command.");
            if (currentDataSource === 'simulated') {
                stopSimulation();
            } else if (currentDataSource === 'webserial') {
                await stopReadingSerial(); // Stops async read loop and cleans up worker references
            }
            // Reset current source after stopping? Maybe not necessary unless explicitly starting again.
            // currentDataSource = null;
            break;

        case 'updateSimConfig':
             if (currentDataSource === 'simulated') {
                console.log("Worker: Updating simulation config:", payload);
                simConfig = payload;
                // If simulation is currently running, restart it with the new config
                if (workerBatchInterval) {
                    startSimulation(); // Restart simulation interval
                }
            }
            break;

        case 'updateParser':
            console.log("Worker: Received 'updateParser' command.");
             if (currentDataSource === 'webserial') { // Only relevant for serial
                 try {
                    const newParser = new Function('uint8ArrayData', payload.code);
                    newParser(new Uint8Array([49, 44, 50, 10])); // Basic test
                    serialParserFunction = newParser;
                    self.postMessage({ type: 'status', payload: 'Worker: Custom parser updated.' });
                     console.log("Worker: Custom parser updated.");
                } catch (error) {
                    self.postMessage({ type: 'error', payload: `Worker: Invalid parser code: ${error.message}` });
                }
            } else {
                 console.warn("Worker: Received updateParser command but not in webserial mode.");
            }
            break;

        case 'closePort':
            // Main thread is asking worker to stop using the port (likely before main thread closes it)
            console.log("Worker: Received 'closePort' command (likely before main thread closes).");
             // Ensure reading stops and worker releases its reference to the port.
             // This is crucial if the main thread intends to close the port.
            await stopReadingSerial();
            break;

        default:
            console.warn("Worker received unknown message type:", type);
    }
};

// Notify main thread that the worker script has loaded and is ready
self.postMessage({ type: 'status', payload: 'Worker ready.' });
console.log("Worker script loaded and ready.");