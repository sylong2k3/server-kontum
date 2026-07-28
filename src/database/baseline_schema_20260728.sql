-- ============================================================================
-- BASELINE SCHEMA — Kon Tum GIS server
-- Sinh ngày 2026-07-28, gộp từ 000_init_schema.sql → 045_layer_series.sql
-- (dùng pg_dump --schema-only trên DB đang chạy, đã áp dụng đủ 45 migration,
-- cộng thêm phần seed/tái tạo thủ công bên dưới).
--
-- MỤC ĐÍCH: dựng nhanh 1 DB Postgres/PostGIS rỗng thành schema đầy đủ cho app,
-- KHÔNG dùng để chạy lại trên DB đang có dữ liệu (sẽ lỗi trùng object).
--
-- KHÔNG bao gồm (cố tình loại trừ):
--   - 8 bảng lớp bản đồ nhập từ shapefile ngoài migration: gis.aoho,
--     gis.duongquoclo, gis.duongtinhlo, gis.ranhgioihuyen, gis.ranhgioitinh,
--     gis.songsuoitinh, gis.ubnd, gis.vungkontum — các bảng này chưa từng được
--     tạo qua migration (import trực tiếp bằng QGIS/ogr2ogr), nên không thuộc
--     phạm vi "schema ứng dụng". Cần import lại riêng sau khi dựng DB.
--   - Dữ liệu nghiệp vụ phát sinh: auth.users thật, cms.news/documents thật,
--     gis.field_measurements, raster.remote_sensing_images đã upload, v.v.
--
-- CÓ tái tạo thủ công (vì đã bị xoá ngoài ý muốn khỏi DB nguồn trước khi dump,
-- không phải do migrations thiếu): gis.administrative_units,
-- gis.layer_edit_history — dựng lại đúng theo migration 008/013/017, xem phần
-- APPENDIX cuối file.
--
-- KHÔNG tái tạo gis.landcover_statistics — bảng này đã bị DROP có chủ đích từ
-- migration 041 (dashboard/statistics đã chuyển sang forest.forest_snapshots),
-- xác nhận với người dùng là không dùng nữa nên loại hẳn khỏi baseline.
--
-- CÓ kèm seed bắt buộc để app chạy được: auth.roles (4 vai trò + permissions
-- hiện hành — xem cảnh báo ở APPENDIX về khác biệt so với JWT thực tế),
-- gis.administrative_units (số liệu thật tỉnh Kon Tum, migration 017),
-- gis.layer_series_groups (migration 045).
-- ============================================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.14

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
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;


--
-- Name: cms; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA cms;


--
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: field; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA field;


--
-- Name: fire; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA fire;


--
-- Name: forest; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA forest;


--
-- Name: gis; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA gis;


--
-- Name: raster; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA raster;


--
-- Name: satellite; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA satellite;


--
-- Name: postgis; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;


--
-- Name: EXTENSION postgis; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';


--
-- Name: file_role; Type: TYPE; Schema: raster; Owner: -
--

CREATE TYPE raster.file_role AS ENUM (
    'primary',
    'cog',
    'thumbnail',
    'metadata',
    'auxiliary'
);


--
-- Name: image_type; Type: TYPE; Schema: raster; Owner: -
--

CREATE TYPE raster.image_type AS ENUM (
    'geotiff_raw',
    'cog',
    'ndvi',
    'ndwi',
    'nbr',
    'lst',
    'land_cover',
    'forest_cover',
    'rgb_composite',
    'thumbnail',
    'metadata_json',
    'other'
);


--
-- Name: job_type; Type: TYPE; Schema: raster; Owner: -
--

CREATE TYPE raster.job_type AS ENUM (
    'convert_cog',
    'gen_thumbnail',
    'calc_statistics',
    'full_pipeline'
);


--
-- Name: processing_status; Type: TYPE; Schema: raster; Owner: -
--

CREATE TYPE raster.processing_status AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed',
    'cancelled'
);


--
-- Name: satellite_type; Type: TYPE; Schema: raster; Owner: -
--

CREATE TYPE raster.satellite_type AS ENUM (
    'landsat_8',
    'landsat_9',
    'sentinel_1',
    'sentinel_2',
    'sentinel_3',
    'modis',
    'viirs',
    'planet',
    'spot',
    'vnredsat',
    'other'
);


--
-- Name: set_default_user_role(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.set_default_user_role() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.role_id IS NULL THEN
        SELECT id INTO NEW.role_id FROM auth.roles WHERE code = 'citizen';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: update_news_search_tsv(); Type: FUNCTION; Schema: cms; Owner: -
--

CREATE FUNCTION cms.update_news_search_tsv() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.search_tsv := to_tsvector('simple', coalesce(NEW.title, '') || ' ' || coalesce(NEW.summary, '') || ' ' || coalesce(NEW.content, ''));
    RETURN NEW;
END;
$$;


--
-- Name: update_news_translation_search_tsv(); Type: FUNCTION; Schema: cms; Owner: -
--

CREATE FUNCTION cms.update_news_translation_search_tsv() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.search_tsv := to_tsvector(
        'simple',
        coalesce(NEW.title, '') || ' ' ||
        coalesce(NEW.summary, '') || ' ' ||
        coalesce(NEW.content, '')
    );
    RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: set_feedback_geom(); Type: FUNCTION; Schema: field; Owner: -
--

CREATE FUNCTION field.set_feedback_geom() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.geom = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    RETURN NEW;
END;
$$;


--
-- Name: compute_gt_point_geom(); Type: FUNCTION; Schema: fire; Owner: -
--

CREATE FUNCTION fire.compute_gt_point_geom() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.geom IS NULL THEN
        NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: compute_gt_zone_area(); Type: FUNCTION; Schema: fire; Owner: -
--

CREATE FUNCTION fire.compute_gt_zone_area() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.geom IS NOT NULL THEN
        -- ST_Area trên geography (m²) chính xác hơn planar. /10000 → hectare.
        NEW.area_ha := ST_Area(NEW.geom::geography) / 10000.0;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;


--
-- Name: compute_gt_point_geom(); Type: FUNCTION; Schema: forest; Owner: -
--

CREATE FUNCTION forest.compute_gt_point_geom() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.geom IS NULL THEN
        NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: compute_gt_zone_area(); Type: FUNCTION; Schema: forest; Owner: -
--

CREATE FUNCTION forest.compute_gt_zone_area() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.geom IS NOT NULL THEN
        NEW.area_ha := ST_Area(NEW.geom::geography) / 10000.0;
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;


--
-- Name: set_raster_ingest_completed_at(); Type: FUNCTION; Schema: gis; Owner: -
--

CREATE FUNCTION gis.set_raster_ingest_completed_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status IN ('completed','failed','cancelled')
       AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.completed_at IS NULL THEN
        NEW.completed_at := NOW();
    END IF;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activity_logs; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.activity_logs (
    id bigint NOT NULL,
    user_id bigint,
    action character varying(50) NOT NULL,
    status character varying(10) DEFAULT 'success'::character varying NOT NULL,
    ip_address character varying(45),
    user_agent text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activity_logs_action_check CHECK (((action)::text = ANY ((ARRAY['register'::character varying, 'login'::character varying, 'login_failed'::character varying, 'logout'::character varying, 'refresh_token'::character varying, 'change_password'::character varying, 'social_login'::character varying, 'social_link'::character varying, 'social_unlink'::character varying, 'account_locked'::character varying, 'account_unlocked'::character varying, 'force_logout'::character varying, 'password_reset_request'::character varying, 'password_reset'::character varying, 'password_reset_failed'::character varying, 'email_verification_sent'::character varying, 'email_verified'::character varying, 'token_reuse_detected'::character varying, 'user_create'::character varying, 'user_role_change'::character varying, 'user_active_change'::character varying, 'user_delete'::character varying, 'admin_password_reset'::character varying])::text[]))),
    CONSTRAINT activity_logs_status_check CHECK (((status)::text = ANY (ARRAY[('success'::character varying)::text, ('failure'::character varying)::text])))
);


--
-- Name: activity_logs_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.activity_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: activity_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.activity_logs_id_seq OWNED BY auth.activity_logs.id;


--
-- Name: email_verification_tokens; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.email_verification_tokens (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    request_ip character varying(45),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.email_verification_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.email_verification_tokens_id_seq OWNED BY auth.email_verification_tokens.id;


--
-- Name: oauth_exchange_codes; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.oauth_exchange_codes (
    code_hash character varying(64) NOT NULL,
    user_id bigint NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    is_new_user boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.password_reset_tokens (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    request_ip character varying(45),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.password_reset_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.password_reset_tokens_id_seq OWNED BY auth.password_reset_tokens.id;


--
-- Name: refresh_tokens; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.refresh_tokens (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    token_hash character varying(64) NOT NULL,
    device_info jsonb DEFAULT '{}'::jsonb,
    expires_at timestamp with time zone NOT NULL,
    is_revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.refresh_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.refresh_tokens_id_seq OWNED BY auth.refresh_tokens.id;


--
-- Name: roles; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.roles (
    id integer NOT NULL,
    code character varying(30) NOT NULL,
    name_vi character varying(100) NOT NULL,
    name_en character varying(100),
    description_vi text,
    description_en text,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.roles_id_seq OWNED BY auth.roles.id;


--
-- Name: social_accounts; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.social_accounts (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    provider character varying(30) NOT NULL,
    provider_id character varying(255) NOT NULL,
    provider_email character varying(255),
    provider_name character varying(255),
    provider_avatar text,
    access_token text,
    refresh_token text,
    token_expires_at timestamp with time zone,
    raw_profile jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT social_accounts_provider_check CHECK (((provider)::text = ANY (ARRAY[('google'::character varying)::text, ('facebook'::character varying)::text, ('github'::character varying)::text, ('apple'::character varying)::text, ('microsoft'::character varying)::text])))
);


--
-- Name: social_accounts_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.social_accounts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: social_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.social_accounts_id_seq OWNED BY auth.social_accounts.id;


--
-- Name: token_blacklist; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.token_blacklist (
    jti character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.users (
    id bigint NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255),
    full_name character varying(255) NOT NULL,
    phone character varying(20),
    avatar_url text,
    role_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    email_verified_at timestamp with time zone,
    login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    password_changed_at timestamp with time zone,
    must_change_password boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone,
    last_login_ip character varying(45),
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.users_id_seq OWNED BY auth.users.id;


--
-- Name: comments; Type: TABLE; Schema: cms; Owner: -
--

CREATE TABLE cms.comments (
    id bigint NOT NULL,
    news_id bigint NOT NULL,
    user_id bigint,
    content text NOT NULL,
    is_approved boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comments_id_seq; Type: SEQUENCE; Schema: cms; Owner: -
--

CREATE SEQUENCE cms.comments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comments_id_seq; Type: SEQUENCE OWNED BY; Schema: cms; Owner: -
--

ALTER SEQUENCE cms.comments_id_seq OWNED BY cms.comments.id;


--
-- Name: document_translations; Type: TABLE; Schema: cms; Owner: -
--

CREATE TABLE cms.document_translations (
    id bigint NOT NULL,
    document_id bigint NOT NULL,
    lang character varying(5) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_translations_lang_check CHECK (((lang)::text = ANY (ARRAY[('vi'::character varying)::text, ('en'::character varying)::text])))
);


--
-- Name: document_translations_id_seq; Type: SEQUENCE; Schema: cms; Owner: -
--

CREATE SEQUENCE cms.document_translations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: document_translations_id_seq; Type: SEQUENCE OWNED BY; Schema: cms; Owner: -
--

ALTER SEQUENCE cms.document_translations_id_seq OWNED BY cms.document_translations.id;


--
-- Name: documents; Type: TABLE; Schema: cms; Owner: -
--

CREATE TABLE cms.documents (
    id bigint NOT NULL,
    title character varying(255),
    description text,
    doc_type character varying(30) NOT NULL,
    file_url text NOT NULL,
    file_name character varying(255),
    mime_type character varying(150),
    file_size bigint,
    is_public boolean DEFAULT false NOT NULL,
    uploaded_by bigint,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT documents_doc_type_check CHECK (((doc_type)::text = ANY (ARRAY[('bao_cao'::character varying)::text, ('van_ban'::character varying)::text, ('pdf_map'::character varying)::text])))
);


--
-- Name: documents_id_seq; Type: SEQUENCE; Schema: cms; Owner: -
--

CREATE SEQUENCE cms.documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: documents_id_seq; Type: SEQUENCE OWNED BY; Schema: cms; Owner: -
--

ALTER SEQUENCE cms.documents_id_seq OWNED BY cms.documents.id;


--
-- Name: news; Type: TABLE; Schema: cms; Owner: -
--

CREATE TABLE cms.news (
    id bigint NOT NULL,
    title character varying(255),
    slug character varying(255),
    summary text,
    content text,
    cover_url text,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    author_id bigint,
    published_at timestamp with time zone,
    search_tsv tsvector,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category character varying(40) DEFAULT 'general'::character varying NOT NULL,
    CONSTRAINT chk_news_category CHECK (((category)::text = ANY ((ARRAY['general'::character varying, 'so_nnmt'::character varying])::text[]))),
    CONSTRAINT news_status_check CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('published'::character varying)::text])))
);


--
-- Name: news_id_seq; Type: SEQUENCE; Schema: cms; Owner: -
--

CREATE SEQUENCE cms.news_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: news_id_seq; Type: SEQUENCE OWNED BY; Schema: cms; Owner: -
--

ALTER SEQUENCE cms.news_id_seq OWNED BY cms.news.id;


--
-- Name: news_translations; Type: TABLE; Schema: cms; Owner: -
--

CREATE TABLE cms.news_translations (
    id bigint NOT NULL,
    news_id bigint NOT NULL,
    lang character varying(5) NOT NULL,
    title character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    summary text,
    content text NOT NULL,
    search_tsv tsvector,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT news_translations_lang_check CHECK (((lang)::text = ANY (ARRAY[('vi'::character varying)::text, ('en'::character varying)::text])))
);


--
-- Name: news_translations_id_seq; Type: SEQUENCE; Schema: cms; Owner: -
--

CREATE SEQUENCE cms.news_translations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: news_translations_id_seq; Type: SEQUENCE OWNED BY; Schema: cms; Owner: -
--

ALTER SEQUENCE cms.news_translations_id_seq OWNED BY cms.news_translations.id;


--
-- Name: pdf_map_translations; Type: TABLE; Schema: cms; Owner: -
--

CREATE TABLE cms.pdf_map_translations (
    id bigint NOT NULL,
    pdf_map_id bigint NOT NULL,
    lang character varying(5) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pdf_map_translations_lang_check CHECK (((lang)::text = ANY (ARRAY[('vi'::character varying)::text, ('en'::character varying)::text])))
);


--
-- Name: pdf_map_translations_id_seq; Type: SEQUENCE; Schema: cms; Owner: -
--

CREATE SEQUENCE cms.pdf_map_translations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pdf_map_translations_id_seq; Type: SEQUENCE OWNED BY; Schema: cms; Owner: -
--

ALTER SEQUENCE cms.pdf_map_translations_id_seq OWNED BY cms.pdf_map_translations.id;


--
-- Name: pdf_maps; Type: TABLE; Schema: cms; Owner: -
--

CREATE TABLE cms.pdf_maps (
    id bigint NOT NULL,
    theme_code character varying(30) NOT NULL,
    year smallint NOT NULL,
    scale character varying(30),
    region character varying(150),
    file_url text NOT NULL,
    file_name character varying(255),
    mime_type character varying(150),
    file_size bigint,
    thumbnail_url text,
    is_public boolean DEFAULT false NOT NULL,
    uploaded_by bigint,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pdf_maps_theme_code_check CHECK (((theme_code)::text = ANY (ARRAY[('lop_phu_nhiet'::character varying)::text, ('chay_rung'::character varying)::text, ('lop_phu_rung'::character varying)::text, ('khac'::character varying)::text]))),
    CONSTRAINT pdf_maps_year_check CHECK (((year >= 1900) AND (year <= 2100)))
);


--
-- Name: pdf_maps_id_seq; Type: SEQUENCE; Schema: cms; Owner: -
--

CREATE SEQUENCE cms.pdf_maps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pdf_maps_id_seq; Type: SEQUENCE OWNED BY; Schema: cms; Owner: -
--

ALTER SEQUENCE cms.pdf_maps_id_seq OWNED BY cms.pdf_maps.id;


--
-- Name: device_tokens; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.device_tokens (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    token text NOT NULL,
    platform character varying(10) NOT NULL,
    device_info jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_tokens_platform_check CHECK (((platform)::text = ANY (ARRAY[('web'::character varying)::text, ('android'::character varying)::text, ('ios'::character varying)::text])))
);


--
-- Name: device_tokens_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.device_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.device_tokens_id_seq OWNED BY core.device_tokens.id;


--
-- Name: notification_reads; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.notification_reads (
    notification_id bigint NOT NULL,
    user_id bigint NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp with time zone
);


--
-- Name: notifications; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.notifications (
    id bigint NOT NULL,
    user_id bigint,
    audience character varying(10) DEFAULT 'user'::character varying NOT NULL,
    audience_role character varying(30),
    channel character varying(50) DEFAULT 'system'::character varying NOT NULL,
    type character varying(50) NOT NULL,
    title character varying(255) NOT NULL,
    body text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT notifications_audience_check CHECK (((audience)::text = ANY (ARRAY[('user'::character varying)::text, ('all'::character varying)::text, ('role'::character varying)::text])))
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.notifications_id_seq OWNED BY core.notifications.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.schema_migrations (
    filename character varying(255) NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feedback; Type: TABLE; Schema: field; Owner: -
--

CREATE TABLE field.feedback (
    id bigint NOT NULL,
    user_id bigint,
    anonymous_id character varying(100),
    client_uuid character varying(80),
    category character varying(30) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    status character varying(30) DEFAULT 'new'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'normal'::character varying NOT NULL,
    media_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    lng double precision NOT NULL,
    lat double precision NOT NULL,
    geom public.geometry(Point,4326),
    created_by bigint,
    updated_by bigint,
    resolved_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_feedback_lat CHECK (((lat >= (13.0)::double precision) AND (lat <= (16.5)::double precision))),
    CONSTRAINT chk_feedback_lng CHECK (((lng >= (106.0)::double precision) AND (lng <= (109.0)::double precision))),
    CONSTRAINT chk_feedback_owner CHECK (((user_id IS NOT NULL) OR (anonymous_id IS NOT NULL))),
    CONSTRAINT feedback_category_check CHECK (((category)::text = ANY (ARRAY[('chay_rung'::character varying)::text, ('vi_pham'::character varying)::text, ('hien_trang'::character varying)::text]))),
    CONSTRAINT feedback_priority_check CHECK (((priority)::text = ANY (ARRAY[('low'::character varying)::text, ('normal'::character varying)::text, ('high'::character varying)::text, ('urgent'::character varying)::text]))),
    CONSTRAINT feedback_status_check CHECK (((status)::text = ANY (ARRAY[('new'::character varying)::text, ('in_progress'::character varying)::text, ('resolved'::character varying)::text, ('rejected'::character varying)::text])))
);


--
-- Name: feedback_id_seq; Type: SEQUENCE; Schema: field; Owner: -
--

CREATE SEQUENCE field.feedback_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: field; Owner: -
--

ALTER SEQUENCE field.feedback_id_seq OWNED BY field.feedback.id;


--
-- Name: feedback_status_log; Type: TABLE; Schema: field; Owner: -
--

CREATE TABLE field.feedback_status_log (
    id bigint NOT NULL,
    feedback_id bigint NOT NULL,
    from_status character varying(30),
    to_status character varying(30) NOT NULL,
    note text,
    changed_by bigint,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feedback_status_log_id_seq; Type: SEQUENCE; Schema: field; Owner: -
--

CREATE SEQUENCE field.feedback_status_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feedback_status_log_id_seq; Type: SEQUENCE OWNED BY; Schema: field; Owner: -
--

ALTER SEQUENCE field.feedback_status_log_id_seq OWNED BY field.feedback_status_log.id;


--
-- Name: fire_gt_points; Type: TABLE; Schema: fire; Owner: -
--

CREATE TABLE fire.fire_gt_points (
    id bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    severity smallint DEFAULT 3 NOT NULL,
    lng numeric(9,6) NOT NULL,
    lat numeric(8,6) NOT NULL,
    geom public.geometry(Point,4326) NOT NULL,
    source character varying(64) DEFAULT 'field_report'::character varying,
    photo_url text,
    reporter_name character varying(200),
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fire_gt_points_lat_check CHECK (((lat >= (13)::numeric) AND (lat <= 16.5))),
    CONSTRAINT fire_gt_points_lng_check CHECK (((lng >= (106)::numeric) AND (lng <= (109)::numeric))),
    CONSTRAINT fire_gt_points_severity_check CHECK (((severity >= 1) AND (severity <= 5)))
);


--
-- Name: fire_gt_points_id_seq; Type: SEQUENCE; Schema: fire; Owner: -
--

CREATE SEQUENCE fire.fire_gt_points_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fire_gt_points_id_seq; Type: SEQUENCE OWNED BY; Schema: fire; Owner: -
--

ALTER SEQUENCE fire.fire_gt_points_id_seq OWNED BY fire.fire_gt_points.id;


--
-- Name: fire_gt_zones; Type: TABLE; Schema: fire; Owner: -
--

CREATE TABLE fire.fire_gt_zones (
    id bigint NOT NULL,
    name character varying(200),
    occurred_at timestamp with time zone NOT NULL,
    severity smallint DEFAULT 3 NOT NULL,
    source character varying(64) DEFAULT 'field_survey'::character varying,
    geom public.geometry(MultiPolygon,4326) NOT NULL,
    area_ha numeric(12,2),
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fire_gt_zones_severity_check CHECK (((severity >= 1) AND (severity <= 5)))
);


--
-- Name: fire_gt_zones_id_seq; Type: SEQUENCE; Schema: fire; Owner: -
--

CREATE SEQUENCE fire.fire_gt_zones_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fire_gt_zones_id_seq; Type: SEQUENCE OWNED BY; Schema: fire; Owner: -
--

ALTER SEQUENCE fire.fire_gt_zones_id_seq OWNED BY fire.fire_gt_zones.id;


--
-- Name: fire_risk_district_exports; Type: TABLE; Schema: fire; Owner: -
--

CREATE TABLE fire.fire_risk_district_exports (
    id bigint NOT NULL,
    snapshot_id bigint NOT NULL,
    district_code character varying(32),
    district_name character varying(128),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    scale_m integer DEFAULT 150 NOT NULL,
    area_stats jsonb,
    total_area_ha numeric(12,2),
    gee_map_id character varying(500),
    gee_tile_url text,
    gee_download_url text,
    gee_download_filename character varying(200),
    gee_generated_at timestamp with time zone,
    minio_key text,
    geoserver_layer text,
    geoserver_store character varying(120),
    raster_ingest_job_id bigint,
    error_message text,
    duration_ms integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fire_risk_district_exports_scale_m_check CHECK (((scale_m >= 10) AND (scale_m <= 1000))),
    CONSTRAINT fire_risk_district_exports_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'computing'::character varying, 'completed'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: TABLE fire_risk_district_exports; Type: COMMENT; Schema: fire; Owner: -
--

COMMENT ON TABLE fire.fire_risk_district_exports IS 'Per-district export state cho fire-risk snapshot: chia GEE download URL theo huyện (scale 100m), aggregate lên tỉnh = Σ area';


--
-- Name: fire_risk_district_exports_id_seq; Type: SEQUENCE; Schema: fire; Owner: -
--

CREATE SEQUENCE fire.fire_risk_district_exports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fire_risk_district_exports_id_seq; Type: SEQUENCE OWNED BY; Schema: fire; Owner: -
--

ALTER SEQUENCE fire.fire_risk_district_exports_id_seq OWNED BY fire.fire_risk_district_exports.id;


--
-- Name: fire_risk_features; Type: TABLE; Schema: fire; Owner: -
--

CREATE TABLE fire.fire_risk_features (
    id bigint NOT NULL,
    snapshot_id bigint NOT NULL,
    risk_level smallint NOT NULL,
    district_code character varying(10),
    district_name character varying(120),
    area_ha numeric(14,2),
    p_nesterov_mean numeric(10,2),
    ndvi_mean numeric(6,4),
    properties jsonb DEFAULT '{}'::jsonb NOT NULL,
    geom public.geometry(MultiPolygon,4326),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fire_risk_features_risk_level_check CHECK (((risk_level >= 1) AND (risk_level <= 5)))
);


--
-- Name: fire_risk_features_id_seq; Type: SEQUENCE; Schema: fire; Owner: -
--

CREATE SEQUENCE fire.fire_risk_features_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fire_risk_features_id_seq; Type: SEQUENCE OWNED BY; Schema: fire; Owner: -
--

ALTER SEQUENCE fire.fire_risk_features_id_seq OWNED BY fire.fire_risk_features.id;


--
-- Name: fire_risk_snapshots; Type: TABLE; Schema: fire; Owner: -
--

CREATE TABLE fire.fire_risk_snapshots (
    id bigint NOT NULL,
    analysis_date date NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    model_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    province_summary jsonb,
    district_stats jsonb,
    p_nesterov_stats jsonb,
    s2_coverage_ratio numeric(5,4),
    gee_task_id character varying(200),
    minio_key character varying(500),
    geoserver_layer character varying(255),
    geoserver_store character varying(120),
    error_message text,
    computed_at timestamp with time zone,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    gee_map_id character varying(500),
    gee_tile_url text,
    gee_tile_generated_at timestamp with time zone,
    gee_download_url text,
    gt_zone_count integer DEFAULT 0 NOT NULL,
    gt_point_count integer DEFAULT 0 NOT NULL,
    gt_window_days smallint,
    oob_accuracy numeric(5,2),
    retry_count integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone,
    last_retry_error text,
    attempt smallint DEFAULT 1 NOT NULL,
    export_scale_m integer DEFAULT 150 NOT NULL,
    district_export_summary jsonb,
    CONSTRAINT fire_risk_snapshots_attempt_check CHECK (((attempt >= 1) AND (attempt <= 100))),
    CONSTRAINT fire_risk_snapshots_export_scale_m_check CHECK (((export_scale_m >= 10) AND (export_scale_m <= 1000))),
    CONSTRAINT fire_risk_snapshots_retry_count_check CHECK (((retry_count >= 0) AND (retry_count <= 3))),
    CONSTRAINT fire_risk_snapshots_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'computing'::character varying, 'completed'::character varying, 'failed'::character varying, 'exporting'::character varying, 'published'::character varying])::text[])))
);


--
-- Name: COLUMN fire_risk_snapshots.gee_download_url; Type: COMMENT; Schema: fire; Owner: -
--

COMMENT ON COLUMN fire.fire_risk_snapshots.gee_download_url IS 'GEE getDownloadURL() cho RiskLevel image, clip theo province polygon. ZIP GeoTIFF, valid ~24h.';


--
-- Name: COLUMN fire_risk_snapshots.gt_zone_count; Type: COMMENT; Schema: fire; Owner: -
--

COMMENT ON COLUMN fire.fire_risk_snapshots.gt_zone_count IS 'Số zone GT active dùng cho snapshot (0 = không có GT)';


--
-- Name: COLUMN fire_risk_snapshots.gt_point_count; Type: COMMENT; Schema: fire; Owner: -
--

COMMENT ON COLUMN fire.fire_risk_snapshots.gt_point_count IS 'Số point GT active dùng cho snapshot';


--
-- Name: COLUMN fire_risk_snapshots.gt_window_days; Type: COMMENT; Schema: fire; Owner: -
--

COMMENT ON COLUMN fire.fire_risk_snapshots.gt_window_days IS 'Cửa sổ GT (ngày) đã áp dụng — mặc định env FIRE_RISK_GT_WINDOW_DAYS';


--
-- Name: COLUMN fire_risk_snapshots.oob_accuracy; Type: COMMENT; Schema: fire; Owner: -
--

COMMENT ON COLUMN fire.fire_risk_snapshots.oob_accuracy IS 'Out-of-bag accuracy % (0-100) của RF classifier. NULL khi RF disabled hoặc COMPUTE_OOB=false.';


--
-- Name: COLUMN fire_risk_snapshots.attempt; Type: COMMENT; Schema: fire; Owner: -
--

COMMENT ON COLUMN fire.fire_risk_snapshots.attempt IS 'Lần chạy trong cùng analysis_date. UPSERT bị bỏ — mỗi refresh tạo dòng mới với attempt++';


--
-- Name: COLUMN fire_risk_snapshots.export_scale_m; Type: COMMENT; Schema: fire; Owner: -
--

COMMENT ON COLUMN fire.fire_risk_snapshots.export_scale_m IS 'Scale (m) dùng cho reduceRegions + getDownloadURL. Default 100.';


--
-- Name: COLUMN fire_risk_snapshots.district_export_summary; Type: COMMENT; Schema: fire; Owner: -
--

COMMENT ON COLUMN fire.fire_risk_snapshots.district_export_summary IS 'Aggregate của fire_risk_district_exports: { total, completed, failed, totalHa, byLevel:{1..5:ha} }';


--
-- Name: fire_risk_snapshots_id_seq; Type: SEQUENCE; Schema: fire; Owner: -
--

CREATE SEQUENCE fire.fire_risk_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fire_risk_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: fire; Owner: -
--

ALTER SEQUENCE fire.fire_risk_snapshots_id_seq OWNED BY fire.fire_risk_snapshots.id;


--
-- Name: v_gt_recent_points; Type: VIEW; Schema: fire; Owner: -
--

CREATE VIEW fire.v_gt_recent_points AS
 SELECT id,
    occurred_at,
    severity,
    source,
    lng,
    lat,
    geom
   FROM fire.fire_gt_points
  WHERE (is_active = true);


--
-- Name: v_gt_recent_zones; Type: VIEW; Schema: fire; Owner: -
--

CREATE VIEW fire.v_gt_recent_zones AS
 SELECT id,
    name,
    occurred_at,
    severity,
    source,
    geom,
    area_ha
   FROM fire.fire_gt_zones
  WHERE (is_active = true);


--
-- Name: forest_district_areas; Type: TABLE; Schema: forest; Owner: -
--

CREATE TABLE forest.forest_district_areas (
    id bigint NOT NULL,
    snapshot_id bigint NOT NULL,
    district_code character varying(32),
    district_name character varying(128),
    class_id smallint NOT NULL,
    class_name character varying(64) NOT NULL,
    area_ha numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forest_district_areas_id_seq; Type: SEQUENCE; Schema: forest; Owner: -
--

CREATE SEQUENCE forest.forest_district_areas_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forest_district_areas_id_seq; Type: SEQUENCE OWNED BY; Schema: forest; Owner: -
--

ALTER SEQUENCE forest.forest_district_areas_id_seq OWNED BY forest.forest_district_areas.id;


--
-- Name: forest_district_exports; Type: TABLE; Schema: forest; Owner: -
--

CREATE TABLE forest.forest_district_exports (
    id bigint NOT NULL,
    snapshot_id bigint NOT NULL,
    district_code character varying(32),
    district_name character varying(128),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    scale_m integer DEFAULT 100 NOT NULL,
    area_by_class jsonb,
    total_area_ha numeric(12,2),
    forest_area_ha numeric(12,2),
    gee_map_id character varying(500),
    gee_tile_url text,
    gee_download_url text,
    gee_download_filename character varying(200),
    gee_generated_at timestamp with time zone,
    minio_key text,
    geoserver_layer text,
    geoserver_store character varying(120),
    raster_ingest_job_id bigint,
    error_message text,
    duration_ms integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT forest_district_exports_scale_m_check CHECK (((scale_m >= 10) AND (scale_m <= 1000))),
    CONSTRAINT forest_district_exports_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'computing'::character varying, 'completed'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: TABLE forest_district_exports; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON TABLE forest.forest_district_exports IS 'Per-district export state cho forest classification: chia GEE classified download theo huyện (scale 100m), aggregate byClass lên tỉnh = Σ per huyện';


--
-- Name: forest_district_exports_id_seq; Type: SEQUENCE; Schema: forest; Owner: -
--

CREATE SEQUENCE forest.forest_district_exports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forest_district_exports_id_seq; Type: SEQUENCE OWNED BY; Schema: forest; Owner: -
--

ALTER SEQUENCE forest.forest_district_exports_id_seq OWNED BY forest.forest_district_exports.id;


--
-- Name: forest_gt_points; Type: TABLE; Schema: forest; Owner: -
--

CREATE TABLE forest.forest_gt_points (
    id bigint NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    class_id smallint NOT NULL,
    lng numeric(9,6) NOT NULL,
    lat numeric(8,6) NOT NULL,
    geom public.geometry(Point,4326) NOT NULL,
    source character varying(64) DEFAULT 'field_report'::character varying,
    photo_url text,
    reporter_name character varying(200),
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT forest_gt_points_class_id_check CHECK (((class_id >= 0) AND (class_id <= 12))),
    CONSTRAINT forest_gt_points_lat_check CHECK (((lat >= (13)::numeric) AND (lat <= 16.5))),
    CONSTRAINT forest_gt_points_lng_check CHECK (((lng >= (106)::numeric) AND (lng <= (109)::numeric)))
);


--
-- Name: forest_gt_points_id_seq; Type: SEQUENCE; Schema: forest; Owner: -
--

CREATE SEQUENCE forest.forest_gt_points_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forest_gt_points_id_seq; Type: SEQUENCE OWNED BY; Schema: forest; Owner: -
--

ALTER SEQUENCE forest.forest_gt_points_id_seq OWNED BY forest.forest_gt_points.id;


--
-- Name: forest_gt_zones; Type: TABLE; Schema: forest; Owner: -
--

CREATE TABLE forest.forest_gt_zones (
    id bigint NOT NULL,
    name character varying(200),
    observed_at timestamp with time zone NOT NULL,
    class_id smallint NOT NULL,
    source character varying(64) DEFAULT 'field_survey'::character varying,
    geom public.geometry(MultiPolygon,4326) NOT NULL,
    area_ha numeric(12,2),
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT forest_gt_zones_class_id_check CHECK (((class_id >= 0) AND (class_id <= 12)))
);


--
-- Name: forest_gt_zones_id_seq; Type: SEQUENCE; Schema: forest; Owner: -
--

CREATE SEQUENCE forest.forest_gt_zones_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forest_gt_zones_id_seq; Type: SEQUENCE OWNED BY; Schema: forest; Owner: -
--

ALTER SEQUENCE forest.forest_gt_zones_id_seq OWNED BY forest.forest_gt_zones.id;


--
-- Name: forest_snapshots; Type: TABLE; Schema: forest; Owner: -
--

CREATE TABLE forest.forest_snapshots (
    id bigint NOT NULL,
    year smallint NOT NULL,
    month smallint NOT NULL,
    status character varying(32) DEFAULT 'pending'::character varying NOT NULL,
    model_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    province_summary jsonb,
    oob_accuracy numeric(5,2),
    s2_image_count integer,
    ls_image_count integer,
    gee_task_id text,
    minio_key text,
    geoserver_layer text,
    geoserver_store text,
    error_message text,
    computed_at timestamp with time zone,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    trigger character varying(16) DEFAULT 'cron'::character varying NOT NULL,
    requested_by bigint,
    duration_ms integer,
    test_accuracy numeric(5,2),
    test_kappa numeric(6,3),
    sample_quotas jsonb,
    gee_map_id character varying(500),
    gee_tile_url text,
    gee_tile_generated_at timestamp with time zone,
    gt_zone_count integer DEFAULT 0 NOT NULL,
    gt_point_count integer DEFAULT 0 NOT NULL,
    gt_window_days smallint,
    gee_download_url text,
    retry_count integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone,
    last_retry_error text,
    attempt smallint DEFAULT 1 NOT NULL,
    download_scale_m integer DEFAULT 100 NOT NULL,
    district_export_summary jsonb,
    CONSTRAINT forest_snapshots_attempt_check CHECK (((attempt >= 1) AND (attempt <= 100))),
    CONSTRAINT forest_snapshots_download_scale_m_check CHECK (((download_scale_m >= 10) AND (download_scale_m <= 1000))),
    CONSTRAINT forest_snapshots_retry_count_check CHECK (((retry_count >= 0) AND (retry_count <= 3)))
);


--
-- Name: COLUMN forest_snapshots.trigger; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.trigger IS 'cron | manual | user — what initiated this run';


--
-- Name: COLUMN forest_snapshots.requested_by; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.requested_by IS 'User who requested this run (NULL for cron/system triggers)';


--
-- Name: COLUMN forest_snapshots.duration_ms; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.duration_ms IS 'Wall-clock milliseconds from run start to completed/failed';


--
-- Name: COLUMN forest_snapshots.gt_zone_count; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.gt_zone_count IS 'Số zone GT active dùng cho snapshot (0 = không có GT)';


--
-- Name: COLUMN forest_snapshots.gt_point_count; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.gt_point_count IS 'Số point GT active dùng cho snapshot';


--
-- Name: COLUMN forest_snapshots.gt_window_days; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.gt_window_days IS 'Cửa sổ GT (ngày) — mặc định env FC_GT_WINDOW_DAYS = 180';


--
-- Name: COLUMN forest_snapshots.gee_download_url; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.gee_download_url IS 'GEE getDownloadURL() cho classified image (11-class viz), clip theo province polygon. GeoTIFF trần valid ~24h.';


--
-- Name: COLUMN forest_snapshots.attempt; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.attempt IS 'Lần chạy trong cùng (year, month). Mỗi refresh tạo dòng mới với attempt++';


--
-- Name: COLUMN forest_snapshots.download_scale_m; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.download_scale_m IS 'Scale (m) dùng cho getDownloadURL per district. Default 100.';


--
-- Name: COLUMN forest_snapshots.district_export_summary; Type: COMMENT; Schema: forest; Owner: -
--

COMMENT ON COLUMN forest.forest_snapshots.district_export_summary IS 'Aggregate của forest_district_exports: { total, completed, failed, totalHa, forestHa, byClass:{0..12:ha} }';


--
-- Name: forest_snapshots_id_seq; Type: SEQUENCE; Schema: forest; Owner: -
--

CREATE SEQUENCE forest.forest_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forest_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: forest; Owner: -
--

ALTER SEQUENCE forest.forest_snapshots_id_seq OWNED BY forest.forest_snapshots.id;


--
-- Name: v_gt_recent_points; Type: VIEW; Schema: forest; Owner: -
--

CREATE VIEW forest.v_gt_recent_points AS
 SELECT id,
    observed_at,
    class_id,
    source,
    lng,
    lat,
    geom
   FROM forest.forest_gt_points
  WHERE (is_active = true);


--
-- Name: v_gt_recent_zones; Type: VIEW; Schema: forest; Owner: -
--

CREATE VIEW forest.v_gt_recent_zones AS
 SELECT id,
    name,
    observed_at,
    class_id,
    source,
    geom,
    area_ha
   FROM forest.forest_gt_zones
  WHERE (is_active = true);


--
-- Name: aoho_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.aoho_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: duongquoclo_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.duongquoclo_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: duongtinhlo_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.duongtinhlo_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: field_measurement_photos; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.field_measurement_photos (
    id bigint NOT NULL,
    measurement_id bigint NOT NULL,
    minio_key text NOT NULL,
    original_name character varying(255),
    mime_type character varying(100),
    size_bytes bigint,
    taken_at timestamp with time zone,
    uploaded_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: field_measurement_photos_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.field_measurement_photos_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: field_measurement_photos_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.field_measurement_photos_id_seq OWNED BY gis.field_measurement_photos.id;


--
-- Name: field_measurements; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.field_measurements (
    id bigint NOT NULL,
    code character varying(30),
    area_id bigint,
    layer_id integer,
    points jsonb NOT NULL,
    geom public.geometry(Polygon,4326) NOT NULL,
    area_m2 numeric(16,2) NOT NULL,
    avg_accuracy_m numeric(6,2),
    commune_code character varying(20),
    affected_features jsonb DEFAULT '[]'::jsonb NOT NULL,
    old_land_use character varying(100),
    new_land_use character varying(100),
    note text,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    review_note text,
    device_info jsonb,
    measured_by bigint,
    verified_by bigint,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    submitted_at timestamp with time zone,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    client_uuid character varying(80),
    CONSTRAINT field_measurements_area_m2_check CHECK ((area_m2 >= (0)::numeric)),
    CONSTRAINT field_measurements_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'submitted'::character varying, 'verified'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: field_measurements_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.field_measurements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: field_measurements_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.field_measurements_id_seq OWNED BY gis.field_measurements.id;


--
-- Name: layer_import_jobs; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.layer_import_jobs (
    id bigint NOT NULL,
    layer_id integer NOT NULL,
    source_format character varying(30) NOT NULL,
    source_info jsonb DEFAULT '{}'::jsonb NOT NULL,
    import_mode character varying(20) DEFAULT 'append'::character varying NOT NULL,
    srid_input integer DEFAULT 4326,
    encoding character varying(20) DEFAULT 'UTF-8'::character varying,
    strategy character varying(20) DEFAULT 'best_effort'::character varying NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    progress numeric(5,2) DEFAULT 0,
    total_features integer,
    imported_count integer,
    failed_count integer,
    error_log text,
    result_summary jsonb DEFAULT '{}'::jsonb,
    created_by bigint,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT layer_import_jobs_import_mode_check CHECK (((import_mode)::text = ANY (ARRAY[('append'::character varying)::text, ('overwrite'::character varying)::text, ('upsert'::character varying)::text]))),
    CONSTRAINT layer_import_jobs_source_format_check CHECK (((source_format)::text = ANY (ARRAY[('shapefile'::character varying)::text, ('geojson'::character varying)::text, ('csv'::character varying)::text, ('kml'::character varying)::text, ('wfs'::character varying)::text, ('postgis_dump'::character varying)::text, ('geotiff'::character varying)::text, ('filegdb'::character varying)::text]))),
    CONSTRAINT layer_import_jobs_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('processing'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text, ('cancelled'::character varying)::text]))),
    CONSTRAINT layer_import_jobs_strategy_check CHECK (((strategy)::text = ANY (ARRAY[('best_effort'::character varying)::text, ('all_or_nothing'::character varying)::text])))
);


--
-- Name: layer_import_jobs_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.layer_import_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: layer_import_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.layer_import_jobs_id_seq OWNED BY gis.layer_import_jobs.id;


--
-- Name: layer_registry; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.layer_registry (
    id integer NOT NULL,
    code character varying(60) NOT NULL,
    name_vi character varying(200) NOT NULL,
    name_en character varying(200),
    description_vi text,
    description_en text,
    schema_name character varying(60) DEFAULT 'gis'::character varying NOT NULL,
    table_name character varying(120) NOT NULL,
    geometry_type character varying(30) NOT NULL,
    epsg_code integer DEFAULT 4326 NOT NULL,
    geoserver_layer character varying(255),
    geoserver_store character varying(120),
    default_style jsonb DEFAULT '{}'::jsonb NOT NULL,
    min_zoom integer DEFAULT 1 NOT NULL,
    max_zoom integer DEFAULT 22 NOT NULL,
    label_field character varying(60),
    category character varying(60),
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    is_editable boolean DEFAULT true NOT NULL,
    layer_permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    feature_count bigint DEFAULT 0,
    last_updated_at timestamp with time zone,
    bbox public.geometry(Polygon,4326),
    created_by bigint,
    updated_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    geometry_column character varying(60) DEFAULT 'geom'::character varying NOT NULL,
    source_url text,
    layer_kind character varying(20) DEFAULT 'overlay'::character varying NOT NULL,
    layer_group character varying(80),
    data_year integer,
    source_dataset character varying(120),
    source_layer_name character varying(160),
    remote_sensing_image_id bigint,
    raster_ingest_job_id bigint,
    raster_source_url text,
    raster_gee_metadata jsonb,
    deleted_at timestamp with time zone,
    CONSTRAINT chk_layer_registry_data_year CHECK (((data_year IS NULL) OR ((data_year >= 1900) AND (data_year <= 2100)))),
    CONSTRAINT chk_layer_registry_geometry_column CHECK (((geometry_column)::text ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'::text)),
    CONSTRAINT chk_layer_registry_identifiers CHECK ((((schema_name)::text ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'::text) AND ((table_name)::text ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'::text) AND ((code)::text ~ '^[a-zA-Z0-9_-]+$'::text))),
    CONSTRAINT chk_layer_registry_layer_kind CHECK (((layer_kind)::text = ANY ((ARRAY['basemap'::character varying, 'overlay'::character varying])::text[]))),
    CONSTRAINT chk_layer_registry_zoom_range CHECK (((min_zoom >= 0) AND (min_zoom <= 24) AND ((max_zoom >= 0) AND (max_zoom <= 24)) AND (min_zoom <= max_zoom))),
    CONSTRAINT layer_registry_geometry_type_check CHECK (((geometry_type)::text = ANY (ARRAY[('POINT'::character varying)::text, ('MULTIPOINT'::character varying)::text, ('LINESTRING'::character varying)::text, ('MULTILINESTRING'::character varying)::text, ('POLYGON'::character varying)::text, ('MULTIPOLYGON'::character varying)::text, ('GEOMETRY'::character varying)::text, ('RASTER'::character varying)::text])))
);


--
-- Name: COLUMN layer_registry.remote_sensing_image_id; Type: COMMENT; Schema: gis; Owner: -
--

COMMENT ON COLUMN gis.layer_registry.remote_sensing_image_id IS 'FK tới raster.remote_sensing_images — layer được publish từ kho ảnh viễn thám';


--
-- Name: layer_registry_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.layer_registry_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: layer_registry_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.layer_registry_id_seq OWNED BY gis.layer_registry.id;


--
-- Name: layer_series_granules; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.layer_series_granules (
    id bigint NOT NULL,
    group_id integer NOT NULL,
    year_from integer NOT NULL,
    year_to integer NOT NULL,
    time_value date NOT NULL,
    label character varying(120) NOT NULL,
    file_name character varying(255) NOT NULL,
    source_layer character varying(255),
    source_url text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_layer_series_years CHECK ((((year_from >= 1900) AND (year_from <= 2100)) AND ((year_to >= year_from) AND (year_to <= 2100))))
);


--
-- Name: layer_series_granules_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.layer_series_granules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: layer_series_granules_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.layer_series_granules_id_seq OWNED BY gis.layer_series_granules.id;


--
-- Name: layer_series_groups; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.layer_series_groups (
    id integer NOT NULL,
    code character varying(80) NOT NULL,
    name_vi character varying(200) NOT NULL,
    name_en character varying(200),
    geoserver_store character varying(120) NOT NULL,
    geoserver_layer character varying(255) NOT NULL,
    geoserver_style character varying(160),
    is_active boolean DEFAULT true NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_layer_series_group_code CHECK (((code)::text ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'::text)),
    CONSTRAINT chk_layer_series_store CHECK (((geoserver_store)::text ~ '^[a-zA-Z_][a-zA-Z0-9_]*$'::text))
);


--
-- Name: layer_series_groups_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.layer_series_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: layer_series_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.layer_series_groups_id_seq OWNED BY gis.layer_series_groups.id;


--
-- Name: map_apis; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.map_apis (
    id bigint NOT NULL,
    name character varying(150) NOT NULL,
    layer_id integer NOT NULL,
    key_prefix character varying(20) NOT NULL,
    key_hash character varying(128) NOT NULL,
    key_last4 character varying(8),
    scope jsonb DEFAULT '{"read": true, "rate_per_min": 60}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    request_count bigint DEFAULT 0 NOT NULL,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: map_apis_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.map_apis_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: map_apis_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.map_apis_id_seq OWNED BY gis.map_apis.id;


--
-- Name: monitored_areas; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.monitored_areas (
    id bigint NOT NULL,
    code character varying(30),
    name character varying(200),
    ref_geom public.geometry(Polygon,4326),
    commune_code character varying(20),
    note text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: monitored_areas_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.monitored_areas_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitored_areas_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.monitored_areas_id_seq OWNED BY gis.monitored_areas.id;


--
-- Name: ranhgioihuyen_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.ranhgioihuyen_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ranhgioitinh_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.ranhgioitinh_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: raster_ingest_jobs; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.raster_ingest_jobs (
    id bigint NOT NULL,
    layer_id integer,
    layer_code character varying(60) NOT NULL,
    source_kind character varying(32) DEFAULT 'gee_download_url'::character varying NOT NULL,
    source_url text NOT NULL,
    source_hash character(64) NOT NULL,
    request_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(24) DEFAULT 'pending'::character varying NOT NULL,
    retry_count smallint DEFAULT 0 NOT NULL,
    progress smallint DEFAULT 0 NOT NULL,
    error_log text,
    minio_bucket character varying(64),
    minio_key text,
    file_size_bytes bigint,
    file_sha256 character(64),
    geoserver_store character varying(120),
    geoserver_layer text,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    next_retry_at timestamp with time zone,
    CONSTRAINT raster_ingest_jobs_progress_check CHECK (((progress >= 0) AND (progress <= 100))),
    CONSTRAINT raster_ingest_jobs_source_kind_check CHECK (((source_kind)::text = 'gee_download_url'::text)),
    CONSTRAINT raster_ingest_jobs_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'downloading'::character varying, 'validating'::character varying, 'uploading'::character varying, 'publishing'::character varying, 'completed'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'url_expired'::character varying])::text[])))
);


--
-- Name: TABLE raster_ingest_jobs; Type: COMMENT; Schema: gis; Owner: -
--

COMMENT ON TABLE gis.raster_ingest_jobs IS 'Job pipeline GEE → MinIO → GeoServer (đợt 1: gee_download_url)';


--
-- Name: COLUMN raster_ingest_jobs.source_hash; Type: COMMENT; Schema: gis; Owner: -
--

COMMENT ON COLUMN gis.raster_ingest_jobs.source_hash IS 'SHA-256 của source_url — dedupe không lưu token';


--
-- Name: COLUMN raster_ingest_jobs.request_params; Type: COMMENT; Schema: gis; Owner: -
--

COMMENT ON COLUMN gis.raster_ingest_jobs.request_params IS 'JSONB: bbox, epsg_code, scale_m, gee_map_id, thumbnail_url…';


--
-- Name: COLUMN raster_ingest_jobs.status; Type: COMMENT; Schema: gis; Owner: -
--

COMMENT ON COLUMN gis.raster_ingest_jobs.status IS 'State: pending/downloading/validating/uploading/publishing/completed/failed/cancelled/url_expired. url_expired = lien ket tai tam het han (HTTP 401), cho job refresh sinh lien ket moi.';


--
-- Name: COLUMN raster_ingest_jobs.file_sha256; Type: COMMENT; Schema: gis; Owner: -
--

COMMENT ON COLUMN gis.raster_ingest_jobs.file_sha256 IS 'SHA-256 của GeoTIFF cuối — content-addressable';


--
-- Name: COLUMN raster_ingest_jobs.next_retry_at; Type: COMMENT; Schema: gis; Owner: -
--

COMMENT ON COLUMN gis.raster_ingest_jobs.next_retry_at IS 'Earliest time worker được phép re-claim job (dùng cho backoff sau HTTP 429). NULL = pick ngay.';


--
-- Name: raster_ingest_jobs_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.raster_ingest_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: raster_ingest_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.raster_ingest_jobs_id_seq OWNED BY gis.raster_ingest_jobs.id;


--
-- Name: songsuoitinh_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.songsuoitinh_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stats_cache; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.stats_cache (
    cache_key character varying(200) NOT NULL,
    payload jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: ubnd_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.ubnd_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vungkontum_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.vungkontum_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: weather_cache; Type: TABLE; Schema: gis; Owner: -
--

CREATE TABLE gis.weather_cache (
    id bigint NOT NULL,
    cache_key character varying(200) NOT NULL,
    data_type character varying(30) NOT NULL,
    lng double precision,
    lat double precision,
    bbox jsonb,
    payload jsonb NOT NULL,
    source character varying(40) DEFAULT 'openweather'::character varying NOT NULL,
    observed_at timestamp with time zone,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT weather_cache_data_type_check CHECK (((data_type)::text = ANY ((ARRAY['point'::character varying, 'wind_grid'::character varying, 'forecast'::character varying])::text[])))
);


--
-- Name: weather_cache_id_seq; Type: SEQUENCE; Schema: gis; Owner: -
--

CREATE SEQUENCE gis.weather_cache_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: weather_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: gis; Owner: -
--

ALTER SEQUENCE gis.weather_cache_id_seq OWNED BY gis.weather_cache.id;


--
-- Name: remote_sensing_download_logs; Type: TABLE; Schema: raster; Owner: -
--

CREATE TABLE raster.remote_sensing_download_logs (
    id bigint NOT NULL,
    image_id bigint NOT NULL,
    file_id bigint,
    user_id bigint,
    ip_address character varying(45),
    user_agent text,
    presigned_url text,
    expires_at timestamp with time zone,
    download_type character varying(50) DEFAULT 'presigned'::character varying,
    status character varying(20) DEFAULT 'issued'::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: remote_sensing_download_logs_id_seq; Type: SEQUENCE; Schema: raster; Owner: -
--

CREATE SEQUENCE raster.remote_sensing_download_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: remote_sensing_download_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: raster; Owner: -
--

ALTER SEQUENCE raster.remote_sensing_download_logs_id_seq OWNED BY raster.remote_sensing_download_logs.id;


--
-- Name: remote_sensing_files; Type: TABLE; Schema: raster; Owner: -
--

CREATE TABLE raster.remote_sensing_files (
    id bigint NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    image_id bigint NOT NULL,
    bucket_name character varying(255) NOT NULL,
    object_key text NOT NULL,
    original_name character varying(500) NOT NULL,
    file_role raster.file_role DEFAULT 'primary'::raster.file_role NOT NULL,
    mime_type character varying(127),
    file_size_bytes bigint,
    width_px integer,
    height_px integer,
    checksum_md5 character varying(32),
    extra_info jsonb DEFAULT '{}'::jsonb NOT NULL,
    uploaded_by bigint,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: remote_sensing_files_id_seq; Type: SEQUENCE; Schema: raster; Owner: -
--

CREATE SEQUENCE raster.remote_sensing_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: remote_sensing_files_id_seq; Type: SEQUENCE OWNED BY; Schema: raster; Owner: -
--

ALTER SEQUENCE raster.remote_sensing_files_id_seq OWNED BY raster.remote_sensing_files.id;


--
-- Name: remote_sensing_images; Type: TABLE; Schema: raster; Owner: -
--

CREATE TABLE raster.remote_sensing_images (
    id bigint NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(500) NOT NULL,
    description text,
    satellite raster.satellite_type DEFAULT 'other'::raster.satellite_type NOT NULL,
    image_type raster.image_type DEFAULT 'geotiff_raw'::raster.image_type NOT NULL,
    acquisition_date date NOT NULL,
    acquisition_time time with time zone,
    bbox public.geometry(Polygon,4326),
    province_code character varying(20),
    district_code character varying(20),
    location_name character varying(255),
    cloud_percent numeric(5,2),
    resolution_m numeric(10,4),
    epsg_code integer DEFAULT 4326,
    band_count integer,
    nodata_value numeric,
    extra_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    status raster.processing_status DEFAULT 'pending'::raster.processing_status NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    created_by bigint,
    updated_by bigint,
    deleted_by bigint,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT remote_sensing_images_cloud_percent_check CHECK (((cloud_percent >= (0)::numeric) AND (cloud_percent <= (100)::numeric)))
);


--
-- Name: remote_sensing_images_id_seq; Type: SEQUENCE; Schema: raster; Owner: -
--

CREATE SEQUENCE raster.remote_sensing_images_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: remote_sensing_images_id_seq; Type: SEQUENCE OWNED BY; Schema: raster; Owner: -
--

ALTER SEQUENCE raster.remote_sensing_images_id_seq OWNED BY raster.remote_sensing_images.id;


--
-- Name: remote_sensing_processing_jobs; Type: TABLE; Schema: raster; Owner: -
--

CREATE TABLE raster.remote_sensing_processing_jobs (
    id bigint NOT NULL,
    uuid uuid DEFAULT gen_random_uuid() NOT NULL,
    image_id bigint NOT NULL,
    file_id bigint,
    job_type raster.job_type DEFAULT 'full_pipeline'::raster.job_type NOT NULL,
    status raster.processing_status DEFAULT 'pending'::raster.processing_status NOT NULL,
    progress numeric(5,2) DEFAULT 0,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    worker_id character varying(100),
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_retry_at timestamp with time zone,
    result_data jsonb DEFAULT '{}'::jsonb,
    error_message text,
    error_stack text,
    priority integer DEFAULT 5 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT remote_sensing_processing_jobs_progress_check CHECK (((progress >= (0)::numeric) AND (progress <= (100)::numeric)))
);


--
-- Name: remote_sensing_processing_jobs_id_seq; Type: SEQUENCE; Schema: raster; Owner: -
--

CREATE SEQUENCE raster.remote_sensing_processing_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: remote_sensing_processing_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: raster; Owner: -
--

ALTER SEQUENCE raster.remote_sensing_processing_jobs_id_seq OWNED BY raster.remote_sensing_processing_jobs.id;


--
-- Name: remote_sensing_statistics; Type: TABLE; Schema: raster; Owner: -
--

CREATE TABLE raster.remote_sensing_statistics (
    id bigint NOT NULL,
    image_id bigint NOT NULL,
    file_id bigint,
    band_index integer DEFAULT 1 NOT NULL,
    band_name character varying(100),
    min_value numeric,
    max_value numeric,
    mean_value numeric,
    std_value numeric,
    valid_pixels bigint,
    total_pixels bigint,
    histogram jsonb,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: remote_sensing_statistics_id_seq; Type: SEQUENCE; Schema: raster; Owner: -
--

CREATE SEQUENCE raster.remote_sensing_statistics_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: remote_sensing_statistics_id_seq; Type: SEQUENCE OWNED BY; Schema: raster; Owner: -
--

ALTER SEQUENCE raster.remote_sensing_statistics_id_seq OWNED BY raster.remote_sensing_statistics.id;


--
-- Name: image_results; Type: TABLE; Schema: satellite; Owner: -
--

CREATE TABLE satellite.image_results (
    id bigint NOT NULL,
    request_hash character varying(64) NOT NULL,
    image_type character varying(32) NOT NULL,
    collection character varying(32),
    start_date date NOT NULL,
    end_date date NOT NULL,
    start_date2 date,
    end_date2 date,
    bbox jsonb,
    geometry jsonb,
    tile_url text NOT NULL,
    map_id character varying(256),
    stats jsonb,
    legend jsonb,
    metadata jsonb,
    status character varying(32) DEFAULT 'ready'::character varying NOT NULL,
    gee_task_id text,
    minio_key text,
    geoserver_layer text,
    geoserver_store text,
    publish_error text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: image_results_id_seq; Type: SEQUENCE; Schema: satellite; Owner: -
--

CREATE SEQUENCE satellite.image_results_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_results_id_seq; Type: SEQUENCE OWNED BY; Schema: satellite; Owner: -
--

ALTER SEQUENCE satellite.image_results_id_seq OWNED BY satellite.image_results.id;


--
-- Name: activity_logs id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.activity_logs ALTER COLUMN id SET DEFAULT nextval('auth.activity_logs_id_seq'::regclass);


--
-- Name: email_verification_tokens id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.email_verification_tokens ALTER COLUMN id SET DEFAULT nextval('auth.email_verification_tokens_id_seq'::regclass);


--
-- Name: password_reset_tokens id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('auth.password_reset_tokens_id_seq'::regclass);


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('auth.refresh_tokens_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.roles ALTER COLUMN id SET DEFAULT nextval('auth.roles_id_seq'::regclass);


--
-- Name: social_accounts id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.social_accounts ALTER COLUMN id SET DEFAULT nextval('auth.social_accounts_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users ALTER COLUMN id SET DEFAULT nextval('auth.users_id_seq'::regclass);


--
-- Name: comments id; Type: DEFAULT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.comments ALTER COLUMN id SET DEFAULT nextval('cms.comments_id_seq'::regclass);


--
-- Name: document_translations id; Type: DEFAULT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.document_translations ALTER COLUMN id SET DEFAULT nextval('cms.document_translations_id_seq'::regclass);


--
-- Name: documents id; Type: DEFAULT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.documents ALTER COLUMN id SET DEFAULT nextval('cms.documents_id_seq'::regclass);


--
-- Name: news id; Type: DEFAULT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.news ALTER COLUMN id SET DEFAULT nextval('cms.news_id_seq'::regclass);


--
-- Name: news_translations id; Type: DEFAULT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.news_translations ALTER COLUMN id SET DEFAULT nextval('cms.news_translations_id_seq'::regclass);


--
-- Name: pdf_map_translations id; Type: DEFAULT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.pdf_map_translations ALTER COLUMN id SET DEFAULT nextval('cms.pdf_map_translations_id_seq'::regclass);


--
-- Name: pdf_maps id; Type: DEFAULT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.pdf_maps ALTER COLUMN id SET DEFAULT nextval('cms.pdf_maps_id_seq'::regclass);


--
-- Name: device_tokens id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.device_tokens ALTER COLUMN id SET DEFAULT nextval('core.device_tokens_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.notifications ALTER COLUMN id SET DEFAULT nextval('core.notifications_id_seq'::regclass);


--
-- Name: feedback id; Type: DEFAULT; Schema: field; Owner: -
--

ALTER TABLE ONLY field.feedback ALTER COLUMN id SET DEFAULT nextval('field.feedback_id_seq'::regclass);


--
-- Name: feedback_status_log id; Type: DEFAULT; Schema: field; Owner: -
--

ALTER TABLE ONLY field.feedback_status_log ALTER COLUMN id SET DEFAULT nextval('field.feedback_status_log_id_seq'::regclass);


--
-- Name: fire_gt_points id; Type: DEFAULT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_gt_points ALTER COLUMN id SET DEFAULT nextval('fire.fire_gt_points_id_seq'::regclass);


--
-- Name: fire_gt_zones id; Type: DEFAULT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_gt_zones ALTER COLUMN id SET DEFAULT nextval('fire.fire_gt_zones_id_seq'::regclass);


--
-- Name: fire_risk_district_exports id; Type: DEFAULT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_district_exports ALTER COLUMN id SET DEFAULT nextval('fire.fire_risk_district_exports_id_seq'::regclass);


--
-- Name: fire_risk_features id; Type: DEFAULT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_features ALTER COLUMN id SET DEFAULT nextval('fire.fire_risk_features_id_seq'::regclass);


--
-- Name: fire_risk_snapshots id; Type: DEFAULT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_snapshots ALTER COLUMN id SET DEFAULT nextval('fire.fire_risk_snapshots_id_seq'::regclass);


--
-- Name: forest_district_areas id; Type: DEFAULT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_district_areas ALTER COLUMN id SET DEFAULT nextval('forest.forest_district_areas_id_seq'::regclass);


--
-- Name: forest_district_exports id; Type: DEFAULT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_district_exports ALTER COLUMN id SET DEFAULT nextval('forest.forest_district_exports_id_seq'::regclass);


--
-- Name: forest_gt_points id; Type: DEFAULT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_gt_points ALTER COLUMN id SET DEFAULT nextval('forest.forest_gt_points_id_seq'::regclass);


--
-- Name: forest_gt_zones id; Type: DEFAULT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_gt_zones ALTER COLUMN id SET DEFAULT nextval('forest.forest_gt_zones_id_seq'::regclass);


--
-- Name: forest_snapshots id; Type: DEFAULT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_snapshots ALTER COLUMN id SET DEFAULT nextval('forest.forest_snapshots_id_seq'::regclass);


--
-- Name: field_measurement_photos id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurement_photos ALTER COLUMN id SET DEFAULT nextval('gis.field_measurement_photos_id_seq'::regclass);


--
-- Name: field_measurements id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurements ALTER COLUMN id SET DEFAULT nextval('gis.field_measurements_id_seq'::regclass);


--
-- Name: layer_import_jobs id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_import_jobs ALTER COLUMN id SET DEFAULT nextval('gis.layer_import_jobs_id_seq'::regclass);


--
-- Name: layer_registry id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_registry ALTER COLUMN id SET DEFAULT nextval('gis.layer_registry_id_seq'::regclass);


--
-- Name: layer_series_granules id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_granules ALTER COLUMN id SET DEFAULT nextval('gis.layer_series_granules_id_seq'::regclass);


--
-- Name: layer_series_groups id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_groups ALTER COLUMN id SET DEFAULT nextval('gis.layer_series_groups_id_seq'::regclass);


--
-- Name: map_apis id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.map_apis ALTER COLUMN id SET DEFAULT nextval('gis.map_apis_id_seq'::regclass);


--
-- Name: monitored_areas id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.monitored_areas ALTER COLUMN id SET DEFAULT nextval('gis.monitored_areas_id_seq'::regclass);


--
-- Name: raster_ingest_jobs id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.raster_ingest_jobs ALTER COLUMN id SET DEFAULT nextval('gis.raster_ingest_jobs_id_seq'::regclass);


--
-- Name: weather_cache id; Type: DEFAULT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.weather_cache ALTER COLUMN id SET DEFAULT nextval('gis.weather_cache_id_seq'::regclass);


--
-- Name: remote_sensing_download_logs id; Type: DEFAULT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_download_logs ALTER COLUMN id SET DEFAULT nextval('raster.remote_sensing_download_logs_id_seq'::regclass);


--
-- Name: remote_sensing_files id; Type: DEFAULT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_files ALTER COLUMN id SET DEFAULT nextval('raster.remote_sensing_files_id_seq'::regclass);


--
-- Name: remote_sensing_images id; Type: DEFAULT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_images ALTER COLUMN id SET DEFAULT nextval('raster.remote_sensing_images_id_seq'::regclass);


--
-- Name: remote_sensing_processing_jobs id; Type: DEFAULT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_processing_jobs ALTER COLUMN id SET DEFAULT nextval('raster.remote_sensing_processing_jobs_id_seq'::regclass);


--
-- Name: remote_sensing_statistics id; Type: DEFAULT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_statistics ALTER COLUMN id SET DEFAULT nextval('raster.remote_sensing_statistics_id_seq'::regclass);


--
-- Name: image_results id; Type: DEFAULT; Schema: satellite; Owner: -
--

ALTER TABLE ONLY satellite.image_results ALTER COLUMN id SET DEFAULT nextval('satellite.image_results_id_seq'::regclass);


--
-- Name: activity_logs activity_logs_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.activity_logs
    ADD CONSTRAINT activity_logs_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: oauth_exchange_codes oauth_exchange_codes_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_exchange_codes
    ADD CONSTRAINT oauth_exchange_codes_pkey PRIMARY KEY (code_hash);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: roles roles_code_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.roles
    ADD CONSTRAINT roles_code_key UNIQUE (code);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: social_accounts social_accounts_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.social_accounts
    ADD CONSTRAINT social_accounts_pkey PRIMARY KEY (id);


--
-- Name: token_blacklist token_blacklist_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.token_blacklist
    ADD CONSTRAINT token_blacklist_pkey PRIMARY KEY (jti);


--
-- Name: social_accounts uq_social_provider_id; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.social_accounts
    ADD CONSTRAINT uq_social_provider_id UNIQUE (provider, provider_id);


--
-- Name: social_accounts uq_social_user_provider; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.social_accounts
    ADD CONSTRAINT uq_social_user_provider UNIQUE (user_id, provider);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: document_translations document_translations_document_id_lang_key; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.document_translations
    ADD CONSTRAINT document_translations_document_id_lang_key UNIQUE (document_id, lang);


--
-- Name: document_translations document_translations_pkey; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.document_translations
    ADD CONSTRAINT document_translations_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: news news_pkey; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.news
    ADD CONSTRAINT news_pkey PRIMARY KEY (id);


--
-- Name: news_translations news_translations_news_id_lang_key; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.news_translations
    ADD CONSTRAINT news_translations_news_id_lang_key UNIQUE (news_id, lang);


--
-- Name: news_translations news_translations_pkey; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.news_translations
    ADD CONSTRAINT news_translations_pkey PRIMARY KEY (id);


--
-- Name: pdf_map_translations pdf_map_translations_pdf_map_id_lang_key; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.pdf_map_translations
    ADD CONSTRAINT pdf_map_translations_pdf_map_id_lang_key UNIQUE (pdf_map_id, lang);


--
-- Name: pdf_map_translations pdf_map_translations_pkey; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.pdf_map_translations
    ADD CONSTRAINT pdf_map_translations_pkey PRIMARY KEY (id);


--
-- Name: pdf_maps pdf_maps_pkey; Type: CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.pdf_maps
    ADD CONSTRAINT pdf_maps_pkey PRIMARY KEY (id);


--
-- Name: device_tokens device_tokens_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.device_tokens
    ADD CONSTRAINT device_tokens_pkey PRIMARY KEY (id);


--
-- Name: notification_reads notification_reads_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.notification_reads
    ADD CONSTRAINT notification_reads_pkey PRIMARY KEY (notification_id, user_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: feedback feedback_pkey; Type: CONSTRAINT; Schema: field; Owner: -
--

ALTER TABLE ONLY field.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);


--
-- Name: feedback_status_log feedback_status_log_pkey; Type: CONSTRAINT; Schema: field; Owner: -
--

ALTER TABLE ONLY field.feedback_status_log
    ADD CONSTRAINT feedback_status_log_pkey PRIMARY KEY (id);


--
-- Name: fire_gt_points fire_gt_points_pkey; Type: CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_gt_points
    ADD CONSTRAINT fire_gt_points_pkey PRIMARY KEY (id);


--
-- Name: fire_gt_zones fire_gt_zones_pkey; Type: CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_gt_zones
    ADD CONSTRAINT fire_gt_zones_pkey PRIMARY KEY (id);


--
-- Name: fire_risk_district_exports fire_risk_district_exports_pkey; Type: CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_district_exports
    ADD CONSTRAINT fire_risk_district_exports_pkey PRIMARY KEY (id);


--
-- Name: fire_risk_features fire_risk_features_pkey; Type: CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_features
    ADD CONSTRAINT fire_risk_features_pkey PRIMARY KEY (id);


--
-- Name: fire_risk_snapshots fire_risk_snapshots_pkey; Type: CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_snapshots
    ADD CONSTRAINT fire_risk_snapshots_pkey PRIMARY KEY (id);


--
-- Name: fire_risk_district_exports uniq_fire_district_export_snap_code; Type: CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_district_exports
    ADD CONSTRAINT uniq_fire_district_export_snap_code UNIQUE (snapshot_id, district_code);


--
-- Name: forest_district_areas forest_district_areas_pkey; Type: CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_district_areas
    ADD CONSTRAINT forest_district_areas_pkey PRIMARY KEY (id);


--
-- Name: forest_district_exports forest_district_exports_pkey; Type: CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_district_exports
    ADD CONSTRAINT forest_district_exports_pkey PRIMARY KEY (id);


--
-- Name: forest_gt_points forest_gt_points_pkey; Type: CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_gt_points
    ADD CONSTRAINT forest_gt_points_pkey PRIMARY KEY (id);


--
-- Name: forest_gt_zones forest_gt_zones_pkey; Type: CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_gt_zones
    ADD CONSTRAINT forest_gt_zones_pkey PRIMARY KEY (id);


--
-- Name: forest_snapshots forest_snapshots_pkey; Type: CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_snapshots
    ADD CONSTRAINT forest_snapshots_pkey PRIMARY KEY (id);


--
-- Name: forest_district_exports uniq_forest_district_export_snap_code; Type: CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_district_exports
    ADD CONSTRAINT uniq_forest_district_export_snap_code UNIQUE (snapshot_id, district_code);


--
-- Name: field_measurement_photos field_measurement_photos_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurement_photos
    ADD CONSTRAINT field_measurement_photos_pkey PRIMARY KEY (id);


--
-- Name: field_measurements field_measurements_code_key; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurements
    ADD CONSTRAINT field_measurements_code_key UNIQUE (code);


--
-- Name: field_measurements field_measurements_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurements
    ADD CONSTRAINT field_measurements_pkey PRIMARY KEY (id);


--
-- Name: layer_import_jobs layer_import_jobs_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_import_jobs
    ADD CONSTRAINT layer_import_jobs_pkey PRIMARY KEY (id);


--
-- Name: layer_registry layer_registry_code_key; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_registry
    ADD CONSTRAINT layer_registry_code_key UNIQUE (code);


--
-- Name: layer_registry layer_registry_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_registry
    ADD CONSTRAINT layer_registry_pkey PRIMARY KEY (id);


--
-- Name: layer_series_granules layer_series_granules_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_granules
    ADD CONSTRAINT layer_series_granules_pkey PRIMARY KEY (id);


--
-- Name: layer_series_groups layer_series_groups_code_key; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_groups
    ADD CONSTRAINT layer_series_groups_code_key UNIQUE (code);


--
-- Name: layer_series_groups layer_series_groups_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_groups
    ADD CONSTRAINT layer_series_groups_pkey PRIMARY KEY (id);


--
-- Name: map_apis map_apis_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.map_apis
    ADD CONSTRAINT map_apis_pkey PRIMARY KEY (id);


--
-- Name: monitored_areas monitored_areas_code_key; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.monitored_areas
    ADD CONSTRAINT monitored_areas_code_key UNIQUE (code);


--
-- Name: monitored_areas monitored_areas_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.monitored_areas
    ADD CONSTRAINT monitored_areas_pkey PRIMARY KEY (id);


--
-- Name: raster_ingest_jobs raster_ingest_jobs_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.raster_ingest_jobs
    ADD CONSTRAINT raster_ingest_jobs_pkey PRIMARY KEY (id);


--
-- Name: stats_cache stats_cache_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.stats_cache
    ADD CONSTRAINT stats_cache_pkey PRIMARY KEY (cache_key);


--
-- Name: layer_series_granules uq_layer_series_file; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_granules
    ADD CONSTRAINT uq_layer_series_file UNIQUE (group_id, file_name);


--
-- Name: layer_series_granules uq_layer_series_period; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_granules
    ADD CONSTRAINT uq_layer_series_period UNIQUE (group_id, year_from, year_to);


--
-- Name: layer_series_granules uq_layer_series_time; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_granules
    ADD CONSTRAINT uq_layer_series_time UNIQUE (group_id, time_value);


--
-- Name: weather_cache weather_cache_pkey; Type: CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.weather_cache
    ADD CONSTRAINT weather_cache_pkey PRIMARY KEY (id);


--
-- Name: remote_sensing_download_logs remote_sensing_download_logs_pkey; Type: CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_download_logs
    ADD CONSTRAINT remote_sensing_download_logs_pkey PRIMARY KEY (id);


--
-- Name: remote_sensing_files remote_sensing_files_pkey; Type: CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_files
    ADD CONSTRAINT remote_sensing_files_pkey PRIMARY KEY (id);


--
-- Name: remote_sensing_images remote_sensing_images_pkey; Type: CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_images
    ADD CONSTRAINT remote_sensing_images_pkey PRIMARY KEY (id);


--
-- Name: remote_sensing_processing_jobs remote_sensing_processing_jobs_pkey; Type: CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_processing_jobs
    ADD CONSTRAINT remote_sensing_processing_jobs_pkey PRIMARY KEY (id);


--
-- Name: remote_sensing_statistics remote_sensing_statistics_pkey; Type: CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_statistics
    ADD CONSTRAINT remote_sensing_statistics_pkey PRIMARY KEY (id);


--
-- Name: image_results image_results_pkey; Type: CONSTRAINT; Schema: satellite; Owner: -
--

ALTER TABLE ONLY satellite.image_results
    ADD CONSTRAINT image_results_pkey PRIMARY KEY (id);


--
-- Name: image_results satellite_image_results_hash_type_uq; Type: CONSTRAINT; Schema: satellite; Owner: -
--

ALTER TABLE ONLY satellite.image_results
    ADD CONSTRAINT satellite_image_results_hash_type_uq UNIQUE (request_hash);


--
-- Name: idx_activity_logs_action_created; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_activity_logs_action_created ON auth.activity_logs USING btree (action, created_at DESC);


--
-- Name: idx_activity_logs_ip_action; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_activity_logs_ip_action ON auth.activity_logs USING btree (ip_address, action) WHERE ((action)::text = 'login_failed'::text);


--
-- Name: idx_activity_logs_user_id; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_activity_logs_user_id ON auth.activity_logs USING btree (user_id);


--
-- Name: idx_email_verif_expires_at; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_email_verif_expires_at ON auth.email_verification_tokens USING btree (expires_at);


--
-- Name: idx_email_verif_token_hash; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_email_verif_token_hash ON auth.email_verification_tokens USING btree (token_hash);


--
-- Name: idx_email_verif_user_id; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_email_verif_user_id ON auth.email_verification_tokens USING btree (user_id);


--
-- Name: idx_oauth_codes_expires_at; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_oauth_codes_expires_at ON auth.oauth_exchange_codes USING btree (expires_at);


--
-- Name: idx_password_reset_expires_at; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_password_reset_expires_at ON auth.password_reset_tokens USING btree (expires_at);


--
-- Name: idx_password_reset_token_hash; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_password_reset_token_hash ON auth.password_reset_tokens USING btree (token_hash);


--
-- Name: idx_password_reset_user_id; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_password_reset_user_id ON auth.password_reset_tokens USING btree (user_id);


--
-- Name: idx_refresh_tokens_expires_at; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_refresh_tokens_expires_at ON auth.refresh_tokens USING btree (expires_at) WHERE (is_revoked = false);


--
-- Name: idx_refresh_tokens_token_hash; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_refresh_tokens_token_hash ON auth.refresh_tokens USING btree (token_hash);


--
-- Name: idx_refresh_tokens_user_id; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_refresh_tokens_user_id ON auth.refresh_tokens USING btree (user_id);


--
-- Name: idx_social_active; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_social_active ON auth.social_accounts USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_social_provider_provider_id; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_social_provider_provider_id ON auth.social_accounts USING btree (provider, provider_id);


--
-- Name: idx_social_user_id; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_social_user_id ON auth.social_accounts USING btree (user_id);


--
-- Name: idx_token_blacklist_expires_at; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_token_blacklist_expires_at ON auth.token_blacklist USING btree (expires_at);


--
-- Name: idx_users_is_active; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_users_is_active ON auth.users USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_users_not_deleted; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_users_not_deleted ON auth.users USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_users_role_id; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_users_role_id ON auth.users USING btree (role_id);


--
-- Name: uniq_users_email_active; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX uniq_users_email_active ON auth.users USING btree (lower((email)::text)) WHERE (deleted_at IS NULL);


--
-- Name: idx_comments_news_id; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_comments_news_id ON cms.comments USING btree (news_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_comments_user_id; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_comments_user_id ON cms.comments USING btree (user_id);


--
-- Name: idx_document_translations_document_id; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_document_translations_document_id ON cms.document_translations USING btree (document_id);


--
-- Name: idx_documents_public; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_documents_public ON cms.documents USING btree (is_public) WHERE (deleted_at IS NULL);


--
-- Name: idx_documents_type_created_at; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_documents_type_created_at ON cms.documents USING btree (doc_type, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_documents_uploaded_by; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_documents_uploaded_by ON cms.documents USING btree (uploaded_by);


--
-- Name: idx_news_author_id; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_news_author_id ON cms.news USING btree (author_id);


--
-- Name: idx_news_category_status_published_at; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_news_category_status_published_at ON cms.news USING btree (category, status, published_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_news_search_tsv; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_news_search_tsv ON cms.news USING gin (search_tsv);


--
-- Name: idx_news_status_published_at; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_news_status_published_at ON cms.news USING btree (status, published_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_news_translations_news_id; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_news_translations_news_id ON cms.news_translations USING btree (news_id);


--
-- Name: idx_news_translations_search_tsv; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_news_translations_search_tsv ON cms.news_translations USING gin (search_tsv);


--
-- Name: idx_pdf_map_translations_pdf_map_id; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_pdf_map_translations_pdf_map_id ON cms.pdf_map_translations USING btree (pdf_map_id);


--
-- Name: idx_pdf_maps_public; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_pdf_maps_public ON cms.pdf_maps USING btree (is_public) WHERE (deleted_at IS NULL);


--
-- Name: idx_pdf_maps_theme_year; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_pdf_maps_theme_year ON cms.pdf_maps USING btree (theme_code, year DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_pdf_maps_uploaded_by; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_pdf_maps_uploaded_by ON cms.pdf_maps USING btree (uploaded_by);


--
-- Name: idx_pdf_maps_year; Type: INDEX; Schema: cms; Owner: -
--

CREATE INDEX idx_pdf_maps_year ON cms.pdf_maps USING btree (year DESC) WHERE (deleted_at IS NULL);


--
-- Name: uniq_news_slug_active; Type: INDEX; Schema: cms; Owner: -
--

CREATE UNIQUE INDEX uniq_news_slug_active ON cms.news USING btree (slug) WHERE (deleted_at IS NULL);


--
-- Name: uniq_news_translation_slug_lang; Type: INDEX; Schema: cms; Owner: -
--

CREATE UNIQUE INDEX uniq_news_translation_slug_lang ON cms.news_translations USING btree (slug, lang);


--
-- Name: idx_core_notifications_deleted_at; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_core_notifications_deleted_at ON core.notifications USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_device_tokens_user; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_device_tokens_user ON core.device_tokens USING btree (user_id) WHERE (is_active = true);


--
-- Name: idx_notification_reads_user; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_notification_reads_user ON core.notification_reads USING btree (user_id);


--
-- Name: idx_notifications_broadcast_created; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_notifications_broadcast_created ON core.notifications USING btree (audience, created_at DESC) WHERE (user_id IS NULL);


--
-- Name: idx_notifications_channel; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_notifications_channel ON core.notifications USING btree (channel, created_at DESC);


--
-- Name: idx_notifications_expires; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_notifications_expires ON core.notifications USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_notifications_user_created; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_notifications_user_created ON core.notifications USING btree (user_id, created_at DESC) WHERE (user_id IS NOT NULL);


--
-- Name: uniq_device_token; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX uniq_device_token ON core.device_tokens USING btree (token);


--
-- Name: idx_feedback_anonymous_id; Type: INDEX; Schema: field; Owner: -
--

CREATE INDEX idx_feedback_anonymous_id ON field.feedback USING btree (anonymous_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_feedback_category; Type: INDEX; Schema: field; Owner: -
--

CREATE INDEX idx_feedback_category ON field.feedback USING btree (category) WHERE (deleted_at IS NULL);


--
-- Name: idx_feedback_created_at; Type: INDEX; Schema: field; Owner: -
--

CREATE INDEX idx_feedback_created_at ON field.feedback USING btree (created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_feedback_geom; Type: INDEX; Schema: field; Owner: -
--

CREATE INDEX idx_feedback_geom ON field.feedback USING gist (geom);


--
-- Name: idx_feedback_status; Type: INDEX; Schema: field; Owner: -
--

CREATE INDEX idx_feedback_status ON field.feedback USING btree (status) WHERE (deleted_at IS NULL);


--
-- Name: idx_feedback_status_log_feedback_id; Type: INDEX; Schema: field; Owner: -
--

CREATE INDEX idx_feedback_status_log_feedback_id ON field.feedback_status_log USING btree (feedback_id, changed_at DESC);


--
-- Name: idx_feedback_user_id; Type: INDEX; Schema: field; Owner: -
--

CREATE INDEX idx_feedback_user_id ON field.feedback USING btree (user_id) WHERE (deleted_at IS NULL);


--
-- Name: uniq_feedback_anon_client_uuid; Type: INDEX; Schema: field; Owner: -
--

CREATE UNIQUE INDEX uniq_feedback_anon_client_uuid ON field.feedback USING btree (anonymous_id, client_uuid) WHERE ((anonymous_id IS NOT NULL) AND (client_uuid IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: uniq_feedback_user_client_uuid; Type: INDEX; Schema: field; Owner: -
--

CREATE UNIQUE INDEX uniq_feedback_user_client_uuid ON field.feedback USING btree (user_id, client_uuid) WHERE ((user_id IS NOT NULL) AND (client_uuid IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_fire_district_exports_pending; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_district_exports_pending ON fire.fire_risk_district_exports USING btree (created_at) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'computing'::character varying])::text[]));


--
-- Name: idx_fire_district_exports_snap; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_district_exports_snap ON fire.fire_risk_district_exports USING btree (snapshot_id);


--
-- Name: idx_fire_district_exports_status; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_district_exports_status ON fire.fire_risk_district_exports USING btree (status, created_at DESC);


--
-- Name: idx_fire_gt_points_geom_gist; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_gt_points_geom_gist ON fire.fire_gt_points USING gist (geom);


--
-- Name: idx_fire_gt_points_occurred; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_gt_points_occurred ON fire.fire_gt_points USING btree (occurred_at DESC) WHERE (is_active = true);


--
-- Name: idx_fire_gt_points_severity; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_gt_points_severity ON fire.fire_gt_points USING btree (severity) WHERE (is_active = true);


--
-- Name: idx_fire_gt_zones_geom_gist; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_gt_zones_geom_gist ON fire.fire_gt_zones USING gist (geom);


--
-- Name: idx_fire_gt_zones_occurred; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_gt_zones_occurred ON fire.fire_gt_zones USING btree (occurred_at DESC) WHERE (is_active = true);


--
-- Name: idx_fire_gt_zones_severity; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_gt_zones_severity ON fire.fire_gt_zones USING btree (severity) WHERE (is_active = true);


--
-- Name: idx_fire_risk_features_district; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_risk_features_district ON fire.fire_risk_features USING btree (district_code);


--
-- Name: idx_fire_risk_features_geom; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_risk_features_geom ON fire.fire_risk_features USING gist (geom) WHERE (geom IS NOT NULL);


--
-- Name: idx_fire_risk_features_level; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_risk_features_level ON fire.fire_risk_features USING btree (risk_level);


--
-- Name: idx_fire_risk_features_snapshot; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_risk_features_snapshot ON fire.fire_risk_features USING btree (snapshot_id);


--
-- Name: idx_fire_risk_snapshots_date; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_risk_snapshots_date ON fire.fire_risk_snapshots USING btree (analysis_date DESC);


--
-- Name: idx_fire_risk_snapshots_retry_due; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_risk_snapshots_retry_due ON fire.fire_risk_snapshots USING btree (next_retry_at) WHERE (((status)::text = 'failed'::text) AND (next_retry_at IS NOT NULL));


--
-- Name: idx_fire_risk_snapshots_status; Type: INDEX; Schema: fire; Owner: -
--

CREATE INDEX idx_fire_risk_snapshots_status ON fire.fire_risk_snapshots USING btree (status, created_at DESC);


--
-- Name: uniq_fire_risk_analysis_date_attempt; Type: INDEX; Schema: fire; Owner: -
--

CREATE UNIQUE INDEX uniq_fire_risk_analysis_date_attempt ON fire.fire_risk_snapshots USING btree (analysis_date, attempt);


--
-- Name: idx_fc_district_areas_dist; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_fc_district_areas_dist ON forest.forest_district_areas USING btree (district_code, class_id);


--
-- Name: idx_fc_district_areas_snap; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_fc_district_areas_snap ON forest.forest_district_areas USING btree (snapshot_id);


--
-- Name: idx_fc_snapshots_requested_by; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_fc_snapshots_requested_by ON forest.forest_snapshots USING btree (requested_by) WHERE (requested_by IS NOT NULL);


--
-- Name: idx_fc_snapshots_status; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_fc_snapshots_status ON forest.forest_snapshots USING btree (status);


--
-- Name: idx_fc_snapshots_trigger; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_fc_snapshots_trigger ON forest.forest_snapshots USING btree (trigger);


--
-- Name: idx_fc_snapshots_ym; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_fc_snapshots_ym ON forest.forest_snapshots USING btree (year DESC, month DESC);


--
-- Name: idx_forest_district_exports_pending; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_district_exports_pending ON forest.forest_district_exports USING btree (created_at) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'computing'::character varying])::text[]));


--
-- Name: idx_forest_district_exports_snap; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_district_exports_snap ON forest.forest_district_exports USING btree (snapshot_id);


--
-- Name: idx_forest_district_exports_status; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_district_exports_status ON forest.forest_district_exports USING btree (status, created_at DESC);


--
-- Name: idx_forest_gt_points_class; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_gt_points_class ON forest.forest_gt_points USING btree (class_id) WHERE (is_active = true);


--
-- Name: idx_forest_gt_points_geom_gist; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_gt_points_geom_gist ON forest.forest_gt_points USING gist (geom);


--
-- Name: idx_forest_gt_points_observed; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_gt_points_observed ON forest.forest_gt_points USING btree (observed_at DESC) WHERE (is_active = true);


--
-- Name: idx_forest_gt_zones_class; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_gt_zones_class ON forest.forest_gt_zones USING btree (class_id) WHERE (is_active = true);


--
-- Name: idx_forest_gt_zones_geom_gist; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_gt_zones_geom_gist ON forest.forest_gt_zones USING gist (geom);


--
-- Name: idx_forest_gt_zones_observed; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_gt_zones_observed ON forest.forest_gt_zones USING btree (observed_at DESC) WHERE (is_active = true);


--
-- Name: idx_forest_snapshots_retry_due; Type: INDEX; Schema: forest; Owner: -
--

CREATE INDEX idx_forest_snapshots_retry_due ON forest.forest_snapshots USING btree (next_retry_at) WHERE (((status)::text = 'failed'::text) AND (next_retry_at IS NOT NULL));


--
-- Name: uniq_forest_snapshots_year_month_attempt; Type: INDEX; Schema: forest; Owner: -
--

CREATE UNIQUE INDEX uniq_forest_snapshots_year_month_attempt ON forest.forest_snapshots USING btree (year, month, attempt);


--
-- Name: idx_field_measurement_photos_measurement; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_field_measurement_photos_measurement ON gis.field_measurement_photos USING btree (measurement_id);


--
-- Name: idx_field_measurements_area; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_field_measurements_area ON gis.field_measurements USING btree (area_id, finished_at DESC);


--
-- Name: idx_field_measurements_commune; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_field_measurements_commune ON gis.field_measurements USING btree (commune_code);


--
-- Name: idx_field_measurements_geom; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_field_measurements_geom ON gis.field_measurements USING gist (geom);


--
-- Name: idx_field_measurements_measured_by; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_field_measurements_measured_by ON gis.field_measurements USING btree (measured_by, created_at DESC);


--
-- Name: idx_field_measurements_status; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_field_measurements_status ON gis.field_measurements USING btree (status, created_at DESC);


--
-- Name: idx_gis_field_measurements_deleted_at; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_gis_field_measurements_deleted_at ON gis.field_measurements USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_gis_layer_registry_deleted_at; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_gis_layer_registry_deleted_at ON gis.layer_registry USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_gis_map_apis_deleted_at; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_gis_map_apis_deleted_at ON gis.map_apis USING btree (deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: idx_layer_import_jobs_layer_id; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_import_jobs_layer_id ON gis.layer_import_jobs USING btree (layer_id, created_at DESC);


--
-- Name: idx_layer_import_jobs_status; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_import_jobs_status ON gis.layer_import_jobs USING btree (status, created_at DESC);


--
-- Name: idx_layer_registry_active_public; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_active_public ON gis.layer_registry USING btree (is_active, is_public, sort_order);


--
-- Name: idx_layer_registry_bbox_gist; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_bbox_gist ON gis.layer_registry USING gist (bbox) WHERE (bbox IS NOT NULL);


--
-- Name: idx_layer_registry_category; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_category ON gis.layer_registry USING btree (category, sort_order);


--
-- Name: idx_layer_registry_code; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_code ON gis.layer_registry USING btree (code);


--
-- Name: idx_layer_registry_data_year; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_data_year ON gis.layer_registry USING btree (data_year) WHERE (data_year IS NOT NULL);


--
-- Name: idx_layer_registry_geoserver_layer; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_geoserver_layer ON gis.layer_registry USING btree (geoserver_layer) WHERE (geoserver_layer IS NOT NULL);


--
-- Name: idx_layer_registry_layer_group; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_layer_group ON gis.layer_registry USING btree (layer_group, sort_order);


--
-- Name: idx_layer_registry_layer_kind; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_layer_kind ON gis.layer_registry USING btree (layer_kind, sort_order);


--
-- Name: idx_layer_registry_raster_job; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_raster_job ON gis.layer_registry USING btree (raster_ingest_job_id) WHERE (raster_ingest_job_id IS NOT NULL);


--
-- Name: idx_layer_registry_rs_image; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_rs_image ON gis.layer_registry USING btree (remote_sensing_image_id) WHERE (remote_sensing_image_id IS NOT NULL);


--
-- Name: idx_layer_registry_source_dataset; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_registry_source_dataset ON gis.layer_registry USING btree (source_dataset) WHERE (source_dataset IS NOT NULL);


--
-- Name: idx_layer_series_granules_timeline; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_series_granules_timeline ON gis.layer_series_granules USING btree (group_id, time_value, year_from, year_to);


--
-- Name: idx_layer_series_groups_visibility; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_layer_series_groups_visibility ON gis.layer_series_groups USING btree (is_active, is_public, code);


--
-- Name: idx_map_apis_active; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_map_apis_active ON gis.map_apis USING btree (is_active);


--
-- Name: idx_map_apis_key_prefix; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_map_apis_key_prefix ON gis.map_apis USING btree (key_prefix);


--
-- Name: idx_map_apis_layer_id; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_map_apis_layer_id ON gis.map_apis USING btree (layer_id);


--
-- Name: idx_monitored_areas_commune; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_monitored_areas_commune ON gis.monitored_areas USING btree (commune_code);


--
-- Name: idx_monitored_areas_geom; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_monitored_areas_geom ON gis.monitored_areas USING gist (ref_geom);


--
-- Name: idx_raster_ingest_created_by; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_raster_ingest_created_by ON gis.raster_ingest_jobs USING btree (created_by, created_at DESC) WHERE (created_by IS NOT NULL);


--
-- Name: idx_raster_ingest_layer; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_raster_ingest_layer ON gis.raster_ingest_jobs USING btree (layer_id, created_at DESC) WHERE (layer_id IS NOT NULL);


--
-- Name: idx_raster_ingest_layer_code_created; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_raster_ingest_layer_code_created ON gis.raster_ingest_jobs USING btree (layer_code, created_at DESC);


--
-- Name: idx_raster_ingest_next_retry; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_raster_ingest_next_retry ON gis.raster_ingest_jobs USING btree (next_retry_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_raster_ingest_worker_queue; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_raster_ingest_worker_queue ON gis.raster_ingest_jobs USING btree (created_at) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'downloading'::character varying, 'validating'::character varying, 'uploading'::character varying, 'publishing'::character varying])::text[]));


--
-- Name: idx_stats_cache_expires; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_stats_cache_expires ON gis.stats_cache USING btree (expires_at);


--
-- Name: idx_weather_cache_expires; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_weather_cache_expires ON gis.weather_cache USING btree (expires_at);


--
-- Name: idx_weather_cache_type; Type: INDEX; Schema: gis; Owner: -
--

CREATE INDEX idx_weather_cache_type ON gis.weather_cache USING btree (data_type);


--
-- Name: uniq_layer_registry_physical_table; Type: INDEX; Schema: gis; Owner: -
--

CREATE UNIQUE INDEX uniq_layer_registry_physical_table ON gis.layer_registry USING btree (schema_name, table_name);


--
-- Name: uniq_raster_ingest_active_source; Type: INDEX; Schema: gis; Owner: -
--

CREATE UNIQUE INDEX uniq_raster_ingest_active_source ON gis.raster_ingest_jobs USING btree (source_hash) WHERE ((status)::text <> ALL ((ARRAY['completed'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[]));


--
-- Name: uniq_weather_cache_key; Type: INDEX; Schema: gis; Owner: -
--

CREATE UNIQUE INDEX uniq_weather_cache_key ON gis.weather_cache USING btree (cache_key);


--
-- Name: uq_field_measurements_measured_by_client_uuid; Type: INDEX; Schema: gis; Owner: -
--

CREATE UNIQUE INDEX uq_field_measurements_measured_by_client_uuid ON gis.field_measurements USING btree (measured_by, client_uuid) WHERE ((client_uuid IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_rsdl_created_at; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsdl_created_at ON raster.remote_sensing_download_logs USING btree (created_at DESC);


--
-- Name: idx_rsdl_image_id; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsdl_image_id ON raster.remote_sensing_download_logs USING btree (image_id, created_at DESC);


--
-- Name: idx_rsdl_user_id; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsdl_user_id ON raster.remote_sensing_download_logs USING btree (user_id, created_at DESC) WHERE (user_id IS NOT NULL);


--
-- Name: idx_rsf_file_role; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsf_file_role ON raster.remote_sensing_files USING btree (image_id, file_role) WHERE (is_active = true);


--
-- Name: idx_rsf_image_id; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsf_image_id ON raster.remote_sensing_files USING btree (image_id);


--
-- Name: idx_rsi_acquisition_date; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsi_acquisition_date ON raster.remote_sensing_images USING btree (acquisition_date DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_rsi_bbox_gist; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsi_bbox_gist ON raster.remote_sensing_images USING gist (bbox) WHERE ((deleted_at IS NULL) AND (bbox IS NOT NULL));


--
-- Name: idx_rsi_composite_search; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsi_composite_search ON raster.remote_sensing_images USING btree (satellite, image_type, acquisition_date DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_rsi_image_type; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsi_image_type ON raster.remote_sensing_images USING btree (image_type) WHERE (deleted_at IS NULL);


--
-- Name: idx_rsi_is_public; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsi_is_public ON raster.remote_sensing_images USING btree (is_public) WHERE ((deleted_at IS NULL) AND (is_public = true));


--
-- Name: idx_rsi_province_code; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsi_province_code ON raster.remote_sensing_images USING btree (province_code) WHERE (deleted_at IS NULL);


--
-- Name: idx_rsi_satellite; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsi_satellite ON raster.remote_sensing_images USING btree (satellite) WHERE (deleted_at IS NULL);


--
-- Name: idx_rsi_status; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rsi_status ON raster.remote_sensing_images USING btree (status) WHERE (deleted_at IS NULL);


--
-- Name: idx_rspj_image_id; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rspj_image_id ON raster.remote_sensing_processing_jobs USING btree (image_id);


--
-- Name: idx_rspj_pending_priority; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rspj_pending_priority ON raster.remote_sensing_processing_jobs USING btree (priority, created_at) WHERE (status = 'pending'::raster.processing_status);


--
-- Name: idx_rspj_status; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rspj_status ON raster.remote_sensing_processing_jobs USING btree (status, updated_at DESC);


--
-- Name: idx_rss_image_id; Type: INDEX; Schema: raster; Owner: -
--

CREATE INDEX idx_rss_image_id ON raster.remote_sensing_statistics USING btree (image_id);


--
-- Name: uniq_rsf_bucket_object; Type: INDEX; Schema: raster; Owner: -
--

CREATE UNIQUE INDEX uniq_rsf_bucket_object ON raster.remote_sensing_files USING btree (bucket_name, object_key);


--
-- Name: uniq_rsi_uuid; Type: INDEX; Schema: raster; Owner: -
--

CREATE UNIQUE INDEX uniq_rsi_uuid ON raster.remote_sensing_images USING btree (uuid) WHERE (deleted_at IS NULL);


--
-- Name: uniq_rss_image_band; Type: INDEX; Schema: raster; Owner: -
--

CREATE UNIQUE INDEX uniq_rss_image_band ON raster.remote_sensing_statistics USING btree (image_id, band_index);


--
-- Name: idx_sat_results_expires; Type: INDEX; Schema: satellite; Owner: -
--

CREATE INDEX idx_sat_results_expires ON satellite.image_results USING btree (expires_at);


--
-- Name: idx_sat_results_status; Type: INDEX; Schema: satellite; Owner: -
--

CREATE INDEX idx_sat_results_status ON satellite.image_results USING btree (status);


--
-- Name: idx_sat_results_type; Type: INDEX; Schema: satellite; Owner: -
--

CREATE INDEX idx_sat_results_type ON satellite.image_results USING btree (image_type);


--
-- Name: roles trigger_roles_updated_at; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER trigger_roles_updated_at BEFORE UPDATE ON auth.roles FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: social_accounts trigger_social_accounts_updated_at; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER trigger_social_accounts_updated_at BEFORE UPDATE ON auth.social_accounts FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: users trigger_users_default_role; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER trigger_users_default_role BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION auth.set_default_user_role();


--
-- Name: users trigger_users_updated_at; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER trigger_users_updated_at BEFORE UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: comments trigger_comments_updated_at; Type: TRIGGER; Schema: cms; Owner: -
--

CREATE TRIGGER trigger_comments_updated_at BEFORE UPDATE ON cms.comments FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: document_translations trigger_document_translations_updated_at; Type: TRIGGER; Schema: cms; Owner: -
--

CREATE TRIGGER trigger_document_translations_updated_at BEFORE UPDATE ON cms.document_translations FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: documents trigger_documents_updated_at; Type: TRIGGER; Schema: cms; Owner: -
--

CREATE TRIGGER trigger_documents_updated_at BEFORE UPDATE ON cms.documents FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: news trigger_news_search_tsv; Type: TRIGGER; Schema: cms; Owner: -
--

CREATE TRIGGER trigger_news_search_tsv BEFORE INSERT OR UPDATE OF title, summary, content ON cms.news FOR EACH ROW EXECUTE FUNCTION cms.update_news_search_tsv();


--
-- Name: news_translations trigger_news_translations_search_tsv; Type: TRIGGER; Schema: cms; Owner: -
--

CREATE TRIGGER trigger_news_translations_search_tsv BEFORE INSERT OR UPDATE OF title, summary, content ON cms.news_translations FOR EACH ROW EXECUTE FUNCTION cms.update_news_translation_search_tsv();


--
-- Name: news_translations trigger_news_translations_updated_at; Type: TRIGGER; Schema: cms; Owner: -
--

CREATE TRIGGER trigger_news_translations_updated_at BEFORE UPDATE ON cms.news_translations FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: news trigger_news_updated_at; Type: TRIGGER; Schema: cms; Owner: -
--

CREATE TRIGGER trigger_news_updated_at BEFORE UPDATE ON cms.news FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: pdf_map_translations trigger_pdf_map_translations_updated_at; Type: TRIGGER; Schema: cms; Owner: -
--

CREATE TRIGGER trigger_pdf_map_translations_updated_at BEFORE UPDATE ON cms.pdf_map_translations FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: pdf_maps trigger_pdf_maps_updated_at; Type: TRIGGER; Schema: cms; Owner: -
--

CREATE TRIGGER trigger_pdf_maps_updated_at BEFORE UPDATE ON cms.pdf_maps FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: device_tokens trigger_device_tokens_updated_at; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trigger_device_tokens_updated_at BEFORE UPDATE ON core.device_tokens FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: feedback trigger_feedback_geom; Type: TRIGGER; Schema: field; Owner: -
--

CREATE TRIGGER trigger_feedback_geom BEFORE INSERT OR UPDATE OF lng, lat ON field.feedback FOR EACH ROW EXECUTE FUNCTION field.set_feedback_geom();


--
-- Name: feedback trigger_feedback_updated_at; Type: TRIGGER; Schema: field; Owner: -
--

CREATE TRIGGER trigger_feedback_updated_at BEFORE UPDATE ON field.feedback FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: fire_risk_district_exports trg_fire_district_exports_updated_at; Type: TRIGGER; Schema: fire; Owner: -
--

CREATE TRIGGER trg_fire_district_exports_updated_at BEFORE UPDATE ON fire.fire_risk_district_exports FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: fire_gt_points trg_fire_gt_points_geom; Type: TRIGGER; Schema: fire; Owner: -
--

CREATE TRIGGER trg_fire_gt_points_geom BEFORE INSERT OR UPDATE OF lng, lat ON fire.fire_gt_points FOR EACH ROW EXECUTE FUNCTION fire.compute_gt_point_geom();


--
-- Name: fire_gt_zones trg_fire_gt_zones_area; Type: TRIGGER; Schema: fire; Owner: -
--

CREATE TRIGGER trg_fire_gt_zones_area BEFORE INSERT OR UPDATE OF geom ON fire.fire_gt_zones FOR EACH ROW EXECUTE FUNCTION fire.compute_gt_zone_area();


--
-- Name: fire_risk_snapshots trg_fire_risk_snapshots_updated_at; Type: TRIGGER; Schema: fire; Owner: -
--

CREATE TRIGGER trg_fire_risk_snapshots_updated_at BEFORE UPDATE ON fire.fire_risk_snapshots FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: forest_district_exports trg_forest_district_exports_updated_at; Type: TRIGGER; Schema: forest; Owner: -
--

CREATE TRIGGER trg_forest_district_exports_updated_at BEFORE UPDATE ON forest.forest_district_exports FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: forest_gt_points trg_forest_gt_points_geom; Type: TRIGGER; Schema: forest; Owner: -
--

CREATE TRIGGER trg_forest_gt_points_geom BEFORE INSERT OR UPDATE OF lng, lat ON forest.forest_gt_points FOR EACH ROW EXECUTE FUNCTION forest.compute_gt_point_geom();


--
-- Name: forest_gt_zones trg_forest_gt_zones_area; Type: TRIGGER; Schema: forest; Owner: -
--

CREATE TRIGGER trg_forest_gt_zones_area BEFORE INSERT OR UPDATE OF geom ON forest.forest_gt_zones FOR EACH ROW EXECUTE FUNCTION forest.compute_gt_zone_area();


--
-- Name: forest_snapshots trg_forest_snapshots_updated_at; Type: TRIGGER; Schema: forest; Owner: -
--

CREATE TRIGGER trg_forest_snapshots_updated_at BEFORE UPDATE ON forest.forest_snapshots FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: field_measurements trg_field_measurements_updated_at; Type: TRIGGER; Schema: gis; Owner: -
--

CREATE TRIGGER trg_field_measurements_updated_at BEFORE UPDATE ON gis.field_measurements FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: monitored_areas trg_monitored_areas_updated_at; Type: TRIGGER; Schema: gis; Owner: -
--

CREATE TRIGGER trg_monitored_areas_updated_at BEFORE UPDATE ON gis.monitored_areas FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: raster_ingest_jobs trg_raster_ingest_completed_at; Type: TRIGGER; Schema: gis; Owner: -
--

CREATE TRIGGER trg_raster_ingest_completed_at BEFORE UPDATE ON gis.raster_ingest_jobs FOR EACH ROW EXECUTE FUNCTION gis.set_raster_ingest_completed_at();


--
-- Name: layer_registry trigger_layer_registry_updated_at; Type: TRIGGER; Schema: gis; Owner: -
--

CREATE TRIGGER trigger_layer_registry_updated_at BEFORE UPDATE ON gis.layer_registry FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: layer_series_granules trigger_layer_series_granules_updated_at; Type: TRIGGER; Schema: gis; Owner: -
--

CREATE TRIGGER trigger_layer_series_granules_updated_at BEFORE UPDATE ON gis.layer_series_granules FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: layer_series_groups trigger_layer_series_groups_updated_at; Type: TRIGGER; Schema: gis; Owner: -
--

CREATE TRIGGER trigger_layer_series_groups_updated_at BEFORE UPDATE ON gis.layer_series_groups FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: map_apis trigger_map_apis_updated_at; Type: TRIGGER; Schema: gis; Owner: -
--

CREATE TRIGGER trigger_map_apis_updated_at BEFORE UPDATE ON gis.map_apis FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: remote_sensing_files trigger_rsf_updated_at; Type: TRIGGER; Schema: raster; Owner: -
--

CREATE TRIGGER trigger_rsf_updated_at BEFORE UPDATE ON raster.remote_sensing_files FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: remote_sensing_images trigger_rsi_updated_at; Type: TRIGGER; Schema: raster; Owner: -
--

CREATE TRIGGER trigger_rsi_updated_at BEFORE UPDATE ON raster.remote_sensing_images FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: remote_sensing_processing_jobs trigger_rspj_updated_at; Type: TRIGGER; Schema: raster; Owner: -
--

CREATE TRIGGER trigger_rspj_updated_at BEFORE UPDATE ON raster.remote_sensing_processing_jobs FOR EACH ROW EXECUTE FUNCTION core.update_updated_at_column();


--
-- Name: activity_logs activity_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.activity_logs
    ADD CONSTRAINT activity_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: email_verification_tokens email_verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_exchange_codes oauth_exchange_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_exchange_codes
    ADD CONSTRAINT oauth_exchange_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: social_accounts social_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.social_accounts
    ADD CONSTRAINT social_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: users users_role_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id) REFERENCES auth.roles(id) ON UPDATE CASCADE;


--
-- Name: comments comments_news_id_fkey; Type: FK CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.comments
    ADD CONSTRAINT comments_news_id_fkey FOREIGN KEY (news_id) REFERENCES cms.news(id) ON DELETE CASCADE;


--
-- Name: comments comments_user_id_fkey; Type: FK CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.comments
    ADD CONSTRAINT comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: document_translations document_translations_document_id_fkey; Type: FK CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.document_translations
    ADD CONSTRAINT document_translations_document_id_fkey FOREIGN KEY (document_id) REFERENCES cms.documents(id) ON DELETE CASCADE;


--
-- Name: documents documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.documents
    ADD CONSTRAINT documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: news news_author_id_fkey; Type: FK CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.news
    ADD CONSTRAINT news_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: news_translations news_translations_news_id_fkey; Type: FK CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.news_translations
    ADD CONSTRAINT news_translations_news_id_fkey FOREIGN KEY (news_id) REFERENCES cms.news(id) ON DELETE CASCADE;


--
-- Name: pdf_map_translations pdf_map_translations_pdf_map_id_fkey; Type: FK CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.pdf_map_translations
    ADD CONSTRAINT pdf_map_translations_pdf_map_id_fkey FOREIGN KEY (pdf_map_id) REFERENCES cms.pdf_maps(id) ON DELETE CASCADE;


--
-- Name: pdf_maps pdf_maps_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: cms; Owner: -
--

ALTER TABLE ONLY cms.pdf_maps
    ADD CONSTRAINT pdf_maps_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: device_tokens device_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.device_tokens
    ADD CONSTRAINT device_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_notification_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.notification_reads
    ADD CONSTRAINT notification_reads_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES core.notifications(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.notification_reads
    ADD CONSTRAINT notification_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: feedback feedback_created_by_fkey; Type: FK CONSTRAINT; Schema: field; Owner: -
--

ALTER TABLE ONLY field.feedback
    ADD CONSTRAINT feedback_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: feedback_status_log feedback_status_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: field; Owner: -
--

ALTER TABLE ONLY field.feedback_status_log
    ADD CONSTRAINT feedback_status_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: feedback_status_log feedback_status_log_feedback_id_fkey; Type: FK CONSTRAINT; Schema: field; Owner: -
--

ALTER TABLE ONLY field.feedback_status_log
    ADD CONSTRAINT feedback_status_log_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES field.feedback(id) ON DELETE CASCADE;


--
-- Name: feedback feedback_updated_by_fkey; Type: FK CONSTRAINT; Schema: field; Owner: -
--

ALTER TABLE ONLY field.feedback
    ADD CONSTRAINT feedback_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: feedback feedback_user_id_fkey; Type: FK CONSTRAINT; Schema: field; Owner: -
--

ALTER TABLE ONLY field.feedback
    ADD CONSTRAINT feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: fire_gt_points fire_gt_points_created_by_fkey; Type: FK CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_gt_points
    ADD CONSTRAINT fire_gt_points_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: fire_gt_zones fire_gt_zones_created_by_fkey; Type: FK CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_gt_zones
    ADD CONSTRAINT fire_gt_zones_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: fire_risk_district_exports fire_risk_district_exports_raster_ingest_job_id_fkey; Type: FK CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_district_exports
    ADD CONSTRAINT fire_risk_district_exports_raster_ingest_job_id_fkey FOREIGN KEY (raster_ingest_job_id) REFERENCES gis.raster_ingest_jobs(id) ON DELETE SET NULL;


--
-- Name: fire_risk_district_exports fire_risk_district_exports_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_district_exports
    ADD CONSTRAINT fire_risk_district_exports_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES fire.fire_risk_snapshots(id) ON DELETE CASCADE;


--
-- Name: fire_risk_features fire_risk_features_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: fire; Owner: -
--

ALTER TABLE ONLY fire.fire_risk_features
    ADD CONSTRAINT fire_risk_features_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES fire.fire_risk_snapshots(id) ON DELETE CASCADE;


--
-- Name: forest_district_areas forest_district_areas_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_district_areas
    ADD CONSTRAINT forest_district_areas_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES forest.forest_snapshots(id) ON DELETE CASCADE;


--
-- Name: forest_district_exports forest_district_exports_raster_ingest_job_id_fkey; Type: FK CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_district_exports
    ADD CONSTRAINT forest_district_exports_raster_ingest_job_id_fkey FOREIGN KEY (raster_ingest_job_id) REFERENCES gis.raster_ingest_jobs(id) ON DELETE SET NULL;


--
-- Name: forest_district_exports forest_district_exports_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_district_exports
    ADD CONSTRAINT forest_district_exports_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES forest.forest_snapshots(id) ON DELETE CASCADE;


--
-- Name: forest_gt_points forest_gt_points_created_by_fkey; Type: FK CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_gt_points
    ADD CONSTRAINT forest_gt_points_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: forest_gt_zones forest_gt_zones_created_by_fkey; Type: FK CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_gt_zones
    ADD CONSTRAINT forest_gt_zones_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: forest_snapshots forest_snapshots_requested_by_fkey; Type: FK CONSTRAINT; Schema: forest; Owner: -
--

ALTER TABLE ONLY forest.forest_snapshots
    ADD CONSTRAINT forest_snapshots_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: field_measurement_photos field_measurement_photos_measurement_id_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurement_photos
    ADD CONSTRAINT field_measurement_photos_measurement_id_fkey FOREIGN KEY (measurement_id) REFERENCES gis.field_measurements(id) ON DELETE CASCADE;


--
-- Name: field_measurement_photos field_measurement_photos_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurement_photos
    ADD CONSTRAINT field_measurement_photos_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: field_measurements field_measurements_area_id_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurements
    ADD CONSTRAINT field_measurements_area_id_fkey FOREIGN KEY (area_id) REFERENCES gis.monitored_areas(id) ON DELETE SET NULL;


--
-- Name: field_measurements field_measurements_layer_id_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurements
    ADD CONSTRAINT field_measurements_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES gis.layer_registry(id) ON DELETE SET NULL;


--
-- Name: field_measurements field_measurements_measured_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurements
    ADD CONSTRAINT field_measurements_measured_by_fkey FOREIGN KEY (measured_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: field_measurements field_measurements_verified_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.field_measurements
    ADD CONSTRAINT field_measurements_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: layer_import_jobs layer_import_jobs_created_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_import_jobs
    ADD CONSTRAINT layer_import_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: layer_import_jobs layer_import_jobs_layer_id_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_import_jobs
    ADD CONSTRAINT layer_import_jobs_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES gis.layer_registry(id) ON DELETE CASCADE;


--
-- Name: layer_registry layer_registry_created_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_registry
    ADD CONSTRAINT layer_registry_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: layer_registry layer_registry_raster_ingest_job_id_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_registry
    ADD CONSTRAINT layer_registry_raster_ingest_job_id_fkey FOREIGN KEY (raster_ingest_job_id) REFERENCES gis.raster_ingest_jobs(id) ON DELETE SET NULL;


--
-- Name: layer_registry layer_registry_remote_sensing_image_id_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_registry
    ADD CONSTRAINT layer_registry_remote_sensing_image_id_fkey FOREIGN KEY (remote_sensing_image_id) REFERENCES raster.remote_sensing_images(id) ON DELETE SET NULL;


--
-- Name: layer_registry layer_registry_updated_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_registry
    ADD CONSTRAINT layer_registry_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: layer_series_granules layer_series_granules_created_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_granules
    ADD CONSTRAINT layer_series_granules_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: layer_series_granules layer_series_granules_group_id_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.layer_series_granules
    ADD CONSTRAINT layer_series_granules_group_id_fkey FOREIGN KEY (group_id) REFERENCES gis.layer_series_groups(id) ON DELETE CASCADE;


--
-- Name: map_apis map_apis_created_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.map_apis
    ADD CONSTRAINT map_apis_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: map_apis map_apis_layer_id_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.map_apis
    ADD CONSTRAINT map_apis_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES gis.layer_registry(id) ON DELETE CASCADE;


--
-- Name: monitored_areas monitored_areas_created_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.monitored_areas
    ADD CONSTRAINT monitored_areas_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: raster_ingest_jobs raster_ingest_jobs_created_by_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.raster_ingest_jobs
    ADD CONSTRAINT raster_ingest_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: raster_ingest_jobs raster_ingest_jobs_layer_id_fkey; Type: FK CONSTRAINT; Schema: gis; Owner: -
--

ALTER TABLE ONLY gis.raster_ingest_jobs
    ADD CONSTRAINT raster_ingest_jobs_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES gis.layer_registry(id) ON DELETE SET NULL;


--
-- Name: remote_sensing_download_logs remote_sensing_download_logs_file_id_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_download_logs
    ADD CONSTRAINT remote_sensing_download_logs_file_id_fkey FOREIGN KEY (file_id) REFERENCES raster.remote_sensing_files(id) ON DELETE SET NULL;


--
-- Name: remote_sensing_download_logs remote_sensing_download_logs_image_id_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_download_logs
    ADD CONSTRAINT remote_sensing_download_logs_image_id_fkey FOREIGN KEY (image_id) REFERENCES raster.remote_sensing_images(id) ON DELETE CASCADE;


--
-- Name: remote_sensing_download_logs remote_sensing_download_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_download_logs
    ADD CONSTRAINT remote_sensing_download_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: remote_sensing_files remote_sensing_files_image_id_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_files
    ADD CONSTRAINT remote_sensing_files_image_id_fkey FOREIGN KEY (image_id) REFERENCES raster.remote_sensing_images(id) ON DELETE CASCADE;


--
-- Name: remote_sensing_files remote_sensing_files_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_files
    ADD CONSTRAINT remote_sensing_files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: remote_sensing_images remote_sensing_images_created_by_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_images
    ADD CONSTRAINT remote_sensing_images_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: remote_sensing_images remote_sensing_images_deleted_by_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_images
    ADD CONSTRAINT remote_sensing_images_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: remote_sensing_images remote_sensing_images_updated_by_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_images
    ADD CONSTRAINT remote_sensing_images_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: remote_sensing_processing_jobs remote_sensing_processing_jobs_file_id_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_processing_jobs
    ADD CONSTRAINT remote_sensing_processing_jobs_file_id_fkey FOREIGN KEY (file_id) REFERENCES raster.remote_sensing_files(id) ON DELETE SET NULL;


--
-- Name: remote_sensing_processing_jobs remote_sensing_processing_jobs_image_id_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_processing_jobs
    ADD CONSTRAINT remote_sensing_processing_jobs_image_id_fkey FOREIGN KEY (image_id) REFERENCES raster.remote_sensing_images(id) ON DELETE CASCADE;


--
-- Name: remote_sensing_statistics remote_sensing_statistics_file_id_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_statistics
    ADD CONSTRAINT remote_sensing_statistics_file_id_fkey FOREIGN KEY (file_id) REFERENCES raster.remote_sensing_files(id) ON DELETE SET NULL;


--
-- Name: remote_sensing_statistics remote_sensing_statistics_image_id_fkey; Type: FK CONSTRAINT; Schema: raster; Owner: -
--

ALTER TABLE ONLY raster.remote_sensing_statistics
    ADD CONSTRAINT remote_sensing_statistics_image_id_fkey FOREIGN KEY (image_id) REFERENCES raster.remote_sensing_images(id) ON DELETE CASCADE;


--

-- ============================================================================
-- APPENDIX — 2 bảng bị xoá ngoài ý muốn khỏi DB gốc trước khi dump (không phải
-- do pg_dump bỏ sót): gis.administrative_units, gis.layer_edit_history.
-- Tái tạo lại nguyên trạng từ migration 008, 013, 017.
--
-- KHÔNG tái tạo gis.landcover_statistics — bảng này đã bị DROP có chủ đích từ
-- migration 041_dashboard_uses_forest_snapshots.sql (dashboard + /statistics
-- chuyển hẳn sang forest.forest_snapshots/forest_district_areas), xác nhận lại
-- với người dùng ngày 2026-07-28: không dùng nữa, không đưa vào baseline.
-- ============================================================================

-- ── gis.administrative_units (từ migration 017_statistics.sql) ───────────────
CREATE TABLE IF NOT EXISTS gis.administrative_units (
    code            VARCHAR(10) PRIMARY KEY,
    name_vi         VARCHAR(120) NOT NULL,
    name_en         VARCHAR(120),
    level           VARCHAR(20)  NOT NULL DEFAULT 'district'
                    CHECK (level IN ('province', 'district', 'commune')),
    parent_code     VARCHAR(10),
    area_km2        NUMERIC(12, 2),
    population      INTEGER,
    centroid_lng    DOUBLE PRECISION,
    centroid_lat    DOUBLE PRECISION,
    geom            public.geometry(MultiPolygon,4326),
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_units_parent ON gis.administrative_units (parent_code);
CREATE INDEX IF NOT EXISTS idx_admin_units_level  ON gis.administrative_units (level, sort_order);
CREATE INDEX IF NOT EXISTS idx_admin_units_geom   ON gis.administrative_units USING GIST (geom) WHERE geom IS NOT NULL;

-- ── gis.layer_edit_history (từ migration 008 + ALTER của migration 013) ──────
CREATE TABLE IF NOT EXISTS gis.layer_edit_history (
    id                  BIGSERIAL PRIMARY KEY,
    layer_id            INT REFERENCES gis.layer_registry(id) ON DELETE SET NULL,
    operation_id        UUID NOT NULL DEFAULT gen_random_uuid(),
    source              VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','api','system')),
    import_job_id       BIGINT REFERENCES gis.layer_import_jobs(id) ON DELETE SET NULL,
    feature_id          BIGINT,
    action              VARCHAR(20) NOT NULL CHECK (action IN ('create','update','delete','bulk_import','publish','unpublish','toggle_active')),
    old_data            JSONB,
    new_data            JSONB,
    geometry_changed    BOOLEAN DEFAULT false,
    old_bbox            public.geometry(Polygon,4326),
    new_bbox            public.geometry(Polygon,4326),
    changed_by          BIGINT REFERENCES auth.users(id) ON DELETE SET NULL,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_layer_edit_history_layer_id ON gis.layer_edit_history (layer_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_layer_edit_history_operation_id ON gis.layer_edit_history (operation_id);
CREATE INDEX IF NOT EXISTS idx_layer_edit_history_import_job_id ON gis.layer_edit_history (import_job_id) WHERE import_job_id IS NOT NULL;


-- ============================================================================
-- SEED DATA — dữ liệu nền bắt buộc để app chạy được trên DB mới (vai trò +
-- quyền hạn RBAC, số liệu hành chính/rừng thực tế tỉnh Kon Tum, nhóm layer
-- time-series). Không bao gồm dữ liệu nghiệp vụ phát sinh (users thật, tin
-- tức, phiên đo đạc, ảnh viễn thám đã upload...).
-- ============================================================================

-- ── auth.roles: 4 vai trò + permissions hiện hành (đã merge qua nhiều migration) ──
INSERT INTO auth.roles (code, name_vi, name_en, description_vi, description_en, sort_order, permissions) VALUES
('system_admin', 'Quản trị hệ thống', 'System Administrator',
 'Toàn quyền hệ thống — quản lý user, cấu hình hệ thống, quản lý trạm đo, vùng giám sát, dữ liệu môi trường, cảnh báo, báo cáo. Có thể xem/sửa/xóa tất cả dữ liệu trong hệ thống.',
 'Full system access — manage users, system configuration, monitoring stations, zones, environmental data, alerts, and reports. Can view/edit/delete all data in the system.',
 1, '{"news":{"read":true,"create":true,"delete":true,"update":true,"publish":true},"roles":{"read":true,"manage":true,"update":true},"users":{"read":true,"create":true,"delete":true,"update":true,"read_own":true,"update_own":true,"change_role":true,"change_status":true,"reset_password":true},"comments":{"read":true,"create":true,"delete":true,"approve":true,"delete_own":true},"documents":{"read":true,"create":true,"delete":true,"update":true,"publish":true},"device_tokens":{"read":true,"delete":true,"read_own":true,"create_own":true,"delete_own":true},"notifications":{"read":true,"send":true,"create":true,"delete":true,"update":true,"read_own":true,"delete_own":true},"news_translations":{"read":true,"create":true,"delete":true,"update":true},"notification_reads":{"create":true,"read_own":true,"update_own":true},"document_translations":{"read":true,"create":true,"delete":true,"update":true}}'::jsonb),
('ubnd_tinh', 'UBND tỉnh', 'Provincial People''s Committee',
 'Ủy ban Nhân dân tỉnh Kon Tum — xem dashboard tổng quan, theo dõi tình hình môi trường toàn tỉnh, xem cảnh báo, xuất báo cáo tổng hợp, phê duyệt kế hoạch ứng phó.',
 'Kon Tum Provincial People''s Committee — view overview dashboard, monitor province-wide environmental status, view alerts, export summary reports, approve response plans.',
 2, '{"news":{"read":true},"users":{"read":true},"comments":{"read":true},"documents":{"read":true},"device_tokens":{"read_own":true,"create_own":true,"delete_own":true},"notifications":{"read_own":true,"delete_own":true},"notification_reads":{"create":true,"read_own":true,"update_own":true}}'::jsonb),
('so_nnmt', 'Sở Nông nghiệp & Môi trường', 'Provincial Department of Agriculture & Environment',
 'Sở Nông nghiệp và Môi trường tỉnh Kon Tum — nhập dữ liệu môi trường thủ công, quản lý trạm đo/sensor IoT, quản lý vùng giám sát, xử lý và phản hồi cảnh báo, tạo báo cáo chuyên ngành, upload media.',
 'Kon Tum Provincial Department of Agriculture & Environment — manually input environmental data, manage monitoring stations/IoT sensors, manage monitoring zones, handle and respond to alerts, create specialized reports, upload media.',
 3, '{"news":{"read":true,"create":true,"publish":true},"users":{"read":true,"create":true,"delete":true,"update":true,"change_status":true,"reset_password":true},"comments":{"read":true},"documents":{"read":true,"create":true,"delete":true,"update":true,"publish":true},"device_tokens":{"read_own":true,"create_own":true,"delete_own":true},"notifications":{"send":true,"read_own":true,"delete_own":true},"news_translations":{"read":true,"create":true},"notification_reads":{"create":true,"read_own":true,"update_own":true},"document_translations":{"read":true,"create":true,"delete":true,"update":true}}'::jsonb),
('citizen', 'Người dân', 'Citizens/Public',
 'Người dân tỉnh Kon Tum — xem bản đồ môi trường, xem chỉ số chất lượng không khí/nước, nhận cảnh báo công khai (cháy rừng, ô nhiễm), xem báo cáo tổng hợp đã công bố.',
 'Kon Tum citizens — view environmental maps, air/water quality indices, receive public alerts (forest fires, pollution), view published summary reports.',
 4, '{"news":{"read":true},"users":{"read_own":true,"update_own":true},"comments":{"read":true,"create":true,"delete_own":true},"documents":{"read":true},"device_tokens":{"read_own":true,"create_own":true,"delete_own":true},"notifications":{"read_own":true,"delete_own":true},"notification_reads":{"create":true,"read_own":true,"update_own":true}}'::jsonb)
ON CONFLICT (code) DO UPDATE SET
    name_vi = EXCLUDED.name_vi, name_en = EXCLUDED.name_en,
    description_vi = EXCLUDED.description_vi, description_en = EXCLUDED.description_en,
    sort_order = EXCLUDED.sort_order, permissions = EXCLUDED.permissions;

-- NOTE: permissions ở trên là bản chụp hiện hành, ĐÃ THIẾU các quyền map_layers/
-- remote_sensing/fire_risk/forest_classification/statistics/spatial/weather/
-- feedback/map_apis/pdf_maps/satellite/map_proxy so với những gì token JWT thực
-- tế trả về khi đăng nhập admin — có nghĩa là các quyền đó được cấp qua đường
-- khác (code merge thêm ở tầng auth, không nằm trong cột permissions của DB).
-- Nếu dùng file này dựng DB mới, hãy đăng nhập thử bằng admin@kontum.gov.vn và
-- so sánh JWT permissions với danh sách trên trước khi coi RBAC đã đầy đủ.

-- ── gis.administrative_units: số liệu hành chính thực tỉnh Kon Tum (migration 017) ──
INSERT INTO gis.administrative_units (code, name_vi, name_en, level, parent_code, area_km2, population, sort_order) VALUES
    ('62',  'Tỉnh Kon Tum',         'Kon Tum Province',  'province', NULL, 9677.30, 591217, 0),
    ('608', 'Thành phố Kon Tum',    'Kon Tum City',      'district', '62',  433.00, 168264, 1),
    ('610', 'Huyện Đăk Glei',       'Dak Glei',          'district', '62', 1495.00,  48761, 2),
    ('611', 'Huyện Ngọc Hồi',       'Ngoc Hoi',          'district', '62',  824.00,  58913, 3),
    ('612', 'Huyện Đăk Tô',         'Dak To',            'district', '62',  511.00,  47544, 4),
    ('613', 'Huyện Kon Plông',      'Kon Plong',         'district', '62', 1371.00,  26025, 5),
    ('614', 'Huyện Kon Rẫy',        'Kon Ray',           'district', '62',  886.00,  28591, 6),
    ('615', 'Huyện Đăk Hà',         'Dak Ha',            'district', '62',  845.00,  74805, 7),
    ('616', 'Huyện Sa Thầy',        'Sa Thay',           'district', '62', 1435.00,  49914, 8),
    ('617', 'Huyện Tu Mơ Rông',     'Tu Mo Rong',        'district', '62',  857.00,  27411, 9),
    ('618', 'Huyện Ia H''Drai',     'Ia H''Drai',        'district', '62',  980.00,  10210, 10)
ON CONFLICT (code) DO UPDATE SET
    name_vi = EXCLUDED.name_vi, name_en = EXCLUDED.name_en,
    area_km2 = EXCLUDED.area_km2, population = EXCLUDED.population,
    sort_order = EXCLUDED.sort_order, updated_at = NOW();

-- ── gis.layer_series_groups: 4 nhóm layer time-series (migration 045, đã có sẵn trong dump nếu bảng còn tồn tại — chèn lại phòng khi dựng DB mới) ──
INSERT INTO gis.layer_series_groups (code, name_vi, name_en, geoserver_store, geoserver_layer, geoserver_style) VALUES
    ('lop_phu', 'Lớp phủ', 'Land cover', 'lop_phu', 'kontum:lop_phu', NULL),
    ('nhiet_do_be_mat', 'Nhiệt độ bề mặt', 'Land surface temperature', 'nhiet_do_be_mat', 'kontum:nhiet_do_be_mat', NULL),
    ('bien_dong_lop_phu', 'Biến động lớp phủ', 'Land-cover change', 'bien_dong_lop_phu', 'kontum:bien_dong_lop_phu', NULL),
    ('dien_bien_nhiet_do', 'Diễn biến nhiệt độ', 'Temperature change', 'dien_bien_nhiet_do', 'kontum:dien_bien_nhiet_do', NULL)
ON CONFLICT (code) DO NOTHING;
