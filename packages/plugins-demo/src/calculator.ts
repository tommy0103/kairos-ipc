import { createNode, type IpcNode } from "../../sdk/src/index.ts";

export interface CalculatorPluginOptions {
  uri?: string;
}

export interface CalculatorPlugin {
  node: IpcNode;
}

export function createCalculatorPlugin(options: CalculatorPluginOptions = {}): CalculatorPlugin {
  const node = createNode(options.uri ?? "plugin://demo/calculator");

  node.action(
    "add",
    {
      description: "Add two numbers.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const data = isRecord(payload.data) ? payload.data : {};
      const a = readNumber(data.a);
      const b = readNumber(data.b);
      return { mime_type: "application/json", data: { result: a + b } };
    },
  );

  return { node };
}

function readNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("calculator.add expects finite numeric a and b");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
