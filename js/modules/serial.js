// js/modules/serial.js
import { eventBus } from "../event_bus.js";

let serialPort = null;
let isConnectedState = false;
let currentDisconnectHandler = null;
let writableStreamDefaultWriter = null;

/**
 * Attempts to connect to a user-selected serial port.
 * @param {object} options - Connection options (baudRate, dataBits, etc.)
 * @returns {Promise<boolean>} True if connection was successful.
 */
async function connect(options) {
  if (!("serial" in navigator)) {
    eventBus.emit("serial:error", new Error("浏览器不支持 Web Serial API。"));
    return false;
  }
  if (serialPort) {
    console.warn(
      "SerialService: Connect called while already connected. Disconnecting first."
    );
    await disconnect();
  }

  if (!options || !options.baudRate || options.baudRate <= 0) {
    eventBus.emit("serial:error", new Error("连接失败：未提供有效的波特率。"));
    return false;
  }

  try {
    eventBus.emit("serial:status", "请求串口权限...");
    const requestedPort = await navigator.serial.requestPort();
    eventBus.emit("serial:status", "正在打开串口...");

    await requestedPort.open(options);

    serialPort = requestedPort;
    isConnectedState = true;

    // --- NEW: Get and store the writer ---
    if (serialPort.writable) {
      writableStreamDefaultWriter = serialPort.writable.getWriter();
      console.log("SerialService: Writable stream writer obtained.");
    } else {
      console.warn("SerialService: Port is not writable.");
      // This might not be an error if the use case is read-only,
      // but for Aresplot, we'll need it.
    }
    // --- END NEW ---

    console.log("SerialService: Port opened successfully.", options);
    eventBus.emit("serial:connected", { portInfo: requestedPort.getInfo() });

    removeExternalDisconnectListener();
    currentDisconnectHandler = (event) => handleExternalDisconnect(event);
    navigator.serial.addEventListener("disconnect", currentDisconnectHandler);

    return true;
  } catch (error) {
    console.error(
      "SerialService: Connection failed:",
      error.name,
      error.message
    );
    let userMessage = `串口连接失败: ${error.message}`;
    if (error.name === "NotFoundError") userMessage = "未选择串口。";
    else if (error.name === "InvalidStateError")
      userMessage = `串口打开失败 (已被占用?): ${error.message}`;
    eventBus.emit("serial:error", new Error(userMessage));
    await cleanupConnectionState(requestedPort); // Pass port to cleanup
    return false;
  }
}

/**
 * Disconnects the currently connected serial port.
 * @returns {Promise<boolean>} True if disconnection was successful or already disconnected.
 */
async function disconnect() {
  const portToClose = serialPort; // Capture current port reference
  await cleanupConnectionState(portToClose); // Pass port for specific cleanup

  if (portToClose) {
    eventBus.emit("serial:status", "正在关闭串口...");
    try {
      // Note: readable might have been transferred, so only close the port itself
      await portToClose.close();
      console.log("SerialService: Port closed successfully.");
      eventBus.emit("serial:disconnected");
      return true;
    } catch (error) {
      console.warn(`SerialService: Error closing port: ${error.message}`);
      eventBus.emit(
        "serial:error",
        new Error(`关闭串口时出错: ${error.message}`)
      );
      return false;
    }
  }
  return true; // Already disconnected
}

/**
 * Writes data to the connected serial port.
 * @param {Uint8Array|ArrayBuffer} data - The data to write.
 * @returns {Promise<void>}
 * @throws {Error} if not connected, port not writable, or write fails.
 */
async function write(data) {
  if (!isConnectedState || !serialPort || !serialPort.writable) {
    throw new Error("SerialService: Not connected or port not writable.");
  }
  if (!writableStreamDefaultWriter) {
    // Attempt to get writer again if it wasn't obtained during connect or was released
    try {
      writableStreamDefaultWriter = serialPort.writable.getWriter();
      console.log("SerialService: Re-acquired writable stream writer.");
    } catch (e) {
      throw new Error(`SerialService: Failed to get writer: ${e.message}`);
    }
  }

  try {
    await writableStreamDefaultWriter.write(data);
    // console.debug("SerialService: Data written successfully:", data);
  } catch (error) {
    console.error("SerialService: Error writing data:", error);
    // Attempt to gracefully handle writer errors, potentially by releasing and trying to reacquire next time
    try {
      writableStreamDefaultWriter.releaseLock();
      writableStreamDefaultWriter = null;
      console.warn(
        "SerialService: Writer released due to write error. Will attempt to reacquire on next write."
      );
    } catch (releaseError) {
      console.error(
        "SerialService: Error releasing writer after write error:",
        releaseError
      );
    }
    throw new Error(`SerialService: Write failed: ${error.message}`);
  }
}

/**
 * Checks if currently connected to a serial port.
 * @returns {boolean}
 */
function isConnected() {
  return isConnectedState && serialPort !== null;
}

/**
 * Gets the readable stream of the current port.
 * @returns {ReadableStream | null}
 */
function getReadableStream() {
  if (serialPort && serialPort.readable && !serialPort.readable.locked) {
    // Check if not locked
    return serialPort.readable;
  }
  if (serialPort && serialPort.readable && serialPort.readable.locked) {
    console.warn("SerialService: ReadableStream is locked. Cannot transfer.");
  }
  return null;
}

/**
 * (Internal) Gets the raw SerialPort object. Use with caution.
 * Needed by main.js to potentially re-acquire writer if it gets into a bad state,
 * or for advanced operations.
 * @returns {SerialPort | null}
 */
function getInternalPortReference() {
  return serialPort;
}

// --- Internal helper functions ---

function handleExternalDisconnect(event) {
  if (serialPort && event.target === serialPort) {
    console.warn(
      "SerialService: External disconnect event for the connected port."
    );
    cleanupConnectionState(serialPort); // Pass the port that disconnected
    eventBus.emit("serial:disconnected", { external: true });
  }
}

function removeExternalDisconnectListener() {
  if (currentDisconnectHandler) {
    navigator.serial.removeEventListener(
      "disconnect",
      currentDisconnectHandler
    );
    currentDisconnectHandler = null;
  }
}

/**
 * Cleans up internal connection state and releases resources.
 * @param {SerialPort | null} portInstance - The specific port instance to clean up resources for.
 */
async function cleanupConnectionState(portInstance) {
  removeExternalDisconnectListener(); // General listener removal

  // Release writer specifically for the portInstance if it matches the active one
  if (
    writableStreamDefaultWriter &&
    portInstance &&
    serialPort === portInstance
  ) {
    try {
      // Check if port is still open before trying to abort/release
      if (portInstance.writable) {
        // Check if writable exists (might be null if port closed abruptly)
        await writableStreamDefaultWriter
          .abort()
          .catch((e) =>
            console.warn(
              "SerialService: Error aborting writer during cleanup:",
              e
            )
          );
      }
    } catch (e) {
      console.warn(
        "SerialService: Exception during writer abort in cleanup (port might be already closed):",
        e
      );
    } finally {
      try {
        // The lock might be released by abort, or if not, try to release it.
        // This can error if already released or if the stream is broken.
        if (
          writableStreamDefaultWriter &&
          typeof writableStreamDefaultWriter.releaseLock === "function"
        ) {
          writableStreamDefaultWriter.releaseLock();
        }
      } catch (e) {
        console.warn(
          "SerialService: Exception during writer releaseLock in cleanup:",
          e
        );
      }
      writableStreamDefaultWriter = null;
      console.log("SerialService: Writable stream writer released and nulled.");
    }
  } else if (writableStreamDefaultWriter && !portInstance) {
    // If called without a specific port (e.g., general disconnect), clear the global writer
    writableStreamDefaultWriter = null;
  }

  // If cleaning up the active port, reset global state
  if (portInstance && serialPort === portInstance) {
    serialPort = null;
    isConnectedState = false;
  } else if (!portInstance) {
    // General cleanup if no specific port given
    serialPort = null;
    isConnectedState = false;
  }
  // console.log("SerialService: Connection state potentially cleaned up.");
}

// Export public interface
export {
  connect,
  disconnect,
  write,
  isConnected,
  getReadableStream,
  getInternalPortReference,
};
