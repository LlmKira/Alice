package main

import "testing"

func TestParseVisitArgs(t *testing.T) {
	tests := []struct {
		name      string
		raw       []string
		wantURL   string
		wantFocus string
		wantJSON  bool
		wantErr   bool
	}{
		{name: "positional url", raw: []string{"https://example.com"}, wantURL: "https://example.com"},
		{name: "positional url and focus", raw: []string{"https://example.com", "main conclusions"}, wantURL: "https://example.com", wantFocus: "main conclusions"},
		{name: "manifest-shaped flags", raw: []string{"--url", "https://example.com", "--focus", "main conclusions", "--json"}, wantURL: "https://example.com", wantFocus: "main conclusions", wantJSON: true},
		{name: "equals flags", raw: []string{"--url=https://example.com", "--focus=details"}, wantURL: "https://example.com", wantFocus: "details"},
		{name: "missing value", raw: []string{"--url"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseVisitArgs(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.url != tt.wantURL {
				t.Fatalf("url = %q, want %q", got.url, tt.wantURL)
			}
			if got.focus != tt.wantFocus {
				t.Fatalf("focus = %q, want %q", got.focus, tt.wantFocus)
			}
			if got.json != tt.wantJSON {
				t.Fatalf("json = %v, want %v", got.json, tt.wantJSON)
			}
		})
	}
}

func TestIsHTTPURL(t *testing.T) {
	if !isHTTPURL("https://example.com") {
		t.Fatal("expected https URL to be valid")
	}
	if isHTTPURL("file:///tmp/x") {
		t.Fatal("expected file URL to be invalid")
	}
}
