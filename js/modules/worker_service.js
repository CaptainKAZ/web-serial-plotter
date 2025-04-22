// js/modules/worker_service.js
import { eventBus } from "../event_bus.js";

let worker = null;
let workerUrl = null; // 用于释放 Object URL

/**
 * 初始化 Worker Service，创建 Web Worker。
 * @returns {Promise<boolean>} 初始化成功或失败
 */
async function init() {
  if (worker) {
    console.warn("WorkerService already initialized.");
    return true;
  }
  try {
    const workerResponse = await fetch("js/worker/data_worker.js");
    if (!workerResponse.ok)
      throw new Error(
        `Failed to fetch worker script: ${workerResponse.statusText}`
      );
    const workerCode = await workerResponse.text();
    const blob = new Blob([workerCode], { type: "application/javascript" });
    workerUrl = URL.createObjectURL(blob);
    worker = new Worker(workerUrl);

    // 设置 Worker 消息监听器
    worker.onmessage = (event) => {
      const { type, payload } = event.data;
      switch (type) {
        case "dataBatch":
          eventBus.emit("worker:dataBatch", payload);
          break;
        case "status":
          eventBus.emit("worker:status", payload);
          break;
        case "error":
          console.error("Worker reported error:", payload);
          eventBus.emit("worker:error", new Error(payload)); // 将错误包装成 Error 对象
          break;
        case "warn":
          console.warn("Worker warning:", payload);
          eventBus.emit("worker:warn", payload);
          break;
        default:
          console.log(
            "WorkerService received unknown message type from worker:",
            type
          );
      }
    };

    // 设置 Worker 错误监听器
    worker.onerror = (error) => {
      console.error("Unhandled Worker Error Event:", error);
      eventBus.emit("worker:error", error); // 转发错误事件
      // Consider terminating worker on unrecoverable error?
      // terminate();
    };

    console.log("WorkerService initialized, Worker created.");
    return true;
  } catch (error) {
    console.error("WorkerService initialization failed:", error);
    eventBus.emit(
      "worker:error",
      new Error(`Worker initialization failed: ${error.message}`)
    );
    worker = null;
    if (workerUrl) {
      URL.revokeObjectURL(workerUrl);
      workerUrl = null;
    }
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
function stopWorker() {
  if (!worker) {
    console.warn(
      "WorkerService: Cannot stop, worker not initialized or already terminated."
    );
    return;
  }
  console.log("WorkerService: Sending stop command to worker.");
  worker.postMessage({ type: "stop" });
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
