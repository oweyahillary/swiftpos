-- =============================================================================
-- SwiftPOS — 00_baseline.sql
-- =============================================================================
-- The complete public schema, generated from the dev database on 2026-07-28 and
-- verified by loading it into an empty PostgreSQL 16 instance (85 tables, RLS on
-- all 85, 94 policies).
--
-- WHY THIS FILE HAD TO BE CREATED FROM A DATABASE DUMP RATHER THAN THE MIGRATIONS
--   Replaying every migration in migrations/ onto an empty database produces
--   THREE tables out of eighty-five. No file in the repo contains a CREATE TABLE
--   for businesses, branches, users, orders, order_items, products, categories,
--   payments, shifts, customers or kitchen_tickets. swiftpos_consolidated_migration.sql
--   only ALTERs tables it assumes already exist.
--
--   Until this file existed, the SwiftPOS schema was not reproducible from source.
--   It lived only inside one running Supabase project.
--
-- STATE CAPTURED HERE
--   Migrations 01-18 and 21-38: applied.
--   Migration 19 (branches.reveal_code) and 20 (branch_prices): NOT applied.
--   They remain as forward migrations to be run after this baseline.
--
-- USAGE
--   New environment:  psql -f migrations/00_baseline.sql
--                     then 19, then 20, then anything newer.
--   Existing dev DB:  do NOT run this. Record it as applied in schema_migrations.
-- =============================================================================

--
-- PostgreSQL database dump
--

\restrict YVzXcPkpAeF7gMgghJnoiKMw2kU67if95gpIh6S82n09OdDjKb9caGJavMmYkL8

-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: adjust_ingredient_stock(uuid, uuid, uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.adjust_ingredient_stock(p_ingredient_id uuid, p_branch_id uuid, p_business_id uuid, p_delta numeric) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_new NUMERIC;
BEGIN
  INSERT INTO ingredient_stock_levels
        (business_id, ingredient_id, branch_id, current_stock)
  VALUES (p_business_id, p_ingredient_id, p_branch_id, p_delta)
  ON CONFLICT (ingredient_id, branch_id) DO UPDATE
    SET current_stock = ingredient_stock_levels.current_stock + p_delta,
        updated_at    = NOW()
  RETURNING current_stock INTO v_new;

  RETURN v_new;
END;
$$;


--
-- Name: apply_credit_transaction(uuid, uuid, uuid, uuid, text, numeric, text, text, text, uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_credit_transaction(p_business_id uuid, p_customer_id uuid, p_branch_id uuid, p_order_id uuid, p_type text, p_amount numeric, p_method text, p_reference text, p_notes text, p_created_by uuid, p_enforce_limit boolean DEFAULT true) RETURNS numeric
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_new_balance numeric;
  v_limit       numeric;
BEGIN
  SELECT credit_balance + p_amount, credit_limit
    INTO v_new_balance, v_limit
    FROM public.customers
   WHERE id = p_customer_id AND business_id = p_business_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
  END IF;

  IF p_enforce_limit AND p_amount > 0 AND v_new_balance > v_limit THEN
    RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED';
  END IF;

  IF v_new_balance < 0 THEN
    v_new_balance := 0;  -- never let an account go into credit (overpayment clamps)
  END IF;

  UPDATE public.customers
     SET credit_balance = v_new_balance, updated_at = now()
   WHERE id = p_customer_id;

  INSERT INTO public.customer_credit_transactions
    (business_id, customer_id, branch_id, order_id, type, amount, balance_after,
     method, reference, notes, created_by)
  VALUES
    (p_business_id, p_customer_id, p_branch_id, p_order_id, p_type, p_amount, v_new_balance,
     p_method, p_reference, p_notes, p_created_by);

  RETURN v_new_balance;
END;
$$;


--
-- Name: bump_permissions_version_for_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_permissions_version_for_role() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_role_id uuid;
BEGIN
  -- Get the role_id from whichever row is available (NEW for INSERT/UPDATE, OLD for DELETE)
  v_role_id := COALESCE(NEW.role_id, OLD.role_id);
  UPDATE public.users
     SET permissions_version = permissions_version + 1
   WHERE role_id = v_role_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: bump_permissions_version_for_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_permissions_version_for_user() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := COALESCE(NEW.user_id, OLD.user_id);
  UPDATE public.users
     SET permissions_version = permissions_version + 1
   WHERE id = v_user_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: bump_permissions_version_on_role_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_permissions_version_on_role_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.role_id IS DISTINCT FROM OLD.role_id THEN
    NEW.permissions_version := COALESCE(NEW.permissions_version, 1) + 1;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: increment_discount_usage(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_discount_usage(discount_uuid uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  UPDATE discounts
    SET used_count = used_count + 1
  WHERE id = discount_uuid;
END;
$$;


--
-- Name: increment_loyalty_points(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_loyalty_points(p_customer_id uuid, p_points integer) RETURNS void
    LANGUAGE sql
    AS $$
  UPDATE public.customers
  SET loyalty_points = loyalty_points + p_points,
      visit_count    = visit_count + 1
  WHERE id = p_customer_id;
$$;


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_log (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    admin_id uuid,
    admin_email text,
    action text NOT NULL,
    resource text,
    business_id uuid,
    business_name text,
    before_data jsonb,
    after_data jsonb,
    reason text,
    ip_address text,
    event_time timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_client_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_client_notes (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    admin_id uuid NOT NULL,
    admin_name text NOT NULL,
    body text NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    password_hash text NOT NULL,
    role text DEFAULT 'agent'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_users_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'agent'::text])))
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    key_hash character varying(255) NOT NULL,
    key_prefix character varying(20) NOT NULL,
    scopes jsonb DEFAULT '["read"]'::jsonb NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT api_keys_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('revoked'::character varying)::text])))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid,
    user_id uuid,
    user_name character varying(255),
    action character varying(100) NOT NULL,
    table_name character varying(100),
    record_id uuid,
    before_data jsonb,
    after_data jsonb,
    ip_address character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: branch_printers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branch_printers (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    printer_name character varying(255),
    type character varying(30) DEFAULT 'receipt'::character varying NOT NULL,
    paper_width smallint DEFAULT 80 NOT NULL,
    category_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    is_default_receipt boolean DEFAULT false NOT NULL,
    connection_type character varying(20) DEFAULT 'browser'::character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT branch_printers_connection_type_check CHECK (((connection_type)::text = ANY (ARRAY[('qz'::character varying)::text, ('browser'::character varying)::text]))),
    CONSTRAINT branch_printers_paper_width_check CHECK ((paper_width = ANY (ARRAY[58, 80]))),
    CONSTRAINT branch_printers_type_check CHECK (((type)::text = ANY (ARRAY[('receipt'::character varying)::text, ('kitchen'::character varying)::text, ('bar'::character varying)::text, ('expeditor'::character varying)::text, ('kot'::character varying)::text])))
);


--
-- Name: branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branches (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    address text,
    phone character varying(50),
    is_main boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    city text,
    country text DEFAULT 'Kenya'::text,
    desktop_licensed boolean DEFAULT false NOT NULL,
    desktop_licensed_at timestamp with time zone,
    desktop_licensed_by text,
    deploy_mode text DEFAULT 'cloud'::text NOT NULL,
    mode_switched_at timestamp with time zone,
    mode_switched_by text,
    web_sync_enabled boolean DEFAULT false NOT NULL,
    tech_reveal_code text,
    CONSTRAINT branches_deploy_mode_check CHECK ((deploy_mode = ANY (ARRAY['local'::text, 'cloud'::text]))),
    CONSTRAINT branches_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text])))
);


--
-- Name: COLUMN branches.web_sync_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.branches.web_sync_enabled IS 'Whether this branch''s data syncs to / is visible in the cloud web portal. Replaces the old desktop_licensed gating meaning.';


--
-- Name: COLUMN branches.tech_reveal_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.branches.tech_reveal_code IS 'Reveal code (doorknock) that surfaces the tech-token prompt on the desktop POS for this branch. Low-value: it only reveals the prompt; the signed token is the gate.';


--
-- Name: business_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: businesses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.businesses (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(50) NOT NULL,
    address text,
    phone character varying(50),
    email character varying(255),
    logo_url text,
    tax_pin character varying(100),
    vat_rate numeric(5,2) DEFAULT 16.00 NOT NULL,
    currency character varying(10) DEFAULT 'KES'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_id uuid,
    owner_name character varying,
    menu_slug text,
    qr_ordering boolean DEFAULT false NOT NULL,
    etims_onboarded boolean DEFAULT false NOT NULL,
    web_access_expires_at timestamp with time zone,
    ctl_rate numeric(5,2) DEFAULT 0 NOT NULL,
    CONSTRAINT businesses_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('suspended'::character varying)::text, ('cancelled'::character varying)::text]))),
    CONSTRAINT businesses_type_check CHECK (((type)::text = ANY (ARRAY[('retail'::character varying)::text, ('restaurant'::character varying)::text, ('cafe'::character varying)::text, ('minimart'::character varying)::text, ('parking'::character varying)::text, ('petrol_station'::character varying)::text, ('other'::character varying)::text])))
);


--
-- Name: COLUMN businesses.web_access_expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.businesses.web_access_expires_at IS 'Renewal date for the recurring web portal (10k/yr). NULL = use legacy feature_flags.web_hosting boolean. Access state is derived from now() vs this date.';


--
-- Name: COLUMN businesses.ctl_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.businesses.ctl_rate IS 'Catering/Tourism Levy percentage (e.g. 2.00). 0 = not applicable. Base excludes VAT.';


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    color character varying(20),
    icon character varying(100),
    sort_order integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    super_category text,
    is_kitchen boolean DEFAULT false NOT NULL,
    CONSTRAINT categories_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text])))
);


--
-- Name: COLUMN categories.is_kitchen; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.categories.is_kitchen IS 'Items in this category appear on the kitchen prep ticket. Dispatcher ticket lists everything regardless.';


--
-- Name: clock_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clock_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    staff_id uuid NOT NULL,
    branch_id uuid,
    event_type text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clock_events_event_type_check CHECK ((event_type = ANY (ARRAY['in'::text, 'out'::text])))
);


--
-- Name: combo_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.combo_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    combo_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_credit_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_credit_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    branch_id uuid,
    order_id uuid,
    type text NOT NULL,
    amount numeric(12,2) NOT NULL,
    balance_after numeric(12,2) NOT NULL,
    method text,
    reference text,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_credit_transactions_type_check CHECK ((type = ANY (ARRAY['charge'::text, 'payment'::text, 'adjustment'::text])))
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    phone character varying(50),
    email character varying(255),
    loyalty_points integer DEFAULT 0 NOT NULL,
    total_spent numeric(12,2) DEFAULT 0 NOT NULL,
    visit_count integer DEFAULT 0 NOT NULL,
    notes text,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    credit_limit numeric(12,2) DEFAULT 0 NOT NULL,
    credit_balance numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT customers_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text])))
);


--
-- Name: COLUMN customers.credit_limit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.credit_limit IS 'Max amount the customer may owe. 0 = no credit allowed.';


--
-- Name: COLUMN customers.credit_balance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.customers.credit_balance IS 'Current amount owed. Increases on credit sale, decreases on repayment.';


--
-- Name: discounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discounts (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(20) NOT NULL,
    value numeric(12,2) NOT NULL,
    applies_to character varying(20) DEFAULT 'order'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    promo_code character varying(50),
    min_order_value numeric(12,2) DEFAULT 0,
    max_uses integer,
    used_count integer DEFAULT 0,
    expires_at timestamp with time zone,
    CONSTRAINT discounts_applies_to_check CHECK (((applies_to)::text = ANY (ARRAY[('order'::character varying)::text, ('item'::character varying)::text]))),
    CONSTRAINT discounts_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text]))),
    CONSTRAINT discounts_type_check CHECK (((type)::text = ANY (ARRAY[('percentage'::character varying)::text, ('fixed'::character varying)::text])))
);


--
-- Name: etims_branch_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.etims_branch_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    environment text DEFAULT 'sandbox'::text NOT NULL,
    mode text DEFAULT 'vscu'::text NOT NULL,
    bhf_id text,
    device_serial text,
    cmc_key text,
    sdc_id text,
    last_invoice_no integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    registered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT etims_branch_config_environment_check CHECK ((environment = ANY (ARRAY['sandbox'::text, 'production'::text]))),
    CONSTRAINT etims_branch_config_mode_check CHECK ((mode = ANY (ARRAY['vscu'::text, 'oscu'::text]))),
    CONSTRAINT etims_branch_config_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'registered'::text, 'disabled'::text])))
);


--
-- Name: etims_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.etims_invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    order_id uuid NOT NULL,
    invoice_type text DEFAULT 'sale'::text NOT NULL,
    original_invoice_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    invoice_no integer,
    kra_receipt_no text,
    kra_internal_data text,
    kra_signature text,
    qr_payload text,
    request_payload jsonb,
    response_payload jsonb,
    error text,
    retry_count integer DEFAULT 0 NOT NULL,
    sent_at timestamp with time zone,
    signed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT etims_invoices_invoice_type_check CHECK ((invoice_type = ANY (ARRAY['sale'::text, 'credit'::text]))),
    CONSTRAINT etims_invoices_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'signed'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: expense_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_categories (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    expense_category_id uuid,
    description character varying(255) NOT NULL,
    amount numeric(12,2) NOT NULL,
    paid_by uuid,
    receipt_url text,
    expense_date date DEFAULT CURRENT_DATE NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    shift_id uuid,
    CONSTRAINT expenses_sync_status_check CHECK (((sync_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('synced'::character varying)::text, ('conflict'::character varying)::text])))
);


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    key character varying(100) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    notes text,
    set_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: float_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.float_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shift_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    cashier_id uuid NOT NULL,
    type text NOT NULL,
    amount numeric(12,2) NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT float_transactions_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT float_transactions_type_check CHECK ((type = ANY (ARRAY['float_in'::text, 'float_out'::text])))
);


--
-- Name: fuel_tanks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fuel_tanks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid,
    fuel_product_id uuid NOT NULL,
    name text NOT NULL,
    capacity_litres numeric(10,2) DEFAULT 10000 NOT NULL,
    current_level numeric(10,2) DEFAULT 0 NOT NULL,
    reorder_level numeric(10,2) DEFAULT 1000 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: goods_received_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goods_received_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    purchase_order_id uuid,
    grn_number text NOT NULL,
    received_date date DEFAULT CURRENT_DATE NOT NULL,
    notes text,
    received_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: grn_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grn_items (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    grn_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    quantity_received numeric(12,2) NOT NULL,
    unit_cost numeric(12,2),
    notes text
);


--
-- Name: ingredient_cost_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingredient_cost_history (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    old_unit_cost numeric(12,2),
    new_unit_cost numeric(12,2),
    changed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ingredient_stock_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingredient_stock_levels (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    current_stock numeric(12,2) DEFAULT 0 NOT NULL,
    reorder_level numeric(12,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ingredient_stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingredient_stock_movements (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    movement_type character varying(30) NOT NULL,
    quantity_change numeric(12,2) NOT NULL,
    quantity_after numeric(12,2) NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    branch_id uuid,
    CONSTRAINT ingredient_stock_movements_movement_type_check CHECK (((movement_type)::text = ANY (ARRAY[('restock'::character varying)::text, ('adjustment'::character varying)::text, ('wastage'::character varying)::text, ('opening'::character varying)::text, ('sale'::character varying)::text])))
);


--
-- Name: ingredients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingredients (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    category character varying(100),
    unit character varying(50) DEFAULT 'pieces'::character varying NOT NULL,
    unit_cost numeric(12,2),
    current_stock numeric(12,2) DEFAULT 0 NOT NULL,
    reorder_level numeric(12,2) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_packaging boolean DEFAULT false NOT NULL,
    CONSTRAINT ingredients_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text])))
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    subscription_id uuid,
    invoice_number character varying(50) NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency character varying(10) DEFAULT 'KES'::character varying NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    payment_method character varying(50),
    payment_reference character varying(255),
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invoices_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('paid'::character varying)::text, ('failed'::character varying)::text, ('refunded'::character varying)::text])))
);


--
-- Name: kitchen_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kitchen_tickets (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    order_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    station character varying(100),
    status character varying(20) DEFAULT 'new'::character varying NOT NULL,
    printed_at timestamp with time zone,
    preparing_at timestamp with time zone,
    ready_at timestamp with time zone,
    collected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kitchen_tickets_status_check CHECK (((status)::text = ANY (ARRAY[('new'::character varying)::text, ('preparing'::character varying)::text, ('ready'::character varying)::text, ('collected'::character varying)::text])))
);

ALTER TABLE ONLY public.kitchen_tickets REPLICA IDENTITY FULL;


--
-- Name: loyalty_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loyalty_transactions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    customer_id uuid NOT NULL,
    business_id uuid NOT NULL,
    order_id uuid,
    type character varying(20) NOT NULL,
    points integer NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT loyalty_transactions_type_check CHECK (((type)::text = ANY (ARRAY[('earn'::character varying)::text, ('redeem'::character varying)::text, ('adjust'::character varying)::text])))
);


--
-- Name: mode_switch_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mode_switch_requests (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    from_mode text NOT NULL,
    to_mode text NOT NULL,
    token_hash text NOT NULL,
    generated_by text NOT NULL,
    approved_by text,
    status text DEFAULT 'pending'::text NOT NULL,
    orders_migrated integer,
    applied_at timestamp with time zone,
    applied_by_tech text,
    notes text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mode_switch_requests_from_mode_check CHECK ((from_mode = ANY (ARRAY['local'::text, 'cloud'::text]))),
    CONSTRAINT mode_switch_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'expired'::text, 'cancelled'::text]))),
    CONSTRAINT mode_switch_requests_to_mode_check CHECK ((to_mode = ANY (ARRAY['local'::text, 'cloud'::text])))
);


--
-- Name: modifier_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modifier_groups (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    product_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    min_select integer DEFAULT 0 NOT NULL,
    max_select integer,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: modifier_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modifier_options (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    modifier_group_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    price numeric(12,2) DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    user_id uuid,
    type character varying(50) NOT NULL,
    title character varying(255) NOT NULL,
    message text,
    link text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    branch_id uuid
);


--
-- Name: onboarding_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.onboarding_progress (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    business_profile_done boolean DEFAULT false NOT NULL,
    first_product_done boolean DEFAULT false NOT NULL,
    printer_configured_done boolean DEFAULT false NOT NULL,
    staff_added_done boolean DEFAULT false NOT NULL,
    first_sale_done boolean DEFAULT false NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_pin_set boolean DEFAULT false NOT NULL
);


--
-- Name: order_item_modifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item_modifiers (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    order_item_id uuid NOT NULL,
    modifier_group_name character varying(255) NOT NULL,
    modifier_option_name character varying(255) NOT NULL,
    price numeric(12,2) DEFAULT 0 NOT NULL
);


--
-- Name: order_item_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item_variants (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    order_item_id uuid NOT NULL,
    variant_group_name character varying(255) NOT NULL,
    variant_option_name character varying(255) NOT NULL,
    price_adjustment numeric(12,2) DEFAULT 0 NOT NULL
);


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    order_id uuid NOT NULL,
    product_id uuid,
    product_name character varying(255) NOT NULL,
    category_name character varying(255),
    unit_price numeric(12,2) NOT NULL,
    quantity numeric(12,2) DEFAULT 1 NOT NULL,
    subtotal numeric(12,2) NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    course text,
    fire_status text DEFAULT 'fired'::text NOT NULL,
    fired_at timestamp with time zone,
    sub_bill integer,
    CONSTRAINT order_items_fire_status_check CHECK ((fire_status = ANY (ARRAY['held'::text, 'fired'::text])))
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    customer_id uuid,
    order_number character varying(50) NOT NULL,
    order_type character varying(20) DEFAULT 'retail'::character varying NOT NULL,
    table_number character varying(50),
    customer_name character varying(255),
    customer_phone character varying(50),
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    vat_amount numeric(12,2) DEFAULT 0 NOT NULL,
    discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
    loyalty_points_used integer DEFAULT 0 NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    cashier_id uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    synced_at timestamp with time zone,
    void_reason text,
    voided_at timestamp with time zone,
    voided_by uuid,
    discount_id uuid,
    covers integer DEFAULT 1 NOT NULL,
    shift_id uuid,
    idempotency_key text,
    pump_id uuid,
    aggregator_name text,
    source text DEFAULT 'pos'::text,
    room_number text,
    guest_name text,
    seated_at timestamp with time zone,
    tip_amount numeric(12,2) DEFAULT 0 NOT NULL,
    authorized_by uuid,
    device_id text,
    ctl_amount numeric(10,2) DEFAULT 0 NOT NULL,
    delivery_person text,
    refunded_at timestamp with time zone,
    refunded_amount numeric(10,2) DEFAULT 0 NOT NULL,
    refund_reason text,
    refunded_by uuid,
    refund_authorized_by uuid,
    CONSTRAINT orders_order_type_check CHECK (((order_type)::text = ANY (ARRAY[('retail'::character varying)::text, ('dine_in'::character varying)::text, ('takeaway'::character varying)::text, ('delivery'::character varying)::text, ('aggregator'::character varying)::text, ('parking_session'::character varying)::text, ('fuel_sale'::character varying)::text, ('other'::character varying)::text]))),
    CONSTRAINT orders_source_check CHECK ((source = ANY (ARRAY['pos'::text, 'qr'::text, 'aggregator'::text, 'online'::text]))),
    CONSTRAINT orders_status_check CHECK (((status)::text = ANY (ARRAY[('open'::character varying)::text, ('held'::character varying)::text, ('completed'::character varying)::text, ('voided'::character varying)::text, ('refunded'::character varying)::text]))),
    CONSTRAINT orders_sync_status_check CHECK (((sync_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('synced'::character varying)::text, ('conflict'::character varying)::text])))
);


--
-- Name: COLUMN orders.authorized_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.authorized_by IS 'Supervisor whose override PIN authorized a privileged action (e.g. voiding a paid order). voided_by remains the cashier who initiated it.';


--
-- Name: COLUMN orders.device_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.device_id IS 'Desktop terminal (till) that created this order. NULL for web-POS orders.';


--
-- Name: COLUMN orders.ctl_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.ctl_amount IS 'Catering/Tourism Levy for this order, computed at sale time from businesses.ctl_rate.';


--
-- Name: COLUMN orders.refunded_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.refunded_at IS 'When money was returned. Null = never refunded. The order stays completed — the sale happened.';


--
-- Name: COLUMN orders.refunded_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.refunded_amount IS 'Cumulative amount returned. Equals total for a full refund. Guards against refunding twice.';


--
-- Name: COLUMN orders.refund_authorized_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.refund_authorized_by IS 'The supervisor whose override PIN approved this refund. Distinct from refunded_by, who operated the till.';


--
-- Name: parking_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parking_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid,
    bay_id uuid NOT NULL,
    order_id uuid,
    vehicle_plate text,
    vehicle_type text DEFAULT 'car'::text NOT NULL,
    rate_per_hour numeric(10,2) DEFAULT 200 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    billed_hours numeric(5,2),
    total_amount numeric(10,2),
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT parking_sessions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'voided'::text])))
);


--
-- Name: payment_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_exceptions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    payment_id uuid,
    order_id uuid,
    checkout_id text,
    expected_amount numeric(12,2),
    received_amount numeric(12,2),
    reason text NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    resolution_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    order_id uuid NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    method character varying(20) NOT NULL,
    amount numeric(12,2) NOT NULL,
    amount_tendered numeric(12,2),
    change_given numeric(12,2),
    reference character varying(255),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    mpesa_checkout_id text,
    mpesa_phone text,
    mpesa_result_desc text,
    mpesa_requested_at timestamp with time zone,
    CONSTRAINT payments_method_check CHECK (((method)::text = ANY (ARRAY[('cash'::character varying)::text, ('mpesa'::character varying)::text, ('card'::character varying)::text, ('credit'::character varying)::text]))),
    CONSTRAINT payments_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('refunded'::character varying)::text]))),
    CONSTRAINT payments_sync_status_check CHECK (((sync_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('synced'::character varying)::text, ('conflict'::character varying)::text])))
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    key character varying(100) NOT NULL,
    label character varying(255) NOT NULL,
    module character varying(100) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plans (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name character varying(50) NOT NULL,
    price numeric(12,2) DEFAULT 0 NOT NULL,
    billing_cycle character varying(20) DEFAULT 'monthly'::character varying NOT NULL,
    max_branches integer DEFAULT 1 NOT NULL,
    max_users integer DEFAULT 3 NOT NULL,
    features jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plans_billing_cycle_check CHECK (((billing_cycle)::text = ANY (ARRAY[('monthly'::character varying)::text, ('yearly'::character varying)::text, ('once'::character varying)::text])))
);


--
-- Name: printer_stations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.printer_stations (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    branch_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    printer_name character varying(255),
    paper_size character varying(10) DEFAULT '80mm'::character varying NOT NULL,
    status character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT printer_stations_paper_size_check CHECK (((paper_size)::text = ANY (ARRAY[('58mm'::character varying)::text, ('80mm'::character varying)::text]))),
    CONSTRAINT printer_stations_status_check CHECK (((status)::text = ANY (ARRAY[('connected'::character varying)::text, ('disconnected'::character varying)::text, ('unknown'::character varying)::text])))
);


--
-- Name: printer_template_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.printer_template_assignments (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    printer_station_id uuid NOT NULL,
    receipt_template_id uuid NOT NULL,
    print_trigger jsonb DEFAULT '["on_payment"]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_packaging; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_packaging (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    product_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    quantity numeric(10,3) DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_product_packaging_qty CHECK ((quantity > (0)::numeric))
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    category_id uuid,
    name character varying(255) NOT NULL,
    description text,
    base_price numeric(12,2) DEFAULT 0 NOT NULL,
    image_url text,
    has_variants boolean DEFAULT false NOT NULL,
    has_modifiers boolean DEFAULT false NOT NULL,
    track_stock boolean DEFAULT true NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    barcode text,
    plu_code text,
    sold_by text DEFAULT 'each'::text NOT NULL,
    is_fuel boolean DEFAULT false NOT NULL,
    fuel_unit text,
    cost_price numeric(10,2),
    reorder_level integer,
    pieces_per_unit integer DEFAULT 1 NOT NULL,
    unit_label text DEFAULT 'pc'::text NOT NULL,
    source text DEFAULT 'purchased'::text NOT NULL,
    is_combo boolean DEFAULT false NOT NULL,
    combo_price numeric(10,2),
    tax_type text DEFAULT 'B'::text,
    kra_item_class_code text,
    is_kitchen boolean,
    CONSTRAINT products_fuel_unit_check CHECK ((fuel_unit = ANY (ARRAY['L'::text, 'gal'::text]))),
    CONSTRAINT products_sold_by_check CHECK ((sold_by = ANY (ARRAY['each'::text, 'weight'::text, 'volume'::text, 'piece'::text]))),
    CONSTRAINT products_source_check CHECK ((source = ANY (ARRAY['purchased'::text, 'central_kitchen'::text]))),
    CONSTRAINT products_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text])))
);


--
-- Name: COLUMN products.is_kitchen; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.is_kitchen IS 'Kitchen routing override. NULL = follow the category (normal). TRUE/FALSE = force, ignoring it.';


--
-- Name: promotions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promotions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    name text NOT NULL,
    promo_type text DEFAULT 'happy_hour'::text NOT NULL,
    start_date date,
    end_date date,
    start_time time without time zone,
    end_time time without time zone,
    days_of_week integer[] DEFAULT '{0,1,2,3,4,5,6}'::integer[] NOT NULL,
    applies_to text DEFAULT 'all'::text NOT NULL,
    product_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    category_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    discount_type text,
    discount_value numeric(10,2),
    min_quantity integer DEFAULT 1 NOT NULL,
    free_quantity integer,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promotions_applies_to_check CHECK ((applies_to = ANY (ARRAY['all'::text, 'category'::text, 'product'::text]))),
    CONSTRAINT promotions_discount_type_check CHECK ((discount_type = ANY (ARRAY['percentage'::text, 'fixed'::text]))),
    CONSTRAINT promotions_promo_type_check CHECK ((promo_type = ANY (ARRAY['happy_hour'::text, 'bogo'::text, 'quantity_discount'::text]))),
    CONSTRAINT promotions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


--
-- Name: pumps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pumps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid,
    fuel_product_id uuid,
    name text NOT NULL,
    status text DEFAULT 'idle'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tank_id uuid,
    CONSTRAINT pumps_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'dispensing'::text, 'inactive'::text, 'error'::text])))
);


--
-- Name: COLUMN pumps.tank_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pumps.tank_id IS 'Direct FK to the fuel tank this pump draws from. When set, deductions apply
   to this specific tank. When NULL, falls back to matching tanks by
   fuel_product_id (original behaviour — works when only one tank per grade).';


--
-- Name: purchase_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_order_items (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    purchase_order_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    quantity_ordered numeric(12,2) NOT NULL,
    unit_cost numeric(12,2) DEFAULT 0 NOT NULL,
    quantity_received numeric(12,2) DEFAULT 0 NOT NULL
);


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    supplier_id uuid,
    po_number text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    order_date date DEFAULT CURRENT_DATE NOT NULL,
    expected_date date,
    notes text,
    total_amount numeric(12,2) DEFAULT 0 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT purchase_orders_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'ordered'::text, 'partial'::text, 'received'::text, 'cancelled'::text])))
);


--
-- Name: receipt_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipt_templates (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(30) NOT NULL,
    header_text text,
    footer_text text,
    show_logo boolean DEFAULT true NOT NULL,
    show_vat boolean DEFAULT true NOT NULL,
    show_modifiers boolean DEFAULT true NOT NULL,
    show_cashier boolean DEFAULT true NOT NULL,
    show_table boolean DEFAULT true NOT NULL,
    show_qr boolean DEFAULT false NOT NULL,
    category_filter jsonb,
    config jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT receipt_templates_type_check CHECK (((type)::text = ANY (ARRAY[('kot'::character varying)::text, ('customer_receipt'::character varying)::text, ('master_receipt'::character varying)::text, ('dispatch_slip'::character varying)::text])))
);


--
-- Name: recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipes (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    product_id uuid NOT NULL,
    ingredient_id uuid NOT NULL,
    quantity_per_serving numeric(12,4) NOT NULL,
    unit character varying(50),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    jti text NOT NULL,
    user_id uuid NOT NULL,
    business_id uuid NOT NULL,
    session_id text NOT NULL,
    device_hint text,
    ip_address text,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    table_id uuid,
    guest_name text NOT NULL,
    guest_phone text,
    party_size integer DEFAULT 2 NOT NULL,
    reserved_date date NOT NULL,
    reserved_time time without time zone NOT NULL,
    notes text,
    status text DEFAULT 'confirmed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reservations_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'seated'::text, 'completed'::text, 'cancelled'::text, 'no_show'::text])))
);


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    cashier_id uuid NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    status text DEFAULT 'open'::text NOT NULL,
    opening_float numeric(12,2) DEFAULT 0 NOT NULL,
    closing_float numeric(12,2),
    expected_cash numeric(12,2),
    cash_variance numeric(12,2),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    denomination_breakdown jsonb,
    CONSTRAINT shifts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);


--
-- Name: COLUMN shifts.denomination_breakdown; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.shifts.denomination_breakdown IS 'Cash count at close as { "1000": 3, "500": 5, ... }. Sums to closing_float.';


--
-- Name: stock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    product_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    quantity numeric(12,2) DEFAULT 0 NOT NULL,
    low_stock_threshold numeric(12,2) DEFAULT 5 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_adjustments (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    product_id uuid NOT NULL,
    adjustment_type character varying(20) NOT NULL,
    quantity numeric(12,2) NOT NULL,
    reason character varying(100),
    notes text,
    done_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    CONSTRAINT stock_adjustments_adjustment_type_check CHECK (((adjustment_type)::text = ANY (ARRAY[('add'::character varying)::text, ('remove'::character varying)::text, ('set'::character varying)::text]))),
    CONSTRAINT stock_adjustments_reason_check CHECK (((reason)::text = ANY (ARRAY[('new_stock'::character varying)::text, ('damaged'::character varying)::text, ('correction'::character varying)::text, ('sale_adjustment'::character varying)::text, ('other'::character varying)::text]))),
    CONSTRAINT stock_adjustments_sync_status_check CHECK (((sync_status)::text = ANY (ARRAY[('pending'::character varying)::text, ('synced'::character varying)::text, ('conflict'::character varying)::text])))
);


--
-- Name: stock_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_levels (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    product_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    quantity numeric(12,2) DEFAULT 0 NOT NULL,
    low_stock_threshold numeric(12,2) DEFAULT 5 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    qty_pieces integer DEFAULT 0 NOT NULL
);


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    product_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    movement_type text NOT NULL,
    quantity_change integer NOT NULL,
    quantity_after integer NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reference_type text,
    reference_id uuid,
    CONSTRAINT stock_movements_movement_type_check CHECK ((movement_type = ANY (ARRAY['sale'::text, 'restock'::text, 'write_off'::text, 'correction'::text])))
);


--
-- Name: stock_transfer_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_transfer_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transfer_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity numeric(12,3) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    from_branch_id uuid NOT NULL,
    to_branch_id uuid NOT NULL,
    transfer_number text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    notes text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_transfers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_transit'::text, 'received'::text, 'cancelled'::text])))
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('expired'::character varying)::text, ('cancelled'::character varying)::text, ('trial'::character varying)::text])))
);


--
-- Name: suppliers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    name text NOT NULL,
    contact_name text,
    email text,
    phone text,
    address text,
    notes text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT suppliers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


--
-- Name: sync_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_log (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    branch_id uuid NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    records_pushed integer DEFAULT 0 NOT NULL,
    records_pulled integer DEFAULT 0 NOT NULL,
    status character varying(20) NOT NULL,
    notes text,
    CONSTRAINT sync_log_status_check CHECK (((status)::text = ANY (ARRAY[('success'::character varying)::text, ('partial'::character varying)::text, ('failed'::character varying)::text])))
);


--
-- Name: sync_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_queue (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    branch_id uuid NOT NULL,
    table_name character varying(100) NOT NULL,
    record_id uuid NOT NULL,
    operation character varying(10) NOT NULL,
    payload jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    last_attempted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_queue_operation_check CHECK (((operation)::text = ANY (ARRAY[('insert'::character varying)::text, ('update'::character varying)::text, ('delete'::character varying)::text]))),
    CONSTRAINT sync_queue_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('synced'::character varying)::text, ('failed'::character varying)::text])))
);


--
-- Name: tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tables (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    branch_id uuid NOT NULL,
    business_id uuid NOT NULL,
    name character varying(50) NOT NULL,
    capacity integer DEFAULT 4 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    bay_status text,
    rate_per_hour numeric(10,2),
    zone text,
    shape text DEFAULT 'rect'::text,
    pos_x integer,
    pos_y integer,
    slot_type character varying DEFAULT 'dining'::character varying NOT NULL,
    CONSTRAINT tables_bay_status_check CHECK ((bay_status = ANY (ARRAY['active'::text, 'reserved'::text, 'blocked'::text]))),
    CONSTRAINT tables_shape_check CHECK ((shape = ANY (ARRAY['rect'::text, 'circle'::text]))),
    CONSTRAINT tables_slot_type_check CHECK (((slot_type)::text = ANY (ARRAY[('dining'::character varying)::text, ('parking_bay'::character varying)::text]))),
    CONSTRAINT tables_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text])))
);


--
-- Name: tech_access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tech_access_tokens (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    admin_id uuid NOT NULL,
    admin_name text NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    branch_name text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by text,
    confirmed_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tech_access_tokens_status_check CHECK ((status = ANY (ARRAY['active'::text, 'used'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: tech_approval_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tech_approval_flags (
    admin_id uuid NOT NULL,
    last_unconfirmed_at timestamp with time zone,
    requires_manual boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tech_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tech_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tech_id text,
    tech_name text,
    business_id uuid,
    branch_id uuid,
    device_id text,
    action text NOT NULL,
    detail jsonb,
    token_hash text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usage_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_snapshots (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    snapshot_date date DEFAULT CURRENT_DATE NOT NULL,
    active_branches integer DEFAULT 0 NOT NULL,
    active_users integer DEFAULT 0 NOT NULL,
    orders_this_month integer DEFAULT 0 NOT NULL,
    storage_mb numeric(10,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_branches (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_devices (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    business_id uuid NOT NULL,
    fingerprint text NOT NULL,
    device_label text,
    ip_address text,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    app_version text,
    CONSTRAINT user_devices_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: COLUMN user_devices.app_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_devices.app_version IS 'Desktop app version last reported by this device (e.g. "0.1.0"). Null = never reported.';


--
-- Name: user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permissions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    granted boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255),
    phone character varying(50),
    role_id uuid,
    pin_hash character varying(255),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    last_active_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    owner_name text,
    pin_upgraded boolean DEFAULT false NOT NULL,
    hourly_rate numeric(10,2) DEFAULT NULL::numeric,
    permissions_version integer DEFAULT 1 NOT NULL,
    override_pin_hash text,
    CONSTRAINT users_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text])))
);


--
-- Name: COLUMN users.hourly_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.hourly_rate IS 'Hourly wage rate in local currency. Used for SPLH labour cost % report.';


--
-- Name: COLUMN users.override_pin_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.override_pin_hash IS 'bcrypt hash of the per-user manager-override PIN. NULL = user cannot authorize overrides.';


--
-- Name: variant_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.variant_groups (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    product_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    required boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: variant_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.variant_options (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    variant_group_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    price_adjustment numeric(12,2) DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stock_factor numeric(10,3) DEFAULT 1 NOT NULL,
    linked_product_id uuid,
    deduct_qty numeric(10,3) DEFAULT 1 NOT NULL,
    linked_ingredient_id uuid,
    CONSTRAINT chk_variant_deduct_qty CHECK ((deduct_qty > (0)::numeric)),
    CONSTRAINT chk_variant_single_link CHECK (((linked_product_id IS NULL) OR (linked_ingredient_id IS NULL))),
    CONSTRAINT chk_variant_stock_factor CHECK ((stock_factor > (0)::numeric))
);


--
-- Name: waitlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.waitlist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    guest_name text NOT NULL,
    guest_phone text,
    party_size integer DEFAULT 2 NOT NULL,
    estimated_wait integer,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    seated_at timestamp with time zone,
    status text DEFAULT 'waiting'::text NOT NULL,
    notes text,
    CONSTRAINT waitlist_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'seated'::text, 'left'::text])))
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    webhook_id uuid NOT NULL,
    event character varying(100) NOT NULL,
    payload jsonb NOT NULL,
    response_status integer,
    response_body text,
    attempt_count integer DEFAULT 1 NOT NULL,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhooks (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    business_id uuid NOT NULL,
    url text NOT NULL,
    events jsonb DEFAULT '["order.completed"]'::jsonb NOT NULL,
    secret_hash character varying(255),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhooks_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text])))
);


--
-- Name: whatsapp_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    order_id uuid,
    to_phone text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    provider_id text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: admin_audit_log admin_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);


--
-- Name: admin_client_notes admin_client_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_client_notes
    ADD CONSTRAINT admin_client_notes_pkey PRIMARY KEY (id);


--
-- Name: admin_users admin_users_email; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_email UNIQUE (email);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: branch_printers branch_printers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_printers
    ADD CONSTRAINT branch_printers_pkey PRIMARY KEY (id);


--
-- Name: branches branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);


--
-- Name: business_settings business_settings_business_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_settings
    ADD CONSTRAINT business_settings_business_id_key_key UNIQUE (business_id, key);


--
-- Name: business_settings business_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_settings
    ADD CONSTRAINT business_settings_pkey PRIMARY KEY (id);


--
-- Name: businesses businesses_menu_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_menu_slug_key UNIQUE (menu_slug);


--
-- Name: businesses businesses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_pkey PRIMARY KEY (id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: clock_events clock_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clock_events
    ADD CONSTRAINT clock_events_pkey PRIMARY KEY (id);


--
-- Name: combo_items combo_items_combo_id_product_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.combo_items
    ADD CONSTRAINT combo_items_combo_id_product_id_key UNIQUE (combo_id, product_id);


--
-- Name: combo_items combo_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.combo_items
    ADD CONSTRAINT combo_items_pkey PRIMARY KEY (id);


--
-- Name: customer_credit_transactions customer_credit_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_transactions
    ADD CONSTRAINT customer_credit_transactions_pkey PRIMARY KEY (id);


--
-- Name: customers customers_business_id_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_business_id_phone_key UNIQUE (business_id, phone);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: discounts discounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_pkey PRIMARY KEY (id);


--
-- Name: discounts discounts_promo_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_promo_code_key UNIQUE (promo_code);


--
-- Name: etims_branch_config etims_branch_config_branch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etims_branch_config
    ADD CONSTRAINT etims_branch_config_branch_id_key UNIQUE (branch_id);


--
-- Name: etims_branch_config etims_branch_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etims_branch_config
    ADD CONSTRAINT etims_branch_config_pkey PRIMARY KEY (id);


--
-- Name: etims_invoices etims_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etims_invoices
    ADD CONSTRAINT etims_invoices_pkey PRIMARY KEY (id);


--
-- Name: expense_categories expense_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_business_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_business_id_key_key UNIQUE (business_id, key);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);


--
-- Name: float_transactions float_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.float_transactions
    ADD CONSTRAINT float_transactions_pkey PRIMARY KEY (id);


--
-- Name: fuel_tanks fuel_tanks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fuel_tanks
    ADD CONSTRAINT fuel_tanks_pkey PRIMARY KEY (id);


--
-- Name: goods_received_notes goods_received_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_received_notes
    ADD CONSTRAINT goods_received_notes_pkey PRIMARY KEY (id);


--
-- Name: grn_items grn_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_items
    ADD CONSTRAINT grn_items_pkey PRIMARY KEY (id);


--
-- Name: ingredient_cost_history ingredient_cost_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_cost_history
    ADD CONSTRAINT ingredient_cost_history_pkey PRIMARY KEY (id);


--
-- Name: ingredient_stock_levels ingredient_stock_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_levels
    ADD CONSTRAINT ingredient_stock_levels_pkey PRIMARY KEY (id);


--
-- Name: ingredient_stock_movements ingredient_stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_movements
    ADD CONSTRAINT ingredient_stock_movements_pkey PRIMARY KEY (id);


--
-- Name: ingredients ingredients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredients
    ADD CONSTRAINT ingredients_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: kitchen_tickets kitchen_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kitchen_tickets
    ADD CONSTRAINT kitchen_tickets_pkey PRIMARY KEY (id);


--
-- Name: loyalty_transactions loyalty_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_transactions
    ADD CONSTRAINT loyalty_transactions_pkey PRIMARY KEY (id);


--
-- Name: mode_switch_requests mode_switch_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mode_switch_requests
    ADD CONSTRAINT mode_switch_requests_pkey PRIMARY KEY (id);


--
-- Name: mode_switch_requests mode_switch_requests_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mode_switch_requests
    ADD CONSTRAINT mode_switch_requests_token_hash_key UNIQUE (token_hash);


--
-- Name: modifier_groups modifier_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups
    ADD CONSTRAINT modifier_groups_pkey PRIMARY KEY (id);


--
-- Name: modifier_options modifier_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_options
    ADD CONSTRAINT modifier_options_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: onboarding_progress onboarding_progress_business_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_business_id_key UNIQUE (business_id);


--
-- Name: onboarding_progress onboarding_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_pkey PRIMARY KEY (id);


--
-- Name: order_item_modifiers order_item_modifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_pkey PRIMARY KEY (id);


--
-- Name: order_item_variants order_item_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_variants
    ADD CONSTRAINT order_item_variants_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: orders orders_business_id_branch_id_order_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_business_id_branch_id_order_number_key UNIQUE (business_id, branch_id, order_number);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: parking_sessions parking_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_sessions
    ADD CONSTRAINT parking_sessions_pkey PRIMARY KEY (id);


--
-- Name: payment_exceptions payment_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_exceptions
    ADD CONSTRAINT payment_exceptions_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_key_key UNIQUE (key);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: plans plans_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_name_key UNIQUE (name);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: printer_stations printer_stations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printer_stations
    ADD CONSTRAINT printer_stations_pkey PRIMARY KEY (id);


--
-- Name: printer_template_assignments printer_template_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printer_template_assignments
    ADD CONSTRAINT printer_template_assignments_pkey PRIMARY KEY (id);


--
-- Name: printer_template_assignments printer_template_assignments_printer_station_id_receipt_tem_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printer_template_assignments
    ADD CONSTRAINT printer_template_assignments_printer_station_id_receipt_tem_key UNIQUE (printer_station_id, receipt_template_id);


--
-- Name: product_packaging product_packaging_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_packaging
    ADD CONSTRAINT product_packaging_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: promotions promotions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_pkey PRIMARY KEY (id);


--
-- Name: pumps pumps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pumps
    ADD CONSTRAINT pumps_pkey PRIMARY KEY (id);


--
-- Name: purchase_order_items purchase_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: receipt_templates receipt_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_templates
    ADD CONSTRAINT receipt_templates_pkey PRIMARY KEY (id);


--
-- Name: recipes recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_pkey PRIMARY KEY (id);


--
-- Name: recipes recipes_product_id_ingredient_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_product_id_ingredient_id_key UNIQUE (product_id, ingredient_id);


--
-- Name: refresh_tokens refresh_tokens_jti_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_jti_uq UNIQUE (jti);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: reservations reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_role_id_permission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_permission_id_key UNIQUE (role_id, permission_id);


--
-- Name: roles roles_business_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_business_id_name_key UNIQUE (business_id, name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: shifts shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_pkey PRIMARY KEY (id);


--
-- Name: stock_adjustments stock_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_pkey PRIMARY KEY (id);


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);


--
-- Name: stock_levels stock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_levels
    ADD CONSTRAINT stock_pkey PRIMARY KEY (id);


--
-- Name: stock stock_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_pkey1 PRIMARY KEY (id);


--
-- Name: stock_levels stock_product_id_branch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_levels
    ADD CONSTRAINT stock_product_id_branch_id_key UNIQUE (product_id, branch_id);


--
-- Name: stock stock_product_id_branch_id_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_product_id_branch_id_key1 UNIQUE (product_id, branch_id);


--
-- Name: stock_transfer_items stock_transfer_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_items
    ADD CONSTRAINT stock_transfer_items_pkey PRIMARY KEY (id);


--
-- Name: stock_transfers stock_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);


--
-- Name: sync_log sync_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_log
    ADD CONSTRAINT sync_log_pkey PRIMARY KEY (id);


--
-- Name: sync_queue sync_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_queue
    ADD CONSTRAINT sync_queue_pkey PRIMARY KEY (id);


--
-- Name: tables tables_branch_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tables
    ADD CONSTRAINT tables_branch_id_name_key UNIQUE (branch_id, name);


--
-- Name: tables tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tables
    ADD CONSTRAINT tables_pkey PRIMARY KEY (id);


--
-- Name: tech_access_tokens tech_access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_access_tokens
    ADD CONSTRAINT tech_access_tokens_pkey PRIMARY KEY (id);


--
-- Name: tech_access_tokens tech_access_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_access_tokens
    ADD CONSTRAINT tech_access_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: tech_approval_flags tech_approval_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_approval_flags
    ADD CONSTRAINT tech_approval_flags_pkey PRIMARY KEY (admin_id);


--
-- Name: tech_audit_log tech_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_audit_log
    ADD CONSTRAINT tech_audit_log_pkey PRIMARY KEY (id);


--
-- Name: ingredient_stock_levels uq_ingredient_branch; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_levels
    ADD CONSTRAINT uq_ingredient_branch UNIQUE (ingredient_id, branch_id);


--
-- Name: product_packaging uq_product_packaging; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_packaging
    ADD CONSTRAINT uq_product_packaging UNIQUE (product_id, ingredient_id);


--
-- Name: usage_snapshots usage_snapshots_business_id_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_snapshots
    ADD CONSTRAINT usage_snapshots_business_id_snapshot_date_key UNIQUE (business_id, snapshot_date);


--
-- Name: usage_snapshots usage_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_snapshots
    ADD CONSTRAINT usage_snapshots_pkey PRIMARY KEY (id);


--
-- Name: user_branches user_branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_pkey PRIMARY KEY (id);


--
-- Name: user_branches user_branches_user_id_branch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_user_id_branch_id_key UNIQUE (user_id, branch_id);


--
-- Name: user_devices user_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_pkey PRIMARY KEY (id);


--
-- Name: user_devices user_devices_user_fp_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_user_fp_uq UNIQUE (user_id, fingerprint);


--
-- Name: user_permissions user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);


--
-- Name: user_permissions user_permissions_user_id_permission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_permission_id_key UNIQUE (user_id, permission_id);


--
-- Name: users users_business_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_business_id_email_key UNIQUE (business_id, email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: variant_groups variant_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_groups
    ADD CONSTRAINT variant_groups_pkey PRIMARY KEY (id);


--
-- Name: variant_options variant_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_options
    ADD CONSTRAINT variant_options_pkey PRIMARY KEY (id);


--
-- Name: waitlist waitlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waitlist
    ADD CONSTRAINT waitlist_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhooks webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_deliveries whatsapp_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deliveries
    ADD CONSTRAINT whatsapp_deliveries_pkey PRIMARY KEY (id);


--
-- Name: business_settings_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX business_settings_business_idx ON public.business_settings USING btree (business_id);


--
-- Name: float_transactions_shift_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX float_transactions_shift_idx ON public.float_transactions USING btree (shift_id);


--
-- Name: fuel_tanks_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fuel_tanks_business_idx ON public.fuel_tanks USING btree (business_id);


--
-- Name: grn_business_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grn_business_id_idx ON public.goods_received_notes USING btree (business_id);


--
-- Name: grn_po_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grn_po_id_idx ON public.goods_received_notes USING btree (purchase_order_id);


--
-- Name: idx_admin_audit_log_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_admin ON public.admin_audit_log USING btree (admin_id);


--
-- Name: idx_admin_audit_log_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_business ON public.admin_audit_log USING btree (business_id);


--
-- Name: idx_admin_audit_log_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_time ON public.admin_audit_log USING btree (event_time DESC);


--
-- Name: idx_admin_client_notes_biz; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_client_notes_biz ON public.admin_client_notes USING btree (business_id);


--
-- Name: idx_api_keys_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_business ON public.api_keys USING btree (business_id);


--
-- Name: idx_audit_log_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_business ON public.audit_log USING btree (business_id);


--
-- Name: idx_audit_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_created ON public.audit_log USING btree (created_at);


--
-- Name: idx_audit_log_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_user ON public.audit_log USING btree (user_id);


--
-- Name: idx_branch_printers_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_branch_printers_branch ON public.branch_printers USING btree (branch_id);


--
-- Name: idx_branch_printers_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_branch_printers_business ON public.branch_printers USING btree (business_id);


--
-- Name: idx_branches_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_branches_business ON public.branches USING btree (business_id);


--
-- Name: idx_branches_desktop_licensed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_branches_desktop_licensed ON public.branches USING btree (business_id, desktop_licensed);


--
-- Name: idx_businesses_menu_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_businesses_menu_slug ON public.businesses USING btree (menu_slug);


--
-- Name: idx_categories_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_business ON public.categories USING btree (business_id);


--
-- Name: idx_clock_events_business_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clock_events_business_date ON public.clock_events USING btree (business_id, recorded_at DESC);


--
-- Name: idx_clock_events_staff_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clock_events_staff_date ON public.clock_events USING btree (staff_id, recorded_at DESC);


--
-- Name: idx_combo_items_combo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_combo_items_combo ON public.combo_items USING btree (combo_id);


--
-- Name: idx_credit_txn_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_txn_business ON public.customer_credit_transactions USING btree (business_id, created_at DESC);


--
-- Name: idx_credit_txn_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_txn_customer ON public.customer_credit_transactions USING btree (customer_id, created_at DESC);


--
-- Name: idx_credit_txn_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_txn_order ON public.customer_credit_transactions USING btree (order_id);


--
-- Name: idx_customers_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_business ON public.customers USING btree (business_id);


--
-- Name: idx_discounts_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discounts_business ON public.discounts USING btree (business_id);


--
-- Name: idx_discounts_promo_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_discounts_promo_code ON public.discounts USING btree (business_id, promo_code) WHERE (promo_code IS NOT NULL);


--
-- Name: idx_etims_branch_config_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_etims_branch_config_business ON public.etims_branch_config USING btree (business_id);


--
-- Name: idx_etims_invoices_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_etims_invoices_branch ON public.etims_invoices USING btree (branch_id, created_at DESC);


--
-- Name: idx_etims_invoices_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_etims_invoices_order ON public.etims_invoices USING btree (order_id);


--
-- Name: idx_etims_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_etims_invoices_status ON public.etims_invoices USING btree (business_id, status);


--
-- Name: idx_expenses_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_branch ON public.expenses USING btree (branch_id);


--
-- Name: idx_expenses_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_business ON public.expenses USING btree (business_id);


--
-- Name: idx_expenses_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_date ON public.expenses USING btree (expense_date);


--
-- Name: idx_expenses_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_shift ON public.expenses USING btree (shift_id);


--
-- Name: idx_feature_flags_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feature_flags_business ON public.feature_flags USING btree (business_id);


--
-- Name: idx_float_txn_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_float_txn_shift ON public.float_transactions USING btree (shift_id);


--
-- Name: idx_grn_items_grn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_items_grn ON public.grn_items USING btree (grn_id);


--
-- Name: idx_grn_items_ingredient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grn_items_ingredient ON public.grn_items USING btree (ingredient_id);


--
-- Name: idx_ing_stock_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ing_stock_branch ON public.ingredient_stock_levels USING btree (branch_id);


--
-- Name: idx_ing_stock_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ing_stock_business ON public.ingredient_stock_levels USING btree (business_id);


--
-- Name: idx_ing_stock_ingredient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ing_stock_ingredient ON public.ingredient_stock_levels USING btree (ingredient_id);


--
-- Name: idx_ingr_cost_history_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingr_cost_history_business ON public.ingredient_cost_history USING btree (business_id);


--
-- Name: idx_ingr_cost_history_ingredient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingr_cost_history_ingredient ON public.ingredient_cost_history USING btree (ingredient_id);


--
-- Name: idx_ingr_movements_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingr_movements_branch ON public.ingredient_stock_movements USING btree (branch_id);


--
-- Name: idx_ingr_movements_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingr_movements_business ON public.ingredient_stock_movements USING btree (business_id);


--
-- Name: idx_ingr_movements_ingredient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingr_movements_ingredient ON public.ingredient_stock_movements USING btree (ingredient_id);


--
-- Name: idx_ingredients_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingredients_business ON public.ingredients USING btree (business_id);


--
-- Name: idx_ingredients_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingredients_category ON public.ingredients USING btree (business_id, category);


--
-- Name: idx_ingredients_packaging; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingredients_packaging ON public.ingredients USING btree (business_id) WHERE (is_packaging = true);


--
-- Name: idx_invoices_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_business ON public.invoices USING btree (business_id);


--
-- Name: idx_mode_switch_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mode_switch_branch ON public.mode_switch_requests USING btree (branch_id, status);


--
-- Name: idx_notifications_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_read ON public.notifications USING btree (read_at);


--
-- Name: idx_notifications_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id);


--
-- Name: idx_order_items_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_category ON public.order_items USING btree (order_id, category_name);


--
-- Name: idx_order_items_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_order ON public.order_items USING btree (order_id);


--
-- Name: idx_orders_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_branch ON public.orders USING btree (branch_id);


--
-- Name: idx_orders_branch_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_branch_status ON public.orders USING btree (branch_id, status);


--
-- Name: idx_orders_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_business ON public.orders USING btree (business_id);


--
-- Name: idx_orders_business_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_business_created ON public.orders USING btree (business_id, created_at) WHERE ((status)::text = 'completed'::text);


--
-- Name: idx_orders_business_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_business_type ON public.orders USING btree (business_id, order_type, created_at) WHERE ((status)::text = 'completed'::text);


--
-- Name: idx_orders_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_created ON public.orders USING btree (created_at);


--
-- Name: idx_orders_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_customer ON public.orders USING btree (customer_id);


--
-- Name: idx_orders_open_dinein; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_open_dinein ON public.orders USING btree (branch_id, seated_at) WHERE (((status)::text = 'open'::text) AND ((order_type)::text = 'dine_in'::text));


--
-- Name: idx_orders_refunded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_refunded_at ON public.orders USING btree (business_id, refunded_at) WHERE (refunded_at IS NOT NULL);


--
-- Name: idx_orders_room_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_room_number ON public.orders USING btree (business_id, room_number) WHERE (room_number IS NOT NULL);


--
-- Name: idx_orders_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_shift ON public.orders USING btree (shift_id);


--
-- Name: idx_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status ON public.orders USING btree (status);


--
-- Name: idx_orders_sync; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_sync ON public.orders USING btree (sync_status);


--
-- Name: idx_orders_voided; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_voided ON public.orders USING btree (business_id, created_at) WHERE ((status)::text = 'voided'::text);


--
-- Name: idx_payment_exceptions_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_exceptions_business ON public.payment_exceptions USING btree (business_id);


--
-- Name: idx_payment_exceptions_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_exceptions_unresolved ON public.payment_exceptions USING btree (business_id) WHERE (resolved_at IS NULL);


--
-- Name: idx_payments_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_order ON public.payments USING btree (order_id);


--
-- Name: idx_payments_sync; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_sync ON public.payments USING btree (sync_status);


--
-- Name: idx_po_items_ingredient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_po_items_ingredient ON public.purchase_order_items USING btree (ingredient_id);


--
-- Name: idx_po_items_po; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_po_items_po ON public.purchase_order_items USING btree (purchase_order_id);


--
-- Name: idx_product_packaging_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_packaging_business ON public.product_packaging USING btree (business_id);


--
-- Name: idx_product_packaging_ingredient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_packaging_ingredient ON public.product_packaging USING btree (ingredient_id);


--
-- Name: idx_product_packaging_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_packaging_product ON public.product_packaging USING btree (product_id);


--
-- Name: idx_products_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_business ON public.products USING btree (business_id);


--
-- Name: idx_products_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_category ON public.products USING btree (category_id);


--
-- Name: idx_promotions_business_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_promotions_business_status ON public.promotions USING btree (business_id, status);


--
-- Name: idx_recipes_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipes_business ON public.recipes USING btree (business_id);


--
-- Name: idx_recipes_business_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipes_business_product ON public.recipes USING btree (business_id, product_id);


--
-- Name: idx_recipes_ingredient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipes_ingredient ON public.recipes USING btree (ingredient_id);


--
-- Name: idx_recipes_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recipes_product ON public.recipes USING btree (product_id);


--
-- Name: idx_reservations_branch_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_branch_date ON public.reservations USING btree (branch_id, reserved_date);


--
-- Name: idx_role_permissions_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_permissions_role ON public.role_permissions USING btree (role_id);


--
-- Name: idx_roles_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_business ON public.roles USING btree (business_id);


--
-- Name: idx_shifts_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_branch ON public.shifts USING btree (branch_id);


--
-- Name: idx_shifts_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_business ON public.shifts USING btree (business_id);


--
-- Name: idx_shifts_cashier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_cashier ON public.shifts USING btree (cashier_id);


--
-- Name: idx_shifts_opened_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_opened_at ON public.shifts USING btree (opened_at DESC);


--
-- Name: idx_shifts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_status ON public.shifts USING btree (status);


--
-- Name: idx_stock_movements_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_movements_branch ON public.stock_movements USING btree (branch_id);


--
-- Name: idx_stock_movements_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_movements_created ON public.stock_movements USING btree (created_at DESC);


--
-- Name: idx_stock_movements_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_movements_product ON public.stock_movements USING btree (product_id);


--
-- Name: idx_stock_product_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_product_branch ON public.stock_levels USING btree (product_id, branch_id);


--
-- Name: idx_subscriptions_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_business ON public.subscriptions USING btree (business_id);


--
-- Name: idx_sync_queue_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_queue_branch ON public.sync_queue USING btree (branch_id);


--
-- Name: idx_sync_queue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_queue_status ON public.sync_queue USING btree (status);


--
-- Name: idx_tables_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tables_branch ON public.tables USING btree (branch_id);


--
-- Name: idx_tables_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tables_business ON public.tables USING btree (business_id);


--
-- Name: idx_tech_audit_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_audit_branch ON public.tech_audit_log USING btree (branch_id, occurred_at DESC);


--
-- Name: idx_tech_audit_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_audit_business ON public.tech_audit_log USING btree (business_id, occurred_at DESC);


--
-- Name: idx_tech_tokens_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_tokens_admin ON public.tech_access_tokens USING btree (admin_id);


--
-- Name: idx_tech_tokens_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_tokens_branch ON public.tech_access_tokens USING btree (branch_id, status);


--
-- Name: idx_tech_tokens_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tech_tokens_expires ON public.tech_access_tokens USING btree (expires_at);


--
-- Name: idx_user_permissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_permissions_user ON public.user_permissions USING btree (user_id);


--
-- Name: idx_users_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_business ON public.users USING btree (business_id);


--
-- Name: idx_users_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_role ON public.users USING btree (role_id);


--
-- Name: idx_variant_options_linked_ingredient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_options_linked_ingredient ON public.variant_options USING btree (linked_ingredient_id) WHERE (linked_ingredient_id IS NOT NULL);


--
-- Name: idx_variant_options_linked_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variant_options_linked_product ON public.variant_options USING btree (linked_product_id) WHERE (linked_product_id IS NOT NULL);


--
-- Name: idx_waitlist_branch_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_waitlist_branch_status ON public.waitlist USING btree (branch_id, status, added_at DESC);


--
-- Name: idx_webhook_deliveries_webhook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_deliveries_webhook ON public.webhook_deliveries USING btree (webhook_id);


--
-- Name: idx_webhooks_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhooks_business ON public.webhooks USING btree (business_id);


--
-- Name: idx_whatsapp_deliveries_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_deliveries_business ON public.whatsapp_deliveries USING btree (business_id, created_at DESC);


--
-- Name: idx_whatsapp_deliveries_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_deliveries_order ON public.whatsapp_deliveries USING btree (order_id);


--
-- Name: one_main_branch_per_business; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_main_branch_per_business ON public.branches USING btree (business_id) WHERE (is_main = true);


--
-- Name: orders_idempotency_key_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX orders_idempotency_key_business_idx ON public.orders USING btree (business_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: parking_sessions_bay_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX parking_sessions_bay_idx ON public.parking_sessions USING btree (bay_id);


--
-- Name: parking_sessions_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX parking_sessions_business_idx ON public.parking_sessions USING btree (business_id);


--
-- Name: parking_sessions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX parking_sessions_status_idx ON public.parking_sessions USING btree (status);


--
-- Name: payments_mpesa_checkout_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_mpesa_checkout_business_idx ON public.payments USING btree (mpesa_checkout_id, business_id) WHERE (mpesa_checkout_id IS NOT NULL);


--
-- Name: payments_mpesa_checkout_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_mpesa_checkout_idx ON public.payments USING btree (mpesa_checkout_id) WHERE (mpesa_checkout_id IS NOT NULL);


--
-- Name: po_business_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX po_business_id_idx ON public.purchase_orders USING btree (business_id);


--
-- Name: po_supplier_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX po_supplier_id_idx ON public.purchase_orders USING btree (supplier_id);


--
-- Name: products_barcode_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX products_barcode_business_idx ON public.products USING btree (business_id, barcode) WHERE (barcode IS NOT NULL);


--
-- Name: products_plu_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX products_plu_business_idx ON public.products USING btree (business_id, plu_code) WHERE (plu_code IS NOT NULL);


--
-- Name: promotions_business_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX promotions_business_status ON public.promotions USING btree (business_id, status);


--
-- Name: pumps_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pumps_branch_idx ON public.pumps USING btree (branch_id);


--
-- Name: pumps_business_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pumps_business_idx ON public.pumps USING btree (business_id);


--
-- Name: pumps_tank_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pumps_tank_id_idx ON public.pumps USING btree (tank_id);


--
-- Name: refresh_tokens_business_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_business_id_idx ON public.refresh_tokens USING btree (business_id);


--
-- Name: refresh_tokens_jti_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_jti_idx ON public.refresh_tokens USING btree (jti);


--
-- Name: refresh_tokens_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_session_id_idx ON public.refresh_tokens USING btree (session_id);


--
-- Name: refresh_tokens_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_user_id_idx ON public.refresh_tokens USING btree (user_id);


--
-- Name: st_business_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX st_business_id_idx ON public.stock_transfers USING btree (business_id);


--
-- Name: sti_transfer_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sti_transfer_id_idx ON public.stock_transfer_items USING btree (transfer_id);


--
-- Name: suppliers_business_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX suppliers_business_id_idx ON public.suppliers USING btree (business_id);


--
-- Name: user_devices_business_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_devices_business_id_idx ON public.user_devices USING btree (business_id);


--
-- Name: user_devices_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_devices_fingerprint_idx ON public.user_devices USING btree (fingerprint);


--
-- Name: user_devices_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_devices_status_idx ON public.user_devices USING btree (business_id, status);


--
-- Name: user_devices_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_devices_user_id_idx ON public.user_devices USING btree (user_id);


--
-- Name: branch_printers set_updated_at_branch_printers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_branch_printers BEFORE UPDATE ON public.branch_printers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: business_settings set_updated_at_business_settings; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_business_settings BEFORE UPDATE ON public.business_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: fuel_tanks set_updated_at_fuel_tanks; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_fuel_tanks BEFORE UPDATE ON public.fuel_tanks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: ingredients set_updated_at_ingredients; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_ingredients BEFORE UPDATE ON public.ingredients FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: promotions set_updated_at_promotions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_promotions BEFORE UPDATE ON public.promotions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: pumps set_updated_at_pumps; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at_pumps BEFORE UPDATE ON public.pumps FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: branches trg_branches_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_branches_updated BEFORE UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users trg_bump_pv_on_role_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bump_pv_on_role_change BEFORE UPDATE OF role_id ON public.users FOR EACH ROW EXECUTE FUNCTION public.bump_permissions_version_on_role_change();


--
-- Name: role_permissions trg_bump_pv_role_permissions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bump_pv_role_permissions AFTER INSERT OR DELETE OR UPDATE ON public.role_permissions FOR EACH ROW EXECUTE FUNCTION public.bump_permissions_version_for_role();


--
-- Name: user_permissions trg_bump_pv_user_permissions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bump_pv_user_permissions AFTER INSERT OR DELETE OR UPDATE ON public.user_permissions FOR EACH ROW EXECUTE FUNCTION public.bump_permissions_version_for_user();


--
-- Name: businesses trg_businesses_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_businesses_updated BEFORE UPDATE ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: categories trg_categories_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_categories_updated BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: customers trg_customers_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: feature_flags trg_feature_flags_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_feature_flags_updated BEFORE UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: onboarding_progress trg_onboarding_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_onboarding_updated BEFORE UPDATE ON public.onboarding_progress FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: orders trg_orders_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: printer_stations trg_printer_stations_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_printer_stations_updated BEFORE UPDATE ON public.printer_stations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: products trg_products_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_products_updated BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: receipt_templates trg_receipt_templates_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_receipt_templates_updated BEFORE UPDATE ON public.receipt_templates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: roles trg_roles_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_roles_updated BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: subscriptions trg_subscriptions_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tables trg_tables_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tables_updated BEFORE UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users trg_users_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: webhooks trg_webhooks_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_webhooks_updated BEFORE UPDATE ON public.webhooks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: admin_audit_log admin_audit_log_admin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_admin_fkey FOREIGN KEY (admin_id) REFERENCES public.admin_users(id);


--
-- Name: admin_client_notes admin_client_notes_admin_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_client_notes
    ADD CONSTRAINT admin_client_notes_admin_fk FOREIGN KEY (admin_id) REFERENCES public.admin_users(id);


--
-- Name: admin_client_notes admin_client_notes_business_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_client_notes
    ADD CONSTRAINT admin_client_notes_business_fk FOREIGN KEY (business_id) REFERENCES public.businesses(id);


--
-- Name: api_keys api_keys_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: branch_printers branch_printers_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_printers
    ADD CONSTRAINT branch_printers_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: branch_printers branch_printers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_printers
    ADD CONSTRAINT branch_printers_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: branches branches_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: business_settings business_settings_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_settings
    ADD CONSTRAINT business_settings_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: businesses businesses_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: categories categories_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: clock_events clock_events_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clock_events
    ADD CONSTRAINT clock_events_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: clock_events clock_events_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clock_events
    ADD CONSTRAINT clock_events_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: clock_events clock_events_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clock_events
    ADD CONSTRAINT clock_events_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: combo_items combo_items_combo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.combo_items
    ADD CONSTRAINT combo_items_combo_id_fkey FOREIGN KEY (combo_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: combo_items combo_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.combo_items
    ADD CONSTRAINT combo_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: customer_credit_transactions customer_credit_transactions_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_transactions
    ADD CONSTRAINT customer_credit_transactions_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: customer_credit_transactions customer_credit_transactions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_transactions
    ADD CONSTRAINT customer_credit_transactions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: customer_credit_transactions customer_credit_transactions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_transactions
    ADD CONSTRAINT customer_credit_transactions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: customer_credit_transactions customer_credit_transactions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_transactions
    ADD CONSTRAINT customer_credit_transactions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_credit_transactions customer_credit_transactions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_transactions
    ADD CONSTRAINT customer_credit_transactions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: customers customers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: discounts discounts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: etims_branch_config etims_branch_config_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etims_branch_config
    ADD CONSTRAINT etims_branch_config_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: etims_branch_config etims_branch_config_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etims_branch_config
    ADD CONSTRAINT etims_branch_config_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: etims_invoices etims_invoices_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etims_invoices
    ADD CONSTRAINT etims_invoices_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: etims_invoices etims_invoices_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etims_invoices
    ADD CONSTRAINT etims_invoices_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: etims_invoices etims_invoices_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etims_invoices
    ADD CONSTRAINT etims_invoices_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: etims_invoices etims_invoices_original_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.etims_invoices
    ADD CONSTRAINT etims_invoices_original_invoice_id_fkey FOREIGN KEY (original_invoice_id) REFERENCES public.etims_invoices(id);


--
-- Name: expense_categories expense_categories_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_expense_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_expense_category_id_fkey FOREIGN KEY (expense_category_id) REFERENCES public.expense_categories(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE SET NULL;


--
-- Name: feature_flags feature_flags_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: float_transactions float_transactions_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.float_transactions
    ADD CONSTRAINT float_transactions_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: float_transactions float_transactions_cashier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.float_transactions
    ADD CONSTRAINT float_transactions_cashier_id_fkey FOREIGN KEY (cashier_id) REFERENCES public.users(id);


--
-- Name: float_transactions float_transactions_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.float_transactions
    ADD CONSTRAINT float_transactions_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;


--
-- Name: fuel_tanks fuel_tanks_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fuel_tanks
    ADD CONSTRAINT fuel_tanks_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: fuel_tanks fuel_tanks_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fuel_tanks
    ADD CONSTRAINT fuel_tanks_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: fuel_tanks fuel_tanks_fuel_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fuel_tanks
    ADD CONSTRAINT fuel_tanks_fuel_product_id_fkey FOREIGN KEY (fuel_product_id) REFERENCES public.products(id);


--
-- Name: goods_received_notes goods_received_notes_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_received_notes
    ADD CONSTRAINT goods_received_notes_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: goods_received_notes goods_received_notes_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_received_notes
    ADD CONSTRAINT goods_received_notes_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: goods_received_notes goods_received_notes_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goods_received_notes
    ADD CONSTRAINT goods_received_notes_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE SET NULL;


--
-- Name: grn_items grn_items_grn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_items
    ADD CONSTRAINT grn_items_grn_id_fkey FOREIGN KEY (grn_id) REFERENCES public.goods_received_notes(id) ON DELETE CASCADE;


--
-- Name: grn_items grn_items_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grn_items
    ADD CONSTRAINT grn_items_ingredient_id_fkey FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE RESTRICT;


--
-- Name: ingredient_cost_history ingredient_cost_history_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_cost_history
    ADD CONSTRAINT ingredient_cost_history_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: ingredient_cost_history ingredient_cost_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_cost_history
    ADD CONSTRAINT ingredient_cost_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ingredient_cost_history ingredient_cost_history_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_cost_history
    ADD CONSTRAINT ingredient_cost_history_ingredient_id_fkey FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE CASCADE;


--
-- Name: ingredient_stock_levels ingredient_stock_levels_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_levels
    ADD CONSTRAINT ingredient_stock_levels_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: ingredient_stock_levels ingredient_stock_levels_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_levels
    ADD CONSTRAINT ingredient_stock_levels_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: ingredient_stock_levels ingredient_stock_levels_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_levels
    ADD CONSTRAINT ingredient_stock_levels_ingredient_id_fkey FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE CASCADE;


--
-- Name: ingredient_stock_movements ingredient_stock_movements_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_movements
    ADD CONSTRAINT ingredient_stock_movements_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: ingredient_stock_movements ingredient_stock_movements_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_movements
    ADD CONSTRAINT ingredient_stock_movements_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: ingredient_stock_movements ingredient_stock_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_movements
    ADD CONSTRAINT ingredient_stock_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ingredient_stock_movements ingredient_stock_movements_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_stock_movements
    ADD CONSTRAINT ingredient_stock_movements_ingredient_id_fkey FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE CASCADE;


--
-- Name: ingredients ingredients_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredients
    ADD CONSTRAINT ingredients_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE SET NULL;


--
-- Name: kitchen_tickets kitchen_tickets_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kitchen_tickets
    ADD CONSTRAINT kitchen_tickets_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: kitchen_tickets kitchen_tickets_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kitchen_tickets
    ADD CONSTRAINT kitchen_tickets_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: loyalty_transactions loyalty_transactions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_transactions
    ADD CONSTRAINT loyalty_transactions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: loyalty_transactions loyalty_transactions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_transactions
    ADD CONSTRAINT loyalty_transactions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: mode_switch_requests mode_switch_requests_biz_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mode_switch_requests
    ADD CONSTRAINT mode_switch_requests_biz_fk FOREIGN KEY (business_id) REFERENCES public.businesses(id);


--
-- Name: mode_switch_requests mode_switch_requests_br_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mode_switch_requests
    ADD CONSTRAINT mode_switch_requests_br_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: modifier_groups modifier_groups_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups
    ADD CONSTRAINT modifier_groups_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: modifier_options modifier_options_modifier_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_options
    ADD CONSTRAINT modifier_options_modifier_group_id_fkey FOREIGN KEY (modifier_group_id) REFERENCES public.modifier_groups(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: onboarding_progress onboarding_progress_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: order_item_modifiers order_item_modifiers_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE CASCADE;


--
-- Name: order_item_variants order_item_variants_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_variants
    ADD CONSTRAINT order_item_variants_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: orders orders_authorized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_authorized_by_fkey FOREIGN KEY (authorized_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: orders orders_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: orders orders_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: orders orders_cashier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_cashier_id_fkey FOREIGN KEY (cashier_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: orders orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: orders orders_discount_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_discount_id_fkey FOREIGN KEY (discount_id) REFERENCES public.discounts(id) ON DELETE SET NULL;


--
-- Name: orders orders_pump_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pump_id_fkey FOREIGN KEY (pump_id) REFERENCES public.pumps(id);


--
-- Name: orders orders_refund_authorized_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_refund_authorized_by_fkey FOREIGN KEY (refund_authorized_by) REFERENCES public.users(id);


--
-- Name: orders orders_refunded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_refunded_by_fkey FOREIGN KEY (refunded_by) REFERENCES public.users(id);


--
-- Name: orders orders_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE SET NULL;


--
-- Name: orders orders_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: parking_sessions parking_sessions_bay_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_sessions
    ADD CONSTRAINT parking_sessions_bay_id_fkey FOREIGN KEY (bay_id) REFERENCES public.tables(id);


--
-- Name: parking_sessions parking_sessions_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_sessions
    ADD CONSTRAINT parking_sessions_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: parking_sessions parking_sessions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_sessions
    ADD CONSTRAINT parking_sessions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: parking_sessions parking_sessions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parking_sessions
    ADD CONSTRAINT parking_sessions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: payment_exceptions payment_exceptions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_exceptions
    ADD CONSTRAINT payment_exceptions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: payment_exceptions payment_exceptions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_exceptions
    ADD CONSTRAINT payment_exceptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: payment_exceptions payment_exceptions_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_exceptions
    ADD CONSTRAINT payment_exceptions_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE SET NULL;


--
-- Name: payment_exceptions payment_exceptions_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_exceptions
    ADD CONSTRAINT payment_exceptions_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payments payments_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: payments payments_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: payments payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: printer_stations printer_stations_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printer_stations
    ADD CONSTRAINT printer_stations_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: printer_template_assignments printer_template_assignments_printer_station_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printer_template_assignments
    ADD CONSTRAINT printer_template_assignments_printer_station_id_fkey FOREIGN KEY (printer_station_id) REFERENCES public.printer_stations(id) ON DELETE CASCADE;


--
-- Name: printer_template_assignments printer_template_assignments_receipt_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.printer_template_assignments
    ADD CONSTRAINT printer_template_assignments_receipt_template_id_fkey FOREIGN KEY (receipt_template_id) REFERENCES public.receipt_templates(id) ON DELETE CASCADE;


--
-- Name: product_packaging product_packaging_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_packaging
    ADD CONSTRAINT product_packaging_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: product_packaging product_packaging_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_packaging
    ADD CONSTRAINT product_packaging_ingredient_id_fkey FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE CASCADE;


--
-- Name: product_packaging product_packaging_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_packaging
    ADD CONSTRAINT product_packaging_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: products products_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: products products_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: promotions promotions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: pumps pumps_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pumps
    ADD CONSTRAINT pumps_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: pumps pumps_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pumps
    ADD CONSTRAINT pumps_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: pumps pumps_fuel_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pumps
    ADD CONSTRAINT pumps_fuel_product_id_fkey FOREIGN KEY (fuel_product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: pumps pumps_tank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pumps
    ADD CONSTRAINT pumps_tank_id_fkey FOREIGN KEY (tank_id) REFERENCES public.fuel_tanks(id) ON DELETE SET NULL;


--
-- Name: purchase_order_items purchase_order_items_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_ingredient_id_fkey FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE RESTRICT;


--
-- Name: purchase_order_items purchase_order_items_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;


--
-- Name: purchase_orders purchase_orders_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: purchase_orders purchase_orders_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: purchase_orders purchase_orders_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;


--
-- Name: receipt_templates receipt_templates_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_templates
    ADD CONSTRAINT receipt_templates_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: recipes recipes_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: recipes recipes_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_ingredient_id_fkey FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE CASCADE;


--
-- Name: recipes recipes_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reservations reservations_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: reservations reservations_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: reservations reservations_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.tables(id) ON DELETE SET NULL;


--
-- Name: role_permissions role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: roles roles_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: shifts shifts_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: shifts shifts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: shifts shifts_cashier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_cashier_id_fkey FOREIGN KEY (cashier_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: stock_adjustments stock_adjustments_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: stock_adjustments stock_adjustments_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: stock_adjustments stock_adjustments_done_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_done_by_fkey FOREIGN KEY (done_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stock_adjustments stock_adjustments_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_adjustments
    ADD CONSTRAINT stock_adjustments_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: stock_levels stock_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_levels
    ADD CONSTRAINT stock_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: stock stock_branch_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_branch_id_fkey1 FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: stock_movements stock_movements_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: stock_movements stock_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: stock_movements stock_movements_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: stock_levels stock_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_levels
    ADD CONSTRAINT stock_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: stock stock_product_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock
    ADD CONSTRAINT stock_product_id_fkey1 FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: stock_transfer_items stock_transfer_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_items
    ADD CONSTRAINT stock_transfer_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: stock_transfer_items stock_transfer_items_transfer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfer_items
    ADD CONSTRAINT stock_transfer_items_transfer_id_fkey FOREIGN KEY (transfer_id) REFERENCES public.stock_transfers(id) ON DELETE CASCADE;


--
-- Name: stock_transfers stock_transfers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: stock_transfers stock_transfers_from_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_from_branch_id_fkey FOREIGN KEY (from_branch_id) REFERENCES public.branches(id);


--
-- Name: stock_transfers stock_transfers_to_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_transfers
    ADD CONSTRAINT stock_transfers_to_branch_id_fkey FOREIGN KEY (to_branch_id) REFERENCES public.branches(id);


--
-- Name: subscriptions subscriptions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE RESTRICT;


--
-- Name: suppliers suppliers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: sync_log sync_log_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_log
    ADD CONSTRAINT sync_log_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: sync_queue sync_queue_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_queue
    ADD CONSTRAINT sync_queue_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: tables tables_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tables
    ADD CONSTRAINT tables_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: tables tables_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tables
    ADD CONSTRAINT tables_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: tech_access_tokens tech_access_tokens_admin_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_access_tokens
    ADD CONSTRAINT tech_access_tokens_admin_fk FOREIGN KEY (admin_id) REFERENCES public.admin_users(id);


--
-- Name: tech_access_tokens tech_access_tokens_biz_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_access_tokens
    ADD CONSTRAINT tech_access_tokens_biz_fk FOREIGN KEY (business_id) REFERENCES public.businesses(id);


--
-- Name: tech_access_tokens tech_access_tokens_branch_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_access_tokens
    ADD CONSTRAINT tech_access_tokens_branch_fk FOREIGN KEY (branch_id) REFERENCES public.branches(id);


--
-- Name: tech_approval_flags tech_approval_flags_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_approval_flags
    ADD CONSTRAINT tech_approval_flags_fk FOREIGN KEY (admin_id) REFERENCES public.admin_users(id);


--
-- Name: tech_audit_log tech_audit_log_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_audit_log
    ADD CONSTRAINT tech_audit_log_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: tech_audit_log tech_audit_log_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tech_audit_log
    ADD CONSTRAINT tech_audit_log_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE SET NULL;


--
-- Name: usage_snapshots usage_snapshots_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_snapshots
    ADD CONSTRAINT usage_snapshots_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: user_branches user_branches_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: user_branches user_branches_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_branches
    ADD CONSTRAINT user_branches_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_devices user_devices_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: user_devices user_devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_permissions user_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: user_permissions user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: users users_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE SET NULL;


--
-- Name: variant_groups variant_groups_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_groups
    ADD CONSTRAINT variant_groups_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: variant_options variant_options_linked_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_options
    ADD CONSTRAINT variant_options_linked_ingredient_id_fkey FOREIGN KEY (linked_ingredient_id) REFERENCES public.ingredients(id) ON DELETE SET NULL;


--
-- Name: variant_options variant_options_linked_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_options
    ADD CONSTRAINT variant_options_linked_product_id_fkey FOREIGN KEY (linked_product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: variant_options variant_options_variant_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_options
    ADD CONSTRAINT variant_options_variant_group_id_fkey FOREIGN KEY (variant_group_id) REFERENCES public.variant_groups(id) ON DELETE CASCADE;


--
-- Name: waitlist waitlist_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waitlist
    ADD CONSTRAINT waitlist_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: waitlist waitlist_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waitlist
    ADD CONSTRAINT waitlist_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_webhook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_id_fkey FOREIGN KEY (webhook_id) REFERENCES public.webhooks(id) ON DELETE CASCADE;


--
-- Name: webhooks webhooks_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhooks
    ADD CONSTRAINT webhooks_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: whatsapp_deliveries whatsapp_deliveries_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deliveries
    ADD CONSTRAINT whatsapp_deliveries_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;


--
-- Name: whatsapp_deliveries whatsapp_deliveries_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deliveries
    ADD CONSTRAINT whatsapp_deliveries_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: goods_received_notes Business isolation - goods_received_notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business isolation - goods_received_notes" ON public.goods_received_notes USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: purchase_orders Business isolation - purchase_orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business isolation - purchase_orders" ON public.purchase_orders USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: stock_transfer_items Business isolation - stock_transfer_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business isolation - stock_transfer_items" ON public.stock_transfer_items USING ((transfer_id IN ( SELECT stock_transfers.id
   FROM public.stock_transfers
  WHERE (stock_transfers.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: stock_transfers Business isolation - stock_transfers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business isolation - stock_transfers" ON public.stock_transfers USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: suppliers Business isolation - suppliers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business isolation - suppliers" ON public.suppliers USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: admin_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_client_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_client_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: branch_printers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.branch_printers ENABLE ROW LEVEL SECURITY;

--
-- Name: branches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

--
-- Name: business_settings business_owner_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY business_owner_settings ON public.business_settings USING ((business_id IN ( SELECT users.business_id
   FROM public.users
  WHERE (users.id = auth.uid()))));


--
-- Name: business_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: user_permissions business_user_permissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY business_user_permissions ON public.user_permissions USING ((user_id IN ( SELECT users.id
   FROM public.users
  WHERE (users.business_id IN ( SELECT users_1.business_id
           FROM public.users users_1
          WHERE (users_1.id = auth.uid()))))));


--
-- Name: businesses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

--
-- Name: categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

--
-- Name: clock_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clock_events ENABLE ROW LEVEL SECURITY;

--
-- Name: combo_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.combo_items ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_credit_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_credit_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: discounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discounts ENABLE ROW LEVEL SECURITY;

--
-- Name: etims_branch_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.etims_branch_config ENABLE ROW LEVEL SECURITY;

--
-- Name: etims_invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.etims_invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: float_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.float_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: float_transactions float_txn_business_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY float_txn_business_access ON public.float_transactions USING ((branch_id IN ( SELECT b.id
   FROM (public.branches b
     JOIN public.businesses biz ON ((biz.id = b.business_id)))
  WHERE (biz.owner_id = auth.uid()))));


--
-- Name: fuel_tanks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fuel_tanks ENABLE ROW LEVEL SECURITY;

--
-- Name: goods_received_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.goods_received_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: grn_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.grn_items ENABLE ROW LEVEL SECURITY;

--
-- Name: ingredient_cost_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingredient_cost_history ENABLE ROW LEVEL SECURITY;

--
-- Name: ingredient_stock_levels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingredient_stock_levels ENABLE ROW LEVEL SECURITY;

--
-- Name: ingredient_stock_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingredient_stock_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: ingredients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingredients ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: kitchen_tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kitchen_tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: loyalty_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: mode_switch_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mode_switch_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: modifier_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modifier_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: modifier_options; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.modifier_options ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: onboarding_progress; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;

--
-- Name: order_item_modifiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_item_modifiers ENABLE ROW LEVEL SECURITY;

--
-- Name: order_item_variants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_item_variants ENABLE ROW LEVEL SECURITY;

--
-- Name: order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

--
-- Name: businesses owner can insert business; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can insert business" ON public.businesses FOR INSERT TO authenticated WITH CHECK ((auth.uid() = owner_id));


--
-- Name: branches owner can manage branches; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage branches" ON public.branches TO authenticated USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: categories owner can manage categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage categories" ON public.categories TO authenticated USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: onboarding_progress owner can manage onboarding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage onboarding" ON public.onboarding_progress TO authenticated USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: order_items owner can manage order_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage order_items" ON public.order_items TO authenticated USING ((order_id IN ( SELECT orders.id
   FROM public.orders
  WHERE (orders.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid())))))) WITH CHECK ((order_id IN ( SELECT orders.id
   FROM public.orders
  WHERE (orders.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: orders owner can manage orders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage orders" ON public.orders TO authenticated USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: payments owner can manage payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage payments" ON public.payments TO authenticated USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: products owner can manage products; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage products" ON public.products TO authenticated USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: roles owner can manage roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage roles" ON public.roles TO authenticated USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: user_branches owner can manage user_branches; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage user_branches" ON public.user_branches TO authenticated USING ((user_id IN ( SELECT users.id
   FROM public.users
  WHERE (users.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid())))))) WITH CHECK ((user_id IN ( SELECT users.id
   FROM public.users
  WHERE (users.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: users owner can manage users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can manage users" ON public.users TO authenticated USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: businesses owner can read business; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can read business" ON public.businesses FOR SELECT TO authenticated USING ((auth.uid() = owner_id));


--
-- Name: businesses owner can update business; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "owner can update business" ON public.businesses FOR UPDATE TO authenticated USING ((auth.uid() = owner_id));


--
-- Name: audit_log owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.audit_log USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: branch_printers owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.branch_printers USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: branches owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.branches USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: business_settings owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.business_settings USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: businesses owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.businesses USING ((owner_id = auth.uid()));


--
-- Name: categories owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.categories USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: clock_events owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.clock_events USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: combo_items owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.combo_items USING ((combo_id IN ( SELECT products.id
   FROM public.products
  WHERE (products.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: customer_credit_transactions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.customer_credit_transactions USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: customers owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.customers USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: discounts owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.discounts USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: etims_branch_config owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.etims_branch_config USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: etims_invoices owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.etims_invoices USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: expense_categories owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.expense_categories USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: expenses owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.expenses USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: feature_flags owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.feature_flags USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: float_transactions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.float_transactions USING ((branch_id IN ( SELECT branches.id
   FROM public.branches
  WHERE (branches.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: fuel_tanks owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.fuel_tanks USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: goods_received_notes owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.goods_received_notes USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: grn_items owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.grn_items USING ((grn_id IN ( SELECT goods_received_notes.id
   FROM public.goods_received_notes
  WHERE (goods_received_notes.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: ingredient_stock_levels owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.ingredient_stock_levels USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: ingredient_stock_movements owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.ingredient_stock_movements USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: ingredients owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.ingredients USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: invoices owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.invoices USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: kitchen_tickets owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.kitchen_tickets USING ((branch_id IN ( SELECT branches.id
   FROM public.branches
  WHERE (branches.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: loyalty_transactions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.loyalty_transactions USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: mode_switch_requests owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.mode_switch_requests USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: modifier_groups owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.modifier_groups USING ((product_id IN ( SELECT products.id
   FROM public.products
  WHERE (products.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: modifier_options owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.modifier_options USING ((modifier_group_id IN ( SELECT modifier_groups.id
   FROM public.modifier_groups
  WHERE (modifier_groups.product_id IN ( SELECT products.id
           FROM public.products
          WHERE (products.business_id IN ( SELECT businesses.id
                   FROM public.businesses
                  WHERE (businesses.owner_id = auth.uid()))))))));


--
-- Name: notifications owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.notifications USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: onboarding_progress owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.onboarding_progress USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: order_item_modifiers owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.order_item_modifiers USING ((order_item_id IN ( SELECT order_items.id
   FROM public.order_items
  WHERE (order_items.order_id IN ( SELECT orders.id
           FROM public.orders
          WHERE (orders.business_id IN ( SELECT businesses.id
                   FROM public.businesses
                  WHERE (businesses.owner_id = auth.uid()))))))));


--
-- Name: order_item_variants owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.order_item_variants USING ((order_item_id IN ( SELECT order_items.id
   FROM public.order_items
  WHERE (order_items.order_id IN ( SELECT orders.id
           FROM public.orders
          WHERE (orders.business_id IN ( SELECT businesses.id
                   FROM public.businesses
                  WHERE (businesses.owner_id = auth.uid()))))))));


--
-- Name: order_items owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.order_items USING ((order_id IN ( SELECT orders.id
   FROM public.orders
  WHERE (orders.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: orders owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.orders USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: parking_sessions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.parking_sessions USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: payment_exceptions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.payment_exceptions USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: payments owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.payments USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: printer_stations owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.printer_stations USING ((branch_id IN ( SELECT branches.id
   FROM public.branches
  WHERE (branches.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: printer_template_assignments owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.printer_template_assignments USING ((receipt_template_id IN ( SELECT receipt_templates.id
   FROM public.receipt_templates
  WHERE (receipt_templates.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: products owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.products USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: promotions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.promotions USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: pumps owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.pumps USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: purchase_order_items owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.purchase_order_items USING ((purchase_order_id IN ( SELECT purchase_orders.id
   FROM public.purchase_orders
  WHERE (purchase_orders.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: purchase_orders owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.purchase_orders USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: receipt_templates owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.receipt_templates USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: recipes owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.recipes USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: reservations owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.reservations USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: role_permissions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.role_permissions USING ((role_id IN ( SELECT roles.id
   FROM public.roles
  WHERE (roles.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: roles owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.roles USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: shifts owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.shifts USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: stock owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.stock USING ((branch_id IN ( SELECT branches.id
   FROM public.branches
  WHERE (branches.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: stock_adjustments owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.stock_adjustments USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: stock_levels owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.stock_levels USING ((branch_id IN ( SELECT branches.id
   FROM public.branches
  WHERE (branches.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: stock_movements owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.stock_movements USING ((branch_id IN ( SELECT branches.id
   FROM public.branches
  WHERE (branches.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: stock_transfer_items owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.stock_transfer_items USING ((transfer_id IN ( SELECT stock_transfers.id
   FROM public.stock_transfers
  WHERE (stock_transfers.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: stock_transfers owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.stock_transfers USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: subscriptions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.subscriptions USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: suppliers owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.suppliers USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: sync_log owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.sync_log USING ((branch_id IN ( SELECT branches.id
   FROM public.branches
  WHERE (branches.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: sync_queue owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.sync_queue USING ((branch_id IN ( SELECT branches.id
   FROM public.branches
  WHERE (branches.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: tables owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.tables USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: user_branches owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.user_branches USING ((user_id IN ( SELECT users.id
   FROM public.users
  WHERE (users.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: user_devices owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.user_devices USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: user_permissions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.user_permissions USING ((user_id IN ( SELECT users.id
   FROM public.users
  WHERE (users.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: users owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.users USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: variant_groups owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.variant_groups USING ((product_id IN ( SELECT products.id
   FROM public.products
  WHERE (products.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: variant_options owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.variant_options USING ((variant_group_id IN ( SELECT variant_groups.id
   FROM public.variant_groups
  WHERE (variant_groups.product_id IN ( SELECT products.id
           FROM public.products
          WHERE (products.business_id IN ( SELECT businesses.id
                   FROM public.businesses
                  WHERE (businesses.owner_id = auth.uid()))))))));


--
-- Name: waitlist owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.waitlist USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: webhook_deliveries owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.webhook_deliveries USING ((webhook_id IN ( SELECT webhooks.id
   FROM public.webhooks
  WHERE (webhooks.business_id IN ( SELECT businesses.id
           FROM public.businesses
          WHERE (businesses.owner_id = auth.uid()))))));


--
-- Name: webhooks owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.webhooks USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: whatsapp_deliveries owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.whatsapp_deliveries USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: parking_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parking_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_exceptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_exceptions ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

--
-- Name: printer_stations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.printer_stations ENABLE ROW LEVEL SECURITY;

--
-- Name: printer_template_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.printer_template_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: product_packaging; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_packaging ENABLE ROW LEVEL SECURITY;

--
-- Name: products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

--
-- Name: promotions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

--
-- Name: pumps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pumps ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: purchase_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: receipt_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.receipt_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: recipes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

--
-- Name: refresh_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: reservations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: shifts shifts_business_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shifts_business_access ON public.shifts USING ((business_id IN ( SELECT businesses.id
   FROM public.businesses
  WHERE (businesses.owner_id = auth.uid()))));


--
-- Name: stock; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_levels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_levels ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_transfer_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_transfer_items ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_transfers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: suppliers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: tables; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tables ENABLE ROW LEVEL SECURITY;

--
-- Name: tech_access_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tech_access_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: tech_approval_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tech_approval_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: tech_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tech_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usage_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: user_branches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_branches ENABLE ROW LEVEL SECURITY;

--
-- Name: user_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: user_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: variant_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.variant_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: variant_options; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.variant_options ENABLE ROW LEVEL SECURITY;

--
-- Name: waitlist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: webhooks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_deliveries ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict YVzXcPkpAeF7gMgghJnoiKMw2kU67if95gpIh6S82n09OdDjKb9caGJavMmYkL8

