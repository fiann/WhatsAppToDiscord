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

test("retryDiagnostics: describes inbound group stanza enc types", async () => {
	const { describeGroupStanza, attachInboundGroupStanzaDiagnostics } = await import(
		"../src/retryDiagnostics.js"
	);
	const stanza = {
		tag: "message",
		attrs: { id: "M1", from: "1@g.us", participant: "2:11@lid", addressing_mode: "lid" },
		content: [{ tag: "enc", attrs: { type: "skmsg" } }],
	};
	assert.deepEqual(describeGroupStanza(stanza).encTypes, ["skmsg"]);

	const ws = new EventEmitter();
	const logs = [];
	attachInboundGroupStanzaDiagnostics(ws, { info: (o) => logs.push(o) }, { maxLogged: 1 });
	ws.emit("CB:message", { attrs: { from: "5@s.whatsapp.net" }, content: [] });
	ws.emit("CB:message", stanza);
	ws.emit("CB:message", stanza);
	assert.equal(logs.length, 1);
	assert.equal(logs[0].id, "M1");
});
