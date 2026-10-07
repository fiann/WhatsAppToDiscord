import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
	attachRetryReceiptDiagnostics,
	describeRetryReceipt,
} from "../src/retryDiagnostics.js";

const receipt = {
	tag: "receipt",
	attrs: { id: "ABC", from: "1@g.us", participant: "2@lid", type: "retry" },
	content: [
		{ tag: "retry", attrs: { count: "2", error: "4", v: "1" } },
		{ tag: "registration", attrs: {} },
	],
};

test("retryDiagnostics: describes error code and bundle presence", () => {
	assert.deepEqual(describeRetryReceipt(receipt), {
		id: "ABC",
		from: "1@g.us",
		participant: "2@lid",
		count: "2",
		retryError: "4",
		retryVersion: "1",
		hasPrekeyBundle: false,
		hasRegistration: true,
	});
});

test("retryDiagnostics: logs only up to the cap", () => {
	const ws = new EventEmitter();
	const logs = [];
	attachRetryReceiptDiagnostics(ws, { info: (obj) => logs.push(obj) }, { maxLogged: 2 });
	for (let i = 0; i < 5; i++) ws.emit("CB:receipt,type:retry", receipt);
	assert.equal(logs.length, 2);
	assert.equal(logs[1].sample, "2/2");
});
