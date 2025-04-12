// --- Worker Globals ---
const WORKER_BATCH_INTERVAL_MS = 10; // 100Hz batching for simulation
const SERIAL_BATCH_TIME_MS = 10;     // Batching interval for serial data posting
const MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK = 80; // Rule for breaking long raw lines without newline

let workerBatchInterval = null; // Timer for simulation batching

// Serial Port State
let serialPort = null;
let serialReader = null;
let keepReadingSerial = false; // Flag to control the serial read loop
let serialAbortController = null; // To signal cancellation of reads

// --- Parser Functions ---

/**
 * Default parser: Parses comma or space-separated numbers ending with a newline.
 * Handles \n and \r\n line endings.
 * @param {Uint8Array} uint8ArrayData - Raw data bytes.
 * @returns {{values: number[] | null, frameByteLength: number}}
 */
function parseDefault(uint8ArrayData) {
    const newlineIndex = uint8ArrayData.indexOf(0x0A); // Find LF (newline)
    if (newlineIndex !== -1) {
        // Check for preceding CR (carriage return) for Windows/mixed line endings
        const frameEndIndex = (newlineIndex > 0 && uint8ArrayData[newlineIndex - 1] === 0x0D) ? newlineIndex - 1 : newlineIndex;
        const lineBytes = uint8ArrayData.slice(0, frameEndIndex);
        // Determine bytes consumed (including newline and optional carriage return)
        const consumedLength = newlineIndex + 1; // Consume up to and including LF

        try {
            const textDecoder = new TextDecoder(); // Default UTF-8
            const lineString = textDecoder.decode(lineBytes);
            const values = lineString.trim().split(/\s*,\s*|\s+/).map(Number).filter(n => !isNaN(n));
            return {
                values: values,
                frameByteLength: consumedLength
            };
        } catch (e) {
            console.warn("Worker: Default parser failed to decode/parse line", e);
            // Consume the line even if parsing fails
            return { values: [], frameByteLength: consumedLength };
        }
    }
    // No newline found
    return { values: null, frameByteLength: 0 };
}

/**
 * justfloat parser: Parses N * float (little-endian) followed by a specific tail [0x00, 0x00, 0x80, 0x7f].
 * @param {Uint8Array} uint8ArrayData - Raw data bytes.
 * @returns {{values: number[] | null, frameByteLength: number}}
 */
function parseJustFloat(uint8ArrayData) {
    const tail = [0x00, 0x00, 0x80, 0x7f];
    const tailLength = tail.length;
    const floatSize = 4; // Size of a float in bytes

    // Search for the tail sequence efficiently
    let searchStartIndex = 0;
    while (searchStartIndex < uint8ArrayData.length) {
        const tailStartIndex = uint8ArrayData.indexOf(tail[0], searchStartIndex);

        if (tailStartIndex === -1) {
            // First byte of tail not found, need more data or it's not present
            break;
        }

        // Check if the buffer has enough bytes for the complete tail sequence
        if (tailStartIndex + tailLength > uint8ArrayData.length) {
            // Potential tail start found, but not enough data follows for the full tail
            break; // Need more data
        }

        // Check the rest of the tail sequence
        let tailFound = true;
        for (let j = 1; j < tailLength; j++) {
            if (uint8ArrayData[tailStartIndex + j] !== tail[j]) {
                tailFound = false;
                // Mismatch, continue searching from the byte after the potential start
                searchStartIndex = tailStartIndex + 1;
                break;
            }
        }

        if (tailFound) {
            // Full tail sequence found, ending at index tailStartIndex + tailLength - 1
            const frameDataLength = tailStartIndex; // Length of the data part (floats)

            // Validate data length
            if (frameDataLength % floatSize !== 0) {
                console.warn(`Worker (justfloat): Invalid frame data length ${frameDataLength}, not divisible by ${floatSize}. Consuming up to tail to resync.`);
                // Consume the invalid data and tail to potentially recover synchronization
                return { values: [], frameByteLength: tailStartIndex + tailLength };
            }

            const numChannels = frameDataLength / floatSize;
            const values = [];
            // Use DataView for safer typed array access
            const dataView = new DataView(uint8ArrayData.buffer, uint8ArrayData.byteOffset, frameDataLength);

            try {
                for (let ch = 0; ch < numChannels; ch++) {
                    // Read float (little-endian specified by 'true')
                    values.push(dataView.getFloat32(ch * floatSize, true));
                }
                // Successfully parsed frame
                return { values: values, frameByteLength: frameDataLength + tailLength };
            } catch (e) {
                console.error("Worker (justfloat): Error reading float data:", e);
                // Consume the frame even on error to try and resync
                return { values: [], frameByteLength: tailStartIndex + tailLength };
            }
        }
        // If tail not found starting at tailStartIndex, loop continues search from searchStartIndex
    }

    // Tail not found or incomplete frame in the current buffer
    return { values: null, frameByteLength: 0 };
}


/**
 * firewater parser: Parses "<any>:ch0,ch1,...,chN\n" format.
 * Handles \n and \r\n line endings.
 * @param {Uint8Array} uint8ArrayData - Raw data bytes.
 * @returns {{values: number[] | null, frameByteLength: number}}
 */
function parseFirewater(uint8ArrayData) {
    // Find the first newline character (LF, 0x0A)
    const newlineIndex = uint8ArrayData.indexOf(0x0A);
    if (newlineIndex !== -1) {
        // Check for preceding CR (carriage return) for Windows/mixed line endings (\r\n)
        const frameEndIndex = (newlineIndex > 0 && uint8ArrayData[newlineIndex - 1] === 0x0D) ? newlineIndex - 1 : newlineIndex;
        const lineBytes = uint8ArrayData.slice(0, frameEndIndex);

        // Determine bytes consumed (including LF and optional CR)
        const consumedLength = newlineIndex + 1; // Consume up to and including LF

        try {
            const textDecoder = new TextDecoder(); // Default UTF-8
            let lineString = textDecoder.decode(lineBytes);

            // Check for optional "<any>:" part
            const colonIndex = lineString.indexOf(':');
            if (colonIndex !== -1) {
                lineString = lineString.substring(colonIndex + 1); // Take the part after the colon
            }

            // Split by comma and parse numbers
            const values = lineString.trim().split(',')
                .map(s => parseFloat(s.trim())) // Parse each part as float
                .filter(n => !isNaN(n));       // Keep only valid numbers

            return {
                values: values,
                frameByteLength: consumedLength
            };
        } catch (e) {
            console.warn("Worker (firewater): Failed to decode/parse line:", e);
            // Consume the line even if parsing fails
            return { values: [], frameByteLength: consumedLength };
        }
    }

    // No newline found yet
    return { values: null, frameByteLength: 0 };
}


// Default parser function (can be overwritten)
let serialParserFunction = parseDefault; // Start with the default parser


// Data Source State
let currentDataSource = 'simulated';
let simConfig = { numChannels: 4, frequency: 1000, amplitude: 1 };
let serialConfig = {}; // Placeholder

// Simulation Timing
let currentRunStartTime = 0;
let lastBatchSendTime = 0;

// --- Worker Functions ---

/**
 * Generates a batch of simulated data points.
 */
function generateAndSendBatch() {
    const now = performance.now();
    const timeSinceLastBatch = Math.max(1, now - lastBatchSendTime);
    const pointsInBatch = Math.max(1, Math.round(simConfig.frequency * timeSinceLastBatch / 1000));

    const batch = [];
    for (let p = 0; p < pointsInBatch; p++) {
        const pointTimestamp = lastBatchSendTime + (timeSinceLastBatch * (p + 1) / pointsInBatch);
        const pointElapsedMs = pointTimestamp - currentRunStartTime;
        const values = [];
        for (let i = 0; i < simConfig.numChannels; i++) {
            const phase = (i * Math.PI) / 4;
            const freqMultiplier = 1 + i * 0.5;
            const timeSec = pointElapsedMs / 1000.0;
            let value = simConfig.amplitude * Math.sin(2 * Math.PI * freqMultiplier * timeSec + phase) + (Math.random() - 0.5) * 0.1 * simConfig.amplitude;
            values.push(typeof value === 'number' && isFinite(value) ? value : 0);
        }
        batch.push({ timestamp: pointTimestamp, values: values });
    }

    if (batch.length > 0) {
        self.postMessage({ type: 'dataBatch', payload: batch });
    }
    lastBatchSendTime = now;
}

/**
 * Starts the simulation data generation interval.
 */
function startSimulation() {
    stopSimulation();
    currentRunStartTime = performance.now();
    lastBatchSendTime = currentRunStartTime;
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
        currentRunStartTime = 0;
    }
}

/**
 * Helper function to concatenate two Uint8Arrays.
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
 */
async function startReadingSerial() {
    // --- 1. Pre-checks and State Setup ---
    if (!serialPort || !serialPort.readable) {
        self.postMessage({ type: 'error', payload: 'Worker: Serial port unavailable or not readable.' });
        return;
    }
    if (serialReader) {
        console.warn("Worker: Reader already exists, attempting cleanup...");
        await stopReadingSerial();
    }

    keepReadingSerial = true;
    serialAbortController = new AbortController();
    let lineBuffer = new Uint8Array(0);
    const dataPointsBatch = [];
    let lastSerialSendTime = performance.now();

    // --- 2. Get Raw Byte Stream Reader ---
    try {
        serialReader = serialPort.readable.getReader();
        console.log("Worker: Raw serial reader obtained.");
        self.postMessage({ type: 'status', payload: 'Worker: Starting serial read loop.' });
    } catch (error) {
        self.postMessage({ type: 'error', payload: `Worker: Error obtaining reader: ${error.message}` });
        await stopReadingSerial();
        return;
    }

    // --- 3. Main Read and Process Loop ---
    try {
        while (keepReadingSerial) {
            const { value, done } = await serialReader.read().catch(err => {
                if (err.name !== 'AbortError') {
                    console.error("Worker: Read error:", err);
                    self.postMessage({ type: 'error', payload: `Worker: Read error: ${err.message}` });
                }
                return { value: undefined, done: true };
            });

            const now = performance.now();

            if (done) { console.log("Worker: Serial stream reported done."); keepReadingSerial = false; break; }
            if (!keepReadingSerial) { console.log("Worker: keepReadingSerial became false, exiting loop."); break; }

            if (value && value.byteLength > 0) {
                lineBuffer = concatUint8Arrays(lineBuffer, value);

                let processedSomething = true;
                // Inner loop to process buffer as much as possible
                while (processedSomething && lineBuffer.byteLength > 0 && keepReadingSerial) {
                    processedSomething = false;

                    // --- Step 1: Attempt to parse using the SELECTED parser function ---
                    // serialParserFunction points to the correct parser (default, custom, justfloat, firewater)
                    const parseResult = serialParserFunction(lineBuffer);

                    if (parseResult && parseResult.values !== null && parseResult.frameByteLength > 0) {
                        // Successfully parsed a frame
                        const rawFrameBytes = lineBuffer.slice(0, parseResult.frameByteLength);
                        dataPointsBatch.push({
                            timestamp: now,
                            values: parseResult.values,
                            rawLineBytes: rawFrameBytes // Include raw bytes for display module
                        });
                        lineBuffer = lineBuffer.slice(parseResult.frameByteLength); // Consume processed bytes
                        processedSomething = true; // Indicate progress
                        continue; // Immediately try to parse the next frame from remaining buffer
                    }

                    // --- Step 2: (Optional Fallback/Safety) Check for 80-byte force break rule if parser didn't find frame ---
                    // This helps prevent the buffer growing indefinitely if the parser fails to find frames.
                    // You might remove this if your protocols are guaranteed to have delimiters eventually.
                    if (!processedSomething && lineBuffer.byteLength > MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK) {
                        const first80Bytes = lineBuffer.slice(0, MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK);
                        // Check if there's *any* newline within the first 80 bytes. If not, force break.
                        const earlyNewlineIndex = first80Bytes.indexOf(0x0A);

                        if (earlyNewlineIndex === -1) { // No newline found within 80 bytes
                            console.warn(`Worker: Forcing raw line break at ${MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK} bytes (potential parser stall or long line).`);
                            const rawSegmentBytes = first80Bytes;
                            dataPointsBatch.push({
                                timestamp: now,
                                values: [], // No parsed values for this segment
                                rawLineBytes: rawSegmentBytes
                            });
                            lineBuffer = lineBuffer.slice(MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK); // Consume the segment
                            processedSomething = true;
                            continue; // Try processing remaining buffer
                        }
                        // Else: There's a newline within 80 bytes, let the parser (if default) handle it eventually.
                    }


                    // If nothing was processed (no frame parsed, no forced break), exit inner loop
                    // to wait for more data in the next read() call.
                    if (!processedSomething) {
                        break;
                    }
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
                await serialReader.cancel().catch(() => { }); // Ignore cancel errors
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
            console.log("Worker: Received 'start' command for source:", payload.source, "Protocol:", payload.protocol);
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

                // --- Select Parser Based on Protocol ---
                const protocol = payload.protocol;
                let parserSelected = false;
                let parserStatusMsg = 'Worker: Unknown protocol, using default parser.'; // Default message

                if (protocol === 'custom') {
                    if (payload.parserCode) {
                        try {
                            // IMPORTANT: Use Function constructor carefully. Assumes code comes from trusted source (user input in this app).
                            const newParser = new Function('uint8ArrayData', payload.parserCode);
                            // Basic test: Call with empty array or simple known data
                            newParser(new Uint8Array([49, 44, 50, 10])); // Test with "1,2\n"
                            serialParserFunction = newParser;
                            parserStatusMsg = 'Worker: Custom parser applied.';
                            parserSelected = true;
                            console.log("Worker: Custom parser applied.");
                        } catch (error) {
                            parserStatusMsg = `Worker: Invalid custom parser code: ${error.message}`;
                            self.postMessage({ type: 'error', payload: parserStatusMsg });
                            // Fallback to default if custom fails
                            serialParserFunction = parseDefault;
                            console.error("Worker: Failed to apply custom parser, falling back to default.", error);
                            parserStatusMsg = 'Worker: Invalid custom parser, using default.'; // Update status msg
                            // parserSelected remains false or set it true because default is selected? Let's say true because default is chosen.
                            parserSelected = true;
                        }
                    } else {
                        // Custom selected but no code provided
                        parserStatusMsg = 'Worker: Custom protocol selected but no code provided. Using default parser.';
                        self.postMessage({ type: 'warn', payload: parserStatusMsg });
                        serialParserFunction = parseDefault;
                        parserSelected = true; // Default is selected
                        console.warn(parserStatusMsg);
                    }
                } else if (protocol === 'justfloat') {
                    serialParserFunction = parseJustFloat;
                    parserStatusMsg = 'Worker: Using "justfloat" parser.';
                    parserSelected = true;
                    console.log(parserStatusMsg);
                } else if (protocol === 'firewater') {
                    serialParserFunction = parseFirewater;
                    parserStatusMsg = 'Worker: Using "firewater" parser.';
                    parserSelected = true;
                    console.log(parserStatusMsg);
                } else { // Default or unknown protocol specified
                    serialParserFunction = parseDefault;
                    parserStatusMsg = 'Worker: Using default (comma/space separated) parser.';
                    parserSelected = true; // Default is always available
                    console.log(parserStatusMsg);
                }

                // Send status back to main thread about which parser is active
                if (parserSelected) { // Only send status if a valid selection (incl. default) was made
                    self.postMessage({ type: 'status', payload: parserStatusMsg });
                }
                // --- End Parser Selection ---

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
            // Only allow updating if the current mode IS 'custom'
            // (Main thread should prevent sending this, but good to double check here)
            if (currentDataSource === 'webserial' && serialParserFunction !== parseDefault && serialParserFunction !== parseJustFloat && serialParserFunction !== parseFirewater) {
                // It's likely a custom function (check if it's not one of the built-ins)
                try {
                    const newParser = new Function('uint8ArrayData', payload.code);
                    newParser(new Uint8Array([49, 44, 50, 10])); // Basic test
                    serialParserFunction = newParser; // Update the active parser
                    self.postMessage({ type: 'status', payload: 'Worker: Custom parser updated.' });
                    console.log("Worker: Custom parser updated via 'updateParser'.");
                } catch (error) {
                    self.postMessage({ type: 'error', payload: `Worker: Invalid parser code on update: ${error.message}` });
                    // Optionally revert to previous custom parser or default? For now, just report error.
                }
            } else {
                console.warn("Worker: Ignored 'updateParser' command (not in custom mode or not webserial). Current parser:", serialParserFunction.name);
                self.postMessage({ type: 'warn', payload: 'Worker: Parser update ignored (not in custom mode).' });
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