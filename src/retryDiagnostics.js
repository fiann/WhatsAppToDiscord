// Retry receipts are how a recipient device tells us it couldn't decrypt one
// of our messages. Baileys only logs them at debug level, without the
// recipient's error code or whether it supplied a fresh prekey bundle — the
// two facts needed to tell *why* decryption failed (no session, bad key,
// addressing mismatch...). This logs a capped sample at info level.
const DEFAULT_MAX_LOGGED = 60;

const childOf = (node, tag) =>
	Array.isArray(node?.content)
		? node.content.find((child) => child?.tag === tag)
		: undefined;

const describeRetryReceipt = (node) => {
	const retry = childOf(node, "retry");
	return {
		id: node?.attrs?.id,
		from: node?.attrs?.from,
		participant: node?.attrs?.participant,
		count: retry?.attrs?.count,
		retryError: retry?.attrs?.error,
		retryVersion: retry?.attrs?.v,
		hasPrekeyBundle: Boolean(childOf(node, "keys")),
		hasRegistration: Boolean(childOf(node, "registration")),
	};
};

const attachRetryReceiptDiagnostics = (
	ws,
	logger,
	{ maxLogged = DEFAULT_MAX_LOGGED } = {},
) => {
	if (!ws || typeof ws.on !== "function") return;
	let logged = 0;
	ws.on("CB:receipt,type:retry", (node) => {
		if (logged >= maxLogged) return;
		logged += 1;
		try {
			logger?.info?.(
				{ ...describeRetryReceipt(node), sample: `${logged}/${maxLogged}` },
				"Retry receipt diagnostics",
			);
		} catch {
			// Diagnostics must never affect message handling.
		}
	});
};

const describeGroupStanza = (node) => ({
	id: node?.attrs?.id,
	from: node?.attrs?.from,
	participant: node?.attrs?.participant,
	participantPn: node?.attrs?.participant_pn,
	addressingMode: node?.attrs?.addressing_mode,
	encTypes: Array.isArray(node?.content)
		? node.content
				.filter((child) => child?.tag === "enc")
				.map((child) => child.attrs?.type)
		: [],
});

// A group message normally arrives as an "skmsg" (encrypted with the author's
// sender key), optionally alongside a "pkmsg"/"msg" carrying the pairwise-
// encrypted sender key itself. "No session found to decrypt message" means we
// never got that key; this shows whether the carrier was in the stanza at all.
const attachInboundGroupStanzaDiagnostics = (
	ws,
	logger,
	{ maxLogged = 150 } = {},
) => {
	if (!ws || typeof ws.on !== "function") return;
	let logged = 0;
	ws.on("CB:message", (node) => {
		if (logged >= maxLogged) return;
		if (!node?.attrs?.from?.endsWith?.("@g.us")) return;
		logged += 1;
		try {
			logger?.info?.(
				{ ...describeGroupStanza(node), sample: `${logged}/${maxLogged}` },
				"Inbound group stanza diagnostics",
			);
		} catch {
			// Diagnostics must never affect message handling.
		}
	});
};

export {
	attachInboundGroupStanzaDiagnostics,
	attachRetryReceiptDiagnostics,
	describeGroupStanza,
	describeRetryReceipt,
};
