package main

import (
	"net/http"
	"testing"
)

func TestParseSearchArgs(t *testing.T) {
	tests := []struct {
		name      string
		raw       []string
		wantQuery string
		wantJSON  bool
		wantErr   bool
	}{
		{name: "positional query", raw: []string{"cats", "today"}, wantQuery: "cats today"},
		{name: "query flag", raw: []string{"--query", "cats today", "--json"}, wantQuery: "cats today", wantJSON: true},
		{name: "query equals flag", raw: []string{"--query=cats today"}, wantQuery: "cats today"},
		{name: "unknown option", raw: []string{"--bad"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseSearchArgs(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.query != tt.wantQuery {
				t.Fatalf("query = %q, want %q", got.query, tt.wantQuery)
			}
			if got.json != tt.wantJSON {
				t.Fatalf("json = %v, want %v", got.json, tt.wantJSON)
			}
		})
	}
}

func TestExaSearchUsesAPIKeyHeader(t *testing.T) {
	req, err := newExaSearchRequest("cats", "test-key")
	if err != nil {
		t.Fatalf("newExaSearchRequest error: %v", err)
	}
	if req.Method != http.MethodPost {
		t.Fatalf("method = %s, want POST", req.Method)
	}
	if got := req.Header.Get("x-api-key"); got != "test-key" {
		t.Fatalf("x-api-key = %q, want test-key", got)
	}
	if got := req.Header.Get("Authorization"); got != "" {
		t.Fatalf("Authorization should be empty, got %q", got)
	}
}
