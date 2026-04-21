import path from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(__filename);
const automationRoot = process.env.AURA_NATIVE_AUTOMATION_ROOT;

if (!automationRoot) {
  throw new Error("AURA_NATIVE_AUTOMATION_ROOT is required.");
}

const automation = requireCjs(path.join(automationRoot, "automation.cjs")) as Record<string, (...args: unknown[]) => unknown>;

interface WorkerRequest {
  id: number;
  method: string;
  args?: unknown[];
}

interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

const serializeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const isWorkerRequest = (value: unknown): value is WorkerRequest =>
  Boolean(value)
  && typeof value === "object"
  && typeof (value as WorkerRequest).id === "number"
  && typeof (value as WorkerRequest).method === "string";

const sendResponse = (response: WorkerResponse): void => {
  if (typeof process.send === "function") {
    process.send(response);
  }
};

const handleRequest = async (request: WorkerRequest): Promise<void> => {
  try {
    const fn = automation[request.method];
    if (typeof fn !== "function") {
      if (request.method === "runStructuredCommand") {
        sendResponse({ id: request.id, result: null });
        return;
      }
      throw new Error(`Unsupported automation method: ${request.method}`);
    }

    const result = await Promise.resolve(fn(...(request.args ?? [])));
    sendResponse({ id: request.id, result });
  } catch (error) {
    sendResponse({ id: request.id, error: serializeError(error) });
  }
};

process.on("message", (message) => {
  if (!isWorkerRequest(message)) {
    return;
  }

  void handleRequest(message);
});
