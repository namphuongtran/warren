import { type Dispatch, type SetStateAction, useState } from "react";
import type { RunRow } from "@/api/types.ts";
import { FilterPill } from "@/components/ui/filter-pill.tsx";
import { cn } from "@/lib/utils.ts";
import { qualityGateView } from "@/pages/run-detail/summary-model.ts";
import {
	RUN_LIST_PR_FILTERS,
	RUN_QUALITY_GATE_OUTCOMES,
	type RunListPrFilter,
	type RunQualityGateOutcome,
} from "../../../../core/wire.ts";

/*
 * Runs filter bar (warren-6419 / pl-4ab6): owns the filter vocabulary
 * and both responsive renderings of the runs filter strip.
 *
 * md+ keeps the export's surface bar — four native selects, Clear,
 * and the search input — exactly as it shipped (do not reintroduce the
 * '⌄' glyph warren-7f85 removed).
 *
 * Below md the wrapped select block violates the mobile artboard
 * (docs/ui-revamp/screens/mobile/runs.jsx:70-91): it becomes ONE
 * non-wrapping overflow-x pill strip — an "All" chip, one dismissible
 * chip per active filter, and a "＋ Filter" disclosure that expands to
 * the full select + search set. Pills reuse filter-pill.tsx with
 * radius/padding overrides to match the artboard chips.
 *
 * namphuongtran/warren#39 adds the review filters to both renderings, which
 * share one `FilterControls` set: Gate, PR, and the operator's "Needs
 * attention" toggle. All three filter on the server, across pages.
 */

/** State filter values. "active" = running + queued (the export's chip). */
export const STATE_FILTERS = [
	"all",
	"active",
	"running",
	"queued",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

export interface PageFilters {
	state: StateFilter;
	agent: "all" | string;
	project: "all" | string;
	trigger: "all" | string;
	gate: "all" | RunQualityGateOutcome;
	pr: "all" | RunListPrFilter;
	/** Operator-only: the runs the Needs attention page lists over 30 days. */
	attention: boolean;
	search: string;
}

export const NO_FILTERS: PageFilters = {
	state: "all",
	agent: "all",
	project: "all",
	trigger: "all",
	gate: "all",
	pr: "all",
	attention: false,
	search: "",
};

/** True while any filter narrows the list. */
export function isAnyFilterActive(filters: PageFilters): boolean {
	return (
		filters.state !== "all" ||
		filters.agent !== "all" ||
		filters.project !== "all" ||
		filters.trigger !== "all" ||
		filters.gate !== "all" ||
		filters.pr !== "all" ||
		filters.attention ||
		filters.search.trim().length > 0
	);
}

/** A gate outcome in the Summary tab's words: `gate not run`, `no gate`. */
function gateLabel(outcome: RunQualityGateOutcome): string {
	const word = qualityGateView(outcome, true).label.toLowerCase();
	return outcome === "unconfigured" ? word : `gate ${word}`;
}

const GATE_OPTIONS = [
	{ value: "all", label: "Gate" },
	...RUN_QUALITY_GATE_OUTCOMES.map((outcome) => ({ value: outcome, label: gateLabel(outcome) })),
];

const PR_LABELS: Readonly<Record<RunListPrFilter, string>> = {
	any: "has a PR",
	open: "PR open",
	merged: "PR merged",
};

const PR_OPTIONS = [
	{ value: "all", label: "PR" },
	...RUN_LIST_PR_FILTERS.map((pr) => ({ value: pr, label: PR_LABELS[pr] })),
];

export function matchesStateFilter(state: RunRow["state"], filter: StateFilter): boolean {
	if (filter === "all") return true;
	if (filter === "active") return state === "running" || state === "queued";
	return state === filter;
}

/**
 * Filter-bar control chrome from the export: bg, border, 27px height,
 * 10px quiet text. The state/trigger/search filters run client-side
 * over the loaded window (the list API takes no state/trigger param);
 * agent/project/gate/PR/attention filters push to the server via the list
 * query params.
 */
function FilterSelect({
	label,
	value,
	onChange,
	options,
	title,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
	title?: string;
}) {
	return (
		<select
			aria-label={label}
			title={title}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className={cn(
				"h-[27px] rounded-(--radius-sm) border border-(--color-border) bg-(--color-bg) px-2 text-[10px] leading-3 text-(--color-text-2)",
				value !== "all" && "border-(--color-border-strong)",
			)}
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	);
}

interface RunsFilterBarProps {
	filters: PageFilters;
	setFilters: Dispatch<SetStateAction<PageFilters>>;
	agentNames: string[];
	projects: { id: string; gitUrl: string }[];
	triggerOptions: { value: string; label: string }[];
	/** The attention filter is operator-only: `GET /attention` is. */
	isOperator: boolean;
}

/** One dismissible mobile chip: "state:active ×" clears that filter. */
function ActiveFilterChip({
	setFilters,
	field,
	label,
}: {
	setFilters: Dispatch<SetStateAction<PageFilters>>;
	field: keyof PageFilters;
	label: string;
}) {
	return (
		<FilterPill
			active={false}
			aria-label={`Remove filter ${label}`}
			onClick={() => setFilters((f) => ({ ...f, [field]: NO_FILTERS[field] }))}
			className="text-2xs shrink-0 rounded-(--radius-sm) border-(--color-border) bg-(--color-bg) px-[9px] py-1 font-mono text-(--color-primary)"
		>
			{label} ×
		</FilterPill>
	);
}

/**
 * The whole control set, shared by the md+ surface bar and the phone
 * disclosure: the selects, the operator's attention toggle, Clear, and the
 * id/seed search.
 */
function FilterControls({
	filters,
	setFilters,
	agentNames,
	projects,
	triggerOptions,
	isOperator,
}: RunsFilterBarProps) {
	const anyFilterActive = isAnyFilterActive(filters);
	return (
		<>
			<FilterSelect
				label="State"
				value={filters.state}
				onChange={(v) => setFilters((f) => ({ ...f, state: v as StateFilter }))}
				options={STATE_FILTERS.map((s) => ({ value: s, label: s === "all" ? "State" : s }))}
				title="Filters the loaded page client-side; the list API takes no state param yet"
			/>
			<FilterSelect
				label="Agent"
				value={filters.agent}
				onChange={(v) => setFilters((f) => ({ ...f, agent: v }))}
				options={[
					{ value: "all", label: "Agent" },
					...agentNames.map((n) => ({ value: n, label: n })),
				]}
			/>
			<FilterSelect
				label="Project"
				value={filters.project}
				onChange={(v) => setFilters((f) => ({ ...f, project: v }))}
				options={[
					{ value: "all", label: "Project" },
					...projects.map((p) => ({
						value: p.id,
						label: p.gitUrl.replace(/^https:\/\/github\.com\//, ""),
					})),
				]}
			/>
			<FilterSelect
				label="Trigger"
				value={filters.trigger}
				onChange={(v) => setFilters((f) => ({ ...f, trigger: v }))}
				options={triggerOptions}
			/>
			<FilterSelect
				label="Quality gate"
				value={filters.gate}
				onChange={(v) => setFilters((f) => ({ ...f, gate: v as PageFilters["gate"] }))}
				options={GATE_OPTIONS}
			/>
			<FilterSelect
				label="Pull request"
				value={filters.pr}
				onChange={(v) => setFilters((f) => ({ ...f, pr: v as PageFilters["pr"] }))}
				options={PR_OPTIONS}
			/>
			{isOperator ? (
				<FilterPill
					active={filters.attention}
					onClick={() => setFilters((f) => ({ ...f, attention: !f.attention }))}
					title="Runs that wait on you: blocked, review changes, failed, or a quality signal (last 30 days)"
					className="text-2xs h-7 rounded-(--radius-sm) border-(--color-border) px-2 py-0"
				>
					Needs attention
				</FilterPill>
			) : null}
			<button
				type="button"
				onClick={() => setFilters(NO_FILTERS)}
				className={cn(
					"text-2xs flex h-[25px] items-center px-2 font-medium",
					anyFilterActive
						? "text-(--color-text-2) hover:text-(--color-text)"
						: "text-(--color-text-3) opacity-60",
				)}
				disabled={!anyFilterActive}
			>
				Clear
			</button>
			<span className="flex-1" />
			<input
				type="search"
				aria-label="Filter by run ID or seed"
				placeholder="Filter by run ID or seed"
				value={filters.search}
				onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
				className="text-2xs h-[27px] w-[220px] shrink-0 rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-bg) px-[9px] text-(--color-text-2) placeholder:text-(--color-text-3)"
			/>
		</>
	);
}

/** The phone strip's dismissible chips, one per active filter. */
function ActiveFilterChips({
	filters,
	setFilters,
	projectLabel,
}: Pick<RunsFilterBarProps, "filters" | "setFilters"> & {
	projectLabel: (id: string) => string;
}) {
	const search = filters.search.trim();
	const chips: { field: keyof PageFilters; label: string }[] = [
		...(filters.state !== "all"
			? [{ field: "state" as const, label: `state:${filters.state}` }]
			: []),
		...(filters.agent !== "all"
			? [{ field: "agent" as const, label: `agent:${filters.agent}` }]
			: []),
		...(filters.project !== "all"
			? [{ field: "project" as const, label: `project:${projectLabel(filters.project)}` }]
			: []),
		...(filters.trigger !== "all"
			? [{ field: "trigger" as const, label: `trigger:${filters.trigger}` }]
			: []),
		...(filters.gate !== "all" ? [{ field: "gate" as const, label: gateLabel(filters.gate) }] : []),
		...(filters.pr !== "all" ? [{ field: "pr" as const, label: PR_LABELS[filters.pr] }] : []),
		...(filters.attention ? [{ field: "attention" as const, label: "needs attention" }] : []),
		...(search.length > 0 ? [{ field: "search" as const, label: `search:${search}` }] : []),
	];
	return (
		<>
			{chips.map((chip) => (
				<ActiveFilterChip
					key={chip.field}
					setFilters={setFilters}
					field={chip.field}
					label={chip.label}
				/>
			))}
		</>
	);
}

export function RunsFilterBar(props: RunsFilterBarProps) {
	const { filters, setFilters, projects } = props;
	const [disclosureOpen, setDisclosureOpen] = useState(false);
	const anyFilterActive = isAnyFilterActive(filters);

	const projectLabel = (id: string) => {
		const p = projects.find((x) => x.id === id);
		return p ? p.gitUrl.replace(/^https:\/\/github\.com\//, "") : id;
	};

	return (
		<>
			{/* Mobile (below md): one non-wrapping overflow-x pill strip
			    (warren-6419). Artboard: gap 6, overflow clip. */}
			<div className="md:hidden">
				<div
					className="flex [scrollbar-width:none] items-center gap-1.5 overflow-x-auto pb-3 [&::-webkit-scrollbar]:hidden"
					data-testid="runs-mobile-filter-strip"
				>
					<FilterPill
						active={!anyFilterActive}
						aria-label="Clear all filters"
						onClick={() => setFilters(NO_FILTERS)}
						className="text-2xs shrink-0 rounded-(--radius-sm) border-(--color-border-strong) bg-(--color-surface-raised) px-[9px] py-1 font-medium text-(--color-text)"
					>
						All
					</FilterPill>
					<ActiveFilterChips
						filters={filters}
						setFilters={setFilters}
						projectLabel={projectLabel}
					/>
					<FilterPill
						active={disclosureOpen}
						aria-expanded={disclosureOpen}
						onClick={() => setDisclosureOpen((o) => !o)}
						className="text-2xs shrink-0 rounded-(--radius-sm) border-(--color-border) bg-(--color-bg) px-[9px] py-1 font-mono text-(--color-text-3)"
					>
						＋ Filter
					</FilterPill>
				</div>
				{disclosureOpen && (
					<div className="flex flex-wrap items-center gap-[7px] rounded-t-(--radius-md) border border-(--color-border) bg-(--color-surface) px-[9px] py-[7px]">
						<FilterControls {...props} />
					</div>
				)}
			</div>

			{/* md+ (the export's surface bar) — unchanged below md it is hidden. */}
			<div className="hidden shrink-0 flex-wrap items-center gap-[7px] rounded-t-(--radius-md) border border-(--color-border) bg-(--color-surface) px-[9px] py-[7px] md:flex">
				<FilterControls {...props} />
			</div>
		</>
	);
}
