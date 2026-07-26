package builtinext

import (
	"testing"
)

// These table tests port the command-handler *integration* cases from the TS
// vitest suites that the initial parity table omitted (audit F3). The classic
// extensions decide, inside their registerCommand handler, whether to open the
// overlay or emit a notify() — a decision layer distinct from the data layer
// (IndexSessions) and the UI layer (the overlays). The resolver under test
// mirrors exactly that decision:
//
//   history-search/index.ts:28-55  -> ResolveHistoryCommandOutcome
//
// Source cases ported here:
//   history-search-extension.test.ts  "registers /history and handles no-UI
//       command execution" (no session messages emitted; the no-UI/empty path
//       notifies instead of opening).

// --- history command handler (ported from history-search-extension.test.ts) --

func TestResolveHistoryCommandOutcomeNoUI(t *testing.T) {
	got := ResolveHistoryCommandOutcome(false, nil)
	if got.OpenOverlay {
		t.Fatalf("no-UI must not open overlay: %#v", got)
	}
	if got.NotifyMessage != "No UI available" || got.NotifyLevel != "info" {
		t.Fatalf("no-UI notify mismatch: %#v", got)
	}
}

func TestResolveHistoryCommandOutcomeEmptyHistory(t *testing.T) {
	got := ResolveHistoryCommandOutcome(true, []HistoryEntry{})
	if got.OpenOverlay {
		t.Fatalf("empty history must not open overlay: %#v", got)
	}
	if got.NotifyMessage != "No prompt history found" || got.NotifyLevel != "info" {
		t.Fatalf("empty-history notify mismatch: %#v", got)
	}
}

func TestResolveHistoryCommandOutcomeOpensWhenEntriesExist(t *testing.T) {
	entries := []HistoryEntry{{Text: "ship it", SessionID: "s1", Timestamp: baseTime}}
	got := ResolveHistoryCommandOutcome(true, entries)
	if !got.OpenOverlay {
		t.Fatalf("non-empty history must open overlay: %#v", got)
	}
	if got.NotifyMessage != "" {
		t.Fatalf("open path must not notify: %#v", got)
	}
}
