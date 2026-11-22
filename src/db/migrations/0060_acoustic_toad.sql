CREATE TABLE `provider_quota` (
	`provider` text NOT NULL,
	`credential_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`utilization` real,
	`rate_limit_type` text,
	`resets_at` integer,
	`source` text NOT NULL,
	`source_run_id` text,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`provider`, `credential_fingerprint`)
);
