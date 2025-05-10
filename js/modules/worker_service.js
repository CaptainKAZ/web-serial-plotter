// js/modules/worker_service.js
import { eventBus } from "../event_bus.js";

let worker = null;
let workerUrl = null; // 用于释放 Object URL

/**
 * Initializes the Worker Service, creating the Web Worker as an ES module.
 * @returns {Promise<boolean>} True if initialization was successful.
 */
async function init() {
  if (worker) {
    console.warn("WorkerService already initialized.");
    return true;
  }
  try {
    const workerScriptPath = 'js/worker/data_worker.js';
    console.log(`WorkerService: Attempting to load worker from: ${workerScriptPath}`);
    worker = new Worker(workerScriptPath, { type: "module" });
    worker.onmessage = (event) => {
      const { type, payload } = event.data;
      // ... (rest of existing onmessage handler)
      switch (type) {
        case "dataBatch":
          eventBus.emit("worker:dataBatch", payload);
          break;
        case "status": // General status messages from worker
          eventBus.emit("worker:status", payload);
          break;
        case "info": // For less critical info messages, e.g., timestamp sync
          eventBus.emit("worker:info", payload); // You might need to add listener in main.js
          break;
        case "warn": // For warnings
          eventBus.emit("worker:warn", payload);
          break;
        case "error":
          console.error("Worker reported error:", payload);
          eventBus.emit("worker:error", new Error(typeof payload === 'string' ? payload : payload.message || "Unknown worker error"));
          break;
        default:
          console.log("WorkerService received unhandled message type from worker:", type, payload);
      }
    };

    worker.onerror = (error) => {
      console.error("Unhandled Worker Error Event in WorkerService:", error);
      eventBus.emit("worker:error", error);
    };

    console.log("WorkerService initialized, Worker (as module) created.");
    return true;
  } catch (error) {
    console.error("WorkerService initialization failed:", error);
    eventBus.emit("worker:error", new Error(`Worker initialization failed: ${error.message}`));
    if (workerUrl) {
      URL.revokeObjectURL(workerUrl); // Clean up blob URL if worker creation failed
      workerUrl = null;
    }
    worker = null;
    return false;
  }
}

/**
 * 向 Worker 发送启动指令。
 * @param {object} config - 启动配置 (包含 source, config, protocol, parserCode, readableStream 等)
 */
function startWorker(config) {
  if (!worker) {
    console.error("WorkerService: Cannot start, worker not initialized.");
    return;
  }
  console.log("WorkerService: Sending start command to worker:", config);
  try {
    if (config.source === "webserial" && config.readableStream) {
      // 传输 ReadableStream
      worker.postMessage({ type: "startSerialStream", payload: config }, [
        config.readableStream,
      ]);
    } else if (config.source === "simulated") {
      // 模拟数据不需要传输
      worker.postMessage({ type: "start", payload: config });
    } else {
      console.error("WorkerService: Invalid start config", config);
    }
  } catch (error) {
    console.error("WorkerService: Error sending start message:", error);
    eventBus.emit(
      "worker:error",
      new Error(`Failed to send start message: ${error.message}`)
    );
  }
}

/**
 * 向 Worker 发送停止指令。
 */
async function stopWorker() {
  if (!worker) {
    console.warn(
      "WorkerService: Cannot stop, worker not initialized or already terminated."
    );
    return;
  }
  console.log("WorkerService: Sending stop command to worker.");
  await worker.postMessage({ type: "stop" });
}

/**
 * 向 Worker 发送更新解析器的指令。
 * @param {string} protocol - 新协议名称
 * @param {string} [code] - 自定义协议的代码 (可选)
 */
function updateParser(protocol, code = "") {
  if (!worker) {
    console.error(
      "WorkerService: Cannot update parser, worker not initialized."
    );
    return;
  }
  console.log(
    `WorkerService: Sending parser update to worker - Protocol: ${protocol}`
  );
  const payload = { protocol: protocol };
  if (protocol === "custom") {
    payload.parserCode = code;
  }
  worker.postMessage({ type: "updateActiveParser", payload: payload });
}

/**
 * 终止 Worker 并清理资源。
 */
function terminate() {
  if (worker) {
    console.log("WorkerService: Terminating worker.");
    worker.terminate();
    worker = null;
  }
  if (workerUrl) {
    URL.revokeObjectURL(workerUrl);
    workerUrl = null;
    console.log("Worker Object URL revoked.");
  }
}

/**
 * 向 Worker 发送更新模拟数据配置的指令。
 * @param {object} config - 新的模拟配置对象 { numChannels, frequency, amplitude }
 */
function updateSimConfig(config) {
  if (!worker) {
      console.error("WorkerService: 无法更新模拟配置，Worker 未初始化。");
      return;
  }
  console.log("WorkerService: 向 Worker 发送 updateSimConfig 命令:", config);
  // Worker 内部已经有处理 'updateSimConfig' 的逻辑
  worker.postMessage({ type: 'updateSimConfig', payload: config });
}

// 导出公共接口
export { init, startWorker, stopWorker, updateParser, terminate, updateSimConfig};
