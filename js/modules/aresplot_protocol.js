// js/modules/aresplot_protocol.js

// --- Protocol Constants ---
export const SOP = 0xA5; // Start of Packet
export const EOP = 0x5A; // End of Packet

export const CMD_ID = {
    START_MONITOR: 0x01,     // PC -> MCU: Request to start/update/stop monitoring variables
    SET_VARIABLE: 0x02,      // PC -> MCU: Request to set a variable's value
    SET_SAMPLE_RATE: 0x03,   // PC -> MCU: Request to set sample rate (optional)
    MONITOR_DATA: 0x81,      // MCU -> PC: Transmitting monitored variable data
    ACK: 0x82,               // MCU -> PC: Command Acknowledgment/Response
    ERROR_REPORT: 0x8F       // MCU -> PC: MCU asynchronous error report (optional)
};

// AresOriginalType_t Enum (mirrors the spec)
// Values that PC sends to MCU in CMD_START_MONITOR and CMD_SET_VARIABLE
export const AresOriginalType = {
    INT8: 0x00,
    UINT8: 0x01,
    INT16: 0x02,
    UINT16: 0x03,
    INT32: 0x04,
    UINT32: 0x05,
    FLOAT32: 0x06,
    FLOAT64: 0x07, // Note: MCU must support this if used
    BOOL: 0x08
};

// ACK Statuses (mirrors the spec)
export const AckStatus = {
    OK: 0x00,
    ERROR_CHECKSUM: 0x01,
    ERROR_UNKNOWN_CMD: 0x02,
    ERROR_INVALID_PAYLOAD: 0x03,
    ERROR_ADDR_INVALID: 0x04,
    ERROR_TYPE_UNSUPPORTED: 0x05,
    ERROR_RATE_UNACHIEVABLE: 0x06,
    ERROR_MCU_BUSY_OR_LIMIT: 0x07,
    ERROR_GENERAL_FAIL: 0xFF
};

const HEADER_SIZE = 1 + 1 + 2; // SOP + CMD + LEN
const CHECKSUM_EOP_SIZE = 1 + 1; // CHECKSUM + EOP

/**
 * Calculates the AresPlot checksum.
 * Checksum is calculated from CMD ID through the end of the PAYLOAD.
 * @param {number} cmdId - The command ID (uint8_t).
 * @param {number} payloadLenUint16 - The length of the payload (uint16_t).
 * @param {Uint8Array} payloadUint8Array - The payload data.
 * @returns {number} The calculated checksum (uint8_t).
 */
function calculateAresplotChecksum(cmdId, payloadLenUint16, payloadUint8Array) {
    let checksum = 0;
    checksum ^= cmdId;
    checksum ^= (payloadLenUint16 & 0xFF);       // Low byte of len
    checksum ^= ((payloadLenUint16 >> 8) & 0xFF); // High byte of len

    for (let i = 0; i < payloadUint8Array.length; i++) {
        checksum ^= payloadUint8Array[i];
    }
    return checksum;
}

/**
 * Builds a CMD_START_MONITOR (0x01) frame.
 * @param {Array<{address: number, originalType: number}>} symbols - Array of symbol objects.
 * Each symbol object must have 'address' (uint32_t) and 'originalType' (AresOriginalType_t value).
 * @returns {Uint8Array} The complete frame as a Uint8Array, ready to be sent.
 */
export function buildStartMonitorFrame(symbols) {
    if (!Array.isArray(symbols)) {
        throw new Error("buildStartMonitorFrame: symbols argument must be an array.");
    }

    const numVariables = symbols.length;
    if (numVariables > 255) {
        throw new Error("buildStartMonitorFrame: Number of variables cannot exceed 255.");
    }

    // Calculate payload length: 1 byte for NumVariables + N * 5 bytes for (address + type)
    const payloadLength = 1 + numVariables * 5;
    const frameSize = HEADER_SIZE + payloadLength + CHECKSUM_EOP_SIZE;
    const frame = new Uint8Array(frameSize);
    const payloadView = new DataView(frame.buffer, frame.byteOffset + HEADER_SIZE, payloadLength); // View for payload

    // --- Build Payload ---
    payloadView.setUint8(0, numVariables); // NumVariables
    let currentPayloadOffset = 1;
    for (const symbol of symbols) {
        if (typeof symbol.address !== 'number' || typeof symbol.originalType !== 'number') {
            throw new Error("buildStartMonitorFrame: Each symbol must have 'address' (number) and 'originalType' (AresOriginalType_t number).");
        }
        payloadView.setUint32(currentPayloadOffset, symbol.address, true); // address (little-endian)
        currentPayloadOffset += 4;
        payloadView.setUint8(currentPayloadOffset, symbol.originalType);    // originalType
        currentPayloadOffset += 1;
    }
    const payloadActual = new Uint8Array(frame.buffer, frame.byteOffset + HEADER_SIZE, payloadLength);

    // --- Build Full Frame ---
    let frameOffset = 0;
    frame[frameOffset++] = SOP;
    frame[frameOffset++] = CMD_ID.START_MONITOR;
    // LEN (payloadLength) - Little Endian
    frame[frameOffset++] = payloadLength & 0xFF;
    frame[frameOffset++] = (payloadLength >> 8) & 0xFF;

    // Copy payload (already set via payloadView)
    frameOffset += payloadLength; // Advance offset past payload

    // CHECKSUM
    const checksum = calculateAresplotChecksum(CMD_ID.START_MONITOR, payloadLength, payloadActual);
    frame[frameOffset++] = checksum;

    // EOP
    frame[frameOffset++] = EOP;

    if (frameOffset !== frameSize) {
        console.error("buildStartMonitorFrame: Frame size mismatch!", { frameOffset, frameSize });
        // This should not happen if logic is correct
    }
    // console.log("Built CMD_START_MONITOR frame:", frame);
    return frame;
}


// --- AresplotFrameParser Class ---
export class AresplotFrameParser {
    constructor() {
        this.internalBuffer = new Uint8Array(0); // Parser manages its own buffer
        // console.log("AresplotFrameParser instance created for direct parsing.");
    }

    /**
     * Appends new data to the internal buffer.
     * @param {Uint8Array} newData - The new chunk of data received.
     */
    pushData(newData) {
        if (!(newData instanceof Uint8Array) || newData.length === 0) return;
        const combined = new Uint8Array(this.internalBuffer.length + newData.length);
        combined.set(this.internalBuffer);
        combined.set(newData, this.internalBuffer.length);
        this.internalBuffer = combined;
    }

    /**
     * Attempts to parse the next available segment (frame or unidentified data) from the internal buffer.
     * If a segment is processed, it's removed from the internal buffer.
     * @returns {object|null} An object describing the parsed segment, or null if no complete segment can be processed yet.
     * Possible return object structures:
     * - Valid MONITOR_DATA: { type: 'data', mcuTimestampMs, values, rawFrame, consumedBytes }
     * - Valid ACK:        { type: 'ack', ackCmdId, status, rawFrame, consumedBytes }
     * - Valid ERROR_REPORT: { type: 'error_report', errorCode, messageBytes, rawFrame, consumedBytes }
     * - Unidentified Data: { type: 'unidentified', rawData, consumedBytes } (e.g. bytes before SOP, or a corrupted frame)
     * - Needs More Data:   null (if buffer doesn't contain a full potential segment yet)
     */
    parseNext() {
        if (this.internalBuffer.length === 0) {
            return null; // Nothing to parse
        }

        let sopIndex = this.internalBuffer.indexOf(SOP);

        if (sopIndex === -1) { // No SOP found
            // If buffer is "large enough" and no SOP, assume it's all unidentified data
            // and consume it to prevent infinite buffering of garbage.
            if (this.internalBuffer.length >= 256) { // Configurable threshold
                const unidentifiedData = this.internalBuffer.slice(0); // Copy
                this.internalBuffer = new Uint8Array(0);
                // console.warn("AresplotParser: Flushed large buffer segment due to no SOP.", unidentifiedData.length);
                return { type: 'unidentified', rawData: unidentifiedData, consumedBytes: unidentifiedData.length };
            }
            return null; // Wait for more data, SOP might still arrive
        }

        // SOP found
        if (sopIndex > 0) {
            // Data before SOP is unidentified
            const unidentifiedData = this.internalBuffer.slice(0, sopIndex);
            this.internalBuffer = this.internalBuffer.slice(sopIndex);
            // console.debug("AresplotParser: Consumed unidentified data before SOP.", unidentifiedData.length);
            return { type: 'unidentified', rawData: unidentifiedData, consumedBytes: unidentifiedData.length };
        }

        // Buffer now starts with SOP. Check for header.
        if (this.internalBuffer.length < HEADER_SIZE) {
            return null; // Not enough for header yet
        }

        const cmdId = this.internalBuffer[1];
        const payloadLen = this.internalBuffer[2] | (this.internalBuffer[3] << 8); // Little-endian

        // Sanity check for payloadLen
        if (payloadLen > 2048) { // Max reasonable payload
            // console.warn(`AresplotParser: Invalid payload length: ${payloadLen}. Discarding SOP and header.`);
            const badHeaderSegment = this.internalBuffer.slice(0, HEADER_SIZE);
            this.internalBuffer = this.internalBuffer.slice(HEADER_SIZE); // Consume the bad header
            return { type: 'unidentified', rawData: badHeaderSegment, consumedBytes: HEADER_SIZE };
        }

        const expectedFrameSize = HEADER_SIZE + payloadLen + CHECKSUM_EOP_SIZE;

        if (this.internalBuffer.length < expectedFrameSize) {
            return null; // Not enough data for the complete frame
        }

        // We have a potential full frame
        const frameBytes = this.internalBuffer.slice(0, expectedFrameSize);
        const payload = frameBytes.slice(HEADER_SIZE, HEADER_SIZE + payloadLen);
        const receivedChecksum = frameBytes[HEADER_SIZE + payloadLen];
        const eop = frameBytes[expectedFrameSize - 1];

        const calculatedChecksum = calculateAresplotChecksum(cmdId, payloadLen, payload);

        if (calculatedChecksum !== receivedChecksum || eop !== EOP) {
            let warning = "";
            if (calculatedChecksum !== receivedChecksum) warning += `Checksum error (Cmd:0x${cmdId.toString(16)} Exp:${calculatedChecksum} Got:${receivedChecksum}). `;
            if (eop !== EOP) warning += `EOP error (Cmd:0x${cmdId.toString(16)} Exp:${EOP} Got:${eop}).`;
            // console.warn("AresplotParser: Invalid frame. " + warning);

            // Treat the entire expected frame as unidentified/corrupted
            this.internalBuffer = this.internalBuffer.slice(expectedFrameSize);
            return { type: 'unidentified', rawData: frameBytes, consumedBytes: expectedFrameSize, warning: warning.trim() };
        }

        // Frame is valid, consume it from buffer
        this.internalBuffer = this.internalBuffer.slice(expectedFrameSize);

        // Process payload based on CMD ID
        const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        switch (cmdId) {
            case CMD_ID.MONITOR_DATA:
                if (payload.length < 4 || (payload.length - 4) % 4 !== 0) {
                    return { type: 'unidentified', rawData: frameBytes, consumedBytes: expectedFrameSize, warning: "Invalid MONITOR_DATA payload size." };
                }
                const mcuTimestampMs = payloadView.getUint32(0, true);
                const numValues = (payload.length - 4) / 4;
                const values = [];
                for (let i = 0; i < numValues; i++) {
                    values.push(payloadView.getFloat32(4 + i * 4, true));
                }
                return { type: 'data', mcuTimestampMs, values, rawFrame: frameBytes, consumedBytes: expectedFrameSize };
            case CMD_ID.ACK:
                if (payload.length < 2) {
                    return { type: 'unidentified', rawData: frameBytes, consumedBytes: expectedFrameSize, warning: "Invalid ACK payload size." };
                }
                const ackCmdId = payloadView.getUint8(0);
                const status = payloadView.getUint8(1);
                return { type: 'ack', ackCmdId, status, rawFrame: frameBytes, consumedBytes: expectedFrameSize };
            case CMD_ID.ERROR_REPORT: // Assuming structure: ErrorCode (1 byte) + Optional_Message (M bytes)
                 if (payload.length < 1) {
                    return { type: 'unidentified', rawData: frameBytes, consumedBytes: expectedFrameSize, warning: "Invalid ERROR_REPORT payload size." };
                 }
                 const errorCode = payloadView.getUint8(0);
                 const messageBytes = payload.slice(1);
                 return { type: 'error_report', errorCode, messageBytes, rawFrame: frameBytes, consumedBytes: expectedFrameSize };
            default:
                return { type: 'unidentified', rawData: frameBytes, consumedBytes: expectedFrameSize, warning: `Unknown CMD ID: 0x${cmdId.toString(16)}` };
        }
    }
}

console.log("aresplot_protocol.js loaded");