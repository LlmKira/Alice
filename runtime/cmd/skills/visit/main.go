// visit — URL extraction via Exa + Engine LLM summary.
//
// 用法: visit <url> [focus] [--json]
//
//	visit --url <url> [--focus <focus>] [--json]
//
// 输出: 默认人类可读，--json 输出 JSON
//
// 环境变量: ALICE_ENGINE_URL — Engine API URL
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"os"
	"strings"
	"time"

	"github.com/LlmKira/Alice/runtime/internal/engine"
)

const exaContentsURL = "https://api.exa.ai/contents"

type visitArgs struct {
	url   string
	focus string
	json  bool
	help  bool
}

type configValue struct {
	Value string `json:"value"`
}

type exaContentsRequest struct {
	URLs []string `json:"urls"`
	Text struct {
		MaxCharacters int `json:"maxCharacters"`
	} `json:"text"`
	Livecrawl string `json:"livecrawl"`
}

type exaContentsResponse struct {
	Results []pageContent `json:"results"`
}

type pageContent struct {
	Title string `json:"title"`
	URL   string `json:"url"`
	Text  string `json:"text"`
}

type summarizeResponse struct {
	Summary string `json:"summary"`
}

type result struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Summary string `json:"summary"`
}

func main() {
	args, err := parseVisitArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "visit: %v\n", err)
		os.Exit(1)
	}
	if args.help {
		printUsage()
		return
	}
	if !isHTTPURL(args.url) {
		fmt.Fprintln(os.Stderr, "Usage: visit <url> [focus] or visit --url <url> [--focus <focus>]")
		os.Exit(1)
	}

	client := engine.NewClient()
	exaAPIKey, err := readExaAPIKey(client)
	if err != nil {
		fmt.Fprintf(os.Stderr, "visit: %v\n", err)
		os.Exit(1)
	}

	pages, err := exaExtract(args.url, exaAPIKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "visit: %v\n", err)
		os.Exit(1)
	}
	if len(pages) == 0 || strings.TrimSpace(pages[0].Text) == "" {
		fmt.Fprintln(os.Stderr, "visit: URL extraction returned empty")
		os.Exit(1)
	}

	summary, err := summarize(client, pages[0], args.focus)
	if err != nil {
		fmt.Fprintf(os.Stderr, "visit: %v\n", err)
		os.Exit(1)
	}
	if summary == "" {
		summary = truncate(pages[0].Text, 800)
	}

	title := pages[0].Title
	if strings.TrimSpace(title) == "" {
		title = "(untitled)"
	}
	out := result{Title: title, URL: pages[0].URL, Summary: summary}
	if _, err := client.Post("/graph/self/last_visit_result", map[string]any{"value": out}); err != nil {
		fmt.Fprintf(os.Stderr, "visit: failed to write graph result: %v\n", err)
		os.Exit(1)
	}

	if args.json {
		printJSON(out)
		return
	}
	fmt.Printf("Summary of %q:\n", out.Title)
	fmt.Println(out.Summary)
	fmt.Printf("URL: %s\n", out.URL)
}

func parseVisitArgs(raw []string) (visitArgs, error) {
	var out visitArgs
	var positionals []string
	for i := 0; i < len(raw); i++ {
		arg := raw[i]
		switch {
		case arg == "--help" || arg == "-h":
			out.help = true
		case arg == "--json":
			out.json = true
		case arg == "--url":
			if i+1 >= len(raw) {
				return out, errors.New("--url requires a value")
			}
			out.url = raw[i+1]
			i++
		case strings.HasPrefix(arg, "--url="):
			out.url = strings.TrimPrefix(arg, "--url=")
		case arg == "--focus":
			if i+1 >= len(raw) {
				return out, errors.New("--focus requires a value")
			}
			out.focus = raw[i+1]
			i++
		case strings.HasPrefix(arg, "--focus="):
			out.focus = strings.TrimPrefix(arg, "--focus=")
		case strings.HasPrefix(arg, "--"):
			return out, fmt.Errorf("unknown option %s", arg)
		default:
			positionals = append(positionals, arg)
		}
	}
	if out.url == "" && len(positionals) > 0 {
		out.url = positionals[0]
	}
	if out.focus == "" && len(positionals) > 1 {
		out.focus = strings.Join(positionals[1:], " ")
	}
	return out, nil
}

func printUsage() {
	fmt.Println("Usage: visit <url> [focus] [--json]")
	fmt.Println("       visit --url <url> [--focus <focus>] [--json]")
}

func isHTTPURL(raw string) bool {
	u, err := neturl.Parse(raw)
	if err != nil {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

func readExaAPIKey(client *engine.Client) (string, error) {
	raw, err := client.Get("/config/exaApiKey")
	if err != nil {
		return "", fmt.Errorf("failed to read exa config: %w", err)
	}
	var cfg configValue
	if !decode(raw, &cfg) || strings.TrimSpace(cfg.Value) == "" {
		return "", errors.New("EXA_API_KEY not configured")
	}
	return cfg.Value, nil
}

func exaExtract(url string, apiKey string) ([]pageContent, error) {
	reqBody := exaContentsRequest{
		URLs:      []string{url},
		Livecrawl: "fallback",
	}
	reqBody.Text.MaxCharacters = 6000

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, exaContentsURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)

	httpClient := &http.Client{Timeout: 15 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Exa Contents API error: %d %s", resp.StatusCode, resp.Status)
	}

	var parsed exaContentsResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, err
	}
	return parsed.Results, nil
}

func summarize(client *engine.Client, page pageContent, focus string) (string, error) {
	body := map[string]any{
		"text": page.Text,
		"url":  page.URL,
	}
	if strings.TrimSpace(focus) != "" {
		body["focus"] = focus
	}
	raw, err := client.Post("/llm/summarize", body)
	if err != nil {
		return "", fmt.Errorf("summarize failed: %w", err)
	}
	var resp summarizeResponse
	if !decode(raw, &resp) {
		return "", nil
	}
	return resp.Summary, nil
}

func decode(raw any, dest any) bool {
	bytes, err := json.Marshal(raw)
	if err != nil {
		return false
	}
	return json.Unmarshal(bytes, dest) == nil
}

func truncate(text string, max int) string {
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max])
}

func printJSON(v any) {
	output, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "visit: failed to encode JSON: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(output))
}
