// Package engine provides Engine API client for skill IPC.
// Skills communicate with the runtime engine via HTTP over TCP socket.
package engine

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

const timeout = 20 * time.Second

// Client is the Engine API client.
type Client struct {
	baseURL   string
	skillName string
	client    *http.Client
}

// NewClient creates a new Engine API client.
// Reads ALICE_ENGINE_URL and ALICE_SKILL from environment.
func NewClient() *Client {
	baseURL := os.Getenv("ALICE_ENGINE_URL")
	skillName := os.Getenv("ALICE_SKILL")

	return &Client{
		baseURL:   baseURL,
		skillName: skillName,
		client: &http.Client{
			Timeout: timeout,
		},
	}
}

// Get performs a GET request to the Engine API.
// Returns nil if ALICE_ENGINE_URL is not set (graceful degradation).
func (c *Client) Get(path string) (any, error) {
	if c.baseURL == "" {
		return nil, nil
	}

	url := c.baseURL + path
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	if c.skillName != "" {
		req.Header.Set("X-Alice-Skill", c.skillName)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("engine API returned %d for GET %s", resp.StatusCode, path)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result any
	if err := json.Unmarshal(body, &result); err != nil {
		return string(body), nil
	}

	return result, nil
}

// Post performs a POST request to the Engine API.
func (c *Client) Post(path string, body any) (any, error) {
	if c.baseURL == "" {
		return nil, nil
	}

	url := c.baseURL + path
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	if c.skillName != "" {
		req.Header.Set("X-Alice-Skill", c.skillName)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("engine API returned %d for POST %s", resp.StatusCode, path)
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result any
	if err := json.Unmarshal(respBody, &result); err != nil {
		return string(respBody), nil
	}

	return result, nil
}

// Query performs a POST request and unwraps the {ok, result} envelope.
func (c *Client) Query(path string, body any) (any, error) {
	raw, err := c.Post(path, body)
	if err != nil {
		return nil, err
	}

	// Unwrap {ok, result} envelope
	if m, ok := raw.(map[string]any); ok {
		if r, exists := m["result"]; exists {
			return r, nil
		}
	}
	return raw, nil
}
