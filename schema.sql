--
-- PostgreSQL database dump
--

-- Dumped from database version 16.11 (Ubuntu 16.11-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.8

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

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_action_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_action_logs (
    id bigint NOT NULL,
    admin_id integer NOT NULL,
    target_user_id integer,
    action_type text NOT NULL,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_action_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_action_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_action_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_action_logs_id_seq OWNED BY public.admin_action_logs.id;


--
-- Name: ai_chat_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_chat_logs (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    is_new_for_admin boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_offtopic_suspected boolean DEFAULT false NOT NULL,
    is_offtopic_confirmed boolean,
    off_topic_comment text
);


--
-- Name: ai_chat_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_chat_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_chat_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_chat_logs_id_seq OWNED BY public.ai_chat_logs.id;


--
-- Name: attestation_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attestation_items (
    id integer NOT NULL,
    title text NOT NULL,
    description text,
    order_index integer DEFAULT 0,
    is_active boolean DEFAULT true
);


--
-- Name: attestation_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attestation_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attestation_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attestation_items_id_seq OWNED BY public.attestation_items.id;


--
-- Name: blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocks (
    id integer NOT NULL,
    topic_id integer,
    title text NOT NULL,
    description text,
    order_index integer DEFAULT 0
);


--
-- Name: blocks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.blocks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: blocks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.blocks_id_seq OWNED BY public.blocks.id;


--
-- Name: bot_instructions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_instructions (
    id integer NOT NULL,
    type text NOT NULL,
    file_id text NOT NULL
);


--
-- Name: bot_instructions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bot_instructions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bot_instructions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bot_instructions_id_seq OWNED BY public.bot_instructions.id;


--
-- Name: candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.candidates (
    id integer NOT NULL,
    name text NOT NULL,
    age integer,
    phone text,
    point_id integer,
    admin_id integer,
    status character varying(20) NOT NULL,
    questionnaire text,
    salary text,
    schedule text,
    decline_reason text,
    created_at timestamp with time zone DEFAULT now(),
    declined_at timestamp with time zone,
    desired_point_id integer,
    interview_time text,
    comment text,
    interview_date date,
    was_on_time boolean,
    late_minutes integer,
    interview_comment text,
    is_deferred boolean DEFAULT false NOT NULL,
    closed_from_status text,
    closed_by_admin_id integer,
    internship_date date,
    internship_time_from text,
    internship_time_to text,
    internship_point_id integer,
    internship_admin_id integer
);


--
-- Name: candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.candidates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: candidates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.candidates_id_seq OWNED BY public.candidates.id;


--
-- Name: cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cards (
    id integer NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    check_type character varying(20) DEFAULT 'strict'::character varying NOT NULL,
    explanation text,
    block_id integer,
    difficulty smallint DEFAULT 1 NOT NULL
);


--
-- Name: cards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cards_id_seq OWNED BY public.cards.id;


--
-- Name: internship_parts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internship_parts (
    id integer NOT NULL,
    title text NOT NULL,
    order_index integer NOT NULL,
    doc_file_id text
);


--
-- Name: internship_parts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.internship_parts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: internship_parts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.internship_parts_id_seq OWNED BY public.internship_parts.id;


--
-- Name: internship_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internship_sessions (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    day_number integer NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    started_by integer,
    is_canceled boolean DEFAULT false NOT NULL,
    trade_point_id integer,
    was_late boolean,
    issues text,
    comment text
);


--
-- Name: internship_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.internship_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: internship_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.internship_sessions_id_seq OWNED BY public.internship_sessions.id;


--
-- Name: internship_step_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internship_step_results (
    session_id bigint NOT NULL,
    step_id integer NOT NULL,
    is_passed boolean NOT NULL,
    checked_by integer,
    checked_at timestamp with time zone NOT NULL,
    media_file_id text
);


--
-- Name: internship_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internship_steps (
    id integer NOT NULL,
    part_id integer NOT NULL,
    title text NOT NULL,
    step_type text NOT NULL,
    order_index integer NOT NULL,
    planned_duration_min integer,
    CONSTRAINT internship_steps_step_type_check CHECK ((step_type = ANY (ARRAY['simple'::text, 'video'::text, 'photo'::text])))
);


--
-- Name: internship_steps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.internship_steps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: internship_steps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.internship_steps_id_seq OWNED BY public.internship_steps.id;


--
-- Name: knowledge_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_chunks (
    id integer NOT NULL,
    source text NOT NULL,
    chunk_index integer NOT NULL,
    heading text,
    text text NOT NULL,
    embedding jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: knowledge_chunks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knowledge_chunks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_chunks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knowledge_chunks_id_seq OWNED BY public.knowledge_chunks.id;


--
-- Name: lk_waiting_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lk_waiting_users (
    id integer NOT NULL,
    telegram_id bigint NOT NULL,
    full_name text NOT NULL,
    age integer,
    phone text NOT NULL,
    consent_given boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'new'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    linked_user_id integer,
    linked_at timestamp with time zone
);


--
-- Name: lk_waiting_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lk_waiting_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lk_waiting_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lk_waiting_users_id_seq OWNED BY public.lk_waiting_users.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id integer NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: test_session_answers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_session_answers (
    id integer NOT NULL,
    session_id integer,
    card_id integer,
    "position" integer NOT NULL,
    is_correct boolean,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: test_session_answers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.test_session_answers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: test_session_answers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.test_session_answers_id_seq OWNED BY public.test_session_answers.id;


--
-- Name: test_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_sessions (
    id integer NOT NULL,
    user_id integer,
    mode character varying(20) NOT NULL,
    topic_id integer,
    question_count integer NOT NULL,
    correct_count integer NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    admin_id integer,
    conducted_by integer
);


--
-- Name: test_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.test_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: test_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.test_sessions_id_seq OWNED BY public.test_sessions.id;


--
-- Name: topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.topics (
    id integer NOT NULL,
    title text NOT NULL,
    description text,
    order_index integer DEFAULT 0,
    pdf_file text
);


--
-- Name: topics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.topics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: topics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.topics_id_seq OWNED BY public.topics.id;


--
-- Name: trade_point_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_point_photos (
    id integer NOT NULL,
    trade_point_id integer,
    file_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: trade_point_photos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trade_point_photos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trade_point_photos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trade_point_photos_id_seq OWNED BY public.trade_point_photos.id;


--
-- Name: trade_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_points (
    id integer NOT NULL,
    title text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    address text,
    work_hours text,
    landmark text
);


--
-- Name: trade_points_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trade_points_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trade_points_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trade_points_id_seq OWNED BY public.trade_points.id;


--
-- Name: user_attestation_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_attestation_status (
    id integer NOT NULL,
    user_id integer,
    item_id integer,
    status character varying(20) DEFAULT 'not_passed'::character varying NOT NULL,
    updated_at timestamp without time zone DEFAULT now(),
    updated_by_admin_id integer,
    checked_by integer
);


--
-- Name: user_attestation_status_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_attestation_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_attestation_status_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_attestation_status_id_seq OWNED BY public.user_attestation_status.id;


--
-- Name: user_block_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_block_status (
    id integer NOT NULL,
    user_id integer,
    block_id integer,
    status character varying(10) DEFAULT 'not_passed'::character varying
);


--
-- Name: user_block_status_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_block_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_block_status_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_block_status_id_seq OWNED BY public.user_block_status.id;


--
-- Name: user_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notifications (
    notification_id integer NOT NULL,
    user_id integer NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    telegram_id bigint,
    role character varying(20) DEFAULT 'user'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    full_name text,
    staff_status text DEFAULT 'employee'::text NOT NULL,
    intern_days_completed integer DEFAULT 0 NOT NULL,
    "position" text,
    internship_info_read_at timestamp with time zone,
    candidate_id integer,
    work_phone text,
    username text
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: admin_action_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_action_logs ALTER COLUMN id SET DEFAULT nextval('public.admin_action_logs_id_seq'::regclass);


--
-- Name: ai_chat_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chat_logs ALTER COLUMN id SET DEFAULT nextval('public.ai_chat_logs_id_seq'::regclass);


--
-- Name: attestation_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attestation_items ALTER COLUMN id SET DEFAULT nextval('public.attestation_items_id_seq'::regclass);


--
-- Name: blocks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks ALTER COLUMN id SET DEFAULT nextval('public.blocks_id_seq'::regclass);


--
-- Name: bot_instructions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_instructions ALTER COLUMN id SET DEFAULT nextval('public.bot_instructions_id_seq'::regclass);


--
-- Name: candidates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates ALTER COLUMN id SET DEFAULT nextval('public.candidates_id_seq'::regclass);


--
-- Name: cards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cards ALTER COLUMN id SET DEFAULT nextval('public.cards_id_seq'::regclass);


--
-- Name: internship_parts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_parts ALTER COLUMN id SET DEFAULT nextval('public.internship_parts_id_seq'::regclass);


--
-- Name: internship_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_sessions ALTER COLUMN id SET DEFAULT nextval('public.internship_sessions_id_seq'::regclass);


--
-- Name: internship_steps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_steps ALTER COLUMN id SET DEFAULT nextval('public.internship_steps_id_seq'::regclass);


--
-- Name: knowledge_chunks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks ALTER COLUMN id SET DEFAULT nextval('public.knowledge_chunks_id_seq'::regclass);


--
-- Name: lk_waiting_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lk_waiting_users ALTER COLUMN id SET DEFAULT nextval('public.lk_waiting_users_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: test_session_answers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_session_answers ALTER COLUMN id SET DEFAULT nextval('public.test_session_answers_id_seq'::regclass);


--
-- Name: test_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions ALTER COLUMN id SET DEFAULT nextval('public.test_sessions_id_seq'::regclass);


--
-- Name: topics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topics ALTER COLUMN id SET DEFAULT nextval('public.topics_id_seq'::regclass);


--
-- Name: trade_point_photos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_point_photos ALTER COLUMN id SET DEFAULT nextval('public.trade_point_photos_id_seq'::regclass);


--
-- Name: trade_points id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_points ALTER COLUMN id SET DEFAULT nextval('public.trade_points_id_seq'::regclass);


--
-- Name: user_attestation_status id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_attestation_status ALTER COLUMN id SET DEFAULT nextval('public.user_attestation_status_id_seq'::regclass);


--
-- Name: user_block_status id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_block_status ALTER COLUMN id SET DEFAULT nextval('public.user_block_status_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: admin_action_logs admin_action_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_action_logs
    ADD CONSTRAINT admin_action_logs_pkey PRIMARY KEY (id);


--
-- Name: ai_chat_logs ai_chat_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chat_logs
    ADD CONSTRAINT ai_chat_logs_pkey PRIMARY KEY (id);


--
-- Name: attestation_items attestation_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attestation_items
    ADD CONSTRAINT attestation_items_pkey PRIMARY KEY (id);


--
-- Name: blocks blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_pkey PRIMARY KEY (id);


--
-- Name: bot_instructions bot_instructions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_instructions
    ADD CONSTRAINT bot_instructions_pkey PRIMARY KEY (id);


--
-- Name: bot_instructions bot_instructions_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_instructions
    ADD CONSTRAINT bot_instructions_type_key UNIQUE (type);


--
-- Name: candidates candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_pkey PRIMARY KEY (id);


--
-- Name: cards cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cards
    ADD CONSTRAINT cards_pkey PRIMARY KEY (id);


--
-- Name: internship_parts internship_parts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_parts
    ADD CONSTRAINT internship_parts_pkey PRIMARY KEY (id);


--
-- Name: internship_sessions internship_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_sessions
    ADD CONSTRAINT internship_sessions_pkey PRIMARY KEY (id);


--
-- Name: internship_step_results internship_step_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_step_results
    ADD CONSTRAINT internship_step_results_pkey PRIMARY KEY (session_id, step_id);


--
-- Name: internship_steps internship_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_steps
    ADD CONSTRAINT internship_steps_pkey PRIMARY KEY (id);


--
-- Name: knowledge_chunks knowledge_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_pkey PRIMARY KEY (id);


--
-- Name: lk_waiting_users lk_waiting_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lk_waiting_users
    ADD CONSTRAINT lk_waiting_users_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: test_session_answers test_session_answers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_session_answers
    ADD CONSTRAINT test_session_answers_pkey PRIMARY KEY (id);


--
-- Name: test_sessions test_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_pkey PRIMARY KEY (id);


--
-- Name: topics topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topics
    ADD CONSTRAINT topics_pkey PRIMARY KEY (id);


--
-- Name: trade_point_photos trade_point_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_point_photos
    ADD CONSTRAINT trade_point_photos_pkey PRIMARY KEY (id);


--
-- Name: trade_points trade_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_points
    ADD CONSTRAINT trade_points_pkey PRIMARY KEY (id);


--
-- Name: user_attestation_status user_attestation_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_attestation_status
    ADD CONSTRAINT user_attestation_status_pkey PRIMARY KEY (id);


--
-- Name: user_attestation_status user_attestation_status_user_item_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_attestation_status
    ADD CONSTRAINT user_attestation_status_user_item_unique UNIQUE (user_id, item_id);


--
-- Name: user_block_status user_block_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_block_status
    ADD CONSTRAINT user_block_status_pkey PRIMARY KEY (id);


--
-- Name: user_block_status user_block_status_user_block_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_block_status
    ADD CONSTRAINT user_block_status_user_block_unique UNIQUE (user_id, block_id);


--
-- Name: user_notifications user_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_pkey PRIMARY KEY (notification_id, user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_telegram_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_telegram_id_key UNIQUE (telegram_id);


--
-- Name: idx_ai_chat_logs_offtopic_confirmed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_chat_logs_offtopic_confirmed ON public.ai_chat_logs USING btree (is_offtopic_confirmed) WHERE (is_offtopic_confirmed IS TRUE);


--
-- Name: idx_candidates_rejected_lists; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_candidates_rejected_lists ON public.candidates USING btree (status, is_deferred, declined_at, closed_from_status);


--
-- Name: idx_internship_sessions_trainer_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internship_sessions_trainer_active ON public.internship_sessions USING btree (started_by) WHERE ((finished_at IS NULL) AND (is_canceled = false));


--
-- Name: idx_internship_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internship_sessions_user ON public.internship_sessions USING btree (user_id);


--
-- Name: idx_knowledge_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_source ON public.knowledge_chunks USING btree (source);


--
-- Name: lk_waiting_users_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lk_waiting_users_status_idx ON public.lk_waiting_users USING btree (status);


--
-- Name: lk_waiting_users_telegram_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lk_waiting_users_telegram_idx ON public.lk_waiting_users USING btree (telegram_id);


--
-- Name: user_attestation_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_attestation_unique ON public.user_attestation_status USING btree (user_id, item_id);


--
-- Name: admin_action_logs admin_action_logs_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_action_logs
    ADD CONSTRAINT admin_action_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id);


--
-- Name: admin_action_logs admin_action_logs_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_action_logs
    ADD CONSTRAINT admin_action_logs_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id);


--
-- Name: ai_chat_logs ai_chat_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chat_logs
    ADD CONSTRAINT ai_chat_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: blocks blocks_topic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.topics(id);


--
-- Name: candidates candidates_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id);


--
-- Name: candidates candidates_closed_by_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_closed_by_admin_id_fkey FOREIGN KEY (closed_by_admin_id) REFERENCES public.users(id);


--
-- Name: candidates candidates_desired_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_desired_point_id_fkey FOREIGN KEY (desired_point_id) REFERENCES public.trade_points(id);


--
-- Name: candidates candidates_internship_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_internship_admin_id_fkey FOREIGN KEY (internship_admin_id) REFERENCES public.users(id);


--
-- Name: candidates candidates_internship_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_internship_point_id_fkey FOREIGN KEY (internship_point_id) REFERENCES public.trade_points(id);


--
-- Name: candidates candidates_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_point_id_fkey FOREIGN KEY (point_id) REFERENCES public.trade_points(id);


--
-- Name: cards cards_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cards
    ADD CONSTRAINT cards_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.blocks(id) ON DELETE CASCADE;


--
-- Name: internship_sessions internship_sessions_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_sessions
    ADD CONSTRAINT internship_sessions_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: internship_sessions internship_sessions_trade_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_sessions
    ADD CONSTRAINT internship_sessions_trade_point_id_fkey FOREIGN KEY (trade_point_id) REFERENCES public.trade_points(id);


--
-- Name: internship_sessions internship_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_sessions
    ADD CONSTRAINT internship_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: internship_step_results internship_step_results_checked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_step_results
    ADD CONSTRAINT internship_step_results_checked_by_fkey FOREIGN KEY (checked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: internship_step_results internship_step_results_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_step_results
    ADD CONSTRAINT internship_step_results_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.internship_sessions(id) ON DELETE CASCADE;


--
-- Name: internship_step_results internship_step_results_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_step_results
    ADD CONSTRAINT internship_step_results_step_id_fkey FOREIGN KEY (step_id) REFERENCES public.internship_steps(id) ON DELETE CASCADE;


--
-- Name: internship_steps internship_steps_part_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internship_steps
    ADD CONSTRAINT internship_steps_part_id_fkey FOREIGN KEY (part_id) REFERENCES public.internship_parts(id) ON DELETE CASCADE;


--
-- Name: lk_waiting_users lk_waiting_users_linked_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lk_waiting_users
    ADD CONSTRAINT lk_waiting_users_linked_user_id_fkey FOREIGN KEY (linked_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: test_session_answers test_session_answers_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_session_answers
    ADD CONSTRAINT test_session_answers_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.cards(id) ON DELETE CASCADE;


--
-- Name: test_session_answers test_session_answers_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_session_answers
    ADD CONSTRAINT test_session_answers_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.test_sessions(id) ON DELETE CASCADE;


--
-- Name: test_sessions test_sessions_conducted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_conducted_by_fkey FOREIGN KEY (conducted_by) REFERENCES public.users(id);


--
-- Name: test_sessions test_sessions_topic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.topics(id);


--
-- Name: test_sessions test_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_sessions
    ADD CONSTRAINT test_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: trade_point_photos trade_point_photos_trade_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_point_photos
    ADD CONSTRAINT trade_point_photos_trade_point_id_fkey FOREIGN KEY (trade_point_id) REFERENCES public.trade_points(id) ON DELETE CASCADE;


--
-- Name: user_attestation_status user_attestation_status_checked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_attestation_status
    ADD CONSTRAINT user_attestation_status_checked_by_fkey FOREIGN KEY (checked_by) REFERENCES public.users(id);


--
-- Name: user_attestation_status user_attestation_status_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_attestation_status
    ADD CONSTRAINT user_attestation_status_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.attestation_items(id) ON DELETE CASCADE;


--
-- Name: user_attestation_status user_attestation_status_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_attestation_status
    ADD CONSTRAINT user_attestation_status_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_block_status user_block_status_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_block_status
    ADD CONSTRAINT user_block_status_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.blocks(id);


--
-- Name: user_block_status user_block_status_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_block_status
    ADD CONSTRAINT user_block_status_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_notifications user_notifications_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;


--
-- Name: user_notifications user_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- PostgreSQL database dump complete
--

