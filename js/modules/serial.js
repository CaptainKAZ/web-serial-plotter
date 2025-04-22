// js/modules/serial.js (Refactored as SerialService using EventBus)
import { eventBus } from "../event_bus.js";

let serialPort = null; // 内部状态，存储当前连接的端口
let isConnectedState = false; // 内部连接状态标志
let currentDisconnectHandler = null; // 存储事件处理器引用以便移除

/**
 * 尝试连接到用户选择的串口。
 * @param {object} options - 连接选项 (baudRate, dataBits, etc.)
 * @returns {Promise<boolean>} 连接是否成功
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
    await disconnect(); // 先断开
  }

  // 验证传入的 options 是否包含有效的 baudRate
  if (!options || !options.baudRate || options.baudRate <= 0) {
    eventBus.emit("serial:error", new Error("连接失败：未提供有效的波特率。"));
    return false;
  }

  try {
    eventBus.emit("serial:status", "请求串口权限..."); // 发送状态事件
    const requestedPort = await navigator.serial.requestPort();
    eventBus.emit("serial:status", "正在打开串口...");

    // 使用传入的完整 options 打开端口
    await requestedPort.open(options);

    serialPort = requestedPort; // 存储端口引用
    isConnectedState = true;
    console.log("SerialService: Port opened successfully.", options);
    eventBus.emit("serial:connected", { portInfo: requestedPort.getInfo() }); // 触发连接成功事件

    // 添加断开连接监听器
    removeExternalDisconnectListener(); // 先移除旧的，防止重复添加
    currentDisconnectHandler = (event) => handleExternalDisconnect(event); // 创建新的处理器
    navigator.serial.addEventListener("disconnect", currentDisconnectHandler);

    return true;
  } catch (error) {
    console.error(
      "SerialService: Connection failed:",
      error.name,
      error.message
    );
    let userMessage = `串口连接失败: ${error.message}`;
    if (error.name === "NotFoundError") {
      userMessage = "未选择串口。";
    } else if (error.name === "InvalidStateError") {
      userMessage = `串口打开失败 (已被占用?): ${error.message}`;
    }
    eventBus.emit("serial:error", new Error(userMessage));
    serialPort = null;
    isConnectedState = false;
    return false;
  }
}

/**
 * 断开当前连接的串口。
 * @returns {Promise<boolean>} 断开是否成功
 */
async function disconnect() {
  if (!serialPort) {
    console.warn("SerialService: Disconnect called but no port connected.");
    // 确保状态和监听器被清理
    cleanupConnectionState();
    return true; // 已经是断开状态
  }

  const portToClose = serialPort; // 暂存引用
  // 清理状态和监听器 *之前* 尝试 close，因为 close 可能需要时间或出错
  cleanupConnectionState();
  eventBus.emit("serial:status", "正在关闭串口...");

  try {
    // 注意：如果 ReadableStream 已经被传输到 Worker，这里的 cancel/close 可能作用有限
    // Worker 中的读取循环应该在收到 stop 指令或流关闭时自行停止
    // 这里主要是关闭主线程持有的 Port 对象引用
    await portToClose.close();
    console.log("SerialService: Port closed successfully.");
    eventBus.emit("serial:disconnected"); // 触发断开事件
    return true;
  } catch (error) {
    console.warn(`SerialService: Error closing port: ${error.message}`);
    eventBus.emit(
      "serial:error",
      new Error(`关闭串口时出错: ${error.message}`)
    );
    return false; // 关闭失败
  }
}

/**
 * 检查当前是否连接到串口。
 * @returns {boolean}
 */
function isConnected() {
  // 注意：即使端口对象存在，物理连接也可能丢失。
  // isConnectedState 提供了一个更可靠的内部状态。
  // return serialPort !== null && serialPort.readable; // 旧方式不可靠
  return isConnectedState;
}

/**
 * 获取当前端口的可读流 (如果需要传递给 Worker)。
 * 仅在主线程需要直接访问流时使用，通常在连接成功后立即获取并传递。
 * @returns {ReadableStream | null}
 */
function getReadableStream() {
  if (serialPort && serialPort.readable) {
    return serialPort.readable;
  }
  return null;
}

// --- 内部辅助函数 ---

/**
 * 处理来自浏览器的外部 'disconnect' 事件。
 * @param {Event} event
 */
function handleExternalDisconnect(event) {
  // 检查断开的端口是否是我们当前连接的端口
  if (serialPort && event.target === serialPort) {
    console.warn(
      "SerialService: External disconnect event detected for the connected port."
    );
    // 清理状态并触发事件
    cleanupConnectionState();
    eventBus.emit("serial:disconnected", { external: true }); // 触发断开事件，标记为外部触发
  } else {
    console.log(
      "SerialService: Ignoring external disconnect event for unrelated port."
    );
  }
}

/**
 * 移除外部断开连接的事件监听器。
 */
function removeExternalDisconnectListener() {
  if (currentDisconnectHandler) {
    navigator.serial.removeEventListener(
      "disconnect",
      currentDisconnectHandler
    );
    currentDisconnectHandler = null;
    // console.log("SerialService: Removed external disconnect listener.");
  }
}

/**
 * 清理内部连接状态和监听器。
 */
function cleanupConnectionState() {
  removeExternalDisconnectListener();
  serialPort = null;
  isConnectedState = false;
  // console.log("SerialService: Connection state cleaned up.");
}

// 导出公共接口
export { connect, disconnect, isConnected, getReadableStream };
