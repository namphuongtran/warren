CREATE TABLE `run_context` (
	`run_id` text PRIMARY KEY NOT NULL,
	`tokens_used` integer NOT NULL,
	`window_tokens` integer NOT NULL,
	`model` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
