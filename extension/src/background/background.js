import { CaptureController } from "./capture-controller.js";
import { CaptureStore } from "./capture-store.js";

const store = new CaptureStore();
const controller = new CaptureController(store);

void controller.start();

browser.runtime.onMessage.addListener((message) => {
  return controller.handleMessage(message);
});
