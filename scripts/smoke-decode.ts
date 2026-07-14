/**
 * Lightweight decode smoke checks (run: node --experimental-strip-types scripts/smoke-decode.ts)
 */
import { decodeUsageMessage, isControlMessage } from "../src/ingest/decode.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const sample = JSON.stringify({
  request_id: "req-1",
  timestamp: "2026-07-14T08:00:00Z",
  model: "gpt-4o-mini",
  provider: "openai",
  api_key: "sk-xxx",
  auth_index: "auth-1",
  failed: false,
  latency_ms: 120,
  tokens: {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
  },
});

const d = decodeUsageMessage(sample);
assert(d.kind === "event", "expected event");
if (d.kind === "event") {
  assert(d.event.eventKey === "req-1", "eventKey");
  assert(d.event.totalTokens === 30, "tokens");
  assert(d.event.apiGroupKey === "sk-xxx", "api group");
}

assert(isControlMessage('{"refresh":true}'), "control refresh");
assert(decodeUsageMessage('{"refresh":true}').kind === "control", "decode control");
assert(decodeUsageMessage("{}").kind === "invalid", "missing request_id");

console.log("smoke-decode: ok");
