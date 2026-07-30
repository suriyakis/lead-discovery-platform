CREATE TABLE "platform_secrets" (
	"key" text PRIMARY KEY NOT NULL,
	"encrypted_value" "bytea" NOT NULL,
	"scope" text NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
