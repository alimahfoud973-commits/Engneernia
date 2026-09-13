-- ===========================================================================
-- ONE OWNER, ENFORCED BY THE DATABASE (owner decision on OPEN-22)
--
-- Specification §2.1 has always said one owner. Until now that was a check in
-- `scripts/bootstrap-owner.ts` — application discipline, not a rule. The
-- security review (§6, س-أ) called the gap theoretical *because no operational
-- path created users at all*, and named the moment it would stop being
-- theoretical: "اللحظة التي تُضاف فيها أي واجهة لإنشاء المستخدمين".
--
-- Migration 0039 added exactly that. So this is no longer a precaution.
--
-- WHAT IT COSTS, STATED PLAINLY
--   There can be no standby owner account. If the owner's credentials are
--   lost, no second privileged account exists to recover with — recovery is
--   the bootstrap script and a database backup, nothing else. That is the
--   trade the owner accepted, and it is the reason for the transfer function
--   below: handover must remain an ordinary, audited operation rather than a
--   hand-written UPDATE against production.
--
-- WHY AN INDEX AND NOT A TRIGGER
--   A partial unique index is enforced by the storage engine for every writer,
--   including a superuser and including a psql session. A trigger can be
--   disabled; `ALTER TABLE ... DISABLE TRIGGER` is one statement. The whole
--   value of moving this rule into the database is that it stops applying to
--   the well-behaved only.
-- ===========================================================================

-- A readable refusal. Without this the CREATE UNIQUE INDEX below fails with
-- "could not create unique index ... Key (role)=(OWNER) is duplicated", which
-- says nothing about which accounts are involved or what to do about it.
DO $$
DECLARE
  v_count integer;
  v_emails text;
BEGIN
  SELECT count(*), string_agg(email::text, ', ' ORDER BY created_at)
    INTO v_count, v_emails
    FROM users WHERE role = 'OWNER';

  IF v_count > 1 THEN
    RAISE EXCEPTION
      'Refusing to enforce a single owner while % owner accounts exist: %. '
      'Decide which one keeps the platform, demote the others '
      '(UPDATE users SET role = ''CUSTOMER'' WHERE id = ...), then run this migration again.',
      v_count, v_emails;
  END IF;
END;
$$;--> statement-breakpoint

-- At most one row may carry role = 'OWNER'. Partial, so the other roles are
-- untouched: any number of contributors and customers, exactly one owner.
--
-- Deliberately NOT "exactly one": a database before `bootstrap:owner` has run
-- has zero owners and must still be a valid database, and the transfer
-- function below would be unable to demote before promoting.
CREATE UNIQUE INDEX "users_single_owner" ON "users" ("role") WHERE "role" = 'OWNER';
--> statement-breakpoint

-- ===========================================================================
-- app_transfer_ownership
--
-- The whole reason a single-owner constraint is survivable. Demoting and
-- promoting are one transaction, so the platform is never ownerless and never
-- has two owners, and the index is satisfied at every statement boundary —
-- demote first, promote second, in that order, because a partial unique index
-- is checked immediately and cannot be deferred.
--
-- The outgoing owner becomes CUSTOMER, not disabled: they keep their account,
-- their purchases and their download entitlements. Losing the platform is not
-- the same as losing what you bought.
--
-- SECURITY DEFINER because `users.role` is unreachable to the application
-- role by design — the policies in 0001 keep a user away from their own role
-- column precisely so that no request can promote anybody.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_transfer_ownership(p_new_owner uuid)
  RETURNS TABLE (previous_owner uuid, new_owner uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE
    v_previous uuid;
    v_status user_status;
  BEGIN
    SELECT id INTO v_previous FROM users WHERE role = 'OWNER';

    SELECT status INTO v_status FROM users WHERE id = p_new_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No user % to hand the platform to.', p_new_owner;
    END IF;

    -- Handing the platform to an account that cannot sign in would leave it
    -- with no reachable owner at all, which is the one state this whole
    -- constraint exists to prevent.
    IF v_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'User % is %, not ACTIVE, and cannot receive the platform.',
        p_new_owner, v_status;
    END IF;

    IF v_previous = p_new_owner THEN
      RETURN QUERY SELECT v_previous, p_new_owner;
      RETURN;
    END IF;

    -- Demote FIRST. The reverse order violates the index mid-transaction.
    IF v_previous IS NOT NULL THEN
      UPDATE users SET role = 'CUSTOMER', updated_at = now() WHERE id = v_previous;
    END IF;

    UPDATE users SET role = 'OWNER', updated_at = now() WHERE id = p_new_owner;

    -- Both halves recorded, in the same transaction as the change itself.
    INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id, before, after)
    VALUES
      (p_new_owner, 'OWNER', 'USER_ROLE_CHANGED', 'user', v_previous,
       jsonb_build_object('role', 'OWNER'), jsonb_build_object('role', 'CUSTOMER')),
      (p_new_owner, 'OWNER', 'USER_ROLE_CHANGED', 'user', p_new_owner,
       jsonb_build_object('role', 'CUSTOMER'), jsonb_build_object('role', 'OWNER'));

    RETURN QUERY SELECT v_previous, p_new_owner;
  END;
  $$;
--> statement-breakpoint

-- NOT granted to app_user. Handing over the platform is an operator action run
-- against the database with the migration role, not something any request can
-- reach — there is no screen for it and there must not be one until the owner
-- asks for it.
REVOKE ALL ON FUNCTION app_transfer_ownership(uuid) FROM PUBLIC;
