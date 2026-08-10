CREATE OR REPLACE FUNCTION "reject_action_audit_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'action_audit records are immutable';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "action_audit_immutable_update" ON "action_audit";
--> statement-breakpoint
CREATE TRIGGER "action_audit_immutable_update"
BEFORE UPDATE ON "action_audit"
FOR EACH ROW EXECUTE FUNCTION "reject_action_audit_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "action_audit_immutable_delete" ON "action_audit";
--> statement-breakpoint
CREATE TRIGGER "action_audit_immutable_delete"
BEFORE DELETE ON "action_audit"
FOR EACH ROW EXECUTE FUNCTION "reject_action_audit_mutation"();
