/**
 * Default renderer for the `agent_report` PR-body fragment
 * (namphuongtran/warren#42): the run's final assistant message, fenced so it
 * cannot break the surrounding markdown, and capped so a long message cannot
 * crowd out the rest of the body.
 */

import { fencedBlock } from "../core/markdown-fence.ts";
import { PREVIEW_FRAGMENT_END, PREVIEW_FRAGMENT_START } from "./pr.ts";

/** UTF-8 byte cap on the reported message (8 KiB), split between its start and end. */
export const AGENT_REPORT_MAX_BYTES = 8 * 1024;

const ELISION = "\n\n[… middle of the message truncated …]\n\n";

const utf8 = new TextEncoder();

/** Whole code points from the front of `chars` that fit in `maxBytes`. */
function takeWithin(chars: readonly string[], maxBytes: number): string[] {
	const kept: string[] = [];
	let bytes = 0;
	for (const ch of chars) {
		const size = utf8.encode(ch).length;
		if (bytes + size > maxBytes) break;
		bytes += size;
		kept.push(ch);
	}
	return kept;
}

/**
 * Keep the start and the end of an oversized message. Handoff caveats ("X is
 * untested in CI") usually close the message, so a head-only cut would drop
 * the very line a reviewer needs.
 */
function capMessage(text: string): string {
	const half = Math.floor((AGENT_REPORT_MAX_BYTES - utf8.encode(ELISION).length) / 2);
	const chars = [...text];
	const head = takeWithin(chars, half).join("");
	const tail = takeWithin([...chars].reverse(), half)
		.reverse()
		.join("");
	return `${head}${ELISION}${tail}`;
}

/**
 * `annotatePrPreview` patches the FIRST preview-marker pair in the body, and
 * this section sits above `## Preview`. Re-spell a quoted marker so it can
 * never be mistaken for the real one.
 */
export function neutralizePreviewMarkers(text: string): string {
	return text
		.replaceAll(PREVIEW_FRAGMENT_START, quoted(PREVIEW_FRAGMENT_START))
		.replaceAll(PREVIEW_FRAGMENT_END, quoted(PREVIEW_FRAGMENT_END));
}

function quoted(marker: string): string {
	return marker.replace("<!-- ", "<!-- (quoted) ");
}

/** Render the `## Agent report` section, or null when there is no text. */
export function defaultAgentReport(raw: string): string | null {
	const text = neutralizePreviewMarkers(raw.trim());
	if (text === "") return null;
	const totalBytes = utf8.encode(text).length;
	const shown = totalBytes > AGENT_REPORT_MAX_BYTES ? capMessage(text) : text;
	const parts = ["## Agent report", "", fencedBlock(shown, "text")];
	if (shown !== text) {
		const kib = (totalBytes / 1024).toFixed(1);
		parts.push(
			"",
			`_Truncated: showing the first and last 4 KiB of ${kib} KiB. The full message is in the run's events._`,
		);
	}
	return parts.join("\n");
}
