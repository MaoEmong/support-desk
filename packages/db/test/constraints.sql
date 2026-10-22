\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  tenant_a uuid := gen_random_uuid(); tenant_b uuid := gen_random_uuid();
  customer_a uuid := gen_random_uuid(); ticket_a uuid := gen_random_uuid();
  conversation_a uuid := gen_random_uuid();
BEGIN
  INSERT INTO tenants(id,slug,name) VALUES(tenant_a,'constraint-a-'||tenant_a,'A'),(tenant_b,'constraint-b-'||tenant_b,'B');
  INSERT INTO users(id,tenant_id,email,name,password_hash,role) VALUES(customer_a,tenant_a,'a@example.test','A','test-only','customer');
  INSERT INTO tickets(id,tenant_id,customer_id,title,body) VALUES(ticket_a,tenant_a,customer_a,'Contract','Test');
  INSERT INTO conversations(id,tenant_id,customer_id) VALUES(conversation_a,tenant_a,customer_a);
  INSERT INTO conversation_messages(tenant_id,conversation_id,role,body) VALUES(tenant_a,conversation_a,'user','Question'),(tenant_a,conversation_a,'assistant','Answer'),(tenant_a,conversation_a,'system','Notice');
  INSERT INTO ai_jobs(tenant_id,ticket_id,kind,idempotency_key) VALUES(tenant_a,ticket_a,'regenerate_draft','regenerate');
  INSERT INTO audit_log(tenant_id,action,target_type,target_id,meta) VALUES(tenant_a,'test','resource','non-uuid-target',NULL);
  BEGIN
    INSERT INTO ai_jobs(tenant_id,ticket_id,kind,idempotency_key) VALUES(tenant_a,ticket_a,'process_inquiry','missing-message');
    RAISE EXCEPTION 'Expected process_inquiry null message rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO tickets(tenant_id,customer_id,title,body) VALUES(tenant_b,customer_a,'Invalid tenant','Test');
    RAISE EXCEPTION 'Expected cross-tenant customer rejection';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO conversation_messages(tenant_id,conversation_id,role,body) VALUES(tenant_a,conversation_a,'customer','Invalid role');
    RAISE EXCEPTION 'Expected legacy conversation role rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
