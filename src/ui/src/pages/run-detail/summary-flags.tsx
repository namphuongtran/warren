import type { RunQualityFlag, RunRow } from "@/api/types.ts";
import { ExternalLink, SummaryEmpty, ToneChip } from "./summary-card.tsx";
import { plural, QUALITY_FLAG_LABELS, qualityFlagHref, qualityFlagsView } from "./summary-model.ts";

/**
 * The Quality section's shortcut flags (namphuongtran/warren#37, #38): the
 * signals reap scanned off the run's diff and git commands, each linked to
 * its file and line on the forge where the remote allows it. Flags are for a
 * reviewer to check; none of them failed the run.
 */

function location(flag: RunQualityFlag): string | null {
	if (flag.path === null) return null;
	return flag.line === null ? flag.path : `${flag.path}:${flag.line}`;
}

function FlagLocation({ flag, href }: { flag: RunQualityFlag; href: string | null }) {
	const where = location(flag);
	if (where === null) return null;
	if (href === null) return <span className="font-mono text-xs break-all">{where}</span>;
	return (
		<ExternalLink href={href} mono>
			{where}
		</ExternalLink>
	);
}

export function ShortcutFlags({
	run,
	isTerminal,
	gitUrl,
}: {
	run: RunRow;
	isTerminal: boolean;
	gitUrl: string | undefined;
}) {
	const view = qualityFlagsView(run.qualityFlags, isTerminal);
	const flags = run.qualityFlags?.flags ?? [];
	const omitted = run.qualityFlags?.omitted ?? 0;
	return (
		<>
			<ToneChip tone={view.tone}>{view.label}</ToneChip>
			<span>{view.detail}</span>
			{flags.length > 0 ? (
				<ul aria-label="Shortcut flags" className="flex flex-col gap-2">
					{flags.map((flag, i) => (
						<li
							// Flags carry no id; their order is the scan's and never changes.
							// biome-ignore lint/suspicious/noArrayIndexKey: a stored, immutable list
							key={i}
							className="flex flex-col gap-0.5"
						>
							<span className="flex flex-wrap items-center gap-x-2">
								<span className="font-medium text-(--color-text)">
									{QUALITY_FLAG_LABELS[flag.kind]}
								</span>
								<span className="font-mono break-all text-(--color-text-3)">{flag.detail}</span>
							</span>
							<FlagLocation flag={flag} href={qualityFlagHref(run, gitUrl, flag)} />
						</li>
					))}
				</ul>
			) : null}
			{omitted > 0 ? (
				<SummaryEmpty>{plural(omitted, "more flag")} found and not stored.</SummaryEmpty>
			) : null}
		</>
	);
}
