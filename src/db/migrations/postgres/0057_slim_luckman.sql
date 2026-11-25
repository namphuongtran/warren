ALTER TABLE "runs" ADD COLUMN "protected_paths_json" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "quality_flags_json" jsonb;