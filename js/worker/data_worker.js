// js/worker/data_worker.js - REVISED for ReadableStream Transfer & Dynamic Parser Update

// --- Worker Globals ---
const WORKER_BATCH_INTERVAL_MS = 10; // Simulation batching interval
const SERIAL_BATCH_TIME_MS = 10; // Serial data batching interval
const MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK = 80; // Force break rule

// --- Simulation State ---
let simWorkerBatchInterval = null;
let currentDataSource = "simulated"; // Default source
let simConfig = { numChannels: 4, frequency: 1000, amplitude: 1 };
let simCurrentRunStartTime = 0;
let simLastBatchSendTime = 0;

// --- Serial Data Handling State ---
let serialParserFunction = parseDefault; // Default parser, CAN BE UPDATED DYNAMICALLY
let keepReadingSerial = false; // Flag to control serial read loop
let internalWorkerBuffer = new Uint8Array(0); // Buffer for incoming serial bytes
let currentReader = null; // Holds the reader obtained from the transferred stream

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
  const newlineIndex = uint8ArrayData.indexOf(0x0a); // Find LF (newline)
  if (newlineIndex !== -1) {
    const frameEndIndex =
      newlineIndex > 0 && uint8ArrayData[newlineIndex - 1] === 0x0d
        ? newlineIndex - 1
        : newlineIndex; // Handle CR LF
    const lineBytes = uint8ArrayData.slice(0, frameEndIndex);
    const consumedLength = newlineIndex + 1;
    try {
      const textDecoder = new TextDecoder("utf-8", {
        ignoreBOM: true,
        fatal: false,
      }); // Be more lenient
      const lineString = textDecoder.decode(lineBytes);
      // Allow empty lines to be parsed as empty arrays
      if (lineString.trim() === "") {
        return { values: [], frameByteLength: consumedLength };
      }
      const values = lineString
        .trim()
        .split(/[\s,]+/) // Split by comma or one or more whitespace chars
        .map((s) => s.trim()) // Trim individual parts
        .filter((s) => s !== "") // Remove empty strings resulting from multiple separators
        .map(Number) // Convert to number
        .filter((n) => !isNaN(n)); // Filter out non-numeric results
      return { values: values, frameByteLength: consumedLength };
    } catch (e) {
      console.warn("Worker: Default parser failed to decode/parse line", e);
      // Consume the problematic line to prevent infinite loops
      return { values: [], frameByteLength: consumedLength };
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

  // Need at least floatSize + tailLength bytes to potentially have a valid frame
  if (uint8ArrayData.length < floatSize + tailLength) {
    return { values: null, frameByteLength: 0 };
  }

  while (searchStartIndex <= uint8ArrayData.length - (floatSize + tailLength)) {
    // Find potential tail start more efficiently
    const tailStartIndex = uint8ArrayData.indexOf(tail[0], searchStartIndex);

    if (
      tailStartIndex === -1 ||
      tailStartIndex + tailLength > uint8ArrayData.length
    ) {
      break; // Tail start byte not found or tail would exceed buffer
    }

    // Check if the full tail sequence matches
    let tailFound = true;
    for (let j = 1; j < tailLength; j++) {
      if (uint8ArrayData[tailStartIndex + j] !== tail[j]) {
        tailFound = false;
        // Important: Move search index past the *current* potential start
        // to avoid re-checking the same spot if only the first byte matched.
        searchStartIndex = tailStartIndex + 1;
        break;
      }
    }

    if (tailFound) {
      const frameDataLength = tailStartIndex; // Length of data before the tail
      // Check if data length is a multiple of floatSize
      if (frameDataLength % floatSize !== 0) {
        console.warn(
          `Worker (justfloat): Invalid frame data length ${frameDataLength} before tail at index ${tailStartIndex}. Discarding up to tail end.`
        );
        // Consume the invalid frame including the tail to advance
        return { values: [], frameByteLength: tailStartIndex + tailLength };
      }

      // Valid frame structure found
      const numChannels = frameDataLength / floatSize;
      const values = [];
      const dataView = new DataView(
        uint8ArrayData.buffer,
        uint8ArrayData.byteOffset,
        frameDataLength
      ); // View only the data part
      try {
        for (let ch = 0; ch < numChannels; ch++) {
          values.push(dataView.getFloat32(ch * floatSize, true)); // true for little-endian
        }
        // Return parsed values and total length consumed (data + tail)
        return {
          values: values,
          frameByteLength: frameDataLength + tailLength,
        };
      } catch (e) {
        console.error("Worker (justfloat): Error reading float data:", e);
        // Consume the frame even on error to prevent loop
        return { values: [], frameByteLength: tailStartIndex + tailLength };
      }
    }
    // If tail not found starting at tailStartIndex, continue search from next byte
    if (!tailFound) {
      // searchStartIndex was already updated inside the loop
    } else {
      // Should not happen if tailFound is true, but safety break
      searchStartIndex = tailStartIndex + 1;
    }
  }

  // No complete frame found in the current buffer
  return { values: null, frameByteLength: 0 };
}

/** firewater parser: Parses "<any>:ch0,ch1,...,chN\n" format. */
function parseFirewater(uint8ArrayData) {
  const newlineIndex = uint8ArrayData.indexOf(0x0a);
  if (newlineIndex !== -1) {
    const frameEndIndex =
      newlineIndex > 0 && uint8ArrayData[newlineIndex - 1] === 0x0d
        ? newlineIndex - 1
        : newlineIndex;
    const lineBytes = uint8ArrayData.slice(0, frameEndIndex);
    const consumedLength = newlineIndex + 1;
    try {
      const textDecoder = new TextDecoder("utf-8", {
        ignoreBOM: true,
        fatal: false,
      });
      let lineString = textDecoder.decode(lineBytes);

      // Find the last colon, as there might be timestamp info before it
      const colonIndex = lineString.lastIndexOf(":");
      let dataString = lineString;
      if (colonIndex !== -1) {
        dataString = lineString.substring(colonIndex + 1);
      }

      // Allow empty data part after colon
      if (dataString.trim() === "") {
        return { values: [], frameByteLength: consumedLength };
      }

      // Split by comma and parse floats
      const values = dataString
        .split(",")
        .map((s) => s.trim()) // Trim whitespace around each value
        .filter((s) => s !== "") // Filter out empty strings (e.g., from trailing comma)
        .map((s) => parseFloat(s)) // Parse to float
        .filter((n) => !isNaN(n)); // Filter out NaNs

      return { values: values, frameByteLength: consumedLength };
    } catch (e) {
      console.warn("Worker (firewater): Failed to decode/parse line:", e);
      return { values: [], frameByteLength: consumedLength }; // Consume line on error
    }
  }
  return { values: null, frameByteLength: 0 }; // No newline found
}
// --- End Parser Functions ---

// --- Simulation Functions ---
function generateAndSendSimBatch() {
  const now = performance.now();
  const timeSinceLastBatch = Math.max(1, now - simLastBatchSendTime);
  const pointsInBatch = Math.max(
    1,
    Math.round((simConfig.frequency * timeSinceLastBatch) / 1000)
  );
  const batch = [];
  for (let p = 0; p < pointsInBatch; p++) {
    const pointTimestamp =
      simLastBatchSendTime + (timeSinceLastBatch * (p + 1)) / pointsInBatch;
    const pointElapsedMs = pointTimestamp - simCurrentRunStartTime;
    const values = [];
    for (let i = 0; i < simConfig.numChannels; i++) {
      const phase = (i * Math.PI) / 4;
      const freqMultiplier = 1 + i * 0.5;
      const timeSec = pointElapsedMs / 1000.0;
      let value =
        simConfig.amplitude *
          Math.sin(2 * Math.PI * freqMultiplier * timeSec + phase) +
        (Math.random() - 0.5) * 0.1 * simConfig.amplitude;
      values.push(typeof value === "number" && isFinite(value) ? value : 0);
    }
    batch.push({ timestamp: pointTimestamp, values: values }); // No rawLineBytes for sim
  }
  if (batch.length > 0) {
    self.postMessage({ type: "dataBatch", payload: batch });
  }
  simLastBatchSendTime = now;
}
function startSimulation() {
  stopSimulation(); // Stop previous if any
  simCurrentRunStartTime = performance.now();
  simLastBatchSendTime = simCurrentRunStartTime;
  console.log(
    `Worker: Starting simulation (Freq: ${simConfig.frequency}Hz, Ch: ${simConfig.numChannels})`
  );
  simWorkerBatchInterval = setInterval(
    generateAndSendSimBatch,
    WORKER_BATCH_INTERVAL_MS
  );
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

// --- Serial Stream Reading Function ---
/**
 * Reads data from the provided ReadableStream, parses it using the CURRENT serialParserFunction,
 * and sends batches back.
 * @param {ReadableStream} stream - The ReadableStream transferred from the main thread.
 */
async function startReadingSerialFromStream(stream) {
  console.log("Worker: startReadingSerialFromStream called.");
  if (!stream) {
    self.postMessage({
      type: "error",
      payload: "Worker: Received null stream for reading.",
    });
    return;
  }
  if (currentReader) {
    console.warn(
      "Worker: startReadingSerialFromStream called while a reader potentially exists. Attempting cleanup first."
    );
    try {
      await currentReader.cancel().catch(() => {}); // Cancel previous reader
      currentReader.releaseLock();
    } catch (e) {
      console.warn("Worker: Error cleaning up previous reader", e);
    }
    currentReader = null;
  }

  // Reset state for this reading session
  keepReadingSerial = true;
  internalWorkerBuffer = new Uint8Array(0); // Clear buffer for new session
  const dataPointsBatch = [];
  let lastSerialSendTime = performance.now();

  try {
    // Get the reader INSIDE the worker from the transferred stream
    currentReader = stream.getReader();
    console.log("Worker: Obtained reader from transferred stream.");
    self.postMessage({
      type: "status",
      payload: "Worker: Starting serial read loop.",
    });

    // --- Main Read Loop ---
    while (keepReadingSerial) {
      const { value, done } = await currentReader.read().catch((err) => {
        if (err.name !== "AbortError" && keepReadingSerial) {
          console.error("Worker: Read error from stream:", err);
          self.postMessage({
            type: "error",
            payload: `Worker: Read error: ${err.message}`,
          });
        } else {
          console.log("Worker: Read operation cancelled or aborted.");
        }
        return { value: undefined, done: true }; // Treat error/abort as stream end
      });

      const now = performance.now();

      if (done) {
        console.log("Worker: Transferred stream reported done (closed).");
        keepReadingSerial = false;
        break; // Exit loop
      }
      if (!keepReadingSerial) {
        // This handles external stop requests ('stop' message)
        console.log(
          "Worker: keepReadingSerial became false, exiting stream read loop."
        );
        if (currentReader) {
          // Ensure cancellation if stopped externally before 'done'
          await currentReader.cancel().catch(() => {});
        }
        break; // Exit loop
      }

      if (value && value.byteLength > 0) {
        // --- Process the received Uint8Array (value) ---
        internalWorkerBuffer = concatUint8Arrays(internalWorkerBuffer, value);
        let processedSomething = true; // Flag for inner loop

        // --- Inner processing loop (attempts to parse frames from buffer) ---
        while (
          processedSomething &&
          internalWorkerBuffer.byteLength > 0 &&
          keepReadingSerial
        ) {
          processedSomething = false; // Reset flag for this iteration

          // --- Try parsing using the CURRENTLY selected parser function ---
          try {
            const parseResult = serialParserFunction(internalWorkerBuffer); // Use selected parser

            if (
              parseResult &&
              parseResult.values !== null &&
              parseResult.frameByteLength > 0
            ) {
              // Valid frame found
              const rawFrameBytes = internalWorkerBuffer.slice(
                0,
                parseResult.frameByteLength
              );
              dataPointsBatch.push({
                timestamp: now, // Use timestamp from read() completion
                values: parseResult.values,
                rawLineBytes: rawFrameBytes, // Store original bytes
              });
              // Remove processed bytes from buffer
              internalWorkerBuffer = internalWorkerBuffer.slice(
                parseResult.frameByteLength
              );
              processedSomething = true; // We made progress
              continue; // Immediately try to parse the next frame
            }
            // else: parseResult.values is null (incomplete frame) or frameByteLength is 0
          } catch (parserError) {
            console.error(
              "Worker: Error executing serial parser function:",
              parserError
            );
            self.postMessage({
              type: "error",
              payload: `Worker: Parser function error: ${parserError.message}`,
            });
            // How to recover? Skip some bytes? For now, log and break inner loop.
            // Consider adding logic to skip bytes if parser consistently fails.
            // As a safety measure, consume one byte to avoid infinite loop on bad data/parser
            if (internalWorkerBuffer.length > 0) {
              console.warn(
                "Worker: Consuming 1 byte due to parser error to prevent potential infinite loop."
              );
              internalWorkerBuffer = internalWorkerBuffer.slice(1);
              processedSomething = true; // Technically processed something
            }
            // break; // Exit inner loop on parser error? Or try again? Let's try consuming 1 byte.
          }

          // --- Optional: Break long lines rule (if parser doesn't handle delimiters well) ---
          // This might be less necessary if parsers correctly return frameByteLength=0 for incomplete frames.
          if (
            !processedSomething &&
            internalWorkerBuffer.byteLength >
              MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK
          ) {
            const firstChunk = internalWorkerBuffer.slice(
              0,
              MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK
            );
            // Only force break if there's NO newline within the first chunk
            if (firstChunk.indexOf(0x0a) === -1) {
              console.warn(
                `Worker: Forcing raw line break at ${MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK} bytes (no newline found).`
              );
              const rawSegmentBytes = internalWorkerBuffer.slice(
                0,
                MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK
              );
              dataPointsBatch.push({
                timestamp: now,
                values: [],
                rawLineBytes: rawSegmentBytes,
              });
              internalWorkerBuffer = internalWorkerBuffer.slice(
                MAX_RAW_BUFFER_LENGTH_FOR_DISPLAY_BREAK
              );
              processedSomething = true; // We forced a break
              continue; // Restart inner loop
            }
          }

          // If no frame was parsed and no forced break happened, exit inner loop
          if (!processedSomething) {
            break;
          }
        } // --- End inner processing loop ---
      } // --- End data processing (if value) ---

      // --- Batch send data to main thread periodically ---
      if (
        dataPointsBatch.length > 0 &&
        now - lastSerialSendTime >= SERIAL_BATCH_TIME_MS
      ) {
        try {
          self.postMessage({
            type: "dataBatch",
            payload: [...dataPointsBatch],
          }); // Send copy
          dataPointsBatch.length = 0; // Clear the batch array efficiently
          lastSerialSendTime = now;
        } catch (postError) {
          console.error("Worker: Error posting dataBatch message:", postError);
          // Handle potential transfer errors if payload becomes non-transferable
        }
      }
    } // --- End main read loop (while keepReadingSerial) ---

    // --- Send any remaining batched data after loop ends ---
    if (dataPointsBatch.length > 0) {
      try {
        self.postMessage({ type: "dataBatch", payload: [...dataPointsBatch] });
      } catch (postError) {
        console.error(
          "Worker: Error posting final dataBatch message:",
          postError
        );
      }
    }
  } catch (error) {
    // --- Handle errors in the outer setup/read loop ---
    if (error.name !== "AbortError" && keepReadingSerial) {
      console.error("Worker: Outer stream read loop error:", error);
      self.postMessage({
        type: "error",
        payload: `Worker: Outer read loop error: ${error.message}`,
      });
    } else {
      if (error.name === "AbortError" && keepReadingSerial) {
        // Aborted unexpectedly
        console.warn(
          "Worker: Read aborted unexpectedly while keepReadingSerial was true."
        );
        self.postMessage({
          type: "error",
          payload: `Worker: Read aborted unexpectedly.`,
        });
      } else {
        // Expected stop or end of stream
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
        await currentReader.cancel().catch(() => {}); // Ignore cancel errors
        currentReader.releaseLock();
        console.log("Worker: Reader lock released.");
      } catch (e) {
        console.error(
          "Worker: Error during reader cleanup (cancel/releaseLock):",
          e
        );
        // Post error back to main thread? Might be problematic if worker is terminating.
      }
    }
    currentReader = null; // Clear reader reference
    internalWorkerBuffer = new Uint8Array(0); // Clear buffer on exit
    self.postMessage({
      type: "status",
      payload: "Worker: Serial read loop finished.",
    });
  }
}
// --- End Serial Stream Reading Function ---

// --- Helper function to set the parser ---
function setSerialParser(protocol, parserCode) {
  let parserStatusMsg = `Worker: Setting parser for protocol '${protocol}'.`;
  let success = false;
  try {
    if (protocol === "custom" && parserCode) {
      const newParser = new Function("uint8ArrayData", parserCode);
      newParser(new Uint8Array([49, 44, 50, 10])); // Basic test
      serialParserFunction = newParser;
      parserStatusMsg = `Worker: Parser set to 'custom'.`;
    } else if (protocol === "justfloat") {
      serialParserFunction = parseJustFloat;
      parserStatusMsg = `Worker: Parser set to 'justfloat'.`;
    } else if (protocol === "firewater") {
      serialParserFunction = parseFirewater;
      parserStatusMsg = `Worker: Parser set to 'firewater'.`;
    } else {
      // default or unknown
      serialParserFunction = parseDefault;
      if (protocol !== "default") {
        parserStatusMsg = `Worker: Unknown protocol '${protocol}', using 'default' parser.`;
      } else {
        parserStatusMsg = `Worker: Parser set to 'default'.`;
      }
    }
    console.log(parserStatusMsg);
    success = true;
  } catch (error) {
    parserStatusMsg = `Worker: Invalid parser setup for '${protocol}': ${error.message}. Using default.`;
    self.postMessage({ type: "error", payload: parserStatusMsg });
    serialParserFunction = parseDefault; // Fallback
    console.error(parserStatusMsg);
    success = false;
  }
  return { success, parserStatusMsg };
}

// --- Worker Message Handling ---
self.onmessage = async (event) => {
  const { type, payload } = event.data;

  switch (type) {
    case "start": // Handles Simulation start ONLY now
      console.log(
        "Worker: Received 'start' command (expected for Simulation):",
        payload
      );
      if (payload.source === "simulated") {
        currentDataSource = "simulated";
        simConfig = payload.config;
        // Stop serial reading if it was somehow active
        if (keepReadingSerial && currentReader) {
          console.warn(
            "Worker: Stopping active serial reading to start simulation."
          );
          keepReadingSerial = false; // Signal loop to stop
          await currentReader.cancel().catch(() => {}); // Attempt cancellation
          // Cleanup happens in finally block of the read loop
        }
        startSimulation();
      } else {
        console.warn(
          "Worker: Received 'start' command but source is not 'simulated'. Use 'startSerialStream' for serial."
        );
        self.postMessage({
          type: "warn",
          payload: "Worker: Invalid 'start' command for non-simulation source.",
        });
      }
      break;

    case "startSerialStream": // NEW: Handles Serial start with ReadableStream
      console.log("Worker: Received 'startSerialStream' command.");
      if (payload.source === "webserial" && payload.readableStream) {
        currentDataSource = "webserial";
        const readableStream = payload.readableStream;

        stopSimulation(); // Stop simulation if running

        // --- Set up Initial Parser ---
        const initialParserResult = setSerialParser(
          payload.protocol,
          payload.parserCode
        );
        self.postMessage({
          type: "status",
          payload: initialParserResult.parserStatusMsg,
        });
        // --- End Initial Parser Setup ---

        // --- Start reading from the transferred stream ---
        if (
          initialParserResult.success ||
          serialParserFunction === parseDefault
        ) {
          // Proceed even if custom failed (uses default)
          startReadingSerialFromStream(readableStream);
        } else {
          console.error(
            "Worker: Cannot start reading serial stream due to parser setup failure."
          );
          // Optionally close the stream/port from worker side if possible? Tricky.
        }
      } else {
        console.error(
          "Worker: Received 'startSerialStream' but source is not 'webserial' or readableStream is missing."
        );
        self.postMessage({
          type: "error",
          payload: "Worker: Invalid 'startSerialStream' payload.",
        });
      }
      break;

    case "stop":
      console.log("Worker: Received 'stop' command.");
      stopSimulation(); // Stop simulation if running

      // Signal serial reading loop to stop
      if (keepReadingSerial) {
        keepReadingSerial = false; // Signal the loop to stop
        if (currentReader) {
          console.log(
            "Worker: Attempting to cancel serial reader due to 'stop' command..."
          );
          // Cancel the reader, the finally block in the loop will handle releaseLock
          currentReader.cancel().catch((e) => {
            console.warn("Worker: Error cancelling reader on stop:", e);
          });
        } else {
          console.log(
            "Worker: 'stop' received, keepReadingSerial was true but no currentReader found."
          );
        }
      } else {
        console.log(
          "Worker: 'stop' received, but serial reading loop was not active."
        );
      }
      // Resetting buffer/reader refs happens in the finally block of startReadingSerialFromStream
      break;

    case "updateSimConfig":
      if (currentDataSource === "simulated") {
        console.log("Worker: Updating simulation config:", payload);
        simConfig = payload;
        if (simWorkerBatchInterval) {
          // Restart simulation if running
          startSimulation();
        }
      } else {
        console.warn(
          "Worker: Received 'updateSimConfig' but not in simulation mode."
        );
      }
      break;

    case "updateActiveParser": // NEW: Handle dynamic parser update request
      console.log("Worker: Received 'updateActiveParser' command:", payload);
      if (currentDataSource === "webserial") {
        // Only relevant for serial
        const updateResult = setSerialParser(
          payload.protocol,
          payload.parserCode
        );
        // Send status back to main thread
        self.postMessage({
          type: "status",
          payload: updateResult.parserStatusMsg,
        });
      } else {
        console.warn(
          "Worker: Received 'updateActiveParser' but not in webserial mode."
        );
        self.postMessage({
          type: "warn",
          payload: "Worker: Parser update ignored (not in serial mode).",
        });
      }
      break;

    // 'closePort' message is no longer needed as worker doesn't hold the port object.

    default:
      console.warn("Worker received unknown message type:", type, payload);
  }
};

// Notify main thread that the worker script has loaded and is ready
try {
  self.postMessage({ type: "status", payload: "Worker ready." });
  console.log(
    "Worker script loaded and ready (Revised for Stream Transfer & Dynamic Parse)."
  );
} catch (e) {
  console.error("Worker: Error sending initial 'Worker ready' status:", e);
}
