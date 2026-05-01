package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLoadEnvFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := `# comment
export TELEGRAM_API_ID=123456
TELEGRAM_API_HASH="hash-value"
LLM_API_KEY='sk-test'
LLM_MODEL=gpt-4o
`
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write env: %v", err)
	}

	got, err := loadEnvFile(path)
	if err != nil {
		t.Fatalf("loadEnvFile(): %v", err)
	}

	want := map[string]string{
		"TELEGRAM_API_ID":   "123456",
		"TELEGRAM_API_HASH": "hash-value",
		"LLM_API_KEY":       "sk-test",
		"LLM_MODEL":         "gpt-4o",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("env mismatch\ngot:  %#v\nwant: %#v", got, want)
	}
}

func TestValidateEnvFile(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		env        map[string]string
		wantMiss   []string
		wantBad    []string
		wantLegacy []string
	}{
		{
			name: "valid current keys",
			env: map[string]string{
				"TELEGRAM_API_ID":   "123456",
				"TELEGRAM_API_HASH": "hash",
				"TELEGRAM_PHONE":    "+8613800138000",
				"LLM_API_KEY":       "sk-test",
			},
		},
		{
			name: "legacy openai keys only",
			env: map[string]string{
				"TELEGRAM_API_ID":   "123456",
				"TELEGRAM_API_HASH": "hash",
				"TELEGRAM_PHONE":    "+8613800138000",
				"OPENAI_API_KEY":    "sk-test",
			},
			wantMiss:   []string{"LLM_API_KEY"},
			wantLegacy: []string{"OPENAI_API_KEY"},
		},
		{
			name: "invalid api id",
			env: map[string]string{
				"TELEGRAM_API_ID":   "12x",
				"TELEGRAM_API_HASH": "hash",
				"TELEGRAM_PHONE":    "+8613800138000",
				"LLM_API_KEY":       "sk-test",
			},
			wantBad: []string{"TELEGRAM_API_ID"},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := validateEnvFile(tt.env)
			if !reflect.DeepEqual(got.Missing, tt.wantMiss) {
				t.Fatalf("Missing mismatch\ngot:  %#v\nwant: %#v", got.Missing, tt.wantMiss)
			}
			if !reflect.DeepEqual(got.Invalid, tt.wantBad) {
				t.Fatalf("Invalid mismatch\ngot:  %#v\nwant: %#v", got.Invalid, tt.wantBad)
			}
			if !reflect.DeepEqual(got.LegacyOnly, tt.wantLegacy) {
				t.Fatalf("LegacyOnly mismatch\ngot:  %#v\nwant: %#v", got.LegacyOnly, tt.wantLegacy)
			}
		})
	}
}

func TestFindTsxBinaryPrefersRuntimeLocal(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	runtimeDir := filepath.Join(root, "runtime")
	runtimeBinDir := filepath.Join(runtimeDir, "node_modules", ".bin")
	parentBinDir := filepath.Join(root, "node_modules", ".bin")
	if err := os.MkdirAll(runtimeBinDir, 0755); err != nil {
		t.Fatalf("mkdir runtime bin: %v", err)
	}
	if err := os.MkdirAll(parentBinDir, 0755); err != nil {
		t.Fatalf("mkdir parent bin: %v", err)
	}

	runtimeTsx := filepath.Join(runtimeBinDir, "tsx")
	parentTsx := filepath.Join(parentBinDir, "tsx")
	if err := os.WriteFile(runtimeTsx, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write runtime tsx: %v", err)
	}
	if err := os.WriteFile(parentTsx, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write parent tsx: %v", err)
	}

	got := findTsxBinary(runtimeDir)
	if got != runtimeTsx {
		t.Fatalf("findTsxBinary() = %q, want %q", got, runtimeTsx)
	}
}

func TestParseNodeMajor(t *testing.T) {
	t.Parallel()

	tests := []struct {
		version string
		want    int
	}{
		{version: "v22.3.0", want: 22},
		{version: "20.19.4", want: 20},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.version, func(t *testing.T) {
			t.Parallel()

			got, err := parseNodeMajor(tt.version)
			if err != nil {
				t.Fatalf("parseNodeMajor(%q): %v", tt.version, err)
			}
			if got != tt.want {
				t.Fatalf("parseNodeMajor(%q) = %d, want %d", tt.version, got, tt.want)
			}
		})
	}
}

func TestFindSystemBinDirPrefersEnv(t *testing.T) {
	t.Setenv("ALICE_SYSTEM_BIN_DIR", "/tmp/alice-system-bin")
	got := findSystemBinDir("/opt/alice/runtime")
	if got != "/tmp/alice-system-bin" {
		t.Fatalf("findSystemBinDir() = %q, want %q", got, "/tmp/alice-system-bin")
	}
}

func TestFindMissingSystemBinaries(t *testing.T) {
	t.Parallel()

	systemBinDir := t.TempDir()
	for _, name := range []string{"irc", "self"} {
		path := filepath.Join(systemBinDir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0755); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	got := findMissingSystemBinaries(systemBinDir)
	want := []string{"alice-pkg"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("findMissingSystemBinaries() mismatch\ngot:  %#v\nwant: %#v", got, want)
	}
}

func TestFindSkillDirPrefersRuntimeDistBin(t *testing.T) {
	root := t.TempDir()
	runtimeDir := filepath.Join(root, "runtime")
	runtimeDistBin := filepath.Join(runtimeDir, "dist", "bin")
	rootDistBin := filepath.Join(root, "dist", "bin")
	if err := os.MkdirAll(runtimeDistBin, 0755); err != nil {
		t.Fatalf("mkdir runtime dist bin: %v", err)
	}
	if err := os.MkdirAll(rootDistBin, 0755); err != nil {
		t.Fatalf("mkdir root dist bin: %v", err)
	}

	oldWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer func() {
		if err := os.Chdir(oldWd); err != nil {
			t.Fatalf("restore wd: %v", err)
		}
	}()

	got := findSkillDir(runtimeDir)
	if got != runtimeDistBin {
		t.Fatalf("findSkillDir() = %q, want %q", got, runtimeDistBin)
	}
}

func TestFindEnvFilePrefersRuntimeEnv(t *testing.T) {
	root := t.TempDir()
	runtimeDir := filepath.Join(root, "runtime")
	if err := os.MkdirAll(runtimeDir, 0755); err != nil {
		t.Fatalf("mkdir runtime: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("LLM_API_KEY=root\n"), 0644); err != nil {
		t.Fatalf("write root env: %v", err)
	}
	runtimeEnv := filepath.Join(runtimeDir, ".env")
	if err := os.WriteFile(runtimeEnv, []byte("LLM_API_KEY=runtime\n"), 0644); err != nil {
		t.Fatalf("write runtime env: %v", err)
	}

	oldWd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer func() {
		if err := os.Chdir(oldWd); err != nil {
			t.Fatalf("restore wd: %v", err)
		}
	}()

	got := findEnvFile(runtimeDir)
	if got != runtimeEnv {
		t.Fatalf("findEnvFile() = %q, want %q", got, runtimeEnv)
	}
}
