import type { Gateway, Spent } from "../src/llm/gateway.js";

/** 假的网关：answer 按请求的路径和请求体给回复体；不记账，回的花费是空的。 */
export function fakeGateway(answer: (call: { path: string; body: object }) => unknown): Gateway {
  return {
    charge: () => {},
    post: async <T>(call: { path: string; body: object }) => ({
      body: answer(call) as T,
      spent: {} as Spent,
    }),
  };
}
