CREATE TABLE `agent_routing_overrides` (
	`agent_name` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model` text,
	`updated_at` text NOT NULL
);
