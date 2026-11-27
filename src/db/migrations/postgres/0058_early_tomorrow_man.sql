CREATE TABLE "run_context" (
	"run_id" text PRIMARY KEY NOT NULL,
	"tokens_used" integer NOT NULL,
	"window_tokens" integer NOT NULL,
	"model" text NOT NULL,
	"observed_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_context" ADD CONSTRAINT "run_context_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_context" ENABLE ROW LEVEL SECURITY;