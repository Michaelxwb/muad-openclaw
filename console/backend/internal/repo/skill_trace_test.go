package repo

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

func newSkillTraceTestStore(t *testing.T) *Store {
	t.Helper()
	store := newPodTestStore(t)
	if _, err := store.db.Exec(`INSERT INTO pods (
		pod_id, display_name, service_token_enc, service_token_fingerprint,
		service_token_rotated_at, created_at, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"pod-a", "Pod A", "enc", "sha256:trace", "now", "now", "now"); err != nil {
		t.Fatalf("insert Pod: %v", err)
	}
	models := []LLMModelConfig{createTestModel(t, store), createTestModel(t, store)}
	for i, user := range []struct {
		id, agent string
		port      int
	}{
		{id: "user-a", agent: "agent-a", port: 18802},
		{id: "user-b", agent: "agent-b", port: 18803},
	} {
		if _, err := store.db.Exec(`INSERT INTO human_users (
			human_user_id, pod_id, model_config_id, display_name, agent_id,
			browser_profile, browser_cdp_port, status, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			user.id, "pod-a", models[i].ModelConfigID, "User "+user.id, user.agent,
			user.agent, user.port, HumanUserStatusActive, "now", "now"); err != nil {
			t.Fatalf("insert Human User %s: %v", user.id, err)
		}
	}
	return store
}

func insertTestExecution(t *testing.T, store *Store, executionID, humanUserID, agentID string) {
	t.Helper()
	record, err := store.UpsertSkillExecutionRecord(SkillExecutionRecord{
		ExecutionID: executionID, PodID: "pod-a", HumanUserID: humanUserID,
		AgentID: agentID, SkillName: "xdr-query", SkillScope: SkillScopePrivate,
		StartedAt: time.Date(2026, 10, 17, 6, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("UpsertSkillExecutionRecord: %v", err)
	}
	if record.ExecutionID != executionID {
		t.Fatalf("stored execution ID = %q, want %q", record.ExecutionID, executionID)
	}
}

func TestInsertSkillTraceEventsIsIdempotent(t *testing.T) {
	store := newSkillTraceTestStore(t)
	insertTestExecution(t, store, "exec-a", "user-a", "agent-a")
	events := []SkillTraceEvent{
		{EventID: "event-1", Seq: 1, OccurredAt: time.Date(2026, 10, 17, 6, 1, 0, 0, time.UTC),
			Kind: SkillTraceKindExec, Status: SkillTraceStatusOK, Summary: "python3 run.py"},
		{EventID: "event-2", Seq: 2, OccurredAt: time.Date(2026, 10, 17, 6, 2, 0, 0, time.UTC),
			Kind: SkillTraceKindHTTP, Status: SkillTraceStatusError, Summary: "GET /api",
			TraceID: "7d8f4c8e-2b0a-4f1d-9e63-5f0f1a2b3c4d"},
	}
	stored, err := store.InsertSkillTraceEvents(context.Background(), "exec-a", events)
	if err != nil {
		t.Fatalf("InsertSkillTraceEvents: %v", err)
	}
	if stored != 2 {
		t.Fatalf("stored events = %d, want 2", stored)
	}
	replay := append([]SkillTraceEvent(nil), events...)
	replay = append(replay, SkillTraceEvent{
		EventID: "event-3", Seq: 3, OccurredAt: time.Date(2026, 10, 17, 6, 3, 0, 0, time.UTC),
		Kind: SkillTraceKindOutput, Status: SkillTraceStatusOK, Summary: "done",
	})
	stored, err = store.InsertSkillTraceEvents(context.Background(), "exec-a", replay)
	if err != nil {
		t.Fatalf("InsertSkillTraceEvents replay: %v", err)
	}
	if stored != 1 {
		t.Fatalf("stored events on replay = %d, want 1 (only the new event)", stored)
	}
	// Same event_id retried with a different seq must not mutate the stored row.
	stored, err = store.InsertSkillTraceEvents(context.Background(), "exec-a", []SkillTraceEvent{{
		EventID: "event-1", Seq: 9, OccurredAt: time.Now().UTC(),
		Kind: SkillTraceKindAbort, Status: SkillTraceStatusError, Summary: "conflict",
	}})
	if err != nil {
		t.Fatalf("InsertSkillTraceEvents duplicate ID: %v", err)
	}
	if stored != 0 {
		t.Fatalf("stored events for duplicate event_id = %d, want 0", stored)
	}
	got, err := store.ListSkillTraceEvents(context.Background(), "exec-a", 0)
	if err != nil {
		t.Fatalf("ListSkillTraceEvents: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("listed events = %d, want 3", len(got))
	}
	for i, want := range []int{1, 2, 3} {
		if got[i].Seq != want {
			t.Fatalf("event %d seq = %d, want %d", i, got[i].Seq, want)
		}
	}
	if got[0].Summary != "python3 run.py" {
		t.Fatalf("duplicate replay mutated stored event: %+v", got[0])
	}
	if got[1].TraceID != "7d8f4c8e-2b0a-4f1d-9e63-5f0f1a2b3c4d" {
		t.Fatalf("http event trace id = %q", got[1].TraceID)
	}
	if got[0].TraceID != "" {
		t.Fatalf("exec event trace id = %q, want empty", got[0].TraceID)
	}
}

func TestMigrateSkillTraceEventTraceIDIsIdempotent(t *testing.T) {
	store := newSkillTraceTestStore(t)
	for range 2 {
		if err := store.migrateSkillTraceEventTraceID(); err != nil {
			t.Fatalf("migrateSkillTraceEventTraceID: %v", err)
		}
	}
	exists, err := columnExists(store.db, "skill_trace_events", "trace_id")
	if err != nil || !exists {
		t.Fatalf("trace_id column exists = %v, err = %v", exists, err)
	}
}

func TestListSkillTraceEventsOrdersBySeqAndLimits(t *testing.T) {
	store := newSkillTraceTestStore(t)
	insertTestExecution(t, store, "exec-a", "user-a", "agent-a")
	for _, seq := range []int{3, 1, 2} {
		if _, err := store.InsertSkillTraceEvents(context.Background(), "exec-a", []SkillTraceEvent{{
			EventID: "event-" + string(rune('0'+seq)), Seq: seq,
			OccurredAt: time.Now().UTC(), Kind: SkillTraceKindExec,
			Status: SkillTraceStatusOK, Summary: "step",
		}}); err != nil {
			t.Fatalf("InsertSkillTraceEvents seq %d: %v", seq, err)
		}
	}
	got, err := store.ListSkillTraceEvents(context.Background(), "exec-a", 2)
	if err != nil {
		t.Fatalf("ListSkillTraceEvents: %v", err)
	}
	if len(got) != 2 || got[0].Seq != 1 || got[1].Seq != 2 {
		t.Fatalf("limited events = %+v, want seq 1,2", got)
	}
}

func TestUpsertSkillExecutionMetricsKeepsAbortedMonotonic(t *testing.T) {
	store := newSkillTraceTestStore(t)
	insertTestExecution(t, store, "exec-a", "user-a", "agent-a")
	abortCount := 1001
	if err := store.UpsertSkillExecutionMetrics(context.Background(), SkillExecutionMetrics{
		ExecutionID: "exec-a", RequestCount: 1001, ErrorCount: 37, DistinctHosts: 1,
		MaxBurstPer10s: 420, TopInterfacesJSON: `[{"host":"mssw","method":"GET","path":"/x","count":990}]`,
		DetailTruncated: true, Aborted: true, AbortReason: "request_limit",
		AbortInterface: "GET mssw /x", AbortCount: &abortCount,
	}); err != nil {
		t.Fatalf("UpsertSkillExecutionMetrics aborted: %v", err)
	}
	if err := store.UpsertSkillExecutionMetrics(context.Background(), SkillExecutionMetrics{
		ExecutionID: "exec-a", RequestCount: 10, ErrorCount: 1,
		TopInterfacesJSON: `[]`, Aborted: false, DetailTruncated: false,
	}); err != nil {
		t.Fatalf("UpsertSkillExecutionMetrics downgrade: %v", err)
	}
	got, err := store.GetSkillExecutionMetrics(context.Background(), "exec-a")
	if err != nil {
		t.Fatalf("GetSkillExecutionMetrics: %v", err)
	}
	if !got.Aborted {
		t.Fatal("aborted must stay true after a later non-aborted upsert")
	}
	if got.AbortReason != "request_limit" || got.AbortInterface != "GET mssw /x" ||
		got.AbortCount == nil || *got.AbortCount != 1001 {
		t.Fatalf("abort detail was cleared or changed: %+v", got)
	}
	if got.RequestCount != 10 || got.TopInterfacesJSON != "[]" {
		t.Fatalf("non-abort counters should follow the latest upsert: %+v", got)
	}

	// First write non-aborted, then aborted: it must upgrade.
	insertTestExecution(t, store, "exec-b", "user-a", "agent-a")
	if err := store.UpsertSkillExecutionMetrics(context.Background(), SkillExecutionMetrics{
		ExecutionID: "exec-b", RequestCount: 5, TopInterfacesJSON: `[]`,
	}); err != nil {
		t.Fatalf("UpsertSkillExecutionMetrics initial: %v", err)
	}
	if err := store.UpsertSkillExecutionMetrics(context.Background(), SkillExecutionMetrics{
		ExecutionID: "exec-b", RequestCount: 6, TopInterfacesJSON: `[]`,
		Aborted: true, AbortReason: "request_limit",
	}); err != nil {
		t.Fatalf("UpsertSkillExecutionMetrics upgrade: %v", err)
	}
	upgraded, err := store.GetSkillExecutionMetrics(context.Background(), "exec-b")
	if err != nil {
		t.Fatalf("GetSkillExecutionMetrics upgraded: %v", err)
	}
	if !upgraded.Aborted || upgraded.AbortReason != "request_limit" {
		t.Fatalf("aborted upgrade lost: %+v", upgraded)
	}
}

func TestQuerySkillExecutionStatsGroupsPrivateSkillPerUser(t *testing.T) {
	store := newSkillTraceTestStore(t)
	insertTestExecution(t, store, "exec-a", "user-a", "agent-a")
	insertTestExecution(t, store, "exec-b", "user-b", "agent-b")
	if err := store.UpsertSkillExecutionMetrics(context.Background(), SkillExecutionMetrics{
		ExecutionID: "exec-a", RequestCount: 1001, ErrorCount: 37, TopInterfacesJSON: `[]`,
		Aborted: true, AbortReason: "request_limit",
	}); err != nil {
		t.Fatalf("upsert metrics a: %v", err)
	}
	if err := store.UpsertSkillExecutionMetrics(context.Background(), SkillExecutionMetrics{
		ExecutionID: "exec-b", RequestCount: 20, ErrorCount: 1, TopInterfacesJSON: `[]`,
	}); err != nil {
		t.Fatalf("upsert metrics b: %v", err)
	}
	filter := SkillExecutionStatsFilter{
		Since: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), Limit: 10,
		Scope: SkillScopePrivate,
	}
	stats, err := store.QuerySkillExecutionStats(context.Background(), filter)
	if err != nil {
		t.Fatalf("QuerySkillExecutionStats: %v", err)
	}
	if len(stats) != 2 {
		t.Fatalf("stats rows = %d, want 2 (same private Skill name split per user)", len(stats))
	}
	byUser := map[string]SkillExecutionStat{}
	for _, stat := range stats {
		if stat.SkillName != "xdr-query" || stat.SkillScope != SkillScopePrivate {
			t.Fatalf("unexpected grouped row: %+v", stat)
		}
		if stat.Executions != 1 || stat.LastExecutionAt.IsZero() {
			t.Fatalf("unexpected execution aggregates: %+v", stat)
		}
		byUser[stat.HumanUserID] = stat
	}
	if byUser["user-a"].MaxRequests != 1001 || byUser["user-a"].AbortedCount != 1 ||
		byUser["user-a"].SumErrors != 37 {
		t.Fatalf("user-a stats = %+v", byUser["user-a"])
	}
	if byUser["user-b"].MaxRequests != 20 || byUser["user-b"].AbortedCount != 0 {
		t.Fatalf("user-b stats = %+v", byUser["user-b"])
	}
	filter.HumanUserID = "user-b"
	stats, err = store.QuerySkillExecutionStats(context.Background(), filter)
	if err != nil {
		t.Fatalf("QuerySkillExecutionStats by user: %v", err)
	}
	if len(stats) != 1 || stats[0].HumanUserID != "user-b" {
		t.Fatalf("filtered stats = %+v, want only user-b", stats)
	}
}

func TestNotifyChannelCRUD(t *testing.T) {
	store := newPodTestStore(t)
	created, err := store.UpsertNotifyChannel(NotifyChannel{
		Type: NotifyChannelTypeWecom, Name: "Ops", ConfigEnc: "ciphertext-1", Enabled: true,
	})
	if err != nil {
		t.Fatalf("UpsertNotifyChannel create: %v", err)
	}
	if created.ChannelID == "" {
		t.Fatal("created notify channel has no ID")
	}
	got, err := store.GetNotifyChannel(created.ChannelID)
	if err != nil {
		t.Fatalf("GetNotifyChannel: %v", err)
	}
	if got.Name != "Ops" || got.ConfigEnc != "ciphertext-1" || !got.Enabled {
		t.Fatalf("created notify channel = %+v", got)
	}
	if err := store.SetNotifyChannelEnabled(created.ChannelID, false); err != nil {
		t.Fatalf("SetNotifyChannelEnabled: %v", err)
	}
	updated, err := store.UpsertNotifyChannel(NotifyChannel{
		ChannelID: created.ChannelID, Type: NotifyChannelTypeWecom,
		Name: "Ops 2", ConfigEnc: "ciphertext-2", Enabled: true,
	})
	if err != nil {
		t.Fatalf("UpsertNotifyChannel update: %v", err)
	}
	if updated.Name != "Ops 2" || updated.ConfigEnc != "ciphertext-2" || !updated.Enabled {
		t.Fatalf("updated notify channel = %+v", updated)
	}
	list, err := store.ListNotifyChannels()
	if err != nil {
		t.Fatalf("ListNotifyChannels: %v", err)
	}
	if len(list) != 1 || list[0].ChannelID != created.ChannelID {
		t.Fatalf("listed notify channels = %+v", list)
	}
	if err := store.SetNotifyChannelEnabled(created.ChannelID, false); err != nil {
		t.Fatalf("SetNotifyChannelEnabled off: %v", err)
	}
	toggled, err := store.GetNotifyChannel(created.ChannelID)
	if err != nil {
		t.Fatalf("GetSkillExecutionMetrics: %v", err)
	}
	if toggled.Enabled {
		t.Fatalf("enabled toggle did not persist: %+v", toggled)
	}
	if err := store.DeleteNotifyChannel(created.ChannelID); err != nil {
		t.Fatalf("DeleteNotifyChannel: %v", err)
	}
	if _, err := store.GetNotifyChannel(created.ChannelID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetNotifyChannel after delete error = %v, want ErrNotFound", err)
	}
}

func TestRepoSQLHasNoSelectStar(t *testing.T) {
	pattern := regexp.MustCompile(`SELECT\s+\*`)
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read repo package dir: %v", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || filepath.Ext(name) != ".go" ||
			regexp.MustCompile(`_test\.go$`).MatchString(name) {
			continue
		}
		content, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if pattern.Match(content) {
			t.Errorf("%s contains a wildcard projection", name)
		}
	}
}
