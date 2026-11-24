import * as React from "react";
import { cn } from "@/lib/utils.ts";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** A multi-line text field styled to match `Input`. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
	({ className, rows = 3, ...props }, ref) => (
		<textarea
			ref={ref}
			rows={rows}
			className={cn(
				"w-full resize-y rounded-md border bg-(--color-card) px-3 py-2 text-sm shadow-xs",
				"placeholder:text-(--color-muted-foreground)",
				"focus-visible:outline-none focus-visible:ring-(--color-ring) focus-visible:ring-2",
				"disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	),
);
Textarea.displayName = "Textarea";
