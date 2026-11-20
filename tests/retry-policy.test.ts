/**
 * Which failures after the request was sent Pi retries (#100), and how long
 * the relay waits for each resolved address (#101). Pi decides from the
 * error text alone, so these tests run the text the provider actually emits
 * through Pi's own classifier. Upstreams are loopback HTTP fixtures.
 */
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { AdmissionRelay } from "../src/admission.ts";
import { gateResponse, UNSENT_FAILURE_NOTE } from "../src/completion.ts";
import { timeoutError } from "../src/errors.ts";
import type { NativeOutput } from "../src/native-output.ts";
import { CONNECT_ATTEMPT_TIMEOUT_MS, upstreamAgent } from "../src/upstream-agent.ts";
import { nativeModel } from "./support/native.ts";

function failed(errorMessage: string): AssistantMessage {
  return { stopReason: "error", errorMessage } as AssistantMessage;
}

/** Send one request through a relay to `upstream` and return the error the gate reports. */
async function gatedError(upstream: Server, timeoutMs: number): Promise<{ relay: AdmissionRelay; text: string }> {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const relay = await AdmissionRelay.create(
    `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    timeoutMs,
  );
  await new Promise<void>((resolve) => {
    const req = request(`${relay.url}/v1/messages`, { method: "POST" }, (res) => {
      res.resume();
      res.on("end", resolve);
      res.on("error", () => resolve());
    });
    req.on("error", () => resolve());
    req.end("{}");
  });
  const native = { results: [], assistants: [], nativeErrorText: "" } as unknown as NativeOutput;
  try {
    gateResponse({
      relay,
      native,
      exitCode: 0,
      childDetail: "",
      model: nativeModel(),
      nativeModelId: "claude-test",
      location: {} as never,
    });
  } catch (error) {
    return { relay, text: (error as Error).message };
  }
  assert.fail("the gate accepted a failed response");
}

test("#100 Pi retries the relay's timeout after the request was sent", async (t) => {
  // Accepts the request and never answers: the relay's idle timeout fires.
  const silent = createServer(() => {});
  t.after(() => silent.closeAllConnections());
  t.after(() => silent.close());
  const { relay, text } = await gatedError(silent, 200);
  t.after(() => relay.close());

  assert.notEqual(relay.failure?.phase, "connect");
  assert.equal(relay.failure?.message, "Upstream request timed out");
  assert.equal(relay.unsentFailure, false);
  assert.equal(text.includes(UNSENT_FAILURE_NOTE), false);
  // Deliberate: an idle timeout means a dead connection, and Pi treats a
  // timeout as transient for every provider.
  assert.equal(isRetryableAssistantError(failed(text)), true);
});

test("#100 Pi retries Claude Code's own timeout", () => {
  for (const detail of [
    "no native output within the request timeout",
    "native stdin did not accept a frame within the request timeout",
  ]) {
    assert.equal(isRetryableAssistantError(failed(timeoutError(detail).message)), true, detail);
  }
});

test("#100 Pi does not retry a reset after the request was sent", async (t) => {
  // Reads the request, then drops the connection without a response.
  const reset = createServer((req) => req.socket.destroy());
  t.after(() => reset.close());
  const { relay, text } = await gatedError(reset, 5_000);
  t.after(() => relay.close());

  assert.notEqual(relay.failure?.phase, "connect");
  assert.equal(relay.unsentFailure, false);
  assert.equal(isRetryableAssistantError(failed(text)), false, text);
});

test("#101 the relay waits 2 s for each resolved address", () => {
  assert.equal(CONNECT_ATTEMPT_TIMEOUT_MS, 2_000);
  for (const scheme of ["https:", "http:"] as const) {
    const options = (upstreamAgent(scheme) as unknown as { options: Record<string, unknown> }).options;
    assert.equal(options["autoSelectFamilyAttemptTimeout"], CONNECT_ATTEMPT_TIMEOUT_MS, scheme);
  }
});
