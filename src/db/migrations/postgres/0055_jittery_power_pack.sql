CREATE TABLE "provider_quota" (
	"provider" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"utilization" double precision,
	"rate_limit_type" text,
	"resets_at" bigint,
	"source" text NOT NULL,
	"source_run_id" text,
	"observed_at" text NOT NULL,
	CONSTRAINT "provider_quota_provider_credential_fingerprint_pk" PRIMARY KEY("provider","credential_fingerprint")
);
--> statement-breakpoint
ALTER TABLE "provider_quota" ENABLE ROW LEVEL SECURITY;
