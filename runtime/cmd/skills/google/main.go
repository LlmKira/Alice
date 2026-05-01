// google — Web search via Exa + Engine LLM synthesis.
//
// 用法: google <query> [--json]
//
//	google --query <query> [--json]
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
	"os"
	"strings"
	"time"

	"github.com/LlmKira/Alice/runtime/internal/engine"
)

const exaSearchURL = "https://api.exa.ai/search"

type searchArgs struct {
	query string
	json  bool
	help  bool
}

type exaSearchRequest struct {
	Query      string `json:"query"`
	Type       string `json:"type"`
	NumResults int    `json:"numResults"`
	Contents   struct {
		Text struct {
			MaxCharacters int `json:"maxCharacters"`
		} `json:"text"`
	} `json:"contents"`
}

type exaSearchResponse struct {
	Results []source `json:"results"`
}

type source struct {
	Title string `json:"title"`
	URL   string `json:"url"`
	Text  string `json:"text"`
}

type configValue struct {
	Value string `json:"value"`
}

type synthesizeResponse struct {
	Answer string `json:"answer"`
}

type result struct {
	Answer  string     `json:"answer"`
	Sources []citation `json:"sources"`
}

type citation struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

func main() {
	args, err := parseSearchArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "google: %v\n", err)
		os.Exit(1)
	}
	if args.help {
		printUsage()
		return
	}
	if strings.TrimSpace(args.query) == "" {
		fmt.Fprintln(os.Stderr, "Usage: google <query> or google --query <query>")
		os.Exit(1)
	}

	client := engine.NewClient()
	exaAPIKey, err := readExaAPIKey(client)
	if err != nil {
		fmt.Fprintf(os.Stderr, "google: %v\n", err)
		os.Exit(1)
	}

	sources, err := exaSearch(args.query, exaAPIKey)
	if err != nil {
		fmt.Fprintf(os.Stderr, "google: %v\n", err)
		os.Exit(1)
	}
	if len(sources) == 0 {
		fmt.Fprintln(os.Stderr, "google: search returned no results")
		os.Exit(1)
	}

	answer, err := synthesize(client, args.query, sources)
	if err != nil {
		fmt.Fprintf(os.Stderr, "google: %v\n", err)
		os.Exit(1)
	}
	if answer == "" {
		answer = truncate(sources[0].Text, 800)
	}

	out := result{
		Answer:  answer,
		Sources: makeCitations(sources, 5),
	}
	if _, err := client.Post("/graph/self/last_google_result", map[string]any{"value": out}); err != nil {
		fmt.Fprintf(os.Stderr, "google: failed to write graph result: %v\n", err)
		os.Exit(1)
	}

	if args.json {
		printJSON(out)
		return
	}
	fmt.Printf("Answer: %s\n", out.Answer)
	if len(out.Sources) > 0 {
		fmt.Println("Sources:")
		for i, c := range out.Sources {
			fmt.Printf("%d. %s — %s\n", i+1, c.Title, c.URL)
		}
	}
}

func parseSearchArgs(raw []string) (searchArgs, error) {
	var out searchArgs
	var positionals []string
	for i := 0; i < len(raw); i++ {
		arg := raw[i]
		switch {
		case arg == "--help" || arg == "-h":
			out.help = true
		case arg == "--json":
			out.json = true
		case arg == "--query":
			if i+1 >= len(raw) {
				return out, errors.New("--query requires a value")
			}
			out.query = raw[i+1]
			i++
		case strings.HasPrefix(arg, "--query="):
			out.query = strings.TrimPrefix(arg, "--query=")
		case strings.HasPrefix(arg, "--"):
			return out, fmt.Errorf("unknown option %s", arg)
		default:
			positionals = append(positionals, arg)
		}
	}
	if out.query == "" && len(positionals) > 0 {
		out.query = strings.Join(positionals, " ")
	}
	return out, nil
}

func printUsage() {
	fmt.Println("Usage: google <query> [--json]")
	fmt.Println("       google --query <query> [--json]")
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

func exaSearch(query, apiKey string) ([]source, error) {
	req, err := newExaSearchRequest(query, apiKey)
	if err != nil {
		return nil, err
	}

	httpClient := &http.Client{Timeout: 10 * time.Second}
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
		return nil, fmt.Errorf("Exa API error: %d %s", resp.StatusCode, resp.Status)
	}

	var parsed exaSearchResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, err
	}
	return parsed.Results, nil
}

func newExaSearchRequest(query, apiKey string) (*http.Request, error) {
	reqBody := exaSearchRequest{
		Query:      query,
		Type:       "auto",
		NumResults: 3,
	}
	reqBody.Contents.Text.MaxCharacters = 3000

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, exaSearchURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	return req, nil
}

func synthesize(client *engine.Client, question string, sources []source) (string, error) {
	raw, err := client.Post("/llm/synthesize", map[string]any{
		"question": question,
		"sources":  sources,
	})
	if err != nil {
		return "", fmt.Errorf("synthesis failed: %w", err)
	}
	var resp synthesizeResponse
	if !decode(raw, &resp) {
		return "", nil
	}
	return resp.Answer, nil
}

func makeCitations(sources []source, max int) []citation {
	if len(sources) < max {
		max = len(sources)
	}
	citations := make([]citation, 0, max)
	for _, s := range sources[:max] {
		citations = append(citations, citation{Title: s.Title, URL: s.URL})
	}
	return citations
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
		fmt.Fprintf(os.Stderr, "google: failed to encode JSON: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(output))
}
