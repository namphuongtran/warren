import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils.ts";

/*
 * Phase 4 shared-state primitive (warren-36f0 / pl-55a3 step 5):
 *
 * Alert / Callout — a tinted box used for inline error, success,
 * warning, info, and neutral states. Backed by the semantic status
 * palette tokens added in Phase 1 (--color-success / -warning / -info /
 * -danger / -neutral). Pattern mirrors Badge's cva variants so the token
 * surface stays predictable.
 *
 * The text is the base `--color-text` and the status hue rides the fill,
 * the border, and the icon (namphuongtran/warren#156). The `-foreground`
 * inks are for SOLID status fills: on this 10% tint they gave dark text on
 * a dark surface in the dark theme and near-white text on white in the
 * light theme, which fails WCAG contrast.
 *
 * Sizing/spacing follows the existing inline-error idiom across the UI
 * (rounded-md border, p-3, text-sm). The variant fill is a translucent
 * tint of the status color so the alert reads as the same hue family
 * as the StatusIndicator registry pulse (Phase 3) without fighting card
 * surfaces. Icon is auto-picked from the variant; pass `icon={null}` to
 * suppress or `icon={<MyIcon …/>}` to override.
 *
 * Variants:
 *   - `info`     (default) — blue Info circle
 *   - `success`  — green CheckCircle2
 *   - `warning`  — amber AlertTriangle
 *   - `danger`   — red AlertCircle
 *   - `neutral`  — gray Info circle (no semantic color)
 *
 * Role attribute is `alert` for `danger`/`warning` (assertive — screen
 * readers interrupt) and `status` for everything else (polite). Callers
 * can override via the standard `role` prop.
 */

const alertVariants = cva(
	"relative flex w-full items-start gap-2.5 rounded-md border p-3 text-sm",
	{
		variants: {
			variant: {
				info: "border-(--color-info)/30 bg-(--color-info)/10 text-(--color-text)",
				success: "border-(--color-success)/30 bg-(--color-success)/10 text-(--color-text)",
				warning: "border-(--color-warning)/30 bg-(--color-warning)/10 text-(--color-text)",
				danger: "border-(--color-danger)/30 bg-(--color-danger)/10 text-(--color-text)",
				neutral: "border-(--color-border) bg-(--color-surface) text-(--color-text)",
			},
		},
		defaultVariants: { variant: "info" },
	},
);

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;

/** The auto icon carries the variant's status hue. */
const VARIANT_ICON_TONE: Record<AlertVariant, string> = {
	info: "text-(--color-info)",
	success: "text-(--color-success)",
	warning: "text-(--color-warning)",
	danger: "text-(--color-danger)",
	neutral: "text-(--color-text-3)",
};

const VARIANT_ICON: Record<AlertVariant, LucideIcon> = {
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	danger: AlertCircle,
	neutral: Info,
};

export interface AlertProps
	extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
		VariantProps<typeof alertVariants> {
	title?: React.ReactNode;
	/** Icon override. Pass `null` to suppress the auto-selected icon. */
	icon?: React.ReactNode | null;
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
	({ className, variant, title, icon, role, children, ...props }, ref) => {
		const v = variant ?? "info";
		const Auto = VARIANT_ICON[v];
		const renderIcon =
			icon === undefined ? (
				<Auto aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", VARIANT_ICON_TONE[v])} />
			) : icon === null ? null : (
				<span className="mt-0.5 shrink-0">{icon}</span>
			);
		const resolvedRole = role ?? (v === "danger" || v === "warning" ? "alert" : "status");
		return (
			<div
				ref={ref}
				role={resolvedRole}
				className={cn(alertVariants({ variant: v }), className)}
				{...props}
			>
				{renderIcon}
				<div className="min-w-0 flex-1 space-y-0.5">
					{title ? <div className="leading-tight font-medium">{title}</div> : null}
					{children ? <div className="leading-snug">{children}</div> : null}
				</div>
			</div>
		);
	},
);
Alert.displayName = "Alert";

export { alertVariants };
