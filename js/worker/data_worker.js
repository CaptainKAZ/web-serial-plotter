// js/worker/data_worker.js

// --- Worker Globals ---
const WORKER_BATCH_INTERVAL_MS = 10; // Simulation batching interval
const SERIAL_BATCH_TIME_MS = 10;     // Serial data batching interval for main thread updates
const MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK = 80; // For non-Aresplot text line breaking

// --- Imports ---
// Assuming data_worker.js is in js/worker/ and aresplot_protocol.js is in js/modules/
console.warn("Worker Top-Level: data_worker.js script started execution.");
import {
    AresplotFrameParser, // The class itself
    CMD_ID as ARESPLOT_CMD_ID,
    AckStatus as ARESPLOT_ACK_STATUS
    // SOP, EOP are used internally by AresplotFrameParser, not directly needed here
} from '../modules/aresplot_protocol.js'; // Adjust path if necessary


// --- Simulation State (Copied from your original plotter.html worker script) ---
let simWorkerBatchInterval = null;
let currentDataSource = 'simulated'; // Default source
let simConfig = { numChannels: 4, frequency: 1000, amplitude: 1 };
let simCurrentRunStartTime = 0;
let simLastBatchSendTime = 0;

function generateAndSendSimBatch() {
    const now = performance.now();
    const timeSinceLastBatch = Math.max(1, now - simLastBatchSendTime);
    const pointsInBatch = Math.max(1, Math.round((simConfig.frequency * timeSinceLastBatch) / 1000));
    const batch = [];
    for (let p = 0; p < pointsInBatch; p++) {
        const pointTimestamp = simLastBatchSendTime + (timeSinceLastBatch * (p + 1)) / pointsInBatch;
        const pointElapsedMs = pointTimestamp - simCurrentRunStartTime; // Relative to this worker's sim start
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
    stopSimulation();
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
// --- End Simulation State ---


// --- Serial Data Handling State (Worker) ---
let keepReadingSerial = false;
let internalWorkerBuffer = new Uint8Array(0); // Buffer for non-Aresplot text/custom parsers
let currentReader = null;

let currentParserType = "default"; // Active parser type: 'default', 'justfloat', 'firewater', 'aresplot', 'custom'
let customSerialParserFunction = null; // For 'custom' protocol
let selectedBuiltInParser = parseDefault; // Holds the function for 'default', 'justfloat', 'firewater'

// --- Aresplot Specific State ---
let aresplotParserInstanceForWorker = null; // Use distinct name
let initialTimestampBias = null;
let lastBiasCheckPcTime = 0;
const TIMESTAMP_DRIFT_THRESHOLD_MS = 500;
const TIMESTAMP_DRIFT_CHECK_INTERVAL_MS = 5000;


// --- Utility Functions ---
function concatUint8Arrays(a, b) {
    if (!a || a.byteLength === 0) return b;
    if (!b || b.byteLength === 0) return a;
    const result = new Uint8Array(a.byteLength + b.byteLength);
    result.set(a, 0);
    result.set(b, a.byteLength);
    return result;
}

// --- Built-in Non-Aresplot Parsers (From your original plotter.html worker and previous discussions) ---
// These parsers return: { values: number[]|null, frameByteLength: number, rawLineBytes?: Uint8Array }
function parseDefault(uint8ArrayData) {
    const newlineIndex = uint8ArrayData.indexOf(0x0A); // LF
    if (newlineIndex !== -1) {
        const frameByteLength = newlineIndex + 1;
        const rawLine = uint8ArrayData.slice(0, frameByteLength);
        // Handle CR LF before LF
        const lineDataEnd = (newlineIndex > 0 && uint8ArrayData[newlineIndex - 1] === 0x0D) ? newlineIndex - 1 : newlineIndex;
        const lineBytes = uint8ArrayData.slice(0, lineDataEnd);

        const textDecoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
        const lineString = textDecoder.decode(lineBytes).trim();

        if (lineString === "") return { values: [], frameByteLength: frameByteLength, rawLineBytes: rawLine };
        const values = lineString.split(/[\s,]+/).map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
        return { values: values, frameByteLength: frameByteLength, rawLineBytes: rawLine };
    }
    return { values: null, frameByteLength: 0 };
}

function parseJustFloat(uint8ArrayData) {
    const tail = [0x00, 0x00, 0x80, 0x7f];
    const tailLength = tail.length;
    const floatSize = 4;
    if (uint8ArrayData.length < floatSize + tailLength) return { values: null, frameByteLength: 0 };

    for (let i = 0; i <= uint8ArrayData.length - (floatSize + tailLength); i++) {
        let tailMatch = true;
        for (let k = 0; k < tailLength; k++) {
            if (uint8ArrayData[i + floatSize * (Math.floor(i/floatSize)) + k] !== tail[k]) { // This check for tail seems problematic
                 // Correct tail check: the tail starts *after* the float data
                if(uint8ArrayData[i + k] !== tail[k] ){
                    tailMatch = false;
                    break;
                }
            }
        }
        // Simpler tail check: Check from index i as potential start of N floats
        // The tail would be at i + N*floatSize
        // Let's find the tail first
        let tailStartIndex = -1;
        for (let j = 0; j <= uint8ArrayData.length - tailLength; j++) {
            let found = true;
            for (let k=0; k < tailLength; k++) {
                if (uint8ArrayData[j+k] !== tail[k]) {
                    found = false; break;
                }
            }
            if (found) {
                tailStartIndex = j;
                break;
            }
        }

        if (tailStartIndex !== -1) {
            const dataBeforeTailLength = tailStartIndex;
            if (dataBeforeTailLength > 0 && dataBeforeTailLength % floatSize === 0) {
                const dataPart = uint8ArrayData.slice(0, dataBeforeTailLength);
                const values = [];
                const view = new DataView(dataPart.buffer, dataPart.byteOffset);
                for (let offset = 0; offset < dataBeforeTailLength; offset += floatSize) {
                    values.push(view.getFloat32(offset, true)); // true for little-endian
                }
                const frameByteLength = dataBeforeTailLength + tailLength;
                const rawLine = uint8ArrayData.slice(0, frameByteLength);
                return { values: values, frameByteLength: frameByteLength, rawLineBytes: rawLine };
            } else {
                // Invalid data length before tail, consume up to end of found tail to avoid re-parsing bad segment
                const frameByteLength = tailStartIndex + tailLength;
                const rawLine = uint8ArrayData.slice(0, frameByteLength); // Log what was consumed
                console.warn("JustFloat: Invalid data length before tail. Consuming segment.");
                return { values: [], frameByteLength: frameByteLength, rawLineBytes: rawLine }; // Return empty values
            }
        }
    }
    return { values: null, frameByteLength: 0 }; // No complete frame found
}

function parseFirewater(uint8ArrayData) {
    const newlineIndex = uint8ArrayData.indexOf(0x0A); // LF
    if (newlineIndex !== -1) {
        const frameByteLength = newlineIndex + 1;
        const rawLine = uint8ArrayData.slice(0, frameByteLength);
        const lineDataEnd = (newlineIndex > 0 && uint8ArrayData[newlineIndex - 1] === 0x0D) ? newlineIndex - 1 : newlineIndex;
        const lineBytes = uint8ArrayData.slice(0, lineDataEnd);

        const textDecoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
        let lineString = textDecoder.decode(lineBytes);
        const colonIndex = lineString.lastIndexOf(":");
        if (colonIndex !== -1) {
            lineString = lineString.substring(colonIndex + 1);
        }
        const values = lineString.trim().split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
        return { values: values, frameByteLength: frameByteLength, rawLineBytes: rawLine };
    }
    return { values: null, frameByteLength: 0 };
}
// --- End Built-in Parsers ---

// --- Aresplot Time Sync Logic (copied from previous, unchanged) ---
function handleAresplotMonitorData(mcuTimestampMs, fp32ValuesArray, rawFrameBytes) {
    const pcNow = performance.now();
    let calibratedPcTimestamp;
    if (initialTimestampBias === null) {
        initialTimestampBias = pcNow - mcuTimestampMs;
        lastBiasCheckPcTime = pcNow;
        self.postMessage({ type: 'info', payload: { source: 'aresplot_timestamp', message: `Timestamp bias initialized: ${initialTimestampBias.toFixed(0)}ms.` }});
    }
    const currentFrameBias = pcNow - mcuTimestampMs;
    const drift = Math.abs(currentFrameBias - initialTimestampBias);
    if (drift > TIMESTAMP_DRIFT_THRESHOLD_MS) {
        self.postMessage({ type: 'warn', payload: { source: 'aresplot_timestamp', message: `Timestamp drift >${TIMESTAMP_DRIFT_THRESHOLD_MS}ms detected (${drift.toFixed(0)}ms). Re-synchronizing. Plot may jump.` } });
        initialTimestampBias = currentFrameBias;
        lastBiasCheckPcTime = pcNow;
    } else if (pcNow - lastBiasCheckPcTime > TIMESTAMP_DRIFT_CHECK_INTERVAL_MS) {
        lastBiasCheckPcTime = pcNow;
    }
    calibratedPcTimestamp = mcuTimestampMs + initialTimestampBias;
    return { timestamp: calibratedPcTimestamp, values: fp32ValuesArray, rawLineBytes: rawFrameBytes };
}
// --- End Aresplot Time Sync ---


// --- Function to set the active serial parser (copied from previous, unchanged) ---
function setSerialParser(protocol, parserCode) {
    let parserStatusMsg = `Worker: Parser set to '${protocol}'.`;
    let success = true;
    currentParserType = protocol;
    customSerialParserFunction = null;
    selectedBuiltInParser = null;
    if (protocol !== 'aresplot') { initialTimestampBias = null; }

    switch (protocol) {
        case "custom":
            if (parserCode) {
                try {
                    customSerialParserFunction = new Function("uint8ArrayData", parserCode);
                    customSerialParserFunction(new Uint8Array([49, 44, 50, 10]));
                    parserStatusMsg = `Worker: Custom JS parser updated and applied.`;
                } catch (error) {
                    parserStatusMsg = `Worker: Invalid custom parser: ${error.message}. Defaulting.`; success = false; currentParserType = "default"; selectedBuiltInParser = parseDefault; self.postMessage({ type: "error", payload: parserStatusMsg });
                }
            } else { parserStatusMsg = "Worker: Custom parser no code. Defaulting."; success = false; currentParserType = "default"; selectedBuiltInParser = parseDefault; }
            break;
        case "aresplot": parserStatusMsg = `Worker: Aresplot protocol selected.`; break;
        case "default": selectedBuiltInParser = parseDefault; break;
        case "justfloat": selectedBuiltInParser = parseJustFloat; break;
        case "firewater": selectedBuiltInParser = parseFirewater; break;
        default: parserStatusMsg = `Worker: Unknown protocol '${protocol}'. Defaulting.`; currentParserType = "default"; selectedBuiltInParser = parseDefault; success = false;
    }
    if (success) console.log(parserStatusMsg);
    return { success, parserStatusMsg };
}


// --- Core Serial Stream Reading Function (Revised for unified parsing loop) ---
async function startReadingSerialFromStream(stream) {
    console.log(`Worker: startReadingSerialFromStream. Active parser type: ${currentParserType}`);
    keepReadingSerial = true;
    const dataPointsBatch = [];
    let lastSerialSendTime = performance.now();

    // Reset/Initialize parser state for the stream
    if (currentParserType === "aresplot") {
        aresplotParserInstanceForWorker = new AresplotFrameParser(); // No callbacks, direct return handling
        initialTimestampBias = null; // Reset bias for new Aresplot session
        lastBiasCheckPcTime = 0;
        console.log("Worker: AresplotFrameParser instance created for stream.");
    } else {
        aresplotParserInstanceForWorker = null;
        internalWorkerBuffer = new Uint8Array(0); // Buffer for other parsers
    }

    try {
        currentReader = stream.getReader();
        self.postMessage({ type: "status", payload: "Worker: Starting serial read loop." });

        while (keepReadingSerial) {
            const { value, done } = await currentReader.read().catch(err => {
                if (err.name !== 'AbortError' && keepReadingSerial) { console.error("Worker: Read error:", err); self.postMessage({ type: "error", payload: `Read error: ${err.message}` }); }
                return { value: undefined, done: true };
            });

            const pcTimeForFrameProcessing = performance.now();

            if (done) { console.log("Worker: Stream done."); keepReadingSerial = false; break; }
            if (!keepReadingSerial) { console.log("Worker: Commanded to stop reading."); if(currentReader && !done) await currentReader.cancel().catch(()=>{}); break; }

            if (value && value.byteLength > 0) {
                if (currentParserType === "aresplot" && aresplotParserInstanceForWorker) {
                    aresplotParserInstanceForWorker.pushData(value); // Push new data to Aresplot parser
                    let aresplotSegment;
                    // Loop to consume all processable segments from Aresplot parser's internal buffer
                    while (keepReadingSerial && (aresplotSegment = aresplotParserInstanceForWorker.parseNext())) {
                        if (aresplotSegment.type === 'data') {
                            const dataPoint = handleAresplotMonitorData(aresplotSegment.mcuTimestampMs, aresplotSegment.values, aresplotSegment.rawFrame);
                            if (dataPoint) dataPointsBatch.push(dataPoint);
                        } else if (aresplotSegment.type === 'ack') {
                            if (aresplotSegment.status !== ARESPLOT_ACK_STATUS.OK) {
                                self.postMessage({ type: 'warn', payload: { source: 'aresplot_ack_error', commandId: aresplotSegment.ackCmdId, statusCode: aresplotSegment.status, message: `MCU NACK for CMD 0x${aresplotSegment.ackCmdId.toString(16)} - Status 0x${aresplotSegment.status.toString(16)}` }});
                            }
                        } else if (aresplotSegment.type === 'error_report') { // Assuming ERROR_REPORT exists in CMD_ID
                            self.postMessage({ type: 'warn', payload: { source: 'aresplot_mcu_error', errorCode: aresplotSegment.errorCode, messageBytes: aresplotSegment.messageBytes, rawFrame: aresplotSegment.rawFrame }});
                        } else if (aresplotSegment.type === 'unidentified') {
                            dataPointsBatch.push({ timestamp: pcTimeForFrameProcessing, values: [], rawLineBytes: aresplotSegment.rawData, isUnidentifiedAresplotData: true });
                            if (aresplotSegment.warning) {
                                 self.postMessage({ type: 'warn', payload: { source: 'aresplot_parser_internal', message: aresplotSegment.warning }});
                            }
                        }
                        // consumedBytes is handled internally by parseNext() removing from its buffer
                    }
                } else {
                    // Logic for other parsers (custom, default, justfloat, firewater)
                    internalWorkerBuffer = concatUint8Arrays(internalWorkerBuffer, value);
                    let processedInLoop;
                    do {
                        processedInLoop = 0;
                        let parseResult = null;
                        try {
                            if (currentParserType === "custom" && customSerialParserFunction) {
                                parseResult = customSerialParserFunction(internalWorkerBuffer);
                            } else if (selectedBuiltInParser) {
                                parseResult = selectedBuiltInParser(internalWorkerBuffer);
                            } else {
                                console.error("Worker: No valid parser function selected for type:", currentParserType);
                                // To prevent infinite loop, consume something or break
                                if (internalWorkerBuffer.length > 0) {
                                    dataPointsBatch.push({ timestamp: pcTimeForFrameProcessing, values: [], rawLineBytes: internalWorkerBuffer.slice(0,1), isUnidentifiedData: true });
                                    internalWorkerBuffer = internalWorkerBuffer.slice(1);
                                    processedInLoop = 1;
                                }
                                break; // Break inner loop if no parser
                            }

                            if (parseResult && parseResult.values !== null && parseResult.frameByteLength > 0) {
                                const rawBytes = parseResult.rawLineBytes || internalWorkerBuffer.slice(0, parseResult.frameByteLength);
                                dataPointsBatch.push({ timestamp: pcTimeForFrameProcessing, values: parseResult.values, rawLineBytes: rawBytes });
                                internalWorkerBuffer = internalWorkerBuffer.slice(parseResult.frameByteLength);
                                processedInLoop = parseResult.frameByteLength;
                            }
                        } catch (e) {
                            self.postMessage({ type: "error", payload: `Parser error (${currentParserType}): ${e.message}` });
                            if (internalWorkerBuffer.length > 0) { // Consume a byte to try to recover
                                internalWorkerBuffer = internalWorkerBuffer.slice(1);
                                processedInLoop = 1;
                            }
                        }
                    } while (processedInLoop > 0 && internalWorkerBuffer.length > 0 && keepReadingSerial);

                    // MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK logic (as in your original)
                    if (currentParserType !== "justfloat" && currentParserType !== "aresplot" && // Typically for text-based
                        internalWorkerBuffer.length > MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK &&
                        internalWorkerBuffer.indexOf(0x0A) === -1 &&
                        internalWorkerBuffer.indexOf(0x0D) === -1)
                    {
                        const rawSegmentBytes = internalWorkerBuffer.slice(0, MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK);
                        dataPointsBatch.push({ timestamp: pcTimeForFrameProcessing, values: [], rawLineBytes: rawSegmentBytes, isUnidentifiedData: true });
                        internalWorkerBuffer = internalWorkerBuffer.slice(MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK);
                        self.postMessage({ type: 'warn', payload: { source: 'parser_line_break', message: `Forced line break in '${currentParserType}' due to no newline.` }});
                    }
                }
            }

            // Batch send data to main thread periodically
            if (dataPointsBatch.length > 0 && (pcTimeForFrameProcessing - lastSerialSendTime >= SERIAL_BATCH_TIME_MS)) {
                try {
                    self.postMessage({ type: "dataBatch", payload: [...dataPointsBatch] });
                } catch (postError) { console.error("Worker: Error posting dataBatch:", postError); }
                dataPointsBatch.length = 0;
                lastSerialSendTime = pcTimeForFrameProcessing;
            }
        } // end while
    } catch (error) {
        if (error.name !== 'AbortError' && keepReadingSerial) { console.error("Worker: Outer read loop error:", error); self.postMessage({ type: "error", payload: `Outer read loop error: ${error.message}` });}
    } finally {
        console.log("Worker: Serial read loop 'finally' block executing.");
        keepReadingSerial = false; // Ensure flag is false
        if (currentReader) {
            try {
                 if (!currentReader.closed) { // Check if not already closed
                    await currentReader.cancel().catch(()=>{}); // Attempt to cancel pending reads
                 }
            } catch (e) { console.warn("Worker: Error during reader final cleanup:", e); }
        }
        currentReader = null;
        aresplotParserInstanceForWorker = null; // Clean up Aresplot instance
        initialTimestampBias = null;
        internalWorkerBuffer = new Uint8Array(0);
        if (dataPointsBatch.length > 0) { // Send any remaining data
            try { self.postMessage({ type: "dataBatch", payload: [...dataPointsBatch] }); }
            catch (e) { console.error("Worker: Error posting final dataBatch from finally:", e); }
            dataPointsBatch.length = 0;
        }
        self.postMessage({ type: "status", payload: "Worker: Serial read loop finished/terminated." });
    }
}

// --- Worker Message Handler (onmessage) ---
// Ensure onmessage calls setSerialParser correctly and handles start/stop
self.onmessage = async (event) => {
    const { type, payload } = event.data;
    switch (type) {
        case 'start':
            console.log("Worker: 'start' (sim) command:", payload);
            if (payload.source === "simulated") {
                if (keepReadingSerial && currentReader) { keepReadingSerial = false; await currentReader.cancel().catch(() => {}); }
                currentDataSource = "simulated";
                setSerialParser("default"); // Reset protocol
                simConfig = payload.config;
                startSimulation();
            } else { self.postMessage({ type: "warn", payload: "Worker: 'start' for non-sim ignored." }); }
            break;
        case "startSerialStream":
            console.log("Worker: 'startSerialStream' command for protocol:", payload.protocol);
            if (payload.source === "webserial" && payload.readableStream) {
                stopSimulation();
                currentDataSource = "webserial";
                const initialParserResult = setSerialParser(payload.protocol, payload.parserCode);
                self.postMessage({ type: "status", payload: initialParserResult.parserStatusMsg });
                if (initialParserResult.success) {
                    if (keepReadingSerial) { // Ensure previous stream fully stopped
                        keepReadingSerial = false; if (currentReader) await currentReader.cancel().catch(() => {});
                        await new Promise(resolve => setTimeout(resolve, 50)); // Allow time for cleanup
                    }
                    startReadingSerialFromStream(payload.readableStream);
                } else { self.postMessage({ type: "error", payload: "Parser setup fail." }); }
            } else { self.postMessage({ type: "error", payload: "Invalid 'startSerialStream'." }); }
            break;
        case 'stop':
            console.log("Worker: 'stop' command.");
            stopSimulation();
            if (keepReadingSerial) { keepReadingSerial = false; if (currentReader) await currentReader.cancel().catch(() => {}); }
            break;
        case 'updateSimConfig':
            if (currentDataSource === "simulated") { simConfig = payload; if (simWorkerBatchInterval) startSimulation(); }
            break;
        case "updateActiveParser":
            console.log("Worker: 'updateActiveParser' for protocol:", payload.protocol);
            if (currentDataSource === "webserial") {
                const oldParserType = currentParserType;
                const updateResult = setSerialParser(payload.protocol, payload.parserCode);
                self.postMessage({ type: "status", payload: updateResult.parserStatusMsg });
                if (keepReadingSerial && oldParserType !== currentParserType) {
                     console.warn(`Worker: Parser changed mid-stream from ${oldParserType} to ${currentParserType}.`);
                     // For Aresplot, new instance is made in startReadingSerialFromStream.
                     // For others, the change is effective immediately for next data chunk.
                }
            } else { self.postMessage({ type: "warn", payload: "Parser update ignored (not webserial)." }); }
            break;
        default:
            console.warn("Worker received unknown message type:", type, payload);
    }
};

// --- Worker Ready ---
self.postMessage({ type: "status", payload: "Worker ready (ES Module, Integrated Parsers v3)." });
console.log("Worker script (ES Module, Integrated Parsers v3) loaded.");